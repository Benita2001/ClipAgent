const express = require('express');
const { preparationUpload } = require('../services/uploadService');
const { checkDurationLimit, VideoStreamRequiredError } = require('../services/durationLimitService');
const { createPreparedUpload } = require('../services/preparedUploadService');
const { cleanupFiles } = require('../utils/fileCleanup');

function createUploadsRouter(overrides = {}) {
  const dependencies = {
    uploadSingle: preparationUpload.single('video'),
    checkDurationLimit,
    createPreparedUpload,
    cleanupFiles,
    ...overrides,
  };
  const router = express.Router();

  router.post('/uploads', (req, res, next) => {
    dependencies.uploadSingle(req, res, async (error) => {
      if (error) {
        if (req.file?.path) await dependencies.cleanupFiles([req.file.path]);
        next(error);
        return;
      }
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: { code: 'VIDEO_REQUIRED', message: 'Multipart field "video" is required.' },
        });
        return;
      }

      try {
        const media = await dependencies.checkDurationLimit(req.file.path);
        const prepared = dependencies.createPreparedUpload(req.file, media);
        res.status(201).json({
          uploadId: prepared.uploadId,
          filename: req.file.originalname,
          durationSeconds: prepared.durationSeconds,
          expiresAt: prepared.expiresAt,
        });
      } catch (probeError) {
        await dependencies.cleanupFiles([req.file.path]);
        if (probeError instanceof VideoStreamRequiredError) {
          res.status(400).json({
            success: false,
            error: {
              code: 'VIDEO_STREAM_REQUIRED',
              message: 'The supplied media does not contain a valid video stream.',
            },
          });
          return;
        }
        next(probeError);
      }
    });
  });

  return router;
}

module.exports = createUploadsRouter();
module.exports.createUploadsRouter = createUploadsRouter;
