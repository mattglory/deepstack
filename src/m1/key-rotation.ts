// Planning for an agent key rotation: which balances move from the old agent wallet to the new
// one, in what order, and what has to be true before anything is sent. Pure, so it is tested
// without a network; rotate-key-cli.ts does the reading, signing and sending.
//
// Scope, deliberately narrow:
// - Only the tokens listed in ROTATION_ASSETS are moved, each through its own SIP-010 `transfer`.
//   Anything else in the wallet (address-poisoning dust, unknown airdrops) is listed and left
//   alone: calling `transfer` on a contract we have not read is not worth the risk.
// - The XYK LP token moves as a token, so the position (and its cost basis) is unchanged.
// - The concentrated (DLMM) position does NOT move: it is withdrawn first with the existing,
//   proven `m1:dlmm-recenter -- withdraw`, and reopened from the new wallet at the new width.
//   Any DLMM pool-token balance blocks the plan.
// - STX goes last, as everything left after the fees for that final transfer.

export interface RotationAsset {
  id: string; // full asset identifier, as Hiro's balances endpoint keys it
  contract: string; // contract that implements `transfer`
  label: string;
  decimals: number;
}

export const ROTATION_ASSETS: readonly RotationAsset[] = [
  {
    id: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1::pool-token",
    contract: "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.xyk-pool-sbtc-stx-v-1-1",
    label: "XYK LP (sBTC/STX)",
    decimals: 6,
  },
  {
    id: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token",
    contract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    label: "sBTC",
    decimals: 8,
  },
  {
    id: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx::usdcx-token",
    contract: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    label: "USDCx",
    decimals: 6,
  },
];

export interface WalletBalances {
  stx: bigint; // micro-STX, total
  stxLocked: bigint;
  ft: Record<string, bigint>; // asset id -> base units
}

export interface TokenMove { asset: RotationAsset; amount: bigint }

export interface RotationPlan {
  tokens: TokenMove[];
  stxSend: bigint; // micro-STX for the final transfer (0 when nothing is left to send)
  feesTotal: bigint;
  ignored: string[]; // nonzero balances we will not touch
  blockers: string[]; // any entry means: do not send
}

export const ROTATION_FEE_USTX = 100_000n; // 0.1 STX per transfer, ample at current fee levels

/** Balances as Hiro's /extended/v1/address/{a}/balances returns them. */
export function parseBalances(j: {
  stx?: { balance?: string; locked?: string };
  fungible_tokens?: Record<string, { balance?: string }>;
}): WalletBalances {
  const ft: Record<string, bigint> = {};
  for (const [id, v] of Object.entries(j.fungible_tokens ?? {})) {
    const b = BigInt(v?.balance ?? "0");
    if (b > 0n) ft[id] = b;
  }
  return { stx: BigInt(j.stx?.balance ?? "0"), stxLocked: BigInt(j.stx?.locked ?? "0"), ft };
}

export function planRotation(old: WalletBalances, fee = ROTATION_FEE_USTX): RotationPlan {
  const blockers: string[] = [];
  const known = new Set(ROTATION_ASSETS.map((a) => a.id));
  const tokens = ROTATION_ASSETS.filter((a) => (old.ft[a.id] ?? 0n) > 0n).map((a) => ({ asset: a, amount: old.ft[a.id] }));
  const ignored = Object.keys(old.ft).filter((id) => !known.has(id));

  for (const id of ignored) {
    if (/\.dlmm-pool-[^:]+::pool-token$/.test(id)) {
      blockers.push(`DLMM position still open (${id.split(".")[1].split("::")[0]}): withdraw it first with m1:dlmm-recenter -- withdraw`);
    }
  }
  if (old.stxLocked > 0n) blockers.push(`${Number(old.stxLocked) / 1e6} STX is locked (stacking): it cannot be moved until it unlocks`);

  const feesTotal = fee * BigInt(tokens.length + 1);
  const stxSend = old.stx - old.stxLocked - feesTotal;
  if (stxSend < 0n) blockers.push(`not enough STX for fees: need ${Number(feesTotal) / 1e6}, have ${Number(old.stx - old.stxLocked) / 1e6}`);
  return { tokens, stxSend: stxSend > 0n ? stxSend : 0n, feesTotal, ignored, blockers };
}

/**
 * The old wallet is done when no known asset or DLMM position remains and what STX is left is
 * no more than dust (by default one fee's worth).
 */
export function isDrained(old: WalletBalances, dust = ROTATION_FEE_USTX): boolean {
  if (ROTATION_ASSETS.some((a) => (old.ft[a.id] ?? 0n) > 0n)) return false;
  if (Object.keys(old.ft).some((id) => /\.dlmm-pool-[^:]+::pool-token$/.test(id))) return false;
  return old.stx <= dust;
}

export function fmtUnits(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
