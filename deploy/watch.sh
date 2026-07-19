#!/usr/bin/env bash
# Watch the live pilot agent from your laptop.
#
#   npm run pilot:status     one-page health check
#   npm run pilot:watch      live logs (Ctrl+C to stop watching; agent keeps running)
#   bash deploy/watch.sh errors    anything that ever went wrong
#   bash deploy/watch.sh report [--since YYYY-MM-DD]   pilot P&L report from the box's data
#   bash deploy/watch.sh kill      halt trading NOW (process keeps journalling)
#   bash deploy/watch.sh resume    clear the kill switch
#
# Reads PILOT_HOST (e.g. root@1.2.3.4) from .env — the server address stays out of the
# public repo on purpose: it's a hot-wallet host.

set -euo pipefail
cd "$(dirname "$0")/.."
HOST=$(grep -E '^PILOT_HOST=' .env 2>/dev/null | head -1 | cut -d= -f2-)
[ -n "${HOST:-}" ] || { echo "add PILOT_HOST=root@<vps-ip> to .env"; exit 1; }

case "${1:-status}" in
  logs)
    exec ssh -t "$HOST" journalctl -u deepstack-agent -f
    ;;
  status)
    ssh "$HOST" '
      echo "service : $(systemctl is-active deepstack-agent) ($(systemctl is-enabled deepstack-agent), up $(uptime -p | sed s/^up\ //))"
      echo "kill    : $([ -f /opt/deepstack/KILL ] && echo "⛔ ENGAGED" || echo "off")"
      echo "last tick:"
      tail -1 /opt/deepstack/journal/$(date -u +%F).jsonl 2>/dev/null | head -c 400; echo
      echo "today   : $(grep -c "\"mode\"" /opt/deepstack/journal/$(date -u +%F).jsonl 2>/dev/null || echo 0) ticks, $(grep -c cycle-error /opt/deepstack/journal/$(date -u +%F).jsonl 2>/dev/null || echo 0) errors"'
    ;;
  errors)
    ssh "$HOST" '
      journalctl -u deepstack-agent --no-pager | grep -iE "cycle failed|SAFETY HALT|refusing|broadcast failed" | tail -20
      echo "--- journalled cycle-errors ---"
      grep -h "cycle-error" /opt/deepstack/journal/*.jsonl 2>/dev/null | tail -5 || echo "(none)"'
    ;;
  report)
    shift
    ssh "$HOST" "cd /opt/deepstack && sudo -u deepstack node --import tsx src/m2/pnl-cli.ts $*"
    ;;
  sync)
    # Pull the pilot's evidence (journal + telemetry) down to the laptop. The journal is
    # the M2 uptime/decision record — it must survive a dead VPS. Run this weekly at least.
    mkdir -p evidence-backup
    rsync -az "$HOST":/opt/deepstack/journal/ evidence-backup/journal/
    rsync -az "$HOST":/opt/deepstack/dashboard/metrics.json evidence-backup/metrics.json
    echo "synced → evidence-backup/ ($(ls evidence-backup/journal | wc -l | tr -d ' ') journal days)"
    ;;
  pilot-start)
    shift
    ssh "$HOST" "cd /opt/deepstack && sudo -u deepstack node --import tsx src/m2/pilot-start-cli.ts $*"
    ;;
  kill)
    ssh "$HOST" 'touch /opt/deepstack/KILL && echo "⛔ KILL engaged — trading halts at the next cycle; telemetry continues"'
    ;;
  resume)
    ssh "$HOST" 'rm -f /opt/deepstack/KILL && echo "kill switch cleared — trading resumes next cycle"'
    ;;
  *)
    echo "usage: watch.sh [status|logs|errors|kill|resume]"
    ;;
esac
