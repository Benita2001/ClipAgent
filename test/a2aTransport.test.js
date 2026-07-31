const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  A2aTransportError,
  selectCustomerTransport,
  materializeProviderInput,
} = require('../services/a2aInputTransportService');
const {
  SupabaseTemporarySourceStorage,
  SourceStorageConfigurationError,
} = require('../services/supabaseTemporarySourceStorage');
const {
  assertTemporaryDiskCapacity,
  InsufficientTemporaryDiskError,
} = require('../services/diskCapacityService');
const {
  processA2aClipTask,
  cleanupExpiredTransfers,
  cleanupTaskTransfer,
} = require('../services/a2aClipOrchestrationService');
const { SourceTransferRegistry } = require('../services/sourceTransferRegistry');
const { uploadFileWithTus } = require('../services/tusUploadService');
const { getA2aTransportConfig } = require('../config/a2aTransportConfig');

const attachmentLimit = 104_857_600;

function config(overrides = {}) {
  return {
    okxAttachmentMaxBytes: attachmentLimit,
    maxSourceBytes: null,
    maxDurationSeconds: 3_600,
    signedUrlTtlSeconds: 3_600,
    sourceRetentionSeconds: 86_400,
    requiredFreeSpaceMultiplier: 3,
    largeVideoUploadsEnabled: false,
    sourceBucket: 'clipagent-sources',
    ...overrides,
  };
}

function statWithSize(size) {
  return async () => ({ isFile: () => true, size });
}

test('worker attachment capacity follows the OKX client setting', () => {
  const transport = getA2aTransportConfig({
    OKX_A2A_MAX_FILE_SIZE_BYTES: '209715200',
    OKX_ATTACHMENT_MAX_BYTES: '104857600',
  });
  assert.equal(transport.okxAttachmentMaxBytes, 209_715_200);
});

test('deprecated worker attachment setting remains a compatibility fallback', () => {
  const transport = getA2aTransportConfig({
    OKX_ATTACHMENT_MAX_BYTES: '157286400',
  });
  assert.equal(transport.okxAttachmentMaxBytes, 157_286_400);
});

test('customer transport routes a file at the configured OKX ceiling through the official attachment', async () => {
  const result = await selectCustomerTransport(
    '/customer/video.mp4',
    { filename: 'video.mp4', mimeType: 'video/mp4' },
    { config: config(), stat: statWithSize(attachmentLimit) }
  );
  assert.equal(result.type, 'okx_attachment');
  assert.equal(result.expectedSizeBytes, attachmentLimit);
});

test('customer transport routes one byte above OKX limit through temporary storage', async () => {
  const uploaded = [];
  const storage = {
    createUploadAuthorization: async () => ({
      objectKey: 'pending/transfer-123/video.mp4',
      uploadEndpoint: 'https://project.storage.supabase.co/storage/v1/upload/resumable',
      token: 'signed-upload-token',
      metadata: {},
    }),
    verifySourceExists: async () => true,
    createSignedDownloadUrl: async () => 'https://project.supabase.co/storage/v1/object/sign/source',
    deleteSource: async () => {},
  };
  const result = await selectCustomerTransport(
    '/customer/video.mp4',
    { filename: 'video.mp4', mimeType: 'video/mp4' },
    {
      config: config({
        largeVideoUploadsEnabled: true,
        maxSourceBytes: attachmentLimit * 2,
      }),
      stat: statWithSize(attachmentLimit + 1),
      storage,
      randomUUID: () => 'transfer-123',
      checksumFile: async () => 'sha256:abc',
      uploadFile: async (filePath) => uploaded.push(filePath),
    }
  );
  assert.equal(result.type, 'temporary_source');
  assert.equal(result.transferId, 'transfer-123');
  assert.equal(result.expectedSizeBytes, attachmentLimit + 1);
  assert.deepEqual(uploaded, ['/customer/video.mp4']);
  assert.equal(Object.hasOwn(result, 'objectKey'), false);
});

test('large-video feature flag does not affect ordinary OKX attachments', async () => {
  const small = await selectCustomerTransport(
    '/customer/video.mp4',
    { filename: 'video.mp4', mimeType: 'video/mp4' },
    { config: config({ largeVideoUploadsEnabled: false }), stat: statWithSize(1024) }
  );
  assert.equal(small.type, 'okx_attachment');

  await assert.rejects(
    selectCustomerTransport(
      '/customer/large.mp4',
      { filename: 'large.mp4', mimeType: 'video/mp4' },
      {
        config: config({ largeVideoUploadsEnabled: false }),
        stat: statWithSize(attachmentLimit + 1),
      }
    ),
    (error) =>
      error instanceof A2aTransportError &&
      error.code === 'LARGE_VIDEO_UPLOADS_DISABLED'
  );
});

test('large-video transport requires an explicit processing byte ceiling', async () => {
  await assert.rejects(
    selectCustomerTransport(
      '/customer/large.mp4',
      { filename: 'large.mp4', mimeType: 'video/mp4' },
      {
        config: config({ largeVideoUploadsEnabled: true, maxSourceBytes: null }),
        stat: statWithSize(attachmentLimit + 1),
      }
    ),
    (error) => error.code === 'MAX_SOURCE_BYTES_NOT_CONFIGURED'
  );
});

test('temporary storage adapter rejects missing and public source buckets', async () => {
  const missingClient = {
    storage: {
      getBucket: async () => ({ data: null, error: { message: 'not found' } }),
    },
  };
  await assert.rejects(
    new SupabaseTemporarySourceStorage({ client: missingClient })
      .assertPrivateBucket(10),
    (error) =>
      error instanceof SourceStorageConfigurationError &&
      error.code === 'SOURCE_BUCKET_NOT_FOUND'
  );

  const publicClient = {
    storage: {
      getBucket: async () => ({ data: { public: true, file_size_limit: null }, error: null }),
    },
  };
  await assert.rejects(
    new SupabaseTemporarySourceStorage({ client: publicClient })
      .assertPrivateBucket(10),
    (error) => error.code === 'SOURCE_BUCKET_PUBLIC'
  );
});

test('temporary storage adapter enforces bucket and operational ceilings', async () => {
  const client = {
    storage: {
      getBucket: async () => ({
        data: { public: false, file_size_limit: 1_000 },
        error: null,
      }),
    },
  };
  await assert.rejects(
    new SupabaseTemporarySourceStorage({ client, maxSourceBytes: 2_000 })
      .assertPrivateBucket(1_001),
    (error) => error.code === 'SOURCE_BUCKET_SIZE_LIMIT'
  );
  await assert.rejects(
    new SupabaseTemporarySourceStorage({ client, maxSourceBytes: 500 })
      .assertPrivateBucket(501),
    (error) => error.code === 'SOURCE_TOO_LARGE'
  );
});

test('temporary storage rejects unsafe signed download metadata', async () => {
  const bucket = {
    createSignedUrl: async () => ({
      data: { signedUrl: 'http://user:password@storage.example/video' },
      error: null,
    }),
  };
  const client = {
    storage: {
      getBucket: async () => ({ data: { public: false }, error: null }),
      from: () => bucket,
    },
  };
  await assert.rejects(
    new SupabaseTemporarySourceStorage({ client })
      .createSignedDownloadUrl('pending/transfer-123/video.mp4', 60),
    (error) => error.code === 'SIGNED_DOWNLOAD_INVALID'
  );
});

test('interrupted resumable upload requests TUS cleanup', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-tus-'));
  const filePath = path.join(directory, 'source.mp4');
  await fs.promises.writeFile(filePath, 'video-bytes');
  const methods = [];
  const fetchImpl = async (url, options) => {
    methods.push(options.method);
    if (options.method === 'POST') {
      return {
        ok: true,
        status: 201,
        headers: new Headers({ location: '/upload/session-1' }),
      };
    }
    if (options.method === 'PATCH') {
      return { ok: false, status: 500, headers: new Headers() };
    }
    return { ok: true, status: 204, headers: new Headers() };
  };
  try {
    await assert.rejects(
      uploadFileWithTus(filePath, {
        uploadEndpoint: 'https://project.storage.supabase.co/storage/v1/upload/resumable',
        token: 'signed-token',
        metadata: {
          bucketName: 'clipagent-sources',
          objectName: 'pending/transfer-123/source.mp4',
          contentType: 'video/mp4',
        },
      }, { fetchImpl }),
      /HTTP 500/
    );
    assert.deepEqual(methods, ['POST', 'PATCH', 'DELETE']);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('insufficient temporary disk is rejected before materialization', async () => {
  await assert.rejects(
    assertTemporaryDiskCapacity({
      targetPath: '/tmp',
      expectedSourceBytes: 100,
      multiplier: 3,
      getFreeBytes: async () => 299,
    }),
    (error) =>
      error instanceof InsufficientTemporaryDiskError &&
      error.requiredBytes === 300
  );
});

test('materialized official attachment is FFprobed before pipeline handoff', async () => {
  const input = {
    type: 'okx_attachment',
    localPath: '/tmp/official-attachment.mp4',
    expectedSizeBytes: 500,
    filename: 'source.mp4',
    mimeType: 'video/mp4',
  };
  let probedPath;
  const materialized = await materializeProviderInput(input, {
    config: config(),
    stat: statWithSize(500),
    assertDiskCapacity: async () => {},
    probeVideo: async (filePath) => {
      probedPath = filePath;
      return { durationSeconds: 60, videoStreamCount: 1 };
    },
  });
  assert.equal(probedPath, input.localPath);
  assert.equal(materialized.file.path, input.localPath);
});

test('a source over 3600 seconds is rejected before pipeline handoff', async () => {
  const input = {
    type: 'okx_attachment',
    localPath: '/tmp/too-long.mp4',
    expectedSizeBytes: 500,
    filename: 'too-long.mp4',
    mimeType: 'video/mp4',
  };
  await assert.rejects(
    materializeProviderInput(input, {
      config: config(),
      stat: statWithSize(500),
      assertDiskCapacity: async () => {},
      probeVideo: async () => ({
        durationSeconds: 3_600.001,
        videoStreamCount: 1,
      }),
    }),
    (error) =>
      error.code === 'SOURCE_DURATION_EXCEEDED' &&
      error.statusCode === 413
  );
});

test('over-3600-second media never reaches transcription, ranking, rendering, or upload', async () => {
  let pipelineCalls = 0;
  await assert.rejects(
    processA2aClipTask({
      jobId: 'job-too-long',
      status: 'accepted',
      input: {
        type: 'okx_attachment',
        localPath: '/tmp/too-long.mp4',
        expectedSizeBytes: 500,
        filename: 'too-long.mp4',
        mimeType: 'video/mp4',
      },
    }, {
      materializeProviderInput: (input) => materializeProviderInput(input, {
        config: config(),
        stat: statWithSize(500),
        assertDiskCapacity: async () => {},
        probeVideo: async () => ({
          durationSeconds: 3_601,
          videoStreamCount: 1,
        }),
      }),
      processClip: async () => {
        pipelineCalls += 1;
      },
    }),
    (error) => error.code === 'SOURCE_DURATION_EXCEEDED'
  );
  assert.equal(pipelineCalls, 0);
});

test('invalid downloaded video is cleaned and never reaches the pipeline', async () => {
  const cleaned = [];
  await assert.rejects(
    materializeProviderInput({
      type: 'temporary_source',
      downloadUrl: 'https://project.supabase.co/signed/video',
      expectedSizeBytes: 500,
      filename: 'source.mp4',
      mimeType: 'video/mp4',
      transferId: 'transfer-123',
    }, {
      config: config({ largeVideoUploadsEnabled: true, maxSourceBytes: 1_000 }),
      assertDiskCapacity: async () => {},
      downloadVideo: async () => ({
        path: '/tmp/downloaded.mp4',
        filename: 'downloaded.mp4',
        size: 500,
      }),
      probeVideo: async () => {
        const error = new Error('no video');
        error.code = 'VIDEO_STREAM_REQUIRED';
        throw error;
      },
      cleanup: async (paths) => cleaned.push(...paths),
    }),
    (error) => error.code === 'VIDEO_STREAM_REQUIRED'
  );
  assert.deepEqual(cleaned, ['/tmp/downloaded.mp4']);
});

test('provider orchestration invokes the existing pipeline once after accepted state', async () => {
  let pipelineCalls = 0;
  const deleted = [];
  const result = await processA2aClipTask({
    jobId: 'job-123',
    status: 'accepted',
    input: {
      type: 'temporary_source',
      transferId: 'transfer-123',
      downloadUrl: 'https://project.supabase.co/signed/video',
      expectedSizeBytes: 500,
    },
  }, {
    objectKey: 'pending/transfer-123/video.mp4',
    materializeProviderInput: async () => ({
      file: { path: '/tmp/video.mp4', filename: 'video.mp4' },
    }),
    processClip: async () => {
      pipelineCalls += 1;
      return {
        clips: [{
          index: 0,
          reason: 'Strong hook',
          requestedStartSeconds: 10,
          requestedEndSeconds: 35,
          actualDurationSeconds: 25,
          supabase: { publicUrl: 'https://cdn.example.test/clip.mp4' },
        }],
      };
    },
    sourceStorage: { deleteSource: async (key) => deleted.push(key) },
  });
  assert.equal(pipelineCalls, 1);
  assert.equal(result.clips[0].url, 'https://cdn.example.test/clip.mp4');
  assert.deepEqual(deleted, ['pending/transfer-123/video.mp4']);
});

test('provider orchestration rejects pre-escrow work and cleans source after failure', async () => {
  await assert.rejects(
    processA2aClipTask({ status: 'created', input: { type: 'okx_attachment' } }),
    (error) => error.code === 'A2A_JOB_NOT_ACCEPTED'
  );

  const deleted = [];
  await assert.rejects(
    processA2aClipTask({
      jobId: 'job-123',
      status: 'accepted',
      input: {
        type: 'temporary_source',
        transferId: 'transfer-123',
        downloadUrl: 'https://project.supabase.co/signed/video',
        expectedSizeBytes: 500,
      },
    }, {
      objectKey: 'pending/transfer-123/video.mp4',
      materializeProviderInput: async () => ({
        file: { path: '/tmp/video.mp4', filename: 'video.mp4' },
      }),
      processClip: async () => {
        throw new Error('pipeline failed');
      },
      sourceStorage: { deleteSource: async (key) => deleted.push(key) },
    }),
    /pipeline failed/
  );
  assert.deepEqual(deleted, ['pending/transfer-123/video.mp4']);
});

test('expired and abandoned source cleanup is idempotent', async () => {
  const registry = new SourceTransferRegistry({ now: () => 10_000 });
  registry.register({
    transferId: 'transfer-123',
    objectKey: 'pending/transfer-123/video.mp4',
    expiresAt: new Date(9_000).toISOString(),
  });
  const deleted = [];
  const first = await cleanupExpiredTransfers({
    registry,
    sourceStorage: { deleteSource: async (key) => deleted.push(key) },
  });
  const second = await cleanupExpiredTransfers({
    registry,
    sourceStorage: { deleteSource: async (key) => deleted.push(key) },
  });
  assert.equal(first[0].deleted, true);
  assert.deepEqual(second, []);
  assert.deepEqual(deleted, ['pending/transfer-123/video.mp4']);
});

test('task cleanup retains disputed evidence unless policy explicitly permits deletion', async () => {
  const registry = new SourceTransferRegistry();
  registry.register({
    transferId: 'transfer-123',
    objectKey: 'pending/transfer-123/video.mp4',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  registry.associate('transfer-123', { jobId: 'job-123', ownerAgentId: 'buyer-1' });
  const deleted = [];
  const sourceStorage = { deleteSource: async (key) => deleted.push(key) };

  const retained = await cleanupTaskTransfer({
    transferId: 'transfer-123',
    taskStatus: 'disputed',
    registry,
    sourceStorage,
  });
  assert.equal(retained.reason, 'status_retained');
  assert.deepEqual(deleted, []);

  const removed = await cleanupTaskTransfer({
    transferId: 'transfer-123',
    taskStatus: 'disputed',
    disputedCleanupAllowed: true,
    registry,
    sourceStorage,
  });
  assert.equal(removed.deleted, true);
  assert.deepEqual(deleted, ['pending/transfer-123/video.mp4']);
});

test('checksum mismatch removes a downloaded temporary source', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-a2a-'));
  const filePath = path.join(directory, 'source.mp4');
  await fs.promises.writeFile(filePath, 'video');
  const cleaned = [];
  try {
    await assert.rejects(
      materializeProviderInput({
        type: 'temporary_source',
        downloadUrl: 'https://project.supabase.co/signed/video',
        expectedSizeBytes: 5,
        filename: 'source.mp4',
        mimeType: 'video/mp4',
        checksum: 'sha256:not-the-checksum',
        transferId: 'transfer-123',
      }, {
        config: config({ largeVideoUploadsEnabled: true, maxSourceBytes: 1_000 }),
        assertDiskCapacity: async () => {},
        downloadVideo: async () => ({
          path: filePath,
          filename: 'source.mp4',
          size: 5,
        }),
        cleanup: async (paths) => {
          cleaned.push(...paths);
          await Promise.all(paths.map((entry) => fs.promises.unlink(entry)));
        },
      }),
      (error) => error.code === 'SOURCE_CHECKSUM_MISMATCH'
    );
    assert.deepEqual(cleaned, [filePath]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});
