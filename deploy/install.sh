#!/usr/bin/env bash
# DeepStack VPS: install, update or roll back the agent. Run as root AFTER provision.sh.
#
#   bash install.sh <commit-sha> [--restart]   deploy exactly this reviewed commit
#   bash install.sh --rollback [--restart]     re-activate the previous release
#   bash install.sh --status                   show current / previous release
#
# Hardened 2026-11 (assessment DSA-03 / DSA-23, roadmap B1). What changed and why:
# - Deploys a PINNED commit, never "whatever main is now". The commit must be on origin/main
#   (so it went through review and branch protection) and its CI checks must have passed.
# - Builds as an unprivileged user (deepstack-build) in its own release directory, with
#   `npm ci --ignore-scripts`: the lockfile is enforced and no package install script runs as
#   root, or with access to .env (the build user cannot read it).
# - Runs no tests on this host: CI is the test gate. Nothing executes next to .env except the
#   agent itself.
# - Code is owned by root and only readable by the service user, so the agent cannot rewrite
#   its own code. Only journal/ and dashboard/ stay writable by it.
# - Keeps the previous release for --rollback, creates journal/ up front, and restarts only when
#   asked (so an update never silently leaves old code running: the script says what is live).
# - Appends every deploy and rollback to /var/log/deepstack-deploys.log.
# It never creates or reads .env, and never touches journal/, KILL or dashboard/metrics.json.
#
# Emergency only: DEEPSTACK_SKIP_CI_CHECK="<reason>" deploys without the CI check; the reason is
# logged (docs/CHANGE_MANAGEMENT.md section 4).

set -euo pipefail

REPO="${DEEPSTACK_REPO:-https://github.com/mattglory/deepstack.git}"
GH_API_REPO="${DEEPSTACK_GH_REPO:-mattglory/deepstack}"
APP="${DEEPSTACK_APP:-/opt/deepstack}"
SRC="${DEEPSTACK_SRC:-/opt/deepstack-src}"
RELEASES="${DEEPSTACK_RELEASES:-/opt/deepstack-releases}"
SVC_USER=deepstack
BUILD_USER=deepstack-build
UNIT=deepstack-agent
LOG="${DEEPSTACK_DEPLOY_LOG:-/var/log/deepstack-deploys.log}"
KEEP=5
# The same contexts branch protection requires (ACCESS-AND-DECISIONS §4), from GitHub Actions only.
REQUIRED_CHECKS=(test contract-test "Dependency audit" CodeQL "Secret scan")
# Entries in $APP that are runtime state or secrets: never replaced or removed by a deploy.
PRESERVE_RE='^(\.env.*|journal|KILL|dashboard|\.deployed-commit|\.release-.*)$'

die() { echo "install.sh: $*" >&2; exit 1; }
say() { echo "== $*"; }
have_systemd() { [ -z "${DEEPSTACK_NO_SYSTEMD:-}" ] && command -v systemctl >/dev/null; }
log_deploy() { printf '%s | %s | by %s | %s\n' "$(date -u +%FT%TZ)" "$1" "${SUDO_USER:-root}" "$2" >> "$LOG"; }

[ "$(id -u)" -eq 0 ] || die "run as root"
id "$SVC_USER" >/dev/null 2>&1 || die "run provision.sh first (no $SVC_USER user)"
id "$BUILD_USER" >/dev/null 2>&1 || adduser --system --group --home "/var/lib/$BUILD_USER" "$BUILD_USER" >/dev/null

MODE=deploy SHA="" RESTART=0
for a in "$@"; do
  case "$a" in
    --restart) RESTART=1 ;;
    --rollback) MODE=rollback ;;
    --status) MODE=status ;;
    [0-9a-f]*) [[ "$a" =~ ^[0-9a-f]{40}$ ]] || die "give the full 40-character commit sha, not '$a'"; SHA="$a" ;;
    *) die "unknown argument '$a'" ;;
  esac
done

current() { cat "$APP/.release-current" 2>/dev/null || true; }
previous() { cat "$APP/.release-previous" 2>/dev/null || true; }

if [ "$MODE" = status ]; then
  echo "current:  $(current)"; echo "previous: $(previous)"
  echo "kill switch: $([ -f "$APP/KILL" ] && echo ENGAGED || echo off)"
  have_systemd && echo "service: $(systemctl is-active $UNIT 2>/dev/null || true)"
  exit 0
fi

# --- verify the commit: on origin/main, CI green ----------------------------------------------
verify_commit() {
  local sha="$1"
  say "fetch $REPO"
  if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q --prune origin; else git clone -q "$REPO" "$SRC"; fi
  git -C "$SRC" cat-file -e "$sha^{commit}" 2>/dev/null || die "commit $sha not found in $REPO"
  git -C "$SRC" merge-base --is-ancestor "$sha" origin/main || die "commit $sha is not on origin/main (unreviewed); refusing"
  say "commit $sha is on origin/main: $(git -C "$SRC" log -1 --format='%ci %s' "$sha")"
  if [ -n "${DEEPSTACK_SKIP_CI_CHECK:-}" ]; then
    echo "WARNING: CI check skipped: ${DEEPSTACK_SKIP_CI_CHECK}"
    CI_RESULT="CI-SKIPPED (${DEEPSTACK_SKIP_CI_CHECK})"
    return
  fi
  local json
  json="$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$GH_API_REPO/commits/$sha/check-runs?per_page=100")" || die "could not read CI status for $sha"
  CI_RESULT="$(printf '%s' "$json" | node -e '
    const req = process.argv.slice(1); let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      // Only GitHub Actions runs count (another app with checks:write could post the same name),
      // and only the LATEST run of each name: a later failed re-run is not outvoted by an old pass.
      const runs = (JSON.parse(s).check_runs ?? []).filter(r => r.app && r.app.slug === "github-actions");
      const latest = n => runs.filter(r => r.name === n).sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))[0];
      const bad = req.filter(n => latest(n)?.conclusion !== "success");
      if (bad.length) { console.log("FAIL:" + bad.join(",")); process.exit(0); }
      console.log("CI-OK (" + req.join(", ") + ")");
    });' "${REQUIRED_CHECKS[@]}")"
  [[ "$CI_RESULT" == CI-OK* ]] || die "CI has not passed for $sha (${CI_RESULT#FAIL:} not successful); refusing"
  say "$CI_RESULT"
}

# --- build a release as the unprivileged build user -------------------------------------------
build_release() {
  local sha="$1" rel="$RELEASES/$1"
  mkdir -p "$RELEASES"; chmod 0755 "$RELEASES"
  if [ -f "$rel/.release-complete" ]; then say "release $sha already built"; return; fi
  rm -rf "$rel"; install -d -o "$BUILD_USER" -g "$BUILD_USER" "$rel"
  say "build $sha as $BUILD_USER (npm ci --ignore-scripts; no tests here, CI is the gate)"
  git -C "$SRC" archive "$sha" | runuser -u "$BUILD_USER" -- tar -x -C "$rel"
  runuser -u "$BUILD_USER" -- env -i HOME="/var/lib/$BUILD_USER" PATH="$PATH" \
    sh -c "cd '$rel' && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error"
  # Smoke check that the runtime toolchain works without executing the agent: import a pure module.
  runuser -u "$BUILD_USER" -- env -i HOME="/var/lib/$BUILD_USER" PATH="$PATH" \
    sh -c "cd '$rel' && node --import tsx --input-type=module -e 'await import(\"./src/m1/agent.ts\")'" \
    || die "built release cannot load TypeScript (tsx/esbuild); not activating"
  echo "$sha" | cut -c1-7 > "$rel/.deployed-commit"
  # Freeze: root-owned, readable by the service user, writable by nobody else.
  chown -R root:"$SVC_USER" "$rel"; chmod -R u=rwX,g=rX,o= "$rel"
  touch "$rel/.release-complete"
}

# --- activate a release into $APP without touching state --------------------------------------
entries() { (cd "$1" && ls -A | grep -vE "$PRESERVE_RE|^\.release-complete$" || true); }

activate() {
  local sha="$1" rel="$RELEASES/$1"
  [ -f "$rel/.release-complete" ] || die "release $sha is not built"
  install -d -m 0750 -o root -g "$SVC_USER" "$APP"
  # The agent owns these two; a symlink planted there would make root chown or write elsewhere.
  for d in "$APP/journal" "$APP/dashboard"; do [ -L "$d" ] && die "$d is a symlink; refusing (inspect it)"; done
  install -d -o "$SVC_USER" -g "$SVC_USER" "$APP/journal" "$APP/dashboard"
  # Remove top-level entries the previous release had and this one does not.
  if [ -f "$APP/.release-manifest" ]; then
    comm -23 <(sort "$APP/.release-manifest") <(entries "$rel" | sort) | while read -r e; do
      [[ "$e" =~ $PRESERVE_RE ]] || { [ -n "$e" ] && rm -rf "${APP:?}/$e"; }
    done
  fi
  for e in $(entries "$rel"); do rm -rf "${APP:?}/$e"; cp -a "$rel/$e" "$APP/$e"; done
  # dashboard/ mixes code with the agent's state (metrics.json): replace code files only.
  if [ -d "$rel/dashboard" ]; then
    for f in "$rel"/dashboard/* "$rel"/dashboard/.[!.]*; do
      [ -f "$f" ] && [ ! -L "$f" ] || continue
      case "$(basename "$f")" in metrics.json*) continue ;; esac
      # The agent owns dashboard/, so it could plant a symlink where a code file goes, and cp
      # writes THROUGH a destination symlink (as root). Stage in root-owned $APP and rename:
      # rename(2) replaces whatever is at the destination and never follows it.
      stage="$(mktemp "$APP/.dashboard-stage.XXXXXX")"
      cp -a "$f" "$stage"
      mv -fT "$stage" "$APP/dashboard/$(basename "$f")"
    done
    chown "$SVC_USER":"$SVC_USER" "$APP/dashboard"
  fi
  cp -a "$rel/.deployed-commit" "$APP/.deployed-commit"
  entries "$rel" > "$APP/.release-manifest"
  local cur; cur="$(current)"
  [ -n "$cur" ] && [ "$cur" != "$sha" ] && echo "$cur" > "$APP/.release-previous"
  echo "$sha" > "$APP/.release-current"
  if have_systemd; then
    cp "$rel/deploy/deepstack-agent.service" /etc/systemd/system/ && systemctl daemon-reload
  fi
}

prune() {
  local keep=("$(current)" "$(previous)")
  ls -1t "$RELEASES" 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r d; do
    [[ " ${keep[*]} " == *" $d "* ]] || rm -rf "${RELEASES:?}/$d"
  done
}

restart_or_remind() {
  if [ "$RESTART" -eq 1 ] && have_systemd; then
    say "restart $UNIT"; systemctl restart "$UNIT"; sleep 5
    echo "service: $(systemctl is-active $UNIT || true)"
    journalctl -u "$UNIT" -n 15 --no-pager || true
  else
    echo "NOT restarted: the running agent still uses the code it started with."
    echo "Restart when ready: systemctl restart $UNIT  (then watch: journalctl -u $UNIT -f)"
  fi
}

CI_RESULT=""
if [ "$MODE" = rollback ]; then
  prev="$(previous)"; [ -n "$prev" ] || die "no previous release recorded"
  say "roll back $(current) -> $prev"
  cur="$(current)"; activate "$prev"; echo "$cur" > "$APP/.release-previous"
  log_deploy "$prev" "ROLLBACK from $cur"
  restart_or_remind
  exit 0
fi

[ -n "$SHA" ] || die "usage: install.sh <commit-sha> [--restart] | --rollback [--restart] | --status"
verify_commit "$SHA"
build_release "$SHA"
say "activate $SHA (previous: $(current || true))"
activate "$SHA"
log_deploy "$SHA" "$CI_RESULT"
prune
restart_or_remind
[ -f "$APP/.env" ] || echo "NOTE: $APP/.env is missing: copy it over scp, then chown $SVC_USER:$SVC_USER and chmod 600 (PILOT_DEPLOY.md)."
