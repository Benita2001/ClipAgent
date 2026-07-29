const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveRuntimePaths } = require('../config/runtimePaths');

const STAGE_CHECKPOINT_SCHEMA_VERSION = 'clipagent-stage-v1';

function safe(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_');
}

async function sha256File(filePath, fsImpl = fs) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fsImpl.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return `sha256:${hash.digest('hex')}`;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

class A2aStageCheckpointStore {
  constructor({ rootDir, artifactRoot, env = process.env, fsImpl = fs } = {}) {
    const paths = resolveRuntimePaths(env);
    this.rootDir = rootDir || paths.stageCheckpointDir;
    this.artifactRoot = artifactRoot || paths.stageArtifactDir;
    this.fs = fsImpl;
  }

  jobDir(jobId) {
    return path.join(this.rootDir, safe(jobId));
  }

  checkpointPath(jobId, stage) {
    return path.join(this.jobDir(jobId), `${safe(stage)}.json`);
  }

  artifactPath(jobId, filename) {
    return path.join(this.artifactRoot, safe(jobId), safe(filename));
  }

  async atomicWrite(filePath, value) {
    await this.fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await this.fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await this.fs.promises.rename(temporary, filePath);
  }

  async read(jobId, stage) {
    try {
      const parsed = JSON.parse(
        await this.fs.promises.readFile(this.checkpointPath(jobId, stage), 'utf8')
      );
      return parsed?.schemaVersion === STAGE_CHECKPOINT_SCHEMA_VERSION
        ? parsed
        : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      await this.invalidate(jobId, stage);
      return null;
    }
  }

  async write(jobId, stage, identity, data) {
    const checkpoint = {
      schemaVersion: STAGE_CHECKPOINT_SCHEMA_VERSION,
      stage,
      identity,
      identityFingerprint: fingerprint(identity),
      data,
      completedAt: new Date().toISOString(),
    };
    await this.atomicWrite(this.checkpointPath(jobId, stage), checkpoint);
    return checkpoint;
  }

  async valid(jobId, stage, identity, validator = null) {
    const checkpoint = await this.read(jobId, stage);
    if (!checkpoint || checkpoint.identityFingerprint !== fingerprint(identity)) {
      if (checkpoint) await this.invalidate(jobId, stage);
      return null;
    }
    try {
      if (validator && !(await validator(checkpoint.data))) {
        await this.invalidate(jobId, stage);
        return null;
      }
      return checkpoint.data;
    } catch {
      await this.invalidate(jobId, stage);
      return null;
    }
  }

  async verifyArtifact(artifact) {
    if (!artifact?.path || !artifact?.checksum || !Number.isSafeInteger(artifact?.sizeBytes)) {
      return false;
    }
    const stats = await this.fs.promises.stat(artifact.path).catch(() => null);
    if (!stats?.isFile() || stats.size !== artifact.sizeBytes || stats.size <= 0) return false;
    return (await sha256File(artifact.path, this.fs)) === artifact.checksum;
  }

  async persistArtifact(jobId, sourcePath, filename) {
    const destination = this.artifactPath(jobId, filename);
    await this.fs.promises.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${process.pid}.tmp`;
    await this.fs.promises.copyFile(sourcePath, temporary);
    await this.fs.promises.rename(temporary, destination);
    const stats = await this.fs.promises.stat(destination);
    return {
      path: destination,
      sizeBytes: stats.size,
      checksum: await sha256File(destination, this.fs),
    };
  }

  async invalidate(jobId, stage) {
    await this.fs.promises.unlink(this.checkpointPath(jobId, stage)).catch(() => {});
  }
}

module.exports = {
  A2aStageCheckpointStore,
  STAGE_CHECKPOINT_SCHEMA_VERSION,
  sha256File,
  fingerprint,
};
