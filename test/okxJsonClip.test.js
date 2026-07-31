const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const { PassThrough } = require('node:stream');
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
  RemoteVideoError,
  validateRemoteVideoUrl,
  downloadRemoteVideo,
  isBlockedAddress,
} = require('../services/remoteVideoService');
const { VideoStreamRequiredError } = require('../services/durationLimitService');
const {
  routes,
  NETWORK,
  PAY_TO,
  PRICE,
  MAX_TIMEOUT_SECONDS,
  MIME_TYPE,
} = require('../services/x402Config');
const {
  coerceRequestedClipCount,
  formatClipPrice,
  MAX_REQUESTED_CLIP_COUNT,
} = require('../services/clipPricing');

async function request(app, route, options = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, options);
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function createHttpServerDouble(resultFactory) {
  const calls = { initialize: 0, process: 0, settle: 0, contexts: [] };
  return {
    calls,
    requiresPayment: (context) => context.path === '/clip',
    initialize: async () => {
      calls.initialize += 1;
    },
    processHTTPRequest: async (context) => {
      calls.process += 1;
      calls.contexts.push(context);
      return resultFactory(context);
    },
    processSettlement: async () => {
      calls.settle += 1;
      return { success: true, headers: { 'PAYMENT-RESPONSE': 'settled' } };
    },
  };
}

function paidResult(amount = '0.5') {
  return {
    type: 'payment-verified',
    paymentPayload: { accepted: true },
    paymentRequirements: { amount },
    declaredExtensions: {},
  };
}

function unpaidResult(amount = '0.5') {
  const challenge = Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: {
      url: 'https://clipagent-n1wx.onrender.com/clip',
      mimeType: MIME_TYPE,
    },
    accepts: [{
      network: NETWORK,
      amount,
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    }],
  })).toString('base64');
  return {
    type: 'payment-error',
    response: {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': challenge },
      body: {},
      isHtml: false,
    },
  };
}

const validClipBody = (overrides = {}) => ({
  videoUrl: 'https://cdn.example.test/video.mp4',
  clipCount: 1,
  instructions: 'Find the most engaging moments',
  minDuration: 20,
  maxDuration: 45,
  ...overrides,
});

const validPreparedClipBody = (overrides = {}) => ({
  uploadId: 'prepared-upload',
  clipCount: 1,
  minDurationSeconds: 20,
  maxDurationSeconds: 45,
  ...overrides,
});

function createTestApp({ paymentResult, paymentAmountPaid = null, business = {} } = {}) {
  const logs = [];
  const logger = {
    log: (value) => logs.push(String(value)),
    info: (value) => logs.push(String(value)),
    warn: (value) => logs.push(String(value)),
    error: (value) => logs.push(String(value)),
  };
  let requestedClipCountForPipeline = 1;
  const resolvePayment = paymentResult || ((context) => {
    const body = context.adapter?.getBody?.() || {};
    const { clipCount, tooMany } = coerceRequestedClipCount(body.clipCount);
    if (tooMany || clipCount > MAX_REQUESTED_CLIP_COUNT) {
      return {
        type: 'payment-error',
        response: {
          status: 422,
          headers: { 'PAYMENT-REQUIRED': Buffer.from(JSON.stringify({
            x402Version: 2,
            resource: {
              url: 'https://clipagent-n1wx.onrender.com/clip',
              mimeType: MIME_TYPE,
            },
            accepts: [{
              network: NETWORK,
              amount: formatClipPrice(MAX_REQUESTED_CLIP_COUNT),
              maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
            }],
          })).toString('base64') },
          body: {
            error: {
              code: 'CLIP_COUNT_TOO_LARGE',
              message: 'Requested clipCount must not exceed 3.',
            },
          },
          isHtml: false,
        },
      };
    }

    requestedClipCountForPipeline = clipCount;
    const requiredAmount = formatClipPrice(clipCount);
    if (!context.paymentHeader) {
      return unpaidResult(requiredAmount);
    }
    const paidAmount = paymentAmountPaid === null ? requiredAmount : String(paymentAmountPaid);
    if (Number(paidAmount) < Number(requiredAmount)) {
      return unpaidResult(requiredAmount);
    }
    return paidResult(requiredAmount);
  });
  const httpServer = createHttpServerDouble(resolvePayment);
  const tracedHttpServer = createTracedHttpServer(httpServer, { logger });
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.set('trust proxy', 1);
  app.use(createClipRequestTracingMiddleware({ logger }));
  app.use(paymentMiddlewareFromHTTPServer(tracedHttpServer, undefined, undefined, false));
  app.use(createClipPrepaymentRouter());
  app.use(
    createClipRouter({
      takePreparedUpload: async () => ({
        uploadId: 'prepared-upload',
        durationSeconds: 30,
        file: {
          path: '/tmp/mock-prepared-video.mp4',
          filename: 'mock-prepared-video.mp4',
          originalname: 'prepared-video.mp4',
          mimetype: 'video/mp4',
          size: 100,
        },
      }),
      downloadRemoteVideo: async () => ({
        path: '/tmp/mock-remote-video.mp4',
        filename: 'mock-remote-video.mp4',
        originalname: 'remote-video',
        mimetype: 'video/mp4',
        size: 100,
      }),
      checkDurationLimit: async () => ({ durationSeconds: 30 }),
      getMarketplacePolicy: () => ({
        maxVideoDurationSeconds: 60,
        processingTimeoutMs: 1000,
      }),
      createJob: () => {},
      runPipeline: async () => {},
      processClip: async () => ({
        clips: Array.from({ length: requestedClipCountForPipeline }, (_, index) => ({
          index,
          reason: `test moment ${index + 1}`,
          requestedStartSeconds: index * 30,
          requestedEndSeconds: index * 30 + 30,
          actualDurationSeconds: 30,
          supabase: { publicUrl: `https://cdn.example.test/clip-${index + 1}.mp4` },
        })),
        transcriptDurationSeconds: 120,
        rankingModel: 'mock/ranker',
      }),
      cleanupFiles: async () => {},
      rankMoments: async () => ({
        moments: [{ start_time: 0, end_time: 30, reason: 'test moment' }],
        rankingModel: 'mock/ranker',
      }),
      ...business,
    })
  );
  app.use((req, res) => {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
  });
  app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && error.status === 400 && Object.prototype.hasOwnProperty.call(error, 'body')) {
      sendInputError(res, 400, 'INVALID_JSON', 'The request body must contain valid JSON.');
      return;
    }
    sendInputError(res, 500, 'INTERNAL_ERROR', 'The request could not be processed.');
  });
  return { app, httpServer, logs };
}

function mockRequestSequence(sequence) {
  let index = 0;
  return (url, options, callback) => {
    const requestEmitter = new EventEmitter();
    let response;
    requestEmitter.end = () => {
      const spec = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      response = new PassThrough();
      response.statusCode = spec.statusCode ?? 200;
      response.headers = spec.headers || { 'content-type': 'video/mp4' };
      options.signal?.addEventListener(
        'abort',
        () => {
          response.destroy(options.signal.reason);
          requestEmitter.emit('error', options.signal.reason);
        },
        { once: true }
      );
      callback(response);
      if (spec.chunks) {
        for (const chunk of spec.chunks) response.write(chunk);
        if (!spec.stall) response.end();
      } else if (!spec.stall) {
        response.end();
      }
    };
    return requestEmitter;
  };
}

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

async function readAndRemoveDownloaded(downloaded) {
  try {
    return await fs.promises.readFile(downloaded.path, 'utf8');
  } finally {
    await fs.promises.unlink(downloaded.path);
  }
}

test('bare unpaid POST reaches x402 before business validation', async () => {
  const { app, httpServer } = createTestApp();
  const response = await request(app, '/clip', { method: 'POST' });
  assert.equal(response.status, 402);
  assert.equal(httpServer.calls.process, 1);
  assert.equal(httpServer.calls.settle, 0);
});

test('unpaid JSON challenge price follows the requested clip count', async () => {
  for (const [body, expectedAmount] of [
    [{}, '0.5'],
    [{ clipCount: 1 }, '0.5'],
    [{ clipCount: 2 }, '1.0'],
    [{ clipCount: 3 }, '1.5'],
    [{ uploadId: 'prepared-upload' }, '0.5'],
  ]) {
    const { app, httpServer } = createTestApp();
    const response = await request(app, '/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 402);
    const challenge = JSON.parse(
      Buffer.from(response.headers.get('payment-required'), 'base64').toString('utf8')
    );
    assert.equal(challenge.accepts[0].amount, expectedAmount);
    assert.equal(httpServer.calls.process, 1);
    assert.equal(httpServer.calls.settle, 0);
  }
});

test('unpaid malformed JSON is rejected before payment parsing', async () => {
  const { app } = createTestApp();
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{malformed',
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_JSON');
});

test('unpaid multipart reaches x402 before content-type validation', async () => {
  const { app, httpServer } = createTestApp();
  const form = new FormData();
  form.append('video', new Blob(['video'], { type: 'video/mp4' }), 'sample.mp4');
  const response = await request(app, '/clip', { method: 'POST', body: form });
  assert.equal(response.status, 402);
  assert.equal(httpServer.calls.settle, 0);
});

test('paid replay missing clip parameters is rejected after verification without settlement', async () => {
  const { app, httpServer } = createTestApp();
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_CLIP_PARAMETERS');
  assert.equal(httpServer.calls.process, 1);
  assert.equal(httpServer.calls.settle, 0);
});

test('paid replay missing uploadId is rejected after verification without settlement', async () => {
  const { app, httpServer } = createTestApp();
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify({ clipCount: 1, minDurationSeconds: 20, maxDurationSeconds: 30 }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'INVALID_CLIP_PARAMETERS');
  assert.equal(httpServer.calls.process, 1);
  assert.equal(httpServer.calls.settle, 0);
});

test('valid unpaid JSON input receives the x402 response unchanged', async () => {
  const { app, httpServer } = createTestApp();
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validClipBody()),
  });
  assert.equal(response.status, 402);
  assert.ok(response.headers.get('payment-required'));
  const challenge = JSON.parse(
    Buffer.from(response.headers.get('payment-required'), 'base64').toString('utf8')
  );
  assert.equal(challenge.accepts[0].amount, '0.5');
  assert.equal(httpServer.calls.process, 1);
  assert.equal(httpServer.calls.settle, 0);
});

test('unpaid multipart input returns x402 before JSON enforcement', async () => {
  const { app } = createTestApp();
  const form = new FormData();
  form.append('video', new Blob(['video'], { type: 'video/mp4' }), 'sample.mp4');
  const response = await request(app, '/clip', { method: 'POST', body: form });
  assert.equal(response.status, 402);
});

test('challenge advertises JSON MIME type and configured timeout', async () => {
  const { app } = createTestApp();
  const response = await request(app, '/clip', { method: 'POST' });
  const challenge = JSON.parse(
    Buffer.from(response.headers.get('payment-required'), 'base64').toString('utf8')
  );
  assert.equal(challenge.resource.mimeType, 'application/json');
  assert.equal(challenge.accepts[0].amount, '0.5');
  assert.equal(challenge.accepts[0].maxTimeoutSeconds, MAX_TIMEOUT_SECONDS);
});

test('1, 2, and 3 clip paid replays are accepted at the matching amounts', async () => {
  for (const [clipCount, paymentAmount] of [[1, 0.5], [2, 1.0], [3, 1.5]]) {
    const { app, httpServer } = createTestApp({ paymentAmountPaid: paymentAmount });
    const response = await request(app, '/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Payment-Signature': 'signed-payment',
        'X-Forwarded-Proto': 'https',
        Host: 'clipagent-n1wx.onrender.com',
      },
      body: JSON.stringify(validClipBody({ clipCount })),
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.requestedClipCount, clipCount);
    assert.equal(response.body.generatedClipCount, clipCount);
    assert.equal(response.body.pricePerClip, '0.5');
    assert.equal(response.body.totalAmountPaid, formatClipPrice(clipCount));
    assert.equal(response.body.clips.length, clipCount);
    assert.equal(httpServer.calls.settle, 1);
  }
});

test('underpaid three-clip requests are rejected without settlement', async () => {
  for (const paymentAmount of [0.5, 1.0]) {
    const { app, httpServer } = createTestApp({ paymentAmountPaid: paymentAmount });
    const response = await request(app, '/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Payment-Signature': 'signed-payment',
      },
      body: JSON.stringify(validClipBody({ clipCount: 3 })),
    });
    assert.equal(response.status, 402);
    assert.equal(httpServer.calls.settle, 0);
  }
});

test('requesting four clips is rejected before processing', async () => {
  const { app, httpServer } = createTestApp();
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Payment-Signature': 'signed-payment',
    },
    body: JSON.stringify(validClipBody({ clipCount: 4 })),
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'CLIP_COUNT_TOO_LARGE');
  assert.equal(httpServer.calls.process, 1);
  assert.equal(httpServer.calls.settle, 0);
});

test('missing quantity with 0.5 USDT defaults to 1 clip', async () => {
  const { app, httpServer } = createTestApp({ paymentAmountPaid: 0.5 });
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Payment-Signature': 'signed-payment',
      'X-Forwarded-Proto': 'https',
      Host: 'clipagent-n1wx.onrender.com',
    },
    body: JSON.stringify({ videoUrl: validClipBody().videoUrl }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.requestedClipCount, 1);
  assert.equal(response.body.totalAmountPaid, '0.5');
  assert.equal(httpServer.calls.settle, 1);
});

test('invalid payment replay does not enter business processing or settlement', async () => {
  let processingCalls = 0;
  const { app, httpServer, logs } = createTestApp({
    paymentResult: () => unpaidResult(),
    business: {
      processClip: async () => {
        processingCalls += 1;
      },
    },
  });
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Payment-Signature': 'invalid-payment' },
  });
  assert.equal(response.status, 402);
  assert.equal(processingCalls, 0);
  assert.equal(httpServer.calls.settle, 0);
});

test('valid paid JSON replay waits for completed clips before settlement', async () => {
  let pipelineFile;
  let releasePipeline;
  const pipelineGate = new Promise((resolve) => { releasePipeline = resolve; });
  let markPipelineStarted;
  const pipelineStarted = new Promise((resolve) => { markPipelineStarted = resolve; });
  const events = [];
  const { app, httpServer, logs } = createTestApp({
    business: {
      processClip: async (jobId, file) => {
        pipelineFile = file;
        events.push('processing-started');
        markPipelineStarted();
        await pipelineGate;
        events.push('upload-completed');
        return {
          clips: [{
            index: 0,
            reason: 'test moment',
            requestedStartSeconds: 0,
            requestedEndSeconds: 30,
            actualDurationSeconds: 30,
            supabase: { publicUrl: 'https://cdn.example.test/clip.mp4' },
          }],
          transcriptDurationSeconds: 120,
          rankingModel: 'mock/ranker',
        };
      },
    },
  });
  const responsePromise = request(app, '/clip', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Payment-Signature': 'signed-payment',
      'X-Forwarded-Proto': 'https',
      Host: 'clipagent-n1wx.onrender.com',
    },
    body: JSON.stringify(validClipBody()),
  });
  await pipelineStarted;
  assert.deepEqual(events, ['processing-started']);
  assert.equal(httpServer.calls.settle, 0);
  releasePipeline();
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.requestedClipCount, 1);
  assert.equal(response.body.generatedClipCount, 1);
  assert.equal(response.body.pricePerClip, '0.5');
  assert.equal(response.body.totalAmountPaid, '0.5');
  assert.equal(Object.hasOwn(response.body, 'uploadId'), false);
  assert.equal(response.body.clips[0].url, 'https://cdn.example.test/clip.mp4');
  assert.equal(response.body.clips[0].selectionReason, 'test moment');
  assert.equal(response.body.statusUrl, undefined);
  assert.equal(pipelineFile.path, '/tmp/mock-remote-video.mp4');
  assert.equal(httpServer.calls.contexts[0].paymentHeader, 'signed-payment');
  assert.equal(httpServer.calls.settle, 1);
  assert.deepEqual(events, ['processing-started', 'upload-completed']);
  const structuredEvents = logs
    .map((line) => {
      try { return JSON.parse(line).event; } catch { return null; }
    })
    .filter(Boolean);
  assert.ok(
    structuredEvents.indexOf('x402.verification_finished') <
      structuredEvents.indexOf('x402.settlement_started')
  );
  assert.ok(
    structuredEvents.indexOf('x402.settlement_started') <
      structuredEvents.indexOf('x402.settlement_finished')
  );
  assert.ok(
    structuredEvents.indexOf('x402.settlement_finished') <
      structuredEvents.indexOf('response.released')
  );
});

test('URL request is replayed identically and downloads exactly once only after verification', async () => {
  const serializedBody = JSON.stringify(validClipBody());
  let downloadCalls = 0;
  let pipelineCalls = 0;
  let downloadedUrl;
  const business = {
    downloadRemoteVideo: async (videoUrl) => {
      downloadCalls += 1;
      downloadedUrl = videoUrl;
      return {
        path: '/tmp/mock-remote-video.mp4',
        filename: 'mock-remote-video.mp4',
        mimetype: 'video/mp4',
        size: 100,
      };
    },
    processClip: async () => {
      pipelineCalls += 1;
      return {
        clips: [{
          requestedStartSeconds: 0,
          requestedEndSeconds: 30,
          actualDurationSeconds: 30,
          supabase: { publicUrl: 'https://cdn.example.test/clip.mp4' },
        }],
      };
    },
  };

  const unpaid = createTestApp({ business });
  const unpaidResponse = await request(unpaid.app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: serializedBody,
  });
  assert.equal(unpaidResponse.status, 402);
  assert.equal(downloadCalls, 0);
  assert.equal(pipelineCalls, 0);
  assert.equal(unpaid.httpServer.calls.settle, 0);

  const paid = createTestApp({ business });
  const paidResponse = await request(paid.app, '/clip', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Payment-Signature': 'signed-payment',
    },
    body: serializedBody,
  });
  assert.equal(paidResponse.status, 200);
  assert.equal(downloadedUrl, validClipBody().videoUrl);
  assert.equal(downloadCalls, 1);
  assert.equal(pipelineCalls, 1);
  assert.equal(paid.httpServer.calls.settle, 1);
  assert.equal(paidResponse.body.clips[0].url.startsWith('https://'), true);
});

test('remote download and FFprobe failures clean local source and never settle', async () => {
  const downloadFailure = createTestApp({
    business: {
      downloadRemoteVideo: async () => {
        throw new RemoteVideoError('VIDEO_DOWNLOAD_FAILED', 'download failed', 502);
      },
    },
  });
  const failedDownload = await request(downloadFailure.app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify(validClipBody()),
  });
  assert.equal(failedDownload.status, 502);
  assert.equal(failedDownload.body.error.code, 'VIDEO_DOWNLOAD_FAILED');
  assert.equal(downloadFailure.httpServer.calls.settle, 0);

  const cleaned = [];
  let pipelineCalls = 0;
  const probeFailure = createTestApp({
    business: {
      checkDurationLimit: async () => {
        throw new VideoStreamRequiredError();
      },
      cleanupFiles: async (paths) => cleaned.push(...paths),
      processClip: async () => { pipelineCalls += 1; },
    },
  });
  const failedProbe = await request(probeFailure.app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify(validClipBody()),
  });
  assert.equal(failedProbe.status, 400);
  assert.equal(failedProbe.body.error.code, 'VIDEO_STREAM_REQUIRED');
  assert.deepEqual(cleaned, ['/tmp/mock-remote-video.mp4']);
  assert.equal(pipelineCalls, 0);
  assert.equal(probeFailure.httpServer.calls.settle, 0);
});

test('cleanup failure prevents HTTP 200 and settlement', async () => {
  const { app, httpServer } = createTestApp({
    business: {
      processClip: async () => {
        const error = new Error('cleanup failed');
        error.code = 'CLEANUP_FAILED';
        error.statusCode = 500;
        throw error;
      },
    },
  });
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify(validClipBody()),
  });
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'CLEANUP_FAILED');
  assert.equal(httpServer.calls.settle, 0);
});

test('invalid prepared upload returns 404 without processing or settlement', async () => {
  let processingCalls = 0;
  const missingUpload = createTestApp({
    business: {
      takePreparedUpload: async () => null,
      processClip: async () => { processingCalls += 1; },
    },
  });
  const response = await request(missingUpload.app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify(validPreparedClipBody()),
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'UPLOAD_NOT_FOUND');
  assert.equal(processingCalls, 0);
  assert.equal(missingUpload.httpServer.calls.settle, 0);
});

test('rendering and upload failures return structured errors without settlement', async () => {
  for (const [code, message] of [
    ['CLIP_RENDER_FAILED', 'The selected video clips could not be rendered.'],
    ['UPLOAD_FAILED', 'The generated clips could not be uploaded.'],
  ]) {
    const { app, httpServer } = createTestApp({
      business: {
        processClip: async () => {
          const error = new Error('private provider diagnostic');
          error.pipelineFailure = { publicError: { code, message } };
          throw error;
        },
      },
    });
    const response = await request(app, '/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
      body: JSON.stringify(validClipBody()),
    });
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, code);
    assert.equal(typeof response.body.error.requestId, 'string');
    assert.equal(response.body.error.requestId.length > 0, true);
    assert.equal(JSON.stringify(response.body).includes('private'), false);
    assert.equal(httpServer.calls.settle, 0);
  }
});

test('marketplace timeout returns 504 and skips settlement', async () => {
  const { app, httpServer } = createTestApp({
    business: {
      getMarketplacePolicy: () => ({ maxVideoDurationSeconds: 60, processingTimeoutMs: 5 }),
      processClip: () => new Promise(() => {}),
    },
  });
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify(validClipBody()),
  });
  assert.equal(response.status, 504);
  assert.equal(response.body.error.code, 'PROCESSING_TIMEOUT');
  assert.equal(httpServer.calls.settle, 0);
});

test('over-limit marketplace media is rejected before processing and settlement', async () => {
  let processingCalls = 0;
  const { app, httpServer } = createTestApp({
    business: {
      checkDurationLimit: async () => ({ durationSeconds: 61 }),
      getMarketplacePolicy: () => ({ maxVideoDurationSeconds: 60, processingTimeoutMs: 1000 }),
      processClip: async () => { processingCalls += 1; },
    },
  });
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify(validClipBody()),
  });
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'MARKETPLACE_VIDEO_TOO_LONG');
  assert.equal(processingCalls, 0);
  assert.equal(httpServer.calls.settle, 0);
});

test('non-JSON paid input is rejected without settlement', async () => {
  const { app, httpServer } = createTestApp({
  });
  const form = new FormData();
  form.append('video', new Blob(['video'], { type: 'video/mp4' }), 'sample.mp4');
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Payment-Signature': 'signed-payment' },
    body: form,
  });

  assert.equal(response.status, 415);
  assert.equal(response.body.success, false);
  assert.equal(response.body.error.code, 'JSON_REQUIRED');
  assert.equal(httpServer.calls.settle, 0);
});

test('multipart upload is not accepted by paid clip endpoint', async () => {
  const { app, httpServer } = createTestApp();
  const form = new FormData();
  form.append('video', new Blob(['video'], { type: 'video/mp4' }), 'sample.mp4');
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Payment-Signature': 'signed-payment' },
    body: form,
  });
  assert.equal(response.status, 415);
  assert.equal(response.body.error.code, 'JSON_REQUIRED');
  assert.equal(httpServer.calls.settle, 0);
});

test('the obsolete async endpoint is not exposed', async () => {
  const { app } = createTestApp();
  const response = await request(app, '/clip/async', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(validClipBody()),
  });
  assert.equal(response.status, 404);
});

test('paid multipart input is rejected without settlement', async () => {
  const { app, httpServer } = createTestApp();
  const form = new FormData();
  form.append('video', new Blob(['video'], { type: 'video/mp4' }), 'sample.mp4');
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Payment-Signature': 'signed-payment' },
    body: form,
  });
  assert.equal(response.status, 415);
  assert.equal(response.body.error.code, 'JSON_REQUIRED');
  assert.equal(httpServer.calls.process, 1);
  assert.equal(httpServer.calls.settle, 0);
});

test('invalid clip parameter shapes are rejected after payment without settlement', async () => {
  const { app, httpServer } = createTestApp();
  for (const body of [
    { uploadId: 'x', clipCount: 1, minDurationSeconds: 30, maxDurationSeconds: 20 },
    { videoUrl: 'https://example.com/video.mp4', minDurationSeconds: 45, maxDurationSeconds: 20 },
    validClipBody({ uploadId: 'prepared-upload' }),
    validClipBody({ path: '/tmp/video.mp4' }),
  ]) {
    const response = await request(app, '/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_CLIP_PARAMETERS');
  }
  assert.equal(httpServer.calls.process, 4);
  assert.equal(httpServer.calls.settle, 0);
});

test('paid GET returns 405 and is not settled instead of returning a usage hint', async () => {
  const { app, httpServer } = createTestApp();
  const response = await request(app, '/clip', {
    method: 'GET',
    headers: { 'Payment-Signature': 'signed-payment' },
  });
  assert.equal(response.status, 405);
  assert.equal(response.body.error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(httpServer.calls.settle, 0);
});

test('payment constants and challenge route configuration remain unchanged', () => {
  assert.equal(NETWORK, 'eip155:196');
  assert.equal(PAY_TO, '0x344fdf33c7907c1267c73b940ce91741097cea49');
  assert.equal(PRICE, '0.5');
  assert.deepEqual(Object.keys(routes), ['POST /clip']);
  assert.equal(routes['POST /clip'].mimeType, 'application/json');
  assert.match(routes['POST /clip'].description, /clipCount defaults to 1/);
  assert.equal(MAX_TIMEOUT_SECONDS, 300);
});

test('structured request logs never include payment signature or secret values', async () => {
  const secretValues = [
    'signature-value-must-not-appear',
    'secret-api-value-must-not-appear',
  ];
  const previousApiKey = process.env.OKX_API_KEY;
  process.env.OKX_API_KEY = secretValues[1];
  try {
    const { app, logs } = createTestApp();
    await request(app, '/clip', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Payment-Signature': secretValues[0],
      },
      body: JSON.stringify({ bogus: true }),
    });
    const output = logs.join('\n');
    for (const secret of secretValues) assert.equal(output.includes(secret), false);
    assert.equal(output.includes('x402.paid_replay_received'), true);
    assert.equal(output.includes('request.input_rejected'), true);
    assert.equal(output.includes('response.released'), true);
  } finally {
    if (previousApiKey === undefined) delete process.env.OKX_API_KEY;
    else process.env.OKX_API_KEY = previousApiKey;
  }
});

test('remote URL validation blocks local, private, link-local, and metadata addresses', async () => {
  const blocked = ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fc00::1', 'fe80::1'];
  for (const address of blocked) {
    assert.equal(isBlockedAddress(address, address.includes(':') ? 6 : 4), true);
  }
  await assert.rejects(
    validateRemoteVideoUrl('https://private.example/video.mp4', {
      resolveHostname: async () => [{ address: '169.254.169.254', family: 4 }],
    }),
    (error) => error instanceof RemoteVideoError && error.code === 'VIDEO_URL_BLOCKED'
  );
  await assert.rejects(
    validateRemoteVideoUrl('https://[::1]/video.mp4'),
    (error) => error instanceof RemoteVideoError && error.code === 'VIDEO_URL_BLOCKED'
  );
});

test('remote video streams to a temporary file and reports actual size', async () => {
  const downloaded = await downloadRemoteVideo('https://example.com/video.mp4', {
    requestImpl: mockRequestSequence([{ chunks: [Buffer.from('abc'), Buffer.from('def')] }]),
    resolveHostname: publicDns,
    maxBytes: 100,
  });
  try {
    assert.equal(downloaded.size, 6);
    assert.equal(await fs.promises.readFile(downloaded.path, 'utf8'), 'abcdef');
  } finally {
    await fs.promises.unlink(downloaded.path);
  }
});

test('direct MP4 and extensionless video URLs stream successfully', async () => {
  for (const videoUrl of [
    'https://cdn.example/videos/interview.mp4',
    'https://cdn.example/delivery/asset-id',
  ]) {
    const downloaded = await downloadRemoteVideo(videoUrl, {
      requestImpl: mockRequestSequence([
        { headers: { 'content-type': 'video/mp4' }, chunks: [Buffer.from('video-bytes')] },
      ]),
      resolveHostname: publicDns,
      maxBytes: 100,
    });
    assert.equal(downloaded.mimetype, 'video/mp4');
    assert.equal(await readAndRemoveDownloaded(downloaded), 'video-bytes');
  }
});

test('generic direct-media types and missing Content-Type are downloaded for later ffprobe validation', async () => {
  for (const headers of [
    { 'content-type': 'application/octet-stream' },
    { 'content-type': 'application/mp4' },
    { 'content-type': 'application/x-matroska' },
    {},
  ]) {
    const downloaded = await downloadRemoteVideo('https://storage.example/object-id', {
      requestImpl: mockRequestSequence([{ headers, chunks: [Buffer.from('media')] }]),
      resolveHostname: publicDns,
      maxBytes: 100,
    });
    assert.equal(downloaded.mimetype, headers['content-type'] || 'application/octet-stream');
    assert.equal(await readAndRemoveDownloaded(downloaded), 'media');
  }
});

test('HTML and Google Drive-style share pages are rejected as unsupported media', async () => {
  for (const contentType of ['text/html; charset=utf-8', 'application/xhtml+xml']) {
    await assert.rejects(
      downloadRemoteVideo('https://drive.example/share-page', {
        requestImpl: mockRequestSequence([
          {
            headers: { 'content-type': contentType },
            chunks: [Buffer.from('<html><video></video></html>')],
          },
        ]),
        resolveHostname: publicDns,
      }),
      (error) =>
        error instanceof RemoteVideoError &&
        error.code === 'UNSUPPORTED_VIDEO_TYPE' &&
        error.statusCode === 415
    );
  }
});

test('safe redirects to video succeed while redirects to HTML are rejected', async () => {
  const redirectedVideo = await downloadRemoteVideo('https://share.example/file', {
    requestImpl: mockRequestSequence([
      {
        statusCode: 302,
        headers: { location: 'https://cdn.example/asset' },
      },
      {
        headers: { 'content-type': 'video/webm' },
        chunks: [Buffer.from('webm-bytes')],
      },
    ]),
    resolveHostname: publicDns,
  });
  assert.equal(redirectedVideo.mimetype, 'video/webm');
  assert.equal(await readAndRemoveDownloaded(redirectedVideo), 'webm-bytes');

  await assert.rejects(
    downloadRemoteVideo('https://share.example/file', {
      requestImpl: mockRequestSequence([
        {
          statusCode: 302,
          headers: { location: 'https://share.example/confirmation' },
        },
        {
          headers: { 'content-type': 'text/html' },
          chunks: [Buffer.from('<html>Confirm download</html>')],
        },
      ]),
      resolveHostname: publicDns,
    }),
    (error) => error instanceof RemoteVideoError && error.code === 'UNSUPPORTED_VIDEO_TYPE'
  );
});

test('signed query parameters are preserved for download but absent from errors and logs', async () => {
  const secretQuery = 'signature=temporary-secret&expires=9999999999';
  const signedUrl = `https://storage.example/object?${secretQuery}`;
  let requestedUrl;
  const requestImpl = (url, options, callback) => {
    requestedUrl = url.toString();
    return mockRequestSequence([
      { headers: { 'content-type': 'video/mp4' }, chunks: [Buffer.from('signed-media')] },
    ])(url, options, callback);
  };

  const downloaded = await downloadRemoteVideo(signedUrl, {
    requestImpl,
    resolveHostname: publicDns,
  });
  assert.equal(requestedUrl, signedUrl);
  assert.equal(await readAndRemoveDownloaded(downloaded), 'signed-media');

  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    await assert.rejects(
      downloadRemoteVideo(signedUrl, {
        requestImpl: mockRequestSequence([
          { headers: { 'content-type': 'text/html' }, chunks: [Buffer.from('<html></html>')] },
        ]),
        resolveHostname: publicDns,
      }),
      (error) =>
        error.code === 'UNSUPPORTED_VIDEO_TYPE' &&
        !error.message.includes('temporary-secret') &&
        !error.message.includes('signature=')
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(logged.some((entry) => entry.includes('temporary-secret') || entry.includes('signature=')), false);
});

test('unexpected transport errors are converted to URL-free download errors', async () => {
  const signedUrl = 'https://storage.example/object?signature=temporary-secret';
  const requestImpl = (url) => {
    const requestEmitter = new EventEmitter();
    requestEmitter.end = () => {
      requestEmitter.emit('error', new Error(`socket failed for ${url}`));
    };
    return requestEmitter;
  };

  await assert.rejects(
    downloadRemoteVideo(signedUrl, {
      requestImpl,
      resolveHostname: publicDns,
    }),
    (error) =>
      error instanceof RemoteVideoError &&
      error.code === 'VIDEO_DOWNLOAD_FAILED' &&
      error.statusCode === 502 &&
      !error.message.includes('temporary-secret') &&
      !error.message.includes('signature=')
  );
});

test('remote body timeout aborts consumption and removes the partial file', async () => {
  let cleanedPath;
  await assert.rejects(
    downloadRemoteVideo('https://example.com/video.mp4', {
      requestImpl: mockRequestSequence([{ chunks: [Buffer.from('partial')], stall: true }]),
      resolveHostname: publicDns,
      timeoutMs: 5,
      cleanupFiles: async (paths) => {
        [cleanedPath] = paths;
        await Promise.all(paths.map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
      },
    }),
    (error) => error.code === 'PROVIDER_TIMEOUT'
  );
  await assert.rejects(fs.promises.access(cleanedPath), { code: 'ENOENT' });
});

test('remote timeout also covers a stalled DNS lookup', async () => {
  await assert.rejects(
    downloadRemoteVideo('https://example.com/video.mp4', {
      requestImpl: mockRequestSequence([{ chunks: [Buffer.from('unused')] }]),
      resolveHostname: async () => new Promise(() => {}),
      timeoutMs: 5,
    }),
    (error) => error.code === 'PROVIDER_TIMEOUT'
  );
});

test('oversized Content-Length is rejected before streaming and partial file is absent', async () => {
  let cleanedPath;
  await assert.rejects(
    downloadRemoteVideo('https://example.com/video.mp4', {
      requestImpl: mockRequestSequence([
        { headers: { 'content-type': 'video/mp4', 'content-length': '101' } },
      ]),
      resolveHostname: publicDns,
      maxBytes: 100,
      cleanupFiles: async (paths) => {
        [cleanedPath] = paths;
        await Promise.all(paths.map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
      },
    }),
    (error) => error.code === 'VIDEO_TOO_LARGE'
  );
  await assert.rejects(fs.promises.access(cleanedPath), { code: 'ENOENT' });
});

test('streaming beyond the byte limit is aborted and partial file is removed', async () => {
  let cleanedPath;
  await assert.rejects(
    downloadRemoteVideo('https://example.com/video.mp4', {
      requestImpl: mockRequestSequence([{ chunks: [Buffer.alloc(60), Buffer.alloc(60)] }]),
      resolveHostname: publicDns,
      maxBytes: 100,
      cleanupFiles: async (paths) => {
        [cleanedPath] = paths;
        await Promise.all(paths.map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
      },
    }),
    (error) => error.code === 'VIDEO_TOO_LARGE'
  );
  await assert.rejects(fs.promises.access(cleanedPath), { code: 'ENOENT' });
});

test('redirect limits and private redirect destinations are enforced', async () => {
  const redirect = {
    statusCode: 302,
    headers: { location: 'https://redirect.example/video.mp4' },
  };
  await assert.rejects(
    downloadRemoteVideo('https://example.com/video.mp4', {
      requestImpl: mockRequestSequence([redirect]),
      resolveHostname: publicDns,
      maxRedirects: 0,
    }),
    (error) => error.code === 'VIDEO_REDIRECT_LIMIT'
  );

  await assert.rejects(
    downloadRemoteVideo('https://example.com/video.mp4', {
      requestImpl: mockRequestSequence([
        {
          statusCode: 302,
          headers: { location: 'https://private.example/video.mp4' },
        },
      ]),
      resolveHostname: async (hostname) => [
        { address: hostname === 'private.example' ? '127.0.0.1' : '93.184.216.34', family: 4 },
      ],
    }),
    (error) => error.code === 'VIDEO_URL_BLOCKED'
  );
});

test('caller cancellation aborts remote download and cleans the partial file', async () => {
  const controller = new AbortController();
  let cleanedPath;
  const pending = downloadRemoteVideo('https://example.com/video.mp4', {
    requestImpl: mockRequestSequence([{ stall: true }]),
    resolveHostname: publicDns,
    signal: controller.signal,
    cleanupFiles: async (paths) => {
      [cleanedPath] = paths;
      await Promise.all(paths.map((filePath) => fs.promises.unlink(filePath).catch(() => {})));
    },
  });
  controller.abort(new Error('caller cancelled'));
  await assert.rejects(pending, /caller cancelled/);
  await assert.rejects(fs.promises.access(cleanedPath), { code: 'ENOENT' });
});
