# Trend-rule validation: fixed before any result is looked at (2026-11-13T10:29Z)

Rule (unchanged from the 2026-11-12 sketch):
- Normal: hold 50/50 risk asset / USDC by value (rebalanced only when switching back in).
- Exit to 100% USDC when the daily close < SMA_N x (1 - b). Re-enter 50/50 when close > SMA_N x (1 + b).
- Cost: 0.5% of the notional swapped on every switch. Cash earns 0% (conservative; Zest pays ~1.6%).

Primary candidate (declared now): N = 60 days, b = 2%.
Robustness grid (reported in full, no cherry-picking): N in {20, 40, 60, 90, 120, 200}, b in {0%, 2%, 5%}.

Data: DefiLlama daily closes. Out of sample: BTC 2017-01 to 2024-11 (before the window the rule was sketched on), ETH 2017-01 to 2026-11. In sample (for reference only): BTC 2024-11 to 2026-11.

Tests:
1. Full-period return and max drawdown vs hold 50/50 and vs 100% USDC.
2. Rolling 365-day windows started on the 1st of every month: share of windows where the rule
   (a) has a smaller max drawdown than hold 50/50, (b) ends with more money than hold 50/50, (c) loses more than 20%.
Pass criteria (declared now): (a) >= 70% of windows, and (c) no worse than hold 50/50, on BOTH out-of-sample sets.
Return beating hold is NOT required: the goal is protecting capital, and giving up some upside is the expected price.
