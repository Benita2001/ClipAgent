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

function callerAbortReason(signal) {
  if (signal && signal.reason !== undefined) return signal.reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

function createTimeoutContext(provider, timeoutMs, callerSignal, timerApi = {}) {
  const setTimer = timerApi.setTimeout || setTimeout;
  const clearTimer = timerApi.clearTimeout || clearTimeout;
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  let finished = false;

  const forwardAbort = () => {
    callerAborted = true;
    controller.abort(callerAbortReason(callerSignal));
  };
  if (callerSignal) {
    if (callerSignal.aborted) forwardAbort();
    else callerSignal.addEventListener('abort', forwardAbort, { once: true });
  }

  const timer = setTimer(() => {
    if (finished || controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new ProviderTimeoutError(provider, timeoutMs));
  }, timeoutMs);

  function finish() {
    if (finished) return;
    finished = true;
    clearTimer(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', forwardAbort);
  }

  function normalizeError(error) {
    if (timedOut) return new ProviderTimeoutError(provider, timeoutMs);
    if (callerAborted) return callerAbortReason(callerSignal);
    return error;
  }

  return { signal: controller.signal, finish, normalizeError };
}

async function withProviderTimeout(provider, timeoutMs, operation, { signal, timerApi } = {}) {
  const context = createTimeoutContext(provider, timeoutMs, signal, timerApi);
  try {
    return await operation({ signal: context.signal });
  } catch (error) {
    throw context.normalizeError(error);
  } finally {
    context.finish();
  }
}

function wrapResponseBody(response, context) {
  if (!response.body) {
    context.finish();
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(streamController) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          context.finish();
          streamController.close();
          return;
        }
        streamController.enqueue(value);
      } catch (error) {
        context.finish();
        streamController.error(context.normalizeError(error));
      }
    },
    async cancel(reason) {
      context.finish();
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function createProviderFetch(provider, timeoutMs, fetchImpl = globalThis.fetch, timerApi) {
  return async (url, options = {}) => {
    const context = createTimeoutContext(provider, timeoutMs, options.signal, timerApi);
    try {
      const response = await fetchImpl(url, { ...options, signal: context.signal });
      return wrapResponseBody(response, context);
    } catch (error) {
      context.finish();
      throw context.normalizeError(error);
    }
  };
}

module.exports = {
  ProviderTimeoutError,
  readTimeoutMs,
  withProviderTimeout,
  createProviderFetch,
};
