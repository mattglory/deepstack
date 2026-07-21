// Regime-aware defensive allocation — the "capital-preservation reflex".
//
// A static 50/50 target is inventory-neutral (good for fee capture with no view) but has
// no reflexes: it holds half a crashing asset all the way down. Winning market makers skew
// their target with the regime (Avellaneda-Stoikov: inventory + volatility + risk aversion).
// This is that skew, made deterministic and bounded — the AI can inform the regime call,
// but the core decides and every output is clamped. It changes WHERE the target sits and
// HOW MUCH liquidity is exposed; it never removes a guardrail.
//
// The policy, by regime (derived from measured volatility + portfolio drawdown):
//   calm      → neutral 50/50, full LP        (make fees; no view)
//   elevated  → neutral 50/50, LP halved       (reduce impermanent-loss exposure in chop)
//   defensive → skew toward the safe asset, LP off (preserve capital; hold the harder money)
//
// THE TRUE SAFE ASSET IS A STABLECOIN (USDCx) — it holds value in a bear market; sBTC is
// still Bitcoin and falls in a crash. The full capital-preservation reflex rotates INTO
// USDCx, and that is the intended destination (see the "haven rotation" roadmap in
// docs/ALLOCATION.md), gated on a liquid USDCx pool/route existing — which it does not yet.
//
// Until then, on the stablecoin-less sBTC-STX pilot pair, the only defensive move available
// WITHIN the pair is an INTERIM one: skew toward the relatively harder asset (sBTC falls
// less than the STX alt) and pull LP to avoid impermanent loss. DEFENSIVE_Y_FRACTION carries
// the within-pair skew direction as config. This is a placeholder for the real thing, not
// the real thing. Gated OFF by default — the pilot runs the declared static 50/50.

export type Regime = "calm" | "elevated" | "defensive";

export interface AllocationSignals {
  sigmaDaily: number | null; // measured realised volatility (fraction/day)
  drawdownFrac: number; // current drawdown from the portfolio high-water mark (0..1)
}

export interface AllocationParams {
  enabled: boolean; // ALLOCATION_MODE=adaptive; default false keeps static 50/50
  neutralYFraction: number; // 0.5 — the risk-on target
  defensiveYFraction: number; // target Y in defensive mode (the safe-asset skew direction)
  fullLpFraction: number; // LP allocation when calm
  // Regime thresholds — deliberately conservative; a defensive skew is a lean, not a bet.
  volElevated: number; // sigma/day above which we trim LP (default 4%/day)
  volDefensive: number; // sigma/day above which we go defensive (default 6%/day)
  drawdownDefensive: number; // drawdown fraction that forces defensive regardless of vol
}

export interface AllocationDecision {
  regime: Regime;
  targetYFraction: number;
  targetLpFraction: number;
  reason: string;
}

export function defaultAllocationParams(): AllocationParams {
  const full = Number(process.env.TARGET_LP_FRACTION ?? 0);
  return {
    enabled: (process.env.ALLOCATION_MODE ?? "static").toLowerCase() === "adaptive",
    neutralYFraction: 0.5,
    defensiveYFraction: Number(process.env.DEFENSIVE_Y_FRACTION ?? 0.35), // <0.5 = skew toward x (sBTC)
    fullLpFraction: full,
    volElevated: Number(process.env.VOL_ELEVATED ?? 0.04),
    volDefensive: Number(process.env.VOL_DEFENSIVE ?? 0.06),
    drawdownDefensive: Number(process.env.DRAWDOWN_DEFENSIVE ?? 0.08), // 8% drawdown → defensive
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * Decide the target inventory split and LP exposure from the measured regime.
 * Pure, bounded, and a no-op (static neutral) unless explicitly enabled — so the pilot's
 * declared 50/50 is never changed by accident. An optional aiRegime can DOWNGRADE risk
 * appetite (calm→elevated→defensive) but never upgrade it: the model may make us MORE
 * cautious, never less. Risk controls only tighten on advice, never loosen.
 */
export function decideAllocation(
  s: AllocationSignals,
  p: AllocationParams,
  aiRegime?: Regime | null,
): AllocationDecision {
  if (!p.enabled) {
    return {
      regime: "calm",
      targetYFraction: p.neutralYFraction,
      targetLpFraction: p.fullLpFraction,
      reason: "adaptive allocation off — static neutral 50/50",
    };
  }

  const vol = s.sigmaDaily ?? 0;
  const dd = clamp01(s.drawdownFrac);

  // Deterministic regime from measured signals. Drawdown OR high vol forces defensive.
  let regime: Regime = "calm";
  if (dd >= p.drawdownDefensive || vol >= p.volDefensive) regime = "defensive";
  else if (vol >= p.volElevated) regime = "elevated";

  // The AI may only make us MORE defensive, never less (fail-safe on advice).
  const rank: Record<Regime, number> = { calm: 0, elevated: 1, defensive: 2 };
  if (aiRegime && rank[aiRegime] > rank[regime]) regime = aiRegime;

  const neutral = clamp01(p.neutralYFraction);
  const defensive = clamp01(p.defensiveYFraction);
  switch (regime) {
    case "defensive":
      return {
        regime,
        targetYFraction: defensive, // skew toward the safe asset
        targetLpFraction: 0, // pull liquidity — no IL exposure in a downturn
        reason: `defensive — ${dd >= p.drawdownDefensive ? `drawdown ${(dd * 100).toFixed(1)}%` : `vol ${(vol * 100).toFixed(1)}%/day`}: skew to safe asset, LP off`,
      };
    case "elevated":
      return {
        regime,
        targetYFraction: neutral, // still neutral inventory
        targetLpFraction: p.fullLpFraction / 2, // trim LP to cut impermanent-loss exposure
        reason: `elevated — vol ${(vol * 100).toFixed(1)}%/day: neutral inventory, LP halved`,
      };
    default:
      return {
        regime,
        targetYFraction: neutral,
        targetLpFraction: p.fullLpFraction,
        reason: "calm — neutral 50/50, full LP (fee capture)",
      };
  }
}
