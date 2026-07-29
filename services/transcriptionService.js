const fs = require('fs');
const {
  withProviderTimeout,
  readTimeoutMs,
  ProviderTimeoutError,
} = require('../utils/providerTimeout');

const GROQ_TRANSCRIPTION_URL =
  'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_TIMEOUT_MS = readTimeoutMs(process.env.GROQ_TIMEOUT_MS, 120_000);

class TranscriptionProviderError extends Error {
  constructor(message, {
    provider,
    category,
    statusCode = 502,
    providerStatus = null,
    retryable = false,
    cause,
  } = {}) {
    super(message, { cause });
    this.name = 'TranscriptionProviderError';
    this.code = 'TRANSCRIPTION_PROVIDER_FAILED';
    this.provider = provider;
    this.category = category;
    this.statusCode = statusCode;
    this.providerStatus = providerStatus;
    this.retryable = retryable;
  }
}

function classifyProviderError(error, provider = 'groq') {
  if (error instanceof TranscriptionProviderError) return error;
  const providerStatus = Number(error?.providerStatus || error?.status);
  const message = String(error?.message || 'Transcription provider failed.');
  if (error instanceof ProviderTimeoutError || error?.name === 'AbortError') {
    return new TranscriptionProviderError(message, {
      provider,
      category: 'timeout',
      retryable: true,
      cause: error,
    });
  }
  if ([401, 403].includes(providerStatus)) {
    return new TranscriptionProviderError(message, {
      provider,
      category: 'authentication',
      providerStatus,
      retryable: false,
      cause: error,
    });
  }
  if (providerStatus === 429) {
    return new TranscriptionProviderError(message, {
      provider,
      category: 'rate_limit',
      providerStatus,
      retryable: true,
      cause: error,
    });
  }
  if (providerStatus >= 500) {
    return new TranscriptionProviderError(message, {
      provider,
      category: 'provider_5xx',
      providerStatus,
      retryable: true,
      cause: error,
    });
  }
  if ([400, 413, 415, 422].includes(providerStatus)) {
    return new TranscriptionProviderError(message, {
      provider,
      category:
        providerStatus === 413 ? 'file_size' : 'unsupported_request',
      providerStatus,
      retryable: false,
      cause: error,
    });
  }
  if (
    ['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EAI_AGAIN', 'ETIMEDOUT']
      .includes(error?.code) ||
    error instanceof TypeError
  ) {
    return new TranscriptionProviderError(message, {
      provider,
      category: 'connection',
      retryable: true,
      cause: error,
    });
  }
  return new TranscriptionProviderError(message, {
    provider,
    category: 'unknown',
    retryable: false,
    cause: error,
  });
}

async function transcribeGroqChunk(
  filePath,
  filename,
  mimetype,
  {
    fetchImpl = globalThis.fetch,
    signal,
    model = process.env.GROQ_TRANSCRIPTION_MODEL ||
      process.env.GROQ_WHISPER_MODEL ||
      'whisper-large-v3',
    language = null,
    apiKey = process.env.GROQ_API_KEY,
  } = {}
) {
  if (!apiKey) {
    throw new TranscriptionProviderError('GROQ_API_KEY is not set.', {
      provider: 'groq',
      category: 'configuration',
      statusCode: 503,
      retryable: false,
    });
  }
  const fileBuffer = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimetype }), filename);
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
  if (language) form.append('language', language);

  try {
    return await withProviderTimeout(
      'Groq Whisper',
      GROQ_TIMEOUT_MS,
      async ({ signal: timeoutSignal }) => {
        const response = await fetchImpl(GROQ_TRANSCRIPTION_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: timeoutSignal,
        });
        const bodyText = await response.text();
        let json;
        try {
          json = JSON.parse(bodyText);
        } catch {
          const error = new Error(
            `Groq returned non-JSON HTTP ${response.status}.`
          );
          error.providerStatus = response.status;
          throw error;
        }
        if (!response.ok) {
          const error = new Error(
            json?.error?.message ||
              `Groq transcription returned HTTP ${response.status}.`
          );
          error.providerStatus = response.status;
          throw error;
        }
        return json;
      },
      { signal }
    );
  } catch (error) {
    throw classifyProviderError(error, 'groq');
  }
}

// Compatibility export for the legacy non-chunked path.
const transcribe = transcribeGroqChunk;

module.exports = {
  GROQ_TRANSCRIPTION_URL,
  GROQ_TIMEOUT_MS,
  TranscriptionProviderError,
  classifyProviderError,
  transcribeGroqChunk,
  transcribe,
};
