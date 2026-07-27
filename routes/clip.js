const crypto = require('crypto');
const express = require('express');
const { processClip } = require('../services/pipelineService');
const { rankMoments } = require('../services/rankingService');
const { takePreparedUpload } = require('../services/preparedUploadService');
const { getMarketplacePolicy, withMarketplaceTimeout } = require('../services/marketplacePolicy');
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

const ALLOWED_CLIP_FIELDS = new Set([
  'uploadId',
  'clipCount',
  'minDurationSeconds',
  'maxDurationSeconds',
]);

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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = Object.keys(body);
  if (fields.some((field) => !ALLOWED_CLIP_FIELDS.has(field))) return null;

  const uploadId = typeof body.uploadId === 'string' ? body.uploadId.trim() : '';
  const { clipCount, minDurationSeconds, maxDurationSeconds } = body;
  if (
    !uploadId ||
    !Number.isInteger(clipCount) ||
    clipCount < 1 ||
    clipCount > 2 ||
    !Number.isFinite(minDurationSeconds) ||
    !Number.isFinite(maxDurationSeconds) ||
    minDurationSeconds < 20 ||
    maxDurationSeconds > 60 ||
    minDurationSeconds > maxDurationSeconds
  ) {
    return null;
  }

  return {
    inputType: 'prepared-upload',
    uploadId,
    clipCount,
    minDurationSeconds,
    maxDurationSeconds,
  };
}

function createClipPrepaymentRouter() {
  const router = express.Router();
  router.use('/clip', express.json({ limit: '8kb' }));
  router.post('/clip', (req, res, next) => {
    if (!req.is('application/json')) {
      logInputRejected(req, 'JSON_REQUIRED', 'non-json');
      sendInputError(
        res,
        415,
        'JSON_REQUIRED',
        'POST /clip accepts application/json only. Upload video bytes to POST /uploads first.'
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
        'Provide only uploadId, clipCount (1-2), minDurationSeconds, and maxDurationSeconds (20-60).'
      );
      return;
    }

    req.clipInput = input;
    logInputValidated(req, input.inputType);
    next();
  });
  return router;
}

function constrainRankedMoments(ranked, input, sourceDurationSeconds) {
  const moments = ranked.moments.slice(0, input.clipCount).map((moment) => {
    const minimumEnd = moment.start_time + input.minDurationSeconds;
    const maximumEnd = moment.start_time + input.maxDurationSeconds;
    return {
      ...moment,
      end_time: Math.min(
        Math.max(moment.end_time, minimumEnd),
        maximumEnd,
        sourceDurationSeconds
      ),
    };
  });
  if (
    moments.length !== input.clipCount ||
    moments.some(
      (moment) => moment.end_time - moment.start_time < input.minDurationSeconds
    )
  ) {
    const error = new Error('Ranking did not produce moments matching the requested duration.');
    error.statusCode = 422;
    error.code = 'NO_MATCHING_CLIPS';
    throw error;
  }
  return { ...ranked, moments };
}

async function cleanupPreparedFile(file, lifecycle, cleanup, logger = console) {
  if (!file) return;
  lifecycle.enterCleanup();
  try {
    await cleanup([file.path]);
    lifecycle.cleanupCompleted();
  } catch (error) {
    lifecycle.cleanupFailed();
    logger.error(`[clip] failed to clean prepared upload: ${error.message}`);
  }
}

function createClipRouter(overrides = {}) {
  const dependencies = {
    processClip,
    rankMoments,
    takePreparedUpload,
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
    let preparedFile;
    let pipelineOwnsFile = false;

    try {
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

      preparedFile = prepared.file;
      const policy = dependencies.getMarketplacePolicy();
      if (prepared.durationSeconds > policy.maxVideoDurationSeconds) {
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
        () => dependencies.processClip(jobId, prepared.file, {
          trace: req.clipTrace,
          lifecycle,
          rankMoments: async (segments) =>
            constrainRankedMoments(
              await dependencies.rankMoments(segments),
              req.clipInput,
              prepared.durationSeconds
            ),
        })
      );

      lifecycle.assertCanStartStage('responding');
      lifecycle.assertConnected('success response');
      lifecycle.connectedCompleted();
      lifecycle.selectResponse(200);
      res.status(200).json({
        success: true,
        clips: result.clips.map((clip) => ({
          url: clip.supabase.publicUrl,
          startSeconds: clip.requestedStartSeconds,
          endSeconds: clip.requestedEndSeconds,
          durationSeconds: clip.actualDurationSeconds,
        })),
      });
    } catch (error) {
      if (error instanceof ClientDisconnectedError) {
        if (!pipelineOwnsFile) {
          await cleanupPreparedFile(
            preparedFile,
            lifecycle,
            dependencies.cleanupFiles,
            dependencies.logger
          );
        }
        respondClientDisconnected(res, lifecycle);
        return;
      }

      if (!pipelineOwnsFile) {
        await cleanupPreparedFile(
          preparedFile,
          lifecycle,
          dependencies.cleanupFiles,
          dependencies.logger
        );
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
