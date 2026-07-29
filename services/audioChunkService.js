const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { readTimeoutMs } = require('../utils/providerTimeout');
const { uploadDir, ensureUploadDir } = require('../utils/tempDir');

const AUDIO_ENCODING_VERSION = 'aac-mono-16khz-64k-v1';
const FFMPEG_TIMEOUT_MS = readTimeoutMs(
  process.env.FFMPEG_TIMEOUT_MS,
  300_000
);

function buildChunkPlan(sourceDurationSeconds, {
  chunkSeconds = 600,
  overlapSeconds = 2,
} = {}) {
  if (
    !Number.isFinite(sourceDurationSeconds) ||
    sourceDurationSeconds <= 0 ||
    !Number.isFinite(chunkSeconds) ||
    chunkSeconds <= 0 ||
    !Number.isFinite(overlapSeconds) ||
    overlapSeconds < 0 ||
    overlapSeconds >= chunkSeconds
  ) {
    throw new Error('Invalid audio chunk-plan configuration.');
  }
  const chunks = [];
  for (
    let logicalStartSeconds = 0, index = 0;
    logicalStartSeconds < sourceDurationSeconds;
    logicalStartSeconds += chunkSeconds, index += 1
  ) {
    const logicalEndSeconds = Math.min(
      logicalStartSeconds + chunkSeconds,
      sourceDurationSeconds
    );
    const extractionStartSeconds =
      index === 0 ? 0 : Math.max(0, logicalStartSeconds - overlapSeconds);
    chunks.push({
      index,
      logicalStartSeconds,
      logicalEndSeconds,
      extractionStartSeconds,
      extractionEndSeconds: logicalEndSeconds,
      extractionDurationSeconds: logicalEndSeconds - extractionStartSeconds,
    });
  }
  return chunks;
}

function getChunkPath(jobId, chunkIndex) {
  const safeJobId = String(jobId).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(
    uploadDir,
    `${safeJobId}-audio-chunk-${String(chunkIndex).padStart(3, '0')}.m4a`
  );
}

function buildChunkFfmpegArgs(audioPath, outputPath, chunk) {
  return [
    '-y',
    '-ss',
    String(chunk.extractionStartSeconds),
    '-i',
    audioPath,
    '-t',
    String(chunk.extractionDurationSeconds),
    '-vn',
    '-acodec',
    'aac',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-b:a',
    '64k',
    outputPath,
  ];
}

async function extractAudioChunk(
  audioPath,
  jobId,
  chunk,
  { execFileImpl = execFile } = {}
) {
  ensureUploadDir();
  const outputPath = getChunkPath(jobId, chunk.index);
  const args = buildChunkFfmpegArgs(audioPath, outputPath, chunk);
  await new Promise((resolve, reject) => {
    execFileImpl(
      'ffmpeg',
      args,
      { timeout: FFMPEG_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        const wrapped = new Error(
          `FFmpeg audio chunk extraction failed: ${stderr || error.message}`
        );
        wrapped.code =
          error.code === 'ENOENT' ? 'FFMPEG_NOT_AVAILABLE' : 'AUDIO_CHUNK_FAILED';
        reject(wrapped);
      }
    );
  });
  const stats = await fs.promises.stat(outputPath);
  if (!stats.isFile() || stats.size <= 0) {
    const error = new Error('FFmpeg produced an empty audio chunk.');
    error.code = 'AUDIO_CHUNK_EMPTY';
    throw error;
  }
  return outputPath;
}

module.exports = {
  AUDIO_ENCODING_VERSION,
  FFMPEG_TIMEOUT_MS,
  buildChunkPlan,
  getChunkPath,
  buildChunkFfmpegArgs,
  extractAudioChunk,
};
