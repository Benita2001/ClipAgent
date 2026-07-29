const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MARKETPLACE_CAPABILITY_LIMITATIONS,
  normalizedLiveContract,
  contradictionFindings,
  evaluateLiveMarketplaceListing,
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

function hostedService(overrides = {}) {
  return {
    ok: true,
    data: [{
      agentInfo: {
        agentId: '6041',
        approvalStatus: 3,
        status: 2,
        onlineStatus: 1,
      },
      list: [{
        id: 37723,
        serviceId: '9902e45d-4cf0-4f32-af26-4f7445648365',
        serviceName: 'ClipAgent Video Clipping',
        serviceDescription:
          'Creates exactly one finished social clip from one attached video. Delivers a public playable MP4 with timestamps, duration, and a selection reason.',
        serviceType: 'A2A',
        fee: '0.5',
        subscription: [],
        endpoint: null,
        ...overrides,
      }],
    }],
  };
}

function evaluate(overrides = {}) {
  const live = normalizedLiveContract(hostedService(overrides), 6041, 37723);
  return evaluateLiveMarketplaceListing(live, local, { providerId: 6041 });
}

test('numeric marketplace id finds service and preserves external UUID separately', () => {
  const live = normalizedLiveContract(hostedService(), 6041, 37723);
  assert.equal(live.serviceId, '37723');
  assert.equal(live.externalServiceId, '9902e45d-4cf0-4f32-af26-4f7445648365');
  assert.equal(live.providerId, '6041');
  assert.equal(evaluate().ok, true);
});

test('missing structured contract version and output quantity are capability limitations, not failures', () => {
  const result = evaluate();
  assert.equal(result.ok, true);
  assert.equal('contractVersion' in result.detail, false);
  assert.equal('clipCount' in result.detail, false);
  assert.ok(MARKETPLACE_CAPABILITY_LIMITATIONS.includes('contractVersion'));
  assert.ok(MARKETPLACE_CAPABILITY_LIMITATIONS.includes('structuredOutputQuantity'));
});

test('current hosted price and description return both marketplace failures', () => {
  const result = evaluate({
    fee: '1',
    serviceDescription:
      'Turns one attached long-form video into three engaging social-ready clips. Provide one video attachment, target clip count, preferred duration, platform, and deadline.',
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.failures.map(({ code }) => code),
    [
      'MARKETPLACE_WRONG_PRICE',
      'MARKETPLACE_DESCRIPTION_CONTRADICTS_CONTRACT',
    ]
  );
  assert.deepEqual(
    result.checks.descriptionCompatibility.detail.contradictions,
    ['MULTIPLE_CLIPS_PROMISED', 'BUYER_SELECTED_QUANTITY_PROMISED']
  );
});

test('updated fixed 0.5 USDT one-clip listing passes', () => {
  const result = evaluate();
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.checks.price.ok, true);
  assert.equal(result.checks.descriptionCompatibility.ok, true);
});

test('harmless wording differences do not fail description compatibility', () => {
  for (const description of [
    'Produces a concise vertical highlight with timing metadata.',
    'Attach a supported video and receive a public playable result.',
    'Optional platform and tone instructions help guide selection.',
  ]) {
    assert.deepEqual(contradictionFindings(description), []);
    assert.equal(evaluate({ serviceDescription: description }).ok, true);
  }
});

test('explicit quantity, buyer selection, and guaranteed deadline promises are contradictions', () => {
  assert.deepEqual(contradictionFindings(
    'Get 3 clips, choose the clip quantity, with a guaranteed deadline.'
  ), [
    'MULTIPLE_CLIPS_PROMISED',
    'BUYER_SELECTED_QUANTITY_PROMISED',
    'GUARANTEED_DEADLINE_PROMISED',
  ]);
  assert.deepEqual(
    contradictionFindings('Creates exactly two finished social clips.'),
    ['MULTIPLE_CLIPS_PROMISED']
  );
});

for (const [name, override, code] of [
  ['wrong provider', { providerId: 6071 }, 'MARKETPLACE_WRONG_PROVIDER'],
  ['wrong price', { fee: '1' }, 'MARKETPLACE_WRONG_PRICE'],
  ['wrong currency', { feeCurrency: 'USD' }, 'MARKETPLACE_WRONG_CURRENCY'],
  ['subscription pricing', {
    fee: '',
    subscription: [{ interval: 'month', fee: '10' }],
  }, 'MARKETPLACE_WRONG_PRICING_MODEL'],
  ['incorrect service type', { serviceType: 'A2MCP' }, 'MARKETPLACE_WRONG_SERVICE_TYPE'],
  ['legacy endpoint', { endpoint: 'https://example.com/clip' }, 'MARKETPLACE_WRONG_ENDPOINT'],
]) {
  test(`${name} fails marketplace listing readiness`, () => {
    const result = evaluate(override);
    const failure = result.failures.find((item) => item.code === code);
    assert.ok(failure);
    if (code === 'MARKETPLACE_WRONG_CURRENCY') {
      assert.deepEqual(failure.detail, { expected: 'USDT', actual: 'USD' });
    }
  });
}

test('missing service and unavailable metadata fail clearly without exposing command errors', async () => {
  const missing = await checkLiveMarketplaceContract({
    runCommand: async () => ({
      stdout: JSON.stringify(hostedService({ id: 999 })),
    }),
    env: {},
    providerId: 6041,
    serviceContract: local,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.failures[0].code, 'MARKETPLACE_SERVICE_NOT_FOUND');

  const unavailable = await checkLiveMarketplaceContract({
    runCommand: async () => {
      throw new Error('secret backend response');
    },
    env: {},
    providerId: 6041,
    serviceContract: local,
  });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.failures[0].code, 'MARKETPLACE_METADATA_UNAVAILABLE');
  assert.equal(JSON.stringify(unavailable).includes('secret'), false);
});
