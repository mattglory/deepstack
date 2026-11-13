# Change management and change freeze

**Status:** PROPOSED (assessment 2026-11, roadmap A7). It takes effect when both founders approve the PR that adds it. The approvals are the sign-off record.

## 1. Change freeze (in force until gates G3–G5 pass for the owner-capital agent)

While the freeze is in force:
- **No** increase in trading capital, position sizes, per-trade or per-position caps, `--max-trades`, or `DLMM_MAX_TARGET_USD`.
- **No** change to trading frequency (`--interval`) or to risk thresholds: oracle divergence, drawdown, slippage, pool-share caps.
- **No** new venues, pairs, strategies or autonomous routes. The flash route stays off.
- **No** v2 vault deployment on mainnet, and **no** outside deposits until **all** of G1–G8 pass (`docs/assessment` gates, held privately). That second rule is a hard boundary, not a freeze item.

What **is** allowed, through the normal process below:
- changes that only tighten safety (fail closed, extra checks, monitoring, alerting);
- fixes for assessed findings;
- tests, documentation, deploy hardening and tooling.

The freeze ends only by a written decision of both founders, recorded in this file, citing the gate evidence.

## 2. What counts as a sensitive change

Any change that affects:
- wallet signing or key handling (`wallet.ts`, `rotate-key*`, `narrow-key*`, `key-*`);
- trading logic, position sizing or risk limits (`agent*.ts`, `safety.ts`, `actions.ts`, `dlmm-*`, `m2/`, `allocation.ts`, `ai/`);
- contract behaviour (`contracts/`, `clarinet/`);
- deposits or withdrawals (`owner-withdraw-cli.ts`, `vault-*`);
- deployment or CI (`deploy/`, `.github/`, `package.json`, `package-lock.json`);
- **runtime configuration on the server**, i.e. any `.env` value that changes behaviour (the `DLMM_*` values, caps, `--live` flags).

## 3. Rules for sensitive changes

1. **Through a pull request**, never a direct push. `main` is protected: CI must be green, and one approving review is needed from a code owner **other than the author** (`.github/CODEOWNERS`).
2. **The PR states the live behaviour change** in one plain paragraph: what the agent will do differently, and why that is equal or safer. "No behaviour change" must be stated when true.
3. **Tests first:** a regression test that fails without the change, plus the full suites (`npm test`, `npm run typecheck`, `cd clarinet && npm test`).
4. **Deploy only a merged, CI-green commit**, by SHA. The deployer records the SHA, time and reason in the deploy log (§5).
5. **Server configuration changes** (`.env` values that change behaviour) need the same two-person approval. Record them in the deploy log, with the variable name and old → new value. Secrets themselves are never recorded.
6. **Contract changes** additionally need:
   - re-running the full Clarinet suite and the invariant runs;
   - an update to the design note;
   - before any mainnet deployment, an outside review of the exact commit.
7. **Neither founder approves their own sensitive change.** The security lead does not approve her own security tooling alone, and the operator does not deploy his own unreviewed change.

## 4. Emergency changes

When funds are at risk:
- **First, halt.** `deploy/watch.sh kill` or the independent halt key (`docs/INDEPENDENT_HALT.md`). Halting is always allowed and needs no approval.
- A fix needed to restore safe operation may be deployed with **one** founder's approval if the other cannot be reached within 2 hours. It is reviewed retrospectively within 24 hours, and the incident is recorded.
- Resuming trading after an emergency needs both founders' agreement.

## 5. Deploy log

Kept privately, for example in the shared tracker. One line per deploy or configuration change:

```
<UTC time> | <deployed SHA or config change> | <PR / reason> | deployed by | approved by | result (healthy report time)
```

## 6. Review of this policy

This policy is reviewed when a gate passes, when the team changes, or after any incident.
