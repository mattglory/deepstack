// A Stacks-native YieldVenue: Stacks lending markets (currently Zest V2).
//
// No bridge — same chain, same wallet, same assets DeepStack already holds — so
// idle inventory can be parked here directly. Read-only for now: it ranks where
// idle capital could earn the best risk-adjusted yield.

import {
  YieldVenue,
  YieldOpportunity,
  YieldFilter,
  tvlRiskScore,
} from "./types.js";
import { fetchChainPools } from "./defillama.js";

// Stacks lending projects we treat as candidate venues (DefiLlama slugs).
const STACKS_LENDING_PROJECTS = ["zest-v2", "granite"];

// Normalise DefiLlama's upper-case symbols to DeepStack's asset names.
function normaliseAsset(symbol: string): string {
  const map: Record<string, string> = {
    SBTC: "sBTC",
    STSTX: "stSTX",
    STSTXBTC: "stSTXbtc",
    USDH: "USDH",
    USDC: "USDC",
    STX: "STX",
  };
  return map[symbol.toUpperCase()] ?? symbol;
}

export class StacksLendingVenue implements YieldVenue {
  readonly name = "stacks-lending";
  readonly chain = "Stacks";

  async listOpportunities(filter?: YieldFilter): Promise<YieldOpportunity[]> {
    const pools = await fetchChainPools("Stacks", STACKS_LENDING_PROJECTS);
    const wantAssets = filter?.assets?.map((a) => a.toLowerCase());
    const minTvl = filter?.minTvlUsd ?? 0;

    const opps: YieldOpportunity[] = pools
      .map((p) => {
        const apyBase = p.apyBase ?? p.apy ?? 0;
        const apyReward = p.apyReward ?? 0;
        const apyTotal = apyBase + apyReward;
        const riskScore = tvlRiskScore(p.tvlUsd);
        return {
          venue: p.project,
          chain: "Stacks",
          asset: normaliseAsset(p.symbol),
          poolId: p.pool,
          apyBase,
          apyReward,
          apyTotal,
          tvlUsd: p.tvlUsd,
          riskScore,
          score: apyTotal * riskScore, // risk-adjusted: yield weighted by safety
        };
      })
      .filter((o) => o.tvlUsd >= minTvl)
      .filter(
        (o) => !wantAssets || wantAssets.includes(o.asset.toLowerCase()),
      )
      .sort((a, b) => b.score - a.score);

    return opps;
  }
}
