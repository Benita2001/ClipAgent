const path = require('path');
const fs = require('fs');
const { extractAudio, getAudioOutputPath } = require('./audioExtractionService');
const { transcribe } = require('./transcriptionService');
const { rankMoments } = require('./rankingService');
const { cutMoments, getClipOutputPath } = require('./cuttingService');
const { uploadClip } = require('./supabaseStorageService');
const { markDone, markFailed } = require('./jobStore');
const { createJobFailure, logJobFailure, redactDiagnostic } = require('./jobErrors');
const { cleanupFiles } = require('../utils/fileCleanup');

/**
 * Runs extract -> transcribe -> rank -> cut -> upload for one job in the
 * background. Audio is ALWAYS extracted first, unconditionally — raw video
 * is never sent to Whisper, regardless of container format. Never resolves
 * with a partial/fabricated success — any stage failure marks the job
 * "failed" with a clear, stage-tagged message. Intentionally not awaited by
 * the route handler; errors are caught here, not thrown to an
 * unhandled-rejection.
 */
async function runPipeline(jobId, file, overrides = {}) {
  const dependencies = {
    extractAudio,
    getAudioOutputPath,
    transcribe,
    rankMoments,
    cutMoments,
    getClipOutputPath,
    uploadClip,
    markDone,
    markFailed,
    cleanupFiles,
    createJobFailure,
    logJobFailure,
    redactDiagnostic,
    logger: console,
    ...overrides,
  };

  const createdPaths = new Set([file.path]);
  const transcriptionMimetype = 'audio/mp4';
  let stage = 'Audio extraction';

  let terminalOutcome;
  try {
    const expectedAudioPath = dependencies.getAudioOutputPath(file.filename);
    createdPaths.add(expectedAudioPath);
    const audioPath = await dependencies.extractAudio(file.path, file.filename);
    createdPaths.add(audioPath);
    const transcriptionFilename = path.basename(audioPath);
    const audioFileSizeBytes = fs.statSync(audioPath).size;

    stage = 'Transcription';
    const groqTranscription = await dependencies.transcribe(audioPath, transcriptionFilename, transcriptionMimetype);

    stage = 'Ranking';
    const ranked = await dependencies.rankMoments(groqTranscription.segments || []);
    const { moments, rankingModel } = ranked;

    stage = 'Cutting';
    for (let i = 0; i < moments.length; i += 1) {
      createdPaths.add(dependencies.getClipOutputPath(jobId, i));
    }
    const cuts = await dependencies.cutMoments(file.path, jobId, moments);
    for (const cut of cuts) createdPaths.add(cut.path);

    stage = 'Supabase upload';
    const uploadedClips = [];
    for (let i = 0; i < cuts.length; i += 1) {
      const cut = cuts[i];
      const storageKey = `${jobId}/${cut.filename}`;
      // eslint-disable-next-line no-await-in-loop
      const uploaded = await dependencies.uploadClip(cut.path, storageKey);
      uploadedClips.push({
        index: cut.index,
        reason: cut.reason,
        requestedStartSeconds: cut.requestedStartSeconds,
        requestedEndSeconds: cut.requestedEndSeconds,
        requestedDurationSeconds: cut.requestedDurationSeconds,
        actualDurationSeconds: cut.actualDurationSeconds,
        supabase: uploaded,
      });
    }

    terminalOutcome = { type: 'done', result: {
      clips: uploadedClips,
      rankingModel,
      audioFileSizeBytes,
      transcriptDurationSeconds: groqTranscription.duration,
    } };
  } catch (error) {
    const failure = dependencies.createJobFailure(stage, error);
    dependencies.logJobFailure(jobId, failure, dependencies.logger);
    terminalOutcome = { type: 'failed', failure };
  }

  let transitionError;
  try {
    const accepted =
      terminalOutcome.type === 'done'
        ? dependencies.markDone(jobId, terminalOutcome.result)
        : dependencies.markFailed(jobId, terminalOutcome.failure);
    if (accepted === false) dependencies.logger.warn(`[job ${jobId}] terminal transition was rejected.`);
  } catch (error) {
    transitionError = error;
    dependencies.logger.error(
      `[job ${jobId}] terminal transition failed: ${dependencies.redactDiagnostic(error.message)}`
    );
  }

  try {
    await dependencies.cleanupFiles([...createdPaths]);
  } catch (error) {
    dependencies.logger.error(`[job ${jobId}] cleanup failed: ${dependencies.redactDiagnostic(error.message)}`);
  }

  if (transitionError) throw transitionError;
}

module.exports = { runPipeline };
