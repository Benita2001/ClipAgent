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

app.use(healthRouter);
app.use(createReadyRouter(x402Initializer.getState));
// Parse and validate the business input before payment verification. The
// installed x402 middleware settles only after a successful (<400) handler
// response, so invalid requests stop here and cannot be charged.
app.use(createClipPrepaymentRouter());
app.use(paymentMiddlewareFromHTTPServer(httpServer));
app.use(clipRouter);
app.use(jobRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof UnsupportedFileTypeError) {
    sendInputError(res, err.statusCode, 'UNSUPPORTED_VIDEO_TYPE', 'The uploaded file type is not supported.');
    return;
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMb = Number(process.env.MAX_UPLOAD_MB) || 500;
      sendInputError(res, 413, 'VIDEO_TOO_LARGE', `The uploaded video exceeds the ${maxMb}MB limit.`);
      return;
    }
    sendInputError(res, 400, 'UPLOAD_INVALID', 'The multipart upload could not be parsed.');
    return;
  }

  if (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, 'body')) {
    sendInputError(res, 400, 'INVALID_JSON', 'The request body must contain valid JSON.');
    return;
  }

  console.error(redactDiagnostic(err && (err.stack || err.message || err)));
  sendInputError(res, 500, 'INTERNAL_ERROR', 'The request could not be processed.');
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`video-clipping-backend listening on port ${port}`);
  // Start once. The controller catches failures and retries without restarting
  // the HTTP server or creating overlapping initialization attempts.
  x402Initializer.start();
});

module.exports = app;
