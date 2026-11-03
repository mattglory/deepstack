#!/usr/bin/env bash
# DeepStack independent halt: the ONLY thing the dedicated halt SSH key can run (assessment
# 2026-11, DSA-04 / roadmap A5). Installed by deploy/install-halt-access.sh as
# /usr/local/sbin/deepstack-halt and reached through a forced command, so the key gets no shell.
#
#   ssh deepstack-halt@<vps> halt     engage the kill switch (trading stops; the process, its
#                                     state files and telemetry keep running)
#   ssh deepstack-halt@<vps> status   kill switch, service state, last agent log lines
#
# Deliberately NOT offered: resume, stop, restart, shell. Resuming trading stays an operator
# decision. The process is not killed: a recenter in flight stops at its next KILL check with its
# pending state saved, which is safer than interrupting a sequence mid-transaction.

set -euo pipefail

APP="${DEEPSTACK_APP_DIR:-/opt/deepstack}"
SERVICE="${DEEPSTACK_SERVICE:-deepstack-agent}"
KILL="$APP/KILL"
CMD="${SSH_ORIGINAL_COMMAND:-${1:-status}}"
WHO="${SUDO_USER:-${USER:-unknown}} ${SSH_CONNECTION:-local}"

log() { command -v logger >/dev/null && logger -t deepstack-halt -- "$*" || true; }

# `systemctl is-active` prints the state AND exits non-zero when not active: keep the printed state.
service_state() {
  local s=""
  command -v systemctl >/dev/null && s="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
  echo "${s:-unknown}"
}

case "$CMD" in
  halt)
    if [ -f "$KILL" ]; then
      echo "kill switch already ENGAGED"
    else
      # Created by root through sudo; the agent only needs to see it. Owned like the app dir so
      # the operator's normal `watch.sh resume` can remove it.
      install -m 0644 -o "$(stat -c %U "$APP")" -g "$(stat -c %G "$APP")" /dev/null "$KILL"
      echo "kill switch ENGAGED: trading stops at the agent's next check; telemetry continues"
    fi
    log "halt requested by $WHO; KILL present: $([ -f "$KILL" ] && echo yes || echo no)"
    echo "service: $(service_state)"
    ;;
  status)
    echo "kill switch: $([ -f "$KILL" ] && echo ENGAGED || echo off)"
    echo "service: $(service_state)"
    if command -v journalctl >/dev/null; then
      journalctl -u "$SERVICE" -n 5 --no-pager -o short-iso 2>/dev/null || true
    fi
    log "status requested by $WHO"
    ;;
  *)
    echo "refused: only 'halt' and 'status' are allowed" >&2
    log "refused command '$CMD' from $WHO"
    exit 2
    ;;
esac
