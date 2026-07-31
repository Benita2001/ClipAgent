class OkxA2aServiceClipMapError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OkxA2aServiceClipMapError';
    this.code = code;
    this.statusCode = 503;
  }
}

function normalizeServiceId(rawServiceId) {
  const numeric = Number(rawServiceId);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new OkxA2aServiceClipMapError(
      'INVALID_A2A_SERVICE_ID',
      `Invalid OKX A2A service ID "${rawServiceId}". Service IDs must be positive integers.`
    );
  }
  return numeric;
}

function normalizeClipCount(rawClipCount, serviceId) {
  const numeric = Number(rawClipCount);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 3) {
    throw new OkxA2aServiceClipMapError(
      'INVALID_A2A_SERVICE_CLIP_COUNT',
      `Service ${serviceId} must map to 1, 2, or 3 finished clips.`
    );
  }
  return numeric;
}

function parseOkxA2aServiceClipMap(rawValue, { fallback } = {}) {
  if (
    (rawValue === undefined || rawValue === null || rawValue === '') &&
    fallback === undefined
  ) {
    throw new OkxA2aServiceClipMapError(
      'A2A_SERVICE_CLIP_MAP_REQUIRED',
      'OKX_A2A_SERVICE_CLIP_MAP is required.'
    );
  }
  const candidate = rawValue === undefined || rawValue === null || rawValue === ''
    ? fallback
    : rawValue;
  let parsed = candidate;
  if (typeof candidate === 'string') {
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      throw new OkxA2aServiceClipMapError(
        'INVALID_A2A_SERVICE_CLIP_MAP',
        'OKX_A2A_SERVICE_CLIP_MAP must be valid JSON.'
      );
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OkxA2aServiceClipMapError(
      'INVALID_A2A_SERVICE_CLIP_MAP',
      'OKX_A2A_SERVICE_CLIP_MAP must be a JSON object whose keys are service IDs.'
    );
  }

  const map = new Map();
  for (const [rawServiceId, rawClipCount] of Object.entries(parsed)) {
    const serviceId = normalizeServiceId(rawServiceId);
    const clipCount = normalizeClipCount(rawClipCount, serviceId);
    map.set(serviceId, clipCount);
  }

  if (!map.size) {
    throw new OkxA2aServiceClipMapError(
      'INVALID_A2A_SERVICE_CLIP_MAP',
      'OKX_A2A_SERVICE_CLIP_MAP must define at least one service mapping.'
    );
  }

  return map;
}

function resolveServiceClipCount(serviceClipMap, serviceId) {
  const numericServiceId = normalizeServiceId(serviceId);
  if (!serviceClipMap) return null;
  if (serviceClipMap instanceof Map) {
    return serviceClipMap.has(numericServiceId) ? serviceClipMap.get(numericServiceId) : null;
  }
  if (typeof serviceClipMap === 'object') {
    return Object.prototype.hasOwnProperty.call(serviceClipMap, numericServiceId)
      ? normalizeClipCount(serviceClipMap[numericServiceId], numericServiceId)
      : null;
  }
  return null;
}

module.exports = {
  OkxA2aServiceClipMapError,
  parseOkxA2aServiceClipMap,
  resolveServiceClipCount,
  normalizeServiceId,
  normalizeClipCount,
};
