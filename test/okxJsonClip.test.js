const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const express = require('express');
const { paymentMiddlewareFromHTTPServer } = require('@okxweb3/x402-express');
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
const { routes, NETWORK, PAY_TO, PRICE } = require('../services/x402Config');

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
    requiresPayment: () => true,
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

function paidResult() {
  return {
    type: 'payment-verified',
    paymentPayload: { accepted: true },
    paymentRequirements: { amount: '1000000' },
    declaredExtensions: {},
  };
}

function createTestApp({ paymentResult = paidResult, pre = {}, business = {} } = {}) {
  const httpServer = createHttpServerDouble(paymentResult);
  const app = express();
  app.set('trust proxy', 1);
  app.use(
    createClipPrepaymentRouter({
      validateRemoteVideoUrl: async (value) => value,
      ...pre,
    })
  );
  app.use(paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false));
  app.use(
    createClipRouter({
      downloadRemoteVideo: async () => ({
        path: '/tmp/mock-remote-video.mp4',
        filename: 'mock-remote-video.mp4',
        originalname: 'remote-video',
        mimetype: 'video/mp4',
        size: 100,
      }),
      checkDurationLimit: async () => ({ durationSeconds: 30 }),
      createJob: () => {},
      runPipeline: async () => {},
      cleanupFiles: async () => {},
      ...business,
    })
  );
  app.use((error, req, res, next) => {
    sendInputError(res, 500, 'INTERNAL_ERROR', 'The request could not be processed.');
  });
  return { app, httpServer };
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

test('missing JSON input is rejected before payment verification or settlement', async () => {
  const { app, httpServer } = createTestApp();
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callerId: 'reviewer' }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'VIDEO_INPUT_REQUIRED');
  assert.equal(httpServer.calls.process, 0);
  assert.equal(httpServer.calls.settle, 0);
});

test('valid unpaid JSON input receives the x402 response unchanged', async () => {
  const challenge = Buffer.from(JSON.stringify({ x402Version: 2, accepts: [] })).toString('base64');
  const { app, httpServer } = createTestApp({
    paymentResult: () => ({
      type: 'payment-error',
      response: {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': challenge },
        body: { x402Version: 2 },
        isHtml: false,
      },
    }),
  });
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callerId: 'reviewer', videoUrl: 'https://example.com/video.mp4' }),
  });
  assert.equal(response.status, 402);
  assert.equal(response.headers.get('payment-required'), challenge);
  assert.equal(httpServer.calls.process, 1);
  assert.equal(httpServer.calls.settle, 0);
});

test('valid paid JSON replay reaches processing and settlement', async () => {
  let pipelineFile;
  const { app, httpServer } = createTestApp({
    business: {
      runPipeline: async (jobId, file) => {
        pipelineFile = file;
      },
    },
  });
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Payment-Signature': 'signed-payment',
      'X-Forwarded-Proto': 'https',
      Host: 'clipagent-n1wx.onrender.com',
    },
    body: JSON.stringify({ callerId: 'reviewer', videoUrl: 'https://example.com/video.mp4' }),
  });
  assert.equal(response.status, 202);
  assert.equal(response.body.success, true);
  assert.equal(response.body.status, 'processing');
  assert.match(response.body.jobId, /^[0-9a-f-]{36}$/);
  assert.match(response.body.statusUrl, /^https:\/\/[^/]+\/job\//);
  assert.equal(pipelineFile.path, '/tmp/mock-remote-video.mp4');
  assert.equal(httpServer.calls.contexts[0].paymentHeader, 'signed-payment');
  assert.equal(httpServer.calls.settle, 1);
});

test('remote download and ffprobe failures return errors without settlement', async () => {
  const downloadFailure = createTestApp({
    business: {
      downloadRemoteVideo: async () => {
        throw new RemoteVideoError('VIDEO_DOWNLOAD_FAILED', 'The video could not be downloaded.', 502);
      },
    },
  });
  const downloadResponse = await request(downloadFailure.app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify({ callerId: 'reviewer', videoUrl: 'https://example.com/video.mp4' }),
  });
  assert.equal(downloadResponse.status, 502);
  assert.equal(downloadFailure.httpServer.calls.settle, 0);

  const validationFailure = createTestApp({
    business: {
      checkDurationLimit: async () => {
        const error = new Error('private ffprobe diagnostic');
        error.statusCode = 400;
        throw error;
      },
    },
  });
  const validationResponse = await request(validationFailure.app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify({ callerId: 'reviewer', videoUrl: 'https://example.com/video.mp4' }),
  });
  assert.equal(validationResponse.status, 400);
  assert.equal(validationResponse.body.error.code, 'VIDEO_VALIDATION_FAILED');
  assert.equal(JSON.stringify(validationResponse.body).includes('ffprobe'), false);
  assert.equal(validationFailure.httpServer.calls.settle, 0);
});

test('media without a video stream returns a safe structured error without settlement', async () => {
  const { app, httpServer } = createTestApp({
    business: {
      checkDurationLimit: async () => {
        throw new VideoStreamRequiredError(new Error('private ffprobe diagnostic'));
      },
    },
  });
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Payment-Signature': 'signed-payment' },
    body: JSON.stringify({ callerId: 'reviewer', videoUrl: 'https://example.com/audio-only.mp4' }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    success: false,
    error: {
      code: 'VIDEO_STREAM_REQUIRED',
      message: 'The supplied media does not contain a valid video stream.',
    },
  });
  assert.equal(JSON.stringify(response.body).includes('ffprobe'), false);
  assert.equal(httpServer.calls.settle, 0);
});

test('multipart upload remains accepted and feeds the same pipeline', async () => {
  let pipelineFile;
  const { app } = createTestApp({
    business: {
      runPipeline: async (jobId, file) => {
        pipelineFile = file;
        await fs.promises.unlink(file.path);
      },
    },
  });
  const form = new FormData();
  form.append('callerId', 'direct-client');
  form.append('video', new Blob(['video'], { type: 'video/mp4' }), 'sample.mp4');
  const response = await request(app, '/clip', { method: 'POST', body: form });
  assert.equal(response.status, 202);
  assert.equal(response.body.callerId, 'direct-client');
  assert.equal(pipelineFile.mimetype, 'video/mp4');
});

test('conflicting multipart file and videoUrl are rejected before payment', async () => {
  const { app, httpServer } = createTestApp();
  const form = new FormData();
  form.append('callerId', 'direct-client');
  form.append('videoUrl', 'https://example.com/other.mp4');
  form.append('video', new Blob(['video'], { type: 'video/mp4' }), 'sample.mp4');
  const response = await request(app, '/clip', { method: 'POST', body: form });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'AMBIGUOUS_VIDEO_INPUT');
  assert.equal(httpServer.calls.process, 0);
  assert.equal(httpServer.calls.settle, 0);
});

test('an unpaid multipart upload is removed after the 402 response', async () => {
  const sourcePath = `/tmp/clipagent-unpaid-${Date.now()}.mp4`;
  await fs.promises.writeFile(sourcePath, 'video');
  const challenge = Buffer.from(JSON.stringify({ x402Version: 2 })).toString('base64');
  const { app } = createTestApp({
    paymentResult: () => ({
      type: 'payment-error',
      response: {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': challenge },
        body: { x402Version: 2 },
        isHtml: false,
      },
    }),
    pre: {
      uploadSingle(req, res, next) {
        req.file = {
          path: sourcePath,
          filename: 'unpaid.mp4',
          originalname: 'unpaid.mp4',
          mimetype: 'video/mp4',
          size: 5,
        };
        req.body = { callerId: 'direct-client' };
        next();
      },
    },
  });
  const response = await request(app, '/clip', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=test' },
  });
  assert.equal(response.status, 402);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(fs.promises.access(sourcePath), { code: 'ENOENT' });
});

test('invalid and non-HTTPS URLs are rejected before payment', async () => {
  const { app, httpServer } = createTestApp({
    pre: { validateRemoteVideoUrl },
  });
  for (const videoUrl of ['not-a-url', 'http://example.com/video.mp4']) {
    const response = await request(app, '/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callerId: 'reviewer', videoUrl }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'INVALID_VIDEO_URL');
  }
  assert.equal(httpServer.calls.process, 0);
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
  assert.equal(PRICE, '1');
  assert.deepEqual(Object.keys(routes).sort(), ['GET /clip', 'POST /clip']);
  assert.deepEqual(routes['POST /clip'].accepts, routes['GET /clip'].accepts);
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
