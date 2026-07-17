#!/usr/bin/env bash
# DeepStack pilot VPS — one-time provisioning. Run as root on a FRESH Debian/Ubuntu box:
#
#   curl -fsSL https://raw.githubusercontent.com/mattglory/deepstack/main/deploy/provision.sh | bash
#   (or: scp this file up and `bash provision.sh`)
#
# Does runbook §2 (docs/PILOT_DEPLOY.md): service user, Node LTS, ssh hardening,
# firewall, unattended security updates. It does NOT install the agent (install.sh)
# and never touches secrets. Safe to re-run.
#
# ⚠ SSH hardening disables password login. Make sure your SSH KEY works BEFORE running
#   this, or you will lock yourself out: `ssh -o PasswordAuthentication=no root@<vps>`

set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }

echo "== service user =="
id deepstack >/dev/null 2>&1 || adduser --system --group --home /opt/deepstack deepstack

echo "== node LTS + git =="
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
apt-get install -y git
node -v

echo "== ssh hardening (key-only, no root login) =="
if [ ! -s /root/.ssh/authorized_keys ] && [ -z "$(ls -A /home/*/.ssh/authorized_keys 2>/dev/null || true)" ]; then
  echo "REFUSING: no authorized_keys found anywhere — hardening now would lock you out."
  echo "Add your ssh key first, then re-run."
  exit 1
fi
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh || systemctl restart sshd

echo "== firewall: ssh only, nothing else inbound =="
apt-get install -y ufw
ufw allow OpenSSH
ufw --force enable

echo "== unattended security updates =="
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades

echo
echo "Provisioned. Next: bash install.sh   (see deploy/install.sh)"
