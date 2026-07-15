const { execFile } = require('child_process');

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

// ~2870s theoretical ceiling at the measured rate; trimmed for margin.
const MAX_SOURCE_DURATION_SECONDS = 2800; // 46 min 40s

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      (error, stdout) => {
        if (error) {
          if (error.code === 'ENOENT') {
            reject(new Error('ffprobe is not installed or not on PATH.'));
            return;
          }
          reject(new Error(`ffprobe failed to read duration: ${error.message}`));
          return;
        }
        const duration = parseFloat(stdout.trim());
        if (Number.isNaN(duration)) {
          reject(new Error(`ffprobe returned an unparsable duration: "${stdout.trim()}"`));
          return;
        }
        resolve(duration);
      }
    );
  });
}

class DurationLimitExceededError extends Error {
  constructor(durationSeconds, estimatedAudioBytes) {
    const durationMin = (durationSeconds / 60).toFixed(1);
    const maxMin = (MAX_SOURCE_DURATION_SECONDS / 60).toFixed(1);
    const estimatedMB = (estimatedAudioBytes / 1_000_000).toFixed(1);
    super(
      `Video is ${durationMin} min long, which would produce roughly ${estimatedMB}MB of extracted audio — ` +
        `over Groq Whisper's ~25MB free-tier limit. Supported length is up to ~${maxMin} minutes ` +
        `at this app's fixed extraction settings (mono, 16kHz, 64kbps AAC). Please upload a shorter video.`
    );
    this.name = 'DurationLimitExceededError';
    this.statusCode = 413;
    this.durationSeconds = durationSeconds;
    this.estimatedAudioBytes = estimatedAudioBytes;
  }
}

/**
 * Fast pre-flight check — reads duration via ffprobe only (no transcoding)
 * and rejects up front if the video is long enough that its extracted audio
 * would predictably exceed Groq's free-tier size limit. Runs BEFORE audio
 * extraction, transcription, ranking, cutting, or any Supabase upload.
 */
async function checkDurationLimit(filePath) {
  const durationSeconds = await probeDuration(filePath);
  const estimatedAudioBytes = durationSeconds * MEASURED_BYTES_PER_SECOND;

  if (durationSeconds > MAX_SOURCE_DURATION_SECONDS) {
    throw new DurationLimitExceededError(durationSeconds, estimatedAudioBytes);
  }

  return { durationSeconds, estimatedAudioBytes };
}

module.exports = {
  checkDurationLimit,
  DurationLimitExceededError,
  MAX_SOURCE_DURATION_SECONDS,
  GROQ_FREE_TIER_MAX_AUDIO_BYTES,
  MEASURED_BYTES_PER_SECOND,
};
