const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildChunkPlan,
} = require('../services/audioChunkService');
const {
  transcribeInChunks,
  transcribeChunkWithFallback,
  createManifest,
} = require('../services/chunkedTranscriptionService');
const {
  TranscriptionProviderError,
} = require('../services/transcriptionService');
const {
  TranscriptCheckpointStore,
} = require('../services/transcriptCheckpointStore');
const {
  mergeChunkTranscripts,
} = require('../services/transcriptSchema');

function transcriptionConfig(root, overrides = {}) {
  return {
    enabled: true,
    primaryProvider: 'groq',
    fallbackProvider: 'openai',
    chunkSeconds: 600,
    overlapSeconds: 2,
    maxGroqAttempts: 3,
    retryBaseMs: 1,
    checkpointDir: root,
    groqModel: 'whisper-large-v3',
    openaiModel: 'whisper-1',
    suppliedLanguage: null,
    ...overrides,
  };
}

function rawTranscript(chunk, {
  text = `chunk-${chunk.index}`,
  language = 'es',
  start = 0,
  end = Math.min(10, chunk.extractionDurationSeconds),
} = {}) {
  return {
    text,
    language,
    duration: chunk.extractionDurationSeconds,
    segments: [{ start, end, text, avg_logprob: -0.2 }],
  };
}

async function fixture(overrides = {}) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'clipagent-chunks-')
  );
  const sourcePath = path.join(root, 'source.mp4');
  const audioPath = path.join(root, 'audio.m4a');
  await fs.promises.writeFile(sourcePath, 'source');
  await fs.promises.writeFile(audioPath, 'audio');
  const calls = { groq: [], openai: [], extracted: [] };
  const config = transcriptionConfig(path.join(root, 'state'), overrides.config);
  const options = {
    jobId: 'job-1',
    sourcePath,
    sourceDurationSeconds: overrides.sourceDurationSeconds || 1_200,
    contractVersion: 'clipagent-a2a-development-v1',
    config,
    checkpointStore: new TranscriptCheckpointStore({
      rootDir: config.checkpointDir,
    }),
    extractChunk: async (input, jobId, chunk) => {
      calls.extracted.push(chunk.index);
      const chunkPath = path.join(root, `chunk-${chunk.index}.m4a`);
      await fs.promises.writeFile(chunkPath, `chunk-${chunk.index}`);
      return chunkPath;
    },
    transcribeGroq: async (file, filename, mime, providerOptions) => {
      const index = Number(/chunk-(\d+)/.exec(filename)?.[1]);
      calls.groq.push(index);
      return rawTranscript(buildChunkPlan(
        overrides.sourceDurationSeconds || 1_200,
        config
      )[index]);
    },
    transcribeOpenAi: async (file, filename) => {
      const index = Number(/chunk-(\d+)/.exec(filename)?.[1]);
      calls.openai.push(index);
      return rawTranscript(buildChunkPlan(
        overrides.sourceDurationSeconds || 1_200,
        config
      )[index]);
    },
    sleep: async () => {},
    ...overrides.options,
  };
  return {
    root,
    audioPath,
    calls,
    options,
    cleanup: () => fs.promises.rm(root, { recursive: true, force: true }),
  };
}

test('a full 3600-second source produces six overlapping chunk requests', () => {
  const chunks = buildChunkPlan(3_600, {
    chunkSeconds: 600,
    overlapSeconds: 2,
  });
  assert.equal(chunks.length, 6);
  assert.deepEqual(chunks[0], {
    index: 0,
    logicalStartSeconds: 0,
    logicalEndSeconds: 600,
    extractionStartSeconds: 0,
    extractionEndSeconds: 600,
    extractionDurationSeconds: 600,
  });
  assert.equal(chunks[1].extractionStartSeconds, 598);
  assert.equal(chunks[5].extractionStartSeconds, 2_998);
  assert.equal(chunks[5].extractionEndSeconds, 3_600);
});

test('checkpoint fingerprint covers every contract and provider input', () => {
  const config = transcriptionConfig('/tmp');
  const chunks = buildChunkPlan(600, config);
  const base = {
    jobId: 'job',
    sourceChecksum: 'sha256:one',
    sourceDurationSeconds: 600,
    contractVersion: 'contract-v1',
    config,
    chunks,
  };
  const initial = createManifest(base).fingerprint;
  const variants = [
    { sourceChecksum: 'sha256:two' },
    { sourceDurationSeconds: 599 },
    { contractVersion: 'contract-v2' },
    { config: { ...config, chunkSeconds: 300 } },
    { config: { ...config, overlapSeconds: 3 } },
    { config: { ...config, groqModel: 'different-groq-model' } },
    { config: { ...config, openaiModel: 'different-openai-model' } },
    { config: { ...config, primaryProvider: 'different-primary' } },
  ];
  for (const variant of variants) {
    assert.notEqual(
      createManifest({ ...base, ...variant }).fingerprint,
      initial
    );
  }
});

test('all chunks use Groq and never call OpenAI when Groq succeeds', async () => {
  const testFixture = await fixture();
  const result = await transcribeInChunks(testFixture.audioPath, testFixture.options);
  assert.deepEqual(testFixture.calls.groq, [0, 1]);
  assert.deepEqual(testFixture.calls.openai, []);
  assert.equal(result.segments.length, 2);
  await testFixture.cleanup();
});

test('only a failed Groq chunk falls back to OpenAI', async () => {
  const testFixture = await fixture();
  testFixture.options.transcribeGroq = async (file, filename) => {
    const index = Number(/chunk-(\d+)/.exec(filename)?.[1]);
    testFixture.calls.groq.push(index);
    if (index === 1) {
      throw new TranscriptionProviderError('unsupported', {
        provider: 'groq',
        category: 'unsupported_request',
        retryable: false,
      });
    }
    return rawTranscript(buildChunkPlan(1_200)[index]);
  };
  await transcribeInChunks(testFixture.audioPath, testFixture.options);
  assert.deepEqual(testFixture.calls.groq, [0, 1]);
  assert.deepEqual(testFixture.calls.openai, [1]);
  await testFixture.cleanup();
});

test('multiple independent failed chunks use per-chunk OpenAI fallback', async () => {
  const testFixture = await fixture({ sourceDurationSeconds: 1_800 });
  testFixture.options.transcribeGroq = async (file, filename) => {
    const index = Number(/chunk-(\d+)/.exec(filename)?.[1]);
    testFixture.calls.groq.push(index);
    if ([0, 2].includes(index)) {
      throw Object.assign(new Error('too large'), { providerStatus: 413 });
    }
    return rawTranscript(buildChunkPlan(1_800)[index]);
  };
  await transcribeInChunks(testFixture.audioPath, testFixture.options);
  assert.deepEqual(testFixture.calls.openai, [0, 2]);
  await testFixture.cleanup();
});

test('retryable Groq failures back off but permanent failures fall back promptly', async () => {
  const chunk = buildChunkPlan(600)[0];
  let retryCalls = 0;
  let sleeps = 0;
  const result = await transcribeChunkWithFallback({
    chunkPath: '/tmp/chunk.m4a',
    chunk,
    config: transcriptionConfig('/tmp'),
    transcribeGroq: async () => {
      retryCalls += 1;
      if (retryCalls < 3) {
        throw Object.assign(new Error('rate limited'), { providerStatus: 429 });
      }
      return rawTranscript(chunk);
    },
    transcribeOpenAi: async () => {
      throw new Error('must not run');
    },
    sleep: async () => {
      sleeps += 1;
    },
  });
  assert.equal(result.provider, 'groq');
  assert.equal(retryCalls, 3);
  assert.equal(sleeps, 2);

  let permanentCalls = 0;
  let fallbackCalls = 0;
  await transcribeChunkWithFallback({
    chunkPath: '/tmp/chunk.m4a',
    chunk,
    config: transcriptionConfig('/tmp'),
    transcribeGroq: async () => {
      permanentCalls += 1;
      throw Object.assign(new Error('bad request'), { providerStatus: 400 });
    },
    transcribeOpenAi: async () => {
      fallbackCalls += 1;
      return rawTranscript(chunk);
    },
    sleep: async () => {
      throw new Error('must not sleep');
    },
  });
  assert.equal(permanentCalls, 1);
  assert.equal(fallbackCalls, 1);
});

test('the job fails only when both providers fail for one required chunk', async () => {
  const testFixture = await fixture({
    options: {
      transcribeGroq: async () => {
        throw Object.assign(new Error('Groq 503'), { providerStatus: 503 });
      },
      transcribeOpenAi: async () => {
        throw Object.assign(new Error('OpenAI 503'), { providerStatus: 503 });
      },
    },
  });
  await assert.rejects(
    transcribeInChunks(testFixture.audioPath, testFixture.options),
    (error) =>
      error.code === 'TRANSCRIPTION_ALL_PROVIDERS_FAILED' &&
      error.chunkIndex === 0
  );
  await testFixture.cleanup();
});

test('restart resumes at the first incomplete chunk without repeat billing', async () => {
  const testFixture = await fixture();
  let failSecond = true;
  const originalOpenAi = testFixture.options.transcribeOpenAi;
  testFixture.options.transcribeGroq = async (file, filename) => {
    const index = Number(/chunk-(\d+)/.exec(filename)?.[1]);
    testFixture.calls.groq.push(index);
    if (index === 1) {
      throw Object.assign(new Error('unsupported'), { providerStatus: 413 });
    }
    return rawTranscript(buildChunkPlan(1_200)[index]);
  };
  testFixture.options.transcribeOpenAi = async (...args) => {
    if (failSecond) {
      throw Object.assign(new Error('temporary failure'), { providerStatus: 503 });
    }
    return originalOpenAi(...args);
  };
  await assert.rejects(
    transcribeInChunks(testFixture.audioPath, testFixture.options),
    /both transcription providers/
  );
  failSecond = false;
  testFixture.calls.groq.length = 0;
  await transcribeInChunks(testFixture.audioPath, testFixture.options);
  assert.deepEqual(testFixture.calls.groq, [1]);
  assert.deepEqual(testFixture.calls.extracted, [0, 1, 1]);
  await testFixture.cleanup();
});

test('overlap speech is deduplicated and absolute timestamps remain monotonic', () => {
  const chunks = buildChunkPlan(1_200);
  const first = {
    schemaVersion: 'clipagent-transcript-v1',
    chunkIndex: 0,
    provider: 'groq',
    model: 'whisper-large-v3',
    language: 'fr',
    logicalStartSeconds: 0,
    logicalEndSeconds: 600,
    segments: [{
      id: 0,
      text: 'bonjour le monde',
      relativeStart: 598,
      relativeEnd: 600,
      absoluteStart: 598,
      absoluteEnd: 600,
      chunkIndex: 0,
      provider: 'groq',
      model: 'whisper-large-v3',
      language: 'fr',
      confidence: {},
    }],
  };
  const second = {
    ...first,
    chunkIndex: 1,
    logicalStartSeconds: 600,
    logicalEndSeconds: 1_200,
    provider: 'openai',
    model: 'whisper-1',
    segments: [{
      ...first.segments[0],
      relativeStart: 0,
      relativeEnd: 2,
      absoluteStart: chunks[1].extractionStartSeconds,
      absoluteEnd: 600,
      chunkIndex: 1,
      provider: 'openai',
      model: 'whisper-1',
    }, {
      ...first.segments[0],
      text: 'suite en français',
      relativeStart: 2,
      relativeEnd: 6,
      absoluteStart: 600,
      absoluteEnd: 604,
      chunkIndex: 1,
      provider: 'openai',
      model: 'whisper-1',
    }],
  };
  const merged = mergeChunkTranscripts([first, second], {
    sourceDurationSeconds: 1_200,
  });
  assert.deepEqual(
    merged.segments.map((segment) => segment.text),
    ['bonjour le monde', 'suite en français']
  );
  assert.deepEqual(
    merged.segments.map((segment) => [segment.start, segment.end]),
    [[598, 600], [600, 604]]
  );
  assert.equal(merged.language, 'fr');
});

test('partially repeated overlap text is removed from the later segment', () => {
  const merged = mergeChunkTranscripts([
    {
      schemaVersion: 'clipagent-transcript-v1',
      chunkIndex: 0,
      logicalStartSeconds: 0,
      logicalEndSeconds: 600,
      language: 'en',
      segments: [{
        text: 'a strong moment begins here',
        absoluteStart: 596,
        absoluteEnd: 600,
        chunkIndex: 0,
        provider: 'groq',
        model: 'whisper-large-v3',
      }],
    },
    {
      schemaVersion: 'clipagent-transcript-v1',
      chunkIndex: 1,
      logicalStartSeconds: 600,
      logicalEndSeconds: 1_200,
      language: 'en',
      segments: [{
        text: 'begins here and continues clearly',
        absoluteStart: 598,
        absoluteEnd: 604,
        chunkIndex: 1,
        provider: 'openai',
        model: 'whisper-1',
      }],
    },
  ], { sourceDurationSeconds: 1_200 });
  assert.deepEqual(
    merged.segments.map((segment) => segment.text),
    ['a strong moment begins here', 'and continues clearly']
  );
});

test('mixed-provider non-English chunks remain transcriptions', async () => {
  const testFixture = await fixture();
  testFixture.options.transcribeGroq = async (file, filename) => {
    const index = Number(/chunk-(\d+)/.exec(filename)?.[1]);
    testFixture.calls.groq.push(index);
    if (index === 1) throw Object.assign(new Error('413'), { providerStatus: 413 });
    return rawTranscript(buildChunkPlan(1_200)[index], {
      text: 'hola mundo',
      language: 'es',
    });
  };
  testFixture.options.transcribeOpenAi = async (file, filename) => {
    const index = Number(/chunk-(\d+)/.exec(filename)?.[1]);
    testFixture.calls.openai.push(index);
    return rawTranscript(buildChunkPlan(1_200)[index], {
      text: 'seguimos hablando',
      language: 'es',
    });
  };
  const merged = await transcribeInChunks(
    testFixture.audioPath,
    testFixture.options
  );
  assert.equal(merged.language, 'es');
  assert.match(merged.text, /hola mundo/);
  assert.match(merged.text, /seguimos hablando/);
  await testFixture.cleanup();
});
