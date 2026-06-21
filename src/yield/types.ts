// Shared interface for "where can idle DeepStack capital earn yield?".
//
// DeepStack's market-making core holds inventory (sBTC, STX, USDC...) that is
// not always fully deployed. A YieldVenue is anywhere that idle inventory can be
// parked for yield between market-making. Keeping this behind one interface lets
// DeepStack's treasury logic stay venue-agnostic, and lets us add execution
// (supply/withdraw) later without touching callers.

export interface YieldOpportunity {
  venue: string; // e.g. "zest-v2"
  chain: string; // e.g. "Stacks"
  asset: string; // e.g. "sBTC"
  poolId: string; // venue/source pool identifier
  apyBase: number; // % base supply APY
  apyReward: number; // % incentive APY
  apyTotal: number; // % base + reward
  tvlUsd: number;
  riskScore: number; // 0..1, higher = safer (liquidity/TVL proxy for now)
  score: number; // ranking score = apyTotal * riskScore
}

export interface YieldFilter {
  assets?: string[]; // case-insensitive symbols to keep, e.g. ["sBTC","STX"]
  minTvlUsd?: number; // drop pools thinner than this
}

export interface YieldVenue {
  readonly name: string;
  readonly chain: string;
  /** Read-only: rank where idle capital could go. No funds move. */
  listOpportunities(filter?: YieldFilter): Promise<YieldOpportunity[]>;

  // --- execution, deferred until the read-only side is proven ---
  // supply(asset: string, amount: bigint): Promise<{ txid: string }>;
  // withdraw(asset: string, amount: bigint): Promise<{ txid: string }>;
  // position(): Promise<{ asset: string; amount: bigint; valueUsd: number }[]>;
}

// TVL-based safety proxy: $10M+ pool => full marks. Crude but honest for an MVP;
// replace with utilization / oracle / audit signals when we add execution.
export function tvlRiskScore(tvlUsd: number): number {
  return Math.max(0, Math.min(1, tvlUsd / 10_000_000));
}
