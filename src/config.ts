// Central config for the PoC spike. Values come from .env (see .env.example),
// with safe public defaults so the spike runs with zero setup.

export const config = {
  stacksApi: process.env.STACKS_API ?? "https://api.mainnet.hiro.so",
  bitflowTickerApi:
    process.env.BITFLOW_TICKER_API ??
    "https://bitflow-sdk-api-gateway-7owjsmt8.uc.gateway.dev",
  // Any valid mainnet principal works as the "sender" for read-only calls.
  senderAddress: process.env.SENDER_ADDRESS ?? "SP000000000000000000002Q6VF78",
  // MM params. In production the AI layer (OpenRouter) tunes these on a cadence;
  // here they are static so the deterministic core is fully reproducible.
  targetSpreadBps: Number(process.env.TARGET_SPREAD_BPS ?? 20),
  lpRangeBps: Number(process.env.LP_RANGE_BPS ?? 150),
};

// Tokens we care about for the Bitcoin-native liquidity thesis.
// Matched loosely against ticker symbols/principals (case-insensitive substring).
export const BTC_HINTS = ["btc", "sbtc", "abtc", "xbtc"];
export const USD_HINTS = ["usd", "usda", "susdt", "aeusdc", "usdh"];
