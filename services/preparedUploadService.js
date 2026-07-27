const crypto = require('crypto');
const { cleanupFiles } = require('../utils/fileCleanup');

const DEFAULT_UPLOAD_TTL_MS = 15 * 60 * 1000;
const uploads = new Map();
const expiryTimers = new Map();

function readUploadTtlMs(value = process.env.PREPARED_UPLOAD_TTL_MS) {
  if (value === undefined || value === '') return DEFAULT_UPLOAD_TTL_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('PREPARED_UPLOAD_TTL_MS must be a positive integer.');
  }
  return parsed;
}

const UPLOAD_TTL_MS = readUploadTtlMs();

function clearExpiryTimer(uploadId) {
  const timer = expiryTimers.get(uploadId);
  if (timer) clearTimeout(timer);
  expiryTimers.delete(uploadId);
}

function scheduleExpiry(record, cleanup) {
  const delayMs = Math.max(0, record.expiresAtMs - Date.now());
  const timer = setTimeout(() => {
    if (uploads.get(record.uploadId) !== record) return;
    uploads.delete(record.uploadId);
    expiryTimers.delete(record.uploadId);
    cleanup([record.file.path]).catch((error) => {
      console.error(`Failed to clean expired upload ${record.uploadId}: ${error.message}`);
    });
  }, delayMs);
  timer.unref?.();
  expiryTimers.set(record.uploadId, timer);
}

function createPreparedUpload(file, media, options = {}) {
  const now = options.now ?? Date.now();
  const cleanup = options.cleanup ?? cleanupFiles;
  const uploadId = crypto.randomUUID();
  const record = Object.freeze({
    uploadId,
    file: Object.freeze({ ...file }),
    durationSeconds: media.durationSeconds,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + UPLOAD_TTL_MS).toISOString(),
    expiresAtMs: now + UPLOAD_TTL_MS,
  });
  uploads.set(uploadId, record);
  scheduleExpiry(record, cleanup);
  return record;
}

async function removeExpiredUpload(record, cleanup = cleanupFiles) {
  if (!record || record.expiresAtMs > Date.now()) return false;
  uploads.delete(record.uploadId);
  clearExpiryTimer(record.uploadId);
  await cleanup([record.file.path]);
  return true;
}

async function getPreparedUpload(uploadId, { cleanup = cleanupFiles } = {}) {
  const record = uploads.get(uploadId);
  if (!record) return null;
  if (await removeExpiredUpload(record, cleanup)) return null;
  return record;
}

async function takePreparedUpload(uploadId, options = {}) {
  const record = uploads.get(uploadId);
  if (!record) return null;
  uploads.delete(uploadId);
  clearExpiryTimer(uploadId);
  if (record.expiresAtMs <= Date.now()) {
    await (options.cleanup ?? cleanupFiles)([record.file.path]);
    return null;
  }
  return record;
}

async function deletePreparedUpload(uploadId, cleanup = cleanupFiles) {
  const record = uploads.get(uploadId);
  if (!record) return false;
  uploads.delete(uploadId);
  clearExpiryTimer(uploadId);
  await cleanup([record.file.path]);
  return true;
}

function clearPreparedUploadsForTests() {
  for (const timer of expiryTimers.values()) clearTimeout(timer);
  expiryTimers.clear();
  uploads.clear();
}

module.exports = {
  createPreparedUpload,
  getPreparedUpload,
  takePreparedUpload,
  deletePreparedUpload,
  clearPreparedUploadsForTests,
  readUploadTtlMs,
  UPLOAD_TTL_MS,
  DEFAULT_UPLOAD_TTL_MS,
};
