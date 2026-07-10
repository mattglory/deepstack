// Verified mainnet constants + pair REGISTRY for Bitflow XYK pools.
//
// Adding a new XYK pair is a CONFIG change: add one entry to PAIRS. No code edits
// elsewhere. All values verified against live contracts. Select the active pair at
// runtime with the PAIR env var (default "sbtc-stx").
//
// Note the leg arrangement differs per pair: for sBTC-STX, x=sBTC (SIP-010 FT) and
// y=STX (native); for STX-aeUSDC, x=STX (native) and y=aeUSDC (FT). Code that builds
// post-conditions must therefore branch on `token.native`, not assume which leg is STX.

export const CORE = {
  address: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR",
  name: "xyk-core-v-1-2",
} as const;

export interface Token {
  address: string;
  name: string;
  asset?: string; // SIP-010 FT asset name; omit when native STX
  decimals: number;
  native?: boolean; // true = native STX -> post-condition uses .ustx()
  symbol: string; // for display
  coingecko: string; // id for the external price cross-check (safety layer)
}

export interface PoolConfig {
  key: string;
  poolSymbol: string;
  pool: { address: string; name: string };
  lp: { address: string; name: string; asset: string; decimals: number };
  x: Token; // base token
  y: Token; // quote token; midXinY = y per 1 x
  deprecated?: string; // reason — kept selectable so users can EXIT positions
}

const BF = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR"; // Bitflow deployer

export const PAIRS: Record<string, PoolConfig> = {
  "sbtc-stx": {
    key: "sbtc-stx",
    poolSymbol: "sBTC-STX",
    pool: { address: BF, name: "xyk-pool-sbtc-stx-v-1-1" },
    lp: { address: BF, name: "xyk-pool-sbtc-stx-v-1-1", asset: "pool-token", decimals: 6 },
    x: { address: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", name: "sbtc-token", asset: "sbtc-token", decimals: 8, symbol: "sBTC", coingecko: "bitcoin" },
    y: { address: BF, name: "token-stx-v-1-2", decimals: 6, native: true, symbol: "STX", coingecko: "blockstack" },
  },
  "stx-aeusdc": {
    key: "stx-aeusdc",
    poolSymbol: "STX-aeUSDC",
    deprecated:
      "aeUSDC is winding down on Stacks (Bitflow announcement, Jul 2026). Pool depth is draining ($56k→$10k). EXIT-ONLY: use to remove liquidity / swap out, do not open new positions. Successor asset is USDCx (Circle via xReserve); no meaningful STX-USDCx pool exists yet — add it to PAIRS when one launches.",
    pool: { address: BF, name: "xyk-pool-stx-aeusdc-v-1-2" },
    lp: { address: BF, name: "xyk-pool-stx-aeusdc-v-1-2", asset: "pool-token", decimals: 6 },
    x: { address: BF, name: "token-stx-v-1-2", decimals: 6, native: true, symbol: "STX", coingecko: "blockstack" },
    y: { address: "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K", name: "token-aeusdc", asset: "aeUSDC", decimals: 6, symbol: "aeUSDC", coingecko: "usd-coin" },
  },
};

let warnedDeprecated = false;

export function activePool(): PoolConfig {
  const key = (process.env.PAIR ?? "sbtc-stx").toLowerCase();
  const cfg = PAIRS[key];
  if (!cfg) {
    throw new Error(`unknown PAIR "${key}"; known: ${Object.keys(PAIRS).join(", ")}`);
  }
  if (cfg.deprecated && !warnedDeprecated) {
    warnedDeprecated = true; // once per process, not per call
    console.warn(`⚠ PAIR "${cfg.key}" is DEPRECATED: ${cfg.deprecated}`);
  }
  return cfg;
}

export const contractId = (c: {
  address: string;
  name: string;
}): `${string}.${string}` => `${c.address}.${c.name}`;

export const tokenId = (t: Token): `${string}.${string}` => `${t.address}.${t.name}`;
