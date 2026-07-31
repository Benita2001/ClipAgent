const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { processA2aClipTask } = require('./a2aClipOrchestrationService');
const { materializeProviderInput, A2aTransportError } = require('./a2aInputTransportService');
const { processClip } = require('./pipelineService');
const { processA2aDurableClip } = require('./a2aDurablePipelineService');
const { rankMoments } = require('./rankingService');
const { cutMoments, VERTICAL_9_16_FILTER } = require('./cuttingService');
const { constrainRankedMoments } = require('./clipMomentConstraints');
const {
  DEFAULT_REQUESTED_CLIP_COUNT,
  MAX_REQUESTED_CLIP_COUNT,
  DEFAULT_MIN_DURATION_SECONDS,
  DEFAULT_MAX_DURATION_SECONDS,
  coerceRequestedClipCount,
  normalizeDurationBounds,
} = require('./clipPricing');
const { cleanupFiles } = require('../utils/fileCleanup');
const { getA2aTransportConfig } = require('../config/a2aTransportConfig');
const { OkxA2aJobStateStore } = require('./okxA2aJobStateStore');
const { VIDEO_MIME_TYPES } = require('./supabaseTemporarySourceStorage');
const { normalizeOkxA2aJob } = require('./okxA2aTaskNormalizer');
const { validateA2aClipResult } = require('./a2aOutputValidation');
const { A2aStageCheckpointStore } = require('./a2aStageCheckpointStore');
const { getMarketplaceIdentity } = require('../config/marketplaceIdentity');

const execFileAsync = promisify(execFile);
const DEFAULT_CLIP_COUNT = DEFAULT_REQUESTED_CLIP_COUNT;
const JOB_ACK_EVENT = 'job_accepted';

function emitStatus(logger, message) {
  if (logger && typeof logger.log === 'function') {
    logger.log(message);
    return;
  }
  console.log(message);
}

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readJobFile(jobFilePath) {
  const raw = fs.readFileSync(jobFilePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Job file ${jobFilePath} did not contain JSON.`);
  }
  return parsed;
}

function normalizeMessageRecord(message) {
  const candidates = [
    message?.payload,
    message?.rawText,
    message?.content,
    message?.message,
    message,
  ];
  for (const candidate of candidates) {
    const parsed = parseMaybeJson(typeof candidate === 'string' ? candidate : JSON.stringify(candidate));
    if (parsed) return parsed;
    if (candidate && typeof candidate === 'object') return candidate;
  }
  return null;
}

function isAcceptedJobEvent(event) {
  if (!event || typeof event !== 'object') return false;
  return String(event.event || event.type || '').trim() === JOB_ACK_EVENT || String(event.status || '').trim() === 'accepted';
}

function isAttachmentEvent(event) {
  if (!event || typeof event !== 'object') return false;
  const topLevel = [
    event.fileKey,
    event.digest,
    event.salt,
    event.nonce,
    event.secret,
    event.filename,
  ];
  if (topLevel.every((value) => typeof value === 'string' && value.trim())) return true;
  const nested = event.attachment;
  return !!nested && [
    nested.fileKey,
    nested.digest,
    nested.salt,
    nested.nonce,
    nested.secret,
    nested.filename,
  ].every((value) => typeof value === 'string' && value.trim());
}

function extractAttachmentMetadata(messages, event) {
  const candidates = [];
  const addCandidates = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    candidates.push(candidate, candidate.attachment, candidate.data?.attachment);
    if (Array.isArray(candidate.attachments)) candidates.push(...candidate.attachments);
    if (Array.isArray(candidate.data?.attachments)) {
      candidates.push(...candidate.data.attachments);
    }
  };
  addCandidates(event);
  for (const message of [...messages].reverse()) {
    const parsed = normalizeMessageRecord(message);
    addCandidates(parsed);
  }
  const attachments = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const direct = candidate.fileKey ? candidate : candidate.attachment || candidate.data?.attachment || null;
    const source = direct || candidate;
    if (isAttachmentEvent(source)) {
      const attachment = {
        fileKey: source.fileKey,
        digest: source.digest,
        salt: source.salt,
        nonce: source.nonce,
        secret: source.secret,
        filename: source.filename,
        mimeType: source.mimeType || source.contentType || null,
        rawFileSize: source.fileSize ?? null,
        expectedSizeBytes: Number(
          source.expectedSizeBytes ??
          source.sizeBytes ??
          source.size ??
          source.fileSize ??
          0
        ) || null,
      };
      const identity = [
        attachment.fileKey,
        attachment.digest,
        attachment.salt,
        attachment.nonce,
        attachment.secret,
      ].map((value) => String(value || '').trim()).join(':');
      if (!seen.has(identity)) {
        seen.add(identity);
        attachments.push(attachment);
      }
    }
  }
  if (attachments.length > 1) {
    const error = new Error(
      'The configured ClipAgent service requires exactly one official video attachment.'
    );
    error.code = 'MULTIPLE_ATTACHMENTS_UNSUPPORTED';
    error.statusCode = 400;
    throw error;
  }
  return attachments[0] || null;
}

function extractInstructionText(messages, event) {
  const possible = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) possible.push(value.trim());
  };
  push(event?.instruction);
  push(event?.instructions);
  push(event?.description);
  push(event?.content);
  push(event?.taskDescription);
  push(event?.message);
  push(event?.data?.instruction);
  push(event?.data?.instructions);
  push(event?.data?.description);
  push(event?.data?.content);
  for (const message of [...messages].reverse()) {
    push(message?.rawText);
    push(message?.content);
    const parsed = normalizeMessageRecord(message);
    push(parsed?.instruction);
    push(parsed?.instructions);
    push(parsed?.description);
    push(parsed?.content);
  }
  return possible.find((value) => !value.startsWith('{')) || possible[0] || '';
}

function parseServiceParams(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  const result = {};
  for (const chunk of value.split(/[;\n,]+/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!key || rest.length === 0) continue;
    result[key.trim()] = rest.join('=').trim();
  }
  return result;
}

function extractClipPlan(event, instructionText) {
  const serviceParams = parseServiceParams(
    event?.serviceParams ??
      event?.service_params ??
      event?.params ??
      event?.data?.serviceParams ??
      event?.data?.service_params ??
      event?.data?.params
  );
  const fromEvent = {
    clipCount: event?.clipCount ?? event?.count ?? event?.data?.clipCount ?? serviceParams.clipCount,
    minDurationSeconds:
      event?.minDurationSeconds ??
      event?.minDuration ??
      event?.data?.minDurationSeconds ??
      event?.data?.minDuration ??
      serviceParams.minDurationSeconds ??
      serviceParams.minDuration,
    maxDurationSeconds:
      event?.maxDurationSeconds ??
      event?.maxDuration ??
      event?.data?.maxDurationSeconds ??
      event?.data?.maxDuration ??
      serviceParams.maxDurationSeconds ??
      serviceParams.maxDuration,
  };
  const { clipCount, tooMany } = coerceRequestedClipCount(fromEvent.clipCount);
  if (tooMany) {
    const error = new Error(`Requested clipCount ${fromEvent.clipCount} exceeds the maximum of ${MAX_REQUESTED_CLIP_COUNT}.`);
    error.code = 'CLIP_COUNT_TOO_LARGE';
    error.statusCode = 400;
    throw error;
  }
  const durationBounds = normalizeDurationBounds(
    fromEvent.minDurationSeconds,
    fromEvent.maxDurationSeconds,
    {
      defaultMin: DEFAULT_MIN_DURATION_SECONDS,
      defaultMax: DEFAULT_MAX_DURATION_SECONDS,
    }
  );
  if (durationBounds.invalid) {
    const error = new Error('The requested duration range is invalid.');
    error.code = 'INVALID_DURATION_RANGE';
    error.statusCode = 400;
    throw error;
  }
  return {
    clipCount,
    minDurationSeconds: durationBounds.minDurationSeconds,
    maxDurationSeconds: durationBounds.maxDurationSeconds,
  };
}

function guessMimeType(filename, fallback = 'video/mp4') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.avi') return 'video/x-msvideo';
  if (ext === '.mpeg' || ext === '.mpg') return 'video/mpeg';
  return fallback;
}

function readLastNonEmptyLine(stdout = '') {
  return String(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || '';
}

async function runCommand(command, args, options = {}) {
  const runner = options.runCommand || (async (cmd, argv, execOptions = {}) => {
    const { stdout, stderr } = await execFileAsync(cmd, argv, {
      cwd: execOptions.cwd,
      env: execOptions.env,
      maxBuffer: execOptions.maxBuffer || 10 * 1024 * 1024,
      timeout: execOptions.timeout,
    });
    return { stdout, stderr };
  });
  return runner(command, args, options);
}

async function downloadOfficialAttachment(attachment, options = {}) {
  if (!options.agentId) {
    throw new Error('Configured provider ID is required for attachment download.');
  }
  const args = [
    'file',
    'download',
    '--file-key',
    attachment.fileKey,
    '--agent-id',
    String(options.agentId),
    '--digest',
    attachment.digest,
    '--salt',
    attachment.salt,
    '--nonce',
    attachment.nonce,
    '--secret',
    attachment.secret,
    '--filename',
    attachment.filename,
  ];
  const { stdout } = await runCommand(options.binary || 'okx-a2a', args, {
    ...(options.commandOptions || {}),
    runCommand: options.runCommand,
  });
  const outputPath = readLastNonEmptyLine(stdout);
  if (!outputPath) {
    throw new Error('Attachment download command did not return a file path.');
  }
  return path.resolve(outputPath);
}

async function deliverResult(jobId, providerId, payload, options = {}) {
  const message = JSON.stringify(payload);
  const args = [
    'agent',
    'deliver',
    jobId,
    '--agent-id',
    String(providerId),
    '--message',
    message,
  ];
  return runCommand(options.binary || 'onchainos', args, {
    ...(options.commandOptions || {}),
    runCommand: options.runCommand,
  });
}

async function deliveryAlreadySubmitted(jobId, providerId, options = {}) {
  try {
    const { stdout } = await runCommand(
      options.binary || 'onchainos',
      ['agent', 'status', jobId, '--agent-id', String(providerId)],
      { ...(options.commandOptions || {}), runCommand: options.runCommand }
    );
    const parsed = JSON.parse(String(stdout || '').trim());
    const values = [];
    const visit = (value) => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/status|state/i.test(key) && ['string', 'number'].includes(typeof child)) {
          values.push(String(child).toLowerCase());
        }
        visit(child);
      }
    };
    visit(parsed);
    return values.some((value) =>
      ['submitted', 'delivered', 'completed', '5', '6'].includes(value)
    );
  } catch {
    return false;
  }
}

function buildDeliveryPayload({
  jobId,
  providerId,
  serviceId,
  serviceContract,
  purchasedClipCount,
  diagnosticRequestedClipCount,
  diagnosticRequestedClipCountSource,
  quantityNote,
  result,
}) {
  return {
    status: 'completed',
    jobId,
    providerId,
    serviceId,
    serviceContractVersion: serviceContract.contractVersion,
    purchasedClipCount,
    generatedClipCount: result.clips.length,
    clipCount: result.clips.length,
    pricingModel: serviceContract.pricingModel,
    serviceFeeAmount: serviceContract.feeAmount,
    serviceFeeCurrency: serviceContract.feeCurrency,
    clips: result.clips.map((clip) => ({
      url: clip.url,
      startTime: clip.startSeconds,
      endTime: clip.endSeconds,
      durationSeconds: clip.durationSeconds,
      selectionReason: clip.reason,
    })),
  };
}

async function runOkxA2aJob(options = {}) {
  const env = options.env || process.env;
  const identity = getMarketplaceIdentity(env);
  const logger = options.logger || console;
  const stateStore = options.stateStore || new OkxA2aJobStateStore();
  const config = options.config || getA2aTransportConfig(env);
  const stageCheckpointStore = options.stageCheckpointStore ||
    new A2aStageCheckpointStore({ env });
  const materialize = options.materializeProviderInput || materializeProviderInput;
  const runA2aClipTask = options.processA2aClipTask || processA2aClipTask;
  const pipelineProcessClip = options.pipelineProcessClip || processA2aDurableClip;
  const jobFilePath = options.jobFilePath || env.OKX_AGENT_TASK_CURRENT_JOB_FILE;
  let jobId = String(env.OKX_AGENT_TASK_CURRENT_JOB_ID || path.basename(jobFilePath || 'job')).trim();

  if (!jobFilePath) {
    throw new Error('OKX_AGENT_TASK_CURRENT_JOB_FILE is required to run the A2A job handler.');
  }

  emitStatus(logger, `[ClipAgent] Task created: ${env.OKX_AGENT_TASK_CURRENT_JOB_ID || path.basename(jobFilePath)}`);

  let downloadedPath;
  let downloadedSize = null;
  let cleanupTarget = null;
  let deliveryResult;
  let sourceDurationSeconds = null;
  let heartbeatTimer = null;
  const processingOwner = options.processingOwner || crypto.randomUUID();

  try {
    const jobFile = options.readJobFile ? await options.readJobFile(jobFilePath) : readJobFile(jobFilePath);
    const canonicalJob = normalizeOkxA2aJob(jobFile, { env, config });
    jobId = canonicalJob.jobId || jobId;
    const {
      providerAgentId: providerId,
      serviceId,
      purchasedClipCount,
      instructionText,
      attachment,
      acceptedEvent,
      sourceMessageId,
      sessionAgentId,
      diagnostics,
    } = canonicalJob;
    if (
      providerId !== identity.providerId ||
      serviceId !== identity.serviceId
    ) {
      const error = new Error(
        'The accepted task does not match the configured marketplace identity.'
      );
      error.code = 'MARKETPLACE_IDENTITY_MISMATCH';
      error.statusCode = 400;
      throw error;
    }
    const serviceContract = config.serviceContracts?.get(serviceId);
    if (
      !serviceContract ||
      !serviceContract.active ||
      serviceContract.clipCount !== purchasedClipCount
    ) {
      const error = new Error(
        `Service ${serviceId} does not have an active A2A service contract matching its purchased quantity.`
      );
      error.code = 'A2A_SERVICE_CONTRACT_UNAVAILABLE';
      error.statusCode = 503;
      throw error;
    }
    const previous = await stateStore.get(jobId);
    const claim = await stateStore.claim(jobId, {
      providerId,
      serviceId,
      contractVersion: serviceContract.contractVersion,
      purchasedClipCount,
      status: previous?.status || 'received',
      event: acceptedEvent.event || JOB_ACK_EVENT,
      acceptedEvent,
      sourceMessageId,
      sessionAgentId,
      instructionText,
      diagnostics,
      processingOwner,
    });
    if (!claim.claimed) {
      return {
        skipped: true,
        jobId,
        status: claim.job?.status,
        reason: claim.reason === 'already_completed' ? 'already_processed' : claim.reason,
      };
    }
    const claimedState = claim.job;
    const heartbeatMs = Number(
      env.A2A_HEARTBEAT_INTERVAL_MS ||
      stateStore.heartbeatIntervalMs ||
      30_000
    );
    let heartbeatInFlight = false;
    heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      stateStore.heartbeat(jobId, processingOwner)
        .catch((error) => logger.error?.(
          `[ClipAgent] job heartbeat failed: ${error.code || error.name || 'unknown'}`
        ))
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, heartbeatMs);
    heartbeatTimer.unref?.();
    let resumedDeliveryOnly = Boolean(
      (claim.resumeDeliveryOnly ||
        ['ready_for_delivery', 'delivery_failed'].includes(claimedState.status)) &&
        claimedState.result
    );

    let result = claimedState.result || null;
    let deliveryPayload = null;
    if (resumedDeliveryOnly) {
      try {
        validateA2aClipResult(result, {
          expectedClipCount: purchasedClipCount,
          minDurationSeconds: DEFAULT_MIN_DURATION_SECONDS,
          maxDurationSeconds: DEFAULT_MAX_DURATION_SECONDS,
          sourceDurationSeconds: claimedState.sourceDurationSeconds,
        });
      } catch (error) {
        resumedDeliveryOnly = false;
        result = null;
        await stateStore.upsert(jobId, {
          status: 'processing',
          stage: 'restarting',
          recoveryReason: `invalid_persisted_output_${error.code || 'unknown'}`,
          recoveryAttempt: Number(claimedState.recoveryAttempt || 0) + 1,
          result: null,
          deliveryPayload: null,
          deliveryResult: null,
          deliveryError: null,
        });
      }
    }
    const normalizedInstruction = instructionText || `Turn this video into ${purchasedClipCount} engaging 20–45 second vertical clip${purchasedClipCount === 1 ? '' : 's'}. Return public playable URLs, timestamps, durations, and the reason each segment was selected.`;

    if (!resumedDeliveryOnly) {
      const attachmentIdentity = {
        jobId,
        providerId,
        serviceId,
        contractVersion: serviceContract.contractVersion,
        fileKey: attachment.fileKey,
        digest: attachment.digest,
        expectedSizeBytes: attachment.expectedSizeBytes,
      };
      await stateStore.upsert(jobId, {
        status: 'attachment_downloading',
        stage: 'attachment_acquisition',
        attachment,
      });
      emitStatus(logger, '[ClipAgent] Attachment received');

      const reusableAttachment = await stageCheckpointStore.valid(
        jobId,
        'attachment',
        attachmentIdentity,
        (data) => stageCheckpointStore.verifyArtifact(data?.artifact)
      );
      if (reusableAttachment) {
        downloadedPath = reusableAttachment.artifact.path;
      } else {
        downloadedPath = await downloadOfficialAttachment(attachment, {
          agentId: providerId,
          runCommand: options.runCommand,
          binary: options.downloadBinary || 'okx-a2a',
          commandOptions: options.downloadCommandOptions || {},
        });
        cleanupTarget = downloadedPath;
        const artifact = await stageCheckpointStore.persistArtifact(
          jobId,
          downloadedPath,
          `source-${path.basename(attachment.filename)}`
        );
        await stageCheckpointStore.write(jobId, 'attachment', attachmentIdentity, {
          artifact,
          rawFileSize: attachment.rawFileSize ?? attachment.expectedSizeBytes,
          validatedAt: new Date().toISOString(),
        });
        downloadedPath = artifact.path;
      }
      const downloadedStats = await fs.promises.stat(downloadedPath);
      downloadedSize = downloadedStats.size;
      if (!downloadedStats.isFile() || downloadedSize <= 0) {
        throw new Error('The downloaded attachment is not a valid file.');
      }
      if (downloadedSize > config.okxAttachmentMaxBytes) {
        throw new A2aTransportError(
          'OKX_ATTACHMENT_TOO_LARGE',
          'The official OKX attachment exceeds its transport limit.',
          413
        );
      }

      await stateStore.upsert(jobId, {
        status: 'attachment_ready',
        stage: 'validation',
        attachmentPath: downloadedPath,
        attachmentSizeBytes: downloadedSize,
      });

      const probeIdentity = {
        ...attachmentIdentity,
        sourceChecksum: reusableAttachment?.artifact?.checksum ||
          (await stageCheckpointStore.read(jobId, 'attachment'))?.data?.artifact?.checksum,
        sourceSize: downloadedSize,
        maximumDurationSeconds: config.maxDurationSeconds,
      };
      const reusableProbe = await stageCheckpointStore.valid(
        jobId,
        'source_probe',
        probeIdentity,
        (data) =>
          Number.isFinite(data?.durationSeconds) &&
          data.durationSeconds > 0 &&
          data.durationSeconds <= config.maxDurationSeconds
      );
      const materialized = reusableProbe
        ? {
            file: {
              path: downloadedPath,
              filename: path.basename(downloadedPath),
              originalname: attachment.filename,
              mimetype: attachment.mimeType || guessMimeType(attachment.filename),
              size: downloadedSize,
            },
            metadata: reusableProbe,
            ownsLocalFile: false,
          }
        : await materialize(
            {
              type: 'okx_attachment',
              localPath: downloadedPath,
              expectedSizeBytes: downloadedSize,
              filename: attachment.filename,
              mimeType: attachment.mimeType || guessMimeType(attachment.filename),
            },
            {
              config,
              stat: async () => downloadedStats,
            }
          );
      if (!reusableProbe) {
        await stageCheckpointStore.write(
          jobId,
          'source_probe',
          probeIdentity,
          materialized.metadata
        );
      }
      sourceDurationSeconds = materialized.metadata.durationSeconds;
      emitStatus(logger, '[ClipAgent] FFprobe complete');
      await stateStore.upsert(jobId, {
        status: 'processing',
        stage: 'transcription',
        sourceDurationSeconds,
      });
      emitStatus(logger, '[ClipAgent] Escrow accepted');

      result = await runA2aClipTask(
        {
          jobId,
          status: 'accepted',
          input: {
            type: 'okx_attachment',
            localPath: materialized.file.path,
            expectedSizeBytes: downloadedSize,
            filename: materialized.file.originalname || attachment.filename,
            mimeType: materialized.file.mimetype || attachment.mimeType || guessMimeType(attachment.filename),
          },
        },
        {
          materializeProviderInput: async () => materialized,
          processClip: async (pipelineJobId, file, overrides = {}) =>
            pipelineProcessClip(pipelineJobId, file, {
              ...overrides,
              sourceDurationSeconds,
              contractVersion: serviceContract.contractVersion,
              providerId,
              serviceId,
              instructions: normalizedInstruction,
              env,
              stageCheckpointStore,
              onStageProgress: async (stage) => {
                await stateStore.heartbeat(jobId, processingOwner, {
                  status: 'processing',
                  stage,
                });
              },
              onTranscriptionChunkComplete: async ({
                chunkIndex,
                completedChunks,
                totalChunks,
                provider,
              }) => {
                await stateStore.upsert(jobId, {
                  status: 'processing',
                  stage: 'transcription',
                  transcriptionChunkIndex: chunkIndex,
                  transcriptionChunksCompleted: completedChunks,
                  transcriptionChunksTotal: totalChunks,
                  transcriptionLastProvider: provider,
                });
              },
              transcribe: async (...args) => {
                await stateStore.upsert(jobId, { status: 'processing', stage: 'transcription' });
                const transcription = await (
                  options.transcribe ||
                  overrides.transcribe ||
                  require('./transcriptionOrchestrationService').transcribeAudio
                )(...args);
                emitStatus(logger, '[ClipAgent] Transcription complete');
                return transcription;
              },
              rankMoments: async (segments) => {
                await stateStore.upsert(jobId, { status: 'processing', stage: 'ranking' });
                const ranked = await (options.rankMoments || overrides.rankMoments || rankMoments)(segments, {
                  instructions: normalizedInstruction,
                  clipCount: purchasedClipCount,
                });
                const constrained = constrainRankedMoments(
                  ranked,
                  {
                    clipCount: purchasedClipCount,
                    minDurationSeconds: DEFAULT_MIN_DURATION_SECONDS,
                    maxDurationSeconds: DEFAULT_MAX_DURATION_SECONDS,
                  },
                  sourceDurationSeconds
                );
                emitStatus(logger, '[ClipAgent] Moments ranked');
                return constrained;
              },
              cutMoments: async (sourcePath, cutJobId, moments) => {
                await stateStore.upsert(jobId, { status: 'processing', stage: 'rendering' });
                return cutMoments(sourcePath, cutJobId, moments, {
                  videoFilter: VERTICAL_9_16_FILTER,
                  requireVertical: true,
                  onClipStart: (index, total) => {
                    emitStatus(logger, `[ClipAgent] Rendering clip ${index + 1}/${total}`);
                  },
                });
              },
              uploadClip: async (...args) => {
                await stateStore.upsert(jobId, { status: 'processing', stage: 'upload' });
                return (options.uploadClip || overrides.uploadClip || require('./supabaseStorageService').uploadClip)(...args);
              },
            }),
        }
      );
      validateA2aClipResult(result, {
        expectedClipCount: purchasedClipCount,
        minDurationSeconds: DEFAULT_MIN_DURATION_SECONDS,
        maxDurationSeconds: DEFAULT_MAX_DURATION_SECONDS,
        sourceDurationSeconds,
      });
      emitStatus(logger, '[ClipAgent] Results uploaded');
      await stateStore.upsert(jobId, {
        status: 'ready_for_delivery',
        stage: 'ready_for_delivery',
        result,
        attachment: null,
        attachmentPath: null,
      });
      deliveryPayload = buildDeliveryPayload({
        jobId,
        providerId,
        serviceId,
        serviceContract,
        purchasedClipCount,
        diagnosticRequestedClipCount: diagnostics.requestedClipCount,
        diagnosticRequestedClipCountSource: diagnostics.requestedClipCountSource,
        quantityNote: diagnostics.quantityNote,
        result,
      });
      await stateStore.upsert(jobId, {
        status: 'ready_for_delivery',
        stage: 'ready_for_delivery',
        result,
        deliveryPayload,
        attachment: null,
        attachmentPath: null,
      });
    } else {
      deliveryPayload = buildDeliveryPayload({
        jobId,
        providerId,
        serviceId,
        serviceContract,
        purchasedClipCount,
        diagnosticRequestedClipCount: diagnostics.requestedClipCount,
        diagnosticRequestedClipCountSource: diagnostics.requestedClipCountSource,
        quantityNote: diagnostics.quantityNote,
        result,
      });
      await stateStore.upsert(jobId, {
        status: 'ready_for_delivery',
        stage: 'ready_for_delivery',
        result,
        deliveryPayload,
        attachment: null,
        attachmentPath: null,
      });
      emitStatus(logger, '[ClipAgent] Results uploaded');
    }

    try {
      const deliveryPayloadChecksum = `sha256:${crypto
        .createHash('sha256')
        .update(JSON.stringify(deliveryPayload))
        .digest('hex')}`;
      await stateStore.upsert(jobId, {
        status: 'ready_for_delivery',
        stage: 'delivery',
        deliveryPayload,
        deliveryPayloadChecksum,
        deliveryAttemptedAt: new Date().toISOString(),
      });
      const alreadySubmitted = resumedDeliveryOnly && await deliveryAlreadySubmitted(
        jobId,
        providerId,
        {
          runCommand: options.runCommand,
          binary: options.deliverBinary || 'onchainos',
          commandOptions: options.deliverCommandOptions || {},
        }
      );
      deliveryResult = alreadySubmitted
        ? { stdout: '{"ok":true,"recoveredExistingDelivery":true}' }
        : await deliverResult(jobId, providerId, deliveryPayload, {
            runCommand: options.runCommand,
            binary: options.deliverBinary || 'onchainos',
            commandOptions: options.deliverCommandOptions || {},
          });
    } catch (error) {
      await stateStore.upsert(jobId, {
        status: 'delivery_failed',
        stage: 'delivery',
        result,
        deliveryPayload,
        deliveryError: {
          code: error.code || null,
          message: error.message,
          statusCode: error.statusCode || null,
        },
        attachment: null,
        attachmentPath: null,
      });
      error.deliveryFailureHandled = true;
      throw error;
    }
    emitStatus(logger, '[ClipAgent] Delivery submitted');
    await stateStore.upsert(jobId, {
      status: 'delivered',
      stage: 'delivered',
      deliveryPayload,
      deliveryResult: typeof deliveryResult?.stdout === 'string' ? deliveryResult.stdout.trim() : null,
      deliveredAt: new Date().toISOString(),
      attachment: null,
      attachmentPath: null,
    });
    emitStatus(logger, '[ClipAgent] Task completed');

    return {
      jobId,
      providerId,
      serviceId,
      purchasedClipCount,
      result,
      deliveryPayload,
      deliveryResult,
      attachmentPath: downloadedPath,
      attachmentSizeBytes: downloadedSize,
      diagnosticRequestedClipCount: diagnostics.requestedClipCount,
      quantityNote: diagnostics.quantityNote,
    };
  } catch (error) {
    if (error.deliveryFailureHandled) {
      throw error;
    }
    const previousState = await stateStore.get(jobId).catch(() => null);
    await stateStore.upsert(jobId, {
      status: error?.code === 'DELIVERY_FAILED' ? 'delivery_failed' : 'failed',
      failureStage:
        downloadTargetStage(error) ||
        (sourceDurationSeconds ? 'processing' : 'attachment_downloading'),
      error: {
        code: error.code || null,
        message: error.message,
        statusCode: error.statusCode || null,
      },
      previousStatus: previousState?.status || null,
      attachment: null,
      attachmentPath: null,
    });
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (cleanupTarget) {
      await cleanupFiles([cleanupTarget], logger);
    }
  }
}

function downloadTargetStage(error) {
  if (!error) return null;
  if (error instanceof A2aTransportError) {
    if (String(error.code || '').startsWith('OKX_ATTACHMENT')) return 'attachment_downloading';
    if (String(error.code || '').startsWith('SOURCE')) return 'attachment_ready';
  }
  return null;
}

module.exports = {
  runOkxA2aJob,
  parseMaybeJson,
  normalizeMessageRecord,
  extractAttachmentMetadata,
  extractInstructionText,
  extractClipPlan,
  isAcceptedJobEvent,
  isAttachmentEvent,
  deliverResult,
  deliveryAlreadySubmitted,
  downloadOfficialAttachment,
  guessMimeType,
  buildDeliveryPayload,
  normalizeOkxA2aJob,
  DEFAULT_CLIP_COUNT,
  DEFAULT_MIN_DURATION_SECONDS,
  DEFAULT_MAX_DURATION_SECONDS,
};
