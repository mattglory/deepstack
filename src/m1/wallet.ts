// Wallet + network wiring for M1 broadcasting.
//
// SAFETY:
//  - The private key is read ONLY from the STACKS_PRIVATE_KEY env var (loaded
//    from a gitignored .env). It is never logged, printed, or committed.
//  - Network defaults to TESTNET. Mainnet requires STACKS_NETWORK=mainnet.

import { readFileSync, existsSync } from "node:fs";
import { getAddressFromPrivateKey } from "@stacks/transactions";
import { generateWallet, generateNewAccount } from "@stacks/wallet-sdk";
import { activePool, contractId, tokenId, type Token } from "./contracts.js";
import { withRpc } from "./rpc.js";

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

// Mainnet reads go through the RPC failover (rpc.ts) — one provider must not take the
// pilot down. Testnet keeps the single public endpoint; it carries no uptime SLA.
async function hiroJson<T>(network: Network, path: string): Promise<T> {
  const get = async (base: string) => {
    const res = await fetch(base + path);
    if (!res.ok) throw new Error(`fetch failed: ${res.status} (${path})`);
    return (await res.json()) as T;
  };
  return network === "mainnet" ? withRpc(get) : get(apiBase(network));
}

export interface Wallet {
  key: string; // kept in memory only; never log this
  address: string;
  network: Network;
}

// Accepts either a raw hex private key OR a 12/24-word seed phrase in
// STACKS_PRIVATE_KEY. A seed phrase is detected by whitespace (multiple words)
// and the STX key for STACKS_ACCOUNT_INDEX (default 0) is derived from it.
async function resolvePrivateKey(raw: string): Promise<string> {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length < 12) return raw.trim(); // raw hex key
  const idx = Number(process.env.STACKS_ACCOUNT_INDEX ?? 0);
  let wallet = await generateWallet({ secretKey: words.join(" "), password: "" });
  while (wallet.accounts.length <= idx) wallet = generateNewAccount(wallet);
  return wallet.accounts[idx].stxPrivateKey;
}

export async function getWallet(): Promise<Wallet> {
  loadDotenv();
  const raw = process.env.STACKS_PRIVATE_KEY;
  if (!raw || !raw.trim()) {
    throw new Error(
      "STACKS_PRIVATE_KEY not set. Add a hex key OR a 12/24-word seed phrase to a local .env (gitignored) — never paste it anywhere shared.",
    );
  }
  const network = getNetwork();
  const key = await resolvePrivateKey(raw);
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
  const j = await hiroJson<{ stx?: { balance?: string } }>(
    network,
    `/extended/v1/address/${address}/balances`,
  );
  const micro = BigInt(j.stx?.balance ?? "0");
  return { stx: Number(micro) / 1e6, microStx: micro };
}

async function ftBalance(address: string, network: Network, assetId: string): Promise<bigint> {
  const j = await hiroJson<{ fungible_tokens?: Record<string, { balance?: string }> }>(
    network,
    `/extended/v1/address/${address}/balances`,
  );
  return BigInt(j.fungible_tokens?.[assetId]?.balance ?? "0");
}

// Balance of any pool token (base units). Native STX -> the native balance;
// SIP-010 -> the FT balance. Works for either leg of any pair.
export async function getTokenBalance(
  address: string,
  network: Network,
  token: Token,
): Promise<bigint> {
  if (token.native) return (await getStxBalance(address, network)).microStx;
  return ftBalance(address, network, `${tokenId(token)}::${token.asset}`);
}

// LP token balance (base units) for the active pair.
export async function getLpBalance(address: string, network: Network): Promise<bigint> {
  const lp = activePool().lp;
  return ftBalance(address, network, `${contractId(lp)}::${lp.asset}`);
}
