const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getA2aTransportConfig } = require('../config/a2aTransportConfig');
const { uploadDir, ensureUploadDir } = require('../utils/tempDir');
const { cleanupFiles } = require('../utils/fileCleanup');
const { checkDurationLimit } = require('./durationLimitService');
const { downloadRemoteVideo } = require('./remoteVideoService');
const { assertTemporaryDiskCapacity } = require('./diskCapacityService');
const { sanitizeFilename, VIDEO_MIME_TYPES } = require('./supabaseTemporarySourceStorage');
const { uploadFileWithTus } = require('./tusUploadService');

class A2aTransportError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'A2aTransportError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return `sha256:${hash.digest('hex')}`;
}

function validateNormalizedInput(input) {
  if (!input || !['okx_attachment', 'temporary_source'].includes(input.type)) {
    throw new A2aTransportError('INVALID_A2A_INPUT', 'Unsupported A2A video input type.');
  }
  if (input.type === 'okx_attachment' && !input.localPath) {
    throw new A2aTransportError(
      'OKX_ATTACHMENT_NOT_MATERIALIZED',
      'The official OKX attachment has not been materialized locally.'
    );
  }
  if (input.type === 'temporary_source' && (!input.downloadUrl || !input.transferId)) {
    throw new A2aTransportError(
      'TEMPORARY_SOURCE_REFERENCE_INVALID',
      'Temporary source input requires a signed URL and transferId.'
    );
  }
  if (input.mimeType && !VIDEO_MIME_TYPES.has(input.mimeType)) {
    throw new A2aTransportError(
      'UNSUPPORTED_VIDEO_TYPE',
      'A2A source metadata must declare a supported video MIME type.',
      415
    );
  }
  return input;
}

async function selectCustomerTransport(filePath, metadata, options = {}) {
  const config = options.config || getA2aTransportConfig();
  const stat = await (options.stat || fs.promises.stat)(filePath);
  if (!stat.isFile()) {
    throw new A2aTransportError('SOURCE_FILE_INVALID', 'The attached video is not a regular file.');
  }
  const filename = sanitizeFilename(metadata.filename || path.basename(filePath));
  const mimeType = metadata.mimeType;
  if (!VIDEO_MIME_TYPES.has(mimeType)) {
    throw new A2aTransportError('UNSUPPORTED_VIDEO_TYPE', 'The attached file must use a supported video MIME type.', 415);
  }

  if (stat.size <= config.okxAttachmentMaxBytes) {
    return {
      type: 'okx_attachment',
      localPath: filePath,
      expectedSizeBytes: stat.size,
      filename,
      mimeType,
    };
  }
  if (!config.largeVideoUploadsEnabled) {
    throw new A2aTransportError(
      'LARGE_VIDEO_UPLOADS_DISABLED',
      'Large-video transfer is disabled; regular OKX attachments remain available.',
      503
    );
  }
  if (!config.maxSourceBytes) {
    throw new A2aTransportError(
      'MAX_SOURCE_BYTES_NOT_CONFIGURED',
      'CLIPAGENT_MAX_SOURCE_BYTES is required before large-video transfer can be enabled.',
      503
    );
  }
  if (stat.size > config.maxSourceBytes) {
    throw new A2aTransportError(
      'SOURCE_TOO_LARGE',
      'The source exceeds the configured ClipAgent processing limit.',
      413
    );
  }
  if (!options.storage) {
    throw new A2aTransportError(
      'SOURCE_STORAGE_NOT_CONFIGURED',
      'Temporary source storage is required for large-video transfer.',
      503
    );
  }

  const transferId = (options.randomUUID || crypto.randomUUID)();
  const checksum = await (options.checksumFile || sha256File)(filePath);
  const uploadAuthorization = await options.storage.createUploadAuthorization({
    transferId,
    filename,
    mimeType,
    expectedSizeBytes: stat.size,
    checksum,
  });
  try {
    await (options.uploadFile || uploadFileWithTus)(
      filePath,
      uploadAuthorization,
      options.uploadOptions
    );
    const exists = await options.storage.verifySourceExists(
      uploadAuthorization.objectKey,
      { expectedSizeBytes: stat.size }
    );
    if (!exists) throw new Error('Uploaded source metadata did not match the local file.');
    const downloadUrl = await options.storage.createSignedDownloadUrl(
      uploadAuthorization.objectKey,
      config.signedUrlTtlSeconds
    );
    const expiresAt = new Date(
      Date.now() + config.sourceRetentionSeconds * 1000
    ).toISOString();
    options.registry?.register({
      transferId,
      objectKey: uploadAuthorization.objectKey,
      expectedSizeBytes: stat.size,
      filename,
      mimeType,
      checksum,
      expiresAt,
    });
    return {
      type: 'temporary_source',
      downloadUrl,
      expectedSizeBytes: stat.size,
      filename,
      mimeType,
      checksum,
      transferId,
    };
  } catch (error) {
    await options.storage.deleteSource(uploadAuthorization.objectKey).catch(() => {});
    throw error;
  }
}

async function materializeProviderInput(input, options = {}) {
  validateNormalizedInput(input);
  const config = options.config || getA2aTransportConfig();
  ensureUploadDir();
  const expectedSizeBytes = Number(input.expectedSizeBytes);
  if (!Number.isSafeInteger(expectedSizeBytes) || expectedSizeBytes <= 0) {
    throw new A2aTransportError('SOURCE_SIZE_REQUIRED', 'A verified expected source size is required.');
  }
  if (config.maxSourceBytes && expectedSizeBytes > config.maxSourceBytes) {
    throw new A2aTransportError('SOURCE_TOO_LARGE', 'The source exceeds the configured ClipAgent processing limit.', 413);
  }
  await (options.assertDiskCapacity || assertTemporaryDiskCapacity)({
    targetPath: uploadDir,
    expectedSourceBytes: expectedSizeBytes,
    multiplier: config.requiredFreeSpaceMultiplier,
  });

  let file;
  let ownsLocalFile = false;
  try {
    if (input.type === 'okx_attachment') {
      if (expectedSizeBytes > config.okxAttachmentMaxBytes) {
        throw new A2aTransportError(
          'OKX_ATTACHMENT_TOO_LARGE',
          'The official OKX attachment exceeds its transport limit.',
          413
        );
      }
      const stats = await (options.stat || fs.promises.stat)(input.localPath);
      if (!stats.isFile() || stats.size !== expectedSizeBytes) {
        throw new A2aTransportError(
          'OKX_ATTACHMENT_SIZE_MISMATCH',
          'Materialized OKX attachment size does not match its metadata.'
        );
      }
      file = {
        path: input.localPath,
        filename: path.basename(input.localPath),
        originalname: input.filename || path.basename(input.localPath),
        mimetype: input.mimeType,
        size: stats.size,
      };
    } else {
      if (!config.largeVideoUploadsEnabled) {
        throw new A2aTransportError(
          'LARGE_VIDEO_UPLOADS_DISABLED',
          'Large-video transfer is disabled.',
          503
        );
      }
      if (!config.maxSourceBytes) {
        throw new A2aTransportError(
          'MAX_SOURCE_BYTES_NOT_CONFIGURED',
          'CLIPAGENT_MAX_SOURCE_BYTES is required for temporary source transfer.',
          503
        );
      }
      file = await (options.downloadVideo || downloadRemoteVideo)(input.downloadUrl, {
        maxBytes: Math.min(config.maxSourceBytes, expectedSizeBytes),
      });
      ownsLocalFile = true;
      if (file.size !== expectedSizeBytes) {
        throw new A2aTransportError(
          'TEMPORARY_SOURCE_SIZE_MISMATCH',
          'Downloaded source size does not match task metadata.'
        );
      }
      if (file.mimetype && !VIDEO_MIME_TYPES.has(file.mimetype)) {
        throw new A2aTransportError(
          'UNSUPPORTED_VIDEO_TYPE',
          'Downloaded temporary source returned an unsupported MIME type.',
          415
        );
      }
    }

    if (input.checksum) {
      const actualChecksum = await (options.checksumFile || sha256File)(file.path);
      if (actualChecksum.toLowerCase() !== input.checksum.toLowerCase()) {
        throw new A2aTransportError(
          'SOURCE_CHECKSUM_MISMATCH',
          'Materialized source checksum does not match task metadata.'
        );
      }
    }
    const metadata = await (options.probeVideo || checkDurationLimit)(file.path);
    if (metadata.durationSeconds > config.maxDurationSeconds) {
      throw new A2aTransportError(
        'SOURCE_DURATION_EXCEEDED',
        'The source exceeds CLIPAGENT_MAX_DURATION_SECONDS.',
        413
      );
    }
    return { file, metadata, ownsLocalFile };
  } catch (error) {
    if (ownsLocalFile && file?.path) {
      await (options.cleanup || cleanupFiles)([file.path]);
    }
    throw error;
  }
}

module.exports = {
  A2aTransportError,
  selectCustomerTransport,
  materializeProviderInput,
  validateNormalizedInput,
  sha256File,
};
