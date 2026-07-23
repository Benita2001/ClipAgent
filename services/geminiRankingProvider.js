const { SYSTEM_PROMPT, buildUserPrompt, validateShape } = require('./rankingPrompt');
const { fetchWithTimeout, readTimeoutMs } = require('../utils/providerTimeout');

// gemini-flash-latest: confirmed live against the real API — gemini-2.5-flash
// returned 404 "no longer available to new users" on this key, and
// gemini-3.5-flash returned intermittent 503 (overloaded). The "-latest"
// alias is Google-maintained to always point at the current Flash model, so
// it avoids pinning to a version that quietly deprecates.
const MODEL = process.env.GEMINI_RANKING_MODEL || 'gemini-flash-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const GEMINI_TIMEOUT_MS = readTimeoutMs(process.env.GEMINI_TIMEOUT_MS, 60_000);

/**
 * Single-attempt Gemini fallback — only called after the primary (Groq)
 * exhausts its own retries. No internal retry here per spec ("tries Gemini
 * once"). Throws (never fabricates) on any failure.
 */
async function rankWithGemini(segments) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set.');
  }

  const response = await fetchWithTimeout(
    `${GEMINI_URL}?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(segments) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
      }),
    },
    { provider: 'Gemini', timeoutMs: GEMINI_TIMEOUT_MS }
  );

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    const err = new Error(`Gemini returned a non-JSON HTTP response (status ${response.status}): ${bodyText.slice(0, 500)}`);
    err.statusCode = 502;
    throw err;
  }

  if (!response.ok) {
    const message = (body && body.error && body.error.message) || JSON.stringify(body);
    const err = new Error(`Gemini generateContent failed (status ${response.status}): ${message}`);
    err.statusCode = 502;
    throw err;
  }

  const content = body?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof content !== 'string') {
    const err = new Error(`Gemini response had no text content: ${JSON.stringify(body).slice(0, 500)}`);
    err.statusCode = 502;
    throw err;
  }

  let parsed;
  try {
    parsed = JSON.parse(content.trim());
  } catch (e) {
    const err = new Error(`Gemini ranking failed: did not return valid JSON (${e.message}). Response: ${content.slice(0, 500)}`);
    err.statusCode = 502;
    throw err;
  }

  if (!validateShape(parsed)) {
    const err = new Error(`Gemini ranking failed: response did not match the required schema. Response: ${content.slice(0, 500)}`);
    err.statusCode = 502;
    throw err;
  }

  return { moments: parsed.moments, raw: content, attempts: 1, retried: false, provider: 'gemini', model: MODEL };
}

module.exports = { rankWithGemini, MODEL, GEMINI_TIMEOUT_MS };
