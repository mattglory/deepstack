# AUM vault — mainnet deployment runbook (Phase 1)

Deploys `contracts/deepstack-vault-token.clar` and `contracts/deepstack-vault.clar` to
mainnet and seeds the vault with DeepStack's own capital first — no third-party deposits
in this phase. Every broadcast is irreversible (Clarity has no in-place upgrade and no
undeploy); this is not a dry-run-able action past step 3.

**Status before this runbook is run:** both contracts exist only in this repo and on
Clarinet's simnet (60/60 tests passing, `clarinet check` clean, CI green as of commit
`4dd2d67`). Nothing below has been broadcast yet.

## 0. Preconditions — confirmed, not assumed

- Operator wallet `SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60` (the same wallet the pilot
  agent already trades from — "same wallet" was the deliberate Phase 1 choice, see
  `reports/DeepStack AUM vault architecture.md`) holds **~192.7 STX free, 0 locked**
  (checked live via the Hiro API on 2026-10-05 — reverify immediately before running step
  2, balances move).
- Neither `deepstack-vault` nor `deepstack-vault-token` exists at that address yet
  (confirmed via `/v2/contracts/interface` — both return "No contract interface data
  found"). This is a clean first deploy, not a redeploy.
- The SIP-010 trait dependency `SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.sip-010-trait-ft-standard-v-1-1`
  the token contract implements already exists live on mainnet (confirmed).
- Local `.env` already has `STACKS_NETWORK=mainnet` and `STACKS_PRIVATE_KEY` set to this
  same operator wallet — `npm run m1:vault` runs from this machine, no VPS SSH step needed
  for this particular action (unlike the `.env` edits blocked earlier this project for the
  live pilot agent).
- **Deploy fee was re-checked and bumped before this runbook was written.** The project's
  only prior deploy (the 7.8KB receiver contract) paid 150,000 µSTX and succeeded, but
  `deepstack-vault.clar` is ~22KB (~2.8x larger) and the current mainnet transfer-fee
  market (~13 µSTX/byte as of 2026-10-05) extrapolates to ~0.29 STX for a transaction this
  size. `src/m1/vault-cli.ts`'s `DEPLOY_FEE` is now `500,000` µSTX (0.5 STX) for both
  deploys — real margin above both figures, trivial against a ~190 STX balance, not worth
  risking a stuck deploy to save a fraction of a STX.

## 1. Deploy the token (first — the vault hardcodes a reference to it)

```bash
npm run m1:vault -- status            # sanity check: confirms "no contract" for both, confirms wallet address
npm run m1:vault -- deploy-token --yes-mainnet
```

Waits for confirmation (up to 4 minutes, polls every 6s). Must print `status: success`.
If it doesn't: stop, do not run step 2, read the error.

## 2. Deploy the vault

```bash
npm run m1:vault -- deploy-vault --yes-mainnet
```

Same wait/verify pattern. The vault's `.deepstack-vault-token` references resolve
automatically since both contracts deploy under the same principal — this only works
because step 1 already landed.

## 3. Link — one-time, cannot be redone

```bash
npm run m1:vault -- link --yes-mainnet
```

Calls the token's `set-vault-contract`, pointing it at the vault just deployed. This is
gated to fire exactly once (`ERR-VAULT-ALREADY-SET` on a second attempt) — if this
broadcasts successfully to the wrong vault address for any reason, the only fix is a full
redeploy of both contracts under a fresh pair of names. Re-run `npm run m1:vault -- status`
immediately after and confirm it now reads real values instead of "contracts may not be
deployed yet."

## 4. Verify the constants actually deployed, on-chain, before trusting them

`status` doesn't currently print the two delay constants (they're compile-time constants,
not data-vars — there's no getter). Confirm them directly against the deployed source
before relying on anything in `docs/VAULT_DISCLOSURE.md`:

```bash
curl -s "https://api.mainnet.hiro.so/v2/contracts/source/SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60/deepstack-vault" \
  | grep -o 'WITHDRAWAL-DELAY-BLOCKS u[0-9]*\|TIMELOCK-DELAY-BLOCKS u[0-9]*'
```

Expect `WITHDRAWAL-DELAY-BLOCKS u11330` and `TIMELOCK-DELAY-BLOCKS u39660` (7 days / 2
days at current ~15.25 sec/block cadence — see
`reports/DeepStack vault timelock duration.md`). If this doesn't match what's in the repo
at deploy time, something was deployed from a stale checkout — stop and investigate before
any deposit.

## 5. Seed deposit — DeepStack's own capital, not yet open to anyone else

**Recommendation: 20 STX.** Reasoning, not a guess:

- Small enough that a Phase 1 mistake (a bug this audit and 60 tests missed, or a fee-market
  surprise) costs little in absolute terms.
- Large enough to be a *real* test of the full lifecycle — deposit, a genuine
  `sweep-to-strategy` / `return-from-strategy` round-trip through the existing DLMM
  strategy, a real withdrawal request and claim after the new 2-day delay actually
  elapses — not a dust amount that risks hitting an off-by-one at the `MIN-FIRST-DEPOSIT`
  floor (1 STX) or rounding in the virtual-share-offset math.
- Leaves ~170 STX of the wallet's free balance untouched for the pilot agent's own
  existing trading and gas, and well under the 500 STX `max-tvl` cap (raisable later via
  the 7-day timelock once Phase 1 proves out).

```bash
npm run m1:vault -- deposit 20 --yes-mainnet
npm run m1:vault -- status            # confirm vault balance: 20 STX, shares outstanding: 20,000,000 (1:1 first deposit)
```

**This step moves real capital into a new, unaudited-by-a-third-party contract. Confirm
the amount before running it — it is not bundled into steps 1-4 and should not be run on
autopilot.**

## 6. First full lifecycle proof (do this before telling anyone this vault exists)

The disclosure doc and the architecture report both treat an unexercised code path as
unproven. Before this vault is mentioned anywhere public:

```bash
npm run m1:vault -- sweep-to-strategy 15 --yes-mainnet     # moves 15 of the 20 STX to the operator wallet for the DLMM strategy
# ... run the existing strategy for real (e.g. one real DLMM recenter cycle) ...
npm run m1:vault -- return-from-strategy <actual-result> --yes-mainnet   # whatever actually comes back, honestly
npm run m1:vault -- status            # confirm cumulative-realized-pnl and high-water-mark moved as expected
```

Then prove a withdrawal end-to-end: request a small withdrawal, wait out the real 2-day
delay (do not shortcut this by testing on a fork — the point is proving the *mainnet*
delay actually behaves as designed), claim it, confirm the STX lands back in the wallet
and the shares burn.

## 7. Publish, only after step 6 is real and clean

- Commit confirmation: this runbook itself, with the real txids filled in, becomes the
  record (do not publish txids with any grant dollar figures nearby — see CLAUDE.md).
- `docs/VAULT_DISCLOSURE.md` is already written for depositors; it needs no changes to go
  live unless step 6 surfaces something it doesn't already disclose.
- Still **not** open to third-party deposits at the end of this runbook — that's a
  separate, later decision (Phase 2), made after this Phase 1 lifecycle has run clean on
  DeepStack's own capital for some real stretch of time, not immediately after step 6.

---

## Open issues to settle before step 5

- **Seed amount is a recommendation, not yet confirmed.** 20 STX is reasoned above; say so
  explicitly if a different number is wanted before step 5 runs.
- **No third party has reviewed this contract.** `docs/CLARITY_AUDIT_VAULT.md` is a
  manual, structured self-review (same format as the already-live receiver contract's
  audit), not a paid third-party audit — Phase 1 is explicitly scoped to proceed without
  one, self-funded capital only, per the architecture report's phasing.
- **The timelock/withdrawal delays cannot be changed if they turn out wrong** — short of a
  full redeploy and fund migration. Step 4's verification exists specifically to catch a
  stale-deploy mismatch before any capital is at risk, not after.
