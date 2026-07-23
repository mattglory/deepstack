# Bitflow pool survey — where can DeepStack actually LP?

*Snapshot 2026-07-20 from the live Bitflow ticker. Re-run the scan any time; the
conclusion is structural, not a one-day artifact. Fee income = volume × 0.5% × our share,
so volume is the only thing that matters — but volume without a clean oracle and bounded
IL is a trap, not an opportunity.*

## Every pool with >$1k liquidity, ranked by 24h volume

| Pair | Liquidity | 24h volume | LP fees/day (all LPs) | DeepStack verdict |
|---|---|---|---|---|
| sBTC / **DOG** | $10.8k | **$833k** | ~$4,166 | ❌ memecoin — no oracle, ruinous IL |
| sBTC / **DROID** | $6.4k | $50k | ~$252 | ❌ memecoin — same |
| STX / stxcity | $2k | $1.1k | ~$6 | ❌ dust + meme |
| **sBTC / STX** | $277k | $1.1k | ~$5.5 | ✅ our pool — deepest real pair, clean BTC oracle |
| notastrategy / STX | $10.7k | $376 | ~$2 | ❌ meme |
| STX / stSTX | $182k | $196 | ~$1 | ⚠️ safe (low IL) but ~zero volume |
| STX / aeUSDC | $10.3k | $87 | ~$0.4 | ⚠️ winding down (aeUSDC deprecated) |
| everything else | — | ~$0 | ~$0 | ❌ dead |

## The uncomfortable structural finding

**The only real volume on the entire Bitflow DEX is on memecoins** (DOG ~$833k/day, DROID
~$50k/day). Every "serious" pair — sBTC, stSTX, the stablecoins — does **under ~$1,400/day**.

So the small LP fee income is **not** DeepStack underperforming. It is the correct outcome
of a safety-first agent operating in a market whose only liquidity is degen churn it is
built, by design, not to touch:

- **No clean oracle.** DeepStack's safety gate needs an external reference price to detect
  manipulation. sBTC and STX have CEX oracles; DOG/DROID do not. Without one, the oracle
  halt can't function — a hard blocker, not a preference.
- **Ruinous impermanent loss.** DOG turns over 77× its own liquidity per day — that price
  is thrashing. IL on a volatile memecoin doing that would erase the fat fees many times
  over. High APR on a meme pool is IL bait.
- **It's the whole brand.** DeepStack's value is auditable, safe, honest liquidity
  management. Meme-LPing is the opposite pitch.

**sBTC-STX remains the correct home** — deepest genuinely-tradeable pair, real oracle,
bounded IL. We are not missing a better pool; there isn't one that fits the mandate.

## The watch list (what would change this)

Fee income scales with *safe* volume, and that arrives only if the market grows. Triggers
worth scanning for (weekly, via the same ticker pull):

1. **STX-USDCx pool launches** — native USDC (~$10M bridged, Circle xReserve) with real
   depth would be the first serious new pair; DeepStack can LP it day one (one PAIRS entry).
   Currently no such pool exists.
2. **Endowment liquidity incentives** land on a specific pair — they are deploying capital;
   a boosted, safe pair changes the math.
3. **sBTC-STX volume climbs** with Bitcoin Staking inflows — same pool, bigger fee base,
   nothing to change on our side.
4. **stSTX/STX volume appears** — it's the safest pair (both track STX, minimal IL); today
   it's dead, but a live low-IL pair would be an ideal DeepStack venue.

## Cross-DEX: is there a bigger venue on Stacks? (checked 2026-07-20)

No. Bitflow is the largest DEX on Stacks by both TVL and volume — DeepStack is already on it.

| DEX | TVL | 24h volume |
|---|---|---|
| **Bitflow** (current venue) | **$2.6M** | **$73k** (mostly the DOG memecoin) |
| ALEX | $772k | $8.7k |
| Velar AMM | $269k | $116 (effectively dead) |
| StackSwap | $50k | ~$0 |
| **Whole Stacks DEX market** | — | **~$70k/day** |

The XYK/stableswap DEX market is ~$70k/day. Adding ALEX would mean a new adapter for 8× less
volume — not worth it.

**CORRECTION (2026-07-20): HODLMM is NOT `univ2-core`.** An earlier note here identified
Bitflow's HODLMM as `SP1Y5YSTAHZ...univ2-core` and called it a permissionless concentrated-
liquidity BTC venue. That was WRONG. On inspection `univ2-core` holds hundreds of memecoins
(leo, hawk-thua, andrew-tate, jeo-boden, doge-bonk, theroaringkitty) — it is a **generic
memecoin AMM factory**, and the high-volume DOG/LEO churn routes through it. Its "sbtc" balance
was a memecoin named `sbtc`, not real sBTC. The permissionless-mint finding applies to that
memecoin AMM, not to any premium BTC venue.

**The real HODLMM contract is NOT publicly identifiable on-chain** as of this survey: not in
the XYK ticker, not in the standard docs deployed-contracts page, and the obvious candidate was
the memecoin factory above. So its accessibility, volume, and TVL are genuinely UNKNOWN — these
are legitimate questions for Bitflow (Diego), not laziness.

**Where the real sBTC actually is (traced via largest holders, 2026-07-20):** overwhelmingly
LENDING + CUSTODY, not DEX. Zest's sBTC vault holds ~732 sBTC (~$47M); big individual wallets
hold 808 / 531 / 276 sBTC; a few lending-style "state-v1"/"pool-vault" contracts hold 22–91
each. Bitflow DEX pools hold single-digit sBTC. This CONFIRMS the idle-capital thesis on-chain:
sBTC sits in wallets and lending (earning ~0.01%) because there is no compelling DEX yield to
pull it out. The gap is real; closing it needs a better yield proposition (vaults + HODLMM if it
proves out), not a clever contract.

The other expansion axis is **other chains** — the Bitcoin-L2 multichain thesis (BOB, Botanix,
Core, Rootstock, Citrea), or organic growth of the sBTC-STX pool if Bitcoin Staking pulls
capital in. Stacks is where DeepStack is proven; whether it becomes a real market is TBD.

## UPDATE (2026-07-22): a live concentrated-liquidity (DLMM) venue exists — resolves 3 open items above

This survey (dated 2026-07-20) covered only the XYK/stableswap DEXes and left the concentrated-
liquidity question open. On 2026-07-22 a live **DLMM (bin-based concentrated-liquidity) DEX** was
found and verified on-chain (deployer `SM1FKXG…`, a separate DEX). It changes three conclusions
here — corrections, in the honest spirit of the rest of this doc:

- **"No STX-USDCx pool exists" (watch-list #1) is now WRONG.** `dlmm-pool-stx-usdcx-v-2-bps-10`
  holds ~533k STX + ~61k USDCx (**~$211k**), 782 txs, traded today. A real STX-USDCx pool is live
  — on the DLMM venue, not XYK.
- **"stSTX/STX is dead" (row + watch-list #4) is XYK-only.** The XYK stSTX pool does ~$196/day,
  but `dlmm-pool-ststx-stx-v-1-bps-1` has **4,214 txs and trades by the minute** — the lowest-IL
  pair on Stacks is very much alive on DLMM.
- **The "real HODLMM not identifiable" open question** now has a strong candidate: this DLMM DEX
  (its bins match AIBTC's public screenshots). Not positively confirmed as Bitflow's HODLMM or as
  AIBTC's venue, but no longer a blank.

This does not change the pilot (sBTC-STX, XYK, as declared) — reaching the DLMM venue needs a
bin-aware adapter, which is a post-pilot build (design notes kept internally, not in this repo).

## What this means for strategy

The LP position is proving the mechanism and producing honest numbers — it is not, and at
this market size *cannot be*, a yield business. The larger value on a thin pool is the
mispricing (LVR), which is why capture (Routes A/C) is measured separately. When safe
volume arrives, adding a pair is one line of config; until then, chasing the meme volume
would trade the entire safety thesis for fees that IL would eat anyway. Don't.
