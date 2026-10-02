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
import { makeContractDeploy, broadcastTransaction, fetchCallReadOnlyFunction, cvToJSON, PostConditionMode } from "@stacks/transactions";
import { getWallet } from "../m1/wallet.js";
import { withRpc, hiroFetch } from "../m1/rpc.js";
import { readFlashStackStatus, armRebalance, executeFlashLoanRebalance, waitForTx as sharedWaitForTx } from "./flash-rebalance-exec.js";
import { flashFee } from "./flash-rebalance.js";

const FLASHSTACK_CORE = {
  address: "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5",
  name: "flashstack-stx-core",
} as const;
const RECEIVER_NAME = "deepstack-rebalance-receiver";
const CONTRACT_PATH = "contracts/deepstack-rebalance-receiver.clar";
const DEPLOY_FEE = 150_000n; // µSTX — deploys are size-priced; ~7KB needs headroom

// Thin wrapper over the shared waitForTx (flash-rebalance-exec.ts) — same polling/failover
// behavior, this CLI's own console formatting (a dot per poll, a boolean return).
async function waitForTx(txid: string): Promise<boolean> {
  process.stdout.write("  confirming");
  const status = await sharedWaitForTx(txid, () => process.stdout.write("."));
  console.log(`\n  status: ${status}`);
  return status === "success";
}

function requireLive(argv: string[]): void {
  if (!argv.includes("--yes-mainnet")) {
    console.log("  refusing: this broadcasts a REAL mainnet transaction. Add --yes-mainnet.");
    process.exit(1);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const w = await getWallet();
  if (w.network !== "mainnet") throw new Error("mainnet only — set STACKS_NETWORK=mainnet");
  const receiverId = `${w.address}.${RECEIVER_NAME}`;
  console.log(`operator: ${w.address}\nreceiver: ${receiverId}\n`);

  if (cmd === "status") {
    const status = await readFlashStackStatus(w);
    console.log(`core fee: ${status.feeBps}bps | max loan: ${Number(status.maxSingleLoan) / 1e6} STX | reserve: ${Number(status.reserveBalance) / 1e6} STX`);
    console.log(`receiver whitelisted: ${status.whitelisted}`);
    try {
      const pending = cvToJSON(
        await withRpc((baseUrl) =>
          fetchCallReadOnlyFunction({
            contractAddress: w.address,
            contractName: RECEIVER_NAME,
            functionName: "get-pending",
            functionArgs: [],
            network: "mainnet",
            client: { baseUrl, fetch: hiroFetch(baseUrl) },
            senderAddress: w.address,
          }),
        ),
      ) as any;
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
      const armed = await armRebalance(w, amount, { broadcast: true });
      console.log(`arm: borrow ${stx} STX → quote ${Number(armed.quotedDx) / 1e8} sBTC, ` +
        `min-dx ${Number(armed.minDx) / 1e8} (expires in 10 blocks)`);
      console.log(`  txid: ${armed.txid}`);
      if (await waitForTx(armed.txid!)) console.log(`\nNEXT (within ~10 blocks): npm run m2:receiver -- flash ${stx} --yes-mainnet`);
      return;
    }

    // flash: the real thing. Operator pays back amount + fee; the post-condition (built
    // inside executeFlashLoanRebalance) caps exactly that.
    const repay = amount + flashFee(amount);
    console.log(`flash-loan: ${stx} STX via ${FLASHSTACK_CORE.name} → ${RECEIVER_NAME}`);
    console.log(`  repay cap (post-condition): ${Number(repay) / 1e6} STX from operator`);
    const flashed = await executeFlashLoanRebalance(w, amount, { broadcast: true });
    console.log(`  txid: ${flashed.txid}`);
    if (await waitForTx(flashed.txid!))
      console.log("\n🎉 flash-rebalance confirmed — save this txid for the record");
    return;
  }

  console.log("usage: m2:receiver -- status | deploy | arm <stx> | flash <stx>   (broadcasts need --yes-mainnet)");
}

main().catch((err) => {
  console.error("receiver-cli failed:", err.message);
  process.exit(1);
});
