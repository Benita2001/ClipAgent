class MarketplaceContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketplaceContractError';
    this.code = code;
    this.statusCode = 503;
  }
}

const MARKETPLACE_CAPABILITY_LIMITATIONS = Object.freeze([
  'contractVersion',
  'structuredOutputQuantity',
  'inputSchema',
  'outputSchema',
  'structuredAttachmentPolicy',
  'maximumSourceDuration',
  'maximumFileSize',
]);

const ACCEPTABLE_STATUSES = new Set([
  'active',
  'approved',
  'published',
  'online',
  '1',
]);

function scalar(record, names) {
  for (const name of names) {
    const value = record?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function marketplaceServiceId(record) {
  const numericId = scalar(record, ['id']);
  if (Number.isInteger(Number(numericId)) && Number(numericId) > 0) {
    return String(numericId).trim();
  }
  const serviceId = scalar(record, ['serviceId', 'service_id']);
  return serviceId == null ? null : String(serviceId).trim();
}

function collectServiceRecords(value, context = {}, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectServiceRecords(item, context, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  const agentInfo = value.agentInfo && typeof value.agentInfo === 'object'
    ? value.agentInfo
    : null;
  const nextContext = {
    providerId:
      scalar(value, ['providerId', 'agentId', 'aspId']) ??
      scalar(agentInfo, ['providerId', 'agentId', 'aspId']) ??
      context.providerId,
    agentInfo: agentInfo || context.agentInfo,
  };
  const serviceId = marketplaceServiceId(value);
  const looksLikeService = Boolean(
    scalar(value, ['serviceId', 'service_id']) ||
    scalar(value, ['serviceName', 'serviceType']) ||
    scalar(value, ['fee', 'subscription'])
  );
  if (serviceId !== null && looksLikeService) {
    output.push({
      ...value,
      __marketplaceServiceId: serviceId,
      __providerId: nextContext.providerId,
      __agentInfo: nextContext.agentInfo,
    });
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      collectServiceRecords(child, nextContext, output);
    }
  }
  return output;
}

function normalizedLiveContract(response, providerId, serviceId) {
  if (!response?.ok) {
    throw new MarketplaceContractError(
      'MARKETPLACE_METADATA_UNAVAILABLE',
      'Live marketplace service metadata could not be retrieved.'
    );
  }
  const matches = collectServiceRecords(response).filter(
    (service) => service.__marketplaceServiceId === String(serviceId)
  );
  if (matches.length !== 1) {
    throw new MarketplaceContractError(
      matches.length ? 'MARKETPLACE_SERVICE_AMBIGUOUS' : 'MARKETPLACE_SERVICE_NOT_FOUND',
      `Live marketplace service ${serviceId} was not found exactly once.`
    );
  }
  const service = matches[0];
  const agentInfo = service.__agentInfo || {};
  const explicitStatus = scalar(service, ['status', 'serviceStatus', 'state']);
  const status = explicitStatus ?? (
    Number(agentInfo.approvalStatus) === 3 &&
    Number(agentInfo.status) === 2
      ? 'approved'
      : ''
  );
  const fee = scalar(service, ['feeAmount', 'price', 'serviceFee', 'fee']);
  const subscription = Array.isArray(service.subscription)
    ? service.subscription
    : [];
  return {
    providerId: String(
      scalar(service, ['providerId', 'agentId', 'aspId']) ?? service.__providerId ?? providerId ?? ''
    ).trim(),
    serviceId: service.__marketplaceServiceId,
    externalServiceId: String(scalar(service, ['serviceId', 'service_id']) ?? '').trim(),
    serviceName: String(scalar(service, ['serviceName', 'name']) ?? '').trim(),
    serviceDescription: String(
      scalar(service, ['serviceDescription', 'description']) ?? ''
    ).trim(),
    serviceType: String(scalar(service, ['serviceType', 'type']) ?? '').trim().toUpperCase(),
    status: String(status).trim().toLowerCase(),
    feeAmount: String(fee ?? '').trim(),
    feeCurrency: String(
      scalar(service, ['feeCurrency', 'currency', 'token']) ??
      (fee != null ? 'USDT' : '')
    ).trim().toUpperCase(),
    subscription,
    endpoint: scalar(service, ['endpoint']),
    pricingModel:
      fee != null && subscription.length === 0
        ? 'fixed_service_total'
        : subscription.length > 0
          ? 'subscription'
          : 'unpriced',
  };
}

function finding(code, message, detail = undefined) {
  return {
    code,
    message,
    ...(detail === undefined ? {} : { detail }),
  };
}

function contradictionFindings(description) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  const contradictions = [];
  const patterns = [
    {
      code: 'MULTIPLE_CLIPS_PROMISED',
      expression: /\b(?:two|2|three|3|multiple)\b.{0,60}\bclips?\b/i,
    },
    {
      code: 'BUYER_SELECTED_QUANTITY_PROMISED',
      expression:
        /\b(?:target|requested|preferred|choose|select(?:ed)?)\s+(?:the\s+)?(?:clip\s+)?(?:count|quantity|number of clips)\b/i,
    },
    {
      code: 'GUARANTEED_DEADLINE_PROMISED',
      expression:
        /\b(?:guaranteed?|promise[sd]?|will\s+meet)\b.{0,40}\b(?:deadline|sla)\b|\b(?:deadline|sla)\b.{0,40}\b(?:guaranteed?|promise[sd]?)\b/i,
    },
  ];
  for (const pattern of patterns) {
    if (pattern.expression.test(text)) contradictions.push(pattern.code);
  }
  return contradictions;
}

function evaluateLiveMarketplaceListing(live, local, { providerId }) {
  const checks = {};
  const failures = [];
  const check = (name, ok, code, message, detail) => {
    checks[name] = { ok, ...(detail === undefined ? {} : { detail }) };
    if (!ok) failures.push(finding(code, message, detail));
  };

  check(
    'provider',
    live.providerId === String(providerId),
    'MARKETPLACE_WRONG_PROVIDER',
    'Live service is not listed under the configured provider.',
    { expected: String(providerId), actual: live.providerId }
  );
  check(
    'serviceExists',
    live.serviceId === String(local.serviceId),
    'MARKETPLACE_WRONG_SERVICE',
    'Live service ID does not match local configuration.',
    { expected: String(local.serviceId), actual: live.serviceId }
  );
  check(
    'serviceType',
    live.serviceType === 'A2A',
    'MARKETPLACE_WRONG_SERVICE_TYPE',
    'ClipAgent service must use the A2A service type.',
    { expected: 'A2A', actual: live.serviceType }
  );
  check(
    'status',
    ACCEPTABLE_STATUSES.has(live.status),
    'MARKETPLACE_SERVICE_INACTIVE',
    'Live service is not active for receiving work.',
    { actual: live.status }
  );
  check(
    'price',
    Number.isFinite(Number(live.feeAmount)) &&
      Number(live.feeAmount) === Number(local.feeAmount),
    'MARKETPLACE_WRONG_PRICE',
    'Live fixed fee does not match the local contract.',
    { expected: local.feeAmount, actual: live.feeAmount }
  );
  check(
    'currency',
    live.feeCurrency === local.feeCurrency,
    'MARKETPLACE_WRONG_CURRENCY',
    'Live fee currency does not match the local contract.',
    { expected: local.feeCurrency, actual: live.feeCurrency }
  );
  check(
    'pricing',
    live.pricingModel === 'fixed_service_total',
    'MARKETPLACE_WRONG_PRICING_MODEL',
    'Live service must use a fixed per-service fee without subscription pricing.',
    { expected: 'fixed_service_total', actual: live.pricingModel }
  );
  check(
    'endpoint',
    live.endpoint == null || String(live.endpoint).trim() === '',
    'MARKETPLACE_WRONG_ENDPOINT',
    'ClipAgent A2A service must not publish a legacy HTTP endpoint.',
    { expected: null, actual: live.endpoint }
  );
  const contradictions = contradictionFindings(live.serviceDescription);
  check(
    'descriptionCompatibility',
    contradictions.length === 0,
    'MARKETPLACE_DESCRIPTION_CONTRADICTS_CONTRACT',
    'Live service description contradicts the local ClipAgent contract.',
    { contradictions }
  );

  return {
    ok: failures.length === 0,
    checks,
    failures,
    detail: {
      providerId: Number(live.providerId),
      serviceId: Number(live.serviceId),
      externalServiceId: live.externalServiceId,
      serviceName: live.serviceName,
      serviceType: live.serviceType,
      status: live.status,
      feeAmount: live.feeAmount,
      feeCurrency: live.feeCurrency,
      pricingModel: live.pricingModel,
      endpoint: live.endpoint,
    },
  };
}

function assertLiveContractMatches(live, local, options) {
  const result = evaluateLiveMarketplaceListing(live, local, options);
  if (!result.ok) {
    const first = result.failures[0];
    throw new MarketplaceContractError(first.code, first.message);
  }
  return result.detail;
}

async function checkLiveMarketplaceContract({
  runCommand,
  env,
  providerId,
  serviceContract,
}) {
  let response;
  try {
    const result = await runCommand(
      'onchainos',
      ['agent', 'service-list', '--agent-id', String(providerId)],
      { env, timeout: 20_000 }
    );
    response = JSON.parse(String(result.stdout || '').trim());
  } catch {
    return {
      ok: false,
      checks: {
        metadata: { ok: false },
      },
      failures: [
        finding(
          'MARKETPLACE_METADATA_UNAVAILABLE',
          'Live marketplace service metadata could not be retrieved.'
        ),
      ],
      detail: null,
    };
  }
  let live;
  try {
    live = normalizedLiveContract(response, providerId, serviceContract.serviceId);
  } catch (error) {
    return {
      ok: false,
      checks: {
        serviceExists: { ok: false },
      },
      failures: [
        finding(
          error.code || 'MARKETPLACE_METADATA_UNAVAILABLE',
          error.message || 'Live marketplace service metadata could not be validated.'
        ),
      ],
      detail: null,
    };
  }
  return evaluateLiveMarketplaceListing(live, serviceContract, { providerId });
}

module.exports = {
  MarketplaceContractError,
  MARKETPLACE_CAPABILITY_LIMITATIONS,
  collectServiceRecords,
  marketplaceServiceId,
  normalizedLiveContract,
  contradictionFindings,
  evaluateLiveMarketplaceListing,
  assertLiveContractMatches,
  checkLiveMarketplaceContract,
};
