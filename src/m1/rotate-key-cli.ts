// Rotate the agent's signing key: move its holdings to a freshly generated key on the server,
// then point .env at the new key. Run on the server, step by step, with the agent stopped.
//
// Why: the current key once sat on the server as a recovery phrase and was imported into a browser
// wallet (review, 2026-10-27). Narrowing it (narrow-key-cli) limited what the server holds, but the
// key itself has been in two places. A new key that has only ever existed on the server ends that.
//
// Steps (each refuses unless the one before it is complete):
//   npm run m1:rotate-key -- new                      # generate the new key into .env.rotation; prints only its address
//   npm run m1:rotate-key -- plan                     # balances of both wallets and what would move (read-only)
//   npm run m1:rotate-key -- move --yes-mainnet       # send everything, one transfer at a time, each confirmed
//   npm run m1:rotate-key -- switch --yes-mainnet     # old wallet drained → .env uses the new key; migration recorded
//   npm run m1:rotate-key -- --remove-backup          # after the agent is confirmed healthy on the new key
//
// Guards:
// - Never prints a key. The new key is written to an owner-only file and nowhere else.
// - The agent must be stopped (systemctl), not just paused: a paused agent still records a sample
//   every cycle, and a sample taken halfway through the move would show the transfers as a crash.
//   KILL must also be present, so a restart by accident cannot trade either.
// - The concentrated position must already be withdrawn. Withdraw it with --readd-later: the exact
//   amounts are saved as a pending re-add, the tokens travel with everything else, and a
//   force-recenter from the new wallet rebalances and re-adds them at the configured width.
// - Only sBTC, USDCx and the XYK LP token are moved (key-rotation.ts); anything else is listed and
//   left. Each transfer is deny-mode with an exact post-condition, and the new address's last 6
//   characters must be typed back before the first one is sent.
// - The migration is recorded (journal/wallet-migrations.json), so the dashboard and metrics keep
//   the history on the new address. The transfers are not capital flows.

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync, copyFileSync, chmodSync, statSync, chownSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  makeContractCall, makeSTXTokenTransfer, broadcastTransaction, fetchNonce, getAddressFromPrivateKey,
  randomPrivateKey, Cl, Pc, PostConditionMode,
} from "@stacks/transactions";
import { getWallet, apiBase, type Wallet } from "./wallet.js";
import { hiroHeaders } from "./rpc.js";
import { loadPending } from "./dlmm-pending-state.js";
import { addWalletMigration } from "./metrics.js";
import { publishMetrics, isPublishConfigured } from "./publish.js";
import { parseBalances, planRotation, isDrained, fmtUnits, ROTATION_FEE_USTX, type WalletBalances } from "./key-rotation.js";

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("--")) ?? "plan";
const yes = argv.includes("--yes-mainnet");
const envPath = ".env";
const rotationPath = ".env.rotation";
const backupPath = ".env.pre-rotation";
const progressPath = "journal/key-rotation-progress.json";
const SERVICE = process.env.AGENT_SERVICE ?? "deepstack-agent";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Progress { from: string; to: string; txids: string[] }

function newKey(): string | null {
  if (!existsSync(rotationPath)) return null;
  return /^NEW_STACKS_PRIVATE_KEY=([0-9a-f]{64,66})$/m.exec(readFileSync(rotationPath, "utf8"))?.[1] ?? null;
}

// Owner-only file, owned like .env (the agent runs as its own user).
function writePrivate(path: string, text: string, like = envPath): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try { const o = statSync(like); chownSync(tmp, o.uid, o.gid); } catch { /* not root, or no .env: already ours */ }
  renameSync(tmp, path);
}

function shred(path: string): void {
  if (!existsSync(path)) return;
  writeFileSync(path, "0".repeat(readFileSync(path).length));
  rmSync(path);
}

async function balances(w: { address: string; network: Wallet["network"] }): Promise<WalletBalances> {
  const base = apiBase(w.network);
  const r = await fetch(`${base}/extended/v1/address/${w.address}/balances`, { headers: hiroHeaders(base) });
  if (!r.ok) throw new Error(`balance read failed: HTTP ${r.status}`);
  return parseBalances(await r.json());
}

function agentRunning(): boolean {
  try {
    return execFileSync("systemctl", ["is-active", SERVICE], { encoding: "utf8" }).trim() === "active";
  } catch (e) {
    const out = String((e as { stdout?: string }).stdout ?? "").trim();
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; // no systemd here (local run)
    return out === "active";
  }
}

function requireStopped(): void {
  if (!existsSync("KILL")) throw new Error("refusing: pause the agent first (touch /opt/deepstack/KILL)");
  if (agentRunning()) throw new Error(`refusing: stop the agent first (systemctl stop ${SERVICE}); a paused agent still records samples`);
}

function loadProgress(): Progress | null {
  try { return existsSync(progressPath) ? (JSON.parse(readFileSync(progressPath, "utf8")) as Progress) : null; } catch { return null; }
}
function saveProgress(p: Progress): void {
  mkdirSync(dirname(progressPath), { recursive: true });
  const tmp = `${progressPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(p, null, 2));
  renameSync(tmp, progressPath);
}

async function waitTx(network: Wallet["network"], txid: string): Promise<{ status: string; t: string }> {
  const base = apiBase(network);
  for (let i = 0; i < 100; i++) {
    await sleep(6000);
    const j = await fetch(`${base}/extended/v1/tx/${txid}`, { headers: hiroHeaders(base) })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null) as { tx_status?: string; burn_block_time_iso?: string } | null;
    if (!j?.tx_status || j.tx_status === "pending") continue;
    return { status: j.tx_status, t: j.burn_block_time_iso ?? new Date().toISOString() };
  }
  return { status: "pending", t: "" };
}

async function confirmTyped(address: string): Promise<void> {
  console.log(`\nnew agent address: ${address}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question("Type its LAST 6 characters to continue: ")).trim();
  rl.close();
  if (typed !== address.slice(-6)) throw new Error("cancelled: nothing sent");
}

function printPlan(old: WalletBalances, fresh: WalletBalances, from: string, to: string): ReturnType<typeof planRotation> {
  const p = planRotation(old);
  console.log(`from ${from} (current agent)`);
  console.log(`to   ${to} (new key)`);
  for (const t of p.tokens) console.log(`  move ${fmtUnits(t.amount, t.asset.decimals)} ${t.asset.label}`);
  console.log(`  move ${fmtUnits(p.stxSend, 6)} STX last (fees ${fmtUnits(p.feesTotal, 6)} STX)`);
  for (const id of p.ignored) if (!/dlmm-pool/.test(id)) console.log(`  leave ${id} (not on the transfer list)`);
  const freshHas = fresh.stx > 0n || Object.keys(fresh.ft).length > 0;
  if (freshHas) console.log(`  note: the new address already holds something (${fmtUnits(fresh.stx, 6)} STX, ${Object.keys(fresh.ft).length} tokens)`);
  for (const b of p.blockers) console.log(`  BLOCKED: ${b}`);
  return p;
}

// A pending re-add is expected here (withdraw --readd-later): it travels with the tokens.
function notePending(): void {
  const p = loadPending();
  if (p) console.log(`  pending DLMM re-add (${p.pair}): ${p.xBase} x + ${p.yBase} y base units; resume it from the new wallet with force-recenter`);
}

async function main(): Promise<void> {
  if (argv.includes("--remove-backup")) {
    if (!existsSync(backupPath)) return void console.log("no backup to remove");
    shred(backupPath);
    return void console.log(`removed ${backupPath}`);
  }
  const w = await getWallet(); // loads .env
  if (w.network !== "mainnet") throw new Error("this command is for the mainnet agent wallet");

  if (cmd === "new") {
    if (existsSync(rotationPath)) throw new Error(`refusing: ${rotationPath} already exists (one rotation at a time)`);
    const key = randomPrivateKey();
    writePrivate(rotationPath, `NEW_STACKS_PRIVATE_KEY=${key}\n`);
    const address = getAddressFromPrivateKey(key, "mainnet");
    console.log(`new key written to ${rotationPath} (owner-only). Its address: ${address}`);
    console.log("next: npm run m1:rotate-key -- plan");
    return;
  }

  const key = newKey();
  if (!key) throw new Error(`no new key yet: run \`npm run m1:rotate-key -- new\` first`);
  const to = getAddressFromPrivateKey(key, "mainnet");
  if (to === w.address) throw new Error("the new key is the current key; nothing to rotate");

  if (cmd === "plan") {
    printPlan(await balances(w), await balances({ address: to, network: w.network }), w.address, to);
    notePending();
    return;
  }

  if (cmd === "move") {
    const old = await balances(w);
    const p = printPlan(old, await balances({ address: to, network: w.network }), w.address, to);
    notePending();
    if (p.blockers.length) throw new Error("refusing: resolve the BLOCKED items first; nothing sent");
    if (!yes) return void console.log("\n(preview — not sent; stop the agent, then add --yes-mainnet)");
    requireStopped();
    await confirmTyped(to);

    const prog = loadProgress();
    const progress: Progress = prog && prog.from === w.address && prog.to === to ? prog : { from: w.address, to, txids: [] };
    for (const t of p.tokens) {
      const [addr, name] = t.asset.contract.split(".");
      const nonce = await fetchNonce({ address: w.address, network: w.network });
      const tx = await makeContractCall({
        contractAddress: addr, contractName: name, functionName: "transfer",
        functionArgs: [Cl.uint(t.amount), Cl.principal(w.address), Cl.principal(to), Cl.none()],
        senderKey: w.key, network: w.network, fee: ROTATION_FEE_USTX, nonce,
        postConditionMode: PostConditionMode.Deny,
        postConditions: [Pc.principal(w.address).willSendEq(t.amount).ft(t.asset.contract as `${string}.${string}`, t.asset.id.split("::")[1])],
      });
      const res = await broadcastTransaction({ transaction: tx, network: w.network });
      if (!("txid" in res)) throw new Error(`broadcast failed (${t.asset.label}): ${JSON.stringify(res)}`);
      const txid = res.txid.startsWith("0x") ? res.txid : `0x${res.txid}`;
      console.log(`sent ${fmtUnits(t.amount, t.asset.decimals)} ${t.asset.label}: ${txid}, confirming…`);
      const r = await waitTx(w.network, txid);
      console.log(`  ${r.status}`);
      if (r.status !== "success") throw new Error(`stopped: ${t.asset.label} transfer did not succeed. Re-run plan; move resumes with what is left.`);
      progress.txids.push(txid);
      saveProgress(progress);
    }
    // STX last: re-read, so the amount is exactly what remains after the fees just paid.
    const after = await balances(w);
    const stxSend = after.stx - after.stxLocked - ROTATION_FEE_USTX;
    if (stxSend > 0n) {
      const nonce = await fetchNonce({ address: w.address, network: w.network });
      const tx = await makeSTXTokenTransfer({ recipient: to, amount: stxSend, senderKey: w.key, network: w.network, fee: ROTATION_FEE_USTX, nonce, memo: "key rotation" });
      const res = await broadcastTransaction({ transaction: tx, network: w.network });
      if (!("txid" in res)) throw new Error(`broadcast failed (STX): ${JSON.stringify(res)}`);
      const txid = res.txid.startsWith("0x") ? res.txid : `0x${res.txid}`;
      console.log(`sent ${fmtUnits(stxSend, 6)} STX: ${txid}, confirming…`);
      const r = await waitTx(w.network, txid);
      console.log(`  ${r.status}`);
      if (r.status !== "success") throw new Error("stopped: the STX transfer did not succeed. Re-run plan; move resumes with what is left.");
      progress.txids.push(txid);
      saveProgress(progress);
    }
    console.log("\nmoved. next: npm run m1:rotate-key -- switch --yes-mainnet");
    return;
  }

  if (cmd === "switch") {
    const old = await balances(w);
    if (!isDrained(old)) throw new Error("refusing: the current agent wallet still holds funds; run move first");
    const fresh = await balances({ address: to, network: w.network });
    if (fresh.stx === 0n) throw new Error("refusing: the new address holds no STX; nothing seems to have arrived");
    console.log(`old ${w.address}: drained (${fmtUnits(old.stx, 6)} STX dust)`);
    console.log(`new ${to}: ${fmtUnits(fresh.stx, 6)} STX, ${Object.keys(fresh.ft).length} tokens`);
    if (!yes) return void console.log("\n(preview — nothing changed; add --yes-mainnet)");
    requireStopped();

    const text = readFileSync(envPath, "utf8");
    if (!/^STACKS_PRIVATE_KEY=.*$/m.test(text)) throw new Error(`no STACKS_PRIVATE_KEY in ${envPath}`);
    copyFileSync(envPath, backupPath);
    chmodSync(backupPath, 0o600);
    const orig = statSync(envPath);
    const tmp = `${envPath}.tmp-${process.pid}`;
    writeFileSync(tmp, text.replace(/^STACKS_PRIVATE_KEY=.*$/m, `STACKS_PRIVATE_KEY=${key}`), { mode: orig.mode & 0o777 });
    try { chownSync(tmp, orig.uid, orig.gid); } catch { /* not root */ }
    renameSync(tmp, envPath);
    const check = /^STACKS_PRIVATE_KEY=(.*)$/m.exec(readFileSync(envPath, "utf8"))?.[1]?.trim() ?? "";
    if (getAddressFromPrivateKey(check, "mainnet") !== to) {
      copyFileSync(backupPath, envPath);
      throw new Error("verification failed; the original .env was restored");
    }

    const prog = loadProgress();
    const txids = prog && prog.from === w.address && prog.to === to ? prog.txids : [];
    const r = addWalletMigration({ t: new Date().toISOString(), from: w.address, to, txids, note: "key rotation" });
    console.log(`.env now uses ${to}; migration recorded (${r}, ${txids.length} transfers)`);
    shred(rotationPath);
    if (existsSync(progressPath)) rmSync(progressPath);
    if (isPublishConfigured()) await publishMetrics();
    console.log(`next: reopen the DLMM position from the new wallet, then systemctl start ${SERVICE} && rm KILL;`);
    console.log("      confirm its next report, then: npm run m1:rotate-key -- --remove-backup");
    return;
  }

  throw new Error(`unknown command "${cmd}" (new | plan | move | switch | --remove-backup)`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
