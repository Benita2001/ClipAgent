const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const express = require('express');
const { paymentMiddlewareFromHTTPServer } = require('@okxweb3/x402-express');
const {
  createClipRequestTracingMiddleware,
  createTracedHttpServer,
} = require('../services/requestTracing');
const {
  createClipPrepaymentRouter,
  createClipRouter,
  sendInputError,
} = require('../routes/clip');
const {
  createClipRequestLifecycle,
} = require('../services/clipRequestLifecycle');
const {
  REMOTE_VIDEO_DOWNLOAD_TIMEOUT_MS,
} = require('../services/remoteVideoService');

function createPaidHttpServer() {
  const calls = { settle: 0 };
  return {
    calls,
    requiresPayment: (context) => context.path === '/clip',
    initialize: async () => {},
    processHTTPRequest: async () => ({
      type: 'payment-verified',
      paymentPayload: { accepted: true },
      paymentRequirements: { amount: '1000000' },
      declaredExtensions: {},
    }),
    processSettlement: async () => {
      calls.settle += 1;
      return { success: true, headers: { 'PAYMENT-RESPONSE': 'settled' } };
    },
  };
}

async function startDisconnectApp(business = {}) {
  const logs = [];
  let resolveFinalStatus;
  let resolveDisconnected;
  const finalStatus = new Promise((resolve) => {
    resolveFinalStatus = resolve;
  });
  const disconnected = new Promise((resolve) => {
    resolveDisconnected = resolve;
  });
  const record = (value) => {
    logs.push(String(value));
    try {
      const entry = JSON.parse(String(value));
      if (entry.event === 'clip_final_handler_status') resolveFinalStatus(entry);
      if (entry.event === 'clip_client_disconnected') resolveDisconnected(entry);
    } catch {
      // Non-structured dependency logs are intentionally ignored.
    }
  };
  const logger = { log: record, info: record, warn: record, error: record };
  const paymentServer = createPaidHttpServer();
  const app = express();
  app.use(createClipRequestTracingMiddleware({ logger }));
  app.use(
    paymentMiddlewareFromHTTPServer(
      createTracedHttpServer(paymentServer, { logger }),
      undefined,
      undefined,
      false
    )
  );
  app.use(createClipPrepaymentRouter({
  }));
  app.use(createClipRouter({
    takePreparedUpload: async () => ({
      uploadId: 'prepared-upload',
      path: '/tmp/graceful-disconnect-source.mp4',
      durationSeconds: 30,
      file: {
        path: '/tmp/graceful-disconnect-source.mp4',
        filename: 'graceful-disconnect-source.mp4',
        originalname: 'prepared.mp4',
        mimetype: 'video/mp4',
        size: 100,
      },
    }),
    getMarketplacePolicy: () => ({
      maxVideoDurationSeconds: 60,
      processingTimeoutMs: 5000,
    }),
    withMarketplaceTimeout: async (timeoutMs, operation) => operation(),
    cleanupFiles: async () => {},
    processClip: async () => ({
      clips: [{
        index: 0,
        reason: 'test',
        requestedStartSeconds: 0,
        requestedEndSeconds: 30,
        actualDurationSeconds: 30,
        supabase: { publicUrl: 'https://cdn.example.test/clip.mp4' },
      }],
      rankingModel: 'mock',
    }),
    ...business,
  }));
  app.use((error, req, res, next) => {
    sendInputError(res, 500, 'INTERNAL_ERROR', 'The request could not be processed.');
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, paymentServer, logs, finalStatus, disconnected };
}

function sendPaidRequestAndDisconnect(server) {
  const request = http.request({
    host: '127.0.0.1',
    port: server.address().port,
    path: '/clip',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Payment-Signature': 'test-payment',
    },
  });
  request.on('error', () => {});
  request.end(JSON.stringify({
    uploadId: 'prepared-upload',
    clipCount: 1,
    minDurationSeconds: 20,
    maxDurationSeconds: 30,
  }));
  return request;
}

test('disconnect while resolving prepared upload blocks processing and skips settlement', async () => {
  let releaseDownload;
  let markDownloadStarted;
  const downloadStarted = new Promise((resolve) => { markDownloadStarted = resolve; });
  const downloadGate = new Promise((resolve) => { releaseDownload = resolve; });
  let pipelineCalls = 0;
  const fixture = await startDisconnectApp({
    takePreparedUpload: async () => {
      markDownloadStarted();
      await downloadGate;
      return {
        uploadId: 'prepared-upload',
        durationSeconds: 30,
        file: {
          path: '/tmp/graceful-disconnect-source.mp4',
          filename: 'graceful-disconnect-source.mp4',
          originalname: 'prepared.mp4',
          mimetype: 'video/mp4',
          size: 100,
        },
      };
    },
    processClip: async () => {
      pipelineCalls += 1;
    },
  });

  try {
    const request = sendPaidRequestAndDisconnect(fixture.server);
    await downloadStarted;
    request.destroy();
    await fixture.disconnected;
    releaseDownload();
    const final = await fixture.finalStatus;

    assert.equal(pipelineCalls, 0);
    assert.equal(final.status, 503);
    assert.equal(fixture.paymentServer.calls.settle, 0);
    assert.ok(fixture.logs.some((line) => line.includes('"event":"clip_client_disconnected"')));
    assert.ok(fixture.logs.some((line) => line.includes('"event":"clip_cleanup_completed"')));
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('disconnect after prepared upload resolution blocks processing and skips settlement', async () => {
  let releaseProbe;
  let markProbeStarted;
  const probeStarted = new Promise((resolve) => { markProbeStarted = resolve; });
  const probeGate = new Promise((resolve) => { releaseProbe = resolve; });
  let pipelineCalls = 0;
  const fixture = await startDisconnectApp({
    takePreparedUpload: async () => {
      markProbeStarted();
      await probeGate;
      return {
        uploadId: 'prepared-upload',
        durationSeconds: 30,
        file: {
          path: '/tmp/graceful-disconnect-source.mp4',
          filename: 'graceful-disconnect-source.mp4',
          originalname: 'prepared.mp4',
          mimetype: 'video/mp4',
          size: 100,
        },
      };
    },
    processClip: async () => {
      pipelineCalls += 1;
    },
  });

  try {
    const request = sendPaidRequestAndDisconnect(fixture.server);
    await probeStarted;
    request.destroy();
    await fixture.disconnected;
    releaseProbe();
    const final = await fixture.finalStatus;

    assert.equal(pipelineCalls, 0);
    assert.equal(final.status, 503);
    assert.equal(fixture.paymentServer.calls.settle, 0);
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

for (const scenario of [
  { active: 'ranking', next: 'cutting/rendering' },
  { active: 'cutting/rendering', next: 'upload' },
  { active: 'upload', next: null },
]) {
  test(`disconnect during ${scenario.active} blocks later work and skips settlement`, async () => {
    let releaseStage;
    let markStageStarted;
    const stageStarted = new Promise((resolve) => { markStageStarted = resolve; });
    const stageGate = new Promise((resolve) => { releaseStage = resolve; });
    let nextStageCalls = 0;
    const fixture = await startDisconnectApp({
      processClip: async (jobId, file, { lifecycle }) => {
        lifecycle.assertCanStartStage(scenario.active);
        markStageStarted();
        await stageGate;
        if (scenario.next) {
          lifecycle.assertCanStartStage(scenario.next);
          nextStageCalls += 1;
        }
        return {
          clips: [{
            index: 0,
            reason: 'test',
            requestedStartSeconds: 0,
            requestedEndSeconds: 30,
            actualDurationSeconds: 30,
            supabase: { publicUrl: 'https://cdn.example.test/clip.mp4' },
          }],
          rankingModel: 'mock',
        };
      },
    });

    try {
      const request = sendPaidRequestAndDisconnect(fixture.server);
      await stageStarted;
      request.destroy();
      await fixture.disconnected;
      releaseStage();
      const final = await fixture.finalStatus;

      assert.equal(final.status, 503);
      assert.equal(fixture.paymentServer.calls.settle, 0);
      assert.equal(nextStageCalls, 0);
      if (scenario.next) {
        assert.ok(fixture.logs.some((line) =>
          line.includes('"event":"clip_stage_blocked"') && line.includes(`"nextStage":"${scenario.next}"`)
        ));
      }
    } finally {
      await new Promise((resolve) => fixture.server.close(resolve));
    }
  });
}

test('disconnect immediately before success blocks HTTP 200 and skips settlement', async () => {
  const fixture = await startDisconnectApp({
    processClip: async (jobId, file, { lifecycle }) => {
      lifecycle.markDisconnected('test_before_success');
      return {
        clips: [{
          index: 0,
          reason: 'test',
          requestedStartSeconds: 0,
          requestedEndSeconds: 30,
          actualDurationSeconds: 30,
          supabase: { publicUrl: 'https://cdn.example.test/clip.mp4' },
        }],
        rankingModel: 'mock',
      };
    },
  });

  try {
    const response = await fetch(`http://127.0.0.1:${fixture.server.address().port}/clip`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Payment-Signature': 'test-payment',
      },
      body: JSON.stringify({
        uploadId: 'prepared-upload',
        clipCount: 1,
        minDurationSeconds: 20,
        maxDurationSeconds: 30,
      }),
    });
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.error.code, 'CLIENT_DISCONNECTED');
    assert.equal(fixture.paymentServer.calls.settle, 0);
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
  }
});

test('duplicate request and response disconnect events are recorded once', () => {
  const logs = [];
  const req = new EventEmitter();
  req.clipTrace = {
    requestId: 'request-id',
    startedAt: Date.now(),
    logger: {
      log: (value) => logs.push(String(value)),
      info: (value) => logs.push(String(value)),
      warn: (value) => logs.push(String(value)),
      error: (value) => logs.push(String(value)),
    },
  };
  const res = new EventEmitter();
  res.writableEnded = false;
  const lifecycle = createClipRequestLifecycle(req, res);

  lifecycle.setStage('downloading');
  req.emit('aborted');
  res.emit('close');

  assert.equal(lifecycle.state.disconnected, true);
  assert.equal(lifecycle.state.disconnectSource, 'request_aborted');
  assert.equal(logs.filter((line) => line.includes('"event":"clip_client_disconnected"')).length, 1);
  assert.equal(logs.filter((line) => line.includes('"event":"clip_duplicate_disconnect_ignored"')).length, 1);
});

test('remote video download default remains a configurable ten-minute guard', () => {
  assert.equal(REMOTE_VIDEO_DOWNLOAD_TIMEOUT_MS, 600000);
});
