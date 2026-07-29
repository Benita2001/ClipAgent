const { coerceRequestedClipCount } = require('./clipPricing');
const {
  parseOkxA2aServiceClipMap,
  normalizeServiceId,
  resolveServiceClipCount,
} = require('../config/okxA2aServiceClipMap');
const { VIDEO_MIME_TYPES } = require('./supabaseTemporarySourceStorage');

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function normalizeMessageRecord(message) {
  const candidates = [
    message?.payload,
    message?.rawText,
    message?.content,
    message?.message,
    message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const parsed = parseMaybeJson(candidate);
      if (parsed) return parsed;
      continue;
    }
    if (candidate && typeof candidate === 'object') return candidate;
  }
  return null;
}

function isAcceptedJobEvent(event) {
  if (!event || typeof event !== 'object') return false;
  return String(event.event || event.type || '').trim() === 'job_accepted' || String(event.status || '').trim() === 'accepted';
}

function isAttachmentEvent(event) {
  if (!event || typeof event !== 'object') return false;
  const topLevel = [
    event.fileKey,
    event.digest,
    event.salt,
    event.nonce,
    event.secret,
    event.filename,
  ];
  if (topLevel.every((value) => typeof value === 'string' && value.trim())) return true;
  const nested = event.attachment;
  return !!nested && [
    nested.fileKey,
    nested.digest,
    nested.salt,
    nested.nonce,
    nested.secret,
    nested.filename,
  ].every((value) => typeof value === 'string' && value.trim());
}

function attachmentIdentity(attachment) {
  return [
    attachment?.fileKey,
    attachment?.digest,
    attachment?.salt,
    attachment?.nonce,
    attachment?.secret,
  ].map((value) => String(value || '').trim()).join(':');
}

function collectAttachmentMetadata(messages, event) {
  const candidates = [];
  const addCandidates = (candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    candidates.push(candidate, candidate.attachment, candidate.data?.attachment);
    if (Array.isArray(candidate.attachments)) candidates.push(...candidate.attachments);
    if (Array.isArray(candidate.data?.attachments)) {
      candidates.push(...candidate.data.attachments);
    }
  };
  addCandidates(event);
  for (const message of [...messages].reverse()) {
    const parsed = normalizeMessageRecord(message);
    addCandidates(parsed);
  }
  const attachments = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const direct = candidate.fileKey ? candidate : candidate.attachment || candidate.data?.attachment || null;
    const source = direct || candidate;
    if (isAttachmentEvent(source)) {
      const attachment = {
        fileKey: source.fileKey,
        digest: source.digest,
        salt: source.salt,
        nonce: source.nonce,
        secret: source.secret,
        filename: source.filename,
        mimeType: source.mimeType || source.contentType || null,
        rawFileSize: source.fileSize ?? null,
        expectedSizeBytes:
          source.expectedSizeBytes ??
          source.sizeBytes ??
          source.size ??
          source.fileSize ??
          null,
      };
      const identity = attachmentIdentity(attachment);
      if (!seen.has(identity)) {
        seen.add(identity);
        attachments.push(attachment);
      }
    }
  }
  return attachments;
}

function extractAttachmentMetadata(messages, event) {
  const attachments = collectAttachmentMetadata(messages, event);
  if (attachments.length > 1) {
    const error = new Error(
      'ClipAgent service 37723 requires exactly one official video attachment.'
    );
    error.code = 'MULTIPLE_ATTACHMENTS_UNSUPPORTED';
    error.statusCode = 400;
    throw error;
  }
  return attachments[0] || null;
}

function validateAttachmentMetadata(attachment) {
  if (!attachment || typeof attachment !== 'object') {
    throw new Error('No official attachment metadata was found in the current job file.');
  }
  for (const key of ['fileKey', 'digest', 'salt', 'nonce', 'secret', 'filename']) {
    if (typeof attachment[key] !== 'string' || !attachment[key].trim()) {
      const error = new Error('The attachment metadata is incomplete.');
      error.code = 'INVALID_ATTACHMENT_METADATA';
      error.statusCode = 400;
      throw error;
    }
  }
  if (attachment.mimeType && !VIDEO_MIME_TYPES.has(attachment.mimeType)) {
    const error = new Error('The attachment metadata declares an unsupported MIME type.');
    error.code = 'UNSUPPORTED_VIDEO_TYPE';
    error.statusCode = 415;
    throw error;
  }
  if (
    attachment.expectedSizeBytes !== null &&
    attachment.expectedSizeBytes !== undefined &&
    attachment.expectedSizeBytes !== '' &&
    (!Number.isSafeInteger(Number(attachment.expectedSizeBytes)) || Number(attachment.expectedSizeBytes) <= 0)
  ) {
    const error = new Error('The attachment metadata declares an invalid expected size.');
    error.code = 'INVALID_ATTACHMENT_SIZE';
    error.statusCode = 400;
    throw error;
  }
  return {
    ...attachment,
    expectedSizeBytes:
      attachment.expectedSizeBytes === null || attachment.expectedSizeBytes === undefined || attachment.expectedSizeBytes === ''
        ? null
        : Number(attachment.expectedSizeBytes),
  };
}

function extractInstructionText(messages, event) {
  const possible = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) possible.push(value.trim());
  };
  push(event?.instruction);
  push(event?.instructions);
  push(event?.description);
  push(event?.content);
  push(event?.taskDescription);
  push(event?.message);
  push(event?.data?.instruction);
  push(event?.data?.instructions);
  push(event?.data?.description);
  push(event?.data?.content);
  for (const message of [...messages].reverse()) {
    push(message?.rawText);
    push(message?.content);
    const parsed = normalizeMessageRecord(message);
    push(parsed?.instruction);
    push(parsed?.instructions);
    push(parsed?.description);
    push(parsed?.content);
  }
  return possible.find((value) => !value.startsWith('{')) || possible[0] || '';
}

function parseServiceParams(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  const result = {};
  for (const chunk of value.split(/[;\n,]+/)) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!key || rest.length === 0) continue;
    result[key.trim()] = rest.join('=').trim();
  }
  return result;
}

function extractProviderId(event, env = process.env) {
  const value = event?.providerId ??
    event?.provider ??
    event?.agentId ??
    env.OKX_AGENT_TASK_CURRENT_AGENT_ID ??
    env.OKX_A2A_PROVIDER_AGENT_ID ??
    6041;
  return normalizeServiceId(value);
}

function extractServiceId(event, env = process.env) {
  const value = event?.serviceId ??
    event?.service_id ??
    event?.service?.id ??
    env.OKX_A2A_SERVICE_ID ??
    37723;
  return normalizeServiceId(value);
}

function parseNaturalLanguageClipCount(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const normalized = text.trim().toLowerCase();
  const wordCounts = new Map([
    ['one', 1],
    ['two', 2],
    ['three', 3],
  ]);
  for (const [word, count] of wordCounts.entries()) {
    const regex = new RegExp(`\\b${word}\\s+clips?\\b|\\bclips?\\s+${word}\\b`);
    if (regex.test(normalized)) return count;
  }
  const numericPatterns = [
    /\b([1-3])\s*(?:x|×)?\s*clips?\b/i,
    /\bclips?\s*(?:of|x|:)?\s*([1-3])\b/i,
    /\b([1-3])\s*clip\b/i,
  ];
  for (const pattern of numericPatterns) {
    const match = normalized.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

function extractDiagnosticClipCount(event, instructionText) {
  const serviceParams = parseServiceParams(
    event?.serviceParams ??
      event?.service_params ??
      event?.params ??
      event?.data?.serviceParams ??
      event?.data?.service_params ??
      event?.data?.params
  );
  const fromServiceParams = coerceRequestedClipCount(serviceParams.clipCount, { fallback: null });
  if (!fromServiceParams.invalid && fromServiceParams.clipCount) {
    return {
      clipCount: fromServiceParams.clipCount,
      source: 'serviceParams',
      serviceParams,
    };
  }

  const naturalLanguageClipCount = parseNaturalLanguageClipCount(instructionText);
  if (naturalLanguageClipCount) {
    return {
      clipCount: naturalLanguageClipCount,
      source: 'instruction',
      serviceParams,
    };
  }

  return {
    clipCount: null,
    source: null,
    serviceParams,
  };
}

function buildQuantityNote({ purchasedClipCount, diagnosticClipCount, diagnosticSource, serviceId }) {
  if (!diagnosticClipCount || diagnosticClipCount === purchasedClipCount) {
    return null;
  }
  const requested = diagnosticClipCount;
  const direction = requested > purchasedClipCount ? 'reduced to' : 'raised to';
  const source = diagnosticSource === 'serviceParams' ? 'service parameters' : 'task instructions';
  return `Requested ${requested} clip${requested === 1 ? '' : 's'} via ${source} but service ${serviceId} purchases ${purchasedClipCount}; generating ${direction} the purchased quantity.`;
}

function normalizeOkxA2aJob(jobFile, { env = process.env, config = null } = {}) {
  const messages = Array.isArray(jobFile?.messages) ? jobFile.messages : [];
  const parsedMessages = messages.map((message) => normalizeMessageRecord(message)).filter(Boolean);
  const acceptedMessage = parsedMessages.find((event) => isAcceptedJobEvent(event))
    || parsedMessages.find((event) => String(event.event || '').trim() === 'job_accepted');
  if (!acceptedMessage) {
    throw new Error('No accepted job event was found in the current job file.');
  }

  const providerAgentId = extractProviderId(acceptedMessage, env);
  if (providerAgentId !== 6041) {
    const error = new Error(`Unexpected providerId ${providerAgentId}; expected 6041.`);
    error.code = 'UNEXPECTED_PROVIDER_ID';
    error.statusCode = 400;
    throw error;
  }
  const serviceId = extractServiceId(acceptedMessage, env);
  const serviceClipMap = config?.serviceClipMap
    || (env.OKX_A2A_SERVICE_CLIP_MAP
      ? parseOkxA2aServiceClipMap(env.OKX_A2A_SERVICE_CLIP_MAP)
      : null);
  const purchasedClipCount = resolveServiceClipCount(serviceClipMap, serviceId);
  if (!purchasedClipCount) {
    const error = new Error(`Service ${serviceId} is not configured for A2A clip quantities.`);
    error.code = 'UNSUPPORTED_A2A_SERVICE';
    error.statusCode = 400;
    throw error;
  }

  const jobId = String(
    acceptedMessage.jobId ||
      acceptedMessage.taskId ||
      jobFile?.jobId ||
      jobFile?.taskId ||
      env.OKX_AGENT_TASK_CURRENT_JOB_ID ||
      ''
  ).trim();
  if (!jobId) {
    throw new Error('The accepted job event did not include a jobId.');
  }

  const instructionText = extractInstructionText(messages, acceptedMessage);
  const diagnostic = extractDiagnosticClipCount(acceptedMessage, instructionText);
  const quantityNote = buildQuantityNote({
    purchasedClipCount,
    diagnosticClipCount: diagnostic.clipCount,
    diagnosticSource: diagnostic.source,
    serviceId,
  });

  const attachment = validateAttachmentMetadata(extractAttachmentMetadata(messages, acceptedMessage));

  const sourceMessageId = acceptedMessage.messageId || acceptedMessage.id || null;
  const sessionAgentId =
    jobFile?.sessionAgentId ??
    acceptedMessage.sessionAgentId ??
    null;

  return {
    jobId,
    providerAgentId,
    serviceId,
    purchasedClipCount,
    instructionText,
    attachment,
    acceptedEvent: acceptedMessage,
    sourceMessageId,
    sessionAgentId,
    diagnostics: {
      requestedClipCount: diagnostic.clipCount,
      requestedClipCountSource: diagnostic.source,
      serviceParams: diagnostic.serviceParams,
      quantityNote,
    },
  };
}

module.exports = {
  parseMaybeJson,
  normalizeMessageRecord,
  isAcceptedJobEvent,
  isAttachmentEvent,
  collectAttachmentMetadata,
  extractAttachmentMetadata,
  extractInstructionText,
  parseServiceParams,
  extractProviderId,
  extractServiceId,
  parseNaturalLanguageClipCount,
  extractDiagnosticClipCount,
  buildQuantityNote,
  validateAttachmentMetadata,
  normalizeOkxA2aJob,
};
