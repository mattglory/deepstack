// Record an owner deposit into, or withdrawal from, the agent wallet, so the dashboard's HODL
// comparison and the agent's own drawdown checks don't read it as a trading result.
//
// The transaction is read from the chain, never typed in by hand: it must be a successful STX
// transfer between the agent wallet (the metrics file's `wallet`) and another address.
// A transfer OUT is recorded as a withdrawal, IN as a deposit. Other assets (USDCx, sBTC) are
// refused for now: convert to STX inside the wallet first, as the 2026-10-22 withdrawal did.
//
// Run it where the live metrics file is (the VPS), like `dlmm-recenter-cli set-basis`:
//   npm run m1:flow -- add <txid> [--note="owner withdrawal"]
//   npm run m1:flow -- list

import { loadDotenv } from "./wallet.js";
import { addCapitalFlow, loadCapitalFlows, METRICS_PATH } from "./metrics.js";
import { publishMetrics, isPublishConfigured } from "./publish.js";
import { readFileSync } from "node:fs";

loadDotenv();
const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith("--"));
const note = argv.find((a) => a.startsWith("--note="))?.slice("--note=".length);

interface Tx {
  tx_status?: string;
  tx_type?: string;
  sender_address?: string;
  burn_block_time_iso?: string;
  token_transfer?: { recipient_address: string; amount: string };
}

async function main(): Promise<void> {
  const cmd = pos[0];
  if (cmd === "list") {
    const flows = loadCapitalFlows();
    if (flows.length === 0) return void console.log("no capital flows recorded");
    for (const f of flows) console.log(`${f.t}  ${f.stx > 0 ? "+" : ""}${f.stx} STX  ${f.txid}${f.note ? `  (${f.note})` : ""}`);
    return;
  }
  if (cmd !== "add" || !pos[1]) throw new Error("usage: m1:flow -- add <txid> [--note=...] | list");

  const wallet = (JSON.parse(readFileSync(METRICS_PATH, "utf8")) as { wallet?: string }).wallet;
  if (!wallet) throw new Error(`no wallet in ${METRICS_PATH}`);
  const txid = pos[1].startsWith("0x") ? pos[1] : `0x${pos[1]}`;
  const res = await fetch(`https://api.mainnet.hiro.so/extended/v1/tx/${txid}`);
  if (!res.ok) throw new Error(`could not read ${txid}: HTTP ${res.status}`);
  const tx = (await res.json()) as Tx;

  if (tx.tx_status !== "success") throw new Error(`transaction status is ${tx.tx_status}, not success`);
  if (tx.tx_type !== "token_transfer" || !tx.token_transfer) {
    throw new Error("only plain STX transfers are supported; convert other assets to STX inside the wallet first");
  }
  const { recipient_address: to, amount } = tx.token_transfer;
  const from = tx.sender_address;
  const stx = Number(amount) / 1e6;
  let signed: number;
  if (from === wallet && to !== wallet) signed = -stx;
  else if (to === wallet && from !== wallet) signed = stx;
  else throw new Error("this transfer does not move STX between the agent wallet and another address");
  if (!tx.burn_block_time_iso) throw new Error("transaction has no block time yet");

  const r = addCapitalFlow({ t: tx.burn_block_time_iso, txid, stx: signed, note });
  console.log(`${r === "added" ? "recorded" : "already recorded"}: ${signed > 0 ? "deposit" : "withdrawal"} of ${stx} STX at ${tx.burn_block_time_iso} (${txid})`);
  if (r === "added" && isPublishConfigured()) {
    console.log((await publishMetrics()) ? "published to the gist mirror." : "gist publish failed; the dashboard picks it up on the agent's next cycle.");
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
