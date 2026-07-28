class TemporarySourceStorage {
  async createUploadAuthorization() {
    throw new Error('createUploadAuthorization() is not implemented.');
  }

  async createSignedDownloadUrl() {
    throw new Error('createSignedDownloadUrl() is not implemented.');
  }

  async deleteSource() {
    throw new Error('deleteSource() is not implemented.');
  }

  async getSourceMetadata() {
    throw new Error('getSourceMetadata() is not implemented.');
  }

  async verifySourceExists() {
    throw new Error('verifySourceExists() is not implemented.');
  }
}

module.exports = { TemporarySourceStorage };
