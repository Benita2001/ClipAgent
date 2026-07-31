const DEFAULT_MARKETPLACE_METADATA = Object.freeze({
  serviceType: 'A2A',
  endpointMode: 'daemon',
});

const DEVELOPMENT_IDENTITY = Object.freeze({
  providerId: 91001,
  serviceId: 92001,
  contractName: 'clipagent-a2a-development-v1',
  marketplaceEnvironment: 'development',
  marketplaceMetadata: DEFAULT_MARKETPLACE_METADATA,
});

class MarketplaceIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketplaceIdentityError';
    this.code = code;
    this.statusCode = 503;
  }
}

function isExplicitNonProduction(env = process.env) {
  return ['development', 'test'].includes(
    String(env.NODE_ENV || process.env.NODE_ENV || '').trim().toLowerCase()
  );
}

function positiveId(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MarketplaceIdentityError(
      'MARKETPLACE_IDENTITY_MISSING',
      `${name} must be configured as a positive integer.`
    );
  }
  return parsed;
}

function contractName(value) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{3,100}$/.test(normalized)) {
    throw new MarketplaceIdentityError(
      'MARKETPLACE_IDENTITY_MISSING',
      'OKX_A2A_CONTRACT_NAME must define a stable contract name.'
    );
  }
  return normalized;
}

function marketplaceEnvironment(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,50}$/.test(normalized)) {
    throw new MarketplaceIdentityError(
      'MARKETPLACE_IDENTITY_MISSING',
      'OKX_MARKETPLACE_ENVIRONMENT must be configured.'
    );
  }
  return normalized;
}

function parseMarketplaceMetadata(value, fallback = DEFAULT_MARKETPLACE_METADATA) {
  if (value === undefined || value === null || value === '') return { ...fallback };
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new MarketplaceIdentityError(
        'INVALID_MARKETPLACE_METADATA',
        'OKX_A2A_MARKETPLACE_METADATA must be valid JSON.'
      );
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MarketplaceIdentityError(
      'INVALID_MARKETPLACE_METADATA',
      'OKX_A2A_MARKETPLACE_METADATA must be a JSON object.'
    );
  }
  const serviceType = String(parsed.serviceType || 'A2A').trim().toUpperCase();
  const endpointMode = String(parsed.endpointMode || 'daemon').trim().toLowerCase();
  if (serviceType !== 'A2A') {
    throw new MarketplaceIdentityError(
      'INVALID_MARKETPLACE_METADATA',
      'ClipAgent marketplace metadata must declare the A2A service type.'
    );
  }
  if (endpointMode !== 'daemon') {
    throw new MarketplaceIdentityError(
      'INVALID_MARKETPLACE_METADATA',
      'ClipAgent marketplace metadata must declare daemon endpoint mode.'
    );
  }
  return {
    ...parsed,
    serviceType,
    endpointMode,
  };
}

function getMarketplaceIdentity(env = process.env) {
  const allowDefaults = isExplicitNonProduction(env);
  const defaults = allowDefaults ? DEVELOPMENT_IDENTITY : {};
  return Object.freeze({
    providerId: positiveId(
      env.OKX_A2A_PROVIDER_AGENT_ID ?? defaults.providerId,
      'OKX_A2A_PROVIDER_AGENT_ID'
    ),
    serviceId: positiveId(
      env.OKX_A2A_SERVICE_ID ?? defaults.serviceId,
      'OKX_A2A_SERVICE_ID'
    ),
    contractName: contractName(
      env.OKX_A2A_CONTRACT_NAME ?? defaults.contractName
    ),
    marketplaceEnvironment: marketplaceEnvironment(
      env.OKX_MARKETPLACE_ENVIRONMENT ?? defaults.marketplaceEnvironment
    ),
    marketplaceMetadata: Object.freeze(parseMarketplaceMetadata(
      env.OKX_A2A_MARKETPLACE_METADATA,
      defaults.marketplaceMetadata || DEFAULT_MARKETPLACE_METADATA
    )),
  });
}

module.exports = {
  DEVELOPMENT_IDENTITY,
  DEFAULT_MARKETPLACE_METADATA,
  MarketplaceIdentityError,
  getMarketplaceIdentity,
  isExplicitNonProduction,
  parseMarketplaceMetadata,
};
