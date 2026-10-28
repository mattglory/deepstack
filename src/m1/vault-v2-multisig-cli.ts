// Vault v2 admin through a native Stacks 2-of-3 multisig (design note section 10: the admin is
// a 2-of-3, each key signing on its own device).
//
// The flow is split so no machine ever holds more than one key:
//   build      anyone: writes the UNSIGNED transaction to a file (no key needed)
//   sign       each key holder, on their own machine: adds ONE signature file next to it
//   broadcast  anyone: assembles the signatures in public-key order and broadcasts
// Non-sequential multisig (SIP-027) is used, so signers sign the same hash independently and
// in any order; the assembled transaction lists every key, signed or not, in the fixed order of
// MS_PUBKEYS.
//
// Keys and the multisig's public keys come from the environment:
//   MS_PUBKEYS   comma-separated compressed public keys, in a fixed order (defines the address)
//   MS_KEY_<n>   a private key, used only by `sign --key=<n>` on the machine that holds it
// On testnet `keys-new` creates three test keys in .env.testnet (gitignored) so the whole flow
// can be rehearsed on one machine; on mainnet the keys live on separate devices.
//
//   npm run m1:vault-v2-ms -- keys-new --testnet
//   npm run m1:vault-v2-ms -- address --testnet
//   npm run m1:vault-v2-ms -- build <contract-id> <function> [args...] --out=<file> --testnet
//   npm run m1:vault-v2-ms -- sign <file> --key=1 --testnet
//   npm run m1:vault-v2-ms -- broadcast <file> --testnet
//   npm run m1:vault-v2-ms -- run <contract-id> <function> [args...] --signers=1,2 --testnet   # testnet rehearsal: all three steps
//
// Arguments: digits are uint, anything starting with S is a principal (a contract principal
// when it contains a dot).
//
// Hardening after review (2026-10-27): only an allow-list of vault admin functions on the
// configured vault (MS_VAULT, or --vault=) can be built or signed; every transaction is Deny
// mode, with no post-conditions except sweep, which asserts the vault sends exactly the amount;
// `sign` decodes and prints the transaction and needs the function name typed back before it
// signs; each signature file records the transaction's pre-sign hash, and `broadcast` ignores
// any signature that doesn't match (stale files from an earlier run).
//
// Each signing device sets MS_VAULT itself; never copy it from the machine that built the
// transaction, or a tampered build could name a different vault (review 2026-10-28). For calls
// that hand a role to an address (admin, strategy, guardian, fee recipient), the signer also
// types the last 6 characters of that address.

import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join } from "node:path";
import {
  makeUnsignedContractCall, broadcastTransaction, deserializeTransaction, fetchNonce, TransactionSigner,
  createTransactionAuthField, createMessageSignature, createStacksPublicKey, addressFromVersionHash,
  addressToString, AddressVersion, PubKeyEncoding, PostConditionMode, privateKeyToPublic, randomPrivateKey,
  Cl, Pc, cvToString, type ClarityValue, type MultiSigSpendingCondition,
} from "@stacks/transactions";
import { loadDotenv, getNetwork, apiBase, type Network } from "./wallet.js";

const argv = process.argv.slice(2);
const flags = new Map(argv.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? "true"]; }));
const pos = argv.filter((a) => !a.startsWith("--"));
if (flags.has("testnet")) loadDotenv(".env.testnet");
loadDotenv();
const network: Network = getNetwork();
const FEE = 100_000n; // a 2-of-3 is larger than a single-sig call; 0.1 STX

// The only functions a multisig signer may be asked to sign: the vault's admin surface.
export const ADMIN_FUNCTIONS = new Set([
  "sweep", "pause-deposits", "pause-sweeps", "unpause-deposits", "unpause-sweeps",
  "queue-max-tvl", "queue-fee-bps", "queue-max-deploy-bps", "queue-fee-recipient", "queue-strategy",
  "queue-guardian", "queue-admin-change", "queue-resume-sweeps",
  "confirm-max-tvl", "confirm-fee-bps", "confirm-max-deploy-bps", "confirm-fee-recipient",
  "confirm-strategy", "confirm-guardian", "confirm-resume-sweeps", "accept-admin-change",
]);

function configuredVault(): string {
  const v = (flags.get("vault") ?? process.env.MS_VAULT ?? "").trim();
  if (!/^S[0-9A-Z]+\.[a-zA-Z][a-zA-Z0-9-]*$/.test(v)) throw new Error("set the vault contract id (MS_VAULT in the env, or --vault=ADDR.name)");
  return v;
}

function checkAllowed(contractId: string, fn: string): void {
  if (contractId !== configuredVault()) throw new Error(`refusing: ${contractId} is not the configured vault ${configuredVault()}`);
  if (!ADMIN_FUNCTIONS.has(fn)) throw new Error(`refusing: ${fn} is not an allow-listed vault admin function`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pubkeys(): string[] {
  const raw = process.env.MS_PUBKEYS?.trim();
  if (!raw) throw new Error("MS_PUBKEYS is not set (comma-separated compressed public keys, fixed order)");
  const ks = raw.split(",").map((k) => k.trim()).filter(Boolean);
  if (ks.length !== 3 || !ks.every((k) => /^0[23][0-9a-f]{64}$/i.test(k))) throw new Error("MS_PUBKEYS must hold exactly 3 compressed public keys");
  if (new Set(ks).size !== 3) throw new Error("MS_PUBKEYS has a duplicate key");
  return ks;
}

// Builds a throwaway unsigned transaction only to read the multisig's address hash, so the
// address always comes from the library's own derivation for this exact hash mode.
async function multisigAddress(keys: string[]): Promise<string> {
  const tx = await makeUnsignedContractCall({
    contractAddress: "SP000000000000000000002Q6VF78", contractName: "pox-4", functionName: "get-pox-info", functionArgs: [],
    numSignatures: 2, publicKeys: keys, useNonSequentialMultiSig: true, network, fee: 0n, nonce: 0n,
  });
  const version = network === "mainnet" ? AddressVersion.MainnetMultiSig : AddressVersion.TestnetMultiSig;
  return addressToString(addressFromVersionHash(version, tx.auth.spendingCondition.signer));
}

function parseArg(a: string): ClarityValue {
  if (/^\d+$/.test(a)) return Cl.uint(BigInt(a));
  if (/^S[0-9A-Z]+(\.[a-zA-Z][a-zA-Z0-9-]*)?$/.test(a)) return Cl.principal(a);
  throw new Error(`can't tell the type of argument '${a}' (digits = uint, S... = principal)`);
}

function sigFiles(txFile: string): string[] {
  const dir = dirname(txFile) || ".";
  const base = basename(txFile);
  return readdirSync(dir).filter((f) => f.startsWith(`${base}.sig`) && f.endsWith(".json")).map((f) => join(dir, f));
}

async function waitForTx(txid: string): Promise<boolean> {
  process.stdout.write("  confirming");
  for (let i = 0; i < 60; i++) {
    await sleep(6000);
    try {
      const res = await fetch(`${apiBase(network)}/extended/v1/tx/${txid}`);
      if (res.ok) {
        const j = (await res.json()) as { tx_status?: string; tx_result?: { repr?: string } };
        if (j.tx_status && j.tx_status !== "pending") {
          console.log(`\n  status: ${j.tx_status}  ${j.tx_result?.repr ?? ""}`);
          return j.tx_status === "success";
        }
      }
    } catch { /* keep polling */ }
    process.stdout.write(".");
  }
  console.log("\n  still pending after 6 minutes");
  return false;
}

async function build(contractId: string, fn: string, args: string[], out: string): Promise<void> {
  const [contractAddress, contractName] = contractId.split(".");
  if (!contractName) throw new Error("contract id must be ADDRESS.name");
  checkAllowed(contractId, fn);
  const keys = pubkeys();
  const address = await multisigAddress(keys);
  const nonce = await fetchNonce({ address, network });
  const tx = await makeUnsignedContractCall({
    contractAddress, contractName, functionName: fn, functionArgs: args.map(parseArg),
    numSignatures: 2, publicKeys: keys, useNonSequentialMultiSig: true,
    network, fee: FEE, nonce,
    // Deny mode: admin calls move no assets, except sweep, which must send exactly the amount.
    postConditionMode: PostConditionMode.Deny,
    postConditions: fn === "sweep" ? [Pc.principal(contractId).willSendEq(BigInt(args[0])).ustx()] : [],
  });
  writeFileSync(out, tx.serialize() + "\n");
  console.log(`built ${fn}(${args.join(" ")}) on ${contractId}\n  from multisig ${address}, nonce ${nonce}, fee ${Number(FEE) / 1e6} STX\n  unsigned transaction: ${out}`);
}

function describe(tx: ReturnType<typeof deserializeTransaction>): { contractId: string; fn: string; text: string } {
  const p = tx.payload as any;
  if (!p?.functionName) throw new Error("not a contract call");
  const contractId = `${addressToString(p.contractAddress)}.${p.contractName.content}`;
  const fn = p.functionName.content as string;
  const sc = tx.auth.spendingCondition as MultiSigSpendingCondition;
  const net = tx.chainId === 1 ? "MAINNET" : `testnet (chain ${tx.chainId})`;
  const mode = tx.postConditionMode === PostConditionMode.Deny ? "deny" : "ALLOW";
  const text = [
    `  network:          ${net}`,
    `  contract:         ${contractId}`,
    `  function:         ${fn}`,
    `  arguments:        ${(p.functionArgs as ClarityValue[]).map((a) => cvToString(a)).join(", ") || "(none)"}`,
    `  nonce / fee:      ${sc.nonce} / ${Number(sc.fee) / 1e6} STX`,
    `  post-conditions:  ${mode} mode, ${tx.postConditions.values.length} condition(s)`,
  ].join("\n");
  return { contractId, fn, text };
}

const PRINCIPAL_FUNCTIONS = new Set(["queue-admin-change", "queue-strategy", "queue-guardian", "queue-fee-recipient"]);

async function confirmTyped(expected: string, principal: string | null): Promise<boolean> {
  // One line iterator for both answers: rl.question() twice drops a line that arrives early.
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string) => { process.stdout.write(q); const r = await lines.next(); return r.done ? "" : String(r.value).trim(); };
  let ok = (await ask(`Type the function name (${expected}) to sign it, anything else cancels: `)) === expected;
  if (ok && principal) {
    console.log(`\n  this hands a role to: ${principal}`);
    ok = (await ask(`Type the LAST 6 characters of that address: `)) === principal.slice(-6);
  }
  rl.close();
  console.log("");
  return ok;
}

async function sign(file: string, keyN: string, confirm = true): Promise<void> {
  const key = process.env[`MS_KEY_${keyN}`]?.trim();
  if (!key) throw new Error(`MS_KEY_${keyN} is not set on this machine`);
  const pub = privateKeyToPublic(key) as string;
  if (!pubkeys().includes(pub)) throw new Error(`MS_KEY_${keyN} is not one of the multisig's keys`);
  const tx = deserializeTransaction(readFileSync(file, "utf8").trim());
  const sc = tx.auth.spendingCondition as MultiSigSpendingCondition;
  if (sc.fields.length !== 0) throw new Error("expected an unsigned transaction (it already has auth fields)");
  // Decode and show what is being approved; refuse anything outside the allow-list.
  const d = describe(tx);
  checkAllowed(d.contractId, d.fn);
  if (tx.postConditionMode !== PostConditionMode.Deny) throw new Error("refusing: not deny mode");
  console.log(`About to sign with key ${keyN}:\n${d.text}`);
  const p = tx.payload as any;
  const principal = PRINCIPAL_FUNCTIONS.has(d.fn) && p.functionArgs?.[0] ? cvToString(p.functionArgs[0]) : null;
  if (confirm && !(await confirmTyped(d.fn, principal))) throw new Error("cancelled: nothing signed");
  const preSignHash = tx.signBegin();
  // Non-sequential: every signer signs the same initial hash, so this signature is valid on its
  // own and can be combined with the others in any order.
  const signer = new TransactionSigner(tx);
  signer.signOrigin(key);
  const field = sc.fields[0];
  const sig = (field.contents as { data: string }).data;
  const out = `${file}.sig${keyN}.json`;
  writeFileSync(out, JSON.stringify({ pubkey: pub, signature: sig, preSignHash }, null, 2) + "\n");
  console.log(`signed with key ${keyN} (${pub.slice(0, 10)}…)\n  signature: ${out}`);
}

async function broadcast(file: string): Promise<boolean> {
  const keys = pubkeys();
  const tx = deserializeTransaction(readFileSync(file, "utf8").trim());
  const sc = tx.auth.spendingCondition as MultiSigSpendingCondition;
  const d = describe(tx);
  checkAllowed(d.contractId, d.fn);
  const expectedHash = tx.signBegin();
  const sigs = new Map<string, string>();
  for (const f of sigFiles(file)) {
    const j = JSON.parse(readFileSync(f, "utf8")) as { pubkey: string; signature: string; preSignHash?: string };
    if (j.preSignHash !== expectedHash) { console.log(`ignoring ${f}: it was signed for a different transaction`); continue; }
    if (!keys.includes(j.pubkey)) throw new Error(`${f} is from a key outside the multisig`);
    sigs.set(j.pubkey, j.signature);
  }
  console.log(`Broadcasting:\n${d.text}`);
  if (sigs.size < sc.signaturesRequired) throw new Error(`need ${sc.signaturesRequired} signatures, found ${sigs.size}`);
  sc.fields = keys.map((k) =>
    sigs.has(k)
      ? createTransactionAuthField(PubKeyEncoding.Compressed, createMessageSignature(sigs.get(k)!))
      : createTransactionAuthField(PubKeyEncoding.Compressed, createStacksPublicKey(k)),
  );
  const res = await broadcastTransaction({ transaction: tx, network });
  if (!("txid" in res)) throw new Error(`broadcast failed: ${JSON.stringify(res)}`);
  console.log(`broadcast ${sigs.size}-of-${keys.length}: txid ${res.txid}`);
  return waitForTx(res.txid);
}

async function main(): Promise<void> {
  const cmd = pos[0];
  if (network === "mainnet" && cmd !== "address" && cmd !== "build" && cmd !== "sign" && !flags.has("yes-mainnet")) {
    throw new Error("refusing on MAINNET without --yes-mainnet");
  }
  if (cmd === "keys-new") {
    if (network !== "testnet") throw new Error("keys-new is testnet only: mainnet keys are created on their own devices");
    if (process.env.MS_PUBKEYS || process.env.MS_KEY_1) throw new Error("test multisig keys already exist in .env.testnet");
    const ks = [randomPrivateKey(), randomPrivateKey(), randomPrivateKey()];
    const pubs = ks.map((k) => privateKeyToPublic(k) as string);
    if (!existsSync(".env.testnet")) throw new Error(".env.testnet not found");
    appendFileSync(".env.testnet", `\n# 2-of-3 test multisig (testnet only)\nMS_PUBKEYS=${pubs.join(",")}\n${ks.map((k, i) => `MS_KEY_${i + 1}=${k}`).join("\n")}\n`, { mode: 0o600 });
    process.env.MS_PUBKEYS = pubs.join(",");
    console.log(`created 3 test keys in .env.testnet\nmultisig address: ${await multisigAddress(pubs)}`);
    return;
  }
  if (cmd === "address") return void console.log(await multisigAddress(pubkeys()));
  if (cmd === "build") return build(pos[1], pos[2], pos.slice(3), flags.get("out") ?? "ms-tx.hex");
  if (cmd === "sign") return sign(pos[1], flags.get("key") ?? "");
  if (cmd === "broadcast") { if (!(await broadcast(pos[1]))) process.exitCode = 1; return; }
  if (cmd === "run") {
    if (network !== "testnet") throw new Error("run is a testnet rehearsal; on mainnet use build / sign / broadcast on separate devices");
    const out = flags.get("out") ?? `ms-${pos[2]}-${Date.now()}.hex`;
    await build(pos[1], pos[2], pos.slice(3), out);
    // Testnet rehearsal with test keys: the details still print, the typed confirmation is skipped.
    for (const n of (flags.get("signers") ?? "1,2").split(",")) await sign(out, n, false);
    if (!(await broadcast(out))) process.exitCode = 1;
    return;
  }
  console.log("unknown command. See the header of src/m1/vault-v2-multisig-cli.ts for usage.");
  process.exitCode = 1;
}

main().catch((e) => { console.error(`error: ${(e as Error).message}`); process.exitCode = 1; });
