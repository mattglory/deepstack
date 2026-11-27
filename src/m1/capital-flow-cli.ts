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
//
// Owner allocation (docs/WALLET_RESERVATION_DESIGN.md, the owner claim). A recorded deposit with no
// `allocated` marker, and every owner hold, is reserved for the owner: no venue trades it.
//   npm run m1:flow -- allocate <txid> <dlmm|xyk|trend>        a deposit has been given to a venue
//     Until reservation stage 3 only the XYK claims loose tokens, so allocating a deposit releases it
//     to the XYK whatever venue is named. For a NEW deposit meant for the DLMM: KILL on, open the
//     DLMM while the deposit is still an owner claim, THEN allocate (review R113-1).
//   npm run m1:flow -- hold <sbtc|usdcx|stx> <amount> --note=..  set tokens aside (human units)
//   npm run m1:flow -- release <hold-id>                       give a hold back to the venues
//   npm run m1:flow -- holds                                   list holds
// Run as the agent's user on the VPS (they write journal/).

import { loadDotenv } from "./wallet.js";
import { addCapitalFlow, allocateCapitalFlow, loadCapitalFlows, METRICS_PATH } from "./metrics.js";
import { holdAssets, loadOwnerHolds, saveOwnerHolds } from "./owner-claims.js";
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
  if (cmd === "allocate") {
    const [txid, venue] = [pos[1], pos[2]];
    if (!txid || !["dlmm", "xyk", "trend"].includes(venue ?? "")) throw new Error("usage: m1:flow -- allocate <txid> <dlmm|xyk|trend>");
    const r = allocateCapitalFlow(txid.startsWith("0x") ? txid : `0x${txid}`, venue);
    if (r !== "allocated") throw new Error(r === "not-found" ? `no recorded flow ${txid}` : `${txid} is not a deposit`);
    console.log(`deposit ${txid} allocated to ${venue}; it is no longer an owner claim`);
    if (venue !== "xyk") console.log(`note: until reservation stage 3 nothing claims loose tokens for ${venue}, so the XYK may now trade them. For a new deposit, open the venue first, then allocate.`);
    return;
  }
  if (cmd === "holds") {
    const h = loadOwnerHolds();
    if (!h.ok) throw new Error(h.reason);
    if (h.value.length === 0) return void console.log("no owner holds");
    for (const x of h.value) console.log(`${x.id}  ${x.t}  ${x.amount} base units of ${x.asset}${x.note ? `  (${x.note})` : ""}`);
    return;
  }
  if (cmd === "hold") {
    const ha = holdAssets()[(pos[1] ?? "").toLowerCase()];
    const a: [string, number] | undefined = ha && [ha.asset, ha.decimals];
    const human = pos[2] ?? "";
    if (!a || !/^[0-9]+([.][0-9]+)?$/.test(human)) throw new Error("usage: m1:flow -- hold <sbtc|usdcx|stx> <amount> --note=...");
    const [whole, frac = ""] = human.split(".");
    if (frac.length > a[1]) throw new Error(`${pos[1]} has ${a[1]} decimals`);
    const amount = (BigInt(whole) * 10n ** BigInt(a[1]) + BigInt(frac.padEnd(a[1], "0") || "0")).toString();
    const h = loadOwnerHolds();
    if (!h.ok) throw new Error(h.reason);
    const id = `hold-${Date.now()}`;
    saveOwnerHolds([...h.value, { id, t: new Date().toISOString(), asset: a[0], amount, note }]);
    return void console.log(`${id}: ${human} ${pos[1]} held for the owner; no venue trades it until released`);
  }
  if (cmd === "release") {
    const h = loadOwnerHolds();
    if (!h.ok) throw new Error(h.reason);
    if (!h.value.some((x) => x.id === pos[1])) throw new Error(`no hold ${pos[1]}`);
    saveOwnerHolds(h.value.filter((x) => x.id !== pos[1]));
    return void console.log(`${pos[1]} released; its tokens go back to the XYK (the residual owner) unless another venue claims them`);
  }
  if (cmd !== "add" || !pos[1]) throw new Error("usage: m1:flow -- add <txid> [--note=...] | list | allocate | hold | release | holds");

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
