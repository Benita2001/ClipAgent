const { emit, elapsedMs } = require('./requestTracing');

const ACTIVE_STAGES = new Set([
  'downloading',
  'probing',
  'audio extraction',
  'transcription',
  'ranking',
  'cutting/rendering',
  'upload',
]);

class ClientDisconnectedError extends Error {
  constructor({ currentStage, nextStage, disconnectSource, disconnectedAt }) {
    super('The requesting client disconnected before processing completed.');
    this.name = 'ClientDisconnectedError';
    this.code = 'CLIENT_DISCONNECTED';
    this.statusCode = 503;
    this.currentStage = currentStage;
    this.nextStage = nextStage;
    this.disconnectSource = disconnectSource;
    this.disconnectedAt = disconnectedAt;
  }
}

function createClipRequestLifecycle(req, res) {
  const trace = req.clipTrace;
  const startedAt = trace?.startedAt || Date.now();
  const lifecycle = {
    disconnected: false,
    disconnectSource: null,
    disconnectedAt: null,
    currentStage: 'initializing',
    stageStartedAt: Date.now(),
    requestStartedAt: startedAt,
    responseSelected: false,
  };

  const setStage = (nextStage, { allowDisconnected = false } = {}) => {
    // Stage boundaries are the only client-disconnect cancellation points.
    // Active work finishes; genuine provider/tool timeouts remain independent.
    if (lifecycle.disconnected && !allowDisconnected) {
      emit(trace, 'clip_stage_blocked', {
        currentStage: lifecycle.currentStage,
        nextStage,
        disconnectSource: lifecycle.disconnectSource,
        elapsedMs: elapsedMs(trace),
        willSettle: false,
      }, 'warn');
      throw new ClientDisconnectedError({
        currentStage: lifecycle.currentStage,
        nextStage,
        disconnectSource: lifecycle.disconnectSource,
        disconnectedAt: lifecycle.disconnectedAt,
      });
    }

    const now = Date.now();
    const previousStage = lifecycle.currentStage;
    const previousStageElapsedMs = Math.max(0, now - lifecycle.stageStartedAt);
    lifecycle.currentStage = nextStage;
    lifecycle.stageStartedAt = now;
    emit(trace, 'clip_stage_transition', {
      previousStage,
      newStage: nextStage,
      totalElapsedMs: Math.max(0, now - lifecycle.requestStartedAt),
      previousStageElapsedMs,
      disconnected: lifecycle.disconnected,
      disconnectSource: lifecycle.disconnectSource,
    });
  };

  const assertCanStartStage = (nextStage) => {
    setStage(nextStage);
  };

  const assertConnected = (nextWork) => {
    if (!lifecycle.disconnected) return;
    emit(trace, 'clip_stage_blocked', {
      currentStage: lifecycle.currentStage,
      nextStage: nextWork,
      disconnectSource: lifecycle.disconnectSource,
      elapsedMs: elapsedMs(trace),
      willSettle: false,
    }, 'warn');
    throw new ClientDisconnectedError({
      currentStage: lifecycle.currentStage,
      nextStage: nextWork,
      disconnectSource: lifecycle.disconnectSource,
      disconnectedAt: lifecycle.disconnectedAt,
    });
  };

  const markDisconnected = (source) => {
    if (lifecycle.disconnected) {
      emit(trace, 'clip_duplicate_disconnect_ignored', {
        source,
        originalSource: lifecycle.disconnectSource,
        currentStage: lifecycle.currentStage,
        elapsedMs: elapsedMs(trace),
      }, 'warn');
      return;
    }

    lifecycle.disconnected = true;
    lifecycle.disconnectSource = source;
    lifecycle.disconnectedAt = Date.now();
    emit(trace, 'clip_client_disconnected', {
      source,
      currentStage: lifecycle.currentStage,
      elapsedMs: elapsedMs(trace),
      willFinishCurrentStage: ACTIVE_STAGES.has(lifecycle.currentStage),
      willSafelyInterruptCurrentStage: false,
      willStartNextStage: false,
      willSettle: false,
    }, 'warn');
    if (ACTIVE_STAGES.has(lifecycle.currentStage)) {
      emit(trace, 'processing.continued', {
        currentStage: lifecycle.currentStage,
        elapsedMs: elapsedMs(trace),
        reason: 'finish_active_stage_to_safe_checkpoint',
        willStartNextStage: false,
        willSettle: false,
      }, 'warn');
    }
  };

  const onRequestAborted = () => markDisconnected('request_aborted');
  const onResponseClose = () => {
    // A normal close follows writableEnded and must not be treated as premature.
    if (!res.writableEnded) markDisconnected('response_close');
  };
  req.once('aborted', onRequestAborted);
  res.once('close', onResponseClose);

  emit(trace, 'clip_request_started', {
    currentStage: lifecycle.currentStage,
    elapsedMs: elapsedMs(trace),
  });

  return {
    state: lifecycle,
    setStage,
    assertCanStartStage,
    assertConnected,
    markDisconnected,
    enterCleanup() {
      setStage('cleanup', { allowDisconnected: true });
      emit(trace, 'clip_cleanup_started', {
        disconnected: lifecycle.disconnected,
        elapsedMs: elapsedMs(trace),
      });
    },
    cleanupCompleted() {
      emit(trace, 'clip_cleanup_completed', {
        disconnected: lifecycle.disconnected,
        elapsedMs: elapsedMs(trace),
      });
    },
    cleanupFailed() {
      emit(trace, 'clip_cleanup_failed', {
        disconnected: lifecycle.disconnected,
        elapsedMs: elapsedMs(trace),
      }, 'error');
    },
    selectResponse(statusCode) {
      lifecycle.responseSelected = true;
      emit(trace, 'clip_final_handler_status', {
        status: statusCode,
        disconnected: lifecycle.disconnected,
        willSettle: statusCode < 400,
        elapsedMs: elapsedMs(trace),
      }, statusCode < 400 ? 'info' : 'warn');
    },
    connectedCompleted() {
      setStage('completed');
      emit(trace, 'clip_connected_completed', {
        elapsedMs: elapsedMs(trace),
      });
    },
  };
}

module.exports = {
  ClientDisconnectedError,
  createClipRequestLifecycle,
};
