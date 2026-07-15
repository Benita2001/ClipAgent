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
  if (!job) return;
  job.status = 'done';
  job.result = result;
  job.finishedAt = new Date().toISOString();
}

function markFailed(jobId, errorMessage) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'failed';
  job.error = errorMessage;
  job.finishedAt = new Date().toISOString();
}

function getJob(jobId) {
  return jobs.get(jobId);
}

module.exports = { createJob, markDone, markFailed, getJob };
