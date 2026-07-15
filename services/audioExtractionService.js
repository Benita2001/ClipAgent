const { execFile } = require('child_process');
const path = require('path');
const { uploadDir } = require('../utils/tempDir');

/**
 * Extracts a mono 16kHz AAC audio track from a video file via ffmpeg.
 * Always run, unconditionally, before transcription — raw video is never
 * sent to Whisper regardless of container format.
 */
function extractAudio(inputPath, sourceFilename) {
  return new Promise((resolve, reject) => {
    const base = path.basename(sourceFilename, path.extname(sourceFilename));
    const outputPath = path.join(uploadDir, `${base}-audio.m4a`);

    const args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-acodec', 'aac',
      '-ar', '16000',
      '-ac', '1',
      '-b:a', '64k',
      outputPath,
    ];

    execFile('ffmpeg', args, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') {
          reject(new Error('ffmpeg is not installed or not on PATH. Required to extract audio from this video format.'));
          return;
        }
        reject(new Error(`ffmpeg audio extraction failed: ${stderr || error.message}`));
        return;
      }
      resolve(outputPath);
    });
  });
}

module.exports = { extractAudio };
