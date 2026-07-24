const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const {
  ProviderTimeoutError,
  withProviderTimeout,
  createProviderFetch,
} = require('../utils/providerTimeout');
const { rankMoments } = require('../services/rankingService');
const { createJob, getJob, markDone, markFailed } = require('../services/jobStore');
const { createJobFailure } = require('../services/jobErrors');
const jobRouter = require('../routes/job');

async function request(app, route) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function stalledBodyFetch(url, options) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text() {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
  });
}

test('timeout covers response body consumption and names provider and duration', async () => {
  await assert.rejects(
    withProviderTimeout('Groq Whisper', 5, async ({ signal }) => {
      const response = await stalledBodyFetch('https://example.test', { signal });
      return response.text();
    }),
    (error) => error instanceof ProviderTimeoutError &&
      error.provider === 'Groq Whisper' && error.timeoutMs === 5
  );
});

test('successful response body clears timer and cannot time out later', async () => {
  let callback;
  let clears = 0;
  const timerApi = {
    setTimeout(fn) { callback = fn; return 7; },
    clearTimeout(id) { assert.equal(id, 7); clears += 1; },
  };
  let operationSignal;
  const result = await withProviderTimeout('Groq', 10, async ({ signal }) => {
    operationSignal = signal;
    return { text: async () => 'complete' }.text();
  }, { timerApi });
  callback();
  assert.equal(result, 'complete');
  assert.equal(clears, 1);
  assert.equal(operationSignal.aborted, false);
});

test('caller aborts are preserved and listeners are removed', async () => {
  const already = new AbortController();
  const firstReason = new Error('caller stopped before start');
  already.abort(firstReason);
  await assert.rejects(
    withProviderTimeout('Provider', 100, ({ signal }) => Promise.reject(signal.reason), { signal: already.signal }),
    (error) => error === firstReason
  );

  const active = new AbortController();
  let adds = 0;
  let removes = 0;
  const originalAdd = active.signal.addEventListener.bind(active.signal);
  const originalRemove = active.signal.removeEventListener.bind(active.signal);
  active.signal.addEventListener = (...args) => { adds += 1; return originalAdd(...args); };
  active.signal.removeEventListener = (...args) => { removes += 1; return originalRemove(...args); };
  const secondReason = new Error('caller stopped during request');
  const pending = withProviderTimeout('Provider', 100, ({ signal }) =>
    new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  { signal: active.signal });
  active.abort(secondReason);
  await assert.rejects(pending, (error) => error === secondReason && !(error instanceof ProviderTimeoutError));
  assert.equal(adds, 1);
  assert.equal(removes, 1);
});

test('custom provider fetch preserves request options through body completion', async () => {
  let received;
  let clears = 0;
  const providerFetch = createProviderFetch('Supabase', 100, async (url, options) => {
    received = { url, options };
    return new Response('ok', { status: 200, headers: { 'x-test': 'yes' } });
  }, { setTimeout: () => 1, clearTimeout: () => { clears += 1; } });
  const body = Buffer.from('upload');
  const response = await providerFetch('https://example.test/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer fake', 'x-extra': 'yes' },
    body,
    credentials: 'include',
    redirect: 'manual',
    cache: 'no-store',
  });
  assert.equal(await response.text(), 'ok');
  assert.equal(received.url, 'https://example.test/upload');
  assert.equal(received.options.method, 'POST');
  assert.equal(received.options.headers.Authorization, 'Bearer fake');
  assert.equal(received.options.body, body);
  assert.equal(received.options.credentials, 'include');
  assert.equal(received.options.redirect, 'manual');
  assert.equal(received.options.cache, 'no-store');
  assert.equal(clears, 1);
});

test('Supabase response stream remains protected until body consumption', async () => {
  const providerFetch = createProviderFetch('Supabase', 5, async (url, options) => {
    const stream = new ReadableStream({
      start(controller) {
        options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
      },
    });
    return new Response(stream);
  });
  const response = await providerFetch('https://example.test');
  await assert.rejects(response.text(), (error) =>
    error instanceof ProviderTimeoutError && error.provider === 'Supabase');
});

test('Groq ranking timeout falls back to successful Gemini result', async () => {
  const result = await rankMoments([{ id: 1 }], {
    rankWithGroq: async () => { throw new ProviderTimeoutError('Groq Ranking', 5); },
    rankWithGemini: async () => ({ moments: [{ start_time: 0, end_time: 20 }], attempts: 1 }),
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.match(result.rankingModel, /^gemini\//);
});

test('both ranking providers failing produces a ranking failure', async () => {
  await assert.rejects(rankMoments([{ id: 1 }], {
    rankWithGroq: async () => { throw new ProviderTimeoutError('Groq Ranking', 5); },
    rankWithGemini: async () => { throw new ProviderTimeoutError('Gemini', 5); },
    logger: { log() {}, warn() {}, error() {} },
  }), /Ranking failed on both tiers/);
});

test('only the first terminal transition is accepted and data is immutable', () => {
  const doneId = `done-guard-${Date.now()}`;
  createJob(doneId);
  assert.equal(markDone(doneId, { value: 1 }), true);
  assert.equal(markFailed(doneId, createJobFailure('Ranking', new Error('late failure'))), false);
  assert.equal(markDone(doneId, { value: 2 }), false);
  assert.deepEqual(getJob(doneId).result, { value: 1 });

  const failedId = `failed-guard-${Date.now()}`;
  createJob(failedId);
  const first = createJobFailure('Transcription', new Error('first'));
  assert.equal(markFailed(failedId, first), true);
  assert.equal(markDone(failedId, { value: 1 }), false);
  assert.equal(markFailed(failedId, createJobFailure('Ranking', new Error('second'))), false);
  assert.equal(getJob(failedId).internalError.message, 'first');
});

test('failed job API exposes only stable public error fields', async () => {
  const jobId = `safe-error-${Date.now()}`;
  createJob(jobId);
  const secret = 'fake-api-key-123';
  const diagnostic = new Error(
    '/tmp/clipagent/video.mp4 /private/var/folders/example/output.mp4 C:\\temp\\video.mp4 ' +
    `ffmpeg stderr provider diagnostic Authorization: Bearer ${secret}`
  );
  markFailed(jobId, createJobFailure('Cutting', diagnostic));
  const app = express();
  app.use(jobRouter);
  const response = await request(app, `/job/${jobId}`);
  const serialized = JSON.stringify(response.body);
  assert.deepEqual(Object.keys(response.body).sort(), ['error', 'jobId', 'stage', 'status', 'success']);
  assert.deepEqual(response.body.error, {
    code: 'CLIP_CREATION_FAILED',
    message: 'The video clips could not be created.',
  });
  for (const forbidden of ['/tmp/', '/private/', 'C:\\temp', 'ffmpeg', 'provider diagnostic', secret, 'internalError', 'stack']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
