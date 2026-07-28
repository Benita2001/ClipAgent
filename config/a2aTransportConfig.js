const { MAX_SOURCE_DURATION_SECONDS } = require('../services/durationLimitService');
const {
  DEFAULT_OKX_A2A_SERVICE_CLIP_MAP,
  parseOkxA2aServiceClipMap,
} = require('./okxA2aServiceClipMap');

function positiveInteger(value, fallback = null) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function positiveNumber(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function readBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function getA2aTransportConfig(env = process.env) {
  const serviceClipMap = parseOkxA2aServiceClipMap(
    env.OKX_A2A_SERVICE_CLIP_MAP,
    { fallback: DEFAULT_OKX_A2A_SERVICE_CLIP_MAP }
  );
  return {
    okxAttachmentMaxBytes:
      positiveInteger(env.OKX_ATTACHMENT_MAX_BYTES, 104_857_600),
    maxSourceBytes: positiveInteger(env.CLIPAGENT_MAX_SOURCE_BYTES),
    maxDurationSeconds:
      positiveNumber(env.CLIPAGENT_MAX_DURATION_SECONDS, MAX_SOURCE_DURATION_SECONDS),
    signedUrlTtlSeconds:
      positiveInteger(env.SOURCE_SIGNED_URL_TTL_SECONDS, 3_600),
    sourceRetentionSeconds:
      positiveInteger(env.SOURCE_RETENTION_SECONDS, 86_400),
    requiredFreeSpaceMultiplier:
      positiveNumber(env.RENDER_REQUIRED_FREE_SPACE_MULTIPLIER, 3),
    largeVideoUploadsEnabled:
      readBoolean(env.LARGE_VIDEO_UPLOADS_ENABLED, false),
    sourceBucket: env.SUPABASE_SOURCE_BUCKET || 'clipagent-sources',
    serviceClipMap,
  };
}

module.exports = { getA2aTransportConfig, positiveInteger, positiveNumber, readBoolean };
