const express = require('express');
const { MAX_SOURCE_DURATION_SECONDS } = require('../services/durationLimitService');
const { REMOTE_VIDEO_MAX_BYTES } = require('../services/remoteVideoService');

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
        required: ['videoUrl'],
        additionalProperties: false,
        properties: {
        videoUrl: {
          type: 'string',
          format: 'uri',
          pattern: '^https://',
          description: 'A publicly accessible or signed HTTPS video URL.',
        },
        clipCount: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
        instructions: { type: 'string', maxLength: 500 },
        minDuration: { type: 'number', minimum: 20, maximum: 45, default: 20 },
        maxDuration: { type: 'number', minimum: 20, maximum: 45, default: 45 },
      },
    },
    example: {
      videoUrl: 'https://example.com/video.mp4',
      clipCount: 3,
      instructions: 'Find the most engaging moments',
    },
  },
  optionalFields: ['clipCount', 'instructions', 'minDuration', 'maxDuration'],
  defaults: { clipCount: 1, instructions: '', minDuration: 20, maxDuration: 45 },
  limits: {
    maximumRemoteVideoBytes: REMOTE_VIDEO_MAX_BYTES,
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
