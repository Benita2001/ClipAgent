/**
 * Official OKX x402 Payment SDK wiring — matches the canonical "Fixed price
 * per call" pattern in OKX's own agent-integration reference exactly:
 * https://raw.githubusercontent.com/okx/payments/main/typescript/SELLER.md
 * (fetched and read in full; this is not a paraphrase).
 */

const { x402ResourceServer, x402HTTPResourceServer } = require('@okxweb3/x402-core/server');
const { OKXFacilitatorClient } = require('@okxweb3/x402-core');
const { ExactEvmScheme } = require('@okxweb3/x402-evm/exact/server');

// XLayer — agent identities (and this ASP's payments) are chain-fixed here.
const NETWORK = 'eip155:196';

// This ASP's registered wallet address (agentWalletAddress / ownerAddress from
// `onchainos agent get-agents --agent-ids 6041`), re-fetched fresh.
const PAY_TO = '0x344fdf33c7907c1267c73b940ce91741097cea49';

// "1" (plain money string) — the SDK's own parsePrice() resolves this to the
// correct atomic amount + default token (USDT0 on X Layer) internally.
const PRICE = '1';

const MAX_TIMEOUT_SECONDS = 60;

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

const accepts = { scheme: 'exact', payTo: PAY_TO, price: PRICE, network: NETWORK, maxTimeoutSeconds: MAX_TIMEOUT_SECONDS };
const description = 'ClipAgent — extracts the most valuable moments from long videos and cuts them into short, ready-to-post clips.';

const routes = {
  'GET /clip': { accepts, description },
  'POST /clip': { accepts, description },
};

const httpServer = new x402HTTPResourceServer(resourceServer, routes);

module.exports = { resourceServer, httpServer, routes, NETWORK, PAY_TO, PRICE };
