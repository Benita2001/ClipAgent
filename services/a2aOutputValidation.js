const URL_PROTOCOLS = new Set(['http:', 'https:']);
const DEFAULT_DURATION_TOLERANCE_SECONDS = 1.5;

class A2aOutputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'A2aOutputValidationError';
    this.code = 'INVALID_A2A_OUTPUT';
    this.statusCode = 422;
  }
}

function validPublicUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return URL_PROTOCOLS.has(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

function validateA2aClipResult(result, {
  expectedClipCount,
  minDurationSeconds,
  maxDurationSeconds,
  sourceDurationSeconds = null,
  durationToleranceSeconds = DEFAULT_DURATION_TOLERANCE_SECONDS,
} = {}) {
  if (!Number.isInteger(expectedClipCount) || expectedClipCount < 1) {
    throw new A2aOutputValidationError('A valid expected clip count is required.');
  }
  if (!result || !Array.isArray(result.clips)) {
    throw new A2aOutputValidationError('The pipeline did not return a clips array.');
  }
  if (result.clips.length !== expectedClipCount) {
    throw new A2aOutputValidationError(
      `The pipeline returned ${result.clips.length} clips instead of ${expectedClipCount}.`
    );
  }

  const seenUrls = new Set();
  const seenRanges = new Set();
  const normalized = result.clips.map((clip, index) => {
    if (!validPublicUrl(clip?.url)) {
      throw new A2aOutputValidationError(`Clip ${index + 1} does not have a valid public URL.`);
    }
    const normalizedUrl = new URL(clip.url).toString();
    if (seenUrls.has(normalizedUrl)) {
      throw new A2aOutputValidationError('Clip output URLs must be unique.');
    }
    seenUrls.add(normalizedUrl);

    const startSeconds = Number(clip.startSeconds);
    const endSeconds = Number(clip.endSeconds);
    const durationSeconds = Number(clip.durationSeconds);
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < 0 ||
      endSeconds <= startSeconds
    ) {
      throw new A2aOutputValidationError(
        `Clip ${index + 1} has invalid start or end timestamps.`
      );
    }
    if (
      Number.isFinite(sourceDurationSeconds) &&
      endSeconds > sourceDurationSeconds
    ) {
      throw new A2aOutputValidationError(
        `Clip ${index + 1} ends beyond the source duration.`
      );
    }
    if (
      !Number.isFinite(durationSeconds) ||
      durationSeconds < minDurationSeconds ||
      durationSeconds > maxDurationSeconds
    ) {
      throw new A2aOutputValidationError(
        `Clip ${index + 1} is outside the supported duration range.`
      );
    }
    if (
      Math.abs(durationSeconds - (endSeconds - startSeconds)) >
      durationToleranceSeconds
    ) {
      throw new A2aOutputValidationError(
        `Clip ${index + 1} duration does not match its timestamps.`
      );
    }
    if (typeof clip.reason !== 'string' || !clip.reason.trim()) {
      throw new A2aOutputValidationError(
        `Clip ${index + 1} does not include a selection reason.`
      );
    }

    const rangeKey = `${startSeconds}:${endSeconds}`;
    if (seenRanges.has(rangeKey)) {
      throw new A2aOutputValidationError('Clip timestamp ranges must be unique.');
    }
    seenRanges.add(rangeKey);
    return { startSeconds, endSeconds };
  });

  const chronological = [...normalized].sort(
    (left, right) => left.startSeconds - right.startSeconds
  );
  for (let index = 1; index < chronological.length; index += 1) {
    if (chronological[index].startSeconds < chronological[index - 1].endSeconds) {
      throw new A2aOutputValidationError('Clip timestamp ranges must not overlap.');
    }
  }
  return result;
}

module.exports = {
  A2aOutputValidationError,
  validateA2aClipResult,
  validPublicUrl,
  DEFAULT_DURATION_TOLERANCE_SECONDS,
};
