const {
  parseOkxA2aServiceClipMap,
} = require('./okxA2aServiceClipMap');

const DEFAULT_A2A_SERVICE_CONTRACTS = Object.freeze({
  37723: Object.freeze({
    serviceId: 37723,
    active: true,
    contractVersion: 'clipagent-a2a-37723-v1',
    clipCount: 1,
    pricingModel: 'fixed_service_total',
    feeAmount: '0.5',
    feeCurrency: 'USDT',
  }),
});

class OkxA2aServiceContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OkxA2aServiceContractError';
    this.code = code;
    this.statusCode = 503;
  }
}

function normalizeFeeAmount(value, serviceId) {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(text)) {
    throw new OkxA2aServiceContractError(
      'INVALID_A2A_SERVICE_FEE',
      `Service ${serviceId} must define a fixed USDT fee with at most six decimal places.`
    );
  }
  return text;
}

function normalizeContract(rawServiceId, rawContract) {
  const serviceId = Number(rawServiceId);
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    throw new OkxA2aServiceContractError(
      'INVALID_A2A_SERVICE_CONTRACT',
      `Invalid A2A service contract ID "${rawServiceId}".`
    );
  }
  if (!rawContract || typeof rawContract !== 'object' || Array.isArray(rawContract)) {
    throw new OkxA2aServiceContractError(
      'INVALID_A2A_SERVICE_CONTRACT',
      `Service ${serviceId} must define an object contract.`
    );
  }
  const clipCount = Number(rawContract.clipCount);
  if (!Number.isInteger(clipCount) || clipCount < 1 || clipCount > 3) {
    throw new OkxA2aServiceContractError(
      'INVALID_A2A_SERVICE_CONTRACT',
      `Service ${serviceId} must purchase 1, 2, or 3 clips.`
    );
  }
  const contractVersion = String(rawContract.contractVersion || '').trim();
  if (!/^[A-Za-z0-9._-]{3,100}$/.test(contractVersion)) {
    throw new OkxA2aServiceContractError(
      'INVALID_A2A_SERVICE_CONTRACT_VERSION',
      `Service ${serviceId} must define a stable contractVersion.`
    );
  }
  if (rawContract.pricingModel !== 'fixed_service_total') {
    throw new OkxA2aServiceContractError(
      'INVALID_A2A_SERVICE_PRICING_MODEL',
      `Service ${serviceId} must use fixed_service_total pricing.`
    );
  }
  const feeCurrency = String(rawContract.feeCurrency || '').trim().toUpperCase();
  if (feeCurrency !== 'USDT') {
    throw new OkxA2aServiceContractError(
      'INVALID_A2A_SERVICE_FEE_CURRENCY',
      `Service ${serviceId} must use USDT pricing.`
    );
  }
  return Object.freeze({
    serviceId,
    active: rawContract.active !== false,
    contractVersion,
    clipCount,
    pricingModel: 'fixed_service_total',
    feeAmount: normalizeFeeAmount(rawContract.feeAmount, serviceId),
    feeCurrency,
  });
}

function parseOkxA2aServiceContracts(rawValue, {
  fallback = DEFAULT_A2A_SERVICE_CONTRACTS,
} = {}) {
  const candidate =
    rawValue === undefined || rawValue === null || rawValue === ''
      ? fallback
      : rawValue;
  let parsed = candidate;
  if (typeof candidate === 'string') {
    try {
      parsed = JSON.parse(candidate);
    } catch {
      throw new OkxA2aServiceContractError(
        'INVALID_A2A_SERVICE_CONTRACTS',
        'OKX_A2A_SERVICE_CONTRACTS must be valid JSON.'
      );
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OkxA2aServiceContractError(
      'INVALID_A2A_SERVICE_CONTRACTS',
      'OKX_A2A_SERVICE_CONTRACTS must be a JSON object keyed by service ID.'
    );
  }
  const contracts = new Map(
    Object.entries(parsed).map(([serviceId, contract]) => [
      Number(serviceId),
      normalizeContract(serviceId, contract),
    ])
  );
  if (![...contracts.values()].some((contract) => contract.active)) {
    throw new OkxA2aServiceContractError(
      'NO_ACTIVE_A2A_SERVICE_CONTRACTS',
      'At least one A2A service contract must be active.'
    );
  }
  return contracts;
}

function assertLegacyClipMapMatchesContracts(rawClipMap, contracts) {
  if (rawClipMap === undefined || rawClipMap === null || rawClipMap === '') return;
  const legacyMap = parseOkxA2aServiceClipMap(rawClipMap);
  const activeContracts = [...contracts.values()].filter((contract) => contract.active);
  if (
    legacyMap.size !== activeContracts.length ||
    activeContracts.some(
      (contract) => legacyMap.get(contract.serviceId) !== contract.clipCount
    )
  ) {
    throw new OkxA2aServiceContractError(
      'A2A_SERVICE_CONTRACT_MAP_MISMATCH',
      'OKX_A2A_SERVICE_CLIP_MAP does not match the active A2A service contracts.'
    );
  }
}

function getOkxA2aServiceContracts(env = process.env) {
  const contracts = parseOkxA2aServiceContracts(
    env.OKX_A2A_SERVICE_CONTRACTS
  );
  assertLegacyClipMapMatchesContracts(env.OKX_A2A_SERVICE_CLIP_MAP, contracts);
  return contracts;
}

function getActiveOkxA2aServiceContracts(env = process.env) {
  return new Map(
    [...getOkxA2aServiceContracts(env)]
      .filter(([, contract]) => contract.active)
  );
}

function resolveOkxA2aServiceContract(contracts, serviceId) {
  const numericServiceId = Number(serviceId);
  return contracts?.get(numericServiceId) || null;
}

module.exports = {
  DEFAULT_A2A_SERVICE_CONTRACTS,
  OkxA2aServiceContractError,
  parseOkxA2aServiceContracts,
  getOkxA2aServiceContracts,
  getActiveOkxA2aServiceContracts,
  resolveOkxA2aServiceContract,
  assertLegacyClipMapMatchesContracts,
  normalizeFeeAmount,
};
