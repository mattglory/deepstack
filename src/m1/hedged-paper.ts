// Route C, Phase 0 — paper-mode hedged-capture monitor (docs, ROUTE_C_DESIGN.md).
//
// The arb detector (arb.ts) finds pool-vs-external divergence but can't bank it on-chain
// (no closable cycle — verified). The real capture is CEX-hedged: buy the discounted sBTC
// in the pool, short the same BTC notional on a perp, unwind when the pool reverts. This
// module prices that FULL round trip on every detected opportunity using PUBLIC Bybit data
// (mark price + funding) and journals a simulated net — so 30 days of paper P&L decide,
// with evidence, whether Phase 1 (real, small, trade-only keys) is worth doing.
//
// No API keys. No orders. Read-only, never throws. This never touches capital — it decides
// whether capital ever should.

export interface HedgeCosts {
  perpTakerBps?: number; // Bybit linear taker, per side (default 5.5bps)
  poolFeeBps: number; // the unwind's pool fee (entry fee already netted by the detector)
  expectedHoldHours?: number; // how long the basis position is held before revert (default 12)
}

export interface PaperResult {
  edgeStx: number; // the detector's net on-chain edge (already after pool + flash fee entry)
  perpFeeStx: number; // taker fee, both sides of the hedge
  fundingStx: number; // funding paid/earned over the hold (short pays when funding +)
  unwindFeeStx: number; // pool fee on selling the sBTC back
  netStx: number; // simulated hedged P&L — the number that decides Phase 1
  clears: boolean;
}

/** Pure P&L model — tested against hand-computed cases, no network. */
export function paperPnl(
  edgeStx: number,
  notionalStx: number,
  fundingRate8h: number, // Bybit funding for the period (fraction, e.g. 0.00002)
  costs: HedgeCosts,
): PaperResult {
  const perpBps = costs.perpTakerBps ?? 5.5;
  const holdH = costs.expectedHoldHours ?? 12;
  const perpFeeStx = notionalStx * (perpBps / 10_000) * 2; // open + close
  // Funding accrues every 8h; a SHORT pays funding when the rate is positive.
  const fundingPeriods = holdH / 8;
  const fundingStx = notionalStx * fundingRate8h * fundingPeriods;
  const unwindFeeStx = notionalStx * (costs.poolFeeBps / 10_000);
  const netStx = edgeStx - perpFeeStx - fundingStx - unwindFeeStx;
  return {
    edgeStx: +edgeStx.toFixed(4),
    perpFeeStx: +perpFeeStx.toFixed(4),
    fundingStx: +fundingStx.toFixed(4),
    unwindFeeStx: +unwindFeeStx.toFixed(4),
    netStx: +netStx.toFixed(4),
    clears: netStx > 0,
  };
}

/** Fetch Bybit's public BTC perp funding rate (8h). Null on any failure — paper only. */
export async function btcFundingRate8h(doFetch: typeof fetch = fetch): Promise<number | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8_000);
    const r = await doFetch("https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT", { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const rate = Number(j?.result?.list?.[0]?.fundingRate);
    return Number.isFinite(rate) ? rate : null;
  } catch {
    return null;
  }
}
