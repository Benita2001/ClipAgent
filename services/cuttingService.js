const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { clipsOutputDir } = require('../utils/outputDir');

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
function runFfmpegCut(sourcePath, outputPath, startTime, duration) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-ss', String(startTime),
      '-i', sourcePath,
      '-t', String(duration),
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      outputPath,
    ];

    execFile('ffmpeg', args, (error, stdout, stderr) => {
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

const DURATION_TOLERANCE_SECONDS = 1.5;

/**
 * Cuts one clip and then actually verifies the result on disk: file exists,
 * non-zero size, and a real ffprobe-measured duration close to what was
 * requested. Throws (never silently reports success) if any check fails.
 */
async function cutAndVerify(sourcePath, outputPath, startTime, endTime) {
  const requestedDuration = endTime - startTime;

  await runFfmpegCut(sourcePath, outputPath, startTime, requestedDuration);

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

  return { sizeBytes: stat.size, actualDurationSeconds: actualDuration };
}

/**
 * Cuts every ranked moment sequentially (not in parallel — avoids stacking
 * concurrent libx264 encodes on top of each other on a single machine).
 * Throws on the first failed/unverified cut rather than returning partial
 * fabricated success.
 */
async function cutMoments(sourcePath, jobId, moments) {
  const results = [];

  for (let i = 0; i < moments.length; i += 1) {
    const moment = moments[i];
    const filename = `${jobId}-clip-${i}.mp4`;
    const outputPath = getClipOutputPath(jobId, i);

    // eslint-disable-next-line no-await-in-loop
    const { sizeBytes, actualDurationSeconds } = await cutAndVerify(sourcePath, outputPath, moment.start_time, moment.end_time);

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

module.exports = { cutMoments, getClipOutputPath };
