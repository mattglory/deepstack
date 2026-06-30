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
| **ALEX order-book** | Limit + market orders | ⭐ two-sided quoting (the edge) | live per docs; **verify contracts/API + 3rd-party access** |
| **Velar / Arkadiko AMM** | Spot AMM | inventory / routing | spot side usable |
| **Velar PerpDEX** | Perps | ⭐ quoting — *but* | 🚫 **GATED** — see incident below |
| Zest / Granite | Lending | idle-capital yield (not MM) | already in `yield` module |

### Why Velar perps is gated (not removed)

Velar PerpDEX suffered an **oracle-manipulation exploit on Feb 19 2026** (~$401k drained;
contracts lacked Pyth price-timestamp checks; a pause/slowdown system was missing and had
been auditor-flagged; affected Stacks + Mezo). Remediation is **partial**: the EVM (Vyper)
contracts were audited by Thesis Defense, but the **Stacks (Clarity) re-audit/relaunch
status is unconfirmed**, and recovery was a community "REKT" airdrop rather than confirmed
restitution. **Do not deploy DeepStack capital on Velar perps until the Stacks deployment
is confirmed fixed, re-audited, pause/oracle-guarded, and operating cleanly** (see
`docs/VELAR_VERIFY.md` for the check-yourself list).

## The order-book quoting module (DeepStack's actual edge)

Applies to **ALEX order-book** now, and **Velar perps** once un-gated:

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
- **Phase B — ALEX order-book quoting.** Prove the two-sided quoting edge on a real
  order book, cross-venue inventory with Bitflow. *(No perp/leverage risk.)*
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
