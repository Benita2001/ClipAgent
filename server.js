require('dotenv').config();

const express = require('express');
const multer = require('multer');
const { paymentMiddlewareFromHTTPServer } = require('@okxweb3/x402-express');
const { ensureUploadDir } = require('./utils/tempDir');
const { ensureOutputDir } = require('./utils/outputDir');
const { UnsupportedFileTypeError } = require('./services/uploadService');
const { resourceServer, httpServer } = require('./services/x402Config');
const healthRouter = require('./routes/health');
const clipRouter = require('./routes/clip');
const jobRouter = require('./routes/job');

ensureUploadDir();
ensureOutputDir();

const app = express();

app.use(healthRouter);
app.use(paymentMiddlewareFromHTTPServer(httpServer));
app.use(clipRouter);
app.use(jobRouter);

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof UnsupportedFileTypeError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const maxMb = Number(process.env.MAX_UPLOAD_MB) || 500;
      res.status(400).json({ error: `File too large. Max upload size is ${maxMb}MB.` });
      return;
    }
    res.status(400).json({ error: `Upload error: ${err.message}` });
    return;
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, async () => {
  console.log(`video-clipping-backend listening on port ${port}`);
  // SELLER.md's own "Common Mistakes" table: forgetting this call is the
  // documented cause of "Facilitator does not support exact on eip155:196"
  // on every request. Runs after the server starts, matching their canonical
  // example exactly (app.listen(port, async () => { await ...initialize() }).
  await resourceServer.initialize();
});

module.exports = app;
