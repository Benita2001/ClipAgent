class ProviderTimeoutError extends Error {
  constructor(provider, timeoutMs) {
    super(`${provider} request timed out after ${timeoutMs}ms.`);
    this.name = 'ProviderTimeoutError';
    this.code = 'PROVIDER_TIMEOUT';
    this.statusCode = 504;
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }
}

function readTimeoutMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function fetchWithTimeout(url, options = {}, { provider, timeoutMs, fetchImpl = globalThis.fetch }) {
  const controller = new AbortController();
  const callerSignal = options.signal;
  let timedOut = false;

  const forwardAbort = () => controller.abort(callerSignal.reason);
  if (callerSignal) {
    if (callerSignal.aborted) forwardAbort();
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new ProviderTimeoutError(provider, timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', forwardAbort);
  }
}

function createProviderFetch(provider, timeoutMs, fetchImpl = globalThis.fetch) {
  return (url, options) => fetchWithTimeout(url, options, { provider, timeoutMs, fetchImpl });
}

module.exports = { ProviderTimeoutError, readTimeoutMs, fetchWithTimeout, createProviderFetch };
