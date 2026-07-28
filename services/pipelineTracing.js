function elapsedMs(trace) {
  if (!trace) return 0;
  return Math.max(0, Date.now() - trace.startedAt);
}

function emit(trace, event, fields = {}, level = 'info') {
  if (!trace) return;
  const entry = {
    event,
    timestamp: new Date().toISOString(),
    requestId: trace.requestId,
    ...fields,
  };
  const method = typeof trace.logger[level] === 'function' ? level : 'log';
  trace.logger[method](JSON.stringify(entry));
}

async function traceStage(trace, stage, operation) {
  const startedAt = Date.now();
  emit(trace, 'pipeline.stage_started', {
    stage,
    elapsedMs: elapsedMs(trace),
  });
  try {
    const result = await operation();
    emit(trace, 'pipeline.stage_finished', {
      stage,
      outcome: 'success',
      elapsedMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    emit(trace, 'pipeline.stage_finished', {
      stage,
      outcome: 'failed',
      elapsedMs: Date.now() - startedAt,
    }, 'error');
    throw error;
  }
}

function logPipelineFailure(trace, { code, stage, timeout = false }) {
  emit(trace, timeout ? 'pipeline.timeout' : 'pipeline.failed', {
    safeErrorCode: code,
    stage,
    totalElapsedMs: elapsedMs(trace),
  }, 'error');
}

module.exports = {
  emit,
  elapsedMs,
  traceStage,
  logPipelineFailure,
};
