# Pilot deployment — running the agent for 30 days

The M2 pilot needs the agent running continuously on mainnet at ≥95% uptime. That budget
allows roughly **36 hours of downtime across 30 days**, so the goal here is boring: a
process that restarts itself, tells you when it's unhappy, and holds its evidence safely.

This box will hold a **seed phrase for a funded mainnet wallet**. Treat it as a hot wallet
host, not a dev box.

---

## 1. Before anything: the wallet

The agent signs with a key in `.env`. Anyone with root on this machine can take the funds.

- **Use a dedicated wallet holding only pilot inventory.** Never the wallet grant funds
  are paid to, and never a personal wallet. The balance moves with pilot capital — check
  the dashboard or the wallet address directly for the live figure, not a number pinned
  here.
- The seed derives **every account**. A raw hex key for account 0 (`STACKS_PRIVATE_KEY`)
  limits exposure to that one account; a seed phrase does not.
- Do not reuse this box for anything else.

### Key rotation (external review, 2026-09)

This is a single hot key on an internet-facing host, controlling real funds — a host
compromise exposes this one account, not an HD tree (see the point above), but it's
still worth a plan rather than assuming it'll never need to move.

- **Routine:** no fixed rotation schedule during the pilot — the cost of rotating
  (deriving a new wallet, unwinding and rebuilding every LP/DLMM position, re-pointing
  the agent) outweighs the benefit for a key already scoped to pilot inventory only.
  Revisit if this moves from a fixed-term pilot to a standing deployment.
- **Triggered:** rotate immediately on any suspected VPS compromise, any operator
  access change you can't fully account for, or any sign the key material left this box.
- **Procedure** (`npm run m1:rotate-key`, run on the VPS in `/opt/deepstack`; the new key is
  generated there and never displayed or copied anywhere else):
  1. `touch KILL` and `systemctl stop deepstack-agent`. Stopped, not only paused: a paused
     agent still records a sample every cycle, and one taken mid-move would chart the
     transfers as a loss.
  2. Withdraw the concentrated position, saving it as a pending re-add:
     `DLMM_PAIR=sbtc-usdcx npm run m1:dlmm-recenter -- withdraw --readd-later --yes-mainnet`.
  3. `npm run m1:rotate-key -- new` writes the new key to `.env.rotation` (owner-only) and
     prints only its address. `-- plan` shows what will move and anything that blocks it.
  4. `-- move --yes-mainnet` (type the new address's last 6 characters): the XYK LP token,
     sBTC and USDCx are each sent with a deny-mode, exact-amount post-condition and confirmed
     before the next; STX goes last. The XYK position moves as a token, so it is never unwound.
     Anything not on the list (address-poisoning dust) is left behind. Safe to re-run after an
     interruption: it moves whatever is left.
  5. `-- switch --yes-mainnet` checks the old wallet is drained, puts the new key in `.env`
     (old copy kept as `.env.pre-rotation`), records the migration in
     `journal/wallet-migrations.json` and removes `.env.rotation`. The metrics and dashboard
     then continue the same history on the new address.
  6. Re-add the concentrated position from the new wallet, at the width in `DLMM_PIN_HALF_WIDTH`:
     `DLMM_PAIR=sbtc-usdcx npm run m1:dlmm-recenter -- force-recenter --yes-mainnet` resumes the
     pending re-add (rebalancing swaps first if the two sides no longer match, as in any
     recenter). Then `systemctl start deepstack-agent` and `rm KILL`. After its first healthy report,
     `npm run m1:rotate-key -- --remove-backup`.
  7. Update the address in the README and dashboard, and anywhere the wallet is registered
     (for example a liquidity campaign).
- **Rehearsed on testnet (2026-10-30)** with `--testnet` (STACKS_NETWORK=testnet in `.env`),
  using a fresh funded test wallet and the vault v2 test share token in place of sBTC/USDCx:
  `move` refused without KILL and on a wrong confirmation; with both, it moved 5 dsSTX2
  (`0xaac5bb09…`) then 9.8 STX (`0x7c4695ff…`), each confirmed. `switch` put the new key in
  `.env` (owner-only), recorded the migration with both txids and removed `.env.rotation`; the
  next recorded sample, signed by the new key, continued the same history (3 samples, same
  start). `--remove-backup` then removed `.env.pre-rotation`.

## 2. Provision

Any small VPS is enough — the agent is one Node process doing a handful of API calls every
30 minutes. Hetzner CX22 (~€4/mo) or DigitalOcean's $6 droplet are both ample. Grant funds
cover hosting.

Scripted (recommended — this is exactly runbook-§2 as code, refuses to harden ssh if it
would lock you out):

```bash
# as root, on a fresh Debian/Ubuntu box — AFTER confirming your ssh KEY logs in
curl -fsSL https://raw.githubusercontent.com/mattglory/deepstack/main/deploy/provision.sh | bash
```

It creates the `deepstack` service user, installs Node 22 LTS + git, switches ssh to
key-only, enables the ssh-only firewall, and turns on unattended security updates.
Read `deploy/provision.sh` before piping to bash — it's 50 lines on purpose.

## 3. Install

```bash
curl -fsSL https://raw.githubusercontent.com/mattglory/deepstack/main/deploy/install.sh | bash
```

`deploy/install.sh` clones/updates the repo into `/opt/deepstack`, installs deps, runs the
full test suite + typecheck (a red suite aborts the install), and installs — but does NOT
enable — the systemd unit. Re-running it later is the update path: it never touches
`.env`, `journal/`, or the telemetry file.

**`journal/` won't exist yet.** It's gitignored — local runtime evidence, not something a
clone ships with. The agent creates it itself on its first tick (`mkdirSync` in
`journal.ts`), so any command below that reads `journal/...` (verification, `grep`, `tail`)
only works after the agent has actually run at least once. This is expected, not a broken
step — see §6 for the order these actually happen in.

## 4. Secrets

**Never commit `.env`, never paste the key into a chat, never `curl` it anywhere.** Copy it
over ssh and lock it down:

```bash
scp .env root@<vps>:/opt/deepstack/.env      # from your laptop
ssh root@<vps> 'chown deepstack:deepstack /opt/deepstack/.env && chmod 600 /opt/deepstack/.env'
```

Required for the pilot:

```ini
STACKS_NETWORK=mainnet          # without this it runs testnet and the pilot does nothing
PAIR=sbtc-stx
STACKS_PRIVATE_KEY=...          # dedicated pilot wallet
OPENROUTER_API_KEY=...          # AI tuning layer (M1 evidence: keep it active)
HEALTHCHECK_URL=https://hc-ping.com/<uuid>
METRICS_GIST_ID=...             # telemetry mirror — see step 5b
METRICS_GIST_TOKEN=ghp_...      # classic PAT, `gist` scope ONLY (see step 5b)
```

Recommended: a second RPC provider, so a Hiro outage degrades to a warning instead of
eating the uptime budget. The fallback must serve the **full Stacks Blockchain API**
(`/extended/v1/…`), not just node RPC — which in practice means **QuickNode** (official
Stacks integration, free tier is ample for the agent's ~50 requests/hour; create a Stacks
mainnet endpoint and use its URL, auth token included in the path) or a self-hosted
`stacks-blockchain-api`:

```ini
STACKS_API_FALLBACKS=https://<name>.stacks-mainnet.quiknode.pro/<token>   # comma-separated, tried in order
```

> **The `.env` trap.** `loadDotenv()` in `src/m1/wallet.ts` reads `.env` **relative to the
> working directory**. If systemd's `WorkingDirectory` is wrong, the agent does not error —
> it starts on testnet defaults with no key and quietly does nothing for days. Verify with
> step 6 before walking away.

## 5. The dead-man's switch

The `/fail` ping added in `journal.ts` only helps if a check exists.

1. Create a check at [healthchecks.io](https://healthchecks.io) (free tier is fine).
2. **Period: 30 minutes** — must match `--interval`.
3. **Grace: 15 minutes** — a slow cycle (a rebalance waits for confirmation) must not alert.
4. Add an email/Telegram integration. An alert nobody receives is not an alert.
5. Paste the ping URL into `.env` as `HEALTHCHECK_URL`.

Behaviour: a good cycle pings success; a failed cycle pings `/fail` and alerts immediately;
a dead process pings nothing and alerts after the grace period.

## 5b. Telemetry mirror — so the public dashboard stays live

The agent writes `dashboard/metrics.json` on the VPS, but the Vercel dashboard serves
whatever was deployed last. Without a mirror, the uptime and heartbeat panels — the panels
that evidence the pilot — freeze for 30 days. The agent therefore pushes `metrics.json` to
a GitHub gist after every cycle (`src/m1/publish.ts`), and the dashboard renders whichever
copy is fresher.

Why a gist and not `vercel deploy` from the box: this VPS holds a funded wallet key. A
Vercel token can redeploy every project on the account; a classic PAT with only the `gist`
scope can edit gists and nothing else. Smallest credential that does the job.

1. Create a **secret gist** at [gist.github.com](https://gist.github.com) with one file
   named exactly `metrics.json` (content: `{}`). Note the gist id from its URL.
2. Create a **classic** token at github.com/settings/tokens — fine-grained PATs do not
   cover gists — ticking **only** the `gist` scope. No expiry longer than the pilot needs.
3. Put both in `.env` as `METRICS_GIST_ID` / `METRICS_GIST_TOKEN`.
4. In `dashboard/index.html`, set `CFG.metricsMirror` to the gist's **raw** URL *without*
   a commit sha, so it always serves the latest revision:
   `https://gist.githubusercontent.com/<user>/<gist-id>/raw/metrics.json`
5. Redeploy the dashboard once. From then on it needs no deploys for the whole pilot.

Verify end-to-end: run one agent cycle on the VPS, then check the gist shows a fresh
`updated` timestamp and the dashboard's "last heartbeat" tile says **live**. The raw URL
is CDN-cached for ~5 minutes — irrelevant at a 30-minute cadence.

A failed push logs a warning and never interrupts trading; if the mirror breaks, the
dashboard falls back to the deployed copy and its "stale" badge is the tell.

## 6. Start it — and verify before walking away

```bash
sudo cp deploy/deepstack-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now deepstack-agent
journalctl -u deepstack-agent -f
```

The first cycle must show **all** of these. Anything missing means stop and fix:

- `network: mainnet` and the **expected wallet address** — if it says testnet, `.env` is
  not being read (see the trap above)
- `[AI] regime=...` — the tuning layer is live
- `[vol] realised x.xx%/day → band=...bps (measured, in force)` — volatility-scaled band
- `safety: ... divergence ...% | pool active` — the oracle gate
- a decision line (`rebalance: HOLD` is a perfectly good first result)

Then confirm the plumbing:

```bash
systemctl is-enabled deepstack-agent     # "enabled" — survives reboot
sudo reboot                              # actually test it, don't assume
tail -1 journal/$(date -u +%F).jsonl     # a tick was journalled
```
And check the healthchecks.io dashboard went green.

## 7. Running it

```bash
journalctl -u deepstack-agent -f                          # live logs
journalctl -u deepstack-agent --since "1 hour ago"
grep '"type":"cycle-error"' journal/$(date -u +%F).jsonl   # transient failures
npm run m1:lvr                                             # what LPing is costing
sudo systemctl restart deepstack-agent                     # after an .env change
```

**Kill switch.** Stops trading without stopping the process or losing telemetry:

```bash
touch /opt/deepstack/KILL     # halts trading at the next cycle
rm /opt/deepstack/KILL        # resumes
```

---

## Open issues to settle before 1 September

**~~Telemetry does not reach the public dashboard.~~ Resolved** — gist mirror, see §5b.
Remaining setup is operational: create the gist + token, set `CFG.metricsMirror`, redeploy
the dashboard once.

**≥25 transactions may not happen by themselves.** M2 requires ≥25 mainnet txs. With a
6-sigma volatility-scaled band, a rebalance needs roughly a 12% move in the sBTC/STX ratio;
at ~2%/day realised vol that is not a weekly event. LP management (`TARGET_LP_FRACTION`)
adds legitimate activity, but the count should be modelled before the pilot rather than
discovered in October. **Tightening the band to manufacture trades is wash-trading — don't.**
If honest activity falls short, that is a conversation with the Endowment, and it is much
cheaper in August than in October.

**~~Sampling rate trades off against evidence.~~ Decided** — the pilot runs at the 30-minute
cadence (matches the healthcheck period; all 30 days fit the 2000-sample cap with margin).
`MAX_SAMPLES` is now env-tunable for anyone wanting finer sampling, but cadence and cap
must move together, and mid-pilot is not the time.

**~~No way to fail over to a backup RPC.~~ Resolved** — every agent read (Clarity
read-onlys, balances, tx confirmation) now routes through `src/m1/rpc.ts`, which tries
`STACKS_API` then each `STACKS_API_FALLBACKS` entry and sticks with whatever works.
Remaining setup is operational: pick a second provider and put it in `.env` (see §4).
With no fallback configured, behaviour is unchanged — one provider, one point of failure.
