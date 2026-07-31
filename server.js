require('dotenv').config();

const express = require('express');
const path = require('path');
const multer = require('multer');
const { paymentMiddlewareFromHTTPServer } = require('@okxweb3/x402-express');
const { ensureUploadDir } = require('./utils/tempDir');
const { ensureOutputDir } = require('./utils/outputDir');
const {
  UnsupportedFileTypeError,
  PREPARATION_MAX_UPLOAD_BYTES,
} = require('./services/uploadService');
const { resourceServer, httpServer } = require('./services/x402Config');
const { coerceRequestedClipCount, MAX_REQUESTED_CLIP_COUNT } = require('./services/clipPricing');
const { redactDiagnostic } = require('./services/jobErrors');
const { createX402Initializer } = require('./services/x402Readiness');
const {
  createClipRequestTracingMiddleware,
  createTracedHttpServer,
  logInputRejected,
} = require('./services/requestTracing');
const healthRouter = require('./routes/health');
const { createReadyRouter } = require('./routes/ready');
const clipRouter = require('./routes/clip');
const { createClipPrepaymentRouter, sendInputError } = require('./routes/clip');
const clipagentSchemaRouter = require('./routes/clipagentSchema');
const uploadsRouter = require('./routes/uploads');

ensureUploadDir();
ensureOutputDir();

const app = express();
app.use(express.json({ limit: '8kb' }));

// Render terminates TLS at its edge and forwards over plain HTTP, setting
// X-Forwarded-Proto. Without trusting the proxy, req.protocol always reports
// 'http', which leaks into the x402 payment challenge's resource.url and
// fails OKX's x402 standard validation (resource scheme must match the
// actual HTTPS endpoint).
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

const x402Initializer = createX402Initializer({
  initialize: () => resourceServer.initialize(),
});
const tracedHttpServer = createTracedHttpServer(httpServer);

httpServer.onProtectedRequest((context, routeConfig) => {
  if (context.path !== '/clip' || context.method !== 'POST' || routeConfig?.mimeType !== 'application/json') {
    return undefined;
  }
  const body = typeof context.adapter?.getBody === 'function' ? context.adapter.getBody() || {} : {};
  const { clipCount, tooMany } = coerceRequestedClipCount(body.clipCount);
  if (tooMany || clipCount > MAX_REQUESTED_CLIP_COUNT) {
    return { abort: true, reason: 'Requested clipCount must not exceed 3.' };
  }
  return undefined;
});

app.use(healthRouter);
app.use(createReadyRouter(x402Initializer.getState));
app.use(clipagentSchemaRouter);
// Free preparation endpoint. It is deliberately mounted before x402 so the
// binary upload is never part of a paid replay.
app.use(uploadsRouter);
app.use(createClipRequestTracingMiddleware());
// Gate every /clip request before parsing or validating business input. The
// installed middleware releases handler responses with status >= 400 without
// settlement, so an invalid paid replay remains uncharged.
// Initialization is owned by x402Initializer below. Disable the SDK
// middleware's separate eager initialization promise so every failure is
// bounded, logged, and retried by one controller.
app.use(paymentMiddlewareFromHTTPServer(tracedHttpServer, undefined, undefined, false));
app.use(createClipPrepaymentRouter());
app.use(clipRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof UnsupportedFileTypeError) {
    logInputRejected(req, 'UNSUPPORTED_VIDEO_TYPE', 'multipart');
    sendInputError(res, err.statusCode, 'UNSUPPORTED_VIDEO_TYPE', 'The uploaded file type is not supported.');
    return;
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMb = PREPARATION_MAX_UPLOAD_BYTES / 1024 / 1024;
      logInputRejected(req, 'VIDEO_TOO_LARGE', 'multipart');
      sendInputError(res, 413, 'VIDEO_TOO_LARGE', `The uploaded video exceeds the ${maxMb}MB limit.`);
      return;
    }
    logInputRejected(req, 'UPLOAD_INVALID', 'multipart');
    sendInputError(res, 400, 'UPLOAD_INVALID', 'The multipart upload could not be parsed.');
    return;
  }

  if (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, 'body')) {
    logInputRejected(req, 'INVALID_JSON', 'json');
    sendInputError(res, 400, 'INVALID_JSON', 'The request body must contain valid JSON.');
    return;
  }

  console.error(redactDiagnostic(err && (err.stack || err.message || err)));
  sendInputError(res, 500, 'INTERNAL_ERROR', 'The request could not be processed.');
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, '0.0.0.0', () => {
  console.log(JSON.stringify({
    event: 'process.started',
    timestamp: new Date().toISOString(),
    port,
    commit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null,
    deployId: process.env.RENDER_DEPLOY_ID || null,
  }));
  // Start once. The controller catches failures and retries without restarting
  // the HTTP server or creating overlapping initialization attempts.
  x402Initializer.start();
});

function logProcessEvent(event, fields = {}) {
  console.error(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...fields,
  }));
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    logProcessEvent('process.signal_received', { signal });
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}
process.on('uncaughtExceptionMonitor', (error) => {
  logProcessEvent('process.uncaught_exception', {
    errorName: error?.name || 'Error',
    message: redactDiagnostic(error?.message || error),
  });
});
process.on('unhandledRejection', (reason) => {
  logProcessEvent('process.unhandled_rejection', {
    message: redactDiagnostic(reason?.message || reason),
  });
  setImmediate(() => {
    throw reason instanceof Error ? reason : new Error(String(reason));
  });
});

module.exports = app;
