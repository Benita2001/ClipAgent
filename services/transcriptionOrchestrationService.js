const { getTranscriptionConfig } = require('../config/transcriptionConfig');
const { transcribeGroqChunk } = require('./transcriptionService');
const { transcribeInChunks } = require('./chunkedTranscriptionService');

async function transcribeAudio(
  audioPath,
  filename,
  mimetype,
  options = {}
) {
  const config = options.config || getTranscriptionConfig(options.env);
  if (!config.enabled) {
    return transcribeGroqChunk(audioPath, filename, mimetype, {
      signal: options.signal,
      model: config.groqModel,
      language: config.suppliedLanguage,
    });
  }
  return transcribeInChunks(audioPath, {
    ...options,
    config,
  });
}

module.exports = { transcribeAudio };
