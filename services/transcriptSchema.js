const TRANSCRIPT_SCHEMA_VERSION = 'clipagent-transcript-v1';

class TranscriptValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TranscriptValidationError';
    this.code = 'INVALID_TRANSCRIPT_TIMESTAMPS';
    this.statusCode = 502;
  }
}

function confidenceFields(segment) {
  const confidence = {};
  for (const key of [
    'avg_logprob',
    'no_speech_prob',
    'compression_ratio',
    'confidence',
  ]) {
    if (Number.isFinite(Number(segment?.[key]))) {
      confidence[key] = Number(segment[key]);
    }
  }
  return confidence;
}

function normalizeProviderTranscript(raw, {
  chunk,
  provider,
  model,
  suppliedLanguage = null,
} = {}) {
  const language =
    String(raw?.language || suppliedLanguage || '').trim() || null;
  const rawSegments = Array.isArray(raw?.segments) ? raw.segments : [];
  if (rawSegments.length === 0) {
    const error = new TranscriptValidationError(
      'Transcription provider returned no timestamped segments.'
    );
    error.code = 'TRANSCRIPT_SEGMENTS_MISSING';
    throw error;
  }
  let previousRelativeEnd = 0;
  const segments = rawSegments.map((segment, index) => {
    const relativeStart = Number(segment.start);
    const relativeEnd = Number(segment.end);
    if (
      !Number.isFinite(relativeStart) ||
      !Number.isFinite(relativeEnd) ||
      relativeStart < 0 ||
      relativeEnd <= relativeStart ||
      relativeStart < previousRelativeEnd - 0.05 ||
      relativeEnd > chunk.extractionDurationSeconds + 1
    ) {
      throw new TranscriptValidationError(
        `Chunk ${chunk.index} returned impossible or backward timestamps.`
      );
    }
    previousRelativeEnd = relativeEnd;
    return {
      id: index,
      text: String(segment.text || '').trim(),
      relativeStart,
      relativeEnd,
      absoluteStart: chunk.extractionStartSeconds + relativeStart,
      absoluteEnd: chunk.extractionStartSeconds + relativeEnd,
      chunkIndex: chunk.index,
      provider,
      model,
      language,
      confidence: confidenceFields(segment),
    };
  });
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    chunkIndex: chunk.index,
    logicalStartSeconds: chunk.logicalStartSeconds,
    logicalEndSeconds: chunk.logicalEndSeconds,
    provider,
    model,
    language,
    text: String(raw?.text || segments.map((segment) => segment.text).join(' ')).trim(),
    segments,
  };
}

function normalizeText(value) {
  return String(value || '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function removeOverlappingText(previousText, candidateText) {
  const previousTokens = normalizeText(previousText).split(' ').filter(Boolean);
  const candidateTokens = normalizeText(candidateText).split(' ').filter(Boolean);
  const originalCandidateTokens = String(candidateText || '').trim().split(/\s+/);
  const maximum = Math.min(previousTokens.length, candidateTokens.length);
  for (let count = maximum; count > 0; count -= 1) {
    if (
      previousTokens.slice(-count).join(' ') ===
      candidateTokens.slice(0, count).join(' ')
    ) {
      return originalCandidateTokens.slice(count).join(' ').trim();
    }
  }
  return String(candidateText || '').trim();
}

function mergeChunkTranscripts(chunkTranscripts, { sourceDurationSeconds } = {}) {
  const orderedChunks = [...chunkTranscripts].sort(
    (left, right) => left.chunkIndex - right.chunkIndex
  );
  const merged = [];
  for (const transcript of orderedChunks) {
    for (const segment of transcript.segments) {
      const candidate = { ...segment };
      if (
        transcript.chunkIndex > 0 &&
        Number.isFinite(transcript.logicalStartSeconds) &&
        candidate.absoluteEnd <= transcript.logicalStartSeconds
      ) {
        continue;
      }
      if (
        candidate.absoluteStart < 0 ||
        candidate.absoluteEnd <= candidate.absoluteStart ||
        candidate.absoluteEnd > sourceDurationSeconds + 1
      ) {
        throw new TranscriptValidationError(
          `Chunk ${segment.chunkIndex} contains a timestamp outside the source.`
        );
      }
      const previous = merged.at(-1);
      if (previous) {
        const overlaps = candidate.absoluteStart < previous.absoluteEnd;
        const sameText =
          normalizeText(candidate.text) &&
          normalizeText(candidate.text) === normalizeText(previous.text);
        if (overlaps && sameText) continue;
        if (candidate.absoluteStart < previous.absoluteEnd) {
          if (candidate.absoluteEnd <= previous.absoluteEnd) continue;
          candidate.text = removeOverlappingText(
            previous.text,
            candidate.text
          );
          if (!candidate.text) continue;
          candidate.absoluteStart = previous.absoluteEnd;
        }
        if (candidate.absoluteEnd <= candidate.absoluteStart) continue;
      }
      merged.push({ ...candidate, id: merged.length });
    }
  }
  if (merged.length === 0) {
    throw new TranscriptValidationError('Merged transcription is empty.');
  }
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    language:
      orderedChunks.map((chunk) => chunk.language).find(Boolean) || null,
    text: merged.map((segment) => segment.text).join(' ').trim(),
    duration: sourceDurationSeconds,
    segments: merged.map((segment, id) => ({
      ...segment,
      id,
      start: segment.absoluteStart,
      end: segment.absoluteEnd,
    })),
  };
}

module.exports = {
  TRANSCRIPT_SCHEMA_VERSION,
  TranscriptValidationError,
  normalizeProviderTranscript,
  mergeChunkTranscripts,
  normalizeText,
  removeOverlappingText,
};
