// Independent, READ-ONLY wallet watcher for the agent's hot wallet. Meant to run OFF the VPS
// (laptop, second host, scheduled CI) so a compromised VPS cannot silence it. It never signs,
// never broadcasts, never loads a key: only GETs to the public Hiro API, plus POSTs to the
// alert webhooks you configure. See docs/WALLET_WATCHER.md.
//
//   npm run watch:wallet -- --once                    # one poll (cron / CI)
//   npm run watch:wallet -- --interval 300            # poll every 5 min, forever
//   npm run watch:wallet -- --test-alert              # verify alert delivery
//   npm run watch:wallet -- --once --network testnet --addresses ST2…
//
// Exit codes for --once: 0 healthy, 1 watcher unhealthy (sources/delivery failing),
// 2 a new CRITICAL alert was raised (so a CI job turns red too).

import { loadConfig, runPoll, sendTestAlert } from "./run.js";
import { redactUrl } from "./notify.js";

const FLAG_ENV: Record<string, string> = {
  "--network": "WATCH_NETWORK",
  "--addresses": "WATCH_ADDRESSES",
  "--state": "WATCH_STATE_PATH",
  "--api": "WATCH_API",
};

function parseArgs(argv: string[]) {
  const env: Record<string, string | undefined> = { ...process.env };
  let once = false;
  let testAlert = false;
  let interval = 300;
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const value = () => inline ?? argv[++i];
    if (flag === "--once") once = true;
    else if (flag === "--test-alert") testAlert = true;
    else if (flag === "--interval") interval = Number(value());
    else if (FLAG_ENV[flag]) env[FLAG_ENV[flag]] = value();
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!Number.isFinite(interval) || interval < 30) throw new Error("--interval must be >= 30 seconds");
  return { env, once, testAlert, interval };
}

async function main() {
  const { env, once, testAlert, interval } = parseArgs(process.argv.slice(2));
  const c = loadConfig(env);
  const ch = c.channels;
  console.log(`DeepStack wallet watcher — READ-ONLY, ${c.network}`);
  console.log(`  addresses: ${c.addresses.join(", ")}`);
  console.log(`  sources:   ${c.endpoints.join(" → ")} (timeout ${c.timeoutMs}ms)`);
  console.log(`  channels:  slack=${ch.slack ? redactUrl(ch.slack) : "-"} webhook=${ch.webhook ? redactUrl(ch.webhook) : "-"} heartbeat=${ch.heartbeat ? redactUrl(ch.heartbeat) : "-"}${!ch.slack && !ch.webhook ? "  (DRY-RUN: alerts print to stdout)" : ""}`);
  console.log(`  owners:    ${c.owners.length ? c.owners.join(", ") : "(none — every outgoing transfer to a standard address is CRITICAL)"}`);

  if (testAlert) {
    process.exit((await sendTestAlert(c)) ? 0 : 1);
  }

  for (;;) {
    const started = new Date().toISOString();
    const out = await runPoll(c);
    const counts = { CRITICAL: 0, HIGH: 0, INFO: 0 };
    for (const a of out.alerts) counts[a.severity]++;
    console.log(`${started} poll ${out.healthy ? "ok" : "UNHEALTHY"} — new alerts: CRITICAL ${counts.CRITICAL}, HIGH ${counts.HIGH}, INFO ${counts.INFO}${out.notified ? (out.dryRun ? " (dry-run printed)" : " (notified)") : ""}`);
    if (once) process.exit(counts.CRITICAL ? 2 : out.healthy ? 0 : 1);
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

main().catch((err) => {
  console.error(`watcher error: ${(err as Error).message}`);
  process.exit(1);
});
