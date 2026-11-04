// Read-only Hiro API source for the wallet watcher, with failover.
//
// Same failover idea as src/m1/rpc.ts (primary, then each fallback in order, sticky on the
// last endpoint that answered), but self-contained so the watcher has no dependency on the
// agent's config. Every request is a GET with its own AbortSignal.timeout, so a hanging
// endpoint costs one timeout and the next endpoint is tried.
//
// Calls per poll: 1 (chain tip) + per address 4..(3 + maxPages): balances, nonces, mempool,
// and 1-maxPages pages of transactions. Well inside Hiro's unauthenticated 50 req/min.

import type { Observation, Transfer, WatchedTx } from "./watcher.js";
import type { Network } from "./allowlist.js";

type Fetch = typeof fetch;

const strip = (s: string) => s.trim().replace(/\/+$/, "");

export function defaultApi(network: Network): string {
  return network === "mainnet" ? "https://api.mainnet.hiro.so" : "https://api.testnet.hiro.so";
}

export class HiroSource {
  readonly endpoints: string[];
  private preferred = 0;

  constructor(
    endpoints: string[],
    private timeoutMs = 10_000,
    private doFetch: Fetch = fetch,
    private log: (s: string) => void = (s) => console.warn(s),
  ) {
    this.endpoints = endpoints.map(strip).filter(Boolean);
    if (!this.endpoints.length) throw new Error("no API endpoints configured");
  }

  /** GET `path` from the first endpoint that answers 2xx with JSON. Throws when all fail. */
  async get<T>(path: string): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < this.endpoints.length; i++) {
      const idx = (this.preferred + i) % this.endpoints.length;
      const base = this.endpoints[idx];
      try {
        const res = await this.doFetch(`${base}${path}`, { method: "GET", signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as T;
        if (idx !== this.preferred) {
          this.log(`  [watch] ${this.endpoints[this.preferred]} failing — switched to ${base}`);
          this.preferred = idx;
        }
        return body;
      } catch (err) {
        lastErr = new Error(`${base}${path.split("?")[0]}: ${(err as Error).message}`);
      }
    }
    throw lastErr;
  }
}

// --- response shapes (only the fields we use; see fixtures/) ---

interface RawTransfer { amount?: string; value?: { repr?: string }; asset_identifier?: string; sender?: string; recipient?: string }
interface RawTx {
  tx_id: string;
  nonce: number;
  fee_rate: string;
  sender_address: string;
  sponsored?: boolean;
  tx_status: string;
  tx_type: string;
  block_height?: number;
  block_time_iso?: string;
  receipt_time_iso?: string;
  contract_call?: { contract_id: string; function_name: string };
  smart_contract?: { contract_id: string };
  token_transfer?: { recipient_address: string; amount: string };
}
interface RawTxWithTransfers {
  tx: RawTx;
  stx_transfers?: RawTransfer[];
  ft_transfers?: RawTransfer[];
  nft_transfers?: RawTransfer[];
}
interface Page<T> { total: number; results: T[] }

export function parseTx(raw: RawTx, transfers: Transfer[] = []): WatchedTx {
  const pending = raw.tx_status === "pending";
  return {
    txid: raw.tx_id,
    pending,
    status: raw.tx_status,
    type: raw.tx_type,
    sender: raw.sender_address,
    sponsored: Boolean(raw.sponsored),
    nonce: raw.nonce,
    fee: BigInt(raw.fee_rate ?? "0"),
    blockHeight: pending ? undefined : raw.block_height,
    time: pending ? raw.receipt_time_iso : raw.block_time_iso,
    contractId: raw.contract_call?.contract_id,
    functionName: raw.contract_call?.function_name,
    deployId: raw.smart_contract?.contract_id,
    stxRecipient: raw.token_transfer?.recipient_address,
    stxAmount: raw.token_transfer ? BigInt(raw.token_transfer.amount) : undefined,
    transfers,
  };
}

export function parseTxWithTransfers(x: RawTxWithTransfers): WatchedTx {
  const t = (kind: Transfer["kind"], e: RawTransfer): Transfer => ({
    kind,
    asset: kind === "stx" ? "STX" : (e.asset_identifier ?? "?"),
    amount: kind === "nft" ? 1n : BigInt(e.amount ?? "0"),
    sender: e.sender ?? "",
    recipient: e.recipient ?? "",
  });
  return parseTx(x.tx, [
    ...(x.stx_transfers ?? []).map((e) => t("stx", e)),
    ...(x.ft_transfers ?? []).map((e) => t("ft", e)),
    ...(x.nft_transfers ?? []).map((e) => t("nft", e)),
  ]);
}

export function parseBalances(j: { stx?: { balance?: string }; fungible_tokens?: Record<string, { balance?: string }> }): Record<string, bigint> {
  const out: Record<string, bigint> = { STX: BigInt(j.stx?.balance ?? "0") };
  for (const [id, v] of Object.entries(j.fungible_tokens ?? {})) out[id] = BigInt(v.balance ?? "0");
  return out;
}

export async function chainTip(src: HiroSource): Promise<number> {
  const j = await src.get<{ chain_tip?: { block_height?: number } }>("/extended");
  const h = j.chain_tip?.block_height;
  if (typeof h !== "number") throw new Error("chain tip missing from /extended");
  return h;
}

/**
 * Everything the watcher needs about one address, read at `tipHeight`. Transactions are
 * paged newest-first until a page reaches `stopHeight` (the last height already evaluated)
 * or `maxPages` is hit; the evaluator raises a history-gap alert if that was not enough.
 */
export async function observeAddress(src: HiroSource, address: string, tipHeight: number, stopHeight = 0, maxPages = 3): Promise<Observation> {
  const LIMIT = 50;
  const bal = await src.get<Parameters<typeof parseBalances>[0]>(`/extended/v1/address/${address}/balances?until_block=${tipHeight}`);
  const confirmed: WatchedTx[] = [];
  let total = 0;
  for (let p = 0; p < maxPages; p++) {
    const page = await src.get<Page<RawTxWithTransfers>>(`/extended/v1/address/${address}/transactions_with_transfers?limit=${LIMIT}&offset=${p * LIMIT}`);
    total = page.total;
    confirmed.push(...page.results.map(parseTxWithTransfers));
    const reachedKnown = page.results.some((x) => (x.tx.block_height ?? 0) <= stopHeight);
    if (stopHeight === 0 || reachedKnown || page.results.length < LIMIT) break;
  }
  const mp = await src.get<Page<RawTx>>(`/extended/v1/address/${address}/mempool?limit=${LIMIT}`);
  const nonces = await src.get<{ detected_missing_nonces?: number[] }>(`/extended/v1/address/${address}/nonces`);
  return {
    address,
    tipHeight,
    balances: parseBalances(bal),
    confirmed,
    mempool: mp.results.map((t) => parseTx(t)),
    missingNonces: nonces.detected_missing_nonces ?? [],
    historyTotal: total,
  };
}
