const PUBLIC_FAILURES = {
  'Audio extraction': ['AUDIO_EXTRACTION_FAILED', 'The video audio could not be processed.'],
  Transcription: ['TRANSCRIPTION_FAILED', 'The video could not be transcribed.'],
  Ranking: ['RANKING_FAILED', 'The best moments could not be identified.'],
  Cutting: ['CLIP_CREATION_FAILED', 'The video clips could not be created.'],
  'Supabase upload': ['UPLOAD_FAILED', 'The generated clips could not be uploaded.'],
};

function publicFailure(stage, error) {
  if (error && error.code === 'PROVIDER_TIMEOUT') {
    return { code: 'PROVIDER_TIMEOUT', message: 'An external processing service took too long to respond.' };
  }
  const [code, message] = PUBLIC_FAILURES[stage] || ['PROCESSING_FAILED', 'The video could not be processed.'];
  return { code, message };
}

function createJobFailure(stage, error) {
  return {
    stage,
    internalError: {
      name: error && error.name ? error.name : 'Error',
      message: error && error.message ? error.message : String(error),
      stack: error && error.stack ? error.stack : undefined,
    },
    publicError: publicFailure(stage, error),
  };
}

function redactDiagnostic(value) {
  let text = String(value || '');
  const secrets = [
    process.env.GROQ_API_KEY,
    process.env.GEMINI_API_KEY,
    process.env.SUPABASE_SERVICE_KEY,
    process.env.OKX_API_KEY,
    process.env.OKX_SECRET_KEY,
    process.env.OKX_PASSPHRASE,
  ].filter(Boolean);
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
  return text
    .replace(/authorization\s*[:=]\s*[^\s,;]+/gi, 'Authorization: [REDACTED]')
    .replace(/bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(api[-_ ]?key|passphrase|secret)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]');
}

function logJobFailure(jobId, failure, logger = console) {
  const diagnostic = failure.internalError.stack || failure.internalError.message;
  logger.error(`[job ${jobId}] ${failure.stage} failed: ${redactDiagnostic(diagnostic)}`);
}

module.exports = { createJobFailure, logJobFailure, redactDiagnostic };
