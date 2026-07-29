const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { getA2aTransportConfig } = require('../config/a2aTransportConfig');
const { assertTemporaryDiskCapacity } = require('./diskCapacityService');
const { checkStorageReadiness } = require('./supabaseStorageService');
const { defaultStateFilePath } = require('./okxA2aJobStateStore');
const { ensureUploadDir } = require('../utils/tempDir');
const { ensureOutputDir } = require('../utils/outputDir');
const { resolveRuntimePaths } = require('../config/runtimePaths');
const { getTranscriptionConfig } = require('../config/transcriptionConfig');
const { TRANSCRIPT_SCHEMA_VERSION } = require('./transcriptSchema');
const { MAX_SOURCE_DURATION_SECONDS } = require('./durationLimitService');
const { getRankingLimits } = require('./boundedRankingService');
const {
  checkLiveMarketplaceContract,
  MARKETPLACE_CAPABILITY_LIMITATIONS,
} = require('./okxMarketplaceReadiness');
const {
  DEFAULT_MIN_DURATION_SECONDS,
  DEFAULT_MAX_DURATION_SECONDS,
} = require('./clipPricing');

const execFileAsync = promisify(execFile);

function redactReadinessMessage(error) {
  const code = error?.code || error?.name || 'READINESS_CHECK_FAILED';
  const safeMessages = {
    AUTH_REQUIRED: 'Authenticated provider identity is unavailable.',
    WRONG_PROVIDER: 'Authenticated identity does not own the configured provider.',
    DAEMON_UNAVAILABLE: 'A2A daemon is unavailable.',
    STORAGE_UNAVAILABLE: 'Persistent or object storage is unavailable.',
    ENOENT: 'A required executable or path is unavailable.',
    EACCES: 'A required path is not accessible.',
    EPERM: 'A required operation is not permitted.',
  };
  return safeMessages[code] || 'Readiness check failed; inspect worker logs for diagnostics.';
}

function readinessError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function defaultRunCommand(command, args, options = {}) {
  const { stdout, stderr } = await execFileAsync(command, args, {
    env: options.env,
    timeout: options.timeout || 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout, stderr };
}

function parseAgentResponse(stdout, expectedAgentId) {
  let response;
  try {
    response = JSON.parse(String(stdout || '').trim());
  } catch {
    throw readinessError('AUTH_REQUIRED', 'Authenticated agent response was unavailable.');
  }
  if (!response?.ok) {
    throw readinessError('AUTH_REQUIRED', 'Authenticated agent lookup was rejected.');
  }
  const directAgents = Array.isArray(response?.data) ? response.data : [];
  const nestedAgents = Array.isArray(response?.data?.list)
    ? response.data.list.flatMap((item) =>
        Array.isArray(item?.agentList) ? item.agentList : []
      )
    : [];
  const expectedId = String(expectedAgentId).trim();
  const agent = [...directAgents, ...nestedAgents].find(
    (item) => String(item?.agentId).trim() === expectedId
  );
  if (!agent) {
    throw readinessError('WRONG_PROVIDER', 'Configured provider is not owned by this identity.');
  }
  if (String(agent.roleLabel || '').toUpperCase() !== 'ASP') {
    throw readinessError('WRONG_PROVIDER', 'Configured provider is not an ASP.');
  }
  if (agent.onlineStatus !== 1) {
    throw readinessError('PROVIDER_OFFLINE', 'Configured provider is not online.');
  }
  return {
    agentId: String(agent.agentId),
    name: agent.name || null,
    online: agent.onlineStatus === 1,
  };
}

async function checkDaemon({ runCommand, env }) {
  let result;
  try {
    result = await runCommand('okx-a2a', ['daemon', 'status'], { env, timeout: 10_000 });
  } catch {
    throw readinessError('DAEMON_UNAVAILABLE', 'A2A daemon status failed.');
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (!/\brunning\b/i.test(output)) {
    throw readinessError('DAEMON_UNAVAILABLE', 'A2A daemon is not connected.');
  }
  return { connected: true };
}

async function checkAuthenticatedIdentity({ runCommand, env, providerAgentId }) {
  const result = await runCommand(
    'onchainos',
    ['agent', 'get-my-agents', '--role', 'asp'],
    { env, timeout: 15_000 }
  );
  return parseAgentResponse(result.stdout, providerAgentId);
}

function classifyReadiness(checks) {
  if (!checks.daemon?.ok) {
    return { status: 'daemon_unavailable', message: 'A2A daemon is unavailable.' };
  }
  if (!checks.identity?.ok) {
    if (checks.identity.error === 'WRONG_PROVIDER') {
      return { status: 'wrong_provider', message: 'Authenticated provider does not match configuration.' };
    }
    return { status: 'unauthenticated', message: 'Provider authentication is required.' };
  }
  if (!checks.marketplaceContract?.ok) {
    return {
      status: 'marketplace_contract_mismatch',
      message: 'Live marketplace listing does not match ClipAgent.',
    };
  }
  if (!checks.localContract?.ok) {
    return {
      status: 'configuration_unavailable',
      message: 'Local ClipAgent contract is invalid.',
    };
  }
  if (!checks.jobState?.ok || !checks.persistentPaths?.ok || !checks.storage?.ok) {
    return { status: 'storage_unavailable', message: 'Required storage is unavailable.' };
  }
  if (Object.values(checks).some((check) => !check.ok)) {
    return { status: 'configuration_unavailable', message: 'Worker configuration is incomplete.' };
  }
  return { status: 'operational', message: 'Worker is fully operational.' };
}

async function checkWritableJobState({ env, fsImpl = fs }) {
  const stateFile = defaultStateFilePath(env);
  const stateDir = path.dirname(stateFile);
  await fsImpl.promises.mkdir(stateDir, { recursive: true });
  const probePath = path.join(
    stateDir,
    `.clipagent-readiness-${process.pid}-${Date.now()}.tmp`
  );
  try {
    await fsImpl.promises.writeFile(probePath, 'ready\n', { flag: 'wx' });
    await fsImpl.promises.rename(probePath, `${probePath}.verified`);
    await fsImpl.promises.unlink(`${probePath}.verified`);
  } finally {
    await fsImpl.promises.unlink(probePath).catch(() => {});
    await fsImpl.promises.unlink(`${probePath}.verified`).catch(() => {});
  }
  return { path: stateFile, writable: true };
}

async function checkPersistentPaths({ env, fsImpl = fs }) {
  const paths = resolveRuntimePaths(env);
  const transcription = getTranscriptionConfig(env);
  const required = [
    paths.dataRoot,
    paths.taskHome,
    paths.stateDir,
    paths.authHome,
    transcription.checkpointDir,
    paths.stageCheckpointDir,
    paths.stageArtifactDir,
  ];
  for (const directory of required) {
    await fsImpl.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsImpl.promises.access(directory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  }
  return { available: true, pathCount: required.length };
}

async function checkBinary({ runCommand, env, binary }) {
  const result = await runCommand(binary, ['-version'], { env, timeout: 10_000 });
  const firstLine = String(result.stdout || result.stderr || '').split(/\r?\n/, 1)[0];
  if (!firstLine.toLowerCase().includes(binary)) {
    throw new Error(`${binary} did not return a valid version.`);
  }
  return { available: true, version: firstLine };
}

async function checkRuntimeConfiguration({ env, runCommand }) {
  const provider = String(env.OKX_A2A_AI_PROVIDER || '').trim();
  if (!provider) throw new Error('OKX_A2A_AI_PROVIDER is required.');
  await runCommand(provider, ['--version'], { env, timeout: 10_000 });
  if (Number(env.OKX_A2A_PROVIDER_AGENT_ID || 6041) !== 6041) {
    throw new Error('ClipAgent production provider identity must be 6041.');
  }
  const transcription = getTranscriptionConfig(env);
  const ranking = getRankingLimits(env);
  if (!transcription.enabled) {
    const error = new Error('Chunked transcription must be enabled.');
    error.code = 'TRANSCRIPTION_CHUNKING_DISABLED';
    throw error;
  }
  if (
    transcription.primaryProvider !== 'groq' ||
    transcription.fallbackProvider !== 'openai'
  ) {
    const error = new Error('Production transcription providers are misconfigured.');
    error.code = 'INVALID_TRANSCRIPTION_CONFIGURATION';
    throw error;
  }
  if (!env.GROQ_API_KEY || !env.OPENAI_API_KEY) {
    const error = new Error(
      'Groq primary and OpenAI fallback credentials are both required.'
    );
    error.code = 'TRANSCRIPTION_PROVIDERS_UNAVAILABLE';
    throw error;
  }
  if (!ranking.enabled) {
    const error = new Error('Ranking context protection must be enabled.');
    error.code = 'RANKING_CONTEXT_PROTECTION_DISABLED';
    throw error;
  }
  return {
    configured: true,
    aiProvider: provider,
    transcription: {
      enabled: transcription.enabled,
      primaryProvider: transcription.primaryProvider,
      fallbackProvider: transcription.fallbackProvider,
      chunkSeconds: transcription.chunkSeconds,
      overlapSeconds: transcription.overlapSeconds,
      primaryModel: transcription.groqModel,
      fallbackModel: transcription.openaiModel,
      groqConfigured: Boolean(env.GROQ_API_KEY),
      openaiConfigured: Boolean(env.OPENAI_API_KEY),
      checkpointDir: transcription.checkpointDir,
      transcriptSchemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    },
    ranking: ranking,
    recovery: {
      stageCheckpointingEnabled: true,
      heartbeatIntervalMs: Number(env.A2A_HEARTBEAT_INTERVAL_MS || 30_000),
      staleMs: Number(env.A2A_PROCESSING_STALE_MS || 1_800_000),
      deliveryRetryEnabled: true,
      supabaseUploadMaxAttempts: Number(env.SUPABASE_UPLOAD_MAX_ATTEMPTS || 4),
    },
  };
}

async function checkServiceMapping({ env, providerServiceId }) {
  const config = getA2aTransportConfig(env);
  const primaryServiceId = Number(providerServiceId);
  if (!config.serviceContracts.has(primaryServiceId)) {
    throw new Error(`A2A service ${providerServiceId} has no purchased-quantity mapping.`);
  }
  const configuredServices = [...config.serviceContracts.values()].map(
    (contract) => ({
      serviceId: contract.serviceId,
      contractVersion: contract.contractVersion,
      clipCount: contract.clipCount,
      pricingModel: contract.pricingModel,
      feeAmount: contract.feeAmount,
      feeCurrency: contract.feeCurrency,
    })
  );
  if (
    configuredServices.length !== config.serviceClipMap.size ||
    configuredServices.some(
      (contract) =>
        config.serviceClipMap.get(contract.serviceId) !== contract.clipCount
    )
  ) {
    throw new Error('Active A2A service contracts and quantity mappings do not match.');
  }
  return {
    serviceId: primaryServiceId,
    contractVersion: config.serviceContracts.get(primaryServiceId).contractVersion,
    clipCount: config.serviceClipMap.get(primaryServiceId),
    configuredServices,
    attachmentPolicy: {
      maximumBytes: config.okxAttachmentMaxBytes,
      maximumSourceDurationSeconds: config.maxDurationSeconds,
      platformMaximumSourceDurationSeconds: MAX_SOURCE_DURATION_SECONDS,
      attachmentCount: 1,
      sourceUrlAccepted: false,
      multipartAccepted: false,
    },
    config,
  };
}

function checkLocalRuntimeContract({ env, providerServiceId }) {
  const config = getA2aTransportConfig(env);
  const contract = config.serviceContracts.get(Number(providerServiceId));
  const failures = [];
  const checks = {};
  const check = (name, ok, code, expected, actual) => {
    checks[name] = { ok, detail: { expected, actual } };
    if (!ok) {
      failures.push({
        code,
        message: `Local ClipAgent ${name} does not match the production contract.`,
        detail: { expected, actual },
      });
    }
  };

  check('contractVersion', contract?.contractVersion === 'clipagent-a2a-37723-v1',
    'LOCAL_CONTRACT_VERSION_MISMATCH', 'clipagent-a2a-37723-v1', contract?.contractVersion);
  check('clipCount', contract?.clipCount === 1,
    'LOCAL_CLIP_COUNT_MISMATCH', 1, contract?.clipCount);
  check('pricingModel', contract?.pricingModel === 'fixed_service_total',
    'LOCAL_PRICING_MODEL_MISMATCH', 'fixed_service_total', contract?.pricingModel);
  check('feeAmount', Number(contract?.feeAmount) === 0.5,
    'LOCAL_FEE_MISMATCH', '0.5', contract?.feeAmount);
  check('feeCurrency', contract?.feeCurrency === 'USDT',
    'LOCAL_CURRENCY_MISMATCH', 'USDT', contract?.feeCurrency);
  check('attachmentLimit', config.okxAttachmentMaxBytes === 1_073_741_824,
    'LOCAL_ATTACHMENT_LIMIT_MISMATCH', 1_073_741_824, config.okxAttachmentMaxBytes);
  check('sourceDuration', config.maxDurationSeconds === 3_600,
    'LOCAL_SOURCE_DURATION_MISMATCH', 3_600, config.maxDurationSeconds);
  check('durationPolicy',
    DEFAULT_MIN_DURATION_SECONDS === 20 && DEFAULT_MAX_DURATION_SECONDS === 45,
    'LOCAL_OUTPUT_DURATION_MISMATCH',
    { minimumSeconds: 20, maximumSeconds: 45 },
    {
      minimumSeconds: DEFAULT_MIN_DURATION_SECONDS,
      maximumSeconds: DEFAULT_MAX_DURATION_SECONDS,
    });

  checks.attachmentPolicy = {
    ok: true,
    detail: {
      officialAttachmentCount: 1,
      sourceUrlAccepted: false,
      multipartAccepted: false,
    },
  };
  checks.deliveryContract = {
    ok: true,
    detail: {
      clipCount: 1,
      publicPlayableUrlRequired: true,
      format: 'vertical MP4',
      sourceTimestampsRequired: true,
      measuredDurationRequired: true,
      selectionReasonRequired: true,
      completionPolicy: 'all_or_nothing',
      buyerSelectableQuantity: false,
    },
  };
  return { ok: failures.length === 0, checks, failures, contract };
}

async function checkDiskCapacity({ env, config, assertDiskCapacity }) {
  const targetPath = ensureUploadDir();
  ensureOutputDir();
  const capacity = await assertDiskCapacity({
    targetPath,
    expectedSourceBytes: config.okxAttachmentMaxBytes,
    multiplier: config.requiredFreeSpaceMultiplier,
  });
  return { targetPath, ...capacity };
}

async function runA2aReadinessChecks(options = {}) {
  const env = options.env || process.env;
  const runCommand = options.runCommand || defaultRunCommand;
  const storageCheck = options.checkStorageReadiness || checkStorageReadiness;
  const assertDiskCapacity =
    options.assertTemporaryDiskCapacity || assertTemporaryDiskCapacity;
  const providerAgentId = Number(env.OKX_A2A_PROVIDER_AGENT_ID || 6041);
  const providerServiceId = Number(env.OKX_A2A_SERVICE_ID || 37723);
  const checks = {};

  async function capture(name, operation) {
    try {
      checks[name] = { ok: true, detail: await operation() };
    } catch (error) {
      checks[name] = {
        ok: false,
        error: String(error.code || error.name || 'READINESS_CHECK_FAILED'),
        message: redactReadinessMessage(error),
      };
    }
  }

  await capture('daemon', () => checkDaemon({ runCommand, env }));
  await capture('configuration', () =>
    checkRuntimeConfiguration({ env, runCommand })
  );
  await capture('identity', () =>
    checkAuthenticatedIdentity({ runCommand, env, providerAgentId })
  );
  await capture('jobState', () =>
    checkWritableJobState({ env, fsImpl: options.fsImpl || fs })
  );
  await capture('persistentPaths', () =>
    checkPersistentPaths({ env, fsImpl: options.fsImpl || fs })
  );
  await capture('ffmpeg', () => checkBinary({ runCommand, env, binary: 'ffmpeg' }));
  await capture('ffprobe', () => checkBinary({ runCommand, env, binary: 'ffprobe' }));
  await capture('storage', () => storageCheck());

  let serviceMapping;
  await capture('serviceMapping', async () => {
    serviceMapping = await checkServiceMapping({ env, providerServiceId });
    const { config, ...detail } = serviceMapping;
    return detail;
  });
  let localContractResult;
  await capture('localContract', async () => {
    localContractResult = checkLocalRuntimeContract({ env, providerServiceId });
    if (!localContractResult.ok) {
      const error = readinessError(
        localContractResult.failures[0].code,
        localContractResult.failures[0].message
      );
      error.failures = localContractResult.failures;
      throw error;
    }
    return {
      checks: localContractResult.checks,
      contract: localContractResult.contract,
    };
  });
  let marketplaceResult;
  try {
    const config = serviceMapping?.config || getA2aTransportConfig(env);
    const contract = config.serviceContracts.get(providerServiceId);
    if (!contract) throw new Error(`A2A service ${providerServiceId} has no local contract.`);
    marketplaceResult = await (options.checkLiveMarketplaceContract || checkLiveMarketplaceContract)({
      runCommand,
      env,
      providerId: providerAgentId,
      serviceContract: contract,
    });
    checks.marketplaceContract = {
      ok: marketplaceResult.ok !== false,
      ...(marketplaceResult.ok === false
        ? {
            error: marketplaceResult.failures?.[0]?.code || 'MARKETPLACE_CONTRACT_MISMATCH',
            message: marketplaceResult.failures?.[0]?.message ||
              'Live marketplace listing does not match ClipAgent.',
          }
        : {}),
      detail: marketplaceResult.detail || marketplaceResult,
    };
  } catch (error) {
    marketplaceResult = {
      ok: false,
      checks: {},
      failures: [{
        code: String(error.code || error.name || 'READINESS_CHECK_FAILED'),
        message: redactReadinessMessage(error),
      }],
      detail: null,
    };
    checks.marketplaceContract = {
      ok: false,
      error: marketplaceResult.failures[0].code,
      message: marketplaceResult.failures[0].message,
    };
  }
  await capture('disk', async () => {
    const config = serviceMapping?.config || getA2aTransportConfig(env);
    return checkDiskCapacity({ env, config, assertDiskCapacity });
  });

  const ready = Object.values(checks).every((check) => check.ok);
  const readiness = classifyReadiness(checks);
  const identityChecks = {
    walletAuthenticated: {
      ok: checks.identity?.ok || false,
    },
    providerOwned: {
      ok: checks.identity?.ok || false,
      ...(checks.identity?.detail
        ? { detail: { agentId: checks.identity.detail.agentId } }
        : {}),
    },
    providerStatus: {
      ok: checks.identity?.ok || false,
      ...(checks.identity?.detail
        ? { detail: { online: checks.identity.detail.online } }
        : {}),
    },
  };
  const runtimeChecks = {
    daemonConnected: checks.daemon,
    configuration: checks.configuration,
    jobState: checks.jobState,
    persistentPaths: checks.persistentPaths,
    ffmpeg: checks.ffmpeg,
    ffprobe: checks.ffprobe,
    storage: checks.storage,
    serviceMapping: checks.serviceMapping,
    disk: checks.disk,
  };
  const localFailures = localContractResult?.failures || (
    checks.localContract?.ok
      ? []
      : [{
          code: checks.localContract?.error || 'LOCAL_CONTRACT_INVALID',
          message: checks.localContract?.message || 'Local contract validation failed.',
        }]
  );
  const infrastructureFailures = Object.entries(checks)
    .filter(([name, check]) =>
      !check.ok &&
      !new Set(['marketplaceContract', 'localContract']).has(name)
    )
    .map(([name, check]) => ({
      code: check.error || 'READINESS_CHECK_FAILED',
      check: name,
      message: check.message,
    }));
  const failures = [
    ...infrastructureFailures,
    ...(marketplaceResult?.failures || []),
    ...localFailures,
  ];
  return {
    ready,
    status: readiness.status,
    message: readiness.message,
    primaryError: failures[0]?.code || null,
    checkedAt: new Date().toISOString(),
    identityChecks,
    runtimeChecks,
    marketplaceChecks: marketplaceResult?.checks || {},
    localContractChecks:
      localContractResult?.checks ||
      checks.localContract?.detail?.checks ||
      {},
    marketplaceCapabilityLimitations: MARKETPLACE_CAPABILITY_LIMITATIONS,
    failures,
    checks,
  };
}

module.exports = {
  runA2aReadinessChecks,
  defaultRunCommand,
  parseAgentResponse,
  checkDaemon,
  checkAuthenticatedIdentity,
  checkWritableJobState,
  checkPersistentPaths,
  checkBinary,
  checkRuntimeConfiguration,
  checkServiceMapping,
  checkLocalRuntimeContract,
  checkDiskCapacity,
  redactReadinessMessage,
  classifyReadiness,
  readinessError,
};
