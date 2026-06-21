// Verified mainnet constants for the Bitflow sBTC-STX XYK pool (M1 write-side).
// All values confirmed against live contracts (Jun 2026):
//  - you always call CORE, passing POOL + both tokens as trait refs
//  - sBTC is a SIP-010 FT (asset name "sbtc-token")
//  - token-stx-v-1-2 defines NO fungible token => the y leg moves NATIVE STX,
//    so its post-condition uses .ustx(), not .ft()

export const CORE = {
  address: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR",
  name: "xyk-core-v-1-2",
} as const;

export const POOL = {
  address: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR",
  name: "xyk-pool-sbtc-stx-v-1-1",
} as const;

// x-token
export const SBTC = {
  address: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4",
  name: "sbtc-token",
  asset: "sbtc-token", // SIP-010 FT asset name for post-conditions
  decimals: 8,
} as const;

// y-token (wrapped-STX trait; transfers move native STX)
export const STX = {
  address: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR",
  name: "token-stx-v-1-2",
  decimals: 6, // 1 STX = 1e6 microSTX
  native: true, // post-condition uses .ustx()
} as const;

// LP token is a SIP-010 FT minted by the pool contract (asset name "pool-token").
export const POOL_LP = {
  address: POOL.address,
  name: POOL.name,
  asset: "pool-token",
  decimals: 6,
} as const;

export const contractId = (c: {
  address: string;
  name: string;
}): `${string}.${string}` => `${c.address}.${c.name}`;
