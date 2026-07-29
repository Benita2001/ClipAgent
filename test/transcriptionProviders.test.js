const test = require('node:test');
const assert = require('node:assert/strict');
const {
  transcribeOpenAiChunk,
  OPENAI_TRANSCRIPTION_URL,
} = require('../services/openaiTranscriptionProvider');
const {
  classifyProviderError,
} = require('../services/transcriptionService');

test('OpenAI fallback uses timestamped transcription, never translation', async () => {
  let request;
  const response = {
    text: 'hola mundo',
    language: 'es',
    duration: 2,
    segments: [{ start: 0, end: 2, text: 'hola mundo' }],
  };
  const result = await transcribeOpenAiChunk(
    __filename,
    'speech.m4a',
    'audio/mp4',
    {
      apiKey: 'test-key',
      model: 'whisper-1',
      language: null,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    }
  );
  assert.equal(request.url, OPENAI_TRANSCRIPTION_URL);
  assert.equal(request.url.endsWith('/audio/transcriptions'), true);
  assert.equal(request.url.includes('/translations'), false);
  assert.equal(request.options.body.get('model'), 'whisper-1');
  assert.equal(request.options.body.get('response_format'), 'verbose_json');
  assert.equal(request.options.body.has('language'), false);
  assert.equal(result.language, 'es');
  assert.equal(result.text, 'hola mundo');
});
test('Groq error classification separates retryable and permanent failures', () => {
  assert.equal(
    classifyProviderError(
      Object.assign(new Error('rate limit'), { providerStatus: 429 })
    ).retryable,
    true
  );
  assert.equal(
    classifyProviderError(
      Object.assign(new Error('server'), { providerStatus: 503 })
    ).retryable,
    true
  );
  assert.equal(
    classifyProviderError(
      Object.assign(new Error('file size'), { providerStatus: 413 })
    ).category,
    'file_size'
  );
  assert.equal(
    classifyProviderError(
      Object.assign(new Error('authentication'), { providerStatus: 401 })
    ).retryable,
    false
  );
});
