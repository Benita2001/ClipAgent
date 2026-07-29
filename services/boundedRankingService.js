const { rankMoments } = require('./rankingService');
const { constrainRankedMoments } = require('./clipMomentConstraints');

const RANKING_CONFIGURATION_VERSION = 'clipagent-ranking-windowed-v1';

function readPositive(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getRankingLimits(env = process.env) {
  return {
    enabled: String(env.RANKING_CONTEXT_PROTECTION_ENABLED || 'true').toLowerCase() === 'true',
    maxRequestBytes: readPositive(env.RANKING_MAX_REQUEST_BYTES, 400_000),
    windowSeconds: readPositive(env.RANKING_WINDOW_SECONDS, 600),
    maximumCandidates: readPositive(env.RANKING_MAX_CANDIDATES, 12),
    configurationVersion:
      env.RANKING_CONFIGURATION_VERSION || RANKING_CONFIGURATION_VERSION,
  };
}

function requestBytes(segments, instructions = '') {
  return Buffer.byteLength(JSON.stringify({ segments, instructions }), 'utf8');
}

function windowTranscript(segments, limits) {
  const windows = [];
  let current = [];
  let windowStart = null;
  for (const segment of segments) {
    const start = Number(segment.start);
    const end = Number(segment.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    if (windowStart === null) windowStart = start;
    const exceedsDuration = end - windowStart > limits.windowSeconds;
    const exceedsBytes =
      current.length > 0 &&
      requestBytes([...current, segment]) > limits.maxRequestBytes;
    if (exceedsDuration || exceedsBytes) {
      windows.push(current);
      current = [];
      windowStart = start;
    }
    current.push(segment);
    if (requestBytes(current) > limits.maxRequestBytes) {
      const error = new Error('A single ranking segment exceeds the configured request-size ceiling.');
      error.code = 'RANKING_CONTEXT_LIMIT_EXCEEDED';
      throw error;
    }
  }
  if (current.length) windows.push(current);
  return windows;
}

function deterministicCandidate(segments, sourceDurationSeconds) {
  for (let startIndex = 0; startIndex < segments.length; startIndex += 1) {
    const start = Math.max(0, Number(segments[startIndex].start));
    for (let endIndex = startIndex; endIndex < segments.length; endIndex += 1) {
      const end = Math.min(sourceDurationSeconds, Number(segments[endIndex].end));
      const duration = end - start;
      if (duration >= 20 && duration <= 45) {
        return {
          segment_ids: segments.slice(startIndex, endIndex + 1).map((segment) => segment.id),
          start_time: start,
          end_time: end,
          reason: 'Selected as a clear, self-contained segment within the purchased duration range.',
        };
      }
      if (duration > 45) break;
    }
  }
  return null;
}

async function rankBoundedTranscript(segments, {
  sourceDurationSeconds,
  instructions = '',
  clipCount = 1,
  env = process.env,
  limits = getRankingLimits(env),
  ranker = rankMoments,
} = {}) {
  if (!limits.enabled) {
    const error = new Error('Ranking context protection must be enabled.');
    error.code = 'RANKING_CONTEXT_PROTECTION_DISABLED';
    throw error;
  }
  const run = async (candidateSegments) => {
    if (requestBytes(candidateSegments, instructions) > limits.maxRequestBytes) {
      const error = new Error('Ranking request exceeds the configured request-size ceiling.');
      error.code = 'RANKING_CONTEXT_LIMIT_EXCEEDED';
      throw error;
    }
    return ranker(candidateSegments, { instructions, clipCount: 1 });
  };
  if (requestBytes(segments, instructions) <= limits.maxRequestBytes) {
    const ranked = await run(segments);
    return {
      ...constrainRankedMoments(ranked, {
        clipCount,
        minDurationSeconds: 20,
        maxDurationSeconds: 45,
      }, sourceDurationSeconds),
      strategy: 'direct',
      requestBytes: requestBytes(segments, instructions),
      configurationVersion: limits.configurationVersion,
    };
  }

  const windows = windowTranscript(segments, limits);
  const candidates = [];
  for (const window of windows) {
    let candidate;
    try {
      // eslint-disable-next-line no-await-in-loop
      const ranked = await run(window);
      candidate = constrainRankedMoments(ranked, {
        clipCount: 1,
        minDurationSeconds: 20,
        maxDurationSeconds: 45,
      }, sourceDurationSeconds).moments[0];
    } catch {
      candidate = deterministicCandidate(window, sourceDurationSeconds);
    }
    if (candidate) candidates.push(candidate);
  }
  if (!candidates.length) {
    const error = new Error('No valid 20–45 second candidate could be ranked.');
    error.code = 'NO_MATCHING_CLIPS';
    throw error;
  }
  const strongest = candidates
    .slice(0, limits.maximumCandidates)
    .sort((left, right) =>
      String(right.reason).length - String(left.reason).length ||
      left.start_time - right.start_time
    )[0];
  return {
    moments: [strongest],
    provider: 'bounded-window-ranking',
    model: 'window-primary-with-deterministic-final-selection',
    rankingModel: 'bounded-window-ranking',
    strategy: 'windowed',
    windowCount: windows.length,
    candidateCount: candidates.length,
    configurationVersion: limits.configurationVersion,
  };
}

module.exports = {
  RANKING_CONFIGURATION_VERSION,
  getRankingLimits,
  requestBytes,
  windowTranscript,
  deterministicCandidate,
  rankBoundedTranscript,
};
