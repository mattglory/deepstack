"""Post-review re-run (2026-11-17, #90 review R90-5 and the section 5 answers). validate.py stays as
pre-registered. Two changes, each reported next to the original:
- lag=1: the switch trades at the NEXT day's close, not the close that produced the signal (removes
  the mild look-ahead R90-5 points out);
- share=0.3: 30% risk asset in risk-on (the agreed v1 setting), benchmarked against holding 30%.
Same data, windows and 0.5% cost per switch; cash earns 0%."""
import json, datetime as D
COST = 0.005
def load(c): return json.load(open(f"{c}_1d.json"))
def ts(d): return D.datetime.fromisoformat(d).replace(tzinfo=D.timezone.utc).timestamp()

def run(px, a, b, N=60, buf=0.02, rule=True, share=0.5, lag=0):
    x = share / px[a]; y = 1 - share; out = False; vals = []; pending = None
    for i in range(a, b + 1):
        p = px[i]
        if pending is not None:  # execute yesterday's decision at today's price
            if pending == "off": y += x * p * (1 - COST); x = 0
            else: buy = (x * p + y) * share; x = buy * (1 - COST) / p; y -= buy
            pending = None
        if rule:
            m = sum(px[i - N + 1: i + 1]) / N
            act = None
            if not out and p < m * (1 - buf): act, out = "off", True
            elif out and p > m * (1 + buf): act, out = "on", False
            if act and lag == 0:
                if act == "off": y += x * p * (1 - COST); x = 0
                else: buy = (x * p + y) * share; x = buy * (1 - COST) / p; y -= buy
            elif act: pending = act
        vals.append(x * p + y)
    pk, mdd = vals[0], 0
    for v in vals: pk = max(pk, v); mdd = max(mdd, 1 - v / pk)
    return vals[-1] / vals[0] - 1, mdd

def rolling(px, T, a, b, **kw):
    w = []
    for i in range(a, b - 365 + 1):
        if D.datetime.utcfromtimestamp(T[i]).day != 1: continue
        rh, dh = run(px, i, i + 365, rule=False, share=kw.get("share", 0.5))
        rt, dt = run(px, i, i + 365, **kw)
        w.append((dt < dh, rt < -0.2, rh < -0.2, rt - rh))
    n = len(w)
    return sum(x[0] for x in w) / n, sum(x[1] for x in w) / n, sum(x[2] for x in w) / n, sum(x[3] for x in w) / n

for name, (c, s, e) in {"BTC 2019-01..2024-11": ("bitcoin", "2019-01-08", "2024-11-12"), "ETH 2019-01..2026-11": ("ethereum", "2019-01-10", "2026-11-13")}.items():
    P = load(c); T = [t for t, _ in P]; px = [p for _, p in P]
    a = min(range(len(T)), key=lambda i: abs(T[i] - ts(s))); b = min(range(len(T)), key=lambda i: abs(T[i] - ts(e)))
    print(f"== {name}")
    print("   variant                         return  maxDD (hold same share) | 1y windows: smaller DD  >20% loss rule/hold  avg ret diff")
    for lab, kw in [("as pre-registered (50%, same day)", dict(share=0.5, lag=0)), ("50%, next-day execution", dict(share=0.5, lag=1)), ("30%, next-day execution (v1)", dict(share=0.3, lag=1))]:
        r, d = run(px, a, b, **kw); rh, dh = run(px, a, b, rule=False, share=kw["share"])
        sm, l, lh, diff = rolling(px, T, a, b, **kw)
        print(f"   {lab:34s} {r:+7.0%} {d:5.0%} ({rh:+.0%}/{dh:.0%}) |   {sm:6.0%}        {l:4.0%} / {lh:4.0%}       {diff:+6.1%}")
