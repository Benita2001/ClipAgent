const test = require('node:test');
const assert = require('node:assert/strict');
const {
  withSupabaseRetry,
  isTransientSupabaseError,
} = require('../services/supabaseStorageService');

for (const status of [429, 500, 503]) {
  test(`Supabase HTTP ${status} retries and eventually succeeds`, async () => {
    let calls = 0;
    const result = await withSupabaseRetry(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('temporary'), { statusCode: status });
      return 'ok';
    }, { maxAttempts: 4, baseMs: 1, sleep: async () => {}, random: () => 0 });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });
}

test('network and timeout failures are transient', () => {
  assert.equal(isTransientSupabaseError(new Error('fetch failed: ECONNRESET')), true);
  assert.equal(isTransientSupabaseError(new Error('request timed out')), true);
});

test('permanent authentication failure does not retry', async () => {
  let calls = 0;
  await assert.rejects(
    withSupabaseRetry(async () => {
      calls += 1;
      throw Object.assign(new Error('unauthorized'), { statusCode: 401 });
    }, { maxAttempts: 4, sleep: async () => {} }),
    /unauthorized/
  );
  assert.equal(calls, 1);
});
