const fs = require('fs');

class InsufficientTemporaryDiskError extends Error {
  constructor(requiredBytes, availableBytes) {
    super('Insufficient temporary disk space for safe video processing.');
    this.name = 'InsufficientTemporaryDiskError';
    this.code = 'INSUFFICIENT_TEMP_DISK';
    this.statusCode = 507;
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

async function getFreeDiskBytes(targetPath, overrides = {}) {
  const statfs = overrides.statfs || fs.promises.statfs;
  const stats = await statfs(targetPath);
  return Number(stats.bavail) * Number(stats.bsize);
}

async function assertTemporaryDiskCapacity({
  targetPath,
  expectedSourceBytes,
  multiplier,
  getFreeBytes = getFreeDiskBytes,
}) {
  if (!Number.isSafeInteger(expectedSourceBytes) || expectedSourceBytes <= 0) {
    const error = new Error('Expected source size is required for disk capacity validation.');
    error.code = 'SOURCE_SIZE_REQUIRED';
    error.statusCode = 400;
    throw error;
  }
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    const error = new Error('A positive temporary disk multiplier is required.');
    error.code = 'INVALID_DISK_MULTIPLIER';
    error.statusCode = 500;
    throw error;
  }

  const requiredBytes = Math.ceil(expectedSourceBytes * multiplier);
  const availableBytes = await getFreeBytes(targetPath);
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new InsufficientTemporaryDiskError(requiredBytes, availableBytes);
  }
  return { requiredBytes, availableBytes };
}

module.exports = {
  getFreeDiskBytes,
  assertTemporaryDiskCapacity,
  InsufficientTemporaryDiskError,
};
