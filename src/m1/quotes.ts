// Read-only quotes used to set slippage guards (min-*) for write transactions.
// Never submit a write with min = 0 — always size guards from a fresh quote.

import { fetchCallReadOnlyFunction, Cl, cvToJSON } from "@stacks/transactions";
import { config } from "../config.js";
import { CORE, POOL, SBTC, STX } from "./contracts.js";

const poolTraitArgs = () => [
  Cl.contractPrincipal(POOL.address, POOL.name),
  Cl.contractPrincipal(SBTC.address, SBTC.name),
  Cl.contractPrincipal(STX.address, STX.name),
];

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

// slippage helpers (bps): floor for outputs we receive, ceiling for inputs we send
export const minusSlippage = (amount: bigint, bps: number): bigint =>
  (amount * BigInt(10_000 - bps)) / 10_000n;
export const plusSlippage = (amount: bigint, bps: number): bigint =>
  (amount * BigInt(10_000 + bps)) / 10_000n;
