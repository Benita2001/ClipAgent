const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { TemporarySourceStorage } = require('./temporarySourceStorage');
const { getA2aTransportConfig } = require('../config/a2aTransportConfig');
const { createProviderFetch, readTimeoutMs } = require('../utils/providerTimeout');

const VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
  'video/mpeg',
  'video/ogg',
  'video/3gpp',
  'video/x-flv',
]);

class SourceStorageConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SourceStorageConfigurationError';
    this.code = code;
    this.statusCode = 503;
  }
}

function sanitizeFilename(filename) {
  const base = path.basename(String(filename || 'video'));
  const sanitized = base
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_.',!&$@=;:+?() -]/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 180);
  return sanitized || 'video';
}

function validateTransferId(transferId) {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(transferId || ''))) {
    const error = new Error('A valid transferId is required.');
    error.code = 'INVALID_TRANSFER_ID';
    error.statusCode = 400;
    throw error;
  }
  return transferId;
}

class SupabaseTemporarySourceStorage extends TemporarySourceStorage {
  constructor(options = {}) {
    super();
    const config = options.config || getA2aTransportConfig();
    this.bucket = options.bucket || config.sourceBucket;
    this.maxSourceBytes = options.maxSourceBytes ?? config.maxSourceBytes;
    this.supabaseUrl = options.supabaseUrl || process.env.SUPABASE_URL;
    this.serviceKey = options.serviceKey || process.env.SUPABASE_SERVICE_KEY;
    this.client = options.client || null;
    this.fetchImpl = options.fetchImpl || createProviderFetch(
      'Supabase source storage',
      readTimeoutMs(process.env.SUPABASE_TIMEOUT_MS, 90_000)
    );
  }

  getClient() {
    if (this.client) return this.client;
    if (!this.supabaseUrl || !this.serviceKey) {
      throw new SourceStorageConfigurationError(
        'SOURCE_STORAGE_CREDENTIALS_MISSING',
        'SUPABASE_URL and SUPABASE_SERVICE_KEY are required for temporary source storage.'
      );
    }
    this.client = createClient(this.supabaseUrl, this.serviceKey, {
      global: { fetch: this.fetchImpl },
      auth: { persistSession: false },
    });
    return this.client;
  }

  async assertPrivateBucket(expectedSizeBytes) {
    const { data, error } = await this.getClient().storage.getBucket(this.bucket);
    if (error || !data) {
      throw new SourceStorageConfigurationError(
        'SOURCE_BUCKET_NOT_FOUND',
        `Configured temporary source bucket "${this.bucket}" does not exist.`
      );
    }
    if (data.public) {
      throw new SourceStorageConfigurationError(
        'SOURCE_BUCKET_PUBLIC',
        `Configured temporary source bucket "${this.bucket}" must be private.`
      );
    }
    const bucketLimit = Number(data.file_size_limit);
    if (
      Number.isFinite(bucketLimit) &&
      bucketLimit > 0 &&
      Number.isFinite(expectedSizeBytes) &&
      expectedSizeBytes > bucketLimit
    ) {
      throw new SourceStorageConfigurationError(
        'SOURCE_BUCKET_SIZE_LIMIT',
        'The temporary source exceeds the configured bucket size limit.'
      );
    }
    if (
      Number.isFinite(expectedSizeBytes) &&
      Number.isFinite(this.maxSourceBytes) &&
      expectedSizeBytes > this.maxSourceBytes
    ) {
      throw new SourceStorageConfigurationError(
        'SOURCE_TOO_LARGE',
        'The temporary source exceeds CLIPAGENT_MAX_SOURCE_BYTES.'
      );
    }
    return data;
  }

  objectKeyFor({ transferId, filename }) {
    validateTransferId(transferId);
    return `pending/${transferId}/${sanitizeFilename(filename)}`;
  }

  async createUploadAuthorization(metadata) {
    await this.assertPrivateBucket(metadata.expectedSizeBytes);
    if (!VIDEO_MIME_TYPES.has(metadata.mimeType)) {
      const error = new Error('Temporary source must use a supported video MIME type.');
      error.code = 'UNSUPPORTED_VIDEO_TYPE';
      error.statusCode = 415;
      throw error;
    }
    const objectKey = this.objectKeyFor(metadata);
    const { data, error } = await this.getClient()
      .storage
      .from(this.bucket)
      .createSignedUploadUrl(objectKey, { upsert: false });
    if (error || !data?.token) {
      throw new SourceStorageConfigurationError(
        'SIGNED_UPLOAD_UNAVAILABLE',
        `Temporary source bucket could not issue a signed upload authorization: ${error?.message || 'missing token'}.`
      );
    }

    const projectRef = new URL(this.supabaseUrl).hostname.split('.')[0];
    return {
      protocol: 'tus',
      objectKey,
      token: data.token,
      uploadEndpoint: `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`,
      bucket: this.bucket,
      metadata: {
        bucketName: this.bucket,
        objectName: objectKey,
        contentType: metadata.mimeType,
        cacheControl: '0',
      },
    };
  }

  async createSignedDownloadUrl(objectKey, expiresInSeconds) {
    await this.assertPrivateBucket();
    const { data, error } = await this.getClient()
      .storage
      .from(this.bucket)
      .createSignedUrl(objectKey, expiresInSeconds, { download: true });
    if (error || !data?.signedUrl) {
      throw new SourceStorageConfigurationError(
        'SIGNED_DOWNLOAD_UNAVAILABLE',
        `Temporary source bucket could not issue a signed download URL: ${error?.message || 'missing URL'}.`
      );
    }
    let parsed;
    try {
      parsed = new URL(data.signedUrl);
    } catch {
      throw new SourceStorageConfigurationError(
        'SIGNED_DOWNLOAD_INVALID',
        'Temporary source storage returned an invalid signed download URL.'
      );
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new SourceStorageConfigurationError(
        'SIGNED_DOWNLOAD_INVALID',
        'Temporary source storage returned an unsafe signed download URL.'
      );
    }
    return parsed.toString();
  }

  async getSourceMetadata(objectKey) {
    await this.assertPrivateBucket();
    const directory = path.posix.dirname(objectKey);
    const filename = path.posix.basename(objectKey);
    const { data, error } = await this.getClient()
      .storage
      .from(this.bucket)
      .list(directory, { search: filename, limit: 2 });
    if (error) throw error;
    const object = data?.find((entry) => entry.name === filename);
    if (!object) return null;
    return {
      objectKey,
      sizeBytes: Number(object.metadata?.size) || null,
      mimeType: object.metadata?.mimetype || object.metadata?.contentType || null,
      updatedAt: object.updated_at || null,
    };
  }

  async verifySourceExists(objectKey, expected = {}) {
    const metadata = await this.getSourceMetadata(objectKey);
    if (!metadata) return false;
    if (
      Number.isSafeInteger(expected.expectedSizeBytes) &&
      metadata.sizeBytes !== expected.expectedSizeBytes
    ) {
      return false;
    }
    return true;
  }

  async deleteSource(objectKey) {
    await this.assertPrivateBucket();
    const { error } = await this.getClient().storage.from(this.bucket).remove([objectKey]);
    if (error && !/not found/i.test(error.message || '')) throw error;
  }
}

module.exports = {
  SupabaseTemporarySourceStorage,
  SourceStorageConfigurationError,
  sanitizeFilename,
  VIDEO_MIME_TYPES,
};
