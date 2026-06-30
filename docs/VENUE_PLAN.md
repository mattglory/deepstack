# DeepStack — Venue-Diversified, Risk-Gated Expansion Plan

*Supersedes any "Velar-perps-first" framing. DeepStack is an independent,
cross-venue market-making agent; venue choice is driven by **safety first**, then
fit for the order-book quoting edge. Contract specifics are verified against live
contracts before any code (same discipline as M1).*

## Principle

Be independent and **cross-venue**, not locked to one DEX. Rank venues by safety,
deploy the quoting edge where it's both *applicable* and *safe*, and never trust a
venue's price or solvency blindly — DeepStack carries its own oracle-sanity checks and
kill-switch.

## Venue ranking (safety-first)

| Venue | Type | Fit | Status / gate |
|---|---|---|---|
| **Bitflow XYK** | Spot AMM | LP + inventory | ✅ validated on mainnet — keep as base |
| **ALEX order-book (STXDX)** | Limit + market orders | quoting — *but* | 🚫 **NOT recommended** — permissioned/whitelist, BUSL license, RedStone oracle, **2 prior exploits ($4.3M Lazarus 2024, $8.3M 2025)**; v1 likely being replaced by "ALEX2" (testnet) |
| **Velar spot AMM** | Spot AMM | inventory / routing | ✅ **UN-GATED** — separate system, CoinFabrik-audited (Feb 2024), NOT the exploited component |
| **Arkadiko AMM** | Spot AMM | inventory / routing | usable spot |
| **Velar PerpDEX** | Perps | ⭐ quoting — *but* | 🚫 **GATED** — see incident below |
| Zest / Granite | Lending | idle-capital yield (not MM) | already in `yield` module |

### Decision (2026-06): Velar SPOT un-gated, PERPS stay gated

**Spot AMM — un-gated.** Velar's spot AMM is a *separate* system (CoinFabrik Clarity
audit, Feb 2024) and was **not** the exploited component. Treat it like any other audited
Stacks AMM (Bitflow, Arkadiko) for inventory/routing — modest exposure, behind DeepStack's
own oracle-sanity + caps.

**PerpDEX — stays gated.** The Feb 19 2026 exploit (~$401k; oracle manipulation via
missing Pyth price-timestamp checks; no pause system) hit the perp pools. The **only**
PerpDex Clarity audit is **Thesis Defense, July 11 2024 — pre-exploit** — and it had
already **recommended strengthening the oracle and adding emergency controls**, i.e. the
very issues that caused the hack were flagged and not remediated. **No post-Feb-2026
Clarity re-audit exists.** Recovery was a "REKT" airdrop, not confirmed restitution. Do
**not** deploy capital/leveraged positions on Velar perps until a post-exploit Clarity
re-audit + oracle-timestamp + pause guard are confirmed (see `docs/VELAR_VERIFY.md`).

## ⚠️ Hard reality (researched 2026-06): no clean, open order-book venue exists yet

DeepStack's true edge is **order-book quoting**, but as of mid-2026 every order-book/perp
venue on Stacks has a blocking issue:

| Venue | Quoting? | Security | Open to 3rd-party MM? |
|---|---|---|---|
| Bitflow HODLMM | orderbook-style CL | clean (audited) | ❌ first-party Keepers only |
| Velar perps | yes | 1 exploit ($401k, pre-flagged) | open contracts but **gated** |
| ALEX STXDX | yes | **2 exploits ($4.3M+$8.3M)** | ❌ permissioned/whitelist, BUSL |

**Conclusion:** the quoting moat is currently **blocked by venue immaturity/insecurity, not
by DeepStack.** Near-term, operate AMM LP + inventory on **Bitflow XYK spot** (safe) behind
the oracle-sanity + kill-switch layer, and *monitor* for a venue to open up: a Velar perps
post-exploit re-audit, **ALEX2** maturing + opening, HODLMM exposing third-party strategies,
or a new clean perp/orderbook venue. Order-book MM on Stacks is **relationship-gated**
(whitelisting/partnership), so treat it as BD + monitoring, not an immediate build.

## The order-book quoting module (DeepStack's actual edge — venue-gated)

Built once a safe, open venue exists (currently none — see above). Applies to **Velar
perps once un-gated** or **ALEX2 once live/audited/open**:

- Two-sided quotes around a fair price with a target spread; inventory/skew management;
  for perps, funding-rate awareness and delta control.
- Reuses what's already built and mainnet-validated: the deterministic core, the
  off-hot-path AI tuning (OpenRouter → spread/size), the safety/guard pattern, and the
  public dashboard.

## New module the incident demands: oracle-sanity + kill-switch

Turn the Velar lesson into a feature. Before every quote/trade the agent:

1. **Cross-checks price** across ≥2 independent sources (venue mark, an external oracle,
   and a second venue's mid). Refuse to trade if they diverge beyond a band.
2. **Detects thin-volume / manipulation regimes** (the exact condition the Velar attacker
   exploited) and widens spreads or stands down.
3. **Kill-switch** — halts and alerts on anomalous price/funding, venue-pause flags, or
   drawdown limits. Never assumes the venue is safe.

This makes DeepStack *safer than the venues it trades on* — a genuine differentiator.

## Perp-specific risk (when/if Velar un-gates)

Leverage adds liquidation risk, funding cost, and directional exposure. The perps module
starts tiny, delta-aware, with hard limits (max position, max leverage, stop-out band,
daily-loss cap) and runs paper/observe until risk controls are proven.

## Phasing (Builder-grant narrative)

- **Phase A — Bitflow spot, hardened.** Extend the live agent; ship the oracle-sanity +
  kill-switch module. Lowest risk, immediate.
- **Phase B — order-book quoting, when a venue opens (BD + monitoring).** No safe, open
  order-book venue exists today (ALEX = exploited+permissioned; Velar perps = gated;
  HODLMM = closed). Monitor ALEX2, Velar remediation, and HODLMM; build the relationship/
  whitelist path. Build the quoting module only once a venue is safe AND open.
- **Phase C — Velar perps, gated.** Only after the Stacks deployment's remediation is
  confirmed: small, risk-limited perp market-making with the kill-switch in front.

Framed as: *"DeepStack — the independent, AI-driven, cross-venue market-making agent for
Bitcoin DeFi, with venue-agnostic risk controls — extending from spot to order-book
quoting (ALEX) and, when safe, perps (Velar)."* No competing-protocol build, plays to
the operator's real expertise, produces reusable open infrastructure.

## Verify-first checklists (before code)

**ALEX order-book (Phase B):**
- [ ] Order-book contract identifiers + place/cancel-order functions (from ALEX docs/repo)
- [ ] Public API/SDK for orders; mainnet status; third-party MM access permitted
- [ ] Order types (GTC/limit/market), fee schedule, settlement asset

**Velar perps (Phase C — gated):**
- [ ] Stacks (Clarity) PerpDEX re-audited post-Feb-2026; pause + oracle-timestamp guard added
- [ ] perpdex.velar.com operational; deposits open; no outstanding incident
- [ ] Perp contract functions (open/adjust/close/collateral/funding); 3rd-party access
