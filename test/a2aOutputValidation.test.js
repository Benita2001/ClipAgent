const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateA2aClipResult,
} = require('../services/a2aOutputValidation');

function clip(overrides = {}) {
  return {
    url: 'https://project.supabase.co/storage/v1/object/public/clips/job/clip-1.mp4',
    startSeconds: 10,
    endSeconds: 35,
    durationSeconds: 25,
    reason: 'Strong self-contained explanation',
    ...overrides,
  };
}

const constraints = {
  expectedClipCount: 1,
  minDurationSeconds: 20,
  maxDurationSeconds: 45,
};

test('validates quantity, timestamps, URL, duration, and selection reason', () => {
  const result = { clips: [clip()] };
  assert.equal(validateA2aClipResult(result, constraints), result);
});

for (const [name, result] of [
  ['quantity', { clips: [] }],
  ['URL', { clips: [clip({ url: 'file:///tmp/clip.mp4' })] }],
  ['timestamps', { clips: [clip({ endSeconds: 5 })] }],
  ['duration range', { clips: [clip({ endSeconds: 60, durationSeconds: 50 })] }],
  ['duration consistency', { clips: [clip({ durationSeconds: 30 })] }],
  ['selection reason', { clips: [clip({ reason: ' ' })] }],
]) {
  test(`rejects invalid output ${name}`, () => {
    assert.throws(
      () => validateA2aClipResult(result, constraints),
      (error) => error.code === 'INVALID_A2A_OUTPUT'
    );
  });
}

test('rejects duplicate URLs and overlapping clip ranges', () => {
  const multiConstraints = { ...constraints, expectedClipCount: 2 };
  assert.throws(
    () => validateA2aClipResult({
      clips: [
        clip(),
        clip({ startSeconds: 40, endSeconds: 65 }),
      ],
    }, multiConstraints),
    /URLs must be unique/
  );
  assert.throws(
    () => validateA2aClipResult({
      clips: [
        clip(),
        clip({
          url: 'https://project.supabase.co/storage/v1/object/public/clips/job/clip-2.mp4',
          startSeconds: 30,
          endSeconds: 55,
        }),
      ],
    }, multiConstraints),
    /must not overlap/
  );
});

test('rejects a clip whose source timestamps exceed the source duration', () => {
  assert.throws(
    () => validateA2aClipResult(
      { clips: [clip({ startSeconds: 40, endSeconds: 65 })] },
      { ...constraints, sourceDurationSeconds: 60 }
    ),
    /beyond the source duration/
  );
});
