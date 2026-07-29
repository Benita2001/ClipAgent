const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getTranscriptionConfig } = require('../config/transcriptionConfig');
const {
  AUDIO_ENCODING_VERSION,
  buildChunkPlan,
  extractAudioChunk,
} = require('./audioChunkService');
const { TranscriptCheckpointStore } = require('./transcriptCheckpointStore');
const {
  TRANSCRIPT_SCHEMA_VERSION,
  normalizeProviderTranscript,
  mergeChunkTranscripts,
} = require('./transcriptSchema');
const {
  transcribeGroqChunk,
  classifyProviderError,
} = require('./transcriptionService');
const {
  transcribeOpenAiChunk,
} = require('./openaiTranscriptionProvider');
const { cleanupFiles } = require('../utils/fileCleanup');

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return `sha256:${hash.digest('hex')}`;
}

function fingerprintManifest(fields) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(fields))
    .digest('hex');
}

function createManifest({
  jobId,
  sourceChecksum,
  sourceDurationSeconds,
  contractVersion,
  config,
  chunks,
}) {
  const fingerprintFields = {
    sourceChecksum,
    sourceDurationSeconds,
    audioEncodingVersion: AUDIO_ENCODING_VERSION,
    chunkSeconds: config.chunkSeconds,
    overlapSeconds: config.overlapSeconds,
    primaryProvider: config.primaryProvider,
    primaryModel: config.groqModel,
    fallbackProvider: config.fallbackProvider,
    fallbackModel: config.openaiModel,
    transcriptSchemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    contractVersion: contractVersion || null,
  };
  return {
    schemaVersion: 1,
    jobId,
    ...fingerprintFields,
    fingerprint: fingerprintManifest(fingerprintFields),
    chunks,
    createdAt: new Date().toISOString(),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(baseMs, failedAttempt) {
  return Math.min(baseMs * (2 ** Math.max(0, failedAttempt - 1)), 30_000);
}

class ChunkTranscriptionError extends Error {
  constructor(chunkIndex, groqError, openaiError) {
    super(
      `Required audio chunk ${chunkIndex} failed through both transcription providers.`
    );
    this.name = 'ChunkTranscriptionError';
    this.code = 'TRANSCRIPTION_ALL_PROVIDERS_FAILED';
    this.statusCode = 502;
    this.chunkIndex = chunkIndex;
    this.providerFailures = {
      groq: groqError?.category || 'unknown',
      openai: openaiError?.category || 'unknown',
    };
  }
}

async function transcribeChunkWithFallback({
  chunkPath,
  chunk,
  config,
  transcribeGroq = transcribeGroqChunk,
  transcribeOpenAi = transcribeOpenAiChunk,
  sleep = delay,
}) {
  let groqError;
  for (let attempt = 1; attempt <= config.maxGroqAttempts; attempt += 1) {
    try {
      const raw = await transcribeGroq(
        chunkPath,
        path.basename(chunkPath),
        'audio/mp4',
        {
          model: config.groqModel,
          language: config.suppliedLanguage,
        }
      );
      return normalizeProviderTranscript(raw, {
        chunk,
        provider: 'groq',
        model: config.groqModel,
        suppliedLanguage: config.suppliedLanguage,
      });
    } catch (error) {
      groqError = classifyProviderError(error, 'groq');
      if (!groqError.retryable || attempt >= config.maxGroqAttempts) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(retryDelayMs(config.retryBaseMs, attempt));
    }
  }

  try {
    const raw = await transcribeOpenAi(
      chunkPath,
      path.basename(chunkPath),
      'audio/mp4',
      {
        model: config.openaiModel,
        language: config.suppliedLanguage,
      }
    );
    return normalizeProviderTranscript(raw, {
      chunk,
      provider: 'openai',
      model: config.openaiModel,
      suppliedLanguage: config.suppliedLanguage,
    });
  } catch (error) {
    throw new ChunkTranscriptionError(
      chunk.index,
      groqError,
      classifyProviderError(error, 'openai')
    );
  }
}

async function transcribeInChunks(audioPath, {
  jobId,
  sourcePath,
  sourceChecksum,
  sourceDurationSeconds,
  contractVersion = null,
  env = process.env,
  config = getTranscriptionConfig(env),
  checkpointStore = new TranscriptCheckpointStore({
    rootDir: config.checkpointDir,
  }),
  extractChunk = extractAudioChunk,
  transcribeGroq,
  transcribeOpenAi,
  sleep,
  cleanup = cleanupFiles,
  onChunkComplete,
} = {}) {
  if (!jobId || !sourcePath || !Number.isFinite(sourceDurationSeconds)) {
    const error = new Error(
      'Chunked transcription requires jobId, sourcePath, and sourceDurationSeconds.'
    );
    error.code = 'INVALID_TRANSCRIPTION_CONTEXT';
    throw error;
  }
  if (
    config.primaryProvider !== 'groq' ||
    config.fallbackProvider !== 'openai'
  ) {
    const error = new Error(
      'Chunked transcription requires groq primary and openai fallback providers.'
    );
    error.code = 'INVALID_TRANSCRIPTION_CONFIGURATION';
    throw error;
  }
  if (
    !transcribeGroq &&
    !env.GROQ_API_KEY &&
    !transcribeOpenAi &&
    !env.OPENAI_API_KEY
  ) {
    const error = new Error(
      'Neither GROQ_API_KEY nor OPENAI_API_KEY is configured for transcription.'
    );
    error.code = 'TRANSCRIPTION_PROVIDERS_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }

  const checksum = sourceChecksum || await sha256File(sourcePath);
  const chunks = buildChunkPlan(sourceDurationSeconds, config);
  const manifest = createManifest({
    jobId,
    sourceChecksum: checksum,
    sourceDurationSeconds,
    contractVersion,
    config,
    chunks,
  });
  await checkpointStore.initialize(jobId, manifest);

  const completed = [];
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const checkpoint = await checkpointStore.readChunk(jobId, chunk.index);
    if (
      checkpoint?.schemaVersion === TRANSCRIPT_SCHEMA_VERSION &&
      checkpoint?.chunkIndex === chunk.index
    ) {
      completed.push(checkpoint);
      continue;
    }

    let chunkPath;
    try {
      // eslint-disable-next-line no-await-in-loop
      chunkPath = await extractChunk(audioPath, jobId, chunk);
      // eslint-disable-next-line no-await-in-loop
      const transcript = await transcribeChunkWithFallback({
        chunkPath,
        chunk,
        config,
        transcribeGroq,
        transcribeOpenAi,
        sleep,
      });
      // Persist before moving to the next chunk.
      // eslint-disable-next-line no-await-in-loop
      await checkpointStore.writeChunk(jobId, chunk.index, transcript);
      completed.push(transcript);
      // eslint-disable-next-line no-await-in-loop
      await onChunkComplete?.({
        chunkIndex: chunk.index,
        completedChunks: completed.length,
        totalChunks: chunks.length,
        provider: transcript.provider,
      });
    } finally {
      if (chunkPath) {
        // eslint-disable-next-line no-await-in-loop
        await cleanup([chunkPath]);
      }
    }
  }

  const merged = mergeChunkTranscripts(completed, {
    sourceDurationSeconds,
  });
  await checkpointStore.writeMerged(jobId, merged);
  return merged;
}

module.exports = {
  ChunkTranscriptionError,
  sha256File,
  fingerprintManifest,
  createManifest,
  retryDelayMs,
  transcribeChunkWithFallback,
  transcribeInChunks,
};
