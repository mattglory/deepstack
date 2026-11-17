import json, math, datetime as D
COST = 0.005
def load(c): return json.load(open(f"{c}_1d.json"))
def ts(d): return D.datetime.fromisoformat(d).replace(tzinfo=D.timezone.utc).timestamp()

def sim(px, a, b, trend=True, vol=True, N=60, buf=0.02, vt=0.5, vl=20, wmax=0.5, band=0.05):
    V = 1.0; x = 0.0; y = V; out = False; vals = []
    def target(i):
        nonlocal out
        if trend:
            m = sum(px[i - N + 1: i + 1]) / N
            if not out and px[i] < m * (1 - buf): out = True
            elif out and px[i] > m * (1 + buf): out = False
            if out: return 0.0
        if not vol: return wmax
        r = [math.log(px[k] / px[k - 1]) for k in range(i - vl + 1, i + 1)]
        mu = sum(r) / len(r); s = math.sqrt(sum((q - mu) ** 2 for q in r) / (len(r) - 1)) * math.sqrt(365)
        return wmax * min(1.0, vt / s) if s > 0 else wmax
    for i in range(a, b + 1):
        p = px[i]; tot = x * p + y; w = target(i)
        cur = x * p / tot
        first = i == a
        if first or abs(cur - w) > band or (w == 0 and x > 0) or (w > 0 and cur == 0 and w > band):
            trade = w * tot - x * p  # + buy risk, - sell risk
            c = abs(trade) * COST
            x += (trade - (c if trade > 0 else 0)) / p
            y -= trade + (c if trade < 0 else 0)
            if first: x, y = w * tot / p, (1 - w) * tot  # opening position: no cost counted (same as hold)
        vals.append(x * p + y)
    pk, mdd = vals[0], 0
    for v in vals: pk = max(pk, v); mdd = max(mdd, 1 - v / pk)
    return vals[-1] / vals[0] - 1, mdd

def hold(px, a, b): return sim(px, a, b, trend=False, vol=False)

def rolling(px, T, a, b, **kw):
    out = []
    for i in range(a, b - 365 + 1):
        if D.datetime.utcfromtimestamp(T[i]).day != 1: continue
        out.append((sim(px, i, i + 365, **kw), sim(px, i, i + 365, trend=True, vol=False), hold(px, i, i + 365)))
    return out

sets = {"BTC out-of-sample": ("bitcoin", "2019-01-08", "2024-11-12"),
        "ETH out-of-sample": ("ethereum", "2019-01-10", "2026-11-13"),
        "BTC in-sample (reference)": ("bitcoin", "2024-11-12", "2026-11-13")}
for name, (c, s, e) in sets.items():
    P = load(c); T = [t for t, _ in P]; px = [p for _, p in P]
    a = min(range(len(T)), key=lambda i: abs(T[i] - ts(s))); b = min(range(len(T)), key=lambda i: abs(T[i] - ts(e)))
    rh, dh = hold(px, a, b); rt, dt = sim(px, a, b, trend=True, vol=False)
    print(f"\n== {name} {D.date.fromtimestamp(T[a])}..{D.date.fromtimestamp(T[b])}: hold {rh:+.0%}/{dh:.0%}  trend-only {rt:+.0%}/{dt:.0%}")
    print("   variant              target lookback  return  maxDD | vs trend-only, rolling 1y: smallerDD  >20%loss (v / trend / hold)  avg ret diff")
    rows = [("trend+vol", True, 0.5, 20)] + [("trend+vol", True, vt, vl) for vt in (0.3, 0.5, 0.7) for vl in (10, 20, 40) if (vt, vl) != (0.5, 20)] + [("vol only", False, 0.5, 20)]
    for lab, tr, vt, vl in rows:
        r, d = sim(px, a, b, trend=tr, vol=True, vt=vt, vl=vl)
        W = rolling(px, T, a, b, trend=tr, vol=True, vt=vt, vl=vl)
        n = len(W)
        sm = sum(w[0][1] < w[1][1] for w in W) / n
        l20 = sum(w[0][0] < -0.2 for w in W) / n; t20 = sum(w[1][0] < -0.2 for w in W) / n; h20 = sum(w[2][0] < -0.2 for w in W) / n
        diff = sum(w[0][0] - w[1][0] for w in W) / n
        mark = "  <- declared" if (lab, vt, vl) == ("trend+vol", 0.5, 20) else ""
        print(f"   {lab:10s}            {vt:4.0%}   {vl:3d}d   {r:+7.0%}  {d:5.0%} |   {sm:6.0%}       {l20:4.0%} / {t20:4.0%} / {h20:4.0%}        {diff:+6.1%}{mark}")
