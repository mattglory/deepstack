// How many rebalances will a 30-day pilot actually produce?
//
// Exact inventory dynamics: after a rebalance to a 50/50 value split, x*m = y = V/2.
// At m = m0*e^r:  yFraction = 1/(1+e^r), so
//     drift = 1/(1+e^r) - 1/2 = -tanh(r/2)/2
// The agent trades when |drift| >= B, i.e. when |r| >= 2*atanh(2B).
//
// Analytic: drift is driven by Brownian r with variance sigma^2 per day, so the expected
// first-passage time to +/-R is E[T] = R^2 / sigma^2. Monte Carlo checks that against the
// discrete 30-min sampling the pilot will actually run at.

const DAYS = 30;
const STEPS_PER_DAY = 48;            // --interval 1800
const TRIALS = 20000;

const bandFromK = (sigmaDaily, k) => Math.min(0.09, Math.max(0.03, (k * sigmaDaily) / 4));
const triggerR = (B) => 2 * Math.atanh(2 * B);   // mid move that crosses the band

function analytic(sigmaDaily, k) {
  const B = bandFromK(sigmaDaily, k);
  const R = triggerR(B);
  const expectedDays = (R * R) / (sigmaDaily * sigmaDaily); // E[first passage] to +/-R
  return { B, R, expectedDays, expectedIn30: DAYS / expectedDays };
}

// Random normal
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function simulate(sigmaDaily, k) {
  const B = bandFromK(sigmaDaily, k);
  const dt = 1 / STEPS_PER_DAY;
  const sd = sigmaDaily * Math.sqrt(dt);
  const counts = [];
  for (let t = 0; t < TRIALS; t++) {
    let r = 0, n = 0;
    for (let s = 0; s < DAYS * STEPS_PER_DAY; s++) {
      r += sd * gauss();
      const drift = -Math.tanh(r / 2) / 2;
      if (Math.abs(drift) >= B) { n++; r = 0; } // rebalance resets inventory to target
    }
    counts.push(n);
  }
  counts.sort((a, b) => a - b);
  const mean = counts.reduce((a, b) => a + b, 0) / TRIALS;
  const pct = (p) => counts[Math.floor(p * TRIALS)];
  const pAtLeast = (n) => counts.filter((c) => c >= n).length / TRIALS;
  return { B, mean, p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), pZero: counts.filter(c=>c===0).length/TRIALS, p25: pAtLeast(25) };
}

console.log("=== Expected rebalances in a 30-day pilot ===\n");
console.log("Current config: k=6 (sigmasTolerated), band clamped [300,900]bps\n");

for (const sigma of [0.0205, 0.03, 0.04, 0.06]) {
  const a = analytic(sigma, 6);
  const s = simulate(sigma, 6);
  console.log(`sigma=${(sigma*100).toFixed(2)}%/day  band=${(a.B*100).toFixed(2)}%  triggers at a ${(a.R*100).toFixed(1)}% mid move`);
  console.log(`  analytic:  E[time to 1st rebalance] = ${a.expectedDays.toFixed(1)} days -> ${a.expectedIn30.toFixed(2)} in 30d`);
  console.log(`  simulated: mean=${s.mean.toFixed(2)}  median=${s.p50}  p90=${s.p90}  p99=${s.p99}  P(zero)=${(s.pZero*100).toFixed(0)}%  P(>=25)=${(s.p25*100).toFixed(1)}%\n`);
}

console.log("=== What k would be needed for >=25 rebalances? (sigma=2.05%/day) ===\n");
for (const k of [6, 3, 2, 1, 0.5, 0.25]) {
  const a = analytic(0.0205, k);
  const s = simulate(0.0205, k);
  console.log(`k=${String(k).padEnd(5)} band=${(a.B*100).toFixed(2)}%  trigger=${(a.R*100).toFixed(1)}% move  mean=${s.mean.toFixed(1)}  median=${s.p50}  P(>=25)=${(s.p25*100).toFixed(0)}%`);
}
