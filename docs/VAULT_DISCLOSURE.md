# DeepStack AUM Vault — Phase 1 disclosure

Plain-language summary of `contracts/deepstack-vault.clar` and
`contracts/deepstack-vault-token.clar`. Read this before depositing. It is not legal or
financial advice, and nothing here is an offer, a promise of return, or an investment pitch:
depositing gives you a claim on vault assets priced by a transparent on-chain formula, and pays
DeepStack a fee only on realized gains it actually delivers.

**Status: deployed to mainnet on 2026-10-05 and funded only with DeepStack's own capital.
Deposits were paused on 2026-10-08 (tx c3a8c435754c260cd663058779eb9d420236ee71af4e871ee9f9ebb909317f8d)
after an independent review found design issues that need a new contract. It is not open to
outside depositors.** See "Independent review, October 2026" below. The contract source files
still carry a "STATUS: NOT YET DEPLOYED" header. That comment is left unchanged on purpose, so
the files in this repo stay byte-identical to what is deployed on-chain.

## The one thing to understand before anything else

**This vault has a single admin, and the admin's cooperation is required to get swept capital
back.** When the admin moves vault funds out to run the trading strategy
(`sweep-to-strategy`), the contract cannot verify what happens to that capital next, or confirm
that whatever comes back (`return-from-strategy`) honestly reflects the real result. The
contract can prove the admin never *claims* to return more than their wallet holds; it cannot
prove the admin always returns what they actually should. This is the same limitation every
comparable single-operator vault has — it is a fact about trusting one person with signing
authority, not something a timelock or a pause switch can remove. If that's not an acceptable
risk for your capital, this isn't the right product yet. A full third-party audit and a
track record are Phase 2/3 milestones, not something this version has.

## What the contract *can* verify on your behalf

- **Your share of the vault is priced by a public, on-chain formula**, computed from the
  vault's own recorded balances, not from a number anyone reports. Anyone can check it directly
  from the contract, not just DeepStack.
- **A bare STX transfer sent to the vault's address does nothing to anyone's share price.**
  Only real deposits and real strategy round-trips move the price.
- **Withdrawals cannot be paused, frozen, or blocked by the admin.** There is no function
  anywhere in the contract that can stop an already-accepted withdrawal request from being
  claimed once its delay has passed — not a pause button, not a shutdown switch, nothing. A
  withdrawal request can be *rejected at the moment you ask* if the vault's capital happens to
  be fully deployed at the strategy right then (see below), but once accepted, it is fully
  reserved and cannot later become unfundable.
- **Fee changes, cap changes, and a change of admin all require advance public notice.** Any
  such change must be queued on-chain and wait out a fixed delay of 39,660 Stacks blocks
  before it can take effect. That was sized for about 7 days, but blocks have run faster than
  assumed: at the pace measured in October 2026 it is about 6.1 days. It was meant to outlast
  the withdrawal delay below so you could exit before a change lands, but the independent
  review found that exit window is not guaranteed (see below), and once
  queued, DeepStack cannot cancel or skip that wait. Changing your mind after is only possible
  by queuing the old value back, which waits out the same delay again.
- **The performance fee has a hard ceiling** that no queued, delayed change can ever exceed,
  regardless of what's confirmed.

## Current parameters (verify against the deployed contract before relying on these — they are
also readable live at any time via `npm run m1:vault -- status`)

| Parameter | Default | What it means |
|---|---|---|
| Max vault size (`max-tvl`) | 500 STX | The vault stops accepting new deposits once total assets reach this. Deliberately small for a first pilot; raised later only via the timelock. |
| Performance fee | 10% | Charged only on realized gains that take the vault as a whole above its prior high point (see below). Never on deposits or unrealized gains. Because the high point is tracked for the whole vault, an individual depositor can still pay part of a fee while below their own entry value. |
| Fee ceiling (`MAX-PERFORMANCE-FEE-BPS`) | 20% | The fee can never be raised above this, no matter what's queued and confirmed. |
| Minimum first deposit | 1 STX | Required only while the vault has zero depositors — part of what prevents a pricing-manipulation attack on the very first deposit. |
| Withdrawal delay | 11,330 Stacks blocks, about 1.75 days at the October 2026 pace (the first real withdrawal took 42.1 hours) | Time between requesting a withdrawal and being able to claim it. Fixed in Phase 1 — not adjustable at all, by anyone, without a new contract. |
| Timelock delay | 39,660 Stacks blocks, about 6.1 days at the October 2026 pace | Minimum notice before any parameter change (cap, fee, fee recipient, admin) takes effect. Longer than the withdrawal delay, but an exit before a change lands is not guaranteed while capital is deployed (see below). |

## How the fee actually works

DeepStack doesn't charge for holding your deposit, and it doesn't charge on paper gains from an
open position. The fee is minted (as new vault shares to DeepStack, diluting all holders
pro-rata, exactly like a deposit at the current price — no STX ever leaves the vault for a fee)
only when capital that was swept out to the strategy comes back showing a real, realized gain
*above the vault's best previous result*. A loss is never fee-able, and recovering a loss back
to where the vault was before doesn't trigger a fee either — only a genuinely new high-water
mark does. This means DeepStack only gets paid when the vault as a whole is better off than it has
ever been before. Individually it is less clean: the high point is tracked in total STX for the
whole vault, not per share, so a depositor who joined later can pay part of a fee while still
below their own entry value, and one who joined after a loss can benefit from a recovery
without paying any fee. Tracking the high point per share is part of the planned redesign.

## Independent review, October 2026

An external reviewer examined both contracts on 2026-10-07 and added 30 tests that demonstrate
each finding. The reviewer's conclusion: the code is clean in the narrow sense, but the vault is not ready
for outside depositors. The main findings, in plain terms:

- **Custodial in practice.** The admin can sweep all free deposits to its own wallet instantly,
  with no timelock, and then report any result, including a total loss. The admin key is also
  the trading agent's key on a server.
- **Withdrawals can be frozen in effect.** Sweeping all free STX means every new withdrawal
  request is rejected until capital comes back.
- **No guaranteed exit window.** The admin can queue a parameter change and sweep capital at
  the same moment, so depositors may be unable to leave before the change takes effect.
- **Front-running is possible.** Capital at the strategy is valued at cost, and a withdrawal's
  amount is fixed when it is requested, so someone who knows the strategy's result can enter
  before a gain or exit before a loss at the expense of other holders.
- **The fee high point is vault-wide**, with the fairness effects described above.
- **Delays are counted in Stacks blocks**, which have run faster than the contract assumed.

Deposits are paused. The fixes require a new contract, which will be tested on testnet, run
through a real gain and a real loss on mainnet, and re-reviewed before anyone else deposits.

## Honest limitations, stated plainly

- **A withdrawal request can be turned down, not paused, if the vault's capital is fully
  deployed to the strategy when you ask.** This isn't an admin decision in the moment — it's
  a liquidity-timing fact, the same as any fund that's not 100% sitting in cash. You can simply
  try again once the admin brings capital back.
- **This is not insured.** No third-party cover exists for this vault at this stage; that's a
  track-record-gated milestone for later, not a day-one feature.
- **This has not had a professional third-party security audit.** It has had the same kind of
  manual, structured review DeepStack's other live contract received
  (see `docs/CLARITY_AUDIT_VAULT.md`), plus a full automated test suite including a real
  mutation test proving the pricing-attack defense works — but that is not a substitute for a
  paid audit from a specialist firm, which is planned for a later phase once there's a real
  track record and budget to fund one properly.
- **DeepStack's own strategy track record to date is a 30-day sBTC/STX and sBTC/USDCx pilot on
  its own ~$900 of self-funded capital** (see `docs/PILOT_RESULTS.md`), not a record of managing
  third-party funds. This vault is how that changes, starting deliberately small.
