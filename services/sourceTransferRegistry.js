class SourceTransferRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.records = new Map();
    this.now = now;
  }

  register(record) {
    const stored = {
      ...record,
      createdAt: record.createdAt || new Date(this.now()).toISOString(),
      cleanupState: record.cleanupState || 'pending',
    };
    this.records.set(stored.transferId, stored);
    return { ...stored };
  }

  associate(transferId, { jobId, ownerAgentId }) {
    const record = this.records.get(transferId);
    if (!record) return null;
    Object.assign(record, { jobId, ownerAgentId });
    return { ...record };
  }

  get(transferId) {
    const record = this.records.get(transferId);
    return record ? { ...record } : null;
  }

  markCleanup(transferId, cleanupState) {
    const record = this.records.get(transferId);
    if (!record) return null;
    record.cleanupState = cleanupState;
    record.cleanedAt = cleanupState === 'deleted'
      ? new Date(this.now()).toISOString()
      : null;
    return { ...record };
  }

  expired(at = this.now()) {
    return [...this.records.values()]
      .filter((record) => Date.parse(record.expiresAt) <= at && record.cleanupState !== 'deleted')
      .map((record) => ({ ...record }));
  }
}

module.exports = { SourceTransferRegistry };
