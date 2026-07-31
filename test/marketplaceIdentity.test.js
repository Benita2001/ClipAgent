const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEVELOPMENT_IDENTITY,
  getMarketplaceIdentity,
} = require('../config/marketplaceIdentity');

test('production marketplace identity requires explicit provider, service, contract, and environment', () => {
  assert.throws(
    () => getMarketplaceIdentity({ NODE_ENV: 'production' }),
    (error) => error.code === 'MARKETPLACE_IDENTITY_MISSING'
  );
});

test('marketplace identity accepts arbitrary configured provider and service IDs', () => {
  const identity = getMarketplaceIdentity({
    NODE_ENV: 'production',
    OKX_A2A_PROVIDER_AGENT_ID: '73001',
    OKX_A2A_SERVICE_ID: '74001',
    OKX_A2A_CONTRACT_NAME: 'clipagent-a2a-market-v1',
    OKX_MARKETPLACE_ENVIRONMENT: 'production',
    OKX_A2A_MARKETPLACE_METADATA:
      '{"serviceType":"A2A","endpointMode":"daemon","serviceName":"ClipAgent"}',
  });
  assert.deepEqual(identity, {
    providerId: 73001,
    serviceId: 74001,
    contractName: 'clipagent-a2a-market-v1',
    marketplaceEnvironment: 'production',
    marketplaceMetadata: {
      serviceType: 'A2A',
      endpointMode: 'daemon',
      serviceName: 'ClipAgent',
    },
  });
});

test('development defaults require an explicit non-production environment', () => {
  assert.deepEqual(
    getMarketplaceIdentity({ NODE_ENV: 'development' }),
    DEVELOPMENT_IDENTITY
  );
  assert.throws(
    () => getMarketplaceIdentity({}),
    (error) => error.code === 'MARKETPLACE_IDENTITY_MISSING'
  );
});

test('marketplace metadata rejects a non-A2A or endpoint-backed identity', () => {
  const base = {
    NODE_ENV: 'production',
    OKX_A2A_PROVIDER_AGENT_ID: '73001',
    OKX_A2A_SERVICE_ID: '74001',
    OKX_A2A_CONTRACT_NAME: 'clipagent-a2a-market-v1',
    OKX_MARKETPLACE_ENVIRONMENT: 'production',
  };
  assert.throws(
    () => getMarketplaceIdentity({
      ...base,
      OKX_A2A_MARKETPLACE_METADATA:
        '{"serviceType":"A2MCP","endpointMode":"daemon"}',
    }),
    (error) => error.code === 'INVALID_MARKETPLACE_METADATA'
  );
  assert.throws(
    () => getMarketplaceIdentity({
      ...base,
      OKX_A2A_MARKETPLACE_METADATA:
        '{"serviceType":"A2A","endpointMode":"http"}',
    }),
    (error) => error.code === 'INVALID_MARKETPLACE_METADATA'
  );
});
