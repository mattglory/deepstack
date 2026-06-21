// Testnet plumbing test: broadcasts a 1-µSTX self-transfer on TESTNET to prove
// the wallet → sign → broadcast path works with your real test key. Harmless
// (testnet STX is worthless; recipient = yourself). REFUSES to run on mainnet.
//
// Why this and not a pool op? Bitflow's sBTC-STX pool is deployed on MAINNET
// only — there is no testnet pool to add/withdraw/swap against. So testnet can
// validate plumbing; real pool ops are validated by a tiny mainnet smoke later.
//
//   npm run m1:testnet-ping   (with STACKS_NETWORK=testnet and a funded key)

import { makeSTXTokenTransfer, broadcastTransaction, fetchNonce } from "@stacks/transactions";
import { getWallet, getStxBalance } from "./wallet.js";

async function main() {
  console.log("=== DeepStack M1 — testnet broadcast plumbing test ===\n");
  const w = getWallet();
  if (w.network !== "testnet") {
    throw new Error(`refusing to run on ${w.network}; this test is testnet-only`);
  }
  console.log(`network: ${w.network}\naddress: ${w.address}`);

  const bal = await getStxBalance(w.address, w.network);
  if (bal.microStx === 0n) {
    throw new Error("0 STX — fund this testnet address from a faucet first.");
  }

  const nonce = await fetchNonce({ address: w.address, network: "testnet" });
  const tx = await makeSTXTokenTransfer({
    recipient: w.address, // send to self
    amount: 1n, // 1 microSTX
    senderKey: w.key,
    network: "testnet",
    fee: 300n,
    nonce,
    memo: "deepstack m1 ping",
  });

  const res = await broadcastTransaction({ transaction: tx, network: "testnet" });
  const txid = (res as any).txid;
  if (!txid) {
    console.log("broadcast response:", JSON.stringify(res));
    throw new Error("no txid returned — see response above");
  }
  console.log(`\n✓ broadcast on testnet. txid: ${txid}`);
  console.log(`  explorer: https://explorer.hiro.so/txid/${txid}?chain=testnet`);
  console.log("\nThis confirms sign + broadcast works. Pool ops need a mainnet smoke.");
}

main().catch((err) => {
  console.error("testnet ping failed:", err.message);
  process.exit(1);
});
