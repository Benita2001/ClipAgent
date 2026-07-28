const crypto = require('crypto');
const { processClip } = require('./pipelineService');
const { materializeProviderInput } = require('./a2aInputTransportService');

async function processA2aClipTask(task, options = {}) {
  if (!task || task.status !== 'accepted') {
    const error = new Error('A2A work may begin only after job_accepted.');
    error.code = 'A2A_JOB_NOT_ACCEPTED';
    error.statusCode = 409;
    throw error;
  }
  const materialize = options.materializeProviderInput || materializeProviderInput;
  const runPipeline = options.processClip || processClip;
  let materialized;
  let processingSucceeded = false;
  try {
    materialized = await materialize(task.input, options.materializeOptions);
    const pipelineOverrides = options.rankMoments
      ? { rankMoments: options.rankMoments }
      : {};
    const result = await runPipeline(
      task.jobId || crypto.randomUUID(),
      materialized.file,
      pipelineOverrides
    );
    processingSucceeded = true;
    return {
      jobId: task.jobId,
      transferId: task.input.transferId || null,
      clips: result.clips.map((clip) => ({
        filename: clip.filename || `clip-${clip.index + 1}.mp4`,
        url: clip.supabase.publicUrl,
        startSeconds: clip.requestedStartSeconds,
        endSeconds: clip.requestedEndSeconds,
        durationSeconds: clip.actualDurationSeconds,
        reason: clip.reason,
      })),
    };
  } finally {
    if (task.input.type === 'temporary_source' && options.sourceStorage && options.objectKey) {
      await options.sourceStorage.deleteSource(options.objectKey);
      options.registry?.markCleanup(task.input.transferId, 'deleted');
    }
    if (!processingSucceeded) {
      options.registry?.markCleanup(task.input.transferId, 'deleted');
    }
  }
}

async function cleanupExpiredTransfers({ registry, sourceStorage }) {
  const results = [];
  for (const record of registry.expired()) {
    try {
      await sourceStorage.deleteSource(record.objectKey);
      registry.markCleanup(record.transferId, 'deleted');
      results.push({ transferId: record.transferId, deleted: true });
    } catch (error) {
      registry.markCleanup(record.transferId, 'delete_failed');
      results.push({ transferId: record.transferId, deleted: false, error });
    }
  }
  return results;
}

async function cleanupTaskTransfer({
  transferId,
  taskStatus,
  registry,
  sourceStorage,
  disputedCleanupAllowed = false,
}) {
  const cleanupStatuses = new Set(['complete', 'rejected', 'failed', 'expired', 'closed']);
  if (taskStatus === 'disputed' && disputedCleanupAllowed) cleanupStatuses.add('disputed');
  if (!cleanupStatuses.has(taskStatus)) return { deleted: false, reason: 'status_retained' };
  const record = registry.get(transferId);
  if (!record || record.cleanupState === 'deleted') {
    return { deleted: false, reason: 'already_absent' };
  }
  try {
    await sourceStorage.deleteSource(record.objectKey);
    registry.markCleanup(transferId, 'deleted');
    return { deleted: true };
  } catch (error) {
    registry.markCleanup(transferId, 'delete_failed');
    throw error;
  }
}

module.exports = {
  processA2aClipTask,
  cleanupExpiredTransfers,
  cleanupTaskTransfer,
};
