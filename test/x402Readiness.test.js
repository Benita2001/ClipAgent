const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const healthRouter = require('../routes/health');
const { createReadyRouter } = require('../routes/ready');
const { createX402Initializer, SAFE_INITIALIZATION_ERROR } = require('../services/x402Readiness');

function createProbeApp(getReadinessState) {
  const app = express();
  app.use(healthRouter);
  app.use(createReadyRouter(getReadinessState));
  return app;
}

async function request(app, path) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function silentLogger() {
  return { info() {}, error() {} };
}

test('/health returns 200 regardless of x402 readiness', async () => {
  const app = createProbeApp(() => ({ status: 'failed', attempts: 4 }));
  const response = await request(app, '/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('/ready returns 503 before successful initialization', async () => {
  const initializer = createX402Initializer({ initialize: async () => {}, logger: silentLogger() });
  const app = createProbeApp(initializer.getState);
  const response = await request(app, '/ready');

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    status: 'not_ready',
    x402: { ready: false, state: 'initializing', attempts: 0 },
  });
});

test('/ready returns 200 after initialization succeeds', async () => {
  const initializer = createX402Initializer({ initialize: async () => {}, logger: silentLogger() });
  await initializer.start();
  const response = await request(createProbeApp(initializer.getState), '/ready');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ready', x402: { ready: true } });
});

test('failed initialization is caught and recorded safely', async () => {
  const initializer = createX402Initializer({
    initialize: async () => {
      throw new Error('network unavailable');
    },
    schedule: () => ({ unref() {} }),
    logger: silentLogger(),
  });

  await assert.doesNotReject(initializer.start());
  const state = initializer.getState();
  assert.equal(state.status, 'failed');
  assert.equal(state.attempts, 1);
  assert.equal(state.lastError, SAFE_INITIALIZATION_ERROR);
});

test('failed initialization schedules a retry', async () => {
  const scheduled = [];
  const initializer = createX402Initializer({
    initialize: async () => {
      throw new Error('temporary timeout');
    },
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    random: () => 0.5,
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return { unref() {} };
    },
    logger: silentLogger(),
  });

  await initializer.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 100);
  assert.match(initializer.getState().nextRetryAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('a later successful retry changes readiness to ready', async () => {
  let calls = 0;
  const scheduled = [];
  const initializer = createX402Initializer({
    initialize: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary timeout');
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return { unref() {} };
    },
    logger: silentLogger(),
  });

  await initializer.start();
  assert.equal(initializer.getState().status, 'failed');
  scheduled[0]();
  await new Promise(setImmediate);

  const state = initializer.getState();
  assert.equal(state.status, 'ready');
  assert.equal(state.attempts, 2);
  assert.ok(state.lastSuccessfulInitializationAt);
  assert.equal(state.nextRetryAt, null);
});

test('readiness HTTP responses never expose credential values', async () => {
  const credential = 'super-secret-okx-value';
  const logMessages = [];
  const initializer = createX402Initializer({
    initialize: async () => {
      throw new Error(`authentication rejected for ${credential}`);
    },
    secrets: [credential],
    schedule: () => ({ unref() {} }),
    logger: {
      info() {},
      error(message) {
        logMessages.push(message);
      },
    },
  });

  await initializer.start();
  const response = await request(createProbeApp(initializer.getState), '/ready');
  const serialized = JSON.stringify(response.body);

  assert.equal(response.status, 503);
  assert.equal(serialized.includes(credential), false);
  assert.equal(response.body.x402.lastError, SAFE_INITIALIZATION_ERROR);
  assert.equal(logMessages.join('\n').includes(credential), false);
  assert.match(logMessages[0], /\[REDACTED\]/);
});

test('initialization is not started more than once concurrently', async () => {
  let calls = 0;
  let resolveInitialization;
  const pendingInitialization = new Promise((resolve) => {
    resolveInitialization = resolve;
  });
  const initializer = createX402Initializer({
    initialize: async () => {
      calls += 1;
      await pendingInitialization;
    },
    logger: silentLogger(),
  });

  const first = initializer.start();
  const second = initializer.start();
  assert.equal(first, second);
  assert.equal(calls, 1);

  resolveInitialization();
  await first;
  assert.equal(initializer.getState().status, 'ready');
});

test('apparent permanent failures retry at the slower capped interval', async () => {
  const scheduled = [];
  const initializer = createX402Initializer({
    initialize: async () => {
      throw new Error('401 unauthorized: invalid API key');
    },
    retryBaseMs: 100,
    retryMaxMs: 5_000,
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay });
      return { unref() {} };
    },
    logger: silentLogger(),
  });

  await initializer.start();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 5_000);
});
