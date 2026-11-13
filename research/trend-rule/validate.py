import json, datetime as D
COST = 0.005
def load(c): return json.load(open(f"{c}_1d.json"))
def ts(d): return D.datetime.fromisoformat(d).replace(tzinfo=D.timezone.utc).timestamp()

def run(px, a, b, N=60, buf=0.02, rule=True):
    """Value path of hold 50/50 (rule=False) or the trend rule, from index a to b. SMA uses data before a too."""
    V = 1.0; p0 = px[a]; x = V / 2 / p0; y = V / 2; out = False; vals = []; sw = 0
    for i in range(a, b + 1):
        p = px[i]
        if rule:
            m = sum(px[max(0, i - N + 1): i + 1]) / len(px[max(0, i - N + 1): i + 1])
            if not out and p < m * (1 - buf):
                y += x * p * (1 - COST); x = 0; out = True; sw += 1
            elif out and p > m * (1 + buf):
                half = y / 2; x = half * (1 - COST) / p; y -= half; out = False; sw += 1
        vals.append(x * p + y)
    pk, mdd = vals[0], 0
    for v in vals: pk = max(pk, v); mdd = max(mdd, 1 - v / pk)
    return vals[-1] / vals[0] - 1, mdd, sw

def rolling(px, T, a, b, N, buf):
    wins = []
    i = a
    while i + 365 <= b:
        d = D.datetime.utcfromtimestamp(T[i])
        if d.day == 1:
            r_h, dd_h, _ = run(px, i, i + 365, rule=False)
            r_t, dd_t, _ = run(px, i, i + 365, N, buf)
            wins.append((dd_t < dd_h, r_t > r_h, r_t < -0.2, r_h < -0.2, r_t - r_h, dd_h - dd_t))
        i += 1
    n = len(wins)
    return dict(n=n, smallerDD=sum(w[0] for w in wins) / n, moreMoney=sum(w[1] for w in wins) / n,
                ruleLoss20=sum(w[2] for w in wins) / n, holdLoss20=sum(w[3] for w in wins) / n,
                avgRetDiff=sum(w[4] for w in wins) / n, avgDDcut=sum(w[5] for w in wins) / n)

sets = {"BTC out-of-sample (2018-06..2024-11)": ("bitcoin", "2018-06-22", "2024-11-12"),
        "ETH out-of-sample (2018-06..2026-11)": ("ethereum", "2018-06-24", "2026-11-13"),
        "BTC in-sample (2024-11..2026-11)": ("bitcoin", "2024-11-12", "2026-11-13")}
for name, (c, s, e) in sets.items():
    P = load(c); T = [t for t, _ in P]; px = [p for _, p in P]
    a = min(range(len(T)), key=lambda i: abs(T[i] - ts(s))); b = min(range(len(T)), key=lambda i: abs(T[i] - ts(e)))
    a = max(a, 200)  # leave room for the longest SMA
    rh, ddh, _ = run(px, a, b, rule=False)
    print(f"\n== {name}: {D.date.fromtimestamp(T[a])} -> {D.date.fromtimestamp(T[b])}, price {px[a]:,.0f} -> {px[b]:,.0f}")
    print(f"   hold 50/50: return {rh:+.0%}  maxDD {ddh:.0%} | 100% USDC: 0% / 0%")
    print("   N   buf   return  maxDD  switches | rolling 1y: smallerDD  moreMoney  rule<-20%  hold<-20%  avg ret diff  avg DD cut")
    for N in (20, 40, 60, 90, 120, 200):
        for buf in (0.0, 0.02, 0.05):
            r, dd, sw = run(px, a, b, N, buf)
            rl = rolling(px, T, a, b, N, buf)
            mark = " <- declared" if (N, buf) == (60, 0.02) else ""
            print(f"  {N:3d}  {buf:4.0%}  {r:+7.0%}  {dd:5.0%}  {sw:5d}    |  {rl['smallerDD']:6.0%}     {rl['moreMoney']:6.0%}     {rl['ruleLoss20']:5.0%}      {rl['holdLoss20']:5.0%}      {rl['avgRetDiff']:+6.1%}      {rl['avgDDcut']:+6.1%}{mark}")
