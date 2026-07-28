const CLIP_PRICE_USDT = 0.5;
const DEFAULT_REQUESTED_CLIP_COUNT = 1;
const MAX_REQUESTED_CLIP_COUNT = 3;
const DEFAULT_MIN_DURATION_SECONDS = 20;
const DEFAULT_MAX_DURATION_SECONDS = 45;

function coerceRequestedClipCount(value, { fallback = DEFAULT_REQUESTED_CLIP_COUNT } = {}) {
  const numeric = Number(value);
  if (
    value === undefined ||
    value === null ||
    value === '' ||
    !Number.isFinite(numeric) ||
    !Number.isInteger(numeric) ||
    numeric < 1
  ) {
    return { clipCount: fallback, invalid: true, tooMany: false };
  }
  if (numeric > MAX_REQUESTED_CLIP_COUNT) {
    return { clipCount: numeric, invalid: false, tooMany: true };
  }
  return { clipCount: numeric, invalid: false, tooMany: false };
}

function resolveRequestedClipCount(value, fallback = DEFAULT_REQUESTED_CLIP_COUNT) {
  return coerceRequestedClipCount(value, { fallback }).clipCount;
}

function formatClipPrice(clipCount) {
  const numeric = Number(clipCount);
  if (!Number.isFinite(numeric) || numeric < 1) {
    return CLIP_PRICE_USDT.toFixed(1);
  }
  return (numeric * CLIP_PRICE_USDT).toFixed(1);
}

function normalizeDurationBounds(rawMin, rawMax, {
  defaultMin = DEFAULT_MIN_DURATION_SECONDS,
  defaultMax = DEFAULT_MAX_DURATION_SECONDS,
} = {}) {
  const minNumeric = Number(rawMin);
  const maxNumeric = Number(rawMax);
  const minDurationSeconds = Number.isFinite(minNumeric)
    ? Math.min(Math.max(minNumeric, defaultMin), defaultMax)
    : defaultMin;
  const maxDurationSeconds = Number.isFinite(maxNumeric)
    ? Math.min(Math.max(maxNumeric, defaultMin), defaultMax)
    : defaultMax;

  if (minDurationSeconds > maxDurationSeconds) {
    return {
      minDurationSeconds: defaultMin,
      maxDurationSeconds: defaultMax,
      invalid: true,
    };
  }

  return {
    minDurationSeconds,
    maxDurationSeconds,
    invalid: false,
  };
}

module.exports = {
  CLIP_PRICE_USDT,
  DEFAULT_REQUESTED_CLIP_COUNT,
  MAX_REQUESTED_CLIP_COUNT,
  DEFAULT_MIN_DURATION_SECONDS,
  DEFAULT_MAX_DURATION_SECONDS,
  coerceRequestedClipCount,
  resolveRequestedClipCount,
  formatClipPrice,
  normalizeDurationBounds,
};
