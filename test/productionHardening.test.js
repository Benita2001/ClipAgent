const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  OkxA2aJobStateStore,
} = require('../services/okxA2aJobStateStore');
const { resolveRuntimePaths } = require('../config/runtimePaths');
const { runA2aReadinessChecks } = require('../services/a2aReadiness');

function tempStatePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clipagent-state-')), 'state.json');
}

test('production runtime paths are explicit beneath the configured data roots', () => {
  const paths = resolveRuntimePaths({
    NODE_ENV: 'production',
    CLIPAGENT_DATA_ROOT: '/srv/clipagent-data',
    CLIPAGENT_TEMP_ROOT: '/scratch/clipagent',
  });
  assert.equal(paths.taskHome, '/srv/clipagent-data/a2a');
  assert.equal(paths.stateFile, '/srv/clipagent-data/a2a-state/clipagent-a2a-state.json');
  assert.equal(paths.uploadsDir, '/scratch/clipagent/uploads');
  assert.equal(paths.outputDir, '/scratch/clipagent/clips');
});

test('fresh processing claims are not recovered', async () => {
  const filePath = tempStatePath();
  const now = Date.now();
  const store = new OkxA2aJobStateStore({ filePath, now: () => now, staleMs: 1_000 });
  await store.upsert('job-fresh', { status: 'processing', stage: 'ranking' });
  const claim = await store.claim('job-fresh');
  assert.equal(claim.claimed, false);
  assert.equal(claim.reason, 'already_processing');
});

for (const [status, stage] of [
  ['attachment_downloading', 'attachment_acquisition'],
  ['attachment_ready', 'validation'],
  ['processing', 'transcription'],
  ['processing', 'ranking'],
  ['processing', 'rendering'],
  ['processing', 'upload'],
]) {
  test(`stale ${stage} work is atomically claimed for a full restart`, async () => {
    const filePath = tempStatePath();
    let now = 1_000;
    const store = new OkxA2aJobStateStore({ filePath, now: () => now, staleMs: 500 });
    await store.upsert(`job-${stage}`, { status, stage });
    now = 2_000;
    const claim = await store.claim(`job-${stage}`);
    assert.equal(claim.claimed, true);
    assert.equal(claim.recovered, true);
    assert.equal(claim.resumeDeliveryOnly, false);
    assert.equal(claim.job.stage, 'restarting');
    assert.equal(claim.job.recoveryAttempt, 1);
    assert.equal(claim.job.recoveryReason, `stale_${status}_${stage}`);
  });
}

test('stale processing with durable result resumes delivery only', async () => {
  const filePath = tempStatePath();
  let now = 1_000;
  const store = new OkxA2aJobStateStore({ filePath, now: () => now, staleMs: 500 });
  await store.upsert('job-uploaded', {
    status: 'processing',
    stage: 'upload',
    result: { clips: [{ url: 'https://example.invalid/clip.mp4' }] },
    deliveryPayload: { status: 'completed' },
  });
  now = 2_000;
  const claim = await store.claim('job-uploaded');
  assert.equal(claim.resumeDeliveryOnly, true);
  assert.equal(claim.job.status, 'ready_for_delivery');
  assert.equal(claim.job.stage, 'ready_for_delivery');
});

test('a contract-version change atomically clears stale results and restarts work', async () => {
  const filePath = tempStatePath();
  const store = new OkxA2aJobStateStore({ filePath });
  await store.upsert('job-contract-change', {
    status: 'delivery_failed',
    stage: 'delivery',
    contractVersion: 'contract-v1',
    result: { clips: [{ url: 'https://example.invalid/old.mp4' }] },
    deliveryPayload: { status: 'completed', serviceContractVersion: 'contract-v1' },
  });
  const claim = await store.claim('job-contract-change', {
    contractVersion: 'contract-v2',
  });
  assert.equal(claim.claimed, true);
  assert.equal(claim.recovered, true);
  assert.equal(claim.resumeDeliveryOnly, false);
  assert.equal(claim.job.status, 'processing');
  assert.equal(claim.job.stage, 'restarting');
  assert.equal(claim.job.result, null);
  assert.equal(claim.job.deliveryPayload, null);
  assert.equal(claim.job.contractVersion, 'contract-v2');
  assert.match(claim.job.recoveryReason, /contract_changed_contract-v1_to_contract-v2/);
});

for (const status of ['ready_for_delivery', 'delivery_failed']) {
  test(`${status} claims preserve results for delivery retry`, async () => {
    const filePath = tempStatePath();
    const store = new OkxA2aJobStateStore({ filePath });
    await store.upsert(`job-${status}`, {
      status,
      stage: 'delivery',
      result: { clips: [] },
      deliveryPayload: { status: 'completed' },
    });
    const claim = await store.claim(`job-${status}`);
    assert.equal(claim.claimed, true);
    assert.equal(claim.resumeDeliveryOnly, true);
    assert.deepEqual(claim.job.deliveryPayload, { status: 'completed' });
  });
}

test('two state-store instances cannot claim the same job concurrently', async () => {
  const filePath = tempStatePath();
  const first = new OkxA2aJobStateStore({ filePath });
  const second = new OkxA2aJobStateStore({ filePath });
  const claims = await Promise.all([
    first.claim('job-concurrent'),
    second.claim('job-concurrent'),
  ]);
  assert.equal(claims.filter((claim) => claim.claimed).length, 1);
  assert.equal(claims.filter((claim) => !claim.claimed).length, 1);
});

test('active heartbeat prevents stale reclamation until the lease expires', async () => {
  const filePath = tempStatePath();
  let now = 1_000;
  const first = new OkxA2aJobStateStore({
    filePath,
    now: () => now,
    staleMs: 1_000,
  });
  const second = new OkxA2aJobStateStore({
    filePath,
    now: () => now,
    staleMs: 1_000,
  });
  const initial = await first.claim('job-heartbeat', { processingOwner: 'worker-a' });
  assert.equal(initial.claimed, true);

  now = 1_900;
  await first.heartbeat('job-heartbeat', 'worker-a', { stage: 'rendering' });
  now = 2_500;
  const activeClaim = await second.claim('job-heartbeat', { processingOwner: 'worker-b' });
  assert.equal(activeClaim.claimed, false);
  assert.equal(activeClaim.reason, 'already_processing');

  now = 3_001;
  const recovered = await second.claim('job-heartbeat', { processingOwner: 'worker-b' });
  assert.equal(recovered.claimed, true);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.job.processingOwner, 'worker-b');
});

test('heartbeat refuses to extend another worker lease', async () => {
  const filePath = tempStatePath();
  const store = new OkxA2aJobStateStore({ filePath });
  await store.claim('job-owned', { processingOwner: 'worker-a' });
  await assert.rejects(
    store.heartbeat('job-owned', 'worker-b', { stage: 'rendering' }),
    (error) => error.code === 'A2A_JOB_LEASE_LOST'
  );
});

test('readiness fails closed without authentication and redacts command output', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipagent-ready-'));
  const readiness = await runA2aReadinessChecks({
    env: {
      NODE_ENV: 'production',
      CLIPAGENT_DATA_ROOT: root,
      CLIPAGENT_TEMP_ROOT: path.join(root, 'tmp'),
      OKX_A2A_PROVIDER_AGENT_ID: '91001',
      OKX_A2A_SERVICE_ID: '92001',
      OKX_A2A_CONTRACT_NAME: 'clipagent-a2a-development-v1',
      OKX_MARKETPLACE_ENVIRONMENT: 'test',
      OKX_A2A_SERVICE_CONTRACTS: '{"92001":{"active":true,"contractVersion":"clipagent-a2a-development-v1","clipCount":1,"pricingModel":"fixed_service_total","feeAmount":"0.5","feeCurrency":"USDT"}}',
      OKX_A2A_SERVICE_CLIP_MAP: '{"92001":1}',
      OKX_A2A_AI_PROVIDER: 'codex',
    },
    runCommand: async (command) => {
      if (command === 'okx-a2a') return { stdout: 'running pid=123\n' };
      if (command === 'onchainos') {
        const error = new Error('not authenticated token=super-secret-value');
        error.code = 'AUTH_REQUIRED';
        throw error;
      }
      return { stdout: `${command} version test\n` };
    },
    checkStorageReadiness: async () => ({ available: true }),
    assertTemporaryDiskCapacity: async () => ({ availableBytes: 1_000_000_000 }),
    checkLiveMarketplaceContract: async () => ({ status: 'active' }),
  });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.status, 'unauthenticated');
  assert.equal(readiness.checks.identity.error, 'AUTH_REQUIRED');
  assert.equal(JSON.stringify(readiness).includes('super-secret-value'), false);
  assert.equal(JSON.stringify(readiness).includes('91001'), false);
});

test('readiness distinguishes daemon, provider, storage, and operational states', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clipagent-ready-states-'));
  const env = {
    NODE_ENV: 'production',
    CLIPAGENT_DATA_ROOT: root,
    CLIPAGENT_TEMP_ROOT: path.join(root, 'tmp'),
    OKX_A2A_PROVIDER_AGENT_ID: '91001',
    OKX_A2A_SERVICE_ID: '92001',
    OKX_A2A_CONTRACT_NAME: 'clipagent-a2a-development-v1',
    OKX_MARKETPLACE_ENVIRONMENT: 'test',
    OKX_A2A_SERVICE_CONTRACTS: '{"92001":{"active":true,"contractVersion":"clipagent-a2a-development-v1","clipCount":1,"pricingModel":"fixed_service_total","feeAmount":"0.5","feeCurrency":"USDT"}}',
    OKX_A2A_SERVICE_CLIP_MAP: '{"92001":1}',
    OKX_A2A_MAX_FILE_SIZE_BYTES: '1073741824',
    CLIPAGENT_MAX_DURATION_SECONDS: '3600',
    OKX_A2A_AI_PROVIDER: 'codex',
    GROQ_API_KEY: 'test-groq-key',
    OPENAI_API_KEY: 'test-openai-key',
  };
  const identity = {
    ok: true,
    data: [{ agentId: '91001', name: 'ClipAgent', roleLabel: 'ASP', onlineStatus: 1 }],
  };
  const baseOptions = {
    env,
    assertTemporaryDiskCapacity: async () => ({ availableBytes: 1_000_000_000 }),
    checkLiveMarketplaceContract: async () => ({ status: 'active' }),
  };
  const commandRunner = (agentResponse = identity, daemonRunning = true) =>
    async (command) => {
      if (command === 'okx-a2a') {
        if (!daemonRunning) throw Object.assign(new Error('private daemon detail'), { code: 1 });
        return { stdout: 'running' };
      }
      if (command === 'onchainos') return { stdout: JSON.stringify(agentResponse) };
      return { stdout: `${command} version test` };
    };

  const daemon = await runA2aReadinessChecks({
    ...baseOptions,
    runCommand: commandRunner(identity, false),
    checkStorageReadiness: async () => ({ available: true }),
  });
  assert.equal(daemon.status, 'daemon_unavailable');

  const wrongProvider = await runA2aReadinessChecks({
    ...baseOptions,
    runCommand: commandRunner({ ok: true, data: [{ agentId: '6071', roleLabel: 'ASP' }] }),
    checkStorageReadiness: async () => ({ available: true }),
  });
  assert.equal(wrongProvider.status, 'wrong_provider');

  const storage = await runA2aReadinessChecks({
    ...baseOptions,
    runCommand: commandRunner(),
    checkStorageReadiness: async () => {
      throw Object.assign(new Error('key=private-storage-key'), { code: 'STORAGE_UNAVAILABLE' });
    },
  });
  assert.equal(storage.status, 'storage_unavailable');
  assert.equal(JSON.stringify(storage).includes('private-storage-key'), false);

  const operational = await runA2aReadinessChecks({
    ...baseOptions,
    runCommand: commandRunner(),
    checkStorageReadiness: async () => ({ available: true }),
  });
  assert.equal(operational.status, 'operational');
  assert.equal(operational.ready, true);
});

test('container startup is pinned to A2A-only non-root execution with init', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /USER clipagent/);
  assert.match(dockerfile, /ENABLE_A2MCP=false/);
  assert.match(dockerfile, /tini/);
  assert.match(dockerfile, /CMD \["node", "start\.js"\]/);
  assert.doesNotMatch(dockerfile, /CMD \["node", "server\.js"\]/);
});
