const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { clipsOutputDir } = require('../utils/outputDir');
const { readTimeoutMs } = require('../utils/providerTimeout');
const FFMPEG_TIMEOUT_MS = readTimeoutMs(process.env.FFMPEG_TIMEOUT_MS, 300_000);
const FFPROBE_TIMEOUT_MS = readTimeoutMs(process.env.FFPROBE_TIMEOUT_MS, 30_000);
const EVEN_DIMENSION_FILTER = 'pad=ceil(iw/2)*2:ceil(ih/2)*2';
const VERTICAL_9_16_FILTER = 'scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1';

function getClipOutputPath(jobId, index) {
  return path.join(clipsOutputDir, `${jobId}-clip-${index}.mp4`);
}

/**
 * Frame-accurate cut. `-ss` is placed BEFORE `-i` (fast keyframe seek), but
 * because we re-encode (not `-c copy`) ffmpeg's default `-accurate_seek`
 * decodes and discards the gap between that keyframe and the real target,
 * landing exactly on the requested timestamp. `-c copy` would instead snap
 * to the nearest keyframe — fast but imprecise — which is what we're
 * deliberately avoiding here.
 * `-t <duration>` (not `-to`) is used for the end bound since ffmpeg's own
 * docs don't unambiguously define whether `-to` is relative to the seek
 * point or the original file start when combined with input-side `-ss`;
 * `-t` (duration) has no such ambiguity.
 */
function buildFfmpegCutArgs(sourcePath, outputPath, startTime, duration, options = {}) {
  const videoFilter = options.videoFilter || EVEN_DIMENSION_FILTER;
  return [
    '-y',
    '-ss', String(startTime),
    '-i', sourcePath,
    '-t', String(duration),
    // libx264 with yuv420p requires even dimensions. Padding at most one
    // column/row preserves the complete image without stretching or cropping.
    '-vf', videoFilter,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast',
    '-crf', '20',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    outputPath,
  ];
}

function runFfmpegCut(sourcePath, outputPath, startTime, duration, options = {}) {
  return new Promise((resolve, reject) => {
    const args = buildFfmpegCutArgs(sourcePath, outputPath, startTime, duration, options);
    execFile('ffmpeg', args, { timeout: FFMPEG_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') {
          reject(new Error('ffmpeg is not installed or not on PATH.'));
          return;
        }
        reject(new Error(`ffmpeg cut failed: ${stderr || error.message}`));
        return;
      }
      resolve();
    });
  });
}

function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      { timeout: FFPROBE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(new Error(`ffprobe failed on ${filePath}: ${error.message}`));
          return;
        }
        const duration = parseFloat(stdout.trim());
        if (Number.isNaN(duration)) {
          reject(new Error(`ffprobe returned an unparsable duration for ${filePath}: "${stdout.trim()}"`));
          return;
        }
        resolve(duration);
      }
    );
  });
}

function probeVideoDimensions(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,width,height:format=duration',
        '-of',
        'json',
        filePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(new Error(`ffprobe failed on ${filePath}: ${error.message}`));
          return;
        }

        let metadata;
        try {
          metadata = JSON.parse(stdout);
        } catch (parseError) {
          reject(new Error(`ffprobe returned unparsable stream metadata for ${filePath}: ${parseError.message}`));
          return;
        }

        const videoStream = (metadata.streams || []).find((stream) => stream && stream.codec_type === 'video');
        if (!videoStream) {
          reject(new Error(`ffprobe found no video stream for ${filePath}.`));
          return;
        }

        const width = Number(videoStream.width);
        const height = Number(videoStream.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          reject(new Error(`ffprobe returned invalid video dimensions for ${filePath}.`));
          return;
        }

        const duration = Number.parseFloat(metadata.format?.duration);
        resolve({
          durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
          width,
          height,
        });
      }
    );
  });
}

const DURATION_TOLERANCE_SECONDS = 1.5;

/**
 * Cuts one clip and then actually verifies the result on disk: file exists,
 * non-zero size, and a real ffprobe-measured duration close to what was
 * requested. Throws (never silently reports success) if any check fails.
 */
async function cutAndVerify(sourcePath, outputPath, startTime, endTime, options = {}) {
  const requestedDuration = endTime - startTime;

  if (options.onClipStart) {
    options.onClipStart();
  }

  await runFfmpegCut(sourcePath, outputPath, startTime, requestedDuration, options);

  let stat;
  try {
    stat = fs.statSync(outputPath);
  } catch {
    throw new Error(`Cut clip was not created on disk: ${outputPath}`);
  }
  if (stat.size === 0) {
    throw new Error(`Cut clip exists but is zero bytes: ${outputPath}`);
  }

  const actualDuration = await probeDuration(outputPath);
  const drift = Math.abs(actualDuration - requestedDuration);
  if (drift > DURATION_TOLERANCE_SECONDS) {
    throw new Error(
      `Cut clip duration (${actualDuration.toFixed(2)}s) drifted from requested duration ` +
        `(${requestedDuration.toFixed(2)}s) by ${drift.toFixed(2)}s, exceeding the ` +
        `${DURATION_TOLERANCE_SECONDS}s tolerance: ${outputPath}`
    );
  }

  if (options.requireVertical) {
    const dimensions = await probeVideoDimensions(outputPath);
    const aspectRatio = dimensions.width / dimensions.height;
    if (!(dimensions.height > dimensions.width && aspectRatio <= 0.7)) {
      throw new Error(
        `Cut clip is not vertical enough for 9:16 delivery: ${dimensions.width}x${dimensions.height} (${outputPath})`
      );
    }
  }

  return { sizeBytes: stat.size, actualDurationSeconds: actualDuration };
}

/**
 * Cuts every ranked moment sequentially (not in parallel — avoids stacking
 * concurrent libx264 encodes on top of each other on a single machine).
 * Throws on the first failed/unverified cut rather than returning partial
 * fabricated success.
 */
async function cutMoments(sourcePath, jobId, moments, options = {}) {
  const results = [];

  for (let i = 0; i < moments.length; i += 1) {
    const moment = moments[i];
    const filename = `${jobId}-clip-${i}.mp4`;
    const outputPath = getClipOutputPath(jobId, i);

    // eslint-disable-next-line no-await-in-loop
    const { sizeBytes, actualDurationSeconds } = await cutAndVerify(
      sourcePath,
      outputPath,
      moment.start_time,
      moment.end_time,
      {
        videoFilter: options.videoFilter,
        requireVertical: options.requireVertical,
        onClipStart: options.onClipStart
          ? () => options.onClipStart(i, moments.length, moment)
          : undefined,
      }
    );

    results.push({
      index: i,
      filename,
      path: outputPath,
      reason: moment.reason,
      requestedStartSeconds: moment.start_time,
      requestedEndSeconds: moment.end_time,
      requestedDurationSeconds: moment.end_time - moment.start_time,
      actualDurationSeconds,
      sizeBytes,
      verified: true,
    });
  }

  return results;
}

module.exports = {
  cutMoments,
  cutAndVerify,
  getClipOutputPath,
  buildFfmpegCutArgs,
  EVEN_DIMENSION_FILTER,
  VERTICAL_9_16_FILTER,
  probeVideoDimensions,
};
