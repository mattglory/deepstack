# Clarity audit — deepstack-vault + deepstack-vault-token (Phase 1)

**Date:** 2026-10-04 · **Method:** manual audit using the `clarity-audit` skill framework
(aibtcdev/skills, static-analysis checklist + risk-color framework), the same methodology used
for [`docs/CLARITY_AUDIT.md`](CLARITY_AUDIT.md) (the deployed flash-rebalance receiver).
**Contracts:** `contracts/deepstack-vault.clar`, `contracts/deepstack-vault-token.clar` —
**NOT YET DEPLOYED.** Proven on Clarinet's simnet only (60 tests passing, including a real
mutation test on the donation-attack defense); a mainnet deploy is a separate, later decision.

This audit supplements, not replaces, the Clarinet test suite
(`clarinet/tests/deepstack-vault.test.ts`, `clarinet/tests/deepstack-vault-token.test.ts`),
which exercises every property discussed below at runtime and includes a mutation test proving
the donation-attack defense is real, not assumed — see that test file's `donation-attack
defense` and `CR-01` blocks for details.

## Summary

Two contracts implementing a single-strategy, single-admin, capped vault: depositors receive
SIP-010 shares priced against an internally-tracked ledger (never raw on-chain balance), the
admin periodically sweeps free capital to run DeepStack's existing off-chain DLMM strategy and
returns it with a performance fee minted on realized gains above a high-water mark, and
withdrawals go through a fixed delay with no code path that can ever pause or block them.

**Verdict: PASS, with one finding that is not a bug to fix but the central fact a depositor must
understand before using this contract.** Design is deliberately modeled on StackingDAO's
(Arkadiko) audited vault with two departures found necessary during design (see
[`reports/DeepStack AUM vault architecture.md`](../reports/DeepStack%20AUM%20vault%20architecture.md)):
closing a donation-attack gap their own code and audit left open, and never implementing the
withdrawal-blocking mechanism their own audit found Critical and had removed.

**Risk level: LOW** for the code as written against its own stated design; **the irreducible
risk is custodial, not a code defect** (Finding 1).

| | |
|---|---|
| Public functions (vault) | 16 (deposit, request/claim-withdrawal, sweep/return-from-strategy, pause×4, queue/confirm×4 pairs, queue/accept-admin-change) |
| Public functions (token) | 3 (set-vault-contract, mint-for-vault, burn-for-vault) + SIP-010's transfer |
| Read-only functions (vault) | 20 (pricing helpers + getters) |
| Read-only functions (token) | 7 (SIP-010 + get-vault-contract) |
| Data vars (vault) | 13 | Data vars (token) | 1 |
| Maps | 1 (`withdrawal-requests`) |

## What works correctly

- **NAV is read exclusively from an internal ledger, never `stx-get-balance`.** Verified by
  direct test (`donation-attack defense`) and by a real mutation test: temporarily changing
  `get-total-assets` to read raw balance instead of the ledger was confirmed, live, to let a
  donation attack succeed (a victim's fair 2,000,000-share deposit dropped to 39,215 shares
  under the mutated version) — then reverted. This is the strongest form of evidence this kind
  of property can have in a test suite.
- **The virtual-shares/virtual-assets offset has no special case for zero supply.** Unlike the
  StackingDAO precedent this is modeled on, there is no `if supply == 0 then 1:1` branch for an
  attacker to target — the offset is structurally always-on, and `MIN-FIRST-DEPOSIT` additionally
  forecloses the tiny-seed half of the classic attack setup.
- **Withdrawals have no code path that can be paused**, verified two ways: a behavioral test
  (engage every pause function immediately before a claim, confirm no effect) and a static
  source-inspection test (no identifier matching a pause/shutdown pattern appears anywhere in
  the actual code — comments are stripped before the check, so the header's own prose
  explaining *why* no such mechanism exists doesn't fool the test).
- **The liquidity invariant is real, not advisory**: a `request-withdrawal` can only succeed if
  the vault already holds the free STX to cover it *right now*, and once accepted, that amount
  is immediately reserved (`total-pending-withdrawals`) in a way `sweep-to-strategy` is bound to
  respect. There is no code state in which an accepted request can later become unfundable.
- **A bare donation can only ever help, never hurt, withdrawal liquidity.** Because
  `stx-get-balance(vault)` is always greater than or equal to the ledger's `total-stx-balance`
  (a donation raises real balance without raising the ledger), `claim-withdrawal`'s `stx-transfer?`
  always has real funds available to cover what the ledger believes it owes — the donation
  defense closes a *pricing* attack without introducing a *liquidity* risk.
- **The timelock genuinely has no cancel path.** Confirmed by source inspection (no
  `cancel-*` function exists) and by test (a mistaken queue is only correctable by queuing the
  old value back, which itself waits the full delay). `confirm-*` is callable by anyone once
  matured, removing the operator's own discretion over timing — verified via a non-admin
  account successfully confirming a matured change.
- **Admin succession is two-step and gated to the right party at each step**: only the current
  admin can `queue-admin-change`; only the *proposed* principal (not "anyone," unlike the other
  `confirm-*` functions) can `accept-admin-change`, after the same timelock delay. The old admin
  retains full control until acceptance completes — verified directly.
- **The token's mint/burn authority is a one-time, permanently-locked link**, not a mutable
  admin setting. `set-vault-contract` can only ever be called once, by the token's own deployer;
  there is no function anywhere that can change it afterward. Verified: a second call, even with
  the identical correct value, fails closed.
- **`fee-stx-for-round-trip` is a pure, independently-tested function**, not logic buried inside
  the stateful `return-from-strategy` — every HWM edge case (gain, loss, recovery-to-the-old-peak,
  new-high) is tested directly against its exact arithmetic.

## Findings

### 1. [INFORMATIONAL — the central fact to disclose, not a code defect] `return-from-strategy` trusts the admin's declared amount

**Location:** `sweep-to-strategy`/`return-from-strategy`, `deepstack-vault.clar`

This is deliberate, disclosed design, not an oversight, but it is the single most important
thing anyone depositing into this vault needs to understand, so it is listed as Finding 1 rather
than buried in prose. `sweep-to-strategy` sends real STX to the admin's own wallet. Nothing in
the contract requires the admin to ever call `return-from-strategy` at all, and nothing verifies
that a declared `returned-amount` reflects the true result of whatever the admin actually did
with the capital in between — the contract can confirm the admin never *claims* to return more
than their wallet actually holds (`stx-transfer?` is atomic and enforced), but it cannot confirm
the number represents the whole truth of a strategy round-trip. This is the same boundary every
comparable single-admin ALM vault's off-chain rebalancing step has (Arrakis's own audited V2
risk disclosure states this outright: "the manager is TRUSTED... to pass sensitive call data").

**What bounds this risk today:** `MAX-TVL` bounds total exposure to whatever's currently
deposited (500 STX initial pilot cap); the timelock means the cap can't be raised without
advance public notice; withdrawals being structurally unpausable means a depositor can always
exit whatever free balance exists, independent of admin behavior. **What does not bound it:**
once capital is swept to the strategy wallet, nothing on-chain protects it until the admin
chooses to return it.

**Recommendation:** not a code fix — a disclosure requirement. `docs/VAULT_DISCLOSURE.md` states
this plainly, and it should be the first thing stated there, not a footnote.

### 2. [LOW — documented design choice, not a bug] `return-from-strategy` is not bounded by `max-tvl`

**Location:** `return-from-strategy`, `deepstack-vault.clar`

Unlike `deposit`, `return-from-strategy` performs no `max-tvl` check, so a genuinely profitable
round-trip can legitimately push `get-total-assets()` above the configured cap. This is correct,
not a gap: `max-tvl`'s purpose is to bound how much *new* capital can enter via `deposit`, not to
destroy or block organically-earned returns from flowing back into custody — refusing a return
because it exceeds the cap would force profitable capital to sit indefinitely outside the vault,
directly undermining the withdrawal-liquidity model. Side effect, also intended: once assets
exceed the cap this way, new deposits are rejected until the admin raises `max-tvl` via the
timelock. Noted here so a future reader doesn't mistake the absence of a check for an oversight.

### 3. [LOW — operational, not a code risk] Misconfiguring `max-tvl` below `MIN-FIRST-DEPOSIT` would brick new vault bootstrapping

**Location:** `deposit`, interaction between `MIN-FIRST-DEPOSIT` (constant) and `max-tvl` (admin,
timelocked)

If `max-tvl` were ever queued and confirmed to a value below `MIN-FIRST-DEPOSIT` (1 STX) while
supply is still zero, no first deposit could ever succeed. This requires a deliberate or
mistaken admin action, gated by the timelock's own visibility window, so it is not attacker-
reachable — a footgun to avoid operationally, not a contract defect. No code change needed; a
one-line note in the deploy runbook would be a reasonable, free improvement.

### 4. [INFORMATIONAL] Deploy-and-link is a three-transaction manual sequence with no code-level enforcement of order

**Location:** deploy runbooks in both contracts' headers, `src/m1/vault-cli.ts`

Clarity's lack of a factory/dynamic-deploy pattern (confirmed in the architecture research)
means token deploy, vault deploy, and the one-time link are three separate, manually-sequenced
transactions. Between vault deploy and the link transaction, the token is inert (mint/burn
always fails) rather than unsafe — confirmed by test (`mint/burn fail before the link is set`)
— so a stalled or out-of-order deploy fails closed, not open. No finding against the code; the
CLI's own command naming (`deploy-token` → `deploy-vault` → `link`) and console output make the
required order explicit at each step.

## Checklist (per clarity-audit's framework)

| Check | Status |
|---|---|
| Input validation with `asserts!` | All public functions, including amount-positivity and share-positivity checks the StackingDAO precedent omits |
| `tx-sender` vs `contract-caller` used correctly | `contract-caller` for the token's vault-only mint/burn gate (principal-confusion defense); `tx-sender` for admin checks and SIP-010's self-transfer rule — same split the receiver contract's own audit already validated |
| Error codes for all failure paths | 18 distinct constants on the vault (`u100`-`u117`), 4 on the token (`u200`-`u203`), no collisions with the receiver contract's existing `u400`-`u409` range |
| No unbounded iteration | None anywhere in either contract |
| Token operations propagate failure | `try!`/`unwrap!` throughout; the three `unwrap-panic` call sites are each commented explaining why they're safe (reading this contract's own token's `get-total-supply`, which cannot itself fail) |
| Donation/inflation-attack defense | Present and mutation-tested — see "What works correctly" |
| Admin functions have proper access control | Every admin-only function checks `tx-sender == (var-get admin)`; succession is two-step and timelocked |
| Withdrawals cannot be paused | Structurally true — verified by both behavioral and static tests |
| Timelock has no cancel path | Verified by source inspection and by test |
| Post-conditions for asset protection | Enforced at the transaction layer by `vault-cli.ts` (`PostConditionMode.Deny` for deploys/link, `Allow` for value-moving calls where the contract's own internal asserts are the real guard) — the correct layer for it, same pattern the receiver contract's own deploy checklist uses |

## Risk-color summary (by function)

| Function | Color | Why |
|---|---|---|
| All `get-*` read-onlys, `get-vault-contract`, SIP-010 reads | 🟢 GREEN | read-only |
| `deposit`, `request-withdrawal`, `claim-withdrawal`, `transfer` | 🟡 YELLOW | real value movement, but caller-scoped and fully guarded by the invariants above |
| `pause-*`/`unpause-*`, `queue-*`, `confirm-*`, `queue-admin-change`, `accept-admin-change` | 🟡 YELLOW | admin-gated state changes, timelocked where it matters, no cancel path |
| `sweep-to-strategy`, `return-from-strategy` | 🔴 RED | moves real custodied funds to/from the admin's own wallet — see Finding 1 |
| `mint-for-vault`, `burn-for-vault`, `set-vault-contract` | 🔴 RED | treasury-adjacent token-supply control, correctly gated to a single, permanently-locked caller |

## What this audit does not cover

Static review and Clarinet simnet testing only — not a professional paid audit. Per the
project's own [AUM vault architecture research](../reports/DeepStack%20AUM%20vault%20architecture.md),
a full Clarity-specialist audit (CoinFabrik or Clarity Alliance, the two firms with verifiable
Clarity-audit track records) is a Phase 2/3 milestone gated on real external deposits, not a
Phase 1 prerequisite — Phase 1 is seeded only with DeepStack's own capital, disclosed as
unaudited-beyond-this-review the entire time. `clarinet check`'s static-analysis pass is clean
(3 intentionally-justified `unwrap-panic` notes only, no errors); CoinFabrik's `stacy` analyzer
has not yet been run against these two files as of this writing.
