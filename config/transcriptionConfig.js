const path = require('path');
const { resolveRuntimePaths } = require('./runtimePaths');

function positiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function getTranscriptionConfig(env = process.env) {
  const runtimePaths = resolveRuntimePaths(env);
  const chunkSeconds = positiveInteger(env.TRANSCRIPTION_CHUNK_SECONDS, 600);
  const overlapSeconds = positiveInteger(
    env.TRANSCRIPTION_CHUNK_OVERLAP_SECONDS,
    2
  );
  if (overlapSeconds >= chunkSeconds) {
    const error = new Error(
      'TRANSCRIPTION_CHUNK_OVERLAP_SECONDS must be smaller than TRANSCRIPTION_CHUNK_SECONDS.'
    );
    error.code = 'INVALID_TRANSCRIPTION_CONFIGURATION';
    throw error;
  }
  return {
    enabled: readBoolean(env.TRANSCRIPTION_CHUNKING_ENABLED, true),
    primaryProvider: String(
      env.TRANSCRIPTION_PRIMARY_PROVIDER || 'groq'
    ).trim().toLowerCase(),
    fallbackProvider: String(
      env.TRANSCRIPTION_FALLBACK_PROVIDER || 'openai'
    ).trim().toLowerCase(),
    chunkSeconds,
    overlapSeconds,
    maxGroqAttempts: positiveInteger(
      env.TRANSCRIPTION_GROQ_MAX_ATTEMPTS,
      3
    ),
    retryBaseMs: positiveInteger(env.TRANSCRIPTION_RETRY_BASE_MS, 1_000),
    checkpointDir: path.resolve(
      env.TRANSCRIPTION_STATE_DIR ||
        path.join(runtimePaths.stateDir, 'transcripts')
    ),
    groqModel:
      env.GROQ_TRANSCRIPTION_MODEL ||
      env.GROQ_WHISPER_MODEL ||
      'whisper-large-v3',
    openaiModel: env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1',
    suppliedLanguage: String(env.TRANSCRIPTION_LANGUAGE || '').trim() || null,
  };
}

module.exports = {
  getTranscriptionConfig,
  positiveInteger,
  readBoolean,
};
