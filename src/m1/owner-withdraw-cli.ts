// Owner withdrawal of STX from the agent wallet, run on the server, so the agent's key never has
// to live in a browser wallet (review of #18, point 8, 2026-10-27).
//
// Guards, all before anything is signed:
// - the destination must be on OWNER_WITHDRAW_ADDRESSES in .env (comma-separated), so a
//   look-alike address copied from wallet history (two address-poisoning attempts so far) can
//   never be paid;
// - the agent must be paused (KILL present), so the two never use the same nonce;
// - the amount must leave at least STX_FEE_RESERVE (default 50 STX) for the agent's fees;
// - the full destination is printed and its last 6 characters must be typed back.
// After it confirms, the withdrawal is recorded as a capital flow, so it isn't read as a loss.
//
//   npm run m1:withdraw -- <stx> --to=<address>                 # preview
//   npm run m1:withdraw -- <stx> --to=<address> --yes-mainnet   # send

import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { makeSTXTokenTransfer, broadcastTransaction, fetchNonce } from "@stacks/transactions";
import { getWallet, getStxBalance, apiBase } from "./wallet.js";
import { addCapitalFlow, loadCapitalFlows } from "./metrics.js";
import { publishMetrics, isPublishConfigured } from "./publish.js";

const FEE_USTX = 50_000n;
const argv = process.argv.slice(2);
const amountArg = argv.find((a) => !a.startsWith("--"));
const to = argv.find((a) => a.startsWith("--to="))?.slice("--to=".length).trim() ?? "";
const yes = argv.includes("--yes-mainnet");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const w = await getWallet(); // loads .env
  if (w.network !== "mainnet") throw new Error("this command is for the mainnet agent wallet");
  const allowed = (process.env.OWNER_WITHDRAW_ADDRESSES ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  if (allowed.length === 0) throw new Error("set OWNER_WITHDRAW_ADDRESSES in .env (your own addresses, comma-separated) first");
  if (!allowed.includes(to)) throw new Error(`refusing: ${to || "(no --to)"} is not on OWNER_WITHDRAW_ADDRESSES`);
  if (to === w.address) throw new Error("refusing: that is the agent wallet itself");
  const stx = Number(amountArg);
  if (!(stx > 0)) throw new Error("usage: m1:withdraw -- <stx> --to=<address> [--yes-mainnet]");
  const amount = BigInt(Math.round(stx * 1e6));
  const reserve = BigInt(Math.round(Number(process.env.STX_FEE_RESERVE ?? 50) * 1e6));
  const bal = (await getStxBalance(w.address, w.network)).microStx;
  if (amount + reserve + FEE_USTX > bal) {
    throw new Error(`refusing: leaves less than the ${Number(reserve) / 1e6} STX fee reserve (free STX ${Number(bal) / 1e6})`);
  }
  console.log(`withdraw ${stx} STX\n  from  ${w.address} (agent)\n  to    ${to}\n  leaves ${(Number(bal - amount - FEE_USTX) / 1e6).toFixed(6)} STX loose`);
  if (!yes) return void console.log("  (preview — not sent; pause the agent with `touch KILL`, then add --yes-mainnet)");
  if (!existsSync("KILL")) throw new Error("refusing: pause the agent first (touch /opt/deepstack/KILL) so the two never send at once");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question(`Type the LAST 6 characters of the destination to send: `)).trim();
  rl.close();
  if (typed !== to.slice(-6)) throw new Error("cancelled: nothing sent");

  const nonce = await fetchNonce({ address: w.address, network: w.network });
  const tx = await makeSTXTokenTransfer({ recipient: to, amount, senderKey: w.key, network: w.network, fee: FEE_USTX, nonce, memo: "owner withdrawal" });
  const res = await broadcastTransaction({ transaction: tx, network: w.network });
  if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
  const txid = res.txid.startsWith("0x") ? res.txid : `0x${res.txid}`;
  console.log(`sent: ${txid} — confirming…`);
  for (let i = 0; i < 60; i++) {
    await sleep(6000);
    const j = await fetch(`${apiBase(w.network)}/extended/v1/tx/${txid}`).then((r) => (r.ok ? r.json() : null)).catch(() => null) as { tx_status?: string; burn_block_time_iso?: string } | null;
    if (!j?.tx_status || j.tx_status === "pending") continue;
    console.log(`status: ${j.tx_status}`);
    if (j.tx_status !== "success") { process.exitCode = 1; return; }
    const r = addCapitalFlow({ t: j.burn_block_time_iso ?? new Date().toISOString(), txid, stx: -stx, note: "owner withdrawal" });
    console.log(`recorded as a capital flow (${r}); flows now: ${loadCapitalFlows().map((f) => f.stx).join(", ")}`);
    if (isPublishConfigured()) await publishMetrics();
    console.log("Resume the agent when done: rm /opt/deepstack/KILL");
    return;
  }
  console.log("still pending after 6 minutes; record it later with: npm run m1:flow -- add " + txid);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
