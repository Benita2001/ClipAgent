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

function collectServiceRecords(value, context = {}, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectServiceRecords(item, context, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  const nextContext = {
    providerId: scalar(value, ['providerId', 'agentId', 'aspId']) ?? context.providerId,
  };
  const serviceId = scalar(value, ['serviceId', 'service_id']);
  if (serviceId !== null) output.push({ ...value, __providerId: nextContext.providerId });
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
    (service) => String(scalar(service, ['serviceId', 'service_id'])).trim() === String(serviceId)
  );
  if (matches.length !== 1) {
    throw new MarketplaceContractError(
      matches.length ? 'MARKETPLACE_SERVICE_AMBIGUOUS' : 'MARKETPLACE_SERVICE_NOT_FOUND',
      `Live marketplace service ${serviceId} was not found exactly once.`
    );
  }
  const service = matches[0];
  return {
    providerId: String(
      scalar(service, ['providerId', 'agentId', 'aspId']) ?? service.__providerId ?? ''
    ).trim(),
    serviceId: String(scalar(service, ['serviceId', 'service_id'])).trim(),
    status: String(scalar(service, ['status', 'serviceStatus', 'state']) ?? '').trim().toLowerCase(),
    clipCount: Number(scalar(service, ['clipCount', 'outputQuantity', 'quantity'])),
    feeAmount: String(scalar(service, ['feeAmount', 'price', 'serviceFee']) ?? '').trim(),
    feeCurrency: String(scalar(service, ['feeCurrency', 'currency', 'token']) ?? '').trim().toUpperCase(),
    pricingModel: String(scalar(service, ['pricingModel', 'priceModel', 'pricingType']) ?? '').trim().toLowerCase(),
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
  normalizedLiveContract,
  assertLiveContractMatches,
  checkLiveMarketplaceContract,
};
