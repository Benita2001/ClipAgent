const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_A2A_SERVICE_CONTRACTS,
  parseOkxA2aServiceContracts,
  getActiveOkxA2aServiceContracts,
} = require('../config/okxA2aServiceContracts');

test('service 37723 is the active one-clip fixed 0.5 USDT contract', () => {
  const contract = DEFAULT_A2A_SERVICE_CONTRACTS[37723];
  assert.deepEqual(contract, {
    serviceId: 37723,
    active: true,
    contractVersion: 'clipagent-a2a-37723-v1',
    clipCount: 1,
    pricingModel: 'fixed_service_total',
    feeAmount: '0.5',
    feeCurrency: 'USDT',
  });
});

test('service contracts support multiple active fixed-price service variants', () => {
  const contracts = parseOkxA2aServiceContracts({
    90001: {
      active: true,
      contractVersion: 'test-one-v1',
      clipCount: 1,
      pricingModel: 'fixed_service_total',
      feeAmount: '0.5',
      feeCurrency: 'USDT',
    },
    90002: {
      active: true,
      contractVersion: 'test-two-v1',
      clipCount: 2,
      pricingModel: 'fixed_service_total',
      feeAmount: '1',
      feeCurrency: 'USDT',
    },
  });
  assert.equal(contracts.get(90001).clipCount, 1);
  assert.equal(contracts.get(90002).feeAmount, '1');
});

test('service contracts reject invalid quantities, pricing, and versions', () => {
  const base = {
    active: true,
    contractVersion: 'test-v1',
    clipCount: 1,
    pricingModel: 'fixed_service_total',
    feeAmount: '0.5',
    feeCurrency: 'USDT',
  };
  assert.throws(
    () => parseOkxA2aServiceContracts({ 1: { ...base, clipCount: 4 } }),
    /1, 2, or 3/
  );
  assert.throws(
    () => parseOkxA2aServiceContracts({ 1: { ...base, feeAmount: '0.3333333' } }),
    /six decimal/
  );
  assert.throws(
    () => parseOkxA2aServiceContracts({ 1: { ...base, contractVersion: '' } }),
    /contractVersion/
  );
});

test('legacy quantity map must match the active contract source of truth', () => {
  assert.throws(
    () => getActiveOkxA2aServiceContracts({
      OKX_A2A_SERVICE_CLIP_MAP: '{"37723":2}',
    }),
    (error) => error.code === 'A2A_SERVICE_CONTRACT_MAP_MISMATCH'
  );
});
