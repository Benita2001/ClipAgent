const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { processClip, runPipeline } = require('../services/pipelineService');
const { ClientDisconnectedError } = require('../services/clipRequestLifecycle');
const { rankMoments } = require('../services/rankingService');
const { cleanupFiles } = require('../utils/fileCleanup');
const { withProviderTimeout, ProviderTimeoutError } = require('../utils/providerTimeout');
const { createClipRouter, createClipPrepaymentRouter } = require('../routes/clip');
const { createUploadsRouter } = require('../routes/uploads');
const jobRouter = require('../routes/job');
const { createJob, markDone } = require('../services/jobStore');

async function request(app, method, route, options = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, ...options });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function createPipelineFixture() {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-pipeline-'));
  const sourcePath = path.join(directory, 'source.mp4');
  const audioPath = path.join(directory, 'source-audio.m4a');
  const clipPath = path.join(directory, 'job-clip-0.mp4');
  await fs.promises.writeFile(sourcePath, 'source');

  const terminal = { done: [], failed: [] };
  const dependencies = {
    getAudioOutputPath: () => audioPath,
    extractAudio: async () => {
      await fs.promises.writeFile(audioPath, 'audio');
      return audioPath;
    },
    transcribe: async () => ({ duration: 30, segments: [{ id: 0, start: 0, end: 30, text: 'test' }] }),
    rankMoments: async () => ({
      rankingModel: 'mock/groq',
      moments: [{ start_time: 0, end_time: 30, reason: 'test moment' }],
    }),
    getClipOutputPath: () => clipPath,
    cutMoments: async () => {
      await fs.promises.writeFile(clipPath, 'clip');
      return [
        {
          index: 0,
          filename: 'job-clip-0.mp4',
          path: clipPath,
          reason: 'test moment',
          requestedStartSeconds: 0,
          requestedEndSeconds: 30,
          requestedDurationSeconds: 30,
          actualDurationSeconds: 30,
        },
      ];
    },
    uploadClip: async () => ({
      bucket: 'clips',
      storagePath: 'job/job-clip-0.mp4',
      publicUrl: 'https://example.test/job-clip-0.mp4',
    }),
    markDone: (jobId, result) => terminal.done.push({ jobId, result }),
    markFailed: (jobId, error) => terminal.failed.push({ jobId, error }),
    cleanupFiles,
  };

  return {
    directory,
    sourcePath,
    audioPath,
    clipPath,
    file: { path: sourcePath, filename: 'source.mp4' },
    dependencies,
    terminal,
  };
}

async function removeFixture(directory) {
  await fs.promises.rm(directory, { recursive: true, force: true });
}

test('pipeline cleans uploaded, audio, and clip files after success', async () => {
  const fixture = await createPipelineFixture();
  try {
    await runPipeline('job', fixture.file, fixture.dependencies);

    assert.equal(fixture.terminal.done.length, 1);
    assert.equal(fixture.terminal.failed.length, 0);
    for (const filePath of [fixture.sourcePath, fixture.audioPath, fixture.clipPath]) {
      await assert.rejects(fs.promises.access(filePath), { code: 'ENOENT' });
    }
  } finally {
    await removeFixture(fixture.directory);
  }
});

function disconnectingLifecycle(disconnectDuringStage) {
  const state = { disconnected: false, currentStage: 'initializing' };
  return {
    state,
    assertCanStartStage(nextStage) {
      if (state.disconnected) {
        throw new ClientDisconnectedError({
          currentStage: state.currentStage,
          nextStage,
          disconnectSource: 'test',
          disconnectedAt: Date.now(),
        });
      }
      state.currentStage = nextStage;
    },
    assertConnected(nextStage) {
      if (state.disconnected) {
        throw new ClientDisconnectedError({
          currentStage: state.currentStage,
          nextStage,
          disconnectSource: 'test',
          disconnectedAt: Date.now(),
        });
      }
    },
    disconnectIf(stage) {
      if (stage === disconnectDuringStage) state.disconnected = true;
    },
    enterCleanup() {},
    cleanupCompleted() {},
    cleanupFailed() {},
  };
}

for (const scenario of [
  { active: 'audio extraction', blocked: 'transcription' },
  { active: 'transcription', blocked: 'ranking' },
  { active: 'ranking', blocked: 'cutting/rendering' },
  { active: 'cutting/rendering', blocked: 'upload' },
]) {
  test(`disconnect during ${scenario.active} finishes it and blocks ${scenario.blocked}`, async () => {
    const fixture = await createPipelineFixture();
    const lifecycle = disconnectingLifecycle(scenario.active);
    const calls = [];
    for (const [dependencyName, stage] of [
      ['extractAudio', 'audio extraction'],
      ['transcribe', 'transcription'],
      ['rankMoments', 'ranking'],
      ['cutMoments', 'cutting/rendering'],
      ['uploadClip', 'upload'],
    ]) {
      const original = fixture.dependencies[dependencyName];
      fixture.dependencies[dependencyName] = async (...args) => {
        calls.push(stage);
        const result = await original(...args);
        lifecycle.disconnectIf(stage);
        return result;
      };
    }

    try {
      await assert.rejects(
        processClip('job', fixture.file, { ...fixture.dependencies, lifecycle }),
        (error) => error.code === 'CLIENT_DISCONNECTED' && error.nextStage === scenario.blocked
      );
      assert.ok(calls.includes(scenario.active));
      assert.equal(calls.includes(scenario.blocked), false);
      for (const filePath of [fixture.sourcePath, fixture.audioPath, fixture.clipPath]) {
        await assert.rejects(fs.promises.access(filePath), { code: 'ENOENT' });
      }
    } finally {
      await removeFixture(fixture.directory);
    }
  });
}

test('disconnect during upload does not start a later upload and cleanup still runs', async () => {
  const fixture = await createPipelineFixture();
  const lifecycle = disconnectingLifecycle('upload');
  let uploadCalls = 0;
  fixture.dependencies.cutMoments = async () => {
    const firstPath = fixture.clipPath;
    const secondPath = path.join(fixture.directory, 'job-clip-1.mp4');
    await fs.promises.writeFile(firstPath, 'clip-one');
    await fs.promises.writeFile(secondPath, 'clip-two');
    return [firstPath, secondPath].map((clipPath, index) => ({
      index,
      filename: path.basename(clipPath),
      path: clipPath,
      reason: 'test',
      requestedStartSeconds: index * 10,
      requestedEndSeconds: index * 10 + 10,
      requestedDurationSeconds: 10,
      actualDurationSeconds: 10,
    }));
  };
  fixture.dependencies.getClipOutputPath = (jobId, index) =>
    path.join(fixture.directory, `job-clip-${index}.mp4`);
  fixture.dependencies.uploadClip = async () => {
    uploadCalls += 1;
    lifecycle.disconnectIf('upload');
    return { publicUrl: 'https://example.test/clip.mp4' };
  };

  try {
    await assert.rejects(
      processClip('job', fixture.file, { ...fixture.dependencies, lifecycle }),
      (error) => error.code === 'CLIENT_DISCONNECTED'
    );
    assert.equal(uploadCalls, 1);
    for (const filename of ['source.mp4', 'source-audio.m4a', 'job-clip-0.mp4', 'job-clip-1.mp4']) {
      await assert.rejects(fs.promises.access(path.join(fixture.directory, filename)), { code: 'ENOENT' });
    }
  } finally {
    await removeFixture(fixture.directory);
  }
});

test('validation failure cleans the uploaded file', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-validation-'));
  const sourcePath = path.join(directory, 'invalid.mp4');
  await fs.promises.writeFile(sourcePath, 'invalid');

  const app = express();
  app.use(
    createUploadsRouter({
      uploadSingle: (req, res, next) => {
        req.file = {
          path: sourcePath,
          filename: 'invalid.mp4',
          originalname: 'invalid.mp4',
          size: 7,
        };
        next();
      },
      checkDurationLimit: async () => {
        const error = new Error('invalid duration');
        error.statusCode = 400;
        throw error;
      },
    })
  );
  app.use((error, req, res, next) => {
    res.status(error.statusCode || 500).json({
      success: false,
      error: { code: 'UPLOAD_VALIDATION_FAILED' },
    });
  });

  try {
    const response = await request(app, 'POST', '/uploads', {
      headers: { 'Content-Type': 'multipart/form-data; boundary=test' },
    });
    assert.equal(response.status, 400);
    await assert.rejects(fs.promises.access(sourcePath), { code: 'ENOENT' });
  } finally {
    await removeFixture(directory);
  }
});

test('Groq provider failure marks the job failed and cleans created files', async () => {
  const fixture = await createPipelineFixture();
  fixture.dependencies.transcribe = async () => {
    throw new Error('mock Groq failure');
  };

  try {
    await runPipeline('job', fixture.file, fixture.dependencies);

    assert.equal(fixture.terminal.done.length, 0);
    assert.equal(fixture.terminal.failed.length, 1);
    assert.equal(fixture.terminal.failed[0].error.publicError.code, 'TRANSCRIPTION_FAILED');
    await assert.rejects(fs.promises.access(fixture.sourcePath), { code: 'ENOENT' });
    await assert.rejects(fs.promises.access(fixture.audioPath), { code: 'ENOENT' });
  } finally {
    await removeFixture(fixture.directory);
  }
});

test('Groq ranking timeout and Gemini failure mark the pipeline failed and clean files', async () => {
  const fixture = await createPipelineFixture();
  fixture.dependencies.rankMoments = (segments) => rankMoments(segments, {
    rankWithGroq: async () => { throw new ProviderTimeoutError('Groq Ranking', 5); },
    rankWithGemini: async () => { throw new ProviderTimeoutError('Gemini', 5); },
    logger: { log() {}, warn() {}, error() {} },
  });

  try {
    await runPipeline('job', fixture.file, fixture.dependencies);

    assert.equal(fixture.terminal.done.length, 0);
    assert.equal(fixture.terminal.failed.length, 1);
    assert.equal(fixture.terminal.failed[0].error.publicError.code, 'RANKING_FAILED');
    await assert.rejects(fs.promises.access(fixture.sourcePath), { code: 'ENOENT' });
    await assert.rejects(fs.promises.access(fixture.audioPath), { code: 'ENOENT' });
  } finally {
    await removeFixture(fixture.directory);
  }
});

test('Groq ranking timeout and Gemini success allow the pipeline to finish done', async () => {
  const fixture = await createPipelineFixture();
  fixture.dependencies.rankMoments = (segments) => rankMoments(segments, {
    rankWithGroq: async () => { throw new ProviderTimeoutError('Groq Ranking', 5); },
    rankWithGemini: async () => ({
      moments: [{ start_time: 0, end_time: 30, reason: 'fallback' }],
      attempts: 1,
    }),
    logger: { log() {}, warn() {}, error() {} },
  });
  try {
    await runPipeline('job', fixture.file, fixture.dependencies);
    assert.equal(fixture.terminal.done.length, 1);
    assert.equal(fixture.terminal.failed.length, 0);
    assert.match(fixture.terminal.done[0].result.rankingModel, /^gemini\//);
  } finally {
    await removeFixture(fixture.directory);
  }
});

test('terminal transition failure still runs cleanup without applying the opposite state', async () => {
  const fixture = await createPipelineFixture();
  let failedCalls = 0;
  fixture.dependencies.markDone = () => {
    throw new Error('job store unavailable');
  };
  fixture.dependencies.markFailed = () => {
    failedCalls += 1;
    return true;
  };
  try {
    await assert.rejects(runPipeline('job', fixture.file, fixture.dependencies), /job store unavailable/);
    assert.equal(failedCalls, 0);
    await assert.rejects(fs.promises.access(fixture.sourcePath), { code: 'ENOENT' });
    await assert.rejects(fs.promises.access(fixture.audioPath), { code: 'ENOENT' });
    await assert.rejects(fs.promises.access(fixture.clipPath), { code: 'ENOENT' });
  } finally {
    await removeFixture(fixture.directory);
  }
});

test('mock ffmpeg failure cleans a partial clip and marks the job failed', async () => {
  const fixture = await createPipelineFixture();
  fixture.dependencies.cutMoments = async () => {
    await fs.promises.writeFile(fixture.clipPath, 'partial');
    throw new Error('mock ffmpeg failure');
  };

  try {
    await runPipeline('job', fixture.file, fixture.dependencies);

    assert.equal(fixture.terminal.done.length, 0);
    assert.equal(fixture.terminal.failed.length, 1);
    assert.equal(fixture.terminal.failed[0].error.publicError.code, 'CLIP_RENDER_FAILED');
    await assert.rejects(fs.promises.access(fixture.clipPath), { code: 'ENOENT' });
  } finally {
    await removeFixture(fixture.directory);
  }
});

test('mock Supabase upload failure cleans every local file and marks the job failed', async () => {
  const fixture = await createPipelineFixture();
  fixture.dependencies.uploadClip = async () => {
    throw new Error('mock Supabase failure');
  };

  try {
    await runPipeline('job', fixture.file, fixture.dependencies);

    assert.equal(fixture.terminal.done.length, 0);
    assert.equal(fixture.terminal.failed.length, 1);
    assert.equal(fixture.terminal.failed[0].error.publicError.code, 'UPLOAD_FAILED');
    for (const filePath of [fixture.sourcePath, fixture.audioPath, fixture.clipPath]) {
      await assert.rejects(fs.promises.access(filePath), { code: 'ENOENT' });
    }
  } finally {
    await removeFixture(fixture.directory);
  }
});

test('provider timeout aborts the request and names the provider', async () => {
  let receivedSignal;
  const hangingFetch = async (url, options) => {
    receivedSignal = options.signal;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  };

  await assert.rejects(
    withProviderTimeout('Mock Gemini', 5, async ({ signal }) =>
      hangingFetch('https://example.test', { signal })),
    (error) => error instanceof ProviderTimeoutError && error.message === 'Mock Gemini request timed out after 5ms.'
  );
  assert.equal(receivedSignal.aborted, true);
});

test('provider timeout marks the job failed and cleanup still executes', async () => {
  const fixture = await createPipelineFixture();
  fixture.dependencies.transcribe = async () => {
    throw new ProviderTimeoutError('Groq Whisper', 5);
  };

  try {
    await runPipeline('job', fixture.file, fixture.dependencies);

    assert.equal(fixture.terminal.done.length, 0);
    assert.equal(fixture.terminal.failed.length, 1);
    assert.equal(fixture.terminal.failed[0].error.publicError.code, 'PROVIDER_TIMEOUT');
    await assert.rejects(fs.promises.access(fixture.sourcePath), { code: 'ENOENT' });
    await assert.rejects(fs.promises.access(fixture.audioPath), { code: 'ENOENT' });
  } finally {
    await removeFixture(fixture.directory);
  }
});

test('cleanup ignores missing files', async () => {
  const errors = [];
  await assert.doesNotReject(
    cleanupFiles(['/tmp/clipagent-file-that-does-not-exist'], {
      error(message) {
        errors.push(message);
      },
    })
  );
  assert.deepEqual(errors, []);
});

test('cleanup logs deletion failures without throwing', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-cleanup-error-'));
  const errors = [];

  try {
    await assert.doesNotReject(
      cleanupFiles([directory], {
        error(message) {
          errors.push(message);
        },
      })
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^\[cleanup\] failed to remove /);
  } finally {
    await removeFixture(directory);
  }
});

test('completed job output never exposes local filesystem paths', async () => {
  const jobId = `public-output-${Date.now()}`;
  createJob(jobId);
  markDone(jobId, {
    rankingModel: 'mock/groq',
    audioFileSizeBytes: 5,
    transcriptDurationSeconds: 30,
    clips: [
      {
        index: 0,
        localPath: '/private/output/clip.mp4',
        path: '/private/output/clip.mp4',
        supabase: { publicUrl: 'https://example.test/clip.mp4' },
      },
    ],
  });

  const app = express();
  app.use(jobRouter);
  const response = await request(app, 'GET', `/job/${jobId}`);
  const serialized = JSON.stringify(response.body);

  assert.equal(response.status, 200);
  assert.equal(serialized.includes('localPath'), false);
  assert.equal(serialized.includes('/private/output'), false);
  assert.equal(response.body.clips[0].url, 'https://example.test/clip.mp4');
  assert.equal(response.body.status, 'completed');
});
