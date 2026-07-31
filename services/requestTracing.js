const crypto = require('crypto');
const {
  emit,
  elapsedMs,
  traceStage,
  logPipelineFailure,
} = require('./pipelineTracing');

const PAYMENT_HEADERS = ['payment-signature', 'x-payment'];

function hasPaymentHeader(req) {
  return PAYMENT_HEADERS.some((name) => Boolean(req.get(name)));
}

function safeResourceUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

function decodeChallenge(headerValue) {
  if (!headerValue) return null;
  try {
    return JSON.parse(Buffer.from(String(headerValue), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function createClipRequestTracingMiddleware({ logger = console } = {}) {
  return (req, res, next) => {
    if (req.path !== '/clip') {
      next();
      return;
    }

    const trace = {
      requestId: crypto.randomUUID(),
      startedAt: Date.now(),
      logger,
      clientAborted: false,
    };
    req.clipTrace = trace;

    req.once('aborted', () => {
      trace.clientAborted = true;
    });
    res.once('close', () => {
      if (!res.writableEnded) trace.clientAborted = true;
    });
    res.once('finish', () => {
      emit(trace, 'response.released', {
        status: res.statusCode,
        totalElapsedMs: elapsedMs(trace),
        clientAborted: trace.clientAborted,
      });
    });

    emit(trace, 'request.received', {
      method: req.method,
      path: req.path,
      contentType: req.get('content-type') || null,
      contentLength: req.get('content-length') || null,
      userAgent: req.get('user-agent') || null,
      bodyFieldsParsed: false,
      presence: {
        videoUrl: null,
        uploadId: null,
        clipCount: null,
        instructions: null,
        minDuration: null,
        maxDuration: null,
        minDurationSeconds: null,
        maxDurationSeconds: null,
        paymentHeader: hasPaymentHeader(req),
      },
    });
    next();
  };
}

function createTracedHttpServer(httpServer, { logger = console } = {}) {
  const paymentTraces = new WeakMap();

  return {
    requiresPayment: (...args) => httpServer.requiresPayment(...args),
    initialize: (...args) => httpServer.initialize(...args),
    async processHTTPRequest(context, ...args) {
      const trace = context.adapter?.req?.clipTrace;
      const paymentHeaderPresent = Boolean(context.paymentHeader);

      if (paymentHeaderPresent) {
        emit(trace, 'x402.paid_replay_received', {
          paymentHeaderPresent: true,
          elapsedMs: elapsedMs(trace),
        });
        emit(trace, 'x402.verification_started', {
          elapsedMs: elapsedMs(trace),
        });
      }

      const verificationStartedAt = Date.now();
      try {
        const result = await httpServer.processHTTPRequest(context, ...args);
        if (result.type === 'payment-verified') {
          if (result.paymentPayload && typeof result.paymentPayload === 'object') {
            paymentTraces.set(result.paymentPayload, trace);
          }
          emit(trace, 'x402.verification_finished', {
            outcome: 'success',
            elapsedMs: Date.now() - verificationStartedAt,
          });
        } else if (paymentHeaderPresent) {
          emit(trace, 'x402.verification_finished', {
            outcome: 'rejected',
            category: 'payment_error',
            elapsedMs: Date.now() - verificationStartedAt,
          }, 'warn');
        }

        if (result.type === 'payment-error' && result.response?.status === 402) {
          const header =
            result.response.headers?.['PAYMENT-REQUIRED'] ||
            result.response.headers?.['payment-required'];
          const challenge = decodeChallenge(header);
          const accepted = challenge?.accepts?.[0] || {};
          emit(trace, 'x402.challenge_sent', {
            status: 402,
            network: accepted.network || null,
            amount: accepted.amount || null,
            resourceUrl: safeResourceUrl(challenge?.resource?.url) || null,
            maxTimeoutSeconds: accepted.maxTimeoutSeconds || null,
            mimeType: challenge?.resource?.mimeType || null,
          });
        }
        return result;
      } catch (error) {
        if (paymentHeaderPresent) {
          emit(trace, 'x402.verification_finished', {
            outcome: 'error',
            category: 'verification_exception',
            elapsedMs: Date.now() - verificationStartedAt,
          }, 'error');
        }
        throw error;
      }
    },
    async processSettlement(paymentPayload, requirements, extensions, transportContext, overrides) {
      const trace =
        paymentTraces.get(paymentPayload) ||
        transportContext?.request?.adapter?.req?.clipTrace;
      const startedAt = Date.now();
      emit(trace, 'x402.settlement_started', {
        elapsedMs: elapsedMs(trace),
      });
      try {
        const result = await httpServer.processSettlement(
          paymentPayload,
          requirements,
          extensions,
          transportContext,
          overrides
        );
        emit(trace, 'x402.settlement_finished', {
          outcome: result.success ? 'success' : 'failed',
          transactionHash:
            typeof result.transaction === 'string' && result.transaction
              ? result.transaction
              : null,
          elapsedMs: Date.now() - startedAt,
        }, result.success ? 'info' : 'error');
        return result;
      } catch (error) {
        emit(trace, 'x402.settlement_finished', {
          outcome: 'error',
          elapsedMs: Date.now() - startedAt,
        }, 'error');
        throw error;
      }
    },
  };
}

function inputPresence(req) {
  return {
    videoUrl:
      typeof req.body?.videoUrl === 'string' && Boolean(req.body.videoUrl.trim()),
    uploadId:
      typeof req.body?.uploadId === 'string' && Boolean(req.body.uploadId.trim()),
    clipCount: Number.isInteger(req.body?.clipCount),
    instructions: typeof req.body?.instructions === 'string',
    minDuration: Number.isFinite(req.body?.minDuration),
    maxDuration: Number.isFinite(req.body?.maxDuration),
    minDurationSeconds: Number.isFinite(req.body?.minDurationSeconds),
    maxDurationSeconds: Number.isFinite(req.body?.maxDurationSeconds),
  };
}

function logInputValidated(req, inputType) {
  emit(req.clipTrace, 'request.input_validated', {
    inputType,
    presence: inputPresence(req),
    elapsedMs: elapsedMs(req.clipTrace),
  });
}

function logInputRejected(req, code, inputType = 'unknown') {
  emit(req.clipTrace, 'request.input_rejected', {
    safeErrorCode: code,
    inputType,
    presence: inputPresence(req),
    elapsedMs: elapsedMs(req.clipTrace),
  }, 'warn');
}

module.exports = {
  createClipRequestTracingMiddleware,
  createTracedHttpServer,
  emit,
  elapsedMs,
  logInputValidated,
  logInputRejected,
  traceStage,
  logPipelineFailure,
};
