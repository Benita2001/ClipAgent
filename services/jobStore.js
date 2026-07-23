/**
 * In-memory job tracker. No Redis, no queue — a plain Map, per Phase 5 scope.
 * Lost on process restart; that's an accepted limitation of this phase, not
 * hidden: nothing here persists beyond the running Node process.
 */
const jobs = new Map();

function createJob(jobId, initial = {}) {
  jobs.set(jobId, { jobId, status: 'processing', createdAt: new Date().toISOString(), ...initial });
}

function markDone(jobId, result) {
  const job = jobs.get(jobId);
  if (!job || job.status === 'done' || job.status === 'failed' || job.status !== 'processing') return false;
  job.status = 'done';
  job.result = result;
  job.finishedAt = new Date().toISOString();
  return true;
}

function markFailed(jobId, failure) {
  const job = jobs.get(jobId);
  if (!job || job.status === 'done' || job.status === 'failed' || job.status !== 'processing') return false;
  job.status = 'failed';
  job.stage = failure.stage;
  job.internalError = failure.internalError;
  job.publicError = failure.publicError;
  job.finishedAt = new Date().toISOString();
  return true;
}

function getJob(jobId) {
  return jobs.get(jobId);
}

module.exports = { createJob, markDone, markFailed, getJob };
