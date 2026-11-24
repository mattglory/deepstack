# AI direction forecast: pre-registered test

*Written 2026-11-21, before any forecast has been made. The commit that adds this file is the
timestamp. Nothing below may change once the first forecast is logged. A change to the model, the
prompt, the inputs or the scoring restarts the test from day 0 with a new version of this file.*

## 1. Question

Can a language model, given only the data the agent already has, forecast the direction of BTC/USD
better than simple baselines, and better than the trend rule of
the capital-preservation design (#90, `docs/CAPITAL_PRESERVATION_DESIGN.md`)?

The default expectation is **no**. Short-horizon direction is close to unpredictable from public
price data, and a language model gives a confident answer whether or not it has an edge. This test
exists so that the answer is measured, not assumed.

## 2. Why a live, forward test only

A model's training data contains historical BTC prices up to its cutoff, so a backtest on history
can be contaminated: the model may recall what happened next. Only forecasts made before the
outcome exists count. No historical replay is part of this test.

## 3. The forecaster (fixed for the whole test)

- **Model:** one pinned model id, recorded with every forecast. No moving alias such as
  `-latest` (the agent's tuner currently uses `~anthropic/claude-sonnet-latest`, which would change
  mid-test). The exact id is fixed in the commit that adds the forecaster code, before the first
  forecast, and that commit links back to this file.
- **Prompt:** fixed text, stored in the repository; its SHA-256 is recorded with every forecast.
  Temperature 0.
- **Inputs:** only numbers the agent already holds at decision time, from
  `journal/trend-closes.json` (verified daily closes) and the trend step:
  - the last 90 completed daily BTC/USD closes;
  - the 60-day average and the close's distance from it;
  - 30-day realised volatility.

  No news, social posts or other free text. They can't be verified, and they are an easy way to
  steer a model (the same class of risk as a manipulated price feed).
- **Output:** JSON `{ "p_up_1d": 0..1, "p_up_7d": 0..1 }`, the probability that the close in 1 day
  and in 7 days is above the latest close. Anything that doesn't parse is logged as a missing
  forecast, never filled in or retried with a different prompt.
- **When:** once a day, at the trend rule's decision time (`TREND_DECISION_UTC_HOUR`, random
  minute), on the same completed close the rule uses. It is logged to the journal
  (`ai-forecast`) with the model id, prompt hash, inputs hash and timestamp **before** the
  outcome exists.
- **Effect on funds: none.** Observe only. Nothing reads the forecast to make a decision during
  the test.

## 4. Outcomes

From the same verified daily closes. For a forecast made on close D:

- 1-day: up if close(D+1) > close(D);
- 7-day: up if close(D+7) > close(D).

A missing or unverified outcome close leaves that forecast unscored (counted and reported).

## 5. Baselines (each scored the same way)

| Baseline | p_up |
|---|---|
| Coin flip | 0.5 |
| Base rate | share of up moves over the trailing 365 days, at that horizon |
| Persistence | 1 if the last move at that horizon was up, else 0, shrunk to 0.6 / 0.4 |
| Trend rule | 0.6 if the rule's state is risk-on, else 0.4 |

## 6. Scoring

- **Primary: Brier score of `p_up_7d`** (mean of (p − outcome)²; lower is better; a coin flip
  scores 0.25).
- **Secondary:**
  - the Brier score of `p_up_1d`;
  - the hit rate (p > 0.5 counted as "up");
  - an economic check: a 30% sBTC / 70% USDCx holding that is risk-on when `p_up_7d` > 0.5, else
    100% USDCx, traded the next day at 0.5% per switch, compared with the trend rule on the same
    days.
- **Uncertainty:** the 7-day forecasts overlap, so day-to-day results are not independent.
  Confidence intervals use a block bootstrap with 7-day blocks (10,000 resamples).

## 7. Length and decision

- **Stage 1: 90 scored 7-day forecasts.** That is too few to prove an edge. It can only show that
  one is absent or worth a longer look.
- **Pass at stage 1 requires all of:**
  1. the 7-day Brier score is lower than every baseline in section 5;
  2. the 95% interval for (coin-flip Brier − AI Brier) is entirely above 0;
  3. the economic check is no worse than the trend rule after costs.
- **Fail:** the test stops and the result is published as it is.
- **Pass at stage 1:** run stage 2, another 90 days with nothing changed. The same criteria must hold
  on stage 2 alone.
- **Only after both stages pass** may the forecast be proposed as an input, and then only
  asymmetrically: it may make the agent more defensive (for example, risk-off earlier), never
  less. It can't override the trend rule's risk-off or the safety layer. That proposal is a new
  design, reviewed before any code.

## 8. Rules that keep the test honest

- No looking at interim scores to adjust anything. Scores are computed at the end of each stage by
  a script that is committed before that stage's first forecast.
- Missed days stay missing and are reported. They are never back-filled.
- Every forecast record stays in the journal; none is deleted or edited.
- Cost: one model call a day.

## 9. Prerequisites

The forecaster reads the verified closes from the trend observe step (#104), so it is built after
#104 is merged and runs on the same days.
