// Read-only quotes used to set slippage guards (min-*) for write transactions.
// Never submit a write with min = 0 — always size guards from a fresh quote.

import { fetchCallReadOnlyFunction, Cl, cvToJSON } from "@stacks/transactions";
import { config } from "../config.js";
import { CORE, activePool } from "./contracts.js";

const poolTraitArgs = () => {
  const p = activePool();
  return [
    Cl.contractPrincipal(p.pool.address, p.pool.name),
    Cl.contractPrincipal(p.x.address, p.x.name),
    Cl.contractPrincipal(p.y.address, p.y.name),
  ];
};

async function callCore(functionName: string, extraArgs: ReturnType<typeof Cl.uint>[]) {
  const cv = await fetchCallReadOnlyFunction({
    contractAddress: CORE.address,
    contractName: CORE.name,
    functionName,
    functionArgs: [...poolTraitArgs(), ...extraArgs],
    network: "mainnet",
    senderAddress: config.senderAddress,
  });
  return cvToJSON(cv) as any;
}

export interface AddLiquidityQuote {
  dlp: bigint; // LP tokens minted for adding xAmount of sBTC
  yAmount: bigint; // paired STX (microSTX) the pool will pull
}

// get-dlp(pool, x, y, x-amount) -> (tuple (dlp uint) (y-amount uint))
export async function getAddLiquidityQuote(xAmount: bigint): Promise<AddLiquidityQuote> {
  const j = await callCore("get-dlp", [Cl.uint(xAmount)]);
  const t = j?.value?.value;
  if (!t) throw new Error("get-dlp returned no tuple");
  return { dlp: BigInt(t.dlp.value), yAmount: BigInt(t["y-amount"].value) };
}

// get-dy(pool, x, y, x-amount) -> y out for swapping xAmount of sBTC in
export async function getSwapXForYQuote(xAmount: bigint): Promise<bigint> {
  const j = await callCore("get-dy", [Cl.uint(xAmount)]);
  return BigInt(j.value.value);
}

// get-dx(pool, x, y, y-amount) -> x out for swapping yAmount of STX in
export async function getSwapYForXQuote(yAmount: bigint): Promise<bigint> {
  const j = await callCore("get-dx", [Cl.uint(yAmount)]);
  return BigInt(j.value.value);
}

// Raw pool reserves + total shares (base units), read from the pool's get-pool.
export async function getPoolRaw(): Promise<{
  xBalance: bigint;
  yBalance: bigint;
  totalShares: bigint;
}> {
  const p = activePool();
  const cv = await fetchCallReadOnlyFunction({
    contractAddress: p.pool.address,
    contractName: p.pool.name,
    functionName: "get-pool",
    functionArgs: [],
    network: "mainnet",
    senderAddress: config.senderAddress,
  });
  const t = (cvToJSON(cv) as any)?.value?.value;
  if (!t) throw new Error("get-pool returned no tuple");
  return {
    xBalance: BigInt(t["x-balance"].value),
    yBalance: BigInt(t["y-balance"].value),
    totalShares: BigInt(t["total-shares"].value),
  };
}

// Proportional withdrawal: burning lpAmount returns its share of both reserves.
// No dedicated core helper exists, so compute from on-chain reserves + shares.
export async function getWithdrawQuote(
  lpAmount: bigint,
): Promise<{ xOut: bigint; yOut: bigint }> {
  const { xBalance, yBalance, totalShares } = await getPoolRaw();
  if (totalShares === 0n) throw new Error("pool has no shares");
  return {
    xOut: (lpAmount * xBalance) / totalShares,
    yOut: (lpAmount * yBalance) / totalShares,
  };
}

// slippage helpers (bps): floor for outputs we receive, ceiling for inputs we send
export const minusSlippage = (amount: bigint, bps: number): bigint =>
  (amount * BigInt(10_000 - bps)) / 10_000n;
export const plusSlippage = (amount: bigint, bps: number): bigint =>
  (amount * BigInt(10_000 + bps)) / 10_000n;
