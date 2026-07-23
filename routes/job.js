const express = require('express');
const { getJob } = require('../services/jobStore');

const router = express.Router();

function toPublicClip(clip) {
  const { localPath, path, ...publicClip } = clip;
  return publicClip;
}

router.get('/job/:id', (req, res) => {
  const job = getJob(req.params.id);

  if (!job) {
    res.status(404).json({ error: `No job found with id "${req.params.id}".` });
    return;
  }

  if (job.status === 'processing') {
    res.status(200).json({ jobId: job.jobId, status: 'processing' });
    return;
  }

  if (job.status === 'failed') {
    res.status(200).json({ jobId: job.jobId, status: 'failed', error: job.error });
    return;
  }

  // done
  res.status(200).json({
    jobId: job.jobId,
    status: 'done',
    rankingModel: job.result.rankingModel,
    audioFileSizeBytes: job.result.audioFileSizeBytes,
    transcriptDurationSeconds: job.result.transcriptDurationSeconds,
    clips: job.result.clips.map(toPublicClip),
  });
});

module.exports = router;
