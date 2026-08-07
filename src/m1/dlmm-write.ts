// DLMM write path (step 3 of the concentrated-liquidity build — POST-PILOT).
//
// BUILD-ONLY, ON PURPOSE. This module ASSEMBLES the router transactions (add / move / withdraw
// liquidity) but NEVER signs or broadcasts them. It returns a plain contract-call descriptor for
// inspection and simulation; the signing/broadcasting executor is step 4 and is gated behind the
// same double opt-in + safety layer as the XYK path. Developing the encoding this way means the
// whole write path can be built and tested with zero risk of moving capital.
//
// Router: SM1FKXG….dlmm-liquidity-router-v-1-2. All ops take SIGNED bin ids (int128) — the same
// ids our position model uses. Concentrated deposit shape (verified on-chain): bins ABOVE the
// active bin hold X, bins BELOW hold Y, the active bin holds both.

import { Cl, Pc, type ClarityValue, type PostCondition } from "@stacks/transactions";

const DEPLOYER = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER = "dlmm-liquidity-router-v-1-2";

// On this venue "STX" is the token-stx-v-1-2 trait, but the asset actually moved is NATIVE
// STX — the same facade the XYK pool uses (it has no real fungible-token asset). So its input
// cap must be .ustx(), not .ft(). Every other token here (ststx, usdcx, sbtc) is a real SIP-010.
const STX_WRAPPER = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2";

/** True if this DLMM token principal is the native-STX facade (capped with .ustx()). */
export function isNativeStxToken(principal: string): boolean {
  return principal === STX_WRAPPER;
}

export interface InputCap {
  token: string; // "ADDR.name" principal as reported by the pool (x-token / y-token)
  asset: string; // SIP-010 asset name (the part after ::); ignored for the native-STX facade
  max: bigint; // the wallet sends AT MOST this much of the token
}

/**
 * Input-cap post-conditions: the sender sends AT MOST `max` of each token. Paired with Allow
 * mode in the executor, these cap only what LEAVES the wallet, so a mis-encoded router call can
 * never overspend — the proven XYK approach (actions.ts sendCapPC), extended to N tokens. The
 * native-STX facade is capped with .ustx(); real SIP-010s with .ft(). Zero/negative caps are
 * dropped. Pure.
 */
export function buildInputCaps(sender: string, caps: InputCap[]): PostCondition[] {
  return caps
    .filter((c) => c.max > 0n)
    .map((c) =>
      isNativeStxToken(c.token)
        ? Pc.principal(sender).willSendLte(c.max).ustx()
        : Pc.principal(sender).willSendLte(c.max).ft(c.token as `${string}.${string}`, c.asset),
    );
}

export interface PoolRefs {
  poolName: string; // e.g. "dlmm-pool-ststx-stx-v-1-bps-1" (under DEPLOYER)
  xToken: string; // "ADDR.name"
  yToken: string; // "ADDR.name"
}

export interface BinDeposit {
  signedBin: number;
  xAmount: bigint;
  yAmount: bigint;
}

/**
 * Spread a target x/y amount across a bin range in the concentrated "spot" shape: X into the
 * active bin and every bin above it, Y into the active bin and every bin below it (verified
 * against on-chain bin balances). Uniform per bin; integer division, with the remainder parked
 * in the active bin so no dust is lost. Pure.
 */
export function distributeAcrossRange(
  activeBin: number,
  halfWidth: number,
  totalX: bigint,
  totalY: bigint,
): BinDeposit[] {
  const nX = BigInt(halfWidth + 1); // active + bins above hold X
  const nY = BigInt(halfWidth + 1); // active + bins below hold Y
  const xPer = totalX / nX;
  const xRem = totalX % nX;
  const yPer = totalY / nY;
  const yRem = totalY % nY;
  const out: BinDeposit[] = [];
  for (let b = activeBin - halfWidth; b <= activeBin + halfWidth; b++) {
    let x = 0n;
    let y = 0n;
    if (b >= activeBin) x = xPer;
    if (b <= activeBin) y = yPer;
    if (b === activeBin) {
      x += xRem;
      y += yRem;
    }
    if (x > 0n || y > 0n) out.push({ signedBin: b, xAmount: x, yAmount: y });
  }
  return out;
}

export interface BinMove {
  fromBin: number;
  toBin: number;
  amount: bigint; // LP shares to move
}

export interface BinWithdraw {
  signedBin: number;
  amount: bigint; // LP shares to withdraw
  minX: bigint;
  minY: bigint;
}

export interface WriteOpts {
  maxLiquidityFee?: bigint; // cap on protocol liquidity fee per bin (default: permissive = amount)
  minDlp?: bigint; // minimum LP shares out per bin (slippage guard; default 0 for build/sim)
  deadlineTime?: number; // optional unix seconds
}

export interface CallDescriptor {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  note: string; // human summary — this descriptor is NOT signed or broadcast here
}

function principalCV(id: string): ClarityValue {
  const [addr, name] = id.split(".");
  return name ? Cl.contractPrincipal(addr, name) : Cl.standardPrincipal(addr);
}

function deadlineCV(opts: WriteOpts): ClarityValue {
  return opts.deadlineTime ? Cl.some(Cl.uint(opts.deadlineTime)) : Cl.none();
}

/** Build (do NOT broadcast) an add-liquidity-multi call for a set of per-bin deposits. */
export function buildAddLiquidity(pool: PoolRefs, deposits: BinDeposit[], opts: WriteOpts = {}): CallDescriptor {
  const positions = deposits.map((d) =>
    Cl.tuple({
      "bin-id": Cl.int(d.signedBin),
      "max-x-liquidity-fee": Cl.uint(opts.maxLiquidityFee ?? d.xAmount),
      "max-y-liquidity-fee": Cl.uint(opts.maxLiquidityFee ?? d.yAmount),
      "min-dlp": Cl.uint(opts.minDlp ?? 0),
      "pool-trait": principalCV(`${DEPLOYER}.${pool.poolName}`),
      "x-amount": Cl.uint(d.xAmount),
      "x-token-trait": principalCV(pool.xToken),
      "y-amount": Cl.uint(d.yAmount),
      "y-token-trait": principalCV(pool.yToken),
    }),
  );
  return {
    contractAddress: DEPLOYER,
    contractName: ROUTER,
    functionName: "add-liquidity-multi",
    functionArgs: [Cl.list(positions), deadlineCV(opts)],
    note: `BUILD-ONLY add-liquidity across ${deposits.length} bins on ${pool.poolName}`,
  };
}

/** Build (do NOT broadcast) a move-liquidity-multi call — the recenter primitive. */
export function buildMoveLiquidity(pool: PoolRefs, moves: BinMove[], opts: WriteOpts = {}): CallDescriptor {
  const positions = moves.map((m) =>
    Cl.tuple({
      amount: Cl.uint(m.amount),
      "from-bin-id": Cl.int(m.fromBin),
      "max-x-liquidity-fee": Cl.uint(opts.maxLiquidityFee ?? 0),
      "max-y-liquidity-fee": Cl.uint(opts.maxLiquidityFee ?? 0),
      "min-dlp": Cl.uint(opts.minDlp ?? 0),
      "pool-trait": principalCV(`${DEPLOYER}.${pool.poolName}`),
      "to-bin-id": Cl.int(m.toBin),
      "x-token-trait": principalCV(pool.xToken),
      "y-token-trait": principalCV(pool.yToken),
    }),
  );
  return {
    contractAddress: DEPLOYER,
    contractName: ROUTER,
    functionName: "move-liquidity-multi",
    functionArgs: [Cl.list(positions), deadlineCV(opts)],
    note: `BUILD-ONLY recenter (${moves.length} bin moves) on ${pool.poolName}`,
  };
}

/** Build (do NOT broadcast) a withdraw-liquidity-multi call. */
export function buildWithdrawLiquidity(pool: PoolRefs, withdrawals: BinWithdraw[], opts: WriteOpts = {}): CallDescriptor {
  const positions = withdrawals.map((w) =>
    Cl.tuple({
      amount: Cl.uint(w.amount),
      "bin-id": Cl.int(w.signedBin),
      "min-x-amount": Cl.uint(w.minX),
      "min-y-amount": Cl.uint(w.minY),
      "pool-trait": principalCV(`${DEPLOYER}.${pool.poolName}`),
      "x-token-trait": principalCV(pool.xToken),
      "y-token-trait": principalCV(pool.yToken),
    }),
  );
  return {
    contractAddress: DEPLOYER,
    contractName: ROUTER,
    functionName: "withdraw-liquidity-multi",
    functionArgs: [Cl.list(positions), deadlineCV(opts)],
    note: `BUILD-ONLY withdraw (${withdrawals.length} bins) on ${pool.poolName}`,
  };
}
