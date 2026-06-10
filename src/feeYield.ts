// Projected LP fee yield for a pool.
//
// LPs earn only the PROVIDER portion of the swap fee (the protocol keeps the
// rest). For a given daily volume and pool TVL:
//
//   daily fees to LPs = dailyVolumeUsd * providerFee
//   APR              = daily fees / TVL * 365
//
// Volume on thin Stacks pools is sparse, so rather than over-claim from a
// possibly-zero ticker field, we show APR across a few daily-turnover
// scenarios (turnover = dailyVolume / TVL). This is honest and lets a reviewer
// see exactly how the yield scales with the activity a market maker brings.

export interface YieldScenario {
  turnover: number; // daily volume / TVL
  dailyVolumeUsd: number;
  dailyFeesUsd: number;
  aprPct: number;
}

export function lpAprPct(
  tvlUsd: number,
  dailyVolumeUsd: number,
  providerFeeBps: number,
): number {
  if (tvlUsd <= 0) return 0;
  const feeFraction = providerFeeBps / 10_000;
  const dailyFees = dailyVolumeUsd * feeFraction;
  return (dailyFees / tvlUsd) * 365 * 100;
}

export function yieldScenarios(
  tvlUsd: number,
  providerFeeBps: number,
  turnovers: number[] = [0.05, 0.1, 0.25, 0.5, 1.0],
): YieldScenario[] {
  const feeFraction = providerFeeBps / 10_000;
  return turnovers.map((turnover) => {
    const dailyVolumeUsd = tvlUsd * turnover;
    const dailyFeesUsd = dailyVolumeUsd * feeFraction;
    return {
      turnover,
      dailyVolumeUsd,
      dailyFeesUsd,
      aprPct: lpAprPct(tvlUsd, dailyVolumeUsd, providerFeeBps),
    };
  });
}
