const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  runOkxA2aJob,
  buildDeliveryPayload,
} = require('../services/okxA2aJobHandler');
const { OkxA2aJobStateStore } = require('../services/okxA2aJobStateStore');
const { A2aStageCheckpointStore } = require('../services/a2aStageCheckpointStore');
const { buildFfmpegCutArgs, VERTICAL_9_16_FILTER } = require('../services/cuttingService');
const { normalizeOkxA2aJob } = require('../services/okxA2aTaskNormalizer');
const { getA2aTransportConfig } = require('../config/a2aTransportConfig');

function contractsForMap(serviceClipMap) {
  return Object.fromEntries(
    Object.entries(serviceClipMap).map(([serviceId, clipCount]) => [
      serviceId,
      {
        active: true,
        contractVersion: `test-service-${serviceId}-v1`,
        clipCount,
        pricingModel: 'fixed_service_total',
        feeAmount: String(Number(clipCount) * 0.5),
        feeCurrency: 'USDT',
      },
    ])
  );
}

function makeJobFile(
  jobId,
  {
    providerId = 6041,
    serviceId = 37723,
    instruction = 'Turn this video into three engaging 20–45 second vertical clips. Return public playable URLs, timestamps, durations, and the reason each segment was selected.',
    clipCount = 3,
    minDurationSeconds = 20,
    maxDurationSeconds = 45,
    serviceParams = 'clipCount=3',
    sessionAgentId = '9871',
    attachment = {},
    includeAttachment = true,
  } = {}
) {
  const messages = [
    {
      id: 'msg-accepted',
      rawText: JSON.stringify({
        event: 'job_accepted',
        jobId,
        providerId,
        serviceId,
        description: instruction,
        clipCount,
        minDurationSeconds,
        maxDurationSeconds,
        serviceParams,
      }),
    },
  ];

  if (includeAttachment) {
    messages.push({
      id: 'msg-attachment',
      rawText: JSON.stringify({
        event: 'user_attachment_received',
        jobId,
        fileKey: attachment.fileKey || 'file-key',
        digest: attachment.digest || 'digest',
        salt: attachment.salt || 'salt',
        nonce: attachment.nonce || 'nonce',
        secret: attachment.secret || 'secret',
        filename: attachment.filename || 'demo.mp4',
        mimeType: attachment.mimeType || 'video/mp4',
        expectedSizeBytes: attachment.expectedSizeBytes ?? 21,
      }),
    });
  }

  return {
    schemaVersion: 1,
    jobId,
    sessionAgentId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages,
  };
}

async function createJobHarness({
  jobId = 'job-123',
  serviceId = 37723,
  providerId = 6041,
  instruction,
  clipCount = 3,
  serviceParams,
  attachment = {},
  includeAttachment = true,
  serviceClipMap = { 37723: 1 },
  serviceContracts = contractsForMap(serviceClipMap),
  stateSeed = null,
  deliverShouldFail = false,
  mutateClips = (clips) => clips,
} = {}) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-a2a-job-'));
  const jobFilePath = path.join(tempDir, 'job.json');
  const attachmentPath = path.join(tempDir, 'demo.mp4');
  const statePath = path.join(tempDir, 'state.json');
  const commandCalls = [];
  const logs = [];
  let pipelineRequestedClipCount = null;
  let pipelineRuns = 0;
  let deliveredMessages = 0;

  await fs.promises.writeFile(
    jobFilePath,
    JSON.stringify(
      makeJobFile(jobId, {
        providerId,
        serviceId,
        instruction,
        clipCount,
        serviceParams,
        attachment,
        includeAttachment,
      }),
      null,
      2
    )
  );

  if (stateSeed) {
    await fs.promises.writeFile(statePath, JSON.stringify(stateSeed, null, 2));
  }

  const logger = {
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    error: (message) => logs.push(message),
  };

  const runCommand = async (command, args) => {
    commandCalls.push({ command, args });
    if (command === 'okx-a2a') {
      await fs.promises.writeFile(attachmentPath, 'downloaded-attachment');
      return { stdout: `${attachmentPath}\n`, stderr: '' };
    }
    if (command === 'onchainos') {
      if (args[1] === 'status') {
        return { stdout: '{"ok":true,"data":{"status":"accepted"}}\n', stderr: '' };
      }
      deliveredMessages += 1;
      if (deliverShouldFail && deliveredMessages === 1) {
        const error = new Error('delivery failed');
        error.code = 'DELIVERY_FAILED';
        error.statusCode = 502;
        throw error;
      }
      return { stdout: '{"ok":true,"delivered":true}\n', stderr: '' };
    }
    throw new Error(`unexpected command ${command}`);
  };

  const options = {
    env: {
      OKX_AGENT_TASK_CURRENT_JOB_FILE: jobFilePath,
      OKX_AGENT_TASK_CURRENT_JOB_ID: jobId,
      OKX_AGENT_TASK_CURRENT_AGENT_ID: String(providerId),
      OKX_A2A_SERVICE_CLIP_MAP: JSON.stringify(serviceClipMap),
      OKX_A2A_SERVICE_CONTRACTS: JSON.stringify(serviceContracts),
    },
    logger,
    stateStore: new OkxA2aJobStateStore({ filePath: statePath }),
    stageCheckpointStore: new A2aStageCheckpointStore({
      rootDir: path.join(tempDir, 'stages'),
      artifactRoot: path.join(tempDir, 'artifacts'),
    }),
    runCommand,
    materializeProviderInput: async (input) => {
      assert.equal(input.type, 'okx_attachment');
      assert.equal(path.basename(input.localPath), 'source-demo.mp4');
      assert.equal(fs.existsSync(input.localPath), true);
      assert.equal(input.expectedSizeBytes, Buffer.byteLength('downloaded-attachment'));
      return {
        file: {
          path: input.localPath,
          filename: 'demo.mp4',
          originalname: 'demo.mp4',
          mimetype: 'video/mp4',
          size: Buffer.byteLength('downloaded-attachment'),
        },
        metadata: { durationSeconds: 296 },
      };
    },
    transcribe: async () => ({
      segments: [{ id: 0, start: 0, end: 30, text: 'intro' }],
      duration: 296,
    }),
    rankMoments: async (segments, rankOptions) => {
      pipelineRequestedClipCount = rankOptions.clipCount;
      return {
        moments: Array.from({ length: rankOptions.clipCount }, (_, index) => ({
          segment_ids: [0],
          start_time: index * 30,
          end_time: index * 30 + 25,
          reason: `Reason ${index + 1}`,
        })),
        raw: '{"moments":[]}',
        attempts: 1,
        provider: 'mock',
        model: 'mock',
      };
    },
    pipelineProcessClip: async (pipelineJobId, file, overrides) => {
      pipelineRuns += 1;
      assert.equal(pipelineJobId, jobId);
      assert.equal(path.basename(file.path), 'source-demo.mp4');
      assert.equal(fs.existsSync(file.path), true);
      assert.equal(typeof overrides.transcribe, 'function');
      assert.equal(typeof overrides.rankMoments, 'function');
      assert.equal(typeof overrides.cutMoments, 'function');
      await overrides.transcribe('/tmp/audio.mp4', 'audio.mp4', 'audio/mp4');
      const ranked = await overrides.rankMoments([{ id: 0, start: 0, end: 30, text: 'intro' }]);
      assert.ok(Array.isArray(ranked.moments));
      assert.equal(ranked.moments.length, pipelineRequestedClipCount);
      const clips = ranked.moments.map((moment, index) => ({
          filename: `clip-${index + 1}.mp4`,
          reason: moment.reason,
          requestedStartSeconds: moment.start_time,
          requestedEndSeconds: moment.end_time,
          actualDurationSeconds: moment.end_time - moment.start_time,
          supabase: { publicUrl: `https://cdn.example.test/clip-${index + 1}.mp4` },
        }));
      return {
        clips: mutateClips(clips),
        rankingModel: 'mock',
        audioFileSizeBytes: 123,
        transcriptDurationSeconds: 296,
      };
    },
  };

  return {
    tempDir,
    jobFilePath,
    attachmentPath,
    statePath,
    commandCalls,
    logs,
    get pipelineRequestedClipCount() {
      return pipelineRequestedClipCount;
    },
    get pipelineRuns() {
      return pipelineRuns;
    },
    options,
    run: () => runOkxA2aJob(options),
  };
}

test('vertical cut args use the portrait filter required for A2A delivery', () => {
  const args = buildFfmpegCutArgs('/tmp/source.mp4', '/tmp/output.mp4', 10, 25, {
    videoFilter: VERTICAL_9_16_FILTER,
  });
  assert.ok(args.includes(VERTICAL_9_16_FILTER));
  assert.ok(args.includes('-vf'));
});

test('okx a2a job handler uses the configured service mapping for purchased quantity', async () => {
  const harness = await createJobHarness({
    serviceId: 37723,
    clipCount: 3,
    serviceParams: 'clipCount=3',
    instruction: 'Turn this video into three engaging 20–45 second vertical clips.',
    serviceClipMap: { 37723: 1 },
  });

  const result = await harness.run();

  assert.equal(result.jobId, 'job-123');
  assert.equal(result.providerId, 6041);
  assert.equal(result.serviceId, 37723);
  assert.equal(result.purchasedClipCount, 1);
  assert.equal(result.deliveryPayload.status, 'completed');
  assert.equal(result.diagnosticRequestedClipCount, 3);
  assert.equal(Object.hasOwn(result.deliveryPayload, 'requestedClipCount'), false);
  assert.equal(result.deliveryPayload.generatedClipCount, 1);
  assert.equal(result.deliveryPayload.clipCount, 1);
  assert.equal(result.deliveryPayload.pricingModel, 'fixed_service_total');
  assert.equal(result.deliveryPayload.serviceFeeAmount, '0.5');
  assert.equal(result.deliveryPayload.serviceFeeCurrency, 'USDT');
  assert.equal(Object.hasOwn(result.deliveryPayload, 'pricePerClip'), false);
  assert.equal(Object.hasOwn(result.deliveryPayload, 'totalAmountPaid'), false);
  assert.equal(result.deliveryPayload.serviceContractVersion, 'test-service-37723-v1');
  assert.match(result.quantityNote, /requested 3 clips/i);
  assert.match(result.quantityNote, /service 37723 purchases 1/i);
  assert.deepEqual(result.deliveryPayload.clips.map((clip) => clip.url), [
    'https://cdn.example.test/clip-1.mp4',
  ]);
  assert.deepEqual(result.deliveryPayload.clips.map((clip) => clip.selectionReason), ['Reason 1']);
  assert.equal(harness.pipelineRequestedClipCount, 1);
  assert.equal(fs.existsSync(harness.attachmentPath), false);

  const commandNames = harness.commandCalls.map((entry) => entry.command);
  assert.deepEqual(commandNames, ['okx-a2a', 'onchainos']);

  const deliverCall = harness.commandCalls.find((entry) => entry.command === 'onchainos');
  assert.ok(deliverCall);
  const deliveredMessage = JSON.parse(deliverCall.args[deliverCall.args.indexOf('--message') + 1]);
  assert.equal(deliveredMessage.purchasedClipCount, 1);
  assert.equal(Object.hasOwn(deliveredMessage, 'requestedClipCount'), false);
  assert.equal(deliveredMessage.generatedClipCount, 1);
  assert.equal(deliveredMessage.serviceFeeAmount, '0.5');
  assert.equal(Object.hasOwn(deliveredMessage, 'totalAmountPaid'), false);

  const stored = JSON.parse(await fs.promises.readFile(harness.statePath, 'utf8'));
  assert.equal(stored.jobs['job-123'].status, 'delivered');
  assert.equal(stored.jobs['job-123'].contractVersion, 'test-service-37723-v1');

  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler honors a two-clip service mapping', async () => {
  const harness = await createJobHarness({
    jobId: 'job-2',
    serviceId: 90002,
    clipCount: 2,
    serviceParams: 'clipCount=2',
    instruction: 'Turn this video into two engaging 20–45 second vertical clips.',
    serviceClipMap: { 90002: 2 },
  });

  const result = await harness.run();

  assert.equal(result.purchasedClipCount, 2);
  assert.equal(Object.hasOwn(result.deliveryPayload, 'requestedClipCount'), false);
  assert.equal(result.deliveryPayload.generatedClipCount, 2);
  assert.equal(result.deliveryPayload.serviceFeeAmount, '1');
  assert.equal(harness.pipelineRequestedClipCount, 2);
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler honors a three-clip service mapping', async () => {
  const harness = await createJobHarness({
    jobId: 'job-3',
    serviceId: 90003,
    clipCount: 3,
    serviceParams: 'clipCount=3',
    instruction: 'Turn this video into three engaging 20–45 second vertical clips.',
    serviceClipMap: { 90003: 3 },
  });

  const result = await harness.run();

  assert.equal(result.purchasedClipCount, 3);
  assert.equal(Object.hasOwn(result.deliveryPayload, 'requestedClipCount'), false);
  assert.equal(result.deliveryPayload.generatedClipCount, 3);
  assert.equal(result.deliveryPayload.serviceFeeAmount, '1.5');
  assert.equal(harness.pipelineRequestedClipCount, 3);
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler rejects unknown service ids before downloading', async () => {
  const harness = await createJobHarness({
    jobId: 'job-unknown-service',
    serviceId: 49999,
    clipCount: 1,
    instruction: 'Turn this video into one clip.',
    serviceParams: 'clipCount=1',
    serviceClipMap: { 37723: 1 },
  });

  await assert.rejects(harness.run(), /not configured for A2A clip quantities/);
  assert.deepEqual(harness.commandCalls, []);
  const stored = JSON.parse(await fs.promises.readFile(harness.statePath, 'utf8'));
  assert.equal(stored.jobs['job-unknown-service'].status, 'failed');
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler rejects malformed service map JSON', async () => {
  const harness = await createJobHarness({
    jobId: 'job-invalid-map',
    serviceId: 37723,
    clipCount: 1,
    instruction: 'Turn this video into one clip.',
    serviceParams: 'clipCount=1',
    serviceClipMap: { 37723: 1 },
  });

  harness.options.env.OKX_A2A_SERVICE_CLIP_MAP = '{bad-json';

  await assert.rejects(harness.run(), /valid JSON/);
  assert.deepEqual(harness.commandCalls, []);
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler rejects invalid attachment metadata before transcription', async () => {
  const harness = await createJobHarness({
    jobId: 'job-invalid-attachment',
    serviceId: 37723,
    includeAttachment: true,
    attachment: { expectedSizeBytes: 'abc' },
    serviceClipMap: { 37723: 1 },
  });

  await assert.rejects(harness.run(), /invalid expected size/);
  assert.deepEqual(harness.commandCalls, []);
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler rejects missing attachment metadata before transcription', async () => {
  const harness = await createJobHarness({
    jobId: 'job-missing-attachment',
    includeAttachment: false,
    serviceClipMap: { 37723: 1 },
  });

  await assert.rejects(harness.run(), /attachment metadata/i);
  assert.deepEqual(harness.commandCalls, []);
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler rejects provider mismatches', async () => {
  const harness = await createJobHarness({
    jobId: 'job-provider-mismatch',
    providerId: 7000,
    serviceId: 37723,
    serviceClipMap: { 37723: 1 },
  });

  await assert.rejects(harness.run(), /Unexpected providerId 7000/);
  assert.deepEqual(harness.commandCalls, []);
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler skips jobs that were already delivered', async () => {
  const harness = await createJobHarness({
    jobId: 'job-999',
    serviceClipMap: { 37723: 1 },
    stateSeed: {
      schemaVersion: 1,
      jobs: {
        'job-999': {
          jobId: 'job-999',
          status: 'delivered',
        },
      },
    },
  });

  const result = await harness.run();

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'already_processed');
  assert.deepEqual(harness.commandCalls, []);
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler resumes delivery without rerunning the pipeline after delivery failure', async () => {
  const harness = await createJobHarness({
    jobId: 'job-retry',
    serviceId: 37723,
    clipCount: 3,
    serviceParams: 'clipCount=3',
    serviceClipMap: { 37723: 1 },
    deliverShouldFail: true,
  });

  await assert.rejects(harness.run(), /delivery failed/);
  let state = JSON.parse(await fs.promises.readFile(harness.statePath, 'utf8'));
  assert.equal(state.jobs['job-retry'].status, 'delivery_failed');
  assert.ok(state.jobs['job-retry'].result);
  assert.equal(harness.pipelineRuns, 1);

  harness.options.env.OKX_A2A_SERVICE_CLIP_MAP = JSON.stringify({ 37723: 1 });
  harness.options.runCommand = async (command, args) => {
    harness.commandCalls.push({ command, args });
    if (command === 'okx-a2a') {
      throw new Error('resume should not download again');
    }
    if (command === 'onchainos') {
      return { stdout: '{"ok":true,"delivered":true}\n', stderr: '' };
    }
    throw new Error(`unexpected command ${command}`);
  };
  const retryResult = await harness.run();

  assert.equal(retryResult.deliveryPayload.purchasedClipCount, 1);
  assert.equal(retryResult.deliveryPayload.generatedClipCount, 1);
  assert.equal(harness.pipelineRuns, 1);
  assert.equal(
    harness.commandCalls.filter((entry) => entry.command === 'okx-a2a').length,
    1
  );
  assert.equal(
    harness.commandCalls.filter(
      (entry) => entry.command === 'onchainos' && entry.args[1] === 'deliver'
    ).length,
    2
  );
  state = JSON.parse(await fs.promises.readFile(harness.statePath, 'utf8'));
  assert.equal(state.jobs['job-retry'].status, 'delivered');
  assert.equal(state.jobs['job-retry'].deliveryPayload.purchasedClipCount, 1);
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler rejects invalid final output before delivery', async () => {
  const cases = [
    ['quantity', () => []],
    ['URL', (clips) => [{ ...clips[0], supabase: { publicUrl: 'file:///tmp/clip.mp4' } }]],
    ['timestamps', (clips) => [{
      ...clips[0],
      requestedEndSeconds: clips[0].requestedStartSeconds,
      actualDurationSeconds: 25,
    }]],
    ['duration', (clips) => [{ ...clips[0], actualDurationSeconds: 19 }]],
    ['reason', (clips) => [{ ...clips[0], reason: '' }]],
  ];
  for (const [label, mutateClips] of cases) {
    const harness = await createJobHarness({
      jobId: `job-invalid-output-${label}`,
      serviceClipMap: { 37723: 1 },
      mutateClips,
    });
    await assert.rejects(
      harness.run(),
      (error) => error.code === 'INVALID_A2A_OUTPUT'
    );
    assert.equal(
      harness.commandCalls.filter((entry) => entry.command === 'onchainos').length,
      0
    );
    await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
  }
});

test('invalid persisted output restarts processing instead of resuming delivery', async () => {
  const harness = await createJobHarness({
    jobId: 'job-invalid-persisted-output',
    serviceClipMap: { 37723: 1 },
    stateSeed: {
      schemaVersion: 1,
      jobs: {
        'job-invalid-persisted-output': {
          jobId: 'job-invalid-persisted-output',
          status: 'delivery_failed',
          stage: 'delivery',
          contractVersion: 'test-service-37723-v1',
          result: {
            clips: [{
              url: 'file:///tmp/not-public.mp4',
              startSeconds: 0,
              endSeconds: 25,
              durationSeconds: 25,
              reason: 'Old invalid output',
            }],
          },
          deliveryPayload: { status: 'completed' },
        },
      },
    },
  });
  const result = await harness.run();
  assert.equal(result.deliveryPayload.clipCount, 1);
  assert.equal(harness.pipelineRuns, 1);
  assert.equal(
    harness.commandCalls.filter((entry) => entry.command === 'okx-a2a').length,
    1
  );
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('okx a2a job handler rejects missing job ids', async () => {
  const harness = await createJobHarness({
    jobId: '',
    serviceId: 37723,
    serviceClipMap: { 37723: 1 },
  });

  await assert.rejects(harness.run(), /jobId/);
  await fs.promises.rm(harness.tempDir, { recursive: true, force: true });
});

test('task normalization preserves SDK fileSize as expectedSizeBytes', () => {
  const job = makeJobFile('job-sdk-file-size');
  const attachmentEvent = JSON.parse(job.messages[1].rawText);
  delete attachmentEvent.expectedSizeBytes;
  attachmentEvent.fileSize = 1_073_741_824;
  job.messages[1].rawText = JSON.stringify(attachmentEvent);
  const config = getA2aTransportConfig({
    OKX_A2A_MAX_FILE_SIZE_BYTES: '1073741824',
    OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1}',
  });
  const normalized = normalizeOkxA2aJob(job, {
    env: { OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1}' },
    config,
  });
  assert.equal(normalized.attachment.expectedSizeBytes, 1_073_741_824);
  assert.equal(normalized.attachment.rawFileSize, 1_073_741_824);
});

for (const sizeField of ['fileSize', 'expectedSizeBytes', 'sizeBytes', 'size']) {
  test(`task normalization recognizes ${sizeField}`, () => {
    const job = makeJobFile(`job-size-${sizeField}`);
    const attachmentEvent = JSON.parse(job.messages[1].rawText);
    delete attachmentEvent.expectedSizeBytes;
    attachmentEvent[sizeField] = 42_000;
    job.messages[1].rawText = JSON.stringify(attachmentEvent);
    const normalized = normalizeOkxA2aJob(job, {
      env: { OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1}' },
      config: getA2aTransportConfig({
        OKX_A2A_MAX_FILE_SIZE_BYTES: '1073741824',
        OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1}',
      }),
    });
    assert.equal(normalized.attachment.expectedSizeBytes, 42_000);
  });
}

test('task normalization rejects multiple official attachments clearly', () => {
  const job = makeJobFile('job-multiple-attachments');
  job.messages.push({
    id: 'msg-attachment-2',
    rawText: JSON.stringify({
      event: 'user_attachment_received',
      jobId: 'job-multiple-attachments',
      fileKey: 'second-file-key',
      digest: 'second-digest',
      salt: 'second-salt',
      nonce: 'second-nonce',
      secret: 'second-secret',
      filename: 'second.mp4',
      mimeType: 'video/mp4',
      fileSize: 10,
    }),
  });
  assert.throws(
    () => normalizeOkxA2aJob(job, {
      env: { OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1}' },
      config: getA2aTransportConfig({
        OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1}',
      }),
    }),
    (error) =>
      error.code === 'MULTIPLE_ATTACHMENTS_UNSUPPORTED' &&
      error.statusCode === 400
  );
});

test('task normalization rejects source URLs when no official attachment exists', () => {
  const job = makeJobFile('job-source-url', { includeAttachment: false });
  const accepted = JSON.parse(job.messages[0].rawText);
  accepted.sourceUrl = 'https://example.test/video.mp4';
  job.messages[0].rawText = JSON.stringify(accepted);
  assert.throws(
    () => normalizeOkxA2aJob(job, {
      env: { OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1}' },
      config: getA2aTransportConfig({
        OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1}',
      }),
    }),
    /No official attachment metadata/
  );
});

test('delivery payload matches the one-clip fixed-price marketplace contract', () => {
  const payload = buildDeliveryPayload({
    jobId: 'job-contract-snapshot',
    providerId: 6041,
    serviceId: 37723,
    serviceContract: {
      contractVersion: 'clipagent-a2a-37723-v1',
      pricingModel: 'fixed_service_total',
      feeAmount: '0.5',
      feeCurrency: 'USDT',
    },
    purchasedClipCount: 1,
    diagnosticRequestedClipCount: 3,
    diagnosticRequestedClipCountSource: 'task-input',
    quantityNote: 'buyer requested three',
    result: {
      clips: [{
        url: 'https://project.supabase.co/storage/v1/object/public/clips/job/clip-1.mp4',
        startSeconds: 10,
        endSeconds: 35,
        durationSeconds: 25,
        reason: 'A clear, self-contained explanation.',
      }],
    },
  });
  assert.deepEqual(payload, {
    status: 'completed',
    jobId: 'job-contract-snapshot',
    providerId: 6041,
    serviceId: 37723,
    serviceContractVersion: 'clipagent-a2a-37723-v1',
    purchasedClipCount: 1,
    generatedClipCount: 1,
    clipCount: 1,
    pricingModel: 'fixed_service_total',
    serviceFeeAmount: '0.5',
    serviceFeeCurrency: 'USDT',
    clips: [{
      url: 'https://project.supabase.co/storage/v1/object/public/clips/job/clip-1.mp4',
      startTime: 10,
      endTime: 35,
      durationSeconds: 25,
      selectionReason: 'A clear, self-contained explanation.',
    }],
  });
  assert.equal(Object.hasOwn(payload, 'requestedClipCount'), false);
  assert.equal(Object.hasOwn(payload, 'quantityNote'), false);
});
