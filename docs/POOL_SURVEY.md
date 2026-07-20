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

## What this means for strategy

The LP position is proving the mechanism and producing honest numbers — it is not, and at
this market size *cannot be*, a yield business. The larger value on a thin pool is the
mispricing (LVR), which is why capture (Routes A/C) is measured separately. When safe
volume arrives, adding a pair is one line of config; until then, chasing the meme volume
would trade the entire safety thesis for fees that IL would eat anyway. Don't.
