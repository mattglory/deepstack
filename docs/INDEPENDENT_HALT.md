# Independent halt

**Purpose:** a second person can stop trading without the operator and without root (assessment 2026-11, DSA-04 / roadmap A5).

## What it is

- A locked system user `deepstack-halt`. Its SSH key(s) are restricted (`restrict`: no shell, pty or forwarding) to one forced command, `/usr/local/sbin/deepstack-halt`, run through a sudoers rule that allows exactly two arguments.
- **`halt`** engages the existing kill switch (`/opt/deepstack/KILL`). The agent's own checks then refuse to trade:
  - the safety gate at the start of every cycle;
  - the DLMM and flash executors;
  - the operator CLIs that require KILL.

  The process keeps running, so state files, the journal and telemetry carry on.
- **`status`** shows the kill switch, the service state and the last five agent log lines.
- **Not offered:** resume, stop, restart, shell. Resuming trading stays an operator decision. Clearing KILL is `deploy/watch.sh resume` by the operator.

## Why not kill the process

A DLMM recenter is a sequence of transactions: withdraw, up to six swaps, then re-add. Killing the process between them leaves capital out of the pool. The agent already persists a pending re-add and resumes it safely. Engaging KILL lets it stop at a step boundary with that state written.

**How fast it takes effect:**
- Today the agent checks KILL at the start of each 30-minute cycle, and the DLMM and flash executors check it before they start.
- A change under review (C8) re-checks KILL before **every** broadcast inside a multi-step sequence, so a halt also lands between steps of a recenter already in progress.

## Install (operator, as root on the VPS)

```
bash /opt/deepstack/deploy/install-halt-access.sh /path/to/halt-key.pub
```

The halt key holder generates their own key (ideally hardware-backed, e.g. `ssh-keygen -t ed25519-sk`) and sends only the `.pub`. **Confirm its fingerprint out of band.**

## Verify and drill

From the halt key holder's machine:

| Command | Expected |
|---|---|
| `ssh deepstack-halt@<vps> status` | Shows status |
| `ssh deepstack-halt@<vps> whoami` | Refused (exit 2) |
| `ssh -t deepstack-halt@<vps>` | No shell |

**Drill** (agreed time, operator present):
1. `ssh deepstack-halt@<vps> halt`.
2. Confirm that the next agent cycle logs the safety halt and makes no broadcast.
3. The operator resumes.
4. Record the times in the verification log.

## Audit trail

- `logger -t deepstack-halt` records each halt, status or refused call in the system log.
- sshd's own log records the connecting key's fingerprint and source address.
- Optionally ship both off the host (roadmap D3).

## Limits

- It needs the VPS reachable over SSH. If SSH is down but the agent still has outbound access, the fallback is the hosting provider's console. Who holds that access is recorded in the access register.
- Anyone holding a halt key can stop trading. That is a denial-of-service only, never fund movement, which is the intended trade-off.
