# How to verify Velar PerpDEX (Stacks) is safe to build on

The Feb 19 2026 oracle-manipulation exploit (~$401k) affected Velar's Stacks + Mezo
PerpDEX. The EVM contracts were audited (Thesis Defense), but the **Stacks (Clarity)**
remediation status is unconfirmed. Before deploying DeepStack capital on Velar perps,
confirm **all** of the following yourself. If any is "no/unknown" → stay gated.

## 1. Read the official record
- [ ] **@VelarBTC on X** — find the post-exploit thread(s): incident disclosure,
      remediation steps, and any **relaunch** announcement for the **Stacks** PerpDEX.
- [ ] **Velar blog** (blog.velar.co) and **docs.velar.com** — look for a post-mortem and,
      critically, an audit page that covers the **Stacks/Clarity** contracts (not only the
      EVM/Vyper Thesis Defense audit).
- [ ] **Mezo post-mortem** (mezo.org/blog) — already reviewed; corroborate against Velar's.

## 2. Confirm the specific fixes (the exact gaps that caused it)
Ask the Velar team directly (X / Discord) — these are the precise failure points:
- [ ] **Oracle price-timestamp checks** added to the Stacks contracts? (the root cause)
- [ ] **Pause / circuit-breaker / slowdown** system added? (it was missing and
      auditor-flagged before the hack)
- [ ] **Monitoring/alerting** in place so a drain can't run undetected for 2 weeks?
- [ ] **Stacks-specific security audit** completed and published (Clarity), with findings
      resolved?

## 3. Check on-chain, not just announcements
- [ ] On Stacks Explorer, identify the **current** Velar perp contracts. Were **new**
      (fixed) contracts deployed after Feb 2026? Check deployment dates — old vulnerable
      contracts should be retired, not just patched around.
- [ ] Is **perpdex.velar.com** live with deposits/withdrawals **open** (not paused), and
      no standing incident banner?

## 4. Was the community made whole?
- [ ] Was the "REKT" airdrop actual restitution, or a goodwill memecoin? (Affects how much
      to trust the team's risk culture — relevant since you'd custody collateral there.)

## Decision rule
- **All boxes checked + a published Stacks audit** → Velar perps moves from gated to
  Phase C candidate (still start tiny, with DeepStack's own kill-switch in front).
- **Any box unknown** → stay gated; deploy the quoting edge on **ALEX order-book** instead,
  which carries no leverage and no known incident.

> Regardless of outcome, DeepStack runs its **own** oracle-sanity checks and kill-switch
> (see `VENUE_PLAN.md`) — never trusting a venue's price or solvency blindly.
