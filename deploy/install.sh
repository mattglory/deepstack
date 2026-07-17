#!/usr/bin/env bash
# DeepStack pilot VPS — install/update the agent. Run as root AFTER provision.sh:
#
#   bash install.sh          # first install, or update to latest main
#
# Does runbook §3 + §6 prep (docs/PILOT_DEPLOY.md): clone/pull, deps, tests, systemd
# unit. It deliberately does NOT create .env and does NOT start the service — secrets
# travel over scp only, and the first start is a manual, verified step (§4-§6).
# Safe to re-run; re-running updates the code and restarts nothing.

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
id deepstack >/dev/null 2>&1 || { echo "run provision.sh first"; exit 1; }

REPO=https://github.com/mattglory/deepstack.git
APP=/opt/deepstack
SRC=/opt/deepstack-src

echo "== fetch code =="
if [ -d "$SRC/.git" ]; then git -C "$SRC" pull --ff-only; else git clone "$REPO" "$SRC"; fi
# The repo root is the agent (package.json at top level); copy everything except
# runtime/secret state so updates never clobber .env, journal, or telemetry.
mkdir -p "$APP"
rsync -a --delete \
  --exclude .git --exclude node_modules \
  --exclude .env --exclude journal --exclude dashboard/metrics.json \
  "$SRC"/ "$APP"/

echo "== deps + gates (do not deploy a red suite) =="
cd "$APP"
npm install --no-fund --no-audit
npm test
npm run typecheck
chown -R deepstack:deepstack "$APP"

echo "== systemd unit (installed, NOT enabled) =="
cp "$APP/deploy/deepstack-agent.service" /etc/systemd/system/
systemctl daemon-reload

cat <<'EOF'

Installed. Remaining MANUAL steps (docs/PILOT_DEPLOY.md §4-§6):

  1. From your laptop:  scp .env root@<vps>:/opt/deepstack/.env
     then here:         chown deepstack:deepstack /opt/deepstack/.env && chmod 600 /opt/deepstack/.env
  2. Verify the healthchecks.io check exists (30 min period / 15 min grace) and
     HEALTHCHECK_URL is in .env.
  3. Dress rehearsal (observe mode, no trading): run one cycle as the service user and
     check it says mainnet + your wallet address:
        sudo -u deepstack env -C /opt/deepstack node --import tsx src/m1/agent-cli.ts
  4. Only then:  systemctl enable --now deepstack-agent && journalctl -u deepstack -f
  5. Reboot test:  systemctl is-enabled deepstack-agent && reboot
EOF
