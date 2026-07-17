const express = require('express');
const crypto = require('crypto');
const { upload } = require('../services/uploadService');
const { createJob } = require('../services/jobStore');
const { runPipeline } = require('../services/pipelineService');
const { checkDurationLimit } = require('../services/durationLimitService');

const router = express.Router();

// Payment is gated upstream by the x402 SDK middleware (server.js) — by the
// time a request reaches here, it has already paid. GET only exists so the
// x402 middleware has a real route to protect (OKX's endpoint validator
// probes GET); there's no video to process without a POST body.
router.get('/clip', (req, res) => {
  res.status(200).json({
    service: 'ClipAgent',
    description: 'POST a video (multipart field "video") plus callerId to extract and cut its most valuable moments.',
  });
});

router.post('/clip', upload.single('video'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'A video file is required (multipart field name: "video").' });
    return;
  }

  const { callerId } = req.body;
  if (!callerId || !String(callerId).trim()) {
    res.status(400).json({ error: 'callerId is required.' });
    return;
  }

  // Fast pre-flight (ffprobe only, no transcoding) — reject before any
  // extraction, transcription, ranking, cutting, or Supabase upload.
  try {
    await checkDurationLimit(req.file.path);
  } catch (err) {
    const statusCode = err.statusCode || 400;
    res.status(statusCode).json({ error: err.message });
    return;
  }

  const jobId = crypto.randomUUID();

  createJob(jobId, {
    callerId,
    file: {
      originalName: req.file.originalname,
      storedName: req.file.filename,
      path: req.file.path,
      size: req.file.size,
      mimetype: req.file.mimetype,
    },
  });

  res.status(202).json({ jobId, status: 'processing' });

  // Fire-and-forget: runs transcribe -> rank -> cut -> upload in the
  // background. runPipeline catches its own errors and writes them to the
  // job store — this catch is only a last-resort safety net against a bug
  // in that error handling itself, so it never becomes an unhandled rejection.
  runPipeline(jobId, req.file).catch((err) => {
    console.error(`Unexpected uncaught error in pipeline for job ${jobId}:`, err);
  });
});

module.exports = router;
