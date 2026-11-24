"""Backtest: DLMM sBTC/USDCx concentrated LP vs defensive variants, on 4-hourly BTC/USD.

Model (deliberately simple, stated so the results can be judged):
- Position: 2W+1 bins, bin step s (10 bps), equal value per bin at deposit. A bin above the price
  holds sBTC (C_i / p_i), at or below holds USDCx (C_i). Value(p) = sum(p_i > p ? C_i*p/p_i : C_i).
- Fees: while the price is inside the range, value * fee_day * dt. fee_day calibrated from the
  agent's own observed fees (about 0.10-0.17 %/day of position value in Oct-Nov 2026).
- Recenter: when the price leaves the range, liquidate, swap to 50/50 (swap_cost on the notional
  swapped), re-add +-W around the price.
- Defensive: liquidate to USDCx (swap all sBTC, swap_cost), hold; re-enter by swapping half back.
"""
import json, math, sys, datetime as D

P = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "btc4h.json"))
T = [t for t, _ in P]; PX = [p for _, p in P]
DT_DAYS = 4 / 24

class LP:
    def __init__(self, value, p, W, s):
        self.W, self.s = W, s
        c = value / (2 * W + 1)
        self.bins = [(p * (1 + s) ** i, c) for i in range(-W, W + 1)]
        self.lo, self.hi = self.bins[0][0] / (1 + s), self.bins[-1][0] * (1 + s)
    def value(self, p):
        return sum(c * p / pi if pi > p else c for pi, c in self.bins)
    def legs(self, p):  # (sBTC qty, USDCx)
        x = sum(c / pi for pi, c in self.bins if pi > p); y = sum(c for pi, c in self.bins if pi <= p)
        return x, y
    def in_range(self, p):
        return self.lo <= p <= self.hi
    def add_fees(self, f):  # fees are paid in both tokens; keep it simple: grow every bin pro rata
        k = 1 + f / max(1e-9, sum(c for _, c in self.bins))
        self.bins = [(pi, c * k) for pi, c in self.bins]

def sma(i, n):  # simple moving average over the last n steps (incl. i)
    a = PX[max(0, i - n + 1): i + 1]; return sum(a) / len(a)

def rvol(i, n):  # realised daily vol over the last n steps
    a = PX[max(0, i - n): i + 1]
    r = [math.log(a[k + 1] / a[k]) for k in range(len(a) - 1)]
    if len(r) < 2: return 0
    m = sum(r) / len(r); return math.sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1)) * math.sqrt(6)

def run(i0, i1, W=35, s=0.001, fee_day=0.0012, swap_cost=0.005, mode="lp", **k):
    """mode: lp | hodl | usd | trend | dd | haven. Returns dict of results."""
    p0 = PX[i0]; V0 = 10_000.0
    if mode == "hodl":
        x, y = V0 / 2 / p0, V0 / 2
        vals = [x * PX[i] + y for i in range(i0, i1 + 1)]
        return summarize(vals, 0, 0, 0)
    if mode == "usd":
        return summarize([V0] * (i1 - i0 + 1), 0, 0, 0)
    cash = 0.0; lp = LP(V0 * (1 - swap_cost * 0.5 * 0), p0, W, s)  # opening from 50/50 legs: no swap
    haven_frac = k.get("haven", 1.0)  # fraction moved to USDCx when defensive
    defensive = False; vals = []; fees = costs = 0.0; switches = recenters = 0
    peak = p0
    for i in range(i0, i1 + 1):
        p = PX[i]
        # fees for the step just ended
        if lp and lp.in_range(p):
            f = lp.value(p) * fee_day * DT_DAYS; lp.add_fees(f); fees += f
        # regime signal (uses only data up to i)
        want_def = defensive
        if mode == "trend":
            m = sma(i, int(k["days"] * 6)); b = k.get("buf", 0.0)
            if not defensive and p < m * (1 - b): want_def = True
            elif defensive and p > m * (1 + b): want_def = False
        elif mode == "dd":
            peak = max(peak, p) if not defensive else peak
            hi = max(PX[max(0, i - int(k["look"] * 6)): i + 1])
            if not defensive and p < hi * (1 - k["dd"]): want_def = True
            elif defensive and p > sma(i, int(k["reenter"] * 6)): want_def = False
        elif mode == "vol":
            v = rvol(i, int(k["days"] * 6)); m = sma(i, int(k["days"] * 6))
            if not defensive and v > k["vmax"] and p < m: want_def = True
            elif defensive and (v < k["vmax"] * 0.8 or p > m): want_def = False
        # act on a regime change
        if want_def != defensive:
            switches += 1
            # Liquidate everything to legs, then rebuild: defensive -> haven_frac held as USDCx,
            # the rest as a 50/50 LP; back to normal -> 100% LP. One swap for the difference.
            x, y = lp.legs(p) if lp else (0.0, 0.0)
            y += cash; V = x * p + y
            h = haven_frac if want_def else 0.0
            target_x_value = (1 - h) * V / 2
            c = abs(x * p - target_x_value) * swap_cost; costs += c
            V -= c
            cash = h * V
            lp = LP((1 - h) * V, p, W, s) if (1 - h) * V > 1 else None
            defensive = want_def
        # recenter when out of range
        if lp and not lp.in_range(p):
            x, y = lp.legs(p); V = x * p + y
            c = abs(x * p - V / 2) * swap_cost; costs += c
            lp = LP(V - c, p, W, s); recenters += 1
        vals.append(cash + (lp.value(p) if lp else 0))
    return summarize(vals, fees, costs, switches, recenters)

def summarize(vals, fees, costs, switches, recenters=0):
    peak, mdd = vals[0], 0.0
    for v in vals:
        peak = max(peak, v); mdd = max(mdd, 1 - v / peak)
    return {"final": vals[-1], "ret": vals[-1] / vals[0] - 1, "mdd": mdd, "fees": fees, "costs": costs, "switches": switches, "recenters": recenters}

def idx(date):
    t = D.datetime.fromisoformat(date).replace(tzinfo=D.timezone.utc).timestamp()
    return min(range(len(T)), key=lambda i: abs(T[i] - t))

if __name__ == "__main__":
    windows = {
        "2y (Nov 24-Nov 26)": (0, len(PX) - 1),
        "year 1 (Nov 24-Nov 25)": (0, idx("2025-11-12")),
        "year 2 (Nov 25-Nov 26)": (idx("2025-11-12"), len(PX) - 1),
        "since deposit (27 Oct-12 Nov 26)": (idx("2026-10-27T12:00:00"), len(PX) - 1),
    }
    strategies = [
        ("Hold 50/50 sBTC+USDCx", dict(mode="hodl")),
        ("All USDCx", dict(mode="usd")),
        ("LP +-35, always on (today)", dict(mode="lp")),
        ("LP +-50, always on", dict(mode="lp", W=50)),
        ("Trend 7d SMA, 100% to USDCx", dict(mode="trend", days=7, buf=0.0)),
        ("Trend 7d SMA +-2% buffer", dict(mode="trend", days=7, buf=0.02)),
        ("Trend 14d SMA +-2% buffer", dict(mode="trend", days=14, buf=0.02)),
        ("Trend 30d SMA +-2% buffer", dict(mode="trend", days=30, buf=0.02)),
        ("Trend 14d +-2%, 40% haven", dict(mode="trend", days=14, buf=0.02, haven=0.4)),
        ("Drawdown 8% from 14d high", dict(mode="dd", dd=0.08, look=14, reenter=7)),
        ("Drawdown 5% from 7d high", dict(mode="dd", dd=0.05, look=7, reenter=7)),
    ]
    fee_day = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0012
    print(f"fee assumption {fee_day*100:.2f}%/day of in-range value, swap cost 0.5%\n")
    for wname, (a, b) in windows.items():
        print(f"== {wname}: BTC {PX[a]:,.0f} -> {PX[b]:,.0f} ({PX[b]/PX[a]-1:+.1%})")
        for name, kw in strategies:
            r = run(a, b, fee_day=fee_day, **kw)
            print(f"  {name:32s} {r['ret']:+7.1%}  maxDD {r['mdd']:5.1%}  fees ${r['fees']:7,.0f}  costs ${r['costs']:6,.0f}  switches {r['switches']:3d}  recenters {r['recenters']:3d}")
        print()
