// Capital-preservation mode status (read-only): what the trend rule would decide right now, from
// the stored closes plus fresh reads. Writes nothing; the agent's own daily step is the record.
//
//   npm run m1:trend
//   npm run m1:trend -- --capital-usd=2600   # size the would-be switch against exit capacity
//   npm run m1:trend -- --owner=SP...         # leave that wallet's own liquidity out of the capacity

import { loadDotenv } from "./wallet.js";
import { trendObserveStep, trendParams } from "./trend-io.js";

loadDotenv();
const arg = process.argv.find((a) => a.startsWith("--capital-usd="));
const capitalUsd = arg ? Number(arg.split("=")[1]) : null;
const owner = process.argv.find((a) => a.startsWith("--owner="))?.split("=")[1] ?? null;
const p = trendParams();
const r = await trendObserveStep({ capitalUsd, owner, persist: false, force: true });
const rec = (r.record ?? {}) as any;
console.log(`Trend rule (observe only): SMA${p.smaDays}, buffer ${p.buffer * 100}%, risk share ${p.riskShare * 100}%`);
console.log(`  state ${rec.from} → ${rec.action}: ${rec.reason}`);
if (rec.close) console.log(`  close ${rec.close.day} $${Math.round(rec.close.price)} (${rec.checks?.close})`);
if (rec.sma) console.log(`  SMA $${rec.sma} | risk-off below $${rec.offLine} | risk-on above $${rec.onLine}`);
console.log(`  checks: ${rec.checks?.pool} | ${rec.checks?.usdcx}`);
console.log(`  exit capacity: ${JSON.stringify(rec.exitCapacity)}`);
console.log(`  closes stored ${rec.closesStored}, verified ${rec.closesVerified}`);
if (r.alert) console.log(`  ⚠ ${r.alert}`);
