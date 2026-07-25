// Read-only DLMM venue scan — prints active bin, step, depth window, and activity for each
// target pool. Safe to run anytime (no capital, no writes). `node --import tsx src/m1/dlmm-cli.ts`
import { scanDlmm } from "./dlmm-read.js";

const half = Number(process.argv[2] ?? 10);

const rows = await scanDlmm(half);
console.log(`DLMM read-only scan (±${half} bins around active)\n`);
for (const r of rows) {
  if (!r.state) {
    console.log(`[${r.pool}]  (read failed)`);
    continue;
  }
  const s = r.state;
  const d = r.depth;
  console.log(`[${s.pool}]`);
  console.log(`  active bin ${s.activeBinId} | bin-step ${s.binStep}bp | lifetime recenters ${s.binChangeCount.toLocaleString()}`);
  console.log(`  x-token ${s.xToken}`);
  console.log(`  y-token ${s.yToken}`);
  console.log(`  core    ${s.coreAddress}`);
  if (d) {
    const skip = d.binsSkipped > 0 ? ` — ${d.binsSkipped} below-anchor bins skipped (mapping TODO)` : "";
    console.log(`  local depth ±${d.halfWindow} bins: x=${d.xTotal} y=${d.yTotal} (${d.binsWithLiquidity}/${2 * d.halfWindow + 1} bins with liquidity)${skip}`);
  }
  console.log("");
}
