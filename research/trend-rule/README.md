# Trend-rule research

Simulations behind [docs/CAPITAL_PRESERVATION_DESIGN.md](../../docs/CAPITAL_PRESERVATION_DESIGN.md).
Historical simulations, not results.

- `PREREGISTERED.md`: the rule, the settings and the pass criteria, written before any result was seen.
- `fetch.sh`: downloads daily BTC and ETH closes from DefiLlama (public; data starts mid-2018).
- `validate.py`: the pre-registered test (full period, and rolling one-year windows), plus the settings grid.
- `PREREGISTERED_VOL.md`, `validate_vol.py`: the volatility-targeting test (did not pass; see the design note).
- `dlmm_sim.py`: the concentrated-liquidity simulation that motivated this work (needs 4-hourly BTC
  data; see its docstring for the model and its limits).

Run: `./fetch.sh && python3 validate.py`
