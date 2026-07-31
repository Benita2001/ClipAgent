/**
 * Official OKX x402 Payment SDK wiring — matches the canonical per-request
 * payment pattern in OKX's own agent-integration reference exactly:
 * https://raw.githubusercontent.com/okx/payments/main/typescript/SELLER.md
 * (fetched and read in full; this is not a paraphrase).
 */

const { x402ResourceServer, x402HTTPResourceServer } = require('@okxweb3/x402-core/server');
const { OKXFacilitatorClient } = require('@okxweb3/x402-core');
const { ExactEvmScheme } = require('@okxweb3/x402-evm/exact/server');
const { coerceRequestedClipCount, formatClipPrice, CLIP_PRICE_USDT } = require('./clipPricing');

// XLayer — agent identities (and this ASP's payments) are chain-fixed here.
const NETWORK = 'eip155:196';

// This ASP's registered wallet address (agentWalletAddress / ownerAddress from
// the authenticated wallet identity), re-fetched fresh.
const PAY_TO = '0x344fdf33c7907c1267c73b940ce91741097cea49';

// "0.5" (plain money string) — the SDK's own parsePrice() resolves this to the
// correct atomic amount + default token (USDT0 on X Layer) internally.
const PRICE = CLIP_PRICE_USDT.toFixed(1);

const DEFAULT_MAX_TIMEOUT_SECONDS = 300;
const MIME_TYPE = 'application/json';

function clipPricingFromContext(context = {}) {
  const body = typeof context?.adapter?.getBody === 'function' ? context.adapter.getBody() || {} : {};
  const { clipCount, tooMany } = coerceRequestedClipCount(body.clipCount);
  return formatClipPrice(tooMany ? 1 : clipCount);
}

function readMaxTimeoutSeconds(value = process.env.X402_MAX_TIMEOUT_SECONDS) {
  if (value === undefined || value === '') return DEFAULT_MAX_TIMEOUT_SECONDS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('X402_MAX_TIMEOUT_SECONDS must be configured as a positive integer.');
  }
  return parsed;
}

const MAX_TIMEOUT_SECONDS = readMaxTimeoutSeconds();

const facilitatorClient = new OKXFacilitatorClient({
  apiKey: process.env.OKX_API_KEY,
  secretKey: process.env.OKX_SECRET_KEY,
  passphrase: process.env.OKX_PASSPHRASE,
  // When the route returns a successful response, wait for on-chain
  // confirmation before releasing that buffered response. The Express SDK
  // deliberately skips settlement for route responses with status >= 400.
  syncSettle: true,
});

const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());

const accepts = { scheme: 'exact', payTo: PAY_TO, price: clipPricingFromContext, network: NETWORK, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS };
const description =
  'ClipAgent creates ready-to-post clips from an HTTPS video URL. POST JSON requires videoUrl and optionally accepts clipCount, instructions, minDuration, and maxDuration. clipCount defaults to 1, is capped at 3, and the request price scales at 0.5 USDT per clip.';

const routes = {
  'POST /clip': { accepts, description, mimeType: MIME_TYPE },
};

const httpServer = new x402HTTPResourceServer(resourceServer, routes);

module.exports = {
  resourceServer,
  httpServer,
  routes,
  NETWORK,
  PAY_TO,
  PRICE,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  MIME_TYPE,
  readMaxTimeoutSeconds,
};
