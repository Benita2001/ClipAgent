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
  checkLocalRuntimeContract,
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
    OKX_A2A_MAX_FILE_SIZE_BYTES: '1073741824',
    CLIPAGENT_MAX_DURATION_SECONDS: '3600',
    OKX_A2A_AI_PROVIDER: 'codex',
    GROQ_API_KEY: 'test-groq-key',
    OPENAI_API_KEY: 'test-openai-key',
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
    checkLiveMarketplaceContract: async () => ({
      ok: true,
      checks: {
        serviceExists: { ok: true },
      },
      failures: [],
      detail: {
        providerId: 6041,
        serviceId: 37723,
        status: 'active',
      },
    }),
  });

  assert.equal(result.ready, true);
  assert.equal(result.status, 'operational');
  assert.equal(result.identityChecks.providerOwned.ok, true);
  assert.equal(result.runtimeChecks.daemonConnected.ok, true);
  assert.equal(result.runtimeChecks.storage.ok, true);
  assert.equal(result.marketplaceChecks.serviceExists.ok, true);
  assert.equal(result.localContractChecks.clipCount.ok, true);
  assert.ok(result.marketplaceCapabilityLimitations.includes('contractVersion'));
  assert.deepEqual(result.failures, []);
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
    'localContract',
    'marketplaceContract',
    'disk',
  ]);
  assert.equal(result.checks.serviceMapping.detail.clipCount, 1);
  assert.deepEqual(result.checks.serviceMapping.detail.attachmentPolicy, {
    maximumBytes: 1073741824,
    maximumSourceDurationSeconds: 3600,
    platformMaximumSourceDurationSeconds: 3600,
    attachmentCount: 1,
    sourceUrlAccepted: false,
    multipartAccepted: false,
  });
  assert.equal(
    result.checks.configuration.detail.transcription.groqConfigured,
    true
  );
  assert.equal(
    result.checks.configuration.detail.transcription.openaiConfigured,
    true
  );
  assert.equal(
    result.checks.serviceMapping.detail.contractVersion,
    'clipagent-a2a-37723-v1'
  );
  assert.deepEqual(result.checks.serviceMapping.detail.configuredServices, [{
    serviceId: 37723,
    contractVersion: 'clipagent-a2a-37723-v1',
    clipCount: 1,
    pricingModel: 'fixed_service_total',
    feeAmount: '0.5',
    feeCurrency: 'USDT',
  }]);
  assert.equal(commands.some((command) => command[0] === 'onchainos'), true);
  assert.equal(commands.some((command) => command[0] === 'ffmpeg'), true);
  assert.equal(commands.some((command) => command[0] === 'ffprobe'), true);
  await fs.promises.rm(tempDir, { recursive: true, force: true });
});

test('readiness validates every active configured service contract', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-services-'));
  const contracts = {
    37723: {
      active: true,
      contractVersion: 'clipagent-a2a-37723-v1',
      clipCount: 1,
      pricingModel: 'fixed_service_total',
      feeAmount: '0.5',
      feeCurrency: 'USDT',
    },
    90002: {
      active: true,
      contractVersion: 'test-service-90002-v1',
      clipCount: 2,
      pricingModel: 'fixed_service_total',
      feeAmount: '1',
      feeCurrency: 'USDT',
    },
  };
  const result = await runA2aReadinessChecks({
    env: {
      A2A_JOB_STATE_FILE: path.join(tempDir, 'jobs.json'),
      OKX_A2A_PROVIDER_AGENT_ID: '6041',
      OKX_A2A_SERVICE_ID: '37723',
      OKX_A2A_SERVICE_CONTRACTS: JSON.stringify(contracts),
      OKX_A2A_SERVICE_CLIP_MAP: '{"37723":1,"90002":2}',
    OKX_A2A_MAX_FILE_SIZE_BYTES: '1073741824',
    CLIPAGENT_MAX_DURATION_SECONDS: '3600',
    OKX_A2A_AI_PROVIDER: 'codex',
    GROQ_API_KEY: 'test-groq-key',
    OPENAI_API_KEY: 'test-openai-key',
    },
    runCommand: async (command) => {
      if (command === 'okx-a2a') return { stdout: 'running pid=123' };
      if (command === 'onchainos') {
        return {
          stdout: JSON.stringify({
            ok: true,
            data: [{ agentId: '6041', roleLabel: 'ASP', onlineStatus: 1 }],
          }),
        };
      }
      return { stdout: `${command} version test` };
    },
    checkStorageReadiness: async () => ({ bucket: 'clips', public: true }),
    assertTemporaryDiskCapacity: async () => ({ availableBytes: 1_000 }),
    checkLiveMarketplaceContract: async () => ({
      ok: true,
      checks: { serviceExists: { ok: true } },
      failures: [],
      detail: {
        providerId: 6041,
        serviceId: 37723,
        status: 'active',
      },
    }),
  });
  assert.equal(result.ready, true);
  assert.deepEqual(
    result.checks.serviceMapping.detail.configuredServices.map(
      (service) => service.serviceId
    ),
    [37723, 90002]
  );
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
    checkLiveMarketplaceContract: async () => ({
      providerId: 6041,
      serviceId: 49999,
      status: 'active',
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
          data: [{ agentId: '6041', roleLabel: 'ASP', onlineStatus: 1 }],
        }),
      };
    },
  });
  assert.deepEqual(invocation, ['onchainos', 'agent', 'get-my-agents', '--role', 'asp']);
});

function localContractEnv(contractOverrides = {}, envOverrides = {}) {
  const contract = {
    active: true,
    contractVersion: 'clipagent-a2a-37723-v1',
    clipCount: 1,
    pricingModel: 'fixed_service_total',
    feeAmount: '0.5',
    feeCurrency: 'USDT',
    ...contractOverrides,
  };
  return {
    OKX_A2A_SERVICE_ID: '37723',
    OKX_A2A_SERVICE_CONTRACTS: JSON.stringify({ 37723: contract }),
    OKX_A2A_SERVICE_CLIP_MAP: JSON.stringify({ 37723: contract.clipCount }),
    OKX_A2A_MAX_FILE_SIZE_BYTES: '1073741824',
    CLIPAGENT_MAX_DURATION_SECONDS: '3600',
    ...envOverrides,
  };
}

test('local runtime contract validates the production invariants', () => {
  const result = checkLocalRuntimeContract({
    env: localContractEnv(),
    providerServiceId: 37723,
  });
  assert.equal(result.ok, true);
  assert.equal(result.checks.contractVersion.ok, true);
  assert.equal(result.checks.clipCount.ok, true);
  assert.equal(result.checks.attachmentPolicy.detail.sourceUrlAccepted, false);
  assert.equal(result.checks.deliveryContract.detail.completionPolicy, 'all_or_nothing');
});

for (const [name, contractOverrides, envOverrides, code] of [
  [
    'contract version',
    { contractVersion: 'clipagent-a2a-37723-v2' },
    {},
    'LOCAL_CONTRACT_VERSION_MISMATCH',
  ],
  [
    'clip count',
    { clipCount: 2 },
    {},
    'LOCAL_CLIP_COUNT_MISMATCH',
  ],
  [
    'attachment limit',
    {},
    { OKX_A2A_MAX_FILE_SIZE_BYTES: '104857600' },
    'LOCAL_ATTACHMENT_LIMIT_MISMATCH',
  ],
  [
    'source duration',
    {},
    { CLIPAGENT_MAX_DURATION_SECONDS: '3599' },
    'LOCAL_SOURCE_DURATION_MISMATCH',
  ],
]) {
  test(`incorrect local ${name} fails readiness contract validation`, () => {
    const result = checkLocalRuntimeContract({
      env: localContractEnv(contractOverrides, envOverrides),
      providerServiceId: 37723,
    });
    assert.equal(result.ok, false);
    assert.ok(result.failures.some((failure) => failure.code === code));
  });
}

test('offline ASP fails identity readiness', () => {
  assert.throws(
    () => parseAgentResponse(JSON.stringify({
      ok: true,
      data: [{
        agentId: '6041',
        name: 'ClipAgent',
        roleLabel: 'ASP',
        onlineStatus: 0,
      }],
    }), 6041),
    (error) => error.code === 'PROVIDER_OFFLINE'
  );
});

test('readiness reports independent marketplace failures together', async () => {
  const tempDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'clipagent-marketplace-ready-')
  );
  const env = {
    ...localContractEnv(),
    CLIPAGENT_DATA_ROOT: tempDir,
    CLIPAGENT_AUTH_HOME: path.join(tempDir, 'auth'),
    OKX_AGENT_TASK_HOME: path.join(tempDir, 'a2a'),
    A2A_STATE_DIR: path.join(tempDir, 'a2a-state'),
    A2A_JOB_STATE_FILE: path.join(tempDir, 'a2a-state', 'jobs.json'),
    A2A_STAGE_CHECKPOINT_DIR: path.join(tempDir, 'a2a-state', 'stages'),
    A2A_STAGE_ARTIFACT_DIR: path.join(tempDir, 'a2a-state', 'artifacts'),
    TRANSCRIPTION_STATE_DIR: path.join(tempDir, 'a2a-state', 'transcripts'),
    TEMP_UPLOAD_DIR: path.join(tempDir, 'tmp', 'uploads'),
    CLIPS_OUTPUT_DIR: path.join(tempDir, 'tmp', 'clips'),
    OKX_A2A_PROVIDER_AGENT_ID: '6041',
    OKX_A2A_AI_PROVIDER: 'codex',
    GROQ_API_KEY: 'test-groq-key',
    OPENAI_API_KEY: 'test-openai-key',
    TRANSCRIPTION_CHUNKING_ENABLED: 'true',
    TRANSCRIPTION_PRIMARY_PROVIDER: 'groq',
    TRANSCRIPTION_FALLBACK_PROVIDER: 'openai',
    RANKING_CONTEXT_PROTECTION_ENABLED: 'true',
  };
  const result = await runA2aReadinessChecks({
    env,
    runCommand: async (command, args) => {
      if (command === 'okx-a2a') return { stdout: 'daemon running' };
      if (command === 'onchainos') {
        return {
          stdout: JSON.stringify({
            ok: true,
            data: [{
              agentId: '6041',
              roleLabel: 'ASP',
              onlineStatus: 1,
            }],
          }),
        };
      }
      if (command === 'ffmpeg') return { stdout: 'ffmpeg version test' };
      if (command === 'ffprobe') return { stdout: 'ffprobe version test' };
      if (args?.[0] === '--version') return { stdout: 'codex 1.0.0' };
      throw new Error(`Unexpected command: ${command}`);
    },
    checkStorageReadiness: async () => ({ bucket: 'clips', public: true }),
    assertTemporaryDiskCapacity: async () => ({ availableBytes: 4_000_000_000 }),
    checkLiveMarketplaceContract: async () => ({
      ok: false,
      checks: {
        price: { ok: false },
        descriptionCompatibility: { ok: false },
      },
      failures: [
        {
          code: 'MARKETPLACE_WRONG_PRICE',
          message: 'Live fixed fee does not match the local contract.',
        },
        {
          code: 'MARKETPLACE_DESCRIPTION_CONTRADICTS_CONTRACT',
          message: 'Live service description contradicts the local contract.',
        },
      ],
    }),
  });

  assert.equal(result.ready, false);
  assert.equal(result.status, 'marketplace_contract_mismatch');
  assert.equal(result.primaryError, 'MARKETPLACE_WRONG_PRICE');
  assert.deepEqual(
    result.failures.map((failure) => failure.code),
    [
      'MARKETPLACE_WRONG_PRICE',
      'MARKETPLACE_DESCRIPTION_CONTRADICTS_CONTRACT',
    ]
  );
  assert.equal(result.localContractChecks.contractVersion.ok, true);
  assert.equal(result.localContractChecks.clipCount.ok, true);
});
