const path = require('path');
const fs = require('fs');
const { extractAudio } = require('./audioExtractionService');
const { transcribe } = require('./transcriptionService');
const { rankMoments } = require('./rankingService');
const { cutMoments } = require('./cuttingService');
const { uploadClip } = require('./supabaseStorageService');
const { markDone, markFailed } = require('./jobStore');

/**
 * Runs extract -> transcribe -> rank -> cut -> upload for one job in the
 * background. Audio is ALWAYS extracted first, unconditionally — raw video
 * is never sent to Whisper, regardless of container format. Never resolves
 * with a partial/fabricated success — any stage failure marks the job
 * "failed" with a clear, stage-tagged message. Intentionally not awaited by
 * the route handler; errors are caught here, not thrown to an
 * unhandled-rejection.
 */
async function runPipeline(jobId, file) {
  let transcriptionInputPath;
  let transcriptionFilename;
  let audioFileSizeBytes;
  const transcriptionMimetype = 'audio/mp4';

  try {
    const audioPath = await extractAudio(file.path, file.filename);
    transcriptionInputPath = audioPath;
    transcriptionFilename = path.basename(audioPath);
    audioFileSizeBytes = fs.statSync(audioPath).size;
  } catch (err) {
    markFailed(jobId, `Audio extraction failed: ${err.message}`);
    return;
  }

  let groqTranscription;
  try {
    groqTranscription = await transcribe(transcriptionInputPath, transcriptionFilename, transcriptionMimetype);
  } catch (err) {
    markFailed(jobId, `Transcription failed: ${err.message}`);
    return;
  }

  let moments;
  let rankingModel;
  try {
    const ranked = await rankMoments(groqTranscription.segments || []);
    moments = ranked.moments;
    rankingModel = ranked.rankingModel;
  } catch (err) {
    markFailed(jobId, `Ranking failed: ${err.message}`);
    return;
  }

  let cuts;
  try {
    cuts = await cutMoments(file.path, jobId, moments);
  } catch (err) {
    markFailed(jobId, `Cutting failed: ${err.message}`);
    return;
  }

  const uploadedClips = [];
  try {
    for (let i = 0; i < cuts.length; i += 1) {
      const cut = cuts[i];
      const storageKey = `${jobId}/${cut.filename}`;
      // eslint-disable-next-line no-await-in-loop
      const uploaded = await uploadClip(cut.path, storageKey);
      uploadedClips.push({
        index: cut.index,
        reason: cut.reason,
        requestedStartSeconds: cut.requestedStartSeconds,
        requestedEndSeconds: cut.requestedEndSeconds,
        requestedDurationSeconds: cut.requestedDurationSeconds,
        actualDurationSeconds: cut.actualDurationSeconds,
        localPath: cut.path,
        supabase: uploaded,
      });
    }
  } catch (err) {
    // A partial upload (some clips succeeded before this one failed) is still
    // a failed job — we do not report success with an incomplete clip list.
    markFailed(jobId, `Supabase upload failed: ${err.message}`);
    return;
  }

  markDone(jobId, {
    clips: uploadedClips,
    rankingModel,
    audioFileSizeBytes,
    transcriptDurationSeconds: groqTranscription.duration,
  });
}

module.exports = { runPipeline };
