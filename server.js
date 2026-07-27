require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { paymentMiddlewareFromHTTPServer } = require('@okxweb3/x402-express');
const { ensureUploadDir } = require('./utils/tempDir');
const { ensureOutputDir } = require('./utils/outputDir');
const { UnsupportedFileTypeError } = require('./services/uploadService');
const { resourceServer, httpServer } = require('./services/x402Config');
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
const jobRouter = require('./routes/job');

ensureUploadDir();
ensureOutputDir();

const app = express();

// Render terminates TLS at its edge and forwards over plain HTTP, setting
// X-Forwarded-Proto. Without trusting the proxy, req.protocol always reports
// 'http', which leaks into the x402 payment challenge's resource.url and
// fails OKX's x402 standard validation (resource scheme must match the
// actual HTTPS endpoint).
app.set('trust proxy', 1);

const x402Initializer = createX402Initializer({
  initialize: () => resourceServer.initialize(),
});
const tracedHttpServer = createTracedHttpServer(httpServer);

app.use(healthRouter);
app.use(createReadyRouter(x402Initializer.getState));
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
app.use(jobRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof UnsupportedFileTypeError) {
    logInputRejected(req, 'UNSUPPORTED_VIDEO_TYPE', 'multipart');
    sendInputError(res, err.statusCode, 'UNSUPPORTED_VIDEO_TYPE', 'The uploaded file type is not supported.');
    return;
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMb = Number(process.env.MAX_UPLOAD_MB) || 500;
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
