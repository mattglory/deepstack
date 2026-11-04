#!/usr/bin/env bash
# Give a second person a way to halt trading that does not depend on the operator (assessment
# 2026-11, DSA-04 / roadmap A5). Run as root on the VPS, once per halt key:
#
#   bash deploy/install-halt-access.sh /path/to/halt-key.pub
#
# Creates a locked system user `deepstack-halt` whose only authorized key is restricted to a
# forced command (no shell, no forwarding, no pty), plus a sudoers rule letting that user run
# exactly /usr/local/sbin/deepstack-halt as root. See deploy/halt.sh for what it can do (halt,
# status) and cannot (resume, stop, shell). Safe to re-run: it replaces the key list with the
# keys given on each run.

set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
[ "$#" -ge 1 ] || { echo "usage: $0 <halt-key.pub> [more keys...]"; exit 1; }

USER_NAME=deepstack-halt
BIN=/usr/local/sbin/deepstack-halt
SRC="$(cd "$(dirname "$0")" && pwd)/halt.sh"

for k in "$@"; do
  ssh-keygen -l -f "$k" >/dev/null || { echo "not a public key: $k"; exit 1; }
done

id "$USER_NAME" >/dev/null 2>&1 || adduser --system --group --shell /bin/sh --home "/var/lib/$USER_NAME" "$USER_NAME"
passwd -l "$USER_NAME" >/dev/null

install -m 0755 -o root -g root "$SRC" "$BIN"

HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR/.ssh"
AK="$HOME_DIR/.ssh/authorized_keys"
: > "$AK.tmp"
for k in "$@"; do
  # sudo keeps SSH_ORIGINAL_COMMAND only if passed explicitly; the wrapper hands it over as $1.
  printf 'restrict,command="sudo -n %s \\"$SSH_ORIGINAL_COMMAND\\"" %s\n' "$BIN" "$(cat "$k")" >> "$AK.tmp"
done
chown root:"$USER_NAME" "$AK.tmp" && chmod 0640 "$AK.tmp" && mv "$AK.tmp" "$AK"

SUDOERS=/etc/sudoers.d/deepstack-halt
printf '%s ALL=(root) NOPASSWD: %s halt, %s status\n' "$USER_NAME" "$BIN" "$BIN" > "$SUDOERS.tmp"
chmod 0440 "$SUDOERS.tmp"
visudo -cf "$SUDOERS.tmp" >/dev/null && mv "$SUDOERS.tmp" "$SUDOERS"

echo "installed. key fingerprints allowed to halt:"
for k in "$@"; do ssh-keygen -l -f "$k"; done
cat <<EOF

Verify from the halt key holder's machine (not this box):
  ssh $USER_NAME@<vps> status      # works
  ssh $USER_NAME@<vps> whoami      # refused
  ssh -t $USER_NAME@<vps>          # no shell
Drill (agreed time, operator present): ssh $USER_NAME@<vps> halt, confirm the next agent
cycle logs the halt and makes no broadcast, then the operator resumes with watch.sh resume.
EOF
