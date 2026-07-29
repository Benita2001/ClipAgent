const fs = require('fs');
const path = require('path');

class TranscriptCheckpointStore {
  constructor({ rootDir, fsImpl = fs } = {}) {
    this.rootDir = rootDir;
    this.fs = fsImpl;
  }

  jobDir(jobId) {
    const safeJobId = String(jobId).replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(this.rootDir, safeJobId);
  }

  manifestPath(jobId) {
    return path.join(this.jobDir(jobId), 'manifest.json');
  }

  chunkPath(jobId, chunkIndex) {
    return path.join(
      this.jobDir(jobId),
      'chunks',
      `${String(chunkIndex).padStart(3, '0')}.json`
    );
  }

  async atomicWrite(filePath, value) {
    await this.fs.promises.mkdir(path.dirname(filePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await this.fs.promises.writeFile(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    await this.fs.promises.rename(temporaryPath, filePath);
  }

  async readJson(filePath) {
    try {
      return JSON.parse(await this.fs.promises.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async initialize(jobId, manifest) {
    const existing = await this.readJson(this.manifestPath(jobId));
    if (existing?.fingerprint === manifest.fingerprint) return existing;
    await this.fs.promises.rm(this.jobDir(jobId), {
      recursive: true,
      force: true,
    });
    await this.atomicWrite(this.manifestPath(jobId), manifest);
    return manifest;
  }

  readChunk(jobId, chunkIndex) {
    return this.readJson(this.chunkPath(jobId, chunkIndex));
  }

  writeChunk(jobId, chunkIndex, transcript) {
    return this.atomicWrite(this.chunkPath(jobId, chunkIndex), transcript);
  }

  writeMerged(jobId, transcript) {
    return this.atomicWrite(
      path.join(this.jobDir(jobId), 'merged.json'),
      transcript
    );
  }
}

module.exports = { TranscriptCheckpointStore };
