const crypto = require('crypto');
const express = require('express');
const { processClip } = require('../services/pipelineService');
const { rankMoments } = require('../services/rankingService');
const { takePreparedUpload } = require('../services/preparedUploadService');
const { downloadRemoteVideo } = require('../services/remoteVideoService');
const { checkDurationLimit } = require('../services/durationLimitService');
const { getMarketplacePolicy, withMarketplaceTimeout } = require('../services/marketplacePolicy');
const {
  CLIP_PRICE_USDT,
  DEFAULT_MIN_DURATION_SECONDS,
  DEFAULT_MAX_DURATION_SECONDS,
  coerceRequestedClipCount,
  normalizeDurationBounds,
  formatClipPrice,
} = require('../services/clipPricing');
const { cleanupFiles } = require('../utils/fileCleanup');
const {
  logInputValidated,
  logInputRejected,
  logPipelineFailure,
  emit,
  elapsedMs,
} = require('../services/requestTracing');
const {
  ClientDisconnectedError,
  createClipRequestLifecycle,
} = require('../services/clipRequestLifecycle');
const { constrainRankedMoments } = require('../services/clipMomentConstraints');

const ALLOWED_CLIP_FIELDS = new Set([
  'videoUrl',
  'uploadId',
  'clipCount',
  'instructions',
  'minDuration',
  'maxDuration',
  'minDurationSeconds',
  'maxDurationSeconds',
]);

function normalizeClipInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = Object.keys(body);
  if (fields.some((field) => !ALLOWED_CLIP_FIELDS.has(field))) return null;

  const videoUrl = typeof body.videoUrl === 'string' ? body.videoUrl.trim() : '';
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';
  if (videoUrl && uploadId) return null;

  const { clipCount, tooMany } = coerceRequestedClipCount(body.clipCount);
  if (tooMany) return { error: 'CLIP_COUNT_TOO_LARGE' };

  const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
  if (instructions.length > 500) return null;

  const durationBounds = normalizeDurationBounds(
    body.minDurationSeconds ?? body.minDuration,
    body.maxDurationSeconds ?? body.maxDuration,
    {
      defaultMin: DEFAULT_MIN_DURATION_SECONDS,
      defaultMax: DEFAULT_MAX_DURATION_SECONDS,
    }
  );
  if (durationBounds.invalid) return null;

  return {
    videoUrl,
    uploadId,
    clipCount,
    instructions,
    minDurationSeconds: durationBounds.minDurationSeconds,
    maxDurationSeconds: durationBounds.maxDurationSeconds,
  };
}

function sendInputError(res, statusCode, code, message) {
  const lifecycle = res.req?.clipLifecycle;
  if (lifecycle && !lifecycle.state.responseSelected) {
    lifecycle.selectResponse(statusCode);
  }
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      requestId: res.req?.clipTrace?.requestId || null,
    },
  });
}

function respondClientDisconnected(res, lifecycle) {
  if (lifecycle.state.responseSelected) return;
  const blockedStage = lifecycle.state.currentStage;
  lifecycle.setStage('responding', { allowDisconnected: true });
  emit(res.req?.clipTrace, 'clip_success_blocked_disconnected', {
    currentStage: blockedStage,
    disconnectSource: lifecycle.state.disconnectSource,
    elapsedMs: elapsedMs(res.req?.clipTrace),
    willSettle: false,
  }, 'warn');
  emit(res.req?.clipTrace, 'clip_settlement_safe_failure', {
    status: 503,
    safeErrorCode: 'CLIENT_DISCONNECTED',
    elapsedMs: elapsedMs(res.req?.clipTrace),
    willSettle: false,
  }, 'warn');
  lifecycle.selectResponse(503);
  sendInputError(
    res,
    503,
    'CLIENT_DISCONNECTED',
    'The requesting client disconnected before processing completed.'
  );
}

function parseClipInput(body) {
  const normalized = normalizeClipInput(body);
  if (!normalized) return null;
  if (normalized.error === 'CLIP_COUNT_TOO_LARGE') return null;

  if (normalized.videoUrl) {
    if (normalized.videoUrl.length > 4096) return null;
    return {
      inputType: 'remote-url',
      videoUrl: normalized.videoUrl,
      clipCount: normalized.clipCount,
      instructions: normalized.instructions,
      minDurationSeconds: normalized.minDurationSeconds,
      maxDurationSeconds: normalized.maxDurationSeconds,
    };
  }

  if (!normalized.uploadId) return null;

  return {
    inputType: 'prepared-upload',
    uploadId: normalized.uploadId,
    clipCount: normalized.clipCount,
    minDurationSeconds: normalized.minDurationSeconds,
    maxDurationSeconds: normalized.maxDurationSeconds,
  };
}

function createClipPrepaymentRouter() {
  const router = express.Router();
  router.post('/clip', (req, res, next) => {
    if (!req.is('application/json')) {
      logInputRejected(req, 'JSON_REQUIRED', 'non-json');
      sendInputError(
        res,
        415,
        'JSON_REQUIRED',
        'POST /clip accepts application/json only.'
      );
      return;
    }

    const input = parseClipInput(req.body);
    if (!input) {
      logInputRejected(req, 'INVALID_CLIP_PARAMETERS', 'json');
      sendInputError(
        res,
        400,
        'INVALID_CLIP_PARAMETERS',
        'Provide videoUrl or uploadId, optional clipCount (1-3), instructions, minDuration, and maxDuration (20-45).'
      );
      return;
    }

    req.clipInput = input;
    logInputValidated(req, input.inputType);
    next();
  });
  return router;
}

async function cleanupPreparedFile(file, lifecycle, cleanup, logger = console) {
  if (!file) return null;
  lifecycle.enterCleanup();
  try {
    await cleanup([file.path]);
    lifecycle.cleanupCompleted();
    return null;
  } catch (error) {
    lifecycle.cleanupFailed();
    logger.error(`[clip] failed to clean temporary source: ${error.message}`);
    return error;
  }
}

function createClipRouter(overrides = {}) {
  const dependencies = {
    processClip,
    rankMoments,
    takePreparedUpload,
    downloadRemoteVideo,
    checkDurationLimit,
    cleanupFiles,
    getMarketplacePolicy,
    withMarketplaceTimeout,
    logger: console,
    ...overrides,
  };
  const router = express.Router();

  router.get('/clip', (req, res) => {
    sendInputError(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST with application/json.');
  });

  router.post('/clip', async (req, res) => {
    const lifecycle = createClipRequestLifecycle(req, res);
    req.clipLifecycle = lifecycle;
    let sourceFile;
    let sourceDurationSeconds;
    let pipelineOwnsFile = false;

    try {
      const policy = dependencies.getMarketplacePolicy();
      if (req.clipInput.inputType === 'remote-url') {
        lifecycle.assertCanStartStage('downloading');
        sourceFile = await dependencies.downloadRemoteVideo(req.clipInput.videoUrl);
        lifecycle.assertCanStartStage('probing');
        const metadata = await dependencies.checkDurationLimit(sourceFile.path);
        sourceDurationSeconds = metadata.durationSeconds;
      } else {
        const prepared = await dependencies.takePreparedUpload(req.clipInput.uploadId, {
          cleanup: dependencies.cleanupFiles,
        });
        if (!prepared) {
          sendInputError(
            res,
            404,
            'UPLOAD_NOT_FOUND',
            'The prepared upload does not exist, has expired, or was already used.'
          );
          return;
        }
        sourceFile = prepared.file;
        sourceDurationSeconds = prepared.durationSeconds;
      }

      if (sourceDurationSeconds > policy.maxVideoDurationSeconds) {
        const error = new Error('The prepared upload exceeds the marketplace duration limit.');
        error.statusCode = 413;
        error.code = 'MARKETPLACE_VIDEO_TOO_LONG';
        throw error;
      }

      lifecycle.assertConnected('audio extraction');
      pipelineOwnsFile = true;
      const jobId = crypto.randomUUID();
      const result = await dependencies.withMarketplaceTimeout(
        policy.processingTimeoutMs,
        () => dependencies.processClip(jobId, sourceFile, {
          trace: req.clipTrace,
          lifecycle,
          rankMoments: async (segments) =>
            constrainRankedMoments(
              await dependencies.rankMoments(segments, {
                instructions: req.clipInput.instructions || '',
                clipCount: req.clipInput.clipCount,
              }),
              req.clipInput,
              sourceDurationSeconds
            ),
        })
      );

      lifecycle.assertCanStartStage('responding');
      lifecycle.assertConnected('success response');
      lifecycle.connectedCompleted();
      lifecycle.selectResponse(200);
      const requestedClipCount = req.clipInput.clipCount;
      const generatedClipCount = result.clips.length;
      const pricePerClip = CLIP_PRICE_USDT.toFixed(1);
      const totalAmountPaid = formatClipPrice(requestedClipCount);
      res.status(200).json({
        success: true,
        requestedClipCount,
        generatedClipCount,
        pricePerClip,
        totalAmountPaid,
        clips: result.clips.map((clip) => ({
          url: clip.supabase.publicUrl,
          startSeconds: clip.requestedStartSeconds,
          endSeconds: clip.requestedEndSeconds,
          durationSeconds: clip.actualDurationSeconds,
          selectionReason: clip.reason,
        })),
      });
    } catch (error) {
      if (error instanceof ClientDisconnectedError) {
        if (!pipelineOwnsFile) {
          await cleanupPreparedFile(
            sourceFile,
            lifecycle,
            dependencies.cleanupFiles,
            dependencies.logger
          );
        }
        respondClientDisconnected(res, lifecycle);
        return;
      }

      if (!pipelineOwnsFile) {
        const cleanupError = await cleanupPreparedFile(
          sourceFile,
          lifecycle,
          dependencies.cleanupFiles,
          dependencies.logger
        );
        if (cleanupError) {
          sendInputError(
            res,
            500,
            'CLEANUP_FAILED',
            'Temporary media could not be cleaned safely.'
          );
          return;
        }
      }

      const failure = error.pipelineFailure;
      const isTimeout = error.code === 'PROVIDER_TIMEOUT';
      logPipelineFailure(req.clipTrace, {
        code: isTimeout
          ? 'PROCESSING_TIMEOUT'
          : failure?.publicError?.code || error.code || 'PROCESSING_FAILED',
        stage: isTimeout ? 'marketplace processing' : 'processing',
        timeout: isTimeout,
      });
      sendInputError(
        res,
        error.statusCode || 500,
        isTimeout
          ? 'PROCESSING_TIMEOUT'
          : failure?.publicError?.code || error.code || 'PROCESSING_FAILED',
        isTimeout
          ? 'The video could not be completed within the marketplace processing limit.'
          : failure?.publicError?.message || 'The video could not be processed.'
      );
    }
  });

  return router;
}

const router = createClipRouter();
module.exports = router;
module.exports.createClipRouter = createClipRouter;
module.exports.createClipPrepaymentRouter = createClipPrepaymentRouter;
module.exports.parseClipInput = parseClipInput;
module.exports.constrainRankedMoments = constrainRankedMoments;
module.exports.sendInputError = sendInputError;
module.exports.respondClientDisconnected = respondClientDisconnected;
