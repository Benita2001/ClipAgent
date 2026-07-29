const { execFile } = require('child_process');
const { readTimeoutMs } = require('../utils/providerTimeout');
const FFPROBE_TIMEOUT_MS = readTimeoutMs(process.env.FFPROBE_TIMEOUT_MS, 30_000);

/**
 * Real, empirically measured bytes/sec for our fixed extraction encoding
 * (mono, 16kHz, 64kbps AAC — see audioExtractionService.js). Measured from
 * a genuine 949.7s natural-speech video (8,271,470 bytes extracted) AND
 * confirmed stable (69.6kbps reported by ffmpeg) across four independent
 * synthetic durations (20/30/50/60 min) — low variance, safe to rely on.
 */
const MEASURED_BYTES_PER_SECOND = 8710;

/**
 * Groq's documented free-tier Whisper file-size cap (console.groq.com/docs,
 * checked live in Phase 2). We deliberately anchor to this DOCUMENTED number
 * rather than the higher ~31MB we saw actually produce a clean 413 in live
 * testing — the ~25-26MB zone gave an ambiguous Cloudflare 524 timeout,
 * likely confounded by pathologically repetitive test audio (looped source)
 * rather than a clean size rejection, so we don't have a byte-precise
 * measured ceiling in that zone. Staying under the documented promise is the
 * safer bet for something we can't re-verify without more (unrepetitive)
 * long-form test content.
 */
const GROQ_FREE_TIER_MAX_AUDIO_BYTES = 25_000_000;

// Marketplace input-contract ceiling. This is intentionally independent of
// the current transcription plan's smaller effective upload capacity; callers
// must still surface provider-capacity failures rather than claiming that every
// accepted 60-minute source is guaranteed to transcribe.
const MAX_SOURCE_DURATION_SECONDS = 3600; // exactly 60 minutes

class VideoStreamRequiredError extends Error {
  constructor(cause) {
    super('The supplied media does not contain a valid video stream.', { cause });
    this.name = 'VideoStreamRequiredError';
    this.code = 'VIDEO_STREAM_REQUIRED';
    this.statusCode = 400;
  }
}

function probeMedia(filePath, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,duration:stream_disposition=attached_pic',
      '-of',
      'json',
      filePath,
    ];
    const callback = (error, stdout) => {
        if (error) {
          if (error.code === 'ENOENT') {
            reject(new Error('ffprobe is not installed or not on PATH.'));
            return;
          }
          reject(new VideoStreamRequiredError(error));
          return;
        }

        let metadata;
        try {
          metadata = JSON.parse(stdout);
        } catch (parseError) {
          reject(new VideoStreamRequiredError(parseError));
          return;
        }

        if (!metadata || typeof metadata !== 'object' || !Array.isArray(metadata.streams)) {
          reject(new VideoStreamRequiredError(new Error('ffprobe returned incomplete metadata.')));
          return;
        }

        const videoStreams = metadata.streams.filter(
          (stream) =>
            stream?.codec_type === 'video' &&
            Number(stream.disposition?.attached_pic || 0) !== 1
        );
        if (videoStreams.length === 0) {
          reject(new VideoStreamRequiredError(new Error('ffprobe found no video streams.')));
          return;
        }

        const durationCandidates = [
          metadata.format?.duration,
          ...videoStreams.map((stream) => stream.duration),
        ];
        const durationSeconds = durationCandidates
          .map((value) => Number.parseFloat(value))
          .find((value) => Number.isFinite(value) && value > 0);
        if (durationSeconds === undefined) {
          reject(new VideoStreamRequiredError(new Error('ffprobe found no positive media duration.')));
          return;
        }

        resolve({ durationSeconds, videoStreamCount: videoStreams.length });
      };
    if (execFileImpl === execFile) {
      execFileImpl('ffprobe', args, { timeout: FFPROBE_TIMEOUT_MS }, callback);
    } else {
      execFileImpl('ffprobe', args, callback);
    }
  });
}

class DurationLimitExceededError extends Error {
  constructor(durationSeconds, estimatedAudioBytes) {
    const durationMin = (durationSeconds / 60).toFixed(1);
    const maxMin = (MAX_SOURCE_DURATION_SECONDS / 60).toFixed(1);
    super(
      `Video is ${durationMin} min long. ClipAgent accepts source videos up to exactly ` +
        `${maxMin} minutes. Please attach a shorter video.`
    );
    this.name = 'DurationLimitExceededError';
    this.statusCode = 413;
    this.durationSeconds = durationSeconds;
    this.estimatedAudioBytes = estimatedAudioBytes;
  }
}

/**
 * Fast pre-flight check — reads ffprobe metadata without transcoding, requires
 * at least one video stream and a positive duration, then rejects up front if
 * the source exceeds ClipAgent's configured one-hour contract.
 * Runs BEFORE extraction, transcription, ranking, cutting, or Supabase upload.
 */
async function checkDurationLimit(filePath, overrides = {}) {
  const { durationSeconds, videoStreamCount } = await probeMedia(
    filePath,
    overrides.execFile || execFile
  );
  const estimatedAudioBytes = durationSeconds * MEASURED_BYTES_PER_SECOND;

  if (durationSeconds > MAX_SOURCE_DURATION_SECONDS) {
    throw new DurationLimitExceededError(durationSeconds, estimatedAudioBytes);
  }

  return { durationSeconds, estimatedAudioBytes, videoStreamCount };
}

module.exports = {
  checkDurationLimit,
  probeMedia,
  VideoStreamRequiredError,
  DurationLimitExceededError,
  MAX_SOURCE_DURATION_SECONDS,
  GROQ_FREE_TIER_MAX_AUDIO_BYTES,
  MEASURED_BYTES_PER_SECOND,
  FFPROBE_TIMEOUT_MS,
};
