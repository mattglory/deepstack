// M2 flash-rebalance operations — deploy and drive the DeepStack receiver contract.
//
//   npm run m2:receiver -- status                    # read everything, broadcast nothing
//   npm run m2:receiver -- deploy --yes-mainnet      # one-time: deploy the receiver
//   npm run m2:receiver -- arm 50 --yes-mainnet      # arm: borrow 50 STX, min-out quoted fresh
//   npm run m2:receiver -- flash 50 --yes-mainnet    # execute the flash-rebalance
//
// The full flow (docs/FLASH_REBALANCE.md): deploy once from the OPERATOR wallet, get the
// receiver whitelisted on flashstack-stx-core (admin call from the FlashStack wallet),
// then per rebalance: arm (fresh get-dx quote minus slippage, 10-block expiry) and flash.
// Every broadcast is mainnet-only and requires --yes-mainnet. Post-conditions cap what the
// operator can send: the repayment (amount + FlashStack fee) and nothing more.

import { readFileSync } from "node:fs";
import {
  makeContractCall,
  makeContractDeploy,
  broadcastTransaction,
  fetchCallReadOnlyFunction,
  cvToJSON,
  Cl,
  Pc,
  PostConditionMode,
} from "@stacks/transactions";
import { getWallet } from "../m1/wallet.js";
import { getSwapYForXQuote, minusSlippage } from "../m1/quotes.js";
import { withRpc } from "../m1/rpc.js";

const FLASHSTACK_CORE = {
  address: "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5",
  name: "flashstack-stx-core",
} as const;
const RECEIVER_NAME = "deepstack-rebalance-receiver";
const CONTRACT_PATH = "contracts/deepstack-rebalance-receiver.clar";
const CALL_FEE = 50_000n; // µSTX, same as the agent's contract calls
const DEPLOY_FEE = 150_000n; // µSTX — deploys are size-priced; ~7KB needs headroom
const SLIP_BPS = 80; // min-dx slippage budget on the armed quote

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForTx(txid: string) {
  process.stdout.write("  confirming");
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    process.stdout.write(".");
    try {
      const j = await withRpc(async (base) => {
        const r = await fetch(`${base}/extended/v1/tx/${txid}`);
        if (!r.ok) throw new Error(`tx fetch → ${r.status}`);
        return (await r.json()) as { tx_status?: string; tx_result?: { repr?: string } };
      });
      if (j.tx_status && j.tx_status !== "pending") {
        console.log(`\n  status: ${j.tx_status} ${j.tx_result?.repr ?? ""}`);
        return j.tx_status === "success";
      }
    } catch { /* transient — next poll */ }
  }
  console.log("\n  status: still pending after 3 minutes — check the explorer");
  return false;
}

async function readOnly(addr: string, name: string, fn: string, args: any[] = []) {
  return cvToJSON(
    await withRpc((baseUrl) =>
      fetchCallReadOnlyFunction({
        contractAddress: addr,
        contractName: name,
        functionName: fn,
        functionArgs: args,
        network: "mainnet",
        client: { baseUrl },
        senderAddress: addr,
      }),
    ),
  ) as any;
}

function requireLive(argv: string[]): void {
  if (!argv.includes("--yes-mainnet")) {
    console.log("  refusing: this broadcasts a REAL mainnet transaction. Add --yes-mainnet.");
    process.exit(1);
  }
}

const flashFee = (amount: bigint) => {
  const raw = (amount * 5n) / 10_000n; // live core: 5bps, floor 1 µSTX
  return raw > 0n ? raw : 1n;
};

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const w = await getWallet();
  if (w.network !== "mainnet") throw new Error("mainnet only — set STACKS_NETWORK=mainnet");
  const receiverId = `${w.address}.${RECEIVER_NAME}`;
  console.log(`operator: ${w.address}\nreceiver: ${receiverId}\n`);

  if (cmd === "status") {
    const [fee, maxLoan, reserve, approved] = await Promise.all([
      readOnly(FLASHSTACK_CORE.address, FLASHSTACK_CORE.name, "get-fee-basis-points"),
      readOnly(FLASHSTACK_CORE.address, FLASHSTACK_CORE.name, "get-max-single-loan"),
      readOnly(FLASHSTACK_CORE.address, FLASHSTACK_CORE.name, "get-reserve-balance"),
      readOnly(FLASHSTACK_CORE.address, FLASHSTACK_CORE.name, "is-approved-receiver",
        [Cl.contractPrincipal(w.address, RECEIVER_NAME)]),
    ]);
    console.log(`core fee: ${fee?.value?.value}bps | max loan: ${Number(maxLoan?.value?.value) / 1e6} STX | reserve: ${Number(reserve?.value ?? 0) / 1e6} STX`);
    console.log(`receiver whitelisted: ${approved?.value}`);
    try {
      const pending = await readOnly(w.address, RECEIVER_NAME, "get-pending");
      console.log(`armed: ${JSON.stringify(pending?.value?.value ?? null)}`);
    } catch {
      console.log("armed: (receiver not deployed yet)");
    }
    return;
  }

  if (cmd === "deploy") {
    requireLive(argv);
    const codeBody = readFileSync(CONTRACT_PATH, "utf8");
    console.log(`deploying ${RECEIVER_NAME} (${codeBody.length} bytes, fee ${Number(DEPLOY_FEE) / 1e6} STX)`);
    const tx = await makeContractDeploy({
      contractName: RECEIVER_NAME,
      codeBody,
      clarityVersion: 3,
      senderKey: w.key,
      network: "mainnet",
      fee: DEPLOY_FEE,
      postConditionMode: PostConditionMode.Deny, // a deploy moves nothing; Deny proves it
    });
    const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`  txid: ${res.txid}`);
    await waitForTx(res.txid);
    console.log(`\nNEXT: whitelist it — from the FlashStack ADMIN wallet call\n` +
      `  ${FLASHSTACK_CORE.address}.${FLASHSTACK_CORE.name} add-approved-receiver '${receiverId}\n` +
      `then: npm run m2:receiver -- status   (expect "whitelisted: true")`);
    return;
  }

  if (cmd === "arm" || cmd === "flash") {
    const stx = Number(argv[1]);
    if (!(stx > 0)) throw new Error(`usage: ${cmd} <stx-amount> --yes-mainnet`);
    requireLive(argv);
    const amount = BigInt(Math.round(stx * 1e6));

    if (cmd === "arm") {
      const dx = await getSwapYForXQuote(amount); // sBTC out for the borrowed STX
      const minDx = minusSlippage(dx, SLIP_BPS);
      console.log(`arm: borrow ${stx} STX → quote ${Number(dx) / 1e8} sBTC, ` +
        `min-dx ${Number(minDx) / 1e8} (${SLIP_BPS}bps slip, expires in 10 blocks)`);
      const tx = await makeContractCall({
        contractAddress: w.address,
        contractName: RECEIVER_NAME,
        functionName: "arm",
        functionArgs: [Cl.uint(amount), Cl.uint(minDx)],
        senderKey: w.key,
        network: "mainnet",
        fee: CALL_FEE,
        postConditionMode: PostConditionMode.Deny, // arming moves no assets
      });
      const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
      if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
      console.log(`  txid: ${res.txid}`);
      if (await waitForTx(res.txid)) console.log(`\nNEXT (within ~10 blocks): npm run m2:receiver -- flash ${stx} --yes-mainnet`);
      return;
    }

    // flash: the real thing. Operator pays back amount + fee; PC caps exactly that.
    const repay = amount + flashFee(amount);
    console.log(`flash-loan: ${stx} STX via ${FLASHSTACK_CORE.name} → ${RECEIVER_NAME}`);
    console.log(`  repay cap (post-condition): ${Number(repay) / 1e6} STX from operator`);
    const tx = await makeContractCall({
      contractAddress: FLASHSTACK_CORE.address,
      contractName: FLASHSTACK_CORE.name,
      functionName: "flash-loan",
      functionArgs: [Cl.uint(amount), Cl.contractPrincipal(w.address, RECEIVER_NAME)],
      senderKey: w.key,
      network: "mainnet",
      fee: CALL_FEE,
      // Allow mode: the core and receiver contracts move STX/sBTC internally (borrowed
      // leg, swap, forwarding) — same rationale as the agent's swaps. The operator's own
      // outflow is strictly capped at the repayment.
      postConditionMode: PostConditionMode.Allow,
      postConditions: [Pc.principal(w.address).willSendLte(repay).ustx()],
    });
    const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`  txid: ${res.txid}`);
    if (await waitForTx(res.txid))
      console.log("\n🎉 first DeepStack→FlashStack flash-rebalance — save this txid for the M2 submission");
    return;
  }

  console.log("usage: m2:receiver -- status | deploy | arm <stx> | flash <stx>   (broadcasts need --yes-mainnet)");
}

main().catch((err) => {
  console.error("receiver-cli failed:", err.message);
  process.exit(1);
});
