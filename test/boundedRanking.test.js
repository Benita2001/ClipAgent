const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rankBoundedTranscript,
  requestBytes,
} = require('../services/boundedRankingService');

function segments(count, width = 20) {
  return Array.from({ length: count }, (_, index) => ({
    id: index,
    start: index * 5,
    end: index * 5 + 5,
    text: 'x'.repeat(width),
  }));
}

const ranker = async (input) => ({
  moments: [{
    segment_ids: input.slice(0, 5).map((segment) => segment.id),
    start_time: input[0].start,
    end_time: input[0].start + 25,
    reason: `Strong window candidate ${input[0].start}`,
  }],
  provider: 'test',
  model: 'test',
});

test('short transcript uses direct bounded ranking', async () => {
  const result = await rankBoundedTranscript(segments(10), {
    sourceDurationSeconds: 100,
    limits: {
      enabled: true,
      maxRequestBytes: 10_000,
      windowSeconds: 600,
      maximumCandidates: 12,
      configurationVersion: 'test',
    },
    ranker,
  });
  assert.equal(result.strategy, 'direct');
});

test('long transcript uses bounded windows and preserves absolute timestamps', async () => {
  const input = segments(200, 100);
  const result = await rankBoundedTranscript(input, {
    sourceDurationSeconds: 1_000,
    limits: {
      enabled: true,
      maxRequestBytes: 2_000,
      windowSeconds: 120,
      maximumCandidates: 12,
      configurationVersion: 'test',
    },
    ranker,
  });
  assert.equal(result.strategy, 'windowed');
  assert.ok(result.windowCount > 1);
  assert.ok(result.moments[0].start_time >= 0);
  assert.equal(result.moments[0].end_time - result.moments[0].start_time, 25);
});

test('malformed window ranking uses safe deterministic fallback', async () => {
  const result = await rankBoundedTranscript(segments(100, 100), {
    sourceDurationSeconds: 500,
    limits: {
      enabled: true,
      maxRequestBytes: 2_000,
      windowSeconds: 120,
      maximumCandidates: 12,
      configurationVersion: 'test',
    },
    ranker: async () => ({ moments: [] }),
  });
  assert.equal(result.strategy, 'windowed');
  assert.match(result.moments[0].reason, /self-contained/);
});

test('request-size ceiling rejects a single unbounded segment', async () => {
  const oversized = segments(1, 5_000);
  assert.ok(requestBytes(oversized) > 100);
  await assert.rejects(
    rankBoundedTranscript(oversized, {
      sourceDurationSeconds: 60,
      limits: {
        enabled: true,
        maxRequestBytes: 100,
        windowSeconds: 600,
        maximumCandidates: 12,
        configurationVersion: 'test',
      },
      ranker,
    }),
    (error) => error.code === 'RANKING_CONTEXT_LIMIT_EXCEEDED'
  );
});
