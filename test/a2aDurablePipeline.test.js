const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { A2aStageCheckpointStore } = require('../services/a2aStageCheckpointStore');
const { processA2aDurableClip } = require('../services/a2aDurablePipelineService');

async function harness() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'durable-pipeline-'));
  const source = path.join(root, 'source.mp4');
  await fs.promises.writeFile(source, 'source-video');
  const counts = { audio: 0, transcription: 0, ranking: 0, render: 0, upload: 0, verify: 0 };
  const store = new A2aStageCheckpointStore({
    rootDir: path.join(root, 'checkpoints'),
    artifactRoot: path.join(root, 'artifacts'),
  });
  const options = {
    env: {
      RANKING_CONTEXT_PROTECTION_ENABLED: 'true',
      RANKING_MAX_REQUEST_BYTES: '10000',
    },
    providerId: 6041,
    serviceId: 37723,
    contractVersion: 'clipagent-a2a-37723-v1',
    sourceDurationSeconds: 60,
    stageCheckpointStore: store,
    extractAudio: async () => {
      counts.audio += 1;
      const output = path.join(root, `audio-${counts.audio}.m4a`);
      await fs.promises.writeFile(output, 'durable-audio');
      return output;
    },
    transcribe: async () => {
      counts.transcription += 1;
      return {
        schemaVersion: 'clipagent-transcript-v1',
        duration: 60,
        segments: [{ id: 0, start: 0, end: 30, text: 'complete thought' }],
      };
    },
    rankTranscript: async () => {
      counts.ranking += 1;
      return {
        moments: [{
          segment_ids: [0],
          start_time: 0,
          end_time: 25,
          reason: 'A complete buyer-readable thought.',
        }],
        rankingModel: 'test-ranker',
      };
    },
    cutMoments: async () => {
      counts.render += 1;
      const output = path.join(root, `render-${counts.render}.mp4`);
      await fs.promises.writeFile(output, 'rendered-video');
      return [{
        filename: 'clip-1.mp4',
        path: output,
        reason: 'A complete buyer-readable thought.',
        requestedStartSeconds: 0,
        requestedEndSeconds: 25,
        actualDurationSeconds: 25,
      }];
    },
    probeRendered: async () => ({ width: 720, height: 1280, durationSeconds: 25 }),
    uploadClip: async () => {
      counts.upload += 1;
      return {
        bucket: 'clips',
        storagePath: 'job/clip-1.mp4',
        publicUrl: 'https://project.supabase.co/storage/v1/object/public/clips/job/clip-1.mp4',
      };
    },
    verifyUploadedClip: async () => {
      counts.verify += 1;
      return true;
    },
  };
  return {
    root,
    source,
    counts,
    store,
    options,
    file: {
      path: source,
      filename: 'source.mp4',
      size: (await fs.promises.stat(source)).size,
    },
  };
}

test('valid audio, ranking, render, and upload checkpoints are reused', async () => {
  const h = await harness();
  await processA2aDurableClip('job', h.file, h.options);
  await processA2aDurableClip('job', h.file, h.options);
  assert.deepEqual(h.counts, {
    audio: 1,
    transcription: 1,
    ranking: 1,
    render: 1,
    upload: 1,
    verify: 1,
  });
  await fs.promises.rm(h.root, { recursive: true, force: true });
});

test('invalid audio artifact is regenerated and transcript change invalidates ranking', async () => {
  const h = await harness();
  await processA2aDurableClip('job', h.file, h.options);
  const audio = await h.store.read('job', 'audio');
  await fs.promises.writeFile(audio.data.artifact.path, 'corrupt');
  await processA2aDurableClip('job', h.file, h.options);
  assert.equal(h.counts.audio, 2);
  h.options.contractVersion = 'clipagent-a2a-37723-v2';
  await processA2aDurableClip('job', h.file, h.options);
  assert.equal(h.counts.ranking, 2);
  assert.equal(h.counts.render, 2);
  assert.equal(h.counts.upload, 2);
  await fs.promises.rm(h.root, { recursive: true, force: true });
});

test('missing remote upload invalidates upload checkpoint and uploads again', async () => {
  const h = await harness();
  await processA2aDurableClip('job', h.file, h.options);
  h.options.verifyUploadedClip = async () => false;
  await processA2aDurableClip('job', h.file, h.options);
  assert.equal(h.counts.upload, 2);
  assert.equal(h.counts.audio, 1);
  assert.equal(h.counts.ranking, 1);
  assert.equal(h.counts.render, 1);
  await fs.promises.rm(h.root, { recursive: true, force: true });
});

test('transcription provider model changes invalidate dependent checkpoints', async () => {
  const h = await harness();
  h.options.env.GROQ_TRANSCRIPTION_MODEL = 'model-v1';
  await processA2aDurableClip('job', h.file, h.options);
  h.options.env.GROQ_TRANSCRIPTION_MODEL = 'model-v2';
  await processA2aDurableClip('job', h.file, h.options);
  assert.equal(h.counts.audio, 1);
  assert.equal(h.counts.transcription, 2);
  assert.equal(h.counts.ranking, 1);
  assert.equal(h.counts.render, 1);
  assert.equal(h.counts.upload, 1);
  await fs.promises.rm(h.root, { recursive: true, force: true });
});
