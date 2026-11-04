// Vault v2 deploy safety (roadmap C10; assessment N3/DSA-16, F-14/DSA-26). Pure logic behind
// `vault-v2-cli.ts plan | deploy | verify | initialize`, kept free of side effects so it can be
// tested offline: every network read, broadcast and git call is injected.
//
// What it enforces:
//  - an explicit network flag that matches the resolved wallet network AND the node's
//    /v2/info network_id, before anything is broadcast;
//  - all four roles given explicitly; admin and strategy never the deployer; admin, strategy and
//    guardian distinct (mirrors the contract's roles-valid); admin never the agent hot wallet
//    (testnet override only); on mainnet the admin must be a native multisig (SM...);
//  - a reviewable plan built from the PINNED commit's files (git show, not the working tree),
//    with each source's sha256, refused on a dirty tree; mainnet also needs --plan-sha;
//  - deploy, link and initialize on consecutive nonces, broadcast back to back;
//  - a post-deploy verify of the on-chain source hashes and roles, recorded to a JSON file.

import { createHash } from "node:crypto";
import {
  makeContractDeploy, makeContractCall, createAddress, Cl, Pc, PostConditionMode,
  type ClarityValue, type PostCondition, type StacksTransactionWire,
} from "@stacks/transactions";

export type Network = "mainnet" | "testnet";

export const VAULT = "deepstack-vault-v2";
export const TOKEN = "deepstack-vault-v2-token";
export const VAULT_PATH = "contracts/deepstack-vault-v2.clar";
export const TOKEN_PATH = "contracts/deepstack-vault-v2-token.clar";
export const TRAIT_TESTNET = "sip-010-trait-ft-standard-v-1-1";
export const TRAIT_TESTNET_PATH = "contracts/testnet/sip-010-trait-ft-standard-v-1-1.clar";
export const MAINNET_TRAIT = "'SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.sip-010-trait-ft-standard-v-1-1";
export const DEPLOY_FEE = 600_000n; // the v2 vault is ~27 KB; sized with margin, as for v1
export const CALL_FEE = 50_000n;
export const MULTISIG_FEE_CAP = 500_000n; // 0.5 STX: refuse to sign a multisig tx above this fee

// /v2/info network_id, which is also the transaction chain id.
export const NETWORK_ID: Record<Network, number> = { mainnet: 1, testnet: 0x80000000 };

// The agent's hot wallet (its 24-word phrase was exposed: review-38-41 N1) and its testnet twin
// (same key, testnet version byte; docs/VAULT_V2_TESTNET.md "ST23PF43...DK647").
export const AGENT_HOT_WALLET: Record<Network, string> = {
  mainnet: "SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60",
  testnet: "ST23PF43T06AH0BA2XD7XYKH16GECH242S31DK647",
};
export const HOT_ADMIN_OVERRIDE = "--allow-agent-hot-wallet-as-admin-TESTNET-ONLY";

// c32 address versions: single-sig SP/ST, native multisig SM/SN.
const VERSIONS: Record<Network, { single: number; multisig: number }> = {
  mainnet: { single: 22, multisig: 20 },
  testnet: { single: 26, multisig: 21 },
};

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

// ---- network --------------------------------------------------------------------------------

/** Exactly one of --testnet / --mainnet, and it must match the network the wallet resolved. */
export function networkFromFlags(flags: Set<string>, resolved: Network): Network {
  const t = flags.has("--testnet"), m = flags.has("--mainnet");
  if (t === m) throw new Error("refusing: pass exactly one of --testnet or --mainnet");
  const chosen: Network = t ? "testnet" : "mainnet";
  if (chosen !== resolved) throw new Error(`refusing: --${chosen} given but the environment resolves to ${resolved} (STACKS_NETWORK)`);
  return chosen;
}

/** The node must report the chosen network before anything is broadcast to it. */
export async function assertNodeNetwork(network: Network, fetchJson: (path: string) => Promise<any>): Promise<void> {
  const info = await fetchJson("/v2/info");
  const id = Number(info?.network_id);
  if (id !== NETWORK_ID[network]) {
    throw new Error(`refusing: node network_id ${info?.network_id} is not ${network} (${NETWORK_ID[network]})`);
  }
}

export function assertTxChain(chainId: number, network: Network): void {
  if (chainId !== NETWORK_ID[network]) throw new Error(`refusing: transaction chain id ${chainId} is not ${network} (${NETWORK_ID[network]})`);
}

export function assertFeeCap(fee: bigint, cap = MULTISIG_FEE_CAP): void {
  if (fee > cap) throw new Error(`refusing: fee ${fee} uSTX is above the cap of ${cap} uSTX`);
}

// ---- principals -----------------------------------------------------------------------------

/** Version of a standard or contract principal's address; throws on a malformed one. */
function versionOf(principal: string): number {
  const addr = principal.split(".")[0];
  try { return createAddress(addr).version; } catch { throw new Error(`not a Stacks principal: ${principal}`); }
}

export function isMultisig(principal: string, network: Network): boolean {
  return !principal.includes(".") && versionOf(principal) === VERSIONS[network].multisig;
}

function assertOnNetwork(role: string, principal: string, network: Network): void {
  const v = versionOf(principal);
  const ok = v === VERSIONS[network].single || v === VERSIONS[network].multisig;
  if (!ok) throw new Error(`refusing: ${role} ${principal} is not a ${network} principal`);
}

export interface Principals { admin: string; strategy: string; guardian: string; feeRecipient: string }

export function validatePrincipals(
  p: Partial<Principals>,
  ctx: { network: Network; deployer: string; allowHotAdmin?: boolean },
): Principals {
  const roles = ["admin", "strategy", "guardian", "feeRecipient"] as const;
  for (const r of roles) if (!p[r]?.trim()) throw new Error(`refusing: ${r} must be given explicitly (no defaults)`);
  const q = Object.fromEntries(roles.map((r) => [r, p[r]!.trim()])) as unknown as Principals;
  for (const r of roles) assertOnNetwork(r, q[r], ctx.network);
  // Mirrors the contract's roles-valid [assessment W-03].
  if (q.admin === ctx.deployer) throw new Error("refusing: admin is the deployer");
  if (q.strategy === ctx.deployer) throw new Error("refusing: strategy is the deployer");
  if (q.admin === q.strategy) throw new Error("refusing: admin and strategy are the same principal");
  if (q.admin === q.guardian) throw new Error("refusing: admin and guardian are the same principal");
  if (q.strategy === q.guardian) throw new Error("refusing: strategy and guardian are the same principal");
  if (q.admin === AGENT_HOT_WALLET[ctx.network]) {
    if (ctx.network === "mainnet" || !ctx.allowHotAdmin) {
      throw new Error(`refusing: admin is the agent hot wallet ${q.admin}${ctx.network === "testnet" ? ` (testnet override: ${HOT_ADMIN_OVERRIDE})` : ""}`);
    }
  }
  if (ctx.network === "mainnet" && !isMultisig(q.admin, "mainnet")) {
    throw new Error(`refusing: on mainnet the admin must be a native multisig (SM...), got ${q.admin}`);
  }
  return q;
}

// ---- git and sources ------------------------------------------------------------------------

export interface GitState { commit: string; clean: boolean; dirty: string[] }

/** `git` runs one git command and returns stdout. */
export function gitState(git: (args: string[]) => string): GitState {
  const commit = git(["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`unexpected commit id: ${commit}`);
  const dirty = git(["status", "--porcelain"]).split("\n").filter((l) => l.trim());
  return { commit, clean: dirty.length === 0, dirty };
}

export interface Source { name: string; path: string; repoSha256: string; deployedSha256: string; bytes: number; substituted: boolean; code: string }

/** The testnet token's impl-trait points at the testnet trait copy (vault-v2-cli history). */
export function substituteTrait(code: string): string {
  if (!code.includes(MAINNET_TRAIT)) throw new Error("token no longer references the expected trait");
  return code.replace(MAINNET_TRAIT, `.${TRAIT_TESTNET}`);
}

/** The exact bytes to deploy, read from the pinned commit (`git show <commit>:<path>`). */
export function sourcesAt(network: Network, commit: string, git: (args: string[]) => string): Source[] {
  const list: [string, string][] = network === "testnet"
    ? [[TRAIT_TESTNET, TRAIT_TESTNET_PATH], [TOKEN, TOKEN_PATH], [VAULT, VAULT_PATH]]
    : [[TOKEN, TOKEN_PATH], [VAULT, VAULT_PATH]];
  return list.map(([name, path]) => {
    const repo = git(["show", `${commit}:${path}`]);
    const substituted = network === "testnet" && name === TOKEN;
    const code = substituted ? substituteTrait(repo) : repo;
    return { name, path, repoSha256: sha256(repo), deployedSha256: sha256(code), bytes: Buffer.byteLength(code), substituted, code };
  });
}

// ---- plan -----------------------------------------------------------------------------------

export interface PlannedTx { nonce: string; kind: "deploy" | "call"; contract: string; function?: string; args?: string[] }
export interface DeployPlan {
  schema: "deepstack-vault-v2-deploy-plan/1";
  network: Network;
  networkId: number;
  deployer: string;
  git: { commit: string; clean: boolean };
  contracts: Omit<Source, "code">[];
  principals: Principals;
  vaultId: string;
  tokenId: string;
  transactions: PlannedTx[];
  fees: { deploy: string; call: string };
  overrides: { hotWalletAdmin: boolean };
}

export function buildPlan(a: {
  network: Network; deployer: string; git: GitState; sources: Source[]; principals: Principals;
  startNonce: bigint; hotWalletAdmin?: boolean;
}): DeployPlan {
  const vaultId = `${a.deployer}.${VAULT}`;
  const tokenId = `${a.deployer}.${TOKEN}`;
  let n = a.startNonce;
  const txs: PlannedTx[] = a.sources.map((s) => ({ nonce: String(n++), kind: "deploy", contract: `${a.deployer}.${s.name}` }));
  txs.push({ nonce: String(n++), kind: "call", contract: tokenId, function: "set-vault-contract", args: [vaultId] });
  const p = a.principals;
  txs.push({ nonce: String(n++), kind: "call", contract: vaultId, function: "initialize", args: [p.admin, p.strategy, p.guardian, p.feeRecipient] });
  return {
    schema: "deepstack-vault-v2-deploy-plan/1",
    network: a.network,
    networkId: NETWORK_ID[a.network],
    deployer: a.deployer,
    git: { commit: a.git.commit, clean: a.git.clean },
    contracts: a.sources.map(({ code: _code, ...rest }) => rest),
    principals: { admin: p.admin, strategy: p.strategy, guardian: p.guardian, feeRecipient: p.feeRecipient },
    vaultId,
    tokenId,
    transactions: txs,
    fees: { deploy: String(DEPLOY_FEE), call: String(CALL_FEE) },
    overrides: { hotWalletAdmin: !!a.hotWalletAdmin },
  };
}

export const planText = (plan: DeployPlan) => JSON.stringify(plan, null, 2) + "\n";
export const planSha = (plan: DeployPlan) => sha256(planText(plan));

/** Gate between printing a plan and broadcasting it. */
export function checkProceed(plan: DeployPlan, git: GitState, opts: { commit?: string; yesMainnet?: boolean; planSha?: string }): void {
  if (!git.clean) throw new Error(`refusing: the working tree is dirty (${git.dirty.length} path(s)), deploy from a clean checkout`);
  if (!opts.commit) throw new Error(`refusing: pin the commit with --commit=${git.commit}`);
  if (opts.commit !== git.commit || plan.git.commit !== git.commit) throw new Error(`refusing: --commit=${opts.commit} is not HEAD ${git.commit}`);
  if (plan.network === "mainnet") {
    if (!opts.yesMainnet) throw new Error("refusing: this would broadcast on MAINNET, add --yes-mainnet");
    const want = planSha(plan);
    if (opts.planSha !== want) throw new Error(`refusing: --plan-sha does not match the plan (${want}); review the printed plan first`);
  }
}

/** Signs every planned transaction offline, on consecutive nonces, in plan order. */
export async function buildDeployTxs(plan: DeployPlan, sources: Source[], senderKey: string): Promise<{ label: string; tx: StacksTransactionWire }[]> {
  const out: { label: string; tx: StacksTransactionWire }[] = [];
  for (const t of plan.transactions) {
    const nonce = BigInt(t.nonce);
    if (t.kind === "deploy") {
      const name = t.contract.split(".")[1];
      const s = sources.find((x) => x.name === name);
      if (!s || sha256(s.code) !== plan.contracts.find((c) => c.name === name)?.deployedSha256) throw new Error(`source for ${name} does not match the plan`);
      const tx = await makeContractDeploy({
        contractName: name, codeBody: s.code, clarityVersion: 3, senderKey, network: plan.network,
        fee: DEPLOY_FEE, nonce, postConditionMode: PostConditionMode.Deny,
      });
      out.push({ label: `deploy ${name}`, tx });
    } else {
      const [contractAddress, contractName] = t.contract.split(".");
      const functionArgs = t.function === "set-vault-contract"
        ? [Cl.contractPrincipal(plan.deployer, VAULT)]
        : t.args!.map((a) => Cl.principal(a));
      const tx = await makeContractCall({
        contractAddress, contractName, functionName: t.function!, functionArgs, senderKey, network: plan.network,
        fee: CALL_FEE, nonce, postConditionMode: PostConditionMode.Deny,
      });
      out.push({ label: `${t.function}`, tx });
    }
  }
  return out;
}

/** Broadcasts back to back; stops at the first rejection (later nonces could not confirm). */
export async function broadcastAll(
  txs: { label: string; tx: StacksTransactionWire }[],
  broadcast: (tx: StacksTransactionWire) => Promise<any>,
): Promise<{ label: string; txid: string }[]> {
  const done: { label: string; txid: string }[] = [];
  for (const { label, tx } of txs) {
    const res = await broadcast(tx);
    if (!res || !("txid" in res) || res.error) throw Object.assign(new Error(`${label} rejected: ${JSON.stringify(res)}`), { done });
    done.push({ label, txid: res.txid });
  }
  return done;
}

// ---- verify ---------------------------------------------------------------------------------

export interface Check { name: string; ok: boolean; detail: string }

const principalOf = (cv: any): string | null => {
  if (!cv) return null;
  if (cv.type === "address" || cv.type === "contract") return cv.value;
  if (cv.type === "some" || cv.type === "ok") return principalOf(cv.value);
  return null;
};

/**
 * Compares each on-chain source to the plan's hash (the token after the testnet trait
 * substitution), and the vault's roles and the token's link to the plan.
 * fetchJson(path) GETs from the node; callRead(contractName, fn) returns the decoded ClarityValue.
 */
export async function verifyDeployment(
  plan: DeployPlan,
  fetchJson: (path: string) => Promise<any>,
  callRead: (contractName: string, fn: string) => Promise<ClarityValue>,
): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  for (const c of plan.contracts) {
    try {
      const j = await fetchJson(`/v2/contracts/source/${plan.deployer}/${c.name}?proof=0`);
      const got = sha256(String(j.source));
      checks.push({ name: `source ${c.name}`, ok: got === c.deployedSha256, detail: `on-chain ${got} | plan ${c.deployedSha256}` });
    } catch (e) {
      checks.push({ name: `source ${c.name}`, ok: false, detail: (e as Error).message });
    }
  }
  try {
    const st = (await callRead(VAULT, "get-state")) as any;
    const t = st.type === "tuple" ? st.value : st.value?.value;
    const want: [string, string | boolean][] = [
      ["initialized", true], ["admin", plan.principals.admin], ["strategy", plan.principals.strategy],
      ["guardian", plan.principals.guardian], ["fee-recipient", plan.principals.feeRecipient],
    ];
    for (const [k, v] of want) {
      const got = typeof v === "boolean" ? t?.[k]?.type === "true" : principalOf(t?.[k]);
      checks.push({ name: `vault ${k}`, ok: got === v, detail: `on-chain ${got} | plan ${v}` });
    }
  } catch (e) {
    checks.push({ name: "vault get-state", ok: false, detail: (e as Error).message });
  }
  try {
    const got = principalOf(await callRead(TOKEN, "get-vault-contract"));
    checks.push({ name: "token vault link", ok: got === plan.vaultId, detail: `on-chain ${got} | plan ${plan.vaultId}` });
  } catch (e) {
    checks.push({ name: "token vault link", ok: false, detail: (e as Error).message });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

export const recordPath = (network: Network, date: Date) => `deployments/v2-${network}-${date.toISOString().slice(0, 10)}.json`;

export function deploymentRecord(plan: DeployPlan, txids: { label: string; txid: string }[], verify: { ok: boolean; checks: Check[] } | null, at: Date) {
  return { recordedAt: at.toISOString(), planSha256: planSha(plan), plan, txids, verify };
}

// ---- post-conditions for operator calls (DSA-26 / assessment F-14) --------------------------

/**
 * Deny mode with exact STX amounts for the calls whose transfer is known up front. Calls that
 * move nothing get Deny with no conditions. Claims, cancels and requests move an amount that
 * the contract computes, so they stay in Allow mode (returned as null).
 */
export function postConditionsFor(
  fn: string, amount: bigint | null, ctx: { vaultId: string; sender: string },
): { mode: PostConditionMode; postConditions: PostCondition[] } | null {
  const deny = (pcs: PostCondition[]) => ({ mode: PostConditionMode.Deny, postConditions: pcs });
  switch (fn) {
    case "deposit": return deny([Pc.principal(ctx.sender).willSendEq(amount!).ustx()]);
    case "sweep": return deny([Pc.principal(ctx.vaultId).willSendEq(amount!).ustx()]);
    case "return-from-strategy":
    case "recover-from-strategy":
      return deny(amount! > 0n ? [Pc.principal(ctx.sender).willSendEq(amount!).ustx()] : []);
    case "settle-overdue": case "initialize":
    case "pause-deposits": case "pause-sweeps": case "unpause-deposits": case "unpause-sweeps":
    case "accept-admin-change": case "accept-strategy-change":
      return deny([]);
    default:
      if (fn.startsWith("queue-") || fn.startsWith("confirm-")) return deny([]);
      return null;
  }
}
