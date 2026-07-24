const test = require('node:test');
const assert = require('node:assert/strict');
const {
  checkDurationLimit,
  VideoStreamRequiredError,
} = require('../services/durationLimitService');

function ffprobeResult(metadata) {
  return (command, args, callback) => {
    assert.equal(command, 'ffprobe');
    assert.deepEqual(args.slice(0, -1), [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,duration:stream_disposition=attached_pic',
      '-of',
      'json',
    ]);
    callback(null, JSON.stringify(metadata));
  };
}

test('valid video metadata passes preflight with a positive duration', async () => {
  const result = await checkDurationLimit('/tmp/valid-video.mp4', {
    execFile: ffprobeResult({
      streams: [
        { codec_type: 'video', duration: '30.0' },
        { codec_type: 'audio', duration: '30.0' },
      ],
      format: { duration: '30.0' },
    }),
  });

  assert.equal(result.durationSeconds, 30);
  assert.equal(result.videoStreamCount, 1);
  assert.ok(result.estimatedAudioBytes > 0);
});

test('audio-only MP3 is rejected because it has zero video streams', async () => {
  await assert.rejects(
    checkDurationLimit('/tmp/audio-only.mp3', {
      execFile: ffprobeResult({
        streams: [{ codec_type: 'audio', duration: '45.0' }],
        format: { duration: '45.0' },
      }),
    }),
    (error) =>
      error instanceof VideoStreamRequiredError &&
      error.code === 'VIDEO_STREAM_REQUIRED' &&
      error.statusCode === 400
  );
});

test('MP3 album art does not count as a valid video stream', async () => {
  await assert.rejects(
    checkDurationLimit('/tmp/audio-with-cover-art.mp3', {
      execFile: ffprobeResult({
        streams: [
          { codec_type: 'audio', duration: '45.0' },
          {
            codec_type: 'video',
            duration: '45.0',
            disposition: { attached_pic: 1 },
          },
        ],
        format: { duration: '45.0' },
      }),
    }),
    (error) => error instanceof VideoStreamRequiredError
  );
});

test('audio-only MP4 is rejected even though its container has a duration', async () => {
  await assert.rejects(
    checkDurationLimit('/tmp/audio-only.mp4', {
      execFile: ffprobeResult({
        streams: [{ codec_type: 'audio', duration: '60.0' }],
        format: { duration: '60.0' },
      }),
    }),
    (error) => error instanceof VideoStreamRequiredError
  );
});

test('corrupted media rejected by ffprobe becomes a safe video-stream error', async () => {
  const diagnostic = new Error('moov atom not found: /private/tmp/corrupt.mp4');
  await assert.rejects(
    checkDurationLimit('/tmp/corrupt.mp4', {
      execFile(command, args, callback) {
        callback(diagnostic, '');
      },
    }),
    (error) =>
      error instanceof VideoStreamRequiredError &&
      error.message === 'The supplied media does not contain a valid video stream.' &&
      !error.message.includes('moov') &&
      !error.message.includes('/private/')
  );
});

test('video metadata without a positive duration is rejected', async () => {
  await assert.rejects(
    checkDurationLimit('/tmp/zero-duration.mp4', {
      execFile: ffprobeResult({
        streams: [{ codec_type: 'video', duration: '0' }],
        format: { duration: '0' },
      }),
    }),
    (error) => error instanceof VideoStreamRequiredError
  );
});

test('unreadable ffprobe metadata is rejected safely', async () => {
  await assert.rejects(
    checkDurationLimit('/tmp/unreadable.mp4', {
      execFile(command, args, callback) {
        callback(null, '{not-json');
      },
    }),
    (error) => error instanceof VideoStreamRequiredError
  );
});
