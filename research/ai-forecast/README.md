# AI direction forecast

- [PREREGISTERED.md](PREREGISTERED.md): the live test, fixed before any forecast.
- `prompt.txt`: the fixed prompt (SHA-256 `9f7721391ba7…`). It was committed before the backtest ran
  and has not been changed since.
- `backtest.py`: an **exploratory** backtest. It is not the pre-registered test and does not count
  towards it.

## Exploratory backtest, 2026-11-21

Model `anthropic/claude-sonnet-5.5` at temperature 0, with dates withheld, on 286 days from
2026-02-01 to 2026-11-13.

**Why these days.** Asked from memory for BTC on the 1st of each month from March to September
2026, the model said it didn't know and guessed $90k–98k; the actual prices were $59k–79k. It anchored
on October 2025. So these days fall after what it knows.

**Data.** DefiLlama's daily midnight closes (`closes.json`), not cross-checked against an exchange
in this backtest. A first run on a series with labelling gaps was discarded unscored (see git
history). The forecasts are in `forecasts.jsonl`.

| | 1 day | 7 days |
|---|---|---|
| Brier, AI | 0.2506 | 0.2520 |
| Brier, coin flip | 0.2500 | 0.2500 |
| Brier, best other baseline | 0.2506 (base rate) | 0.2519 (base rate) |
| Coin flip minus AI, 95% block-bootstrap CI | −0.0012 to −0.0001 | −0.0036 to +0.0005 |
| AI answered exactly 0.5 | 90% of days | 36% of days |

Economic check from 2026-02 to 2026-11 (30% sBTC when risk-on, else USDCx, next-day execution, 0.5%
per switch):
- AI (risk-on when p_up_7d > 0.5): **−15.4%**
- trend rule: **+5.9%**
- holding 30/70: −3.4%

**Reading.** No edge. The AI scored no better than a coin flip at either horizon; at 1 day it was
slightly worse, and that interval excludes zero. Mostly it declined to forecast, answering 0.5. When it
did lean, following it lost money against both the trend rule and holding. Over the same period the
trend rule, which predicts nothing and reacts to the 60-day average, finished ahead of both.
Under PREREGISTERED.md section 7 this would be a stage-1 fail.

Limits:
- One model, one prompt and about 9 months of data.
- The 7-day forecasts overlap, so there are about 41 independent weeks.
- A different model or prompt is a different hypothesis. It would need its own pre-registration.
