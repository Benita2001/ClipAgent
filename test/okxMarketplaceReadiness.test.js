const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizedLiveContract,
  assertLiveContractMatches,
  checkLiveMarketplaceContract,
} = require('../services/okxMarketplaceReadiness');

const local = {
  serviceId: 37723,
  contractVersion: 'clipagent-a2a-37723-v1',
  clipCount: 1,
  feeAmount: '0.5',
  feeCurrency: 'USDT',
  pricingModel: 'fixed_service_total',
};

function response(overrides = {}) {
  return {
    ok: true,
    data: {
      agentId: 6041,
      list: [{
        serviceList: [{
          serviceId: 37723,
          status: 'active',
          outputQuantity: 1,
          feeAmount: '0.5',
          feeCurrency: 'USDT',
          pricingModel: 'fixed_service_total',
          contractVersion: 'clipagent-a2a-37723-v1',
          buyerSelectableQuantity: false,
          dynamicPricing: false,
          ...overrides,
        }],
      }],
    },
  };
}

test('matching live marketplace service passes', () => {
  const live = normalizedLiveContract(response(), 6041, 37723);
  assert.equal(assertLiveContractMatches(live, local, { providerId: 6041 }).serviceId, 37723);
});

test('hosted CLI numeric id is used instead of the UUID serviceId', () => {
  const hosted = {
    ok: true,
    data: [{
      agentInfo: {
        agentId: '6041',
        approvalStatus: 3,
        status: 2,
      },
      list: [{
        id: 37723,
        serviceId: '9902e45d-4cf0-4f32-af26-4f7445648365',
        serviceName: 'ClipAgent Video Clipping',
        serviceType: 'A2A',
        fee: '0.5',
        subscription: [],
        outputQuantity: 1,
        contractVersion: 'clipagent-a2a-37723-v1',
      }],
    }],
  };
  const live = normalizedLiveContract(hosted, 6041, 37723);
  assert.equal(live.serviceId, '37723');
  assert.equal(live.externalServiceId, '9902e45d-4cf0-4f32-af26-4f7445648365');
  assert.equal(live.providerId, '6041');
  assert.equal(live.status, 'approved');
  assert.equal(live.feeAmount, '0.5');
  assert.equal(live.feeCurrency, 'USDT');
  assert.equal(live.pricingModel, 'fixed_service_total');
  assert.equal(assertLiveContractMatches(live, local, { providerId: 6041 }).serviceId, 37723);
});

test('current hosted response reaches contract validation instead of service-not-found', () => {
  const hosted = {
    ok: true,
    data: [{
      agentInfo: {
        agentId: '6041',
        approvalStatus: 3,
        status: 2,
      },
      list: [{
        id: 37723,
        serviceId: '9902e45d-4cf0-4f32-af26-4f7445648365',
        serviceName: 'ClipAgent Video Clipping',
        serviceType: 'A2A',
        fee: '1',
        subscription: [],
        serviceDescription:
          'Turns one attached long-form video into three engaging social-ready clips.',
      }],
    }],
  };
  const live = normalizedLiveContract(hosted, 6041, 37723);
  assert.equal(live.serviceId, '37723');
  assert.throws(
    () => assertLiveContractMatches(live, local, { providerId: 6041 }),
    (error) => error.code === 'MARKETPLACE_WRONG_QUANTITY'
  );
});

for (const [name, override, code] of [
  ['wrong provider', { providerId: 6071 }, 'MARKETPLACE_WRONG_PROVIDER'],
  ['wrong price', { feeAmount: '1' }, 'MARKETPLACE_WRONG_PRICE'],
  ['wrong currency', { feeCurrency: 'USD' }, 'MARKETPLACE_WRONG_CURRENCY'],
  ['wrong quantity', { outputQuantity: 3 }, 'MARKETPLACE_WRONG_QUANTITY'],
  ['wrong pricing model', { pricingModel: 'per_clip' }, 'MARKETPLACE_WRONG_PRICING_MODEL'],
  ['wrong contract version', { contractVersion: 'old' }, 'MARKETPLACE_WRONG_CONTRACT_VERSION'],
  ['buyer quantity', { buyerSelectableQuantity: true }, 'MARKETPLACE_BUYER_QUANTITY_ENABLED'],
  ['dynamic pricing', { dynamicPricing: true }, 'MARKETPLACE_DYNAMIC_PRICING_ENABLED'],
]) {
  test(`${name} fails marketplace readiness`, () => {
    const live = normalizedLiveContract(response(override), 6041, 37723);
    assert.throws(
      () => assertLiveContractMatches(live, local, { providerId: 6041 }),
      (error) => error.code === code
    );
  });
}

test('wrong or unavailable service fails clearly', async () => {
  assert.throws(
    () => normalizedLiveContract(response({ serviceId: 999 }), 6041, 37723),
    (error) => error.code === 'MARKETPLACE_SERVICE_NOT_FOUND'
  );
  await assert.rejects(
    checkLiveMarketplaceContract({
      runCommand: async () => { throw new Error('secret backend response'); },
      env: {},
      providerId: 6041,
      serviceContract: local,
    }),
    (error) =>
      error.code === 'MARKETPLACE_METADATA_UNAVAILABLE' &&
      !error.message.includes('secret')
  );
});
