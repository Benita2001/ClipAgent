const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseOkxA2aServiceClipMap,
  resolveServiceClipCount,
} = require('../config/okxA2aServiceClipMap');

test('parses a valid A2A service-to-clip mapping', () => {
  const map = parseOkxA2aServiceClipMap('{"92001":1,"37724":2,"37725":3}');
  assert.equal(resolveServiceClipCount(map, 92001), 1);
  assert.equal(resolveServiceClipCount(map, 37724), 2);
  assert.equal(resolveServiceClipCount(map, 37725), 3);
});

test('rejects malformed A2A service-map JSON', () => {
  assert.throws(() => parseOkxA2aServiceClipMap('{bad-json'), /valid JSON/);
});

test('rejects service-map entries below one clip or above three clips', () => {
  assert.throws(() => parseOkxA2aServiceClipMap('{"92001":0}'), /must map to 1, 2, or 3/);
  assert.throws(() => parseOkxA2aServiceClipMap('{"92001":4}'), /must map to 1, 2, or 3/);
});

test('rejects non-integer service ids', () => {
  assert.throws(() => parseOkxA2aServiceClipMap('{"abc":1}'), /positive integers/);
});
