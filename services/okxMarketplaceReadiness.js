class MarketplaceContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MarketplaceContractError';
    this.code = code;
    this.statusCode = 503;
  }
}

function scalar(record, names) {
  for (const name of names) {
    const value = record?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function booleanValue(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null || value === '') return false;
  return String(value).trim().toLowerCase() === 'true';
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
  return {
    providerId: String(
      scalar(service, ['providerId', 'agentId', 'aspId']) ?? service.__providerId ?? ''
    ).trim(),
    serviceId: service.__marketplaceServiceId,
    externalServiceId: String(scalar(service, ['serviceId', 'service_id']) ?? '').trim(),
    status: String(status).trim().toLowerCase(),
    clipCount: Number(scalar(service, ['clipCount', 'outputQuantity', 'quantity'])),
    feeAmount: String(scalar(service, ['feeAmount', 'price', 'serviceFee', 'fee']) ?? '').trim(),
    feeCurrency: String(
      scalar(service, ['feeCurrency', 'currency', 'token']) ??
      (scalar(service, ['fee']) != null ? 'USDT' : '')
    ).trim().toUpperCase(),
    pricingModel: String(
      scalar(service, ['pricingModel', 'priceModel', 'pricingType']) ??
      (
        scalar(service, ['fee']) != null &&
        Array.isArray(service.subscription) &&
        service.subscription.length === 0
          ? 'fixed_service_total'
          : ''
      )
    ).trim().toLowerCase(),
    contractVersion: String(scalar(service, ['contractVersion', 'contract_version', 'version']) ?? '').trim(),
    buyerSelectableQuantity: booleanValue(
      scalar(service, ['buyerSelectableQuantity', 'quantitySelectable', 'allowQuantitySelection'])
    ),
    dynamicPricing: booleanValue(
      scalar(service, ['dynamicPricing', 'usagePricing', 'perClipPricing'])
    ),
  };
}

function assertLiveContractMatches(live, local, { providerId }) {
  const mismatch = (code, message) => {
    throw new MarketplaceContractError(code, message);
  };
  if (live.providerId !== String(providerId)) mismatch('MARKETPLACE_WRONG_PROVIDER', 'Live service belongs to a different provider.');
  if (live.serviceId !== String(local.serviceId)) mismatch('MARKETPLACE_WRONG_SERVICE', 'Live service ID does not match local configuration.');
  if (!new Set(['active', 'approved', 'published', 'online', '1']).has(live.status)) {
    mismatch('MARKETPLACE_SERVICE_INACTIVE', 'Live service is not active for receiving work.');
  }
  if (live.clipCount !== local.clipCount) mismatch('MARKETPLACE_WRONG_QUANTITY', 'Live output quantity does not match the local contract.');
  if (
    !Number.isFinite(Number(live.feeAmount)) ||
    Number(live.feeAmount) !== Number(local.feeAmount)
  ) {
    mismatch('MARKETPLACE_WRONG_PRICE', 'Live fixed fee does not match the local contract.');
  }
  if (live.feeCurrency !== local.feeCurrency) mismatch('MARKETPLACE_WRONG_CURRENCY', 'Live fee currency does not match the local contract.');
  if (live.pricingModel !== local.pricingModel) mismatch('MARKETPLACE_WRONG_PRICING_MODEL', 'Live pricing model does not match the local contract.');
  if (live.contractVersion !== local.contractVersion) mismatch('MARKETPLACE_WRONG_CONTRACT_VERSION', 'Live contract version does not match the worker.');
  if (live.buyerSelectableQuantity) mismatch('MARKETPLACE_BUYER_QUANTITY_ENABLED', 'Live service advertises buyer-selected quantity.');
  if (live.dynamicPricing) mismatch('MARKETPLACE_DYNAMIC_PRICING_ENABLED', 'Live service advertises dynamic or per-clip pricing.');
  return {
    providerId: Number(live.providerId),
    serviceId: Number(live.serviceId),
    status: live.status,
    contractVersion: live.contractVersion,
    clipCount: live.clipCount,
    feeAmount: live.feeAmount,
    feeCurrency: live.feeCurrency,
    pricingModel: live.pricingModel,
  };
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
    throw new MarketplaceContractError(
      'MARKETPLACE_METADATA_UNAVAILABLE',
      'Live marketplace service metadata could not be retrieved.'
    );
  }
  return assertLiveContractMatches(
    normalizedLiveContract(response, providerId, serviceContract.serviceId),
    serviceContract,
    { providerId }
  );
}

module.exports = {
  MarketplaceContractError,
  collectServiceRecords,
  marketplaceServiceId,
  normalizedLiveContract,
  assertLiveContractMatches,
  checkLiveMarketplaceContract,
};
