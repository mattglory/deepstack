# Clarity audit — deepstack-rebalance-receiver

**Date:** 2026-10-02 · **Method:** manual audit using the `clarity-audit` skill framework
(aibtcdev/skills, static-analysis checklist + risk-color framework) · **Contract:**
`SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60.deepstack-rebalance-receiver` · **Source:**
[`contracts/deepstack-rebalance-receiver.clar`](../contracts/deepstack-rebalance-receiver.clar),
confirmed byte-identical to the currently deployed version at audit time.

This audit is static analysis only — it does not execute the contract. It supplements, not
replaces, the 14 Clarinet simnet tests added in `clarinet/tests/` (issue #7), which exercise
the same auth/state logic at runtime and include a mutation test proving the suite catches a
real regression.

## Summary

Small (172-line), single-operator contract: borrow STX via a FlashStack flash loan, swap to
sBTC on Bitflow's XYK pool with a real (never-zero) min-out, forward the sBTC to the operator,
repay principal + fee from the operator's own wallet — all atomic. No critical or high
findings. One medium-severity hardening recommendation (unnecessary trust in a caller-supplied
value) and two medium design notes about operational dependencies that are already disclosed
and accepted elsewhere in the project (hot-wallet custody, FlashStack/Bitflow dependency).

**Verdict: PASS.** **Risk level: LOW.**

| | |
|---|---|
| Public functions | 5 (`arm`, `disarm`, `execute-stx-flash`, `rescue-stx`, `rescue-sbtc`) |
| Read-only functions | 2 (`get-pending`, `get-owner`) |
| Private functions | 0 |
| Data vars | 1 (`pending`) |
| Maps | 0 |
| Constants | 13 (owner, core principal, TTL, and 10 error codes u400–u409) |

## What works correctly

- **Checks-effects-interactions, applied correctly.** `execute-stx-flash` clears `pending`
  (the one-shot state) *before* any external call. Clarity has no implicit receive-STX hook on
  `stx-transfer?` to a contract principal, so the classic reentrancy vector doesn't apply here
  regardless — but the ordering is right even so, and a failing `asserts!` anywhere after the
  clear correctly rolls back the whole transaction (including that clear), verified directly
  by this session's mutation test: disabling the `contract-caller` check made a direct call
  proceed to the swap leg and fail there, exactly as it should, and the trade I'd armed for
  that test was still present afterward — a reverted attempt doesn't silently consume the arm.
- **`min-dx` is a required, non-zero, owner-armed parameter**, not a `u1` floor — the swap
  leg's own min-out is real, and `arm`'s `ERR-BAD-PARAMS` rejects `amount = 0` or `min-dx = 0`
  outright.
- **One-shot + TTL expiry** prevents a stale off-chain quote from being replayed later.
- **Fee rounding is handled explicitly**: `(if (> raw-fee u0) raw-fee u1)` avoids a zero-fee
  edge case from integer division silently repaying less than FlashStack expects.
- **Auth is layered correctly** on the callback: `contract-caller` (who actually invoked this)
  AND `tx-sender` (whose wallet pays the repayment) are both checked, not just one — this
  closes the exact gap a caller-identity-only check would leave (see Finding 1 below for the
  one place this discipline isn't fully carried through).
- **No unbounded iteration** anywhere — fixed, small number of calls per invocation, no gas/cost
  DoS surface.
- **Admin functions are uniformly owner-gated** (`arm`, `disarm`, `rescue-stx`, `rescue-sbtc`
  all assert `tx-sender == CONTRACT-OWNER` first).

## Findings

### 1. [MEDIUM] Repayment destination trusts the caller-supplied `core` argument instead of the already-verified constant

**Location:** `execute-stx-flash`, line 138 — `(stx-transfer? total-owed tx-sender core)`

`core` is a function **parameter**, supplied by whoever calls `execute-stx-flash` — it is not
derived from `contract-caller`. The auth check two lines above (`is-eq contract-caller
FLASHSTACK-CORE`) already pins the only valid caller to one specific, hardcoded principal, so
in the current deployment `core` can only ever carry a value FlashStack's own core contract
chose to pass (checked against the trait source: the parameter exists so the trait stays
generic across any flash-loan core, not because this receiver supports more than one). Given
this receiver already hardcodes and checks for exactly one core, nothing is gained by also
trusting its self-reported address for where the money goes — the repayment correctness
currently depends on an assumption about FlashStack's own internal call convention, which is
outside this contract's source and not independently verifiable from it.

**Not currently exploitable**: the `contract-caller` gate already means only FlashStack's real
core can reach this line at all.

**Recommendation:** repay to the `FLASHSTACK-CORE` constant directly, not the `core`
parameter:
```clarity
(unwrap! (stx-transfer? total-owed tx-sender FLASHSTACK-CORE) ERR-REPAY-FAILED)
```
This removes the dependency on trusting the caller-supplied value entirely, at zero cost (the
contract only ever deals with one core today). The `core` parameter would still need to exist
to satisfy the trait signature even if unused for this.

### 2. [MEDIUM — design, already tracked] Single owner, no succession plan

`CONTRACT-OWNER` binds permanently to `tx-sender` at deploy time with no transfer mechanism.
If the deployer key is lost, `arm`/`disarm`/`rescue-*` become permanently inaccessible short of
a full redeploy. This is the same hot-wallet-custody risk already raised and accepted in
issue #9 (closed) and the rotation plan now in `docs/PILOT_DEPLOY.md` — noted here because an
audit of this contract specifically should surface it, not because it's new. No code action
recommended beyond what's already documented; a `set-owner` two-step transfer would be the fix
if this stops being a single-operator contract.

### 3. [LOW — design, disclosed] Three-way external dependency

Correctness depends on `flashstack-stx-core`, Bitflow's `xyk-core-v-1-2` /
`xyk-pool-sbtc-stx-v-1-1`, and `sbtc-token` all behaving as expected and not being paused,
upgraded, or compromised — none of which DeepStack controls. This is the project's own stated
architecture (the "integrated flywheel" with FlashStack), not an oversight; flagged for
completeness per the audit checklist's design-concerns category, not as something to fix.

### 4. [INFO] No Clarity-4 `as-contract?` allowances

The contract targets `clarity_version = 3` (`clarinet/Clarinet.toml`). Clarity 4 added the
ability to scope an `as-contract` call to an explicit asset allowlist, tightening what a
borrowed-identity call can move. This contract's three `as-contract` call sites (the swap, the
sBTC balance read, the sBTC transfer, plus `rescue-stx`/`rescue-sbtc`) all target hardcoded,
trusted principals already, so the practical exposure is low — but a future Clarity-4 migration
would be a natural place to add that extra constraint. Not a finding against the current code,
just a forward-looking note.

## Checklist (per clarity-audit's framework)

| Check | Status |
|---|---|
| Input validation with `asserts!` | ✅ all public functions |
| `tx-sender` vs `contract-caller` used correctly | ⚠️ see Finding 1 — correct for auth, not for the repay destination |
| Error codes for all failure paths | ✅ 10 distinct, documented constants |
| No unbounded iteration | ✅ |
| Token operations propagate failure | ✅ (`unwrap!` with contract-specific error codes, not raw `try!` — deliberate, gives callers clean codes instead of leaking vendor errors) |
| Post-conditions for asset protection | N/A at the contract level — documented as an operator/wallet-side responsibility in the deploy checklist (Allow-mode post-conditions), which is the correct layer for it |
| All public functions return `(response ok err)` | ✅ |
| Traits whitelisted before use | ✅ (single `impl-trait`, no dynamic trait dispatch elsewhere) |
| Admin functions have proper access control | ✅ |
| Rate limiting on sensitive operations | N/A — single-operator contract, no multi-tenant abuse surface |

## Risk-color summary (by function)

| Function | Color | Why |
|---|---|---|
| `get-pending`, `get-owner` | 🟢 GREEN | read-only |
| `arm`, `disarm` | 🟡 YELLOW | state change, owner-gated |
| `execute-stx-flash` | 🔴 RED | moves real funds (flash-borrowed STX, sBTC, repayment); see Finding 1 |
| `rescue-stx`, `rescue-sbtc` | 🔴 RED | treasury-access admin functions, owner-gated |

## What this audit does not cover

Static review only. It does not replace runtime testing (covered separately by the 14
Clarinet tests), a formal verification pass, or RV-style fuzz testing, which the skill's own
notes recommend for production-critical contracts handling real funds — worth considering as a
follow-up given this contract is live on mainnet.
