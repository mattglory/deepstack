// What band would be required to hit >=25 rebalances in 30 days — and is it defensible?
const SIGMA = 0.0205, DAYS = 30, SWAP_FEE_BPS = 50;
const triggerR = (B) => 2 * Math.atanh(2 * B);

// Invert E[T] = R^2/sigma^2 for a target count
const bandFor = (n) => {
  const T = DAYS / n;                       // days per rebalance
  const R = Math.sqrt(T) * SIGMA;           // required mid move
  return Math.tanh(R / 2) / 2;              // back out the drift band
};

console.log("=== Band required to manufacture a given transaction count (sigma=2.05%/day) ===\n");
console.log("txs/30d   band      triggers on   cost to execute vs the drift it corrects");
for (const n of [1, 5, 10, 25, 50]) {
  const B = bandFor(n);
  // A rebalance trades ~half the drift back to target; it pays SWAP_FEE on that notional.
  // Ratio of fee paid to deviation corrected — >1 means the cure costs more than the disease.
  const feeVsDrift = (SWAP_FEE_BPS / 10000) / (B);
  console.log(
    `${String(n).padStart(5)}   ${(B*10000).toFixed(0).padStart(5)}bps   ${(triggerR(B)*100).toFixed(1).padStart(5)}% move   fee is ${(feeVsDrift*100).toFixed(0)}% of the drift corrected`
  );
}
console.log(`\nswap fee = ${SWAP_FEE_BPS}bps (Bitflow pool fee, paid on every rebalance)`);
