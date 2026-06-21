// Wallet + network wiring for M1 broadcasting.
//
// SAFETY:
//  - The private key is read ONLY from the STACKS_PRIVATE_KEY env var (loaded
//    from a gitignored .env). It is never logged, printed, or committed.
//  - Network defaults to TESTNET. Mainnet requires STACKS_NETWORK=mainnet.

import { readFileSync, existsSync } from "node:fs";
import { getAddressFromPrivateKey } from "@stacks/transactions";

// Minimal zero-dependency .env loader (only sets vars not already in env).
export function loadDotenv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export type Network = "mainnet" | "testnet";

export function getNetwork(): Network {
  const n = (process.env.STACKS_NETWORK ?? "testnet").toLowerCase();
  if (n !== "mainnet" && n !== "testnet") {
    throw new Error(`STACKS_NETWORK must be mainnet|testnet, got "${n}"`);
  }
  return n;
}

export function apiBase(network: Network): string {
  return network === "mainnet"
    ? "https://api.mainnet.hiro.so"
    : "https://api.testnet.hiro.so";
}

export interface Wallet {
  key: string; // kept in memory only; never log this
  address: string;
  network: Network;
}

export function getWallet(): Wallet {
  loadDotenv();
  const key = process.env.STACKS_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "STACKS_PRIVATE_KEY not set. Add it to a local .env (gitignored) — never paste it anywhere shared.",
    );
  }
  const network = getNetwork();
  const address = getAddressFromPrivateKey(key, network);
  return { key, address, network };
}

export interface StxBalance {
  stx: number; // human STX
  microStx: bigint;
}

export async function getStxBalance(
  address: string,
  network: Network,
): Promise<StxBalance> {
  const res = await fetch(`${apiBase(network)}/extended/v1/address/${address}/balances`);
  if (!res.ok) throw new Error(`balance fetch failed: ${res.status}`);
  const j = (await res.json()) as { stx?: { balance?: string } };
  const micro = BigInt(j.stx?.balance ?? "0");
  return { stx: Number(micro) / 1e6, microStx: micro };
}
