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

# Exactly one plain public key per file. ssh-keygen -l alone is not enough: it accepts files
# holding several keys (only the first would get the restriction prefix below, so the others
# would log in with a shell), lines carrying their own options, and private keys.
KEY_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh[.]com|sk-ecdsa-sha2-nistp256@openssh[.]com) [A-Za-z0-9+/]+={0,3}( [^[:cntrl:]]*)?$'
for k in "$@"; do
  lines="$(grep -cvE '^[[:space:]]*(#|$)' "$k" || true)"
  [ "$lines" = 1 ] || { echo "refusing $k: expected exactly one key line, found $lines"; exit 1; }
  grep -vE '^[[:space:]]*(#|$)' "$k" | grep -qE "$KEY_RE" || { echo "refusing $k: not a single plain public key (no options, no private key)"; exit 1; }
  [ "$(ssh-keygen -l -f "$k" 2>/dev/null | wc -l)" = 1 ] || { echo "not a public key: $k"; exit 1; }
done

id "$USER_NAME" >/dev/null 2>&1 || adduser --system --group --shell /bin/sh --home "/var/lib/$USER_NAME" "$USER_NAME"
passwd -l "$USER_NAME" >/dev/null

install -m 0755 -o root -g root "$SRC" "$BIN"

HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
# Home and .ssh are root-owned: the halt user can read its key list but not replace it, and
# root never writes into a directory that user controls (no planted symlinks to follow).
for d in "$HOME_DIR" "$HOME_DIR/.ssh"; do
  [ -L "$d" ] && { echo "refusing: $d is a symlink"; exit 1; }
  install -d -m 0750 -o root -g "$USER_NAME" "$d"
done
AK="$HOME_DIR/.ssh/authorized_keys"
AK_TMP="$(mktemp "$HOME_DIR/.ssh/.authorized_keys.XXXXXX")"
for k in "$@"; do
  # sudo keeps SSH_ORIGINAL_COMMAND only if passed explicitly; the wrapper hands it over as $1.
  printf 'restrict,command="sudo -n %s \\"$SSH_ORIGINAL_COMMAND\\"" %s\n' "$BIN" "$(grep -vE '^[[:space:]]*(#|$)' "$k")" >> "$AK_TMP"
done
chown root:"$USER_NAME" "$AK_TMP"
chmod 0640 "$AK_TMP"
mv -f "$AK_TMP" "$AK"

SUDOERS=/etc/sudoers.d/deepstack-halt
printf '%s ALL=(root) NOPASSWD: %s halt, %s status\n' "$USER_NAME" "$BIN" "$BIN" > "$SUDOERS.tmp"
chmod 0440 "$SUDOERS.tmp"
visudo -cf "$SUDOERS.tmp" >/dev/null || { rm -f "$SUDOERS.tmp"; echo "sudoers rule failed validation; NOT installed"; exit 1; }
mv "$SUDOERS.tmp" "$SUDOERS"

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
