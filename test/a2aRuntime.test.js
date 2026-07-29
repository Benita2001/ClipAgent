const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { startRuntime, a2mcpEnabled } = require('../start');
const { startA2aWorker } = require('../a2a-worker');
const {
  parseAgentResponse,
  runA2aReadinessChecks,
} = require('../services/a2aReadiness');

test('production startup defaults to A2A without loading the legacy server', async () => {
  let a2aStarts = 0;
  let legacyStarts = 0;
  const result = await startRuntime({
    env: {},
    startA2aWorker: async () => {
      a2aStarts += 1;
      return { mode: 'daemon' };
    },
    startLegacy: async () => {
      legacyStarts += 1;
    },
  });

  assert.equal(result.mode, 'daemon');
  assert.equal(a2aStarts, 1);
  assert.equal(legacyStarts, 0);
  assert.equal(require.cache[require.resolve('../server')], undefined);
});

test('ENABLE_A2MCP=true keeps the legacy runtime available explicitly', async () => {
  let a2aStarts = 0;
  let legacyStarts = 0;
  await startRuntime({
    env: { ENABLE_A2MCP: 'true' },
    startA2aWorker: async () => {
      a2aStarts += 1;
    },
    startLegacy: async () => {
      legacyStarts += 1;
    },
  });

  assert.equal(a2mcpEnabled({ ENABLE_A2MCP: 'true' }), true);
  assert.equal(a2aStarts, 0);
  assert.equal(legacyStarts, 1);
});

test('production runtime installs graceful shutdown for the A2A worker', async () => {
  const { installShutdownHandlers } = require('../start');
  const processImpl = new EventEmitter();
  let stopped = 0;
  let exitCode = null;
  processImpl.exit = (code) => {
    exitCode = code;
  };
  installShutdownHandlers(
    { mode: 'daemon', stop: async () => { stopped += 1; } },
    { processImpl, logger: { log() {}, error() {} } }
  );
  processImpl.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, 1);
  assert.equal(exitCode, 0);
});

test('job-shaped startup runs the existing A2A handler without starting a daemon server', async () => {
  let received;
  const result = await startA2aWorker({
    env: {
      OKX_AGENT_TASK_CURRENT_JOB_FILE: '/tmp/job.json',
      OKX_AGENT_TASK_CURRENT_JOB_ID: 'job-1',
    },
    logger: { log() {}, error() {} },
    runOkxA2aJob: async (options) => {
      received = options;
      return { jobId: 'job-1', delivered: true };
    },
    ensureDaemonRunning: async () => {
      throw new Error('daemon startup must not run in job mode');
    },
  });

  assert.equal(result.mode, 'job');
  assert.equal(result.result.delivered, true);
  assert.equal(received.env.OKX_AGENT_TASK_CURRENT_JOB_ID, 'job-1');
});

test('readiness validates every A2A production dependency without x402', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-ready-'));
  const commands = [];
  const env = {
    A2A_JOB_STATE_FILE: path.join(tempDir, 'state', 'jobs.json'),
    OKX_A2A_PROVIDER_AGENT_ID: '6041',
    OKX_A2A_SERVICE_ID: '37723',
    OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1}',
    OKX_A2A_AI_PROVIDER: 'codex',
  };
  const runCommand = async (command, args) => {
    commands.push([command, ...args]);
    if (command === 'okx-a2a') {
      return { stdout: 'running pid=123\n', stderr: '' };
    }
    if (command === 'onchainos') {
      return {
        stdout: JSON.stringify({
          ok: true,
          data: [{ agentId: '6041', name: 'ClipAgent', roleLabel: 'ASP', onlineStatus: 1 }],
        }),
        stderr: '',
      };
    }
    return { stdout: `${command} version test\n`, stderr: '' };
  };

  const result = await runA2aReadinessChecks({
    env,
    runCommand,
    checkStorageReadiness: async () => ({ bucket: 'clips', public: true }),
    assertTemporaryDiskCapacity: async () => ({
      requiredBytes: 300,
      availableBytes: 1_000,
    }),
  });

  assert.equal(result.ready, true);
  assert.equal(result.status, 'operational');
  assert.deepEqual(Object.keys(result.checks), [
    'daemon',
    'configuration',
    'identity',
    'jobState',
    'persistentPaths',
    'ffmpeg',
    'ffprobe',
    'storage',
    'serviceMapping',
    'disk',
  ]);
  assert.equal(result.checks.serviceMapping.detail.clipCount, 1);
  assert.equal(commands.some((command) => command[0] === 'onchainos'), true);
  assert.equal(commands.some((command) => command[0] === 'ffmpeg'), true);
  assert.equal(commands.some((command) => command[0] === 'ffprobe'), true);
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test('readiness fails closed when identity or service mapping is unavailable', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-not-ready-'));
  const result = await runA2aReadinessChecks({
    env: {
      A2A_JOB_STATE_FILE: path.join(tempDir, 'jobs.json'),
      OKX_A2A_PROVIDER_AGENT_ID: '6041',
      OKX_A2A_SERVICE_ID: '49999',
      OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1}',
    },
    runCommand: async (command) => {
      if (command === 'okx-a2a') return { stdout: 'running pid=123', stderr: '' };
      if (command === 'onchainos') return { stdout: '{"ok":false,"data":[]}', stderr: '' };
      return { stdout: `${command} version test`, stderr: '' };
    },
    checkStorageReadiness: async () => ({ bucket: 'clips', public: true }),
    assertTemporaryDiskCapacity: async () => ({
      requiredBytes: 300,
      availableBytes: 1_000,
    }),
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.identity.ok, false);
  assert.equal(result.checks.serviceMapping.ok, false);
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test('identity readiness accepts only the requested ASP identity', () => {
  const parsed = parseAgentResponse(JSON.stringify({
    ok: true,
    data: [{ agentId: '6041', name: 'ClipAgent', roleLabel: 'ASP', onlineStatus: 1 }],
  }), 6041);
  assert.deepEqual(parsed, {
    agentId: '6041',
    name: 'ClipAgent',
    online: true,
  });
});

test('identity readiness accepts nested agents from current get-my-agents response', () => {
  const parsed = parseAgentResponse(JSON.stringify({
    ok: true,
    data: {
      list: [{
        agentList: [{
          agentId: 6041,
          name: 'ClipAgent',
          role: 1,
          roleLabel: 'ASP',
          onlineStatus: 1,
        }],
      }],
    },
  }), '6041');
  assert.deepEqual(parsed, {
    agentId: '6041',
    name: 'ClipAgent',
    online: true,
  });
});

test('authenticated identity lookup uses ownership-scoped ASP query', async () => {
  const { checkAuthenticatedIdentity } = require('../services/a2aReadiness');
  let invocation;
  await checkAuthenticatedIdentity({
    env: {},
    providerAgentId: 6041,
    runCommand: async (command, args) => {
      invocation = [command, ...args];
      return {
        stdout: JSON.stringify({
          ok: true,
          data: [{ agentId: '6041', roleLabel: 'ASP' }],
        }),
      };
    },
  });
  assert.deepEqual(invocation, ['onchainos', 'agent', 'get-my-agents', '--role', 'asp']);
});
