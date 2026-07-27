const express = require('express');
const { REMOTE_VIDEO_MAX_BYTES } = require('../services/remoteVideoService');
const { MAX_SOURCE_DURATION_SECONDS } = require('../services/durationLimitService');
const { MAX_UPLOAD_BYTES } = require('../services/uploadService');

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
      required: ['callerId', 'videoUrl'],
      properties: {
        callerId: {
          type: 'string',
          minLength: 1,
          description: 'A unique caller or request identifier.',
        },
        videoUrl: {
          type: 'string',
          format: 'uri',
          pattern: '^https://',
          description: 'A directly downloadable public HTTPS video URL.',
        },
      },
    },
    example: {
      callerId: 'unique-caller-or-request-id',
      videoUrl: 'https://example.com/video.mp4',
    },
  },
  multipart: {
    contentType: 'multipart/form-data',
    requiredFields: {
      callerId: 'Non-empty string.',
      video: 'Video file field.',
    },
  },
  optionalFields: [],
  defaults: {},
  limits: {
    maximumRemoteSourceBytes: REMOTE_VIDEO_MAX_BYTES,
    maximumMultipartSourceBytes: MAX_UPLOAD_BYTES,
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
