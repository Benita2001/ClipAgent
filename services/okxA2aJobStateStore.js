const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveRuntimePaths } = require('../config/runtimePaths');

function defaultStateFilePath(env = process.env) {
  if (env.A2A_JOB_STATE_FILE || env.CLIPAGENT_DATA_ROOT || env.NODE_ENV === 'production') {
    return resolveRuntimePaths(env).stateFile;
  }
  return path.join(os.homedir(), '.okx-agent-task', 'clipagent-a2a-state.json');
}

const ACTIVE_PROCESSING_STATUSES = new Set([
  'attachment_downloading',
  'attachment_ready',
  'processing',
]);

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class OkxA2aJobStateStore {
  constructor({
    filePath = defaultStateFilePath(),
    fsImpl = fs,
    now = () => Date.now(),
    staleMs = positiveInteger(process.env.A2A_PROCESSING_STALE_MS, 30 * 60 * 1000),
    heartbeatIntervalMs = positiveInteger(process.env.A2A_HEARTBEAT_INTERVAL_MS, 30_000),
    lockTimeoutMs = positiveInteger(process.env.A2A_STATE_LOCK_TIMEOUT_MS, 10_000),
    lockRetryMs = 25,
  } = {}) {
    this.filePath = filePath;
    this.fs = fsImpl;
    this.now = now;
    this.staleMs = staleMs;
    this.heartbeatIntervalMs = Math.min(heartbeatIntervalMs, Math.max(1_000, Math.floor(staleMs / 3)));
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockRetryMs = lockRetryMs;
    this.lockPath = `${filePath}.lock`;
    this._queue = Promise.resolve();
  }

  async readState() {
    try {
      const raw = await this.fs.promises.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.jobs !== 'object') {
        return { schemaVersion: 1, jobs: {} };
      }
      return {
        schemaVersion: parsed.schemaVersion || 1,
        jobs: parsed.jobs || {},
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { schemaVersion: 1, jobs: {} };
      }
      throw error;
    }
  }

  async writeState(state) {
    await this.fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await this.fs.promises.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await this.fs.promises.rename(tmpPath, this.filePath);
  }

  async acquireFileLock() {
    await this.fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    const startedAt = this.now();
    for (;;) {
      try {
        const handle = await this.fs.promises.open(this.lockPath, 'wx', 0o600);
        await handle.writeFile(`${process.pid}\n`);
        return async () => {
          await handle.close().catch(() => {});
          await this.fs.promises.unlink(this.lockPath).catch(() => {});
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const lockStat = await this.fs.promises.stat(this.lockPath).catch(() => null);
        if (lockStat && this.now() - lockStat.mtimeMs > this.lockTimeoutMs) {
          await this.fs.promises.unlink(this.lockPath).catch(() => {});
          continue;
        }
        if (this.now() - startedAt >= this.lockTimeoutMs) {
          const timeout = new Error('Timed out waiting for the A2A job-state lock.');
          timeout.code = 'A2A_STATE_LOCK_TIMEOUT';
          throw timeout;
        }
        await new Promise((resolve) => setTimeout(resolve, this.lockRetryMs));
      }
    }
  }

  withLock(operation) {
    const guarded = async () => {
      const release = await this.acquireFileLock();
      try {
        return await operation();
      } finally {
        await release();
      }
    };
    const next = this._queue.then(guarded, guarded);
    this._queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async get(jobId) {
    return this.withLock(async () => {
      const state = await this.readState();
      return state.jobs[jobId] ? { ...state.jobs[jobId] } : null;
    });
  }

  async upsert(jobId, patch = {}) {
    return this.withLock(async () => {
      const state = await this.readState();
      const existing = state.jobs[jobId] || { jobId };
      const next = {
        ...existing,
        ...patch,
        jobId,
        updatedAt: new Date(this.now()).toISOString(),
      };
      state.jobs[jobId] = next;
      await this.writeState(state);
      return { ...next };
    });
  }

  async heartbeat(jobId, processingOwner, patch = {}) {
    return this.withLock(async () => {
      const state = await this.readState();
      const existing = state.jobs[jobId];
      if (!existing || existing.processingOwner !== processingOwner) {
        const error = new Error('The active job lease is owned by another worker.');
        error.code = 'A2A_JOB_LEASE_LOST';
        throw error;
      }
      const nowIso = new Date(this.now()).toISOString();
      const next = {
        ...existing,
        ...patch,
        jobId,
        heartbeatAt: nowIso,
        updatedAt: nowIso,
      };
      state.jobs[jobId] = next;
      await this.writeState(state);
      return { ...next };
    });
  }

  async claim(jobId, patch = {}) {
    return this.withLock(async () => {
      const state = await this.readState();
      const existing = state.jobs[jobId] || null;
      if (existing && ['delivered', 'completed'].includes(existing.status)) {
        return { claimed: false, job: { ...existing }, reason: 'already_completed' };
      }
      const contractChanged = Boolean(
        existing &&
        patch.contractVersion &&
        existing.contractVersion !== patch.contractVersion
      );
      const active = existing && ACTIVE_PROCESSING_STATUSES.has(existing.status);
      const heartbeatAtMs = Date.parse(
        existing?.heartbeatAt || existing?.updatedAt || ''
      );
      const stale = active && Number.isFinite(heartbeatAtMs) &&
        this.now() - heartbeatAtMs >= this.staleMs;
      if (active && !stale && !contractChanged) {
        return { claimed: false, job: { ...existing }, reason: 'already_processing' };
      }
      const recoveryAttempt = stale || contractChanged
        ? Number(existing?.recoveryAttempt || 0) + 1
        : Number(existing?.recoveryAttempt || 0);
      const hasDurableResult = Boolean(existing?.result && existing?.deliveryPayload);
      const deliveryResume = Boolean(
        existing &&
        ['ready_for_delivery', 'delivery_failed'].includes(existing.status) &&
        existing.result &&
        !contractChanged
      );
      const recovery = stale || contractChanged
        ? {
            recoveryReason: contractChanged
              ? `contract_changed_${existing.contractVersion || 'unversioned'}_to_${patch.contractVersion}`
              : `stale_${existing.status}_${existing.stage || 'unknown'}`,
            recoveryAttempt,
            recoveredAt: new Date(this.now()).toISOString(),
          }
        : {};
      const resumeDurableResult = stale && hasDurableResult && !contractChanged;
      const nowIso = new Date(this.now()).toISOString();
      const next = {
        ...(existing || {}),
        ...patch,
        ...(contractChanged
          ? {
              result: null,
              deliveryPayload: null,
              deliveryResult: null,
              deliveryError: null,
            }
          : {}),
        ...recovery,
        jobId,
        status: resumeDurableResult || deliveryResume
          ? 'ready_for_delivery'
          : 'processing',
        stage: resumeDurableResult || deliveryResume
          ? 'ready_for_delivery'
          : stale || contractChanged ? 'restarting' : 'claimed',
        processingOwner: patch.processingOwner || `${process.pid}`,
        heartbeatAt: nowIso,
        updatedAt: nowIso,
      };
      state.jobs[jobId] = next;
      await this.writeState(state);
      return {
        claimed: true,
        job: { ...next },
        recovered: stale || contractChanged,
        resumeDeliveryOnly: resumeDurableResult || deliveryResume,
      };
    });
  }
}

module.exports = {
  OkxA2aJobStateStore,
  defaultStateFilePath,
  ACTIVE_PROCESSING_STATUSES,
};
