# Venue Vetting Checklist

A repeatable gate for deciding whether DeepStack should deploy capital on a venue.
Score every candidate (new pool, perp DEX, re-audited venue) the same way, so the
decision is consistent and evidence-based — not ad-hoc. Inspired by the "DeFi protocol
health check" framing; grounded in what the Velar / ALEX / HODLMM research taught us.

## How to use
Score each of the 6 dimensions 0–2 (0 = fail, 1 = caution, 2 = clean). Any **hard-stop**
(marked 🛑) is an automatic **GATED** regardless of total. Then apply the decision rule.

---

## 1. Security history & audit  🛑
- Has it been exploited? When, how much, root cause, remediated + **re-audited after**?
- Audit(s): firm, date, and does it cover **the exact deployment** we'd use (Clarity, not
  just an EVM twin)? Were flagged issues actually fixed?
- Time live without incident (time = trust).
- 🛑 **Hard stop:** a past exploit whose fix is *unconfirmed on the deployment we'd use*, or
  an auditor-flagged issue left unremediated.
- *Reference: Velar perps — pre-exploit Clarity audit flagged the oracle+pause gaps that
  later caused the hack; no post-exploit re-audit → GATED. ALEX — two exploits → avoid.*

## 2. Yield / revenue source
- Where does the return **actually** come from? Real fees vs token emissions vs incentives.
- If emissions/incentives stopped tomorrow, what's left?
- For MM: is there real two-sided flow, or is it a ghost venue?
- *Rule of thumb: if you can't state the yield source in one sentence, that IS the red flag.*

## 3. Exit / liquidity risk
- Can DeepStack exit its position quickly (no withdraw queue / lock)?
- Pool depth vs our size — can we add/withdraw without excessive slippage?
- What happens to our position if TVL drops 50% fast?

## 4. Governance & centralization
- Who can pause, upgrade, or change fees/parameters? Multisig? Admin keys?
- Can the team unilaterally alter contracts or seize funds?
- Is there a pause / circuit-breaker (its absence enabled the Velar drain)?

## 5. Oracle dependency  🛑
- Does pricing rely on an oracle? Which (Pyth/RedStone/…)? Manipulable in thin volume?
- Are there price-timestamp / staleness checks on-chain?
- 🛑 **Hard stop for perps/oracle-priced venues** with no timestamp/staleness guard.
- *Mitigation regardless: DeepStack's own oracle-sanity + kill-switch (`m1:safety`) cross-checks
  the venue mid against an independent reference and halts on divergence.*

## 6. Access & licensing
- Can a **third party** (us) manage positions programmatically, or is it first-party /
  whitelist only? (HODLMM = first-party Keepers only → not usable by us.)
- Code license — does it permit our use? (ALEX STXDX = BUSL.)
- Are contracts + interface public and documented enough to integrate safely?

---

## Decision rule
- **Any 🛑 hard-stop triggered → GATED** (do not deploy; monitor for the trigger to clear).
- **Total ≥ 10/12 and no 1s on dims 1, 5, 6 → GREEN** (deploy, start tiny, kill-switch in front).
- **7–9 → YELLOW** (spot/inventory use only, modest size; no leverage).
- **< 7 → AVOID.**

Regardless of score, DeepStack always runs its own **oracle-sanity + kill-switch** and
**input-cap post-conditions** — never trusting a venue's price or solvency blindly.

---

## Current scorecard (as of 2026-07)

| Venue | Sec/Audit | Yield src | Exit | Gov | Oracle | Access | Verdict |
|---|---|---|---|---|---|---|---|
| **Bitflow XYK (sBTC-STX, STX-aeUSDC)** | 2 | 2 | 2 | 1 | 2 (no oracle; reserves) | 2 | **GREEN** — validated, in use |
| **Bitflow HODLMM** | 2 (audited) | 2 | 2 | 1 | 1 | 🛑 0 (first-party only) | **GATED** (access) |
| **Velar spot AMM** | 2 (CoinFabrik) | 2 | 1 | 1 | 2 | 2 | **YELLOW** — usable, modest size |
| **Velar PerpDEX** | 🛑 0 (exploit, no re-audit) | 2 | 1 | 0 (no pause) | 🛑 0 (was manipulable) | 2 | **GATED** — see VELAR_VERIFY.md |
| **ALEX STXDX orderbook** | 🛑 0 (2 exploits) | 1 | 1 | 0 | 1 | 0 (whitelist, BUSL) | **AVOID** (+ likely superseded by ALEX2) |

Re-score whenever a venue changes: a Velar perps re-audit, ALEX2 launch, or HODLMM opening
to third parties. Keep this table current; it is the single gate for new-venue decisions.
