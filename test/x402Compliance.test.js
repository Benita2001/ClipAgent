const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MAX_TIMEOUT_SECONDS,
  readMaxTimeoutSeconds,
} = require('../services/x402Config');
const { getMarketplacePolicy } = require('../services/marketplacePolicy');

test('x402 timeout defaults to the official 300-second example', () => {
  assert.equal(DEFAULT_MAX_TIMEOUT_SECONDS, 300);
  assert.equal(readMaxTimeoutSeconds(undefined), 300);
  assert.equal(readMaxTimeoutSeconds(''), 300);
  assert.equal(readMaxTimeoutSeconds('300'), 300);
});

test('x402 timeout rejects invalid configured values clearly', () => {
  for (const value of ['0', '-1', '1.5', 'not-a-number']) {
    assert.throws(
      () => readMaxTimeoutSeconds(value),
      /X402_MAX_TIMEOUT_SECONDS must be configured as a positive integer/
    );
  }
});

test('benchmark processing timeout reserves settlement time within x402 authorization timeout', () => {
  assert.deepEqual(
    getMarketplacePolicy({
      MARKETPLACE_PROCESSING_TIMEOUT_SECONDS: '2400',
      MARKETPLACE_MAX_VIDEO_DURATION_SECONDS: '4800',
      X402_MAX_TIMEOUT_SECONDS: '3000',
    }),
    {
      maxVideoDurationSeconds: 4800,
      processingTimeoutMs: 2400000,
    }
  );

  assert.throws(
    () => getMarketplacePolicy({
      MARKETPLACE_PROCESSING_TIMEOUT_SECONDS: '3001',
      MARKETPLACE_MAX_VIDEO_DURATION_SECONDS: '4800',
      X402_MAX_TIMEOUT_SECONDS: '3000',
    }),
    /must not exceed X402_MAX_TIMEOUT_SECONDS/
  );
});
