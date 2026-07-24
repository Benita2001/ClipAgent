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
    res.status(200).json({ success: true, jobId: job.jobId, status: 'processing' });
    return;
  }

  if (job.status === 'failed') {
    res.status(200).json({
      success: false,
      jobId: job.jobId,
      status: 'failed',
      stage: job.stage,
      error: job.publicError,
    });
    return;
  }

  // done
  res.status(200).json({
    success: true,
    jobId: job.jobId,
    status: 'completed',
    rankingModel: job.result.rankingModel,
    audioFileSizeBytes: job.result.audioFileSizeBytes,
    transcriptDurationSeconds: job.result.transcriptDurationSeconds,
    clips: job.result.clips.map((clip) => {
      const publicClip = toPublicClip(clip);
      return {
        index: publicClip.index,
        url: publicClip.supabase.publicUrl,
        reason: publicClip.reason,
        startSeconds: publicClip.requestedStartSeconds,
        endSeconds: publicClip.requestedEndSeconds,
        requestedDurationSeconds: publicClip.requestedDurationSeconds,
        actualDurationSeconds: publicClip.actualDurationSeconds,
      };
    }),
  });
});

module.exports = router;
