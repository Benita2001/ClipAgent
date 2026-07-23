const fs = require('fs');
const { fetchWithTimeout, readTimeoutMs } = require('../utils/providerTimeout');

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_TIMEOUT_MS = readTimeoutMs(process.env.GROQ_TIMEOUT_MS, 120_000);

/**
 * Calls Groq's Whisper transcription endpoint and returns its response
 * verbatim (no reshaping) — the response shape is whatever Groq actually
 * returns for verbose_json + timestamp_granularities[]=segment,word.
 */
async function transcribe(filePath, filename, mimetype) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set.');
  }
  const model = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3';

  const fileBuffer = await fs.promises.readFile(filePath);
  const blob = new Blob([fileBuffer], { type: mimetype });

  const form = new FormData();
  form.append('file', blob, filename);
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');

  const response = await fetchWithTimeout(
    GROQ_TRANSCRIPTION_URL,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    },
    { provider: 'Groq Whisper', timeoutMs: GROQ_TIMEOUT_MS }
  );

  const bodyText = await response.text();
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch {
    const err = new Error(`Groq returned a non-JSON response (status ${response.status}): ${bodyText.slice(0, 500)}`);
    err.statusCode = 502;
    throw err;
  }

  if (!response.ok) {
    const message = (json && json.error && json.error.message) || JSON.stringify(json);
    const err = new Error(`Groq transcription failed (status ${response.status}): ${message}`);
    err.statusCode = 502;
    throw err;
  }

  return json;
}

module.exports = { transcribe, GROQ_TIMEOUT_MS };
