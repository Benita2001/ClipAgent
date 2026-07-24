const express = require('express');
const crypto = require('crypto');
const { upload } = require('../services/uploadService');
const { createJob } = require('../services/jobStore');
const { runPipeline } = require('../services/pipelineService');
const {
  checkDurationLimit,
  VideoStreamRequiredError,
} = require('../services/durationLimitService');
const {
  RemoteVideoError,
  validateRemoteVideoUrl,
  downloadRemoteVideo,
} = require('../services/remoteVideoService');
const { redactDiagnostic } = require('../services/jobErrors');
const { cleanupFiles } = require('../utils/fileCleanup');

function sendInputError(res, statusCode, code, message) {
  res.status(statusCode).json({
    success: false,
    error: { code, message },
  });
}

function createClipPrepaymentRouter(overrides = {}) {
  const dependencies = {
    uploadSingle: upload.single('video'),
    validateRemoteVideoUrl,
    cleanupFiles,
    ...overrides,
  };
  const router = express.Router();

  router.use('/clip', express.json({ limit: '32kb' }));
  router.post('/clip', (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      next();
      return;
    }
    dependencies.uploadSingle(req, res, next);
  });

  router.post('/clip', async (req, res, next) => {
    let cleanupStarted = false;
    const cleanupUnownedUpload = async () => {
      if (cleanupStarted || req.clipInputOwnedByPipeline || !req.file) return;
      cleanupStarted = true;
      await dependencies.cleanupFiles([req.file.path]);
    };
    res.once('finish', () => {
      cleanupUnownedUpload().catch((error) => {
        console.error(`[clip] failed to clean an unowned upload: ${redactDiagnostic(error.message)}`);
      });
    });
    req.once('aborted', () => {
      cleanupUnownedUpload().catch((error) => {
        console.error(`[clip] failed to clean an aborted upload: ${redactDiagnostic(error.message)}`);
      });
    });

    const callerId = typeof req.body?.callerId === 'string' ? req.body.callerId.trim() : '';
    if (!callerId) {
      sendInputError(res, 400, 'CALLER_ID_REQUIRED', 'callerId is required.');
      return;
    }

    const suppliedVideoUrl =
      typeof req.body?.videoUrl === 'string' && req.body.videoUrl.trim()
        ? req.body.videoUrl.trim()
        : null;
    if (req.file && suppliedVideoUrl) {
      sendInputError(
        res,
        400,
        'AMBIGUOUS_VIDEO_INPUT',
        'Provide either videoUrl or multipart field "video", not both.'
      );
      return;
    }
    if (!req.file && !suppliedVideoUrl) {
      sendInputError(
        res,
        400,
        'VIDEO_INPUT_REQUIRED',
        'Provide videoUrl in the JSON body or video in multipart field "video".'
      );
      return;
    }

    try {
      if (suppliedVideoUrl) {
        req.clipInput = {
          callerId,
          inputType: 'remote-url',
          videoUrl: await dependencies.validateRemoteVideoUrl(suppliedVideoUrl),
        };
      } else {
        req.clipInput = {
          callerId,
          inputType: 'multipart',
          file: req.file,
        };
      }
      next();
    } catch (error) {
      if (error instanceof RemoteVideoError) {
        sendInputError(res, error.statusCode, error.code, error.message);
        return;
      }
      next(error);
    }
  });

  return router;
}

function createClipRouter(overrides = {}) {
  const dependencies = {
    createJob,
    runPipeline,
    checkDurationLimit,
    downloadRemoteVideo,
    cleanupFiles,
    ...overrides,
  };
  const router = express.Router();

  // GET remains protected for x402 validators, but it is not a valid business
  // operation. A paid GET receives 405, so the SDK does not settle it.
  router.get('/clip', (req, res) => {
    sendInputError(
      res,
      405,
      'METHOD_NOT_ALLOWED',
      'Use POST with a JSON videoUrl or multipart video input.'
    );
  });

  router.post('/clip', async (req, res, next) => {
    const { callerId, inputType, videoUrl } = req.clipInput;
    let file = req.clipInput.file;
    const requestController = new AbortController();
    const abortDownload = () => {
      if (!requestController.signal.aborted) {
        requestController.abort(new DOMException('The client disconnected.', 'AbortError'));
      }
    };
    req.once('aborted', abortDownload);
    res.once('close', () => {
      if (!res.writableEnded) abortDownload();
    });

    if (inputType === 'remote-url') {
      try {
        file = await dependencies.downloadRemoteVideo(videoUrl, { signal: requestController.signal });
      } catch (error) {
        if (error && error.code === 'PROVIDER_TIMEOUT') {
          sendInputError(
            res,
            504,
            'VIDEO_DOWNLOAD_TIMEOUT',
            'The remote video took too long to download.'
          );
          return;
        }
        if (error instanceof RemoteVideoError) {
          sendInputError(res, error.statusCode, error.code, error.message);
          return;
        }
        next(error);
        return;
      }
    }

    try {
      await dependencies.checkDurationLimit(file.path);
    } catch (error) {
      await dependencies.cleanupFiles([file.path]);
      if (error instanceof VideoStreamRequiredError) {
        sendInputError(
          res,
          400,
          'VIDEO_STREAM_REQUIRED',
          'The supplied media does not contain a valid video stream.'
        );
        return;
      }
      const statusCode = error.statusCode || 400;
      sendInputError(
        res,
        statusCode,
        statusCode === 413 ? 'VIDEO_TOO_LONG' : 'VIDEO_VALIDATION_FAILED',
        statusCode === 413
          ? 'The video is longer than the supported processing limit.'
          : 'The video could not be validated.'
      );
      return;
    }

    const jobId = crypto.randomUUID();
    try {
      dependencies.createJob(jobId, {
        callerId,
        inputType,
        file: {
          originalName: file.originalname,
          storedName: file.filename,
          path: file.path,
          size: file.size,
          mimetype: file.mimetype,
        },
      });
    } catch (error) {
      await dependencies.cleanupFiles([file.path]);
      next(error);
      return;
    }
    req.clipInputOwnedByPipeline = true;

    const publicBaseUrl =
      process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const statusUrl = `${publicBaseUrl.replace(/\/+$/, '')}/job/${jobId}`;
    res.status(202).json({
      success: true,
      status: 'processing',
      jobId,
      callerId,
      statusUrl,
    });

    // The existing pipeline owns the local source after the 202 response and
    // guarantees terminal state plus cleanup for multipart and remote inputs.
    dependencies.runPipeline(jobId, file).catch((error) => {
      console.error(
        `Unexpected uncaught error in pipeline for job ${jobId}: ${redactDiagnostic(
          error && (error.stack || error.message)
        )}`
      );
    });
  });

  return router;
}

const router = createClipRouter();
module.exports = router;
module.exports.createClipRouter = createClipRouter;
module.exports.createClipPrepaymentRouter = createClipPrepaymentRouter;
module.exports.sendInputError = sendInputError;
