const { SYSTEM_PROMPT, buildUserPrompt, validateShape } = require('./rankingPrompt');
const { withProviderTimeout, readTimeoutMs } = require('../utils/providerTimeout');

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT_MS = readTimeoutMs(process.env.GROQ_TIMEOUT_MS, 120_000);
// openai/gpt-oss-120b: Groq's production reasoning-capable model (confirmed
// live against GET /v1/models — deepseek-r1-distill-llama-70b is no longer
// listed). Reasoning tokens land in a separate `reasoning` field, not
// `content`, so json_object mode still yields clean JSON (verified live).
const MODEL = process.env.GROQ_RANKING_MODEL || 'openai/gpt-oss-120b';

async function callGroqChat(messages, temperature, { fetchImpl = globalThis.fetch, signal } = {}) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set.');
  }

  return withProviderTimeout('Groq Ranking', GROQ_TIMEOUT_MS, async ({ signal: timeoutSignal }) => {
    const response = await fetchImpl(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature,
        response_format: { type: 'json_object' },
      }),
      signal: timeoutSignal,
    });

    const bodyText = await response.text();
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
    const err = new Error(`Groq chat completions returned a non-JSON HTTP response (status ${response.status}): ${bodyText.slice(0, 500)}`);
    err.statusCode = 502;
    throw err;
    }

  if (!response.ok) {
    const message = (body && body.error && body.error.message) || JSON.stringify(body);
    const err = new Error(`Groq chat completions failed (status ${response.status}): ${message}`);
    err.statusCode = 502;
    throw err;
  }

  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    const err = new Error(`Groq chat completions response had no message content: ${JSON.stringify(body).slice(0, 500)}`);
    err.statusCode = 502;
    throw err;
  }

    return content;
  }, { signal });
}

const MAX_ATTEMPTS = 3; // 1 initial attempt + 2 retries
// Vary sampling across retries so a retry actually explores a different
// completion instead of reproducing the same stuck wrong answer at low temp.
const ATTEMPT_TEMPERATURES = [0.3, 0.7, 1.0];

function clarificationFor(parseError) {
  return parseError
    ? `Your previous response could not be parsed as JSON (${parseError}). You MUST reply with ONLY a single valid JSON object — no markdown fences, no explanation — matching exactly this schema: {"moments":[{"segment_ids":[int,...],"start_time":number,"end_time":number,"reason":string}]}`
    : `Your previous response was valid JSON but did not match the required schema. You MUST reply with ONLY a single valid JSON object matching exactly this schema: {"moments":[{"segment_ids":[int,...],"start_time":number,"end_time":number,"reason":string}]}, with 1 to 2 moments, each 20-60 seconds long (recompute end_time - start_time and check it), non-overlapping, within the transcript's time range.`;
}

/**
 * Ranks moments using Groq. Makes up to MAX_ATTEMPTS total attempts (1
 * initial + 2 retries) with a different temperature each time, each retry
 * appending the prior bad response plus a clarifying follow-up. Throws
 * (never fabricates/returns empty) if every attempt fails — the caller
 * (rankingService orchestrator) decides whether to fall back to Gemini.
 */
async function rankWithGroq(segments, options = {}) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(segments) },
  ];

  let lastContent = null;
  let lastParseError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      messages.push({ role: 'assistant', content: lastContent }, { role: 'user', content: clarificationFor(lastParseError) });
    }

    const temperature = ATTEMPT_TEMPERATURES[attempt - 1] ?? ATTEMPT_TEMPERATURES[ATTEMPT_TEMPERATURES.length - 1];
    // eslint-disable-next-line no-await-in-loop
    const content = await callGroqChat(messages, temperature, options);
    lastContent = content;
    lastParseError = null;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      lastParseError = e.message;
      continue; // eslint-disable-line no-continue
    }

    if (validateShape(parsed)) {
      return { moments: parsed.moments, raw: content, attempts: attempt, retried: attempt > 1, provider: 'groq', model: MODEL };
    }
  }

  const reason = lastParseError ? `did not return valid JSON (${lastParseError})` : 'did not match the required schema';
  const err = new Error(`Groq ranking failed: model ${reason} after ${MAX_ATTEMPTS} attempts. Last response: ${lastContent.slice(0, 500)}`);
  err.statusCode = 502;
  throw err;
}

module.exports = { rankWithGroq, MODEL, MAX_ATTEMPTS };
