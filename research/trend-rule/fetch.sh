#!/usr/bin/env bash
# Daily BTC and ETH closes from DefiLlama (public, no key), saved as bitcoin_1d.json / ethereum_1d.json.
set -euo pipefail
cd "$(dirname "$0")"
start=$(python3 -c 'import datetime as D;print(int(D.datetime(2016,9,1,tzinfo=D.timezone.utc).timestamp()))'); now=$(date +%s)
for c in bitcoin ethereum; do
  s=$start; i=0
  while [ "$s" -lt "$now" ]; do curl -s "https://coins.llama.fi/chart/coingecko:$c?start=$s&span=480&period=1d" -o "d_${c}_$i.json"; s=$((s + 480*86400)); i=$((i+1)); sleep 1; done
done
python3 - <<'PY'
import json, glob
for c in ("bitcoin", "ethereum"):
    pts = {}
    for f in glob.glob(f"d_{c}_*.json"):
        for x in json.load(open(f)).get("coins", {}).get(f"coingecko:{c}", {}).get("prices", []): pts[x["timestamp"] // 86400] = x["price"]
    json.dump([[d * 86400, pts[d]] for d in sorted(pts)], open(f"{c}_1d.json", "w"))
PY
rm -f d_*.json
