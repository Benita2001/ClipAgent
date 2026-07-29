const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { extractAudio } = require('./audioExtractionService');
const { transcribeAudio } = require('./transcriptionOrchestrationService');
const { TRANSCRIPT_SCHEMA_VERSION } = require('./transcriptSchema');
const { getTranscriptionConfig } = require('../config/transcriptionConfig');
const {
  rankBoundedTranscript,
  getRankingLimits,
} = require('./boundedRankingService');
const {
  cutMoments,
  probeVideoDimensions,
  VERTICAL_9_16_FILTER,
} = require('./cuttingService');
const {
  uploadClip,
  verifyUploadedClip,
} = require('./supabaseStorageService');
const {
  A2aStageCheckpointStore,
  sha256File,
  fingerprint,
} = require('./a2aStageCheckpointStore');
const { validateA2aClipResult } = require('./a2aOutputValidation');
const { cleanupFiles } = require('../utils/fileCleanup');

const AUDIO_CONFIGURATION_VERSION = 'aac-mono-16khz-64k-v1';
const RENDER_CONFIGURATION_VERSION = 'vertical-720x1280-libx264-aac-v1';
const OUTPUT_VALIDATION_VERSION = 'a2a-output-one-clip-v1';

function transcriptChecksum(transcript) {
  return `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(transcript))
    .digest('hex')}`;
}

async function processA2aDurableClip(jobId, file, overrides = {}) {
  const checkpointStore = overrides.stageCheckpointStore ||
    new A2aStageCheckpointStore({ env: overrides.env });
  const sourceSize = Number(file.size || (await fs.promises.stat(file.path)).size);
  const sourceChecksum = overrides.sourceChecksum || await sha256File(file.path);
  const sourceDurationSeconds = Number(overrides.sourceDurationSeconds);
  const transcriptionConfig = getTranscriptionConfig(overrides.env);
  const identity = {
    jobId,
    sourceChecksum,
    sourceSize,
    sourceDurationSeconds,
    providerId: overrides.providerId,
    serviceId: overrides.serviceId,
    contractVersion: overrides.contractVersion,
    transcriptSchemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    rankingConfigurationVersion: getRankingLimits(overrides.env).configurationVersion,
    renderConfigurationVersion: RENDER_CONFIGURATION_VERSION,
    outputValidationVersion: OUTPUT_VALIDATION_VERSION,
  };
  const checkpointIdentity = (stage, additional = {}) => ({
    ...identity,
    stage,
    ...additional,
  });
  const heartbeat = async (stage) => {
    await overrides.onStageProgress?.(stage);
  };

  await heartbeat('audio_extraction');
  let audio = await checkpointStore.valid(
    jobId,
    'audio',
    checkpointIdentity('audio', { audioConfigurationVersion: AUDIO_CONFIGURATION_VERSION }),
    (data) => checkpointStore.verifyArtifact(data?.artifact)
  );
  if (!audio) {
    const temporaryAudio = await (overrides.extractAudio || extractAudio)(
      file.path,
      file.filename
    );
    const artifact = await checkpointStore.persistArtifact(jobId, temporaryAudio, 'source-audio.m4a');
    await cleanupFiles([temporaryAudio]);
    audio = {
      artifact,
      configurationVersion: AUDIO_CONFIGURATION_VERSION,
    };
    await checkpointStore.write(
      jobId,
      'audio',
      checkpointIdentity('audio', { audioConfigurationVersion: AUDIO_CONFIGURATION_VERSION }),
      audio
    );
  }

  await heartbeat('transcription');
  const transcriptionIdentity = {
    audioChecksum: audio.artifact.checksum,
    transcriptionConfiguration: {
      enabled: transcriptionConfig.enabled,
      primaryProvider: transcriptionConfig.primaryProvider,
      fallbackProvider: transcriptionConfig.fallbackProvider,
      chunkSeconds: transcriptionConfig.chunkSeconds,
      overlapSeconds: transcriptionConfig.overlapSeconds,
      groqModel: transcriptionConfig.groqModel,
      openaiModel: transcriptionConfig.openaiModel,
      language: transcriptionConfig.language || null,
      audioConfigurationVersion: AUDIO_CONFIGURATION_VERSION,
    },
  };
  let transcript = await checkpointStore.valid(
    jobId,
    'transcription',
    checkpointIdentity('transcription', transcriptionIdentity),
    (data) =>
      data?.schemaVersion === TRANSCRIPT_SCHEMA_VERSION &&
      Array.isArray(data?.segments) &&
      data.segments.length > 0
  );
  if (!transcript) {
    transcript = await (overrides.transcribe || transcribeAudio)(
      audio.artifact.path,
      path.basename(audio.artifact.path),
      'audio/mp4',
      {
        jobId,
        sourcePath: file.path,
        sourceChecksum,
        sourceDurationSeconds,
        contractVersion: overrides.contractVersion,
        env: overrides.env,
        onChunkComplete: overrides.onTranscriptionChunkComplete,
      }
    );
    await checkpointStore.write(
      jobId,
      'transcription',
      checkpointIdentity('transcription', transcriptionIdentity),
      transcript
    );
  }

  const transcriptHash = transcriptChecksum(transcript);
  await heartbeat('ranking');
  let ranking = await checkpointStore.valid(
    jobId,
    'ranking',
    checkpointIdentity('ranking', { transcriptChecksum: transcriptHash }),
    (data) =>
      Array.isArray(data?.moments) &&
      data.moments.length === 1 &&
      typeof data.moments[0]?.reason === 'string'
  );
  if (!ranking) {
    ranking = await (overrides.rankTranscript || rankBoundedTranscript)(
      transcript.segments,
      {
        sourceDurationSeconds,
        instructions: overrides.instructions,
        clipCount: 1,
        env: overrides.env,
        ranker: overrides.rankMoments,
      }
    );
    await checkpointStore.write(
      jobId,
      'ranking',
      checkpointIdentity('ranking', { transcriptChecksum: transcriptHash }),
      {
        ...ranking,
        transcriptChecksum: transcriptHash,
        contractVersion: overrides.contractVersion,
      }
    );
  }

  const moment = ranking.moments[0];
  await heartbeat('rendering');
  let rendered = await checkpointStore.valid(
    jobId,
    'render',
    checkpointIdentity('render', {
      startSeconds: moment.start_time,
      endSeconds: moment.end_time,
    }),
    async (data) => {
      if (!(await checkpointStore.verifyArtifact(data?.artifact))) return false;
      const metadata = await (overrides.probeRendered || probeVideoDimensions)(data.artifact.path);
      return metadata.height > metadata.width &&
        Math.abs(metadata.durationSeconds - data.durationSeconds) <= 1.5;
    }
  );
  if (!rendered) {
    const cuts = await (overrides.cutMoments || cutMoments)(
      file.path,
      jobId,
      [moment],
      {
        videoFilter: VERTICAL_9_16_FILTER,
        requireVertical: true,
      }
    );
    const cut = cuts[0];
    const artifact = await checkpointStore.persistArtifact(jobId, cut.path, 'clip-1.mp4');
    const metadata = await (overrides.probeRendered || probeVideoDimensions)(artifact.path);
    rendered = {
      artifact,
      filename: cut.filename,
      startSeconds: cut.requestedStartSeconds,
      endSeconds: cut.requestedEndSeconds,
      durationSeconds: cut.actualDurationSeconds,
      reason: cut.reason,
      width: metadata.width,
      height: metadata.height,
      videoCodec: 'libx264',
      audioCodec: 'aac',
      configurationVersion: RENDER_CONFIGURATION_VERSION,
    };
    await cleanupFiles(cuts.map((cutResult) => cutResult.path));
    await checkpointStore.write(
      jobId,
      'render',
      checkpointIdentity('render', {
        startSeconds: moment.start_time,
        endSeconds: moment.end_time,
      }),
      rendered
    );
  }

  await heartbeat('upload');
  const uploadIdentity = checkpointIdentity('upload', {
    outputChecksum: rendered.artifact.checksum,
  });
  let uploaded = await checkpointStore.valid(
    jobId,
    'upload',
    uploadIdentity,
    (data) => (overrides.verifyUploadedClip || verifyUploadedClip)({
      ...data,
      expectedSizeBytes: rendered.artifact.sizeBytes,
    })
  );
  if (!uploaded) {
    const storageKey = `${jobId}/${rendered.filename}`;
    uploaded = await (overrides.uploadClip || uploadClip)(
      rendered.artifact.path,
      storageKey
    );
    uploaded = {
      ...uploaded,
      uploadedAt: new Date().toISOString(),
      localOutputChecksum: rendered.artifact.checksum,
      contractVersion: overrides.contractVersion,
    };
    await checkpointStore.write(jobId, 'upload', uploadIdentity, uploaded);
  }

  const result = {
    clips: [{
      url: uploaded.publicUrl,
      startSeconds: rendered.startSeconds,
      endSeconds: rendered.endSeconds,
      durationSeconds: rendered.durationSeconds,
      reason: rendered.reason,
    }],
    rankingModel: ranking.rankingModel || ranking.model || ranking.provider,
    transcriptDurationSeconds: transcript.duration,
  };
  validateA2aClipResult(result, {
    expectedClipCount: 1,
    minDurationSeconds: 20,
    maxDurationSeconds: 45,
    sourceDurationSeconds,
  });
  await checkpointStore.write(
    jobId,
    'completed_pipeline',
    checkpointIdentity('completed_pipeline', {
      resultChecksum: fingerprint(result),
    }),
    result
  );
  return result;
}

module.exports = {
  processA2aDurableClip,
  transcriptChecksum,
  AUDIO_CONFIGURATION_VERSION,
  RENDER_CONFIGURATION_VERSION,
  OUTPUT_VALIDATION_VERSION,
};
