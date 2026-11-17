# Volatility-targeting validation: fixed before any result is looked at (2026-11-13T14:47Z)

Question: does scaling the sBTC share by recent volatility improve on the trend rule alone
(PREREGISTERED.md: 50/50, all USDC below SMA60 x 0.98, back above SMA60 x 1.02)?

Primary candidate "trend + vol" (declared now):
- Trend rule unchanged. When it is risk-off: 0% risk asset.
- When risk-on: risk weight w = 0.5 x min(1, 50% / sigma20), where sigma20 is the annualised realised
  volatility of daily log returns over the last 20 days (sqrt(365) scaling). So w is 50% when
  sigma20 <= 50%, and less when the market is wilder.
- Rebalance only when |w_current - w_target| > 5 percentage points (limits costs). Cost 0.5% of the
  notional swapped. Cash earns 0%.
Secondary (reported, not judged): "vol only" (same w, no trend rule).
Robustness grid (reported in full): sigma_target in {30%, 50%, 70%}, vol lookback in {10, 20, 40} days.

Same data and windows as before: BTC 2019-01..2024-11 and ETH 2019-01..2026-11 out of sample;
BTC 2024-11..2026-11 for reference only. Rolling 365-day windows from the 1st of each month.

Pass criteria (declared now), versus TREND ONLY, on BOTH out-of-sample sets:
(a) smaller max drawdown in >= 60% of windows;
(b) share of windows losing more than 20% no higher than trend only;
(c) average one-year return no more than 3 percentage points below trend only.
If it fails, the design keeps trend only.
