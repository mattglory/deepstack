#!/usr/bin/env bash
# Read-only host baseline for the DeepStack VPS (assessment 2026-11, DSA-28 / roadmap A6).
# Run as root during a supervised session; it changes nothing and prints no secret values:
#
#   bash deploy/host-review.sh > host-review-$(date -u +%F).txt
#
# It reports file modes and owners for secret files, and the NAMES (never values) of the
# variables set in .env compared with .env.example. Review the output before sharing it, and
# share it privately (it describes the host's defences), not in the public repo.

set -uo pipefail
APP="${DEEPSTACK_APP_DIR:-/opt/deepstack}"
SERVICE="${DEEPSTACK_SERVICE:-deepstack-agent}"
sec() { printf '\n=== %s ===\n' "$1"; }
run() { printf '$ %s\n' "$*"; "$@" 2>&1 || printf '(exit %s)\n' "$?"; }

sec "host"
run date -u
run hostnamectl
run uptime
run cat /etc/os-release
run uname -r
command -v cloud-init >/dev/null && run cloud-init query -a 2>/dev/null | grep -Ei '"(cloud_name|platform|region|availability_zone)"' || true

sec "users with a login shell, sudo rights, root keys"
run awk -F: '$7 !~ /(nologin|false)$/ {print $1, $3, $7}' /etc/passwd
run getent group sudo
run ls -l /etc/sudoers.d
for f in /etc/sudoers.d/*; do [ -f "$f" ] && { echo "--- $f"; grep -v '^\s*#' "$f" | sed '/^\s*$/d'; }; done
for h in /root /home/*; do
  ak="$h/.ssh/authorized_keys"
  [ -f "$ak" ] && { echo "--- $ak"; ssh-keygen -l -f "$ak" 2>&1; }
done
[ -f /var/lib/deepstack-halt/.ssh/authorized_keys ] && { echo "--- halt keys"; ssh-keygen -l -f /var/lib/deepstack-halt/.ssh/authorized_keys; }

sec "sshd effective config"
run sh -c "sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|authenticationmethods|allowusers|allowgroups|maxauthtries|x11forwarding|allowtcpforwarding)'"
run sh -c "last -n 20 -a 2>/dev/null | head -25"
run sh -c "journalctl -u ssh -u sshd --since '-7 days' --no-pager 2>/dev/null | grep -Ei 'accepted|failed' | tail -20"
command -v fail2ban-client >/dev/null && run fail2ban-client status || echo "fail2ban: not installed"

sec "firewall and listening sockets"
run ufw status verbose
run ss -tulpn
run sh -c "nft list ruleset 2>/dev/null | head -60"

sec "updates"
run sh -c "apt list --upgradable 2>/dev/null | head -40"
run cat /etc/apt/apt.conf.d/20auto-upgrades
run sh -c "tail -20 /var/log/unattended-upgrades/unattended-upgrades.log 2>/dev/null"
run sh -c "[ -f /var/run/reboot-required ] && cat /var/run/reboot-required || echo 'no reboot required'"

sec "services and processes"
run systemctl status "$SERVICE" --no-pager
run systemctl show "$SERVICE" -p ExecStart -p User -p WorkingDirectory -p Restart -p NRestarts -p ActiveEnterTimestamp -p ProtectSystem -p ReadWritePaths -p NoNewPrivileges
run sh -c "systemctl cat $SERVICE | diff - $APP/deploy/deepstack-agent.service && echo 'unit matches repo copy'"
run systemctl list-units --type=service --state=running --no-pager
run sh -c "ps -eo user,pid,etime,cmd --sort=user | grep -v '\[' | head -60"
run sh -c "crontab -l 2>/dev/null; ls -l /etc/cron.d; systemctl list-timers --no-pager | head -20"

sec "app: code, deployed commit, secret file modes"
run cat "$APP/.deployed-commit"
run sh -c "git -C /opt/deepstack-src log -1 --format='%H %ci %s' 2>/dev/null"
run sh -c "git -C /opt/deepstack-src status --short 2>/dev/null | head"
run node -v
run sh -c "ls -la $APP | head -40"
run sh -c "ls -la $APP/.env* 2>/dev/null; stat -c '%n %a %U:%G' $APP/.env* 2>/dev/null"
run sh -c "ls -la $APP/journal | head -40; du -sh $APP/journal"
run sh -c "[ -f $APP/KILL ] && echo 'KILL: ENGAGED' || echo 'KILL: off'"

sec "configuration: variable NAMES set in .env (values never shown)"
if [ -f "$APP/.env" ]; then
  names() { grep -E '^[A-Z0-9_]+=' "$1" | cut -d= -f1 | sort -u; }
  setnames() { grep -E '^[A-Z0-9_]+=.+' "$1" | cut -d= -f1 | sort -u; }
  echo "set in .env:"; setnames "$APP/.env" | sed 's/^/  /'
  echo "set in .env but not documented in .env.example:"; comm -23 <(setnames "$APP/.env") <(names "$APP/.env.example") | sed 's/^/  /'
  echo "does .env hold a seed phrase (12+ words) rather than a single hex key?"
  awk -F= '/^STACKS_PRIVATE_KEY=/{ n=split($2,w," "); print (n>=12 ? "  YES: seed phrase present (narrow-key not run)" : "  no: single key") }' "$APP/.env"
fi

sec "disk, memory, logs, backups"
run df -h /
run free -m
run sh -c "journalctl --disk-usage; grep -Ei '^(SystemMaxUse|MaxRetentionSec|Storage)' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/* 2>/dev/null"
run sh -c "ls -la /var/backups 2>/dev/null | head"
echo "provider snapshots / backups: check the hosting console (not visible from the host)"

sec "done"
echo "review complete; nothing was changed"
