// Read-only wallet preflight: confirms your key is loaded and shows the derived
// address + balance for the selected network. NEVER prints the key. No broadcast.
//
// Setup (never paste your key anywhere shared):
//   cp .env.example .env   # then edit .env:  STACKS_PRIVATE_KEY=...  STACKS_NETWORK=testnet
//   npm run m1:wallet

import { getWallet, getStxBalance } from "./wallet.js";

async function main() {
  console.log("=== DeepStack M1 — wallet preflight (read-only) ===\n");
  const w = await getWallet();
  console.log(`network: ${w.network}`);
  console.log(`address: ${w.address}`);
  const bal = await getStxBalance(w.address, w.network);
  console.log(`balance: ${bal.stx} STX (${bal.microStx} uSTX)`);
  if (bal.microStx === 0n) {
    console.log(
      w.network === "testnet"
        ? "\n⚠ 0 STX — fund this testnet address from a faucet before broadcasting."
        : "\n⚠ 0 STX — this mainnet address has no funds.",
    );
  }
  console.log("\n✓ key loaded from env (not shown). Nothing broadcast.");
}

main().catch((err) => {
  console.error("preflight failed:", err.message);
  process.exit(1);
});
