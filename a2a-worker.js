require('dotenv').config();

const http = require('http');
const { runOkxA2aJob } = require('./services/okxA2aJobHandler');
const {
  defaultRunCommand,
  runA2aReadinessChecks,
} = require('./services/a2aReadiness');
const { ensureUploadDir } = require('./utils/tempDir');
const { ensureOutputDir } = require('./utils/outputDir');
const { getMarketplaceIdentity } = require('./config/marketplaceIdentity');

function readBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

async function ensureDaemonRunning(options = {}) {
  const env = options.env || process.env;
  const runCommand = options.runCommand || defaultRunCommand;
  const assertRunning = async () => {
    const result = await runCommand('okx-a2a', ['daemon', 'status'], {
      env,
      timeout: 10_000,
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (!/\brunning\b/i.test(output)) {
      throw new Error('A2A daemon is not running.');
    }
    return result;
  };
  try {
    await assertRunning();
    return { started: false, managed: false };
  } catch (statusError) {
    if (!readBoolean(env.A2A_MANAGE_DAEMON, true)) throw statusError;
    await runCommand(
      'okx-a2a',
      ['daemon', 'start', '--no-autostart'],
      { env, timeout: 30_000 }
    );
    const deadline = Date.now() + Number(env.A2A_DAEMON_START_TIMEOUT_MS || 30_000);
    while (Date.now() < deadline) {
      try {
        await assertRunning();
        return { started: true, managed: true };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error('A2A daemon did not become ready before the startup timeout.');
  }
}

function createHealthServer(getReadiness) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'alive', runtime: 'a2a-worker' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/ready') {
      const readiness = getReadiness();
      res.writeHead(readiness.ready ? 200 : 503, {
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify(readiness));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
}

async function startA2aWorker(options = {}) {
  const env = options.env || process.env;
  getMarketplaceIdentity(env);
  const logger = options.logger || console;
  const runJob = options.runOkxA2aJob || runOkxA2aJob;

  if (env.OKX_AGENT_TASK_CURRENT_JOB_FILE) {
    const result = await runJob({ env, logger });
    return { mode: 'job', result };
  }

  ensureUploadDir();
  ensureOutputDir();
  const daemon = await (options.ensureDaemonRunning || ensureDaemonRunning)({
    env,
    runCommand: options.runCommand,
  });

  let readiness = {
    ready: false,
    status: 'configuration_unavailable',
    checkedAt: null,
    checks: {},
    message: 'A2A readiness has not completed.',
  };
  let activeRefresh = null;
  const refreshReadiness = () => {
    if (activeRefresh) return activeRefresh;
    activeRefresh = (options.runA2aReadinessChecks || runA2aReadinessChecks)({
      env,
      runCommand: options.runCommand,
    })
      .then((result) => {
        readiness = result;
        return result;
      })
      .catch((error) => {
        logger.error(JSON.stringify({
          event: 'a2a.readiness_check_failed',
          timestamp: new Date().toISOString(),
          error: String(error?.code || error?.name || 'READINESS_CHECK_FAILED'),
        }));
        readiness = {
          ready: false,
          status: 'configuration_unavailable',
          checkedAt: new Date().toISOString(),
          checks: {},
          message: 'Readiness evaluation failed; inspect worker logs.',
        };
        return readiness;
      })
      .finally(() => {
        activeRefresh = null;
      });
    return activeRefresh;
  };

  const server = (options.createHealthServer || createHealthServer)(() => readiness);
  const port = Number(env.A2A_HEALTH_PORT || env.PORT || 3000);
  const host = env.A2A_HEALTH_HOST || '0.0.0.0';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  await refreshReadiness();
  const intervalMs = Number(env.A2A_READINESS_INTERVAL_MS || 60_000);
  const timer = setInterval(refreshReadiness, intervalMs);
  timer.unref();
  let daemonFailures = 0;
  const daemonMonitorMs = Number(env.A2A_DAEMON_MONITOR_INTERVAL_MS || 15_000);
  const daemonMonitor = setInterval(async () => {
    try {
      await (options.runCommand || defaultRunCommand)(
        'okx-a2a',
        ['daemon', 'status'],
        { env, timeout: 10_000 }
      ).then((result) => {
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        if (!/\brunning\b/i.test(output)) throw new Error('A2A daemon is not running.');
      });
      daemonFailures = 0;
    } catch (error) {
      daemonFailures += 1;
      readiness = {
        ...readiness,
        ready: false,
        status: 'daemon_unavailable',
        message: 'A2A daemon is unavailable.',
        checkedAt: new Date().toISOString(),
        checks: {
          ...readiness.checks,
          daemon: {
            ok: false,
            error: 'DAEMON_DISCONNECTED',
            message: 'A2A daemon is disconnected.',
          },
        },
      };
      logger.error(JSON.stringify({
        event: 'a2a.daemon_disconnected',
        timestamp: new Date().toISOString(),
        attempt: daemonFailures,
      }));
      if (daemonFailures >= Number(env.A2A_DAEMON_FAILURE_THRESHOLD || 3)) {
        process.exitCode = 1;
        await stop({ stopDaemon: false });
      }
    }
  }, daemonMonitorMs);
  daemonMonitor.unref();

  logger.log(JSON.stringify({
    event: 'a2a.worker_started',
    timestamp: new Date().toISOString(),
    port,
    host,
    daemonStarted: daemon.started,
    ready: readiness.ready,
  }));

  let stopping = false;
  const stop = async ({ stopDaemon = true } = {}) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(daemonMonitor);
    await new Promise((resolve) => server.close(resolve));
    if (stopDaemon && daemon.managed) {
      await (options.runCommand || defaultRunCommand)(
        'okx-a2a',
        ['daemon', 'stop'],
        { env, timeout: 15_000 }
      ).catch((error) => {
        logger.error(JSON.stringify({
          event: 'a2a.daemon_stop_failed',
          timestamp: new Date().toISOString(),
          message: error.message,
        }));
      });
    }
  };

  return {
    mode: 'daemon',
    server,
    daemon,
    getReadiness: () => readiness,
    refreshReadiness,
    stop,
  };
}

async function main() {
  const worker = await startA2aWorker();
  if (worker.mode !== 'daemon') return;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      await worker.stop();
      process.exit(0);
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: 'a2a.worker_failed',
      timestamp: new Date().toISOString(),
      message: error.message,
    }));
    process.exitCode = 1;
  });
}

module.exports = {
  startA2aWorker,
  ensureDaemonRunning,
  createHealthServer,
  readBoolean,
};
