const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;
const SAFE_INITIALIZATION_ERROR = 'Facilitator initialization failed';

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function isApparentPermanentError(error) {
  const message = String(error && error.message ? error.message : error).toLowerCase();
  return [
    '401',
    '403',
    'api key',
    'apikey',
    'access-key',
    'credential',
    'passphrase',
    'signature',
    'unauthorized',
    'forbidden',
    'authentication',
    'configuration',
    'missing required',
  ].some((marker) => message.includes(marker));
}

function redactMessage(error, secrets) {
  let message = String(error && error.message ? error.message : error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[REDACTED]');
  }
  return message;
}

function createX402Initializer({
  initialize,
  retryBaseMs = readPositiveInteger(process.env.X402_INIT_RETRY_BASE_MS, DEFAULT_RETRY_BASE_MS),
  retryMaxMs = readPositiveInteger(process.env.X402_INIT_RETRY_MAX_MS, DEFAULT_RETRY_MAX_MS),
  schedule = setTimeout,
  now = () => new Date(),
  random = Math.random,
  logger = console,
  secrets = [process.env.OKX_API_KEY, process.env.OKX_SECRET_KEY, process.env.OKX_PASSPHRASE],
} = {}) {
  if (typeof initialize !== 'function') {
    throw new TypeError('initialize must be a function');
  }

  const baseDelayMs = Math.min(readPositiveInteger(retryBaseMs, DEFAULT_RETRY_BASE_MS), readPositiveInteger(retryMaxMs, DEFAULT_RETRY_MAX_MS));
  const maxDelayMs = Math.max(readPositiveInteger(retryMaxMs, DEFAULT_RETRY_MAX_MS), baseDelayMs);

  const state = {
    status: 'initializing',
    attempts: 0,
    lastSuccessfulInitializationAt: null,
    lastError: null,
    nextRetryAt: null,
  };

  let started = false;
  let currentAttempt = null;
  let retryTimer = null;

  function getState() {
    return { ...state };
  }

  function calculateRetryDelay(attempt, permanent) {
    if (permanent) return maxDelayMs;
    const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
    const jitterMultiplier = 0.8 + random() * 0.4;
    return Math.min(maxDelayMs, Math.max(1, Math.round(exponentialDelay * jitterMultiplier)));
  }

  async function runAttempt() {
    state.status = 'initializing';
    state.attempts += 1;
    state.nextRetryAt = null;
    const attempt = state.attempts;
    logger.info(`[x402] facilitator initialization attempt ${attempt}`);

    try {
      await initialize();
      state.status = 'ready';
      state.lastSuccessfulInitializationAt = now().toISOString();
      state.lastError = null;
      state.nextRetryAt = null;
      logger.info(`[x402] facilitator initialized successfully on attempt ${attempt}`);
    } catch (error) {
      const permanent = isApparentPermanentError(error);
      const delayMs = calculateRetryDelay(attempt, permanent);
      const retryAt = new Date(now().getTime() + delayMs);

      state.status = 'failed';
      state.lastError = SAFE_INITIALIZATION_ERROR;
      state.nextRetryAt = retryAt.toISOString();

      const classification = permanent ? 'apparent permanent error' : 'transient error';
      logger.error(
        `[x402] facilitator initialization failed on attempt ${attempt} (${classification}): ${redactMessage(error, secrets)}; ` +
          `retrying in ${delayMs}ms`
      );

      retryTimer = schedule(() => {
        retryTimer = null;
        currentAttempt = runAttempt();
      }, delayMs);
      if (retryTimer && typeof retryTimer.unref === 'function') retryTimer.unref();
    }
  }

  function start() {
    if (!started) {
      started = true;
      currentAttempt = runAttempt();
    }
    return currentAttempt;
  }

  function stop() {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  }

  return { getState, start, stop };
}

module.exports = {
  createX402Initializer,
  isApparentPermanentError,
  SAFE_INITIALIZATION_ERROR,
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_MAX_MS,
};
