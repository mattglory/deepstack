// AUM vault operations (Phase 1) — deploy and drive deepstack-vault.clar /
// deepstack-vault-token.clar.
//
//   npm run m1:vault -- status                              # read everything, broadcast nothing
//   npm run m1:vault -- deploy-token --yes-mainnet          # one-time, FIRST: deploy the share token
//   npm run m1:vault -- deploy-vault --yes-mainnet          # one-time, SECOND: deploy the vault
//   npm run m1:vault -- link --yes-mainnet                  # one-time, THIRD: the token<->vault link
//   npm run m1:vault -- deposit 10 --yes-mainnet             # deposit 10 STX, get vault shares
//   npm run m1:vault -- sweep-to-strategy 10 --yes-mainnet  # admin only: move capital to the strategy wallet
//   npm run m1:vault -- return-from-strategy 11 --yes-mainnet  # admin only: bring it back + realize P&L
//   npm run m1:vault -- request-withdrawal 10 --yes-mainnet  # queue a withdrawal of 10 vault shares
//   npm run m1:vault -- claim-withdrawal 0 --yes-mainnet      # claim withdrawal id 0 once its delay has passed
//   npm run m1:vault -- pause-deposits --yes-mainnet          # admin only, instant: block new deposits
//   npm run m1:vault -- unpause-deposits --yes-mainnet        # admin only, instant: allow deposits again
//   npm run m1:vault -- pause-strategy --yes-mainnet          # admin only, instant: block new sweeps
//   npm run m1:vault -- unpause-strategy --yes-mainnet        # admin only, instant: allow sweeps again
//
// Deliberately a separate, manual CLI, not a step folded into agent-cli.ts's unattended loop:
// sweep-to-strategy/return-from-strategy are the first functions in this project that can move
// someone else's custodied capital, not just the operator's own self-funded wallet — that earns
// a deliberate, manual, explicitly-logged action every time, not a cron-loop step, regardless of
// how small Phase 1's amounts are. See docs/VAULT_DISCLOSURE.md and
// contracts/deepstack-vault.clar's own header for the full design reasoning.
//
// Every broadcast is mainnet-only and requires --yes-mainnet.

import { readFileSync } from "node:fs";
import { makeContractDeploy, makeContractCall, broadcastTransaction, fetchCallReadOnlyFunction, fetchNonce, cvToJSON, Cl, PostConditionMode } from "@stacks/transactions";
import { getWallet } from "./wallet.js";
import { withRpc, hiroFetch } from "./rpc.js";

const VAULT_NAME = "deepstack-vault";
const TOKEN_NAME = "deepstack-vault-token";
const VAULT_PATH = "contracts/deepstack-vault.clar";
const TOKEN_PATH = "contracts/deepstack-vault-token.clar";
const CALL_FEE = 50_000n; // µSTX, same as the rest of this project's contract calls
// µSTX. Deploys are size-priced. The project's only prior deploy (the 7.8KB receiver
// contract) paid 150_000 and succeeded, but deepstack-vault.clar is ~22KB (~2.8x larger) --
// scaling that precedent plus the current mainnet transfer fee market (~13 µSTX/byte as of
// 2026-10-05, extrapolated: ~0.29 STX for a tx this size) both land meaningfully above
// 150_000. Sized with real margin above both estimates since this is a one-time cost on a
// wallet holding ~190 STX free -- not worth risking a stuck deploy to save a fraction of a
// STX. The smaller token contract (5.4KB, under the receiver's own precedent) is safe at
// this same fee too.
const DEPLOY_FEE = 500_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForTx(txid: string): Promise<boolean> {
  process.stdout.write("  confirming");
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    process.stdout.write(".");
    try {
      const j = await withRpc((baseUrl) =>
        hiroFetch(baseUrl)(`${baseUrl}/extended/v1/tx/${txid}`).then((r) => {
          if (!r.ok) throw new Error(`tx status fetch failed: ${r.status}`);
          return r.json() as Promise<{ tx_status?: string; tx_result?: { repr?: string } }>;
        }),
      );
      if (j.tx_status && j.tx_status !== "pending") {
        console.log(`\n  status: ${j.tx_status}${j.tx_result?.repr ? `  ${j.tx_result.repr}` : ""}`);
        return j.tx_status === "success";
      }
    } catch {
      // no endpoint answered (or all timed out) this poll — treat as still-pending, retry
    }
  }
  console.log("\n  status: still pending — check the explorer");
  return false;
}

async function readOnly(addr: string, name: string, fn: string, args: any[] = []): Promise<any> {
  return cvToJSON(
    await withRpc((baseUrl) =>
      fetchCallReadOnlyFunction({
        contractAddress: addr,
        contractName: name,
        functionName: fn,
        functionArgs: args,
        network: "mainnet",
        client: { baseUrl, fetch: hiroFetch(baseUrl) },
        senderAddress: addr,
      }),
    ),
  );
}

function requireLive(argv: string[]): void {
  if (!argv.includes("--yes-mainnet")) {
    console.log("  refusing: this broadcasts a REAL mainnet transaction. Add --yes-mainnet.");
    process.exit(1);
  }
}

const ustx = (stx: number) => BigInt(Math.round(stx * 1e6));
const stxFmt = (u: bigint | number) => (Number(u) / 1e6).toLocaleString();

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const w = await getWallet();
  if (w.network !== "mainnet") throw new Error("mainnet only — set STACKS_NETWORK=mainnet");
  const vaultId = `${w.address}.${VAULT_NAME}`;
  const tokenId = `${w.address}.${TOKEN_NAME}`;
  console.log(`operator: ${w.address}\nvault: ${vaultId}\ntoken: ${tokenId}\n`);

  if (cmd === "status") {
    try {
      const [admin, maxTvl, feeBps, feeRecipient, depositsPaused, strategyPaused, totalBal, atStrategy, pendingWd, pnl, hwm] = await Promise.all([
        readOnly(w.address, VAULT_NAME, "get-admin"),
        readOnly(w.address, VAULT_NAME, "get-max-tvl"),
        readOnly(w.address, VAULT_NAME, "get-performance-fee-bps"),
        readOnly(w.address, VAULT_NAME, "get-fee-recipient"),
        readOnly(w.address, VAULT_NAME, "get-deposits-paused"),
        readOnly(w.address, VAULT_NAME, "get-strategy-paused"),
        readOnly(w.address, VAULT_NAME, "get-total-stx-balance"),
        readOnly(w.address, VAULT_NAME, "get-capital-at-strategy"),
        readOnly(w.address, VAULT_NAME, "get-total-pending-withdrawals"),
        readOnly(w.address, VAULT_NAME, "get-cumulative-realized-pnl"),
        readOnly(w.address, VAULT_NAME, "get-high-water-mark"),
      ]);
      console.log(`admin: ${admin?.value?.value}`);
      console.log(`max TVL: ${stxFmt(maxTvl?.value?.value ?? 0)} STX | performance fee: ${Number(feeBps?.value?.value ?? 0) / 100}% | fee recipient: ${feeRecipient?.value?.value}`);
      console.log(`deposits paused: ${depositsPaused?.value?.value} | strategy paused: ${strategyPaused?.value?.value}`);
      console.log(`vault balance: ${stxFmt(totalBal?.value?.value ?? 0)} STX | at strategy: ${stxFmt(atStrategy?.value?.value ?? 0)} STX | pending withdrawals: ${stxFmt(pendingWd?.value?.value ?? 0)} STX`);
      console.log(`cumulative realized P&L: ${stxFmt(pnl?.value?.value ?? 0)} STX | high-water mark: ${stxFmt(hwm?.value?.value ?? 0)} STX`);
      const supply = await readOnly(w.address, TOKEN_NAME, "get-total-supply");
      console.log(`vault shares outstanding: ${stxFmt(supply?.value?.value ?? 0)}`);
    } catch (err) {
      console.log(`(status read failed — contracts may not be deployed yet: ${(err as Error).message})`);
    }
    return;
  }

  if (cmd === "deploy-token") {
    requireLive(argv);
    const codeBody = readFileSync(TOKEN_PATH, "utf8");
    console.log(`deploying ${TOKEN_NAME} (${codeBody.length} bytes, fee ${stxFmt(DEPLOY_FEE)} STX)`);
    const tx = await makeContractDeploy({
      contractName: TOKEN_NAME,
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
    console.log("\nNEXT: npm run m1:vault -- deploy-vault --yes-mainnet  (deploy this SECOND, after the token)");
    return;
  }

  if (cmd === "deploy-vault") {
    requireLive(argv);
    const codeBody = readFileSync(VAULT_PATH, "utf8");
    console.log(`deploying ${VAULT_NAME} (${codeBody.length} bytes, fee ${stxFmt(DEPLOY_FEE)} STX)`);
    const tx = await makeContractDeploy({
      contractName: VAULT_NAME,
      codeBody,
      clarityVersion: 3,
      senderKey: w.key,
      network: "mainnet",
      fee: DEPLOY_FEE,
      postConditionMode: PostConditionMode.Deny,
    });
    const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`  txid: ${res.txid}`);
    await waitForTx(res.txid);
    console.log("\nNEXT: npm run m1:vault -- link --yes-mainnet  (one-time: point the token at this vault)");
    return;
  }

  if (cmd === "link") {
    requireLive(argv);
    console.log(`linking ${TOKEN_NAME} -> ${vaultId} (one-time, cannot be changed again — see token contract header)`);
    const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
    const tx = await makeContractCall({
      contractAddress: w.address,
      contractName: TOKEN_NAME,
      functionName: "set-vault-contract",
      functionArgs: [Cl.contractPrincipal(w.address, VAULT_NAME)],
      senderKey: w.key,
      network: "mainnet",
      fee: CALL_FEE,
      nonce,
      postConditionMode: PostConditionMode.Deny,
    });
    const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`  txid: ${res.txid}`);
    if (await waitForTx(res.txid)) console.log("\n✅ vault is live — npm run m1:vault -- status to confirm, then deposit/sweep as needed");
    return;
  }

  if (cmd === "deposit") {
    const stx = Number(argv[1]);
    if (!(stx > 0)) throw new Error("usage: deposit <stx-amount> --yes-mainnet");
    requireLive(argv);
    const amount = ustx(stx);
    console.log(`deposit: ${stx} STX`);
    const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
    const tx = await makeContractCall({
      contractAddress: w.address,
      contractName: VAULT_NAME,
      functionName: "deposit",
      functionArgs: [Cl.uint(amount)],
      senderKey: w.key,
      network: "mainnet",
      fee: CALL_FEE,
      nonce,
      postConditionMode: PostConditionMode.Allow, // the vault mints shares back; Allow, same rationale as other project contract calls
    });
    const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`  txid: ${res.txid}`);
    await waitForTx(res.txid);
    return;
  }

  if (cmd === "sweep-to-strategy" || cmd === "return-from-strategy") {
    const stx = Number(argv[1]);
    if (!(stx > 0)) throw new Error(`usage: ${cmd} <stx-amount> --yes-mainnet`);
    requireLive(argv);
    const amount = ustx(stx);
    const fn = cmd === "sweep-to-strategy" ? "sweep-to-strategy" : "return-from-strategy";
    console.log(`${cmd}: ${stx} STX`);
    const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
    const tx = await makeContractCall({
      contractAddress: w.address,
      contractName: VAULT_NAME,
      functionName: fn,
      functionArgs: [Cl.uint(amount)],
      senderKey: w.key,
      network: "mainnet",
      fee: CALL_FEE,
      nonce,
      postConditionMode: PostConditionMode.Allow,
    });
    const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`  txid: ${res.txid}`);
    await waitForTx(res.txid);
    return;
  }

  if (cmd === "request-withdrawal") {
    const shares = Number(argv[1]);
    if (!(shares > 0)) throw new Error("usage: request-withdrawal <shares> --yes-mainnet");
    requireLive(argv);
    const amount = ustx(shares); // shares use the same 6-decimal base as STX
    console.log(`request-withdrawal: ${shares} shares`);
    const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
    const tx = await makeContractCall({
      contractAddress: w.address,
      contractName: VAULT_NAME,
      functionName: "request-withdrawal",
      functionArgs: [Cl.uint(amount)],
      senderKey: w.key,
      network: "mainnet",
      fee: CALL_FEE,
      nonce,
      postConditionMode: PostConditionMode.Allow, // shares move into vault custody, no STX moves yet
    });
    const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`  txid: ${res.txid}`);
    await waitForTx(res.txid);
    return;
  }

  if (cmd === "claim-withdrawal") {
    const id = Number(argv[1]);
    if (!(id >= 0)) throw new Error("usage: claim-withdrawal <id> --yes-mainnet");
    requireLive(argv);
    console.log(`claim-withdrawal: id ${id}`);
    const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
    const tx = await makeContractCall({
      contractAddress: w.address,
      contractName: VAULT_NAME,
      functionName: "claim-withdrawal",
      functionArgs: [Cl.uint(id)],
      senderKey: w.key,
      network: "mainnet",
      fee: CALL_FEE,
      nonce,
      postConditionMode: PostConditionMode.Allow, // the vault pays out STX; Allow, same rationale as deposit
    });
    const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`  txid: ${res.txid}`);
    await waitForTx(res.txid);
    return;
  }

  // Pause switches. Instant and admin-only in the contract; they never touch withdrawal
  // requests or claims (claim-withdrawal reads no pause flag). Added 2026-10-08 so the
  // independent review's ask to pause deposits (pricing finding H3) can be honored without
  // hand-building a transaction. A pause moves no assets, so Deny mode with zero
  // post-conditions doubles as proof that nothing moved.
  if (["pause-deposits", "unpause-deposits", "pause-strategy", "unpause-strategy"].includes(cmd)) {
    requireLive(argv);
    console.log(`${cmd}`);
    const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
    const tx = await makeContractCall({
      contractAddress: w.address,
      contractName: VAULT_NAME,
      functionName: cmd,
      functionArgs: [],
      senderKey: w.key,
      network: "mainnet",
      fee: CALL_FEE,
      nonce,
      postConditionMode: PostConditionMode.Deny,
    });
    const res = await broadcastTransaction({ transaction: tx, network: "mainnet" });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`  txid: ${res.txid}`);
    await waitForTx(res.txid);
    return;
  }

  console.log(
    "usage: m1:vault -- status | deploy-token | deploy-vault | link | deposit <stx> | sweep-to-strategy <stx> | return-from-strategy <stx> | request-withdrawal <shares> | claim-withdrawal <id> | pause-deposits | unpause-deposits | pause-strategy | unpause-strategy   (broadcasts need --yes-mainnet)",
  );
}

main().catch((err) => {
  console.error("vault-cli failed:", err.message);
  process.exit(1);
});
