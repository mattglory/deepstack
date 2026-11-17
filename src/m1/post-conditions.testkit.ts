// Test-only: evaluate a post-condition set against a list of asset movements the way a Stacks
// node does (stacks-core check_transaction_postconditions), so tests can show what a set allows
// and forbids without a chain:
//   - each condition compares the TOTAL its principal sent of its asset (0 if none) to its amount;
//   - Deny mode: any movement whose (principal, asset) no condition names aborts the tx (NFTs
//     included); Allow mode: unnamed movements pass.
// A burn counts as the burner sending; mints have no sender and are never subject.

import { readFileSync } from "node:fs";
import type { PostCondition } from "@stacks/transactions";

export interface Movement {
  principal: string;
  asset: string; // "STX", "ADDR.c::asset" for FTs, "nft:ADDR.c::asset" for NFTs
  amount: bigint; // 1 per NFT
}

type Cond = { type: string; address: string; condition: string; amount?: bigint | string | number; asset?: string };

const keyOf = (c: Cond) => (c.type === "stx-postcondition" ? "STX" : c.type === "ft-postcondition" ? c.asset! : `nft:${c.asset}`);

/** null if the tx would pass, otherwise why it would abort. */
export function evaluate(pcs: PostCondition[], mode: "allow" | "deny", moves: Movement[]): string | null {
  const sent = new Map<string, bigint>();
  for (const m of moves) sent.set(`${m.principal}|${m.asset}`, (sent.get(`${m.principal}|${m.asset}`) ?? 0n) + m.amount);
  const named = new Set<string>();
  for (const pc of pcs as unknown as Cond[]) {
    const k = `${pc.address}|${keyOf(pc)}`;
    named.add(k);
    const s = sent.get(k) ?? 0n;
    const a = BigInt(pc.amount ?? 0);
    const ok = { lte: s <= a, lt: s < a, gte: s >= a, gt: s > a, eq: s === a }[pc.condition as "lte"];
    if (ok === undefined) throw new Error(`testkit: unsupported condition ${pc.condition}`);
    if (!ok) return `${pc.address} sent ${s} of ${keyOf(pc)}, condition ${pc.condition} ${a}`;
  }
  if (mode === "deny") for (const [k, v] of sent) if (v > 0n && !named.has(k)) return `${k.replaceAll("|", " moved ")} but no condition names it (Deny)`;
  return null;
}

export interface FixtureTx {
  txid: string;
  contract: string;
  function: string;
  pool: string | null;
  postConditionMode: string;
  outflows: { principal: string; kind: "stx" | "ft" | "nft"; asset: string; event: string; count: number; amount: string }[];
}
export const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/agent-asset-flows.json", import.meta.url), "utf8")) as {
  wallet: string;
  txs: FixtureTx[];
};
export const fixtureTx = (prefix: string) => {
  const t = FIXTURE.txs.find((x) => x.txid.startsWith(prefix));
  if (!t) throw new Error(`no fixture tx ${prefix}`);
  return t;
};

/** A fixture tx's observed movements, with the agent wallet replaced by `as` (the test signer). */
export function movementsOf(t: FixtureTx, as: string): Movement[] {
  return t.outflows.map((o) => ({
    principal: o.principal === FIXTURE.wallet ? as : o.principal,
    asset: o.kind === "nft" ? `nft:${o.asset}` : o.asset,
    amount: o.kind === "nft" ? BigInt(o.count) : BigInt(o.amount),
  }));
}

/**
 * Replay a fixture's shape at a test's own sizes: the total `principal` moves of `asset` becomes
 * `amount` (its movements merged into one). Throws if the fixture has no such movement.
 */
export function withAmount(moves: Movement[], principal: string, asset: string, amount: bigint): Movement[] {
  const rest = moves.filter((m) => !(m.principal === principal && m.asset === asset));
  if (rest.length === moves.length) throw new Error(`testkit: no movement of ${asset} by ${principal}`);
  return [...rest, { principal, asset, amount }];
}

/** Readable form of a set, for exact snapshot comparison. */
export const show = (pcs: PostCondition[]) =>
  (pcs as unknown as Cond[]).map((c) => `${c.address} ${c.condition} ${BigInt(c.amount ?? 0)} ${keyOf(c)}`);

// Every asset the wallet holds or can hold, in WALLET_ASSETS order — written out, not imported.
export const STX = "STX";
export const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token";
export const XYK_LP = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1::pool-token";
export const XYK_POOL = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1";
export const HELD = [
  STX,
  SBTC,
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token-locked",
  "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx::usdcx-token",
  "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token::ststx",
  "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc::aeUSDC",
  "SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60.deepstack-vault-token::deepstack-vault-shares",
  XYK_LP,
  "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-stx-aeusdc-v-1-2::pool-token",
  "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-ststx-stx-v-1-bps-1::pool-token",
  "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-2-bps-10::pool-token",
  "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10::pool-token",
  "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-stx-usdcx-v-1-bps-10::pool-token",
];
/** The expected wallet lines: the caps first, then "≤ 0" for every other held asset, in order. */
export const walletLines = (s: string, caps: [string, bigint][]) => [
  ...caps.map(([k, n]) => `${s} lte ${n} ${k}`),
  ...HELD.filter((k) => !caps.some(([c]) => c === k)).map((k) => `${s} lte 0 ${k}`),
];
