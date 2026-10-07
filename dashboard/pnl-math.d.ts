// Type declarations for pnl-math.js, a plain DOM-free ES module shared between the browser
// dashboard (imported directly as .js) and the backend allocator CLI (src/m1/allocator-cli.ts,
// outside tsconfig's "src"-only include, so TS can't infer this file's types on its own). A
// sibling .d.ts is how TS resolves types for a relatively-imported .js file regardless of
// project "include" scope. Kept in sync by hand with pnl-math.js's real exports; a drift
// would fail loudly in pnl-math.test.js at runtime either way.

export function hodlNow(m: unknown, s: { mid: number; stxUsd?: number; portfolioY: number }): number | null;

export function ilAdjustedReturn(m: unknown, s: { mid: number; stxUsd?: number; portfolioY: number }): number | null;

export function isPlausibleAgainstHodl(portfolioY: number, hodl: number | null, maxFrac?: number): boolean;

export function organicApr(args: {
  currentValueY: number;
  basisXQty: number;
  basisYQty: number;
  basisT: string;
  mid: number;
  yLegUsdRate?: number;
  minDays?: number;
}): { netY: number | null; apr: number | null; days: number };
