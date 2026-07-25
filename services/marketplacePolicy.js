const { readTimeoutMs, ProviderTimeoutError } = require('../utils/providerTimeout');

function readRequiredPositiveNumber(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const error = new Error(`${name} must be configured as a positive number.`);
    error.code = 'MARKETPLACE_POLICY_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  return parsed;
}

function getMarketplacePolicy(env = process.env) {
  const processingTimeoutSeconds = readRequiredPositiveNumber(
    'MARKETPLACE_PROCESSING_TIMEOUT_SECONDS',
    env.MARKETPLACE_PROCESSING_TIMEOUT_SECONDS
  );
  const x402MaxTimeoutSeconds = Number(env.X402_MAX_TIMEOUT_SECONDS) || 60;
  if (processingTimeoutSeconds >= x402MaxTimeoutSeconds) {
    const error = new Error(
      'MARKETPLACE_PROCESSING_TIMEOUT_SECONDS must be less than X402_MAX_TIMEOUT_SECONDS.'
    );
    error.code = 'MARKETPLACE_POLICY_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  return {
    maxVideoDurationSeconds: readRequiredPositiveNumber(
      'MARKETPLACE_MAX_VIDEO_DURATION_SECONDS',
      env.MARKETPLACE_MAX_VIDEO_DURATION_SECONDS
    ),
    processingTimeoutMs: processingTimeoutSeconds * 1000,
  };
}

async function withMarketplaceTimeout(timeoutMs, operation, timerApi = {}) {
  const setTimer = timerApi.setTimeout || setTimeout;
  const clearTimer = timerApi.clearTimeout || clearTimeout;
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((resolve, reject) => {
        timer = setTimer(
          () => reject(new ProviderTimeoutError('Marketplace processing', timeoutMs)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimer(timer);
  }
}

module.exports = { getMarketplacePolicy, withMarketplaceTimeout };
