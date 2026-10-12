// Vault v2 operations: deploy and drive contracts/deepstack-vault-v2.clar and its token.
//
// Network: --testnet loads .env.testnet (gitignored, test keys only) before anything else.
// Without it the normal .env is used. Any mainnet broadcast still requires --yes-mainnet.
// Strategy-only calls (return, recover) sign with STRATEGY_PRIVATE_KEY; everything else with
// STACKS_PRIVATE_KEY (the deployer, and the admin until initialize hands that role on).
//
//   npm run m1:vault-v2 -- status --testnet
//   npm run m1:vault-v2 -- deploy --testnet             # token, then vault, then the one-time link
//   npm run m1:vault-v2 -- initialize --testnet [admin strategy guardian fee-recipient]
//   npm run m1:vault-v2 -- deposit 100 --testnet
//   npm run m1:vault-v2 -- request <shares|all> --testnet
//   npm run m1:vault-v2 -- claim <request-id> --testnet
//   npm run m1:vault-v2 -- claim-deposit <epoch> | claim-epoch-withdrawal <epoch> --testnet
//   npm run m1:vault-v2 -- cancel-deposit | cancel-withdrawal --testnet
//   npm run m1:vault-v2 -- sweep 50 --testnet           # admin
//   npm run m1:vault-v2 -- return 55 --testnet          # strategy key
//   npm run m1:vault-v2 -- recover 10 --testnet         # strategy key, after a write-off
//   npm run m1:vault-v2 -- settle-overdue --testnet     # anyone, after MAX-EPOCH
//   npm run m1:vault-v2 -- pause-deposits | pause-sweeps | unpause-deposits | unpause-sweeps --testnet
//   npm run m1:vault-v2 -- queue max-tvl|fee-bps|max-deploy-bps <n> --testnet
//   npm run m1:vault-v2 -- queue fee-recipient|strategy|guardian|admin <principal> --testnet
//   npm run m1:vault-v2 -- queue resume-sweeps --testnet
//   npm run m1:vault-v2 -- confirm max-tvl|fee-bps|max-deploy-bps|fee-recipient|strategy|guardian|resume-sweeps --testnet
//   npm run m1:vault-v2 -- accept-admin --testnet       # signed by the proposed admin
//   npm run m1:vault-v2 -- send-test-stx <address> <stx> --testnet   # testnet only
//
// Contract calls here use Allow mode: this is operator tooling. Deny-mode post-conditions are
// exercised by the deposit site, which is what the testnet claim test (M2) must prove.

import { readFileSync } from "node:fs";
import {
  makeContractDeploy, makeContractCall, makeSTXTokenTransfer, broadcastTransaction,
  fetchCallReadOnlyFunction, fetchNonce, cvToJSON, Cl, ClarityValue, PostConditionMode,
  getAddressFromPrivateKey,
} from "@stacks/transactions";
import { loadDotenv, getWallet, apiBase, type Network } from "./wallet.js";
import { hiroHeaders } from "./rpc.js";

const VAULT = "deepstack-vault-v2";
const TOKEN = "deepstack-vault-v2-token";
const VAULT_PATH = "contracts/deepstack-vault-v2.clar";
const TOKEN_PATH = "contracts/deepstack-vault-v2-token.clar";
const CALL_FEE = 50_000n;
const DEPLOY_FEE = 600_000n;
const TRAIT_TESTNET = "sip-010-trait-ft-standard-v-1-1";
const TRAIT_TESTNET_PATH = "contracts/testnet/sip-010-trait-ft-standard-v-1-1.clar"; // the v2 vault is ~27 KB; sized with margin, as for v1

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const pos = argv.filter((a) => !a.startsWith("--"));
if (flags.has("--testnet")) loadDotenv(".env.testnet");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ustx = (stx: string) => {
  const n = Number(stx);
  if (!(n > 0)) throw new Error(`bad STX amount: ${stx}`);
  return BigInt(Math.round(n * 1e6));
};
const fmtStx = (u: bigint | number | string) => (Number(u) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });
const fmtShares = (u: bigint | number | string) => (Number(u) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 });

async function api(network: Network, path: string, init?: RequestInit): Promise<any> {
  const base = apiBase(network);
  const res = await fetch(base + path, { ...init, headers: { ...(init?.headers ?? {}), ...hiroHeaders(base) } });
  if (!res.ok) throw new Error(`${path} failed: HTTP ${res.status}`);
  return res.json();
}

async function waitForTx(network: Network, txid: string): Promise<boolean> {
  process.stdout.write("  confirming");
  for (let i = 0; i < 60; i++) {
    await sleep(6000);
    process.stdout.write(".");
    try {
      const j = await api(network, `/extended/v1/tx/${txid}`);
      if (j.tx_status && j.tx_status !== "pending") {
        console.log(`\n  status: ${j.tx_status}${j.tx_result?.repr ? `  ${j.tx_result.repr}` : ""}`);
        return j.tx_status === "success";
      }
    } catch {
      // not indexed yet, or a transient API error: keep polling
    }
  }
  console.log("\n  status: still pending, check the explorer");
  return false;
}

async function main() {
  const cmd = pos[0];
  const w = await getWallet();
  const network = w.network;
  if (network === "mainnet" && !flags.has("--yes-mainnet") && !["status"].includes(cmd ?? "")) {
    console.log("refusing: this would broadcast on MAINNET. Add --yes-mainnet, or use --testnet.");
    process.exit(1);
  }
  const strategyKey = process.env.STRATEGY_PRIVATE_KEY?.trim();
  const strategyAddr = strategyKey ? getAddressFromPrivateKey(strategyKey, network) : null;
  const vaultId = `${w.address}.${VAULT}`;
  console.log(`network: ${network} | operator: ${w.address} | vault: ${vaultId}${strategyAddr ? ` | strategy key: ${strategyAddr}` : ""}\n`);

  const ro = async (fn: string, args: ClarityValue[] = [], contract = VAULT) =>
    cvToJSON(
      await fetchCallReadOnlyFunction({
        contractAddress: w.address, contractName: contract, functionName: fn, functionArgs: args,
        network, senderAddress: w.address, client: { baseUrl: apiBase(network) },
      }),
    );

  const send = async (fn: string, args: ClarityValue[], key = w.key) => {
    const sender = getAddressFromPrivateKey(key, network);
    const nonce = await fetchNonce({ address: sender, network, client: { baseUrl: apiBase(network) } });
    const tx = await makeContractCall({
      contractAddress: w.address, contractName: VAULT, functionName: fn, functionArgs: args,
      senderKey: key, network, fee: CALL_FEE, nonce, postConditionMode: PostConditionMode.Allow,
    });
    const res = await broadcastTransaction({ transaction: tx, network });
    if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
    console.log(`${fn}: txid ${res.txid}`);
    const ok = await waitForTx(network, res.txid);
    if (!ok) process.exitCode = 1;
    return ok;
  };
  const asStrategy = () => {
    if (!strategyKey) throw new Error("STRATEGY_PRIVATE_KEY is not set");
    return strategyKey;
  };

  if (cmd === "status") {
    const s = (await ro("get-state")).value;
    const v = (k: string) => s[k]?.value;
    console.log(`initialized: ${v("initialized")} | admin: ${v("admin")} | strategy: ${v("strategy")}`);
    console.log(`guardian: ${v("guardian")} | fee recipient: ${v("fee-recipient")}`);
    console.log(`max TVL ${fmtStx(v("max-tvl"))} STX | fee ${Number(v("fee-bps")) / 100}% | sweep cap ${Number(v("max-deploy-bps")) / 100}%`);
    console.log(`deposits paused: ${v("deposits-paused")} | sweeps paused: ${v("sweeps-paused")} | no change pending: ${v("no-change-pending")}`);
    console.log(`epoch ${v("current-epoch")} | open: ${v("epoch-open")} | overdue: ${v("overdue")}`);
    console.log(`vault STX ${fmtStx(v("vault-stx"))} | at strategy ${fmtStx(v("capital-at-strategy"))} | pending deposits ${fmtStx(v("pending-deposits"))} | ring-fenced ${fmtStx(v("ringfenced"))}`);
    console.log(`total assets ${fmtStx(v("total-assets"))} STX | supply ${fmtShares(v("supply"))} dsSTX2 | price ${(Number(v("pps")) / 1e15).toFixed(9)} (1.0 at launch)`);
    console.log(`realized P&L ${fmtStx(v("realized-pnl"))} STX | high-water price ${(Number(v("hwm-pps")) / 1e15).toFixed(9)} | sweep reference ${(Number(v("sweep-ref-pps")) / 1e15).toFixed(9)}`);
    const bal = await ro("get-balance", [Cl.principal(w.address)], TOKEN);
    console.log(`operator shares: ${fmtShares(bal.value.value)}`);
    return;
  }

  if (cmd === "deploy") {
    // The token implements the mainnet SIP-010 trait (SM1793...), which does not exist on
    // testnet. On testnet only, deploy a verbatim copy of that trait from the operator first and
    // point the token at it. The mainnet sources are never modified.
    const MAINNET_TRAIT = "'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.sip-010-trait-ft-standard-v-1-1";
    const plan: [string, string][] = network === "testnet"
      ? [[TRAIT_TESTNET, TRAIT_TESTNET_PATH], [TOKEN, TOKEN_PATH], [VAULT, VAULT_PATH]]
      : [[TOKEN, TOKEN_PATH], [VAULT, VAULT_PATH]];
    const skip = new Set(pos.slice(1)); // e.g. "deploy sip-010-trait-ft-standard-v-1-1" to resume after a partial run
    for (const [name, path] of plan) {
      if (skip.has(name)) { console.log(`skipping ${name} (already deployed)`); continue; }
      let codeBody = readFileSync(path, "utf8");
      if (network === "testnet" && name === TOKEN) {
        if (!codeBody.includes(MAINNET_TRAIT)) throw new Error("token no longer references the expected trait");
        codeBody = codeBody.replace(MAINNET_TRAIT, `.${TRAIT_TESTNET}`);
      }
      const nonce = await fetchNonce({ address: w.address, network, client: { baseUrl: apiBase(network) } });
      const tx = await makeContractDeploy({
        contractName: name, codeBody, clarityVersion: 3, senderKey: w.key, network,
        fee: DEPLOY_FEE, nonce, postConditionMode: PostConditionMode.Deny,
      });
      const res = await broadcastTransaction({ transaction: tx, network });
      if (!("txid" in res)) throw new Error(`deploy ${name} failed: ${JSON.stringify(res)}`);
      console.log(`deploy ${name} (${codeBody.length} bytes): txid ${res.txid}`);
      if (!(await waitForTx(network, res.txid))) throw new Error(`deploy ${name} did not succeed`);
    }
    const nonce = await fetchNonce({ address: w.address, network, client: { baseUrl: apiBase(network) } });
    const link = await makeContractCall({
      contractAddress: w.address, contractName: TOKEN, functionName: "set-vault-contract",
      functionArgs: [Cl.contractPrincipal(w.address, VAULT)], senderKey: w.key, network,
      fee: CALL_FEE, nonce, postConditionMode: PostConditionMode.Deny,
    });
    const res = await broadcastTransaction({ transaction: link, network });
    if (!("txid" in res)) throw new Error(`link failed: ${JSON.stringify(res)}`);
    console.log(`link token -> vault: txid ${res.txid}`);
    await waitForTx(network, res.txid);
    console.log("\nNEXT: initialize");
    return;
  }

  if (cmd === "initialize") {
    const [admin, strategy, guardian, feeTo] = [pos[1] ?? w.address, pos[2] ?? strategyAddr, pos[3] ?? w.address, pos[4] ?? w.address];
    if (!strategy) throw new Error("no strategy address: pass it, or set STRATEGY_PRIVATE_KEY");
    console.log(`admin ${admin}\nstrategy ${strategy}\nguardian ${guardian}\nfee recipient ${feeTo}`);
    await send("initialize", [Cl.principal(admin), Cl.principal(strategy), Cl.principal(guardian), Cl.principal(feeTo)]);
    return;
  }

  if (cmd === "deposit") return void (await send("deposit", [Cl.uint(ustx(pos[1]))]));
  if (cmd === "request") {
    let shares: bigint;
    if (pos[1] === "all") shares = BigInt((await ro("get-balance", [Cl.principal(w.address)], TOKEN)).value.value);
    else shares = BigInt(pos[1] ?? "0");
    if (shares <= 0n) throw new Error("usage: request <shares in base units|all>");
    console.log(`requesting ${fmtShares(shares)} dsSTX2`);
    return void (await send("request-withdrawal", [Cl.uint(shares)]));
  }
  if (cmd === "claim") return void (await send("claim-withdrawal", [Cl.uint(BigInt(pos[1]))]));
  if (cmd === "claim-deposit") return void (await send("claim-deposit", [Cl.uint(BigInt(pos[1]))]));
  if (cmd === "claim-epoch-withdrawal") return void (await send("claim-epoch-withdrawal", [Cl.uint(BigInt(pos[1]))]));
  if (cmd === "cancel-deposit" || cmd === "cancel-withdrawal") return void (await send(cmd, []));
  if (cmd === "sweep") return void (await send("sweep", [Cl.uint(ustx(pos[1]))]));
  if (cmd === "return") {
    const amt = pos[1] === "0" ? 0n : ustx(pos[1]);
    return void (await send("return-from-strategy", [Cl.uint(amt)], asStrategy()));
  }
  if (cmd === "recover") return void (await send("recover-from-strategy", [Cl.uint(ustx(pos[1]))], asStrategy()));
  if (cmd === "settle-overdue") return void (await send("settle-overdue", []));
  if (["pause-deposits", "pause-sweeps", "unpause-deposits", "unpause-sweeps"].includes(cmd ?? "")) return void (await send(cmd!, []));

  if (cmd === "queue" || cmd === "confirm") {
    const param = pos[1];
    const uintParams = ["max-tvl", "fee-bps", "max-deploy-bps"];
    const principalParams = ["fee-recipient", "strategy", "guardian", "admin"];
    if (cmd === "queue") {
      if (param === "resume-sweeps") return void (await send("queue-resume-sweeps", []));
      if (param === "admin") return void (await send("queue-admin-change", [Cl.principal(pos[2])]));
      if (uintParams.includes(param)) return void (await send(`queue-${param}`, [Cl.uint(BigInt(param === "max-tvl" ? ustx(pos[2]) : BigInt(pos[2])))]));
      if (principalParams.includes(param)) return void (await send(`queue-${param}`, [Cl.principal(pos[2])]));
    } else {
      if (param === "resume-sweeps") return void (await send("confirm-resume-sweeps", []));
      if ([...uintParams, ...principalParams].includes(param) && param !== "admin") return void (await send(`confirm-${param}`, []));
    }
    throw new Error(`unknown parameter: ${param}`);
  }
  if (cmd === "accept-admin") return void (await send("accept-admin-change", []));

  if (cmd === "send-test-stx") {
    if (network !== "testnet") throw new Error("send-test-stx is testnet only");
    const nonce = await fetchNonce({ address: w.address, network, client: { baseUrl: apiBase(network) } });
    const tx = await makeSTXTokenTransfer({ recipient: pos[1], amount: ustx(pos[2]), senderKey: w.key, network, fee: CALL_FEE, nonce });
    const res = await broadcastTransaction({ transaction: tx, network });
    if (!("txid" in res)) throw new Error(`transfer failed: ${JSON.stringify(res)}`);
    console.log(`sent ${pos[2]} test STX to ${pos[1]}: txid ${res.txid}`);
    await waitForTx(network, res.txid);
    return;
  }

  console.log("unknown command. See the header of src/m1/vault-v2-cli.ts for usage.");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("vault-v2-cli failed:", (err as Error).message);
  process.exit(1);
});
