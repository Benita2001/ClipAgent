const fs = require('fs');
const {
  withProviderTimeout,
  readTimeoutMs,
} = require('../utils/providerTimeout');
const {
  TranscriptionProviderError,
  classifyProviderError,
} = require('./transcriptionService');

const OPENAI_TRANSCRIPTION_URL =
  'https://api.openai.com/v1/audio/transcriptions';
const OPENAI_TRANSCRIPTION_TIMEOUT_MS = readTimeoutMs(
  process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS,
  120_000
);
const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = 'whisper-1';

async function transcribeOpenAiChunk(
  filePath,
  filename,
  mimetype,
  {
    fetchImpl = globalThis.fetch,
    signal,
    model =
      process.env.OPENAI_TRANSCRIPTION_MODEL ||
      DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
    language = null,
    apiKey = process.env.OPENAI_API_KEY,
  } = {}
) {
  if (!apiKey) {
    throw new TranscriptionProviderError('OPENAI_API_KEY is not set.', {
      provider: 'openai',
      category: 'configuration',
      statusCode: 503,
      retryable: false,
    });
  }
  if (model !== 'whisper-1') {
    throw new TranscriptionProviderError(
      'OPENAI_TRANSCRIPTION_MODEL must be whisper-1 because timestamped verbose_json output is required.',
      {
        provider: 'openai',
        category: 'configuration',
        statusCode: 503,
        retryable: false,
      }
    );
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
      'OpenAI Whisper',
      OPENAI_TRANSCRIPTION_TIMEOUT_MS,
      async ({ signal: timeoutSignal }) => {
        const response = await fetchImpl(OPENAI_TRANSCRIPTION_URL, {
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
            `OpenAI returned non-JSON HTTP ${response.status}.`
          );
          error.providerStatus = response.status;
          throw error;
        }
        if (!response.ok) {
          const error = new Error(
            json?.error?.message ||
              `OpenAI transcription returned HTTP ${response.status}.`
          );
          error.providerStatus = response.status;
          throw error;
        }
        return json;
      },
      { signal }
    );
  } catch (error) {
    throw classifyProviderError(error, 'openai');
  }
}

module.exports = {
  OPENAI_TRANSCRIPTION_URL,
  OPENAI_TRANSCRIPTION_TIMEOUT_MS,
  DEFAULT_OPENAI_TRANSCRIPTION_MODEL,
  transcribeOpenAiChunk,
};
