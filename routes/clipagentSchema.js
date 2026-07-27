const express = require('express');
const { MAX_SOURCE_DURATION_SECONDS } = require('../services/durationLimitService');
const { PREPARATION_MAX_UPLOAD_BYTES } = require('../services/uploadService');

const router = express.Router();

const schemaDocument = Object.freeze({
  service: 'ClipAgent',
  endpoint: '/clip',
  method: 'POST',
  payment: {
    initialResponse: 402,
    replay: 'Replay the same request with the payment header specified by the challenge.',
    successResponse: 200,
  },
  json: {
    contentType: 'application/json',
    schema: {
      type: 'object',
      required: ['uploadId', 'clipCount', 'minDurationSeconds', 'maxDurationSeconds'],
      properties: {
        uploadId: {
          type: 'string',
          minLength: 1,
          description: 'Opaque identifier returned by POST /uploads.',
        },
        clipCount: { type: 'integer', enum: [1, 2] },
        minDurationSeconds: { type: 'number', minimum: 20, maximum: 60 },
        maxDurationSeconds: { type: 'number', minimum: 20, maximum: 60 },
      },
    },
    example: {
      uploadId: 'prepared-upload-id',
      clipCount: 1,
      minDurationSeconds: 20,
      maxDurationSeconds: 30,
    },
  },
  preparation: {
    endpoint: '/uploads',
    method: 'POST',
    contentType: 'multipart/form-data',
    requiredField: 'video',
    payment: false,
  },
  optionalFields: [],
  defaults: {},
  limits: {
    maximumPreparationUploadBytes: PREPARATION_MAX_UPLOAD_BYTES,
    maximumSourceDurationSeconds: MAX_SOURCE_DURATION_SECONDS,
  },
  response: {
    synchronous: true,
    description: 'A successful paid request returns completed clip URLs and metadata in HTTP 200.',
  },
});

router.get('/.well-known/clipagent', (req, res) => {
  res.status(200).json(schemaDocument);
});

module.exports = router;
module.exports.schemaDocument = schemaDocument;
