"""Exploratory post-knowledge backtest of the AI direction forecaster (not the pre-registered test).

The model is asked about each day with dates withheld, using the fixed prompt in prompt.txt, on days
after its knowledge ends (it recalls BTC up to about late 2025 and guessed 2026 prices tens of
thousands of dollars off: see README in this folder). Scored as PREREGISTERED.md sections 4-6.
Usage: python3 backtest.py fetch | forecast | score     (OPENROUTER_API_KEY in the environment)
"""
import json, math, os, random, sys, time, urllib.request, datetime as D, hashlib
from concurrent.futures import ThreadPoolExecutor

MODEL = "anthropic/claude-sonnet-5.5"
START, END = "2026-02-01", "2026-11-13"  # forecast days; END + 7 must have a completed close
HERE = os.path.dirname(os.path.abspath(__file__))
PROMPT = open(os.path.join(HERE, "prompt.txt")).read()
PROMPT_SHA = hashlib.sha256(PROMPT.encode()).hexdigest()
CLOSES, OUT = os.path.join(HERE, "closes.json"), os.path.join(HERE, "forecasts.jsonl")

def fetch():
    s = int(D.datetime(2025, 9, 1, tzinfo=D.timezone.utc).timestamp()); pts = {}
    while s < time.time():
        j = json.load(urllib.request.urlopen(f"https://coins.llama.fi/chart/coingecko:bitcoin?start={s}&span=400&period=1d", timeout=30))
        for x in j["coins"]["coingecko:bitcoin"]["prices"]:
            # Points sit at about 00:00 UTC, +-10 s: a point at 23:59:52 on day E is the same
            # midnight snapshot as 00:00:02 on day E+1. Label each by the day it closes (ts - 12h).
            pts[D.datetime.utcfromtimestamp(x["timestamp"] - 43200).date().isoformat()] = x["price"]
        s += 400 * 86400
    today = D.datetime.utcnow().date().isoformat()
    c = sorted((d, p) for d, p in pts.items() if d < today)
    gaps = [c[i][0] for i in range(1, len(c)) if (D.date.fromisoformat(c[i][0]) - D.date.fromisoformat(c[i - 1][0])).days != 1]
    assert not gaps, f"gaps in the daily series before {gaps[:5]}"
    json.dump(c, open(CLOSES, "w"))

def load():
    c = json.load(open(CLOSES)); return [d for d, _ in c], [p for _, p in c]

def prompt_for(px, i):
    w = px[i - 89: i + 1]; sma = sum(px[i - 59: i + 1]) / 60
    r = [math.log(px[k] / px[k - 1]) for k in range(i - 29, i + 1)]; m = sum(r) / len(r)
    vol = math.sqrt(sum((x - m) ** 2 for x in r) / (len(r) - 1)) * 100
    return (PROMPT.replace("{closes}", ", ".join(f"{p:.0f}" for p in w)).replace("{last}", f"{px[i]:.0f}")
            .replace("{sma60}", f"{sma:.0f}").replace("{dist}", f"{(px[i] / sma - 1) * 100:+.1f}").replace("{vol}", f"{vol:.2f}"))

def ask(text, key):
    body = json.dumps({"model": MODEL, "temperature": 0, "messages": [{"role": "user", "content": text}]}).encode()
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=body,
                                 headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    j = json.load(urllib.request.urlopen(req, timeout=90))
    return j.get("model"), j["choices"][0]["message"]["content"]

def forecast():
    key = os.environ["OPENROUTER_API_KEY"]; days, px = load()
    done = {json.loads(l)["day"] for l in open(OUT)} if os.path.exists(OUT) else set()
    todo = [i for i, d in enumerate(days) if START <= d <= END and d not in done]
    def one(i):
        try:
            model, txt = ask(prompt_for(px, i), key)
            s = txt[txt.find("{"): txt.rfind("}") + 1]; o = json.loads(s)
            p1, p7 = float(o["p_up_1d"]), float(o["p_up_7d"])
            assert 0 <= p1 <= 1 and 0 <= p7 <= 1
            return {"day": days[i], "p_up_1d": p1, "p_up_7d": p7, "model": model, "prompt_sha": PROMPT_SHA}
        except Exception as e:  # missing, never retried with a different prompt
            return {"day": days[i], "missing": str(e)[:200], "prompt_sha": PROMPT_SHA}
    with ThreadPoolExecutor(4) as ex, open(OUT, "a") as f:
        for r in ex.map(one, todo): f.write(json.dumps(r) + "\n"); f.flush()

def brier(ps, ys): return sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ys)

def score():
    days, px = load(); ix = {d: i for i, d in enumerate(days)}
    fc = {r["day"]: r for r in map(json.loads, open(OUT))}
    # trend rule state through time (SMA60, 2% buffer), starting risk-on once 60 closes exist
    state, st = "on", {}
    for i in range(59, len(px)):
        sma = sum(px[i - 59: i + 1]) / 60
        if state == "on" and px[i] < sma * 0.98: state = "off"
        elif state == "off" and px[i] > sma * 1.02: state = "on"
        st[days[i]] = state
    out = {}
    for h in (1, 7):
        rows = []
        for d, r in sorted(fc.items()):
            i = ix[d]
            if "missing" in r or i + h >= len(px): continue
            y = 1 if px[i + h] > px[i] else 0
            past = [1 if px[k] > px[k - h] else 0 for k in range(max(h, i - 364), i + 1)]
            base = sum(past) / len(past)
            pers = 0.6 if px[i] > px[i - h] else 0.4
            rows.append((d, r[f"p_up_{h}d"], y, 0.5, base, pers, 0.6 if st[d] == "on" else 0.4))
        cols = list(zip(*rows)); y = cols[2]
        names = ["AI", "coin flip", "base rate", "persistence", "trend rule"]
        b = {n: brier(cols[k], y) for n, k in zip(names, [1, 3, 4, 5, 6])}
        hit = sum((p > 0.5) == (t == 1) for p, t in zip(cols[1], y)) / len(y)
        said_half = sum(abs(p - 0.5) < 1e-9 for p in cols[1]) / len(y)
        # block bootstrap, 7-day blocks: coin-flip Brier minus AI Brier
        diffs = [(0.5 - t) ** 2 - (p - t) ** 2 for p, t in zip(cols[1], y)]
        rng = random.Random(7); n = len(diffs); B = []
        for _ in range(10_000):
            s = []
            while len(s) < n:
                a = rng.randrange(0, n - 6); s.extend(diffs[a: a + 7])
            B.append(sum(s[:n]) / n)
        B.sort()
        out[h] = dict(n=n, brier=b, hit=hit, said_half=said_half, ci=(B[249], B[9749]), up_share=sum(y) / n)
    # economic check: 30% sBTC when risk-on, else USDCx; next-day execution; 0.5% per switch
    def run(on_fn):
        sel = [d for d in sorted(fc) if "missing" not in fc[d] and ix[d] + 1 < len(px)]
        v, x, y_, on = 1.0, 0.3 / px[ix[sel[0]]], 0.7, True
        pend = None
        for d in sel:
            i = ix[d]; p = px[i]
            if pend is not None:
                V = x * p + y_
                if pend and not on: x = 0.3 * V * 0.995 / p; y_ = 0.7 * V; on = True
                elif not pend and on: y_ = y_ + x * p * 0.995; x = 0; on = False
                pend = None
            want = on_fn(d)
            if want != on: pend = want
        return x * px[ix[sel[-1]]] + y_
    eco = {"AI (p7>0.5)": run(lambda d: fc[d]["p_up_7d"] > 0.5), "trend rule": run(lambda d: st[d] == "on"), "hold 30/70": run(lambda d: True)}
    first = sorted(fc)[0]; last = sorted(fc)[-1]
    print(f"Model {MODEL}, prompt sha {PROMPT_SHA[:12]}, forecast days {first}..{last}, missing {sum('missing' in r for r in fc.values())}")
    for h, o in out.items():
        print(f"\n{h}-day horizon: n={o['n']}, up share {o['up_share']:.0%}, AI hit rate {o['hit']:.1%}, AI said exactly 0.5 on {o['said_half']:.0%} of days")
        for k, v in sorted(o["brier"].items(), key=lambda kv: kv[1]): print(f"   Brier {k:12s} {v:.4f}")
        print(f"   coin-flip minus AI Brier, 95% block-bootstrap CI: {o['ci'][0]:+.4f} .. {o['ci'][1]:+.4f}")
    print("\nEconomic check (start 1.0, value at the end):")
    for k, v in eco.items(): print(f"   {k:14s} {v:.4f} ({(v - 1) * 100:+.1f}%)")

if __name__ == "__main__":
    {"fetch": fetch, "forecast": forecast, "score": score}[sys.argv[1]]()
