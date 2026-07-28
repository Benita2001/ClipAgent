require('dotenv').config();

function a2mcpEnabled(env = process.env) {
  return String(env.ENABLE_A2MCP || 'false').toLowerCase() === 'true';
}

async function startRuntime(options = {}) {
  const env = options.env || process.env;
  if (a2mcpEnabled(env)) {
    if (options.startLegacy) return options.startLegacy();
    require('./server');
    return { mode: 'legacy-a2mcp' };
  }

  const startA2aWorker =
    options.startA2aWorker || require('./a2a-worker').startA2aWorker;
  return startA2aWorker({ env });
}

function installShutdownHandlers(runtime, {
  processImpl = process,
  logger = console,
} = {}) {
  if (!runtime || runtime.mode !== 'daemon' || typeof runtime.stop !== 'function') return;
  let shuttingDown = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    processImpl.once(signal, async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.log(JSON.stringify({
        event: 'a2a.worker_stopping',
        timestamp: new Date().toISOString(),
        signal,
      }));
      try {
        await runtime.stop();
        logger.log(JSON.stringify({
          event: 'a2a.worker_stopped',
          timestamp: new Date().toISOString(),
          signal,
        }));
        processImpl.exit(0);
      } catch (error) {
        logger.error(JSON.stringify({
          event: 'a2a.worker_stop_failed',
          timestamp: new Date().toISOString(),
          signal,
          message: error.message,
        }));
        processImpl.exit(1);
      }
    });
  }
}

if (require.main === module) {
  startRuntime().then((runtime) => {
    installShutdownHandlers(runtime);
  }).catch((error) => {
    console.error(JSON.stringify({
      event: 'runtime.start_failed',
      timestamp: new Date().toISOString(),
      message: error.message,
    }));
    process.exitCode = 1;
  });
}

module.exports = { startRuntime, a2mcpEnabled, installShutdownHandlers };
