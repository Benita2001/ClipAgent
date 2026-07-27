const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  cutAndVerify,
  buildFfmpegCutArgs,
  EVEN_DIMENSION_FILTER,
} = require('../services/cuttingService');

const execFileAsync = promisify(execFile);

async function createOddCompatibleSource(filePath, width, height) {
  await execFileAsync('ffmpeg', [
    '-v', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=size=${width}x${height}:rate=10:duration=1`,
    '-c:v', 'ffv1',
    '-pix_fmt', 'yuv444p',
    filePath,
  ]);
}

async function probeDimensions(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,pix_fmt',
    '-of', 'json',
    filePath,
  ]);
  return JSON.parse(stdout).streams[0];
}

for (const fixture of [
  { name: 'odd width', width: 853, height: 480, expectedWidth: 854, expectedHeight: 480 },
  { name: 'even dimensions', width: 854, height: 480, expectedWidth: 854, expectedHeight: 480 },
  { name: 'odd height', width: 854, height: 481, expectedWidth: 854, expectedHeight: 482 },
  { name: 'odd width and height', width: 853, height: 481, expectedWidth: 854, expectedHeight: 482 },
]) {
  test(`libx264 rendering preserves content with ${fixture.name}`, async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clipagent-dimensions-'));
    const sourcePath = path.join(directory, 'source.mkv');
    const outputPath = path.join(directory, 'output.mp4');
    try {
      await createOddCompatibleSource(sourcePath, fixture.width, fixture.height);
      const result = await cutAndVerify(sourcePath, outputPath, 0, 0.8);
      const stream = await probeDimensions(outputPath);

      assert.equal(result.sizeBytes > 0, true);
      assert.equal(stream.width, fixture.expectedWidth);
      assert.equal(stream.height, fixture.expectedHeight);
      assert.equal(stream.pix_fmt, 'yuv420p');
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });
}

test('every libx264 cut uses padding rather than scaling or cropping', () => {
  const args = buildFfmpegCutArgs('source.mp4', 'output.mp4', 1, 20);
  const filterIndex = args.indexOf('-vf');

  assert.equal(EVEN_DIMENSION_FILTER, 'pad=ceil(iw/2)*2:ceil(ih/2)*2');
  assert.equal(args[filterIndex + 1], EVEN_DIMENSION_FILTER);
  assert.equal(args.includes('libx264'), true);
  assert.equal(args.some((value) => /^scale=|^crop=/.test(value)), false);
});
