# DeepStack

**Autonomous, safety-first liquidity management for Bitcoin DeFi on Stacks.**

[![CI](https://github.com/mattglory/deepstack/actions/workflows/ci.yml/badge.svg)](https://github.com/mattglory/deepstack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Live on mainnet](https://img.shields.io/badge/Stacks-mainnet-orange.svg)](https://explorer.hiro.so/address/SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60?chain=mainnet)

DeepStack is an agent that provides and actively manages liquidity in Bitcoin-backed
markets on Stacks. It runs a full-range position on Bitflow's sBTC/STX pool and a
concentrated position on Bitflow HODLMM's sBTC/USDCx pool, rebalancing and recentering on
its own, and it refuses to trade whenever something looks wrong.

Every number it reports can be checked on-chain. Nothing here is a promise of yield.

| | |
|---|---|
| **Agent wallet** | [`SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60`](https://explorer.hiro.so/address/SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60?chain=mainnet) |
| **Live dashboard** | [dashboard-two-alpha-t9c0vbn07m.vercel.app](https://dashboard-two-alpha-t9c0vbn07m.vercel.app) |
| **Venues** | Bitflow sBTC/STX (XYK) · Bitflow HODLMM sBTC/USDCx (DLMM, 10 bps bins) |
| **Running since** | July 2026 on mainnet, 30-day public pilot closed 27 Sep 2026 |

---

## What it does

- **Provides liquidity in two venue types.** A constant-product position that earns on
  every trade, and a concentrated position spread across ~100 price bins that earns where
  the trading actually happens.
- **Manages it on its own.** Every 30 minutes it reads the pools, its positions and an
  independent price, then holds, rebalances inventory, or recenters the concentrated range
  when price leaves it.
- **Keeps a recentered position whole.** When price runs through the range, the agent
  withdraws, swaps half the imbalance back inside the same pool through a minimum-output
  router call, and re-adds everything, rather than shrinking the position.
- **Sizes ranges from measured volatility.** The width comes from the pool's own price
  history, and can be pinned by the operator while fee data is measured.
- **Reports honestly.** Performance is shown as *fees net of impermanent loss* against
  simply holding the same tokens. Owner deposits and withdrawals are recorded from chain
  data and added back, so they never show up as profit or loss.

## Safety first

The agent is built to fail closed. Before any transaction it checks, and refuses to act
on, anything outside these limits:

| Control | What it stops |
|---|---|
| Oracle sanity check | Trading when the pool price diverges from an independent reference (possible manipulation) |
| Input-cap post-conditions | A transaction ever sending more than intended |
| Fresh minimum-output guards | Fills worse than a tolerance read from the chain at send time |
| Size caps and pool-share caps | Oversized trades and positions too large for a pool's depth |
| Drawdown halt | Continued trading after a loss beyond the session limit (owner flows excluded) |
| Kill switch | Everything, instantly: one file on the host pauses the agent |
| Failure streak stop | Repeated failed broadcasts: the venue is switched off until a human resets it |

Details, with code references and on-chain evidence: [docs/SAFETY_CONTROLS.md](docs/SAFETY_CONTROLS.md).

## How it works

```
   every 30 min      ┌──────────────────────────────┐
  ───────────────▶   │  Read: pools, positions,      │  Hiro API + an independent
                     │  wallet, independent price    │  price reference
                     └──────────────┬───────────────┘
                                    ▼
                     ┌──────────────────────────────┐
                     │  Safety gate (fail closed)    │  divergence · drawdown ·
                     └──────────────┬───────────────┘  kill switch · pool paused
                                    ▼
   AI layer ──params─▶ ┌──────────────────────────────┐
   (off the hot path,  │  Deterministic decision core  │  hold · rebalance · LP
    can only tighten   │  (pure functions, unit tested)│  adjust · DLMM recenter
    risk)              └──────────────┬───────────────┘
                                    ▼
                     ┌──────────────────────────────┐
                     │  Execute: capped, guarded     │  Bitflow XYK, HODLMM routers
                     │  transactions, then confirm   │
                     └──────────────┬───────────────┘
                                    ▼
                     journal · metrics · public dashboard
```

The AI layer only proposes parameters on a slow cadence, and measured volatility overrides
it. It can make the agent more cautious, never less. Every decision is a pure, tested
function; every transaction is logged with its reason.

## Results

The 30-day public pilot (28 Aug to 27 Sep 2026) is written up in full, with every figure
reproducible from the chain: [docs/PILOT_RESULTS.md](docs/PILOT_RESULTS.md).

| | |
|---|---|
| Uptime | 97.3% |
| Mainnet transactions | 60 (44 succeeded, 16 aborted and disclosed) |
| Return vs simply holding | −1.08% |

That last figure is the honest one: passive liquidity on these pools only beats holding
when fees outrun impermanent loss, and the pilot measured exactly that, including the
incidents and their fixes. Live figures are on the [dashboard](https://dashboard-two-alpha-t9c0vbn07m.vercel.app).

## Vaults

| | Status |
|---|---|
| **v1** | Retired. Paused and fully wound down in October 2026 after an external review |
| **v2** | Epoch-based deposit vault with a performance fee over a high-water mark and a 2-of-3 multisig admin. Fully exercised on testnet ([docs/VAULT_V2_TESTNET.md](docs/VAULT_V2_TESTNET.md)); not open to outside deposits |
| **v3** | Design stage: a vault that owns its position, so deposits never leave the contract |

Design: [docs/VAULT_V2_DESIGN.md](docs/VAULT_V2_DESIGN.md).

## Quick start

Requires Node 22. Nothing is broadcast unless you opt in.

```bash
npm install
npm test                       # unit tests
npm run typecheck

npm run m1:agent               # agent loop in observe mode: decides, sends nothing
npm run m1:safety              # run the oracle and safety checks once
npm run m1:dlmm-recenter -- status   # concentrated position: range, price, decision
```

The agent reads its wallet from `.env` (copy `.env.example`), even in observe mode, so it
can read balances. It only signs and broadcasts with an explicit double opt-in
(`--live --yes-mainnet`), mainnet only. Running it as a service: [docs/PILOT_DEPLOY.md](docs/PILOT_DEPLOY.md).

## Repository layout

| Path | Contents |
|---|---|
| `src/m1/` | The agent: decision core, safety gate, XYK and HODLMM adapters, executors, CLIs |
| `src/m2/` | Pilot tooling: FlashStack flash-rebalance receiver, P&L report |
| `src/yield/` | Read-only scan of where idle inventory could earn on Stacks lending |
| `contracts/` | Clarity: vault v2 and its share token, the rebalance receiver, retired v1 |
| `clarinet/` | Contract test suites (Clarinet simnet + Vitest) |
| `dashboard/` | Static public dashboard and its tested P&L maths |
| `deploy/` | systemd unit and install scripts for the hosted agent |
| `docs/` | Design notes, safety controls, results, vault design and disclosures |

## Documentation

- [Safety controls](docs/SAFETY_CONTROLS.md) · [Implementation notes](docs/IMPLEMENTATION_NOTES.md) · [Integration guide](docs/INTEGRATION.md)
- [Pilot results](docs/PILOT_RESULTS.md) · [Pilot methodology](docs/PILOT_METHODOLOGY.md)
- [FlashStack flash-rebalance](docs/FLASH_REBALANCE.md) · [Velar perps study](docs/VELAR_SPIKE.md)
- [Vision](docs/VISION.md) · [Whitepaper](docs/WHITEPAPER.md)

## Review and disclosure

The code and contracts were reviewed in October 2026 by an external reviewer, who has since
joined DeepStack as a co-founder. The findings are fixed and disclosed in the documents above,
including incidents. Further reviews, and a professional third-party audit, will come from
outside the team before any outside deposit; there has been no professional audit yet. DeepStack trades only its owner's capital; nothing in this
repository is an offer to manage anyone else's funds.

## Related

DeepStack composes with [FlashStack](https://github.com/mattglory/Flashstack), atomic flash
loans for STX and sBTC. Development was supported by a Stacks Endowment grant.

## License

[MIT](LICENSE)
