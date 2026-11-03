// Wallet watcher — pure classification and per-poll evaluation (no network, no disk).
//
// Given what the sources observed for each watched address this poll, plus the persisted
// state from earlier polls, decide which alerts are NEW and what the next state is. Every
// rule produces an alert key (`txid:rule`, or a rule-specific key for non-tx alerts); a key
// already in state.alerted never fires again, which is what makes a mempool tx that later
// confirms alert exactly once per rule.

import type { Network } from "./allowlist.js";

export type Severity = "CRITICAL" | "HIGH" | "INFO";
export const SEVERITY_RANK: Record<Severity, number> = { INFO: 0, HIGH: 1, CRITICAL: 2 };

export interface Transfer {
  kind: "stx" | "ft" | "nft";
  asset: string; // "STX", or the asset identifier "ADDR.contract::asset"
  amount: bigint; // base units; 1 per NFT
  sender: string; // "" = mint
  recipient: string; // "" = burn
}

export interface WatchedTx {
  txid: string;
  pending: boolean;
  status: string; // Hiro tx_status: pending | success | abort_by_response | abort_by_post_condition | ...
  type: string; // contract_call | token_transfer | smart_contract | ...
  sender: string;
  sponsored: boolean;
  nonce: number;
  fee: bigint; // micro-STX
  blockHeight?: number;
  time?: string; // ISO; block time for confirmed, receipt time for mempool
  contractId?: string; // contract_call target
  functionName?: string;
  deployId?: string; // smart_contract
  stxRecipient?: string; // token_transfer
  stxAmount?: bigint;
  transfers: Transfer[]; // asset movements touching the watched address (confirmed only)
}

export interface Observation {
  address: string;
  tipHeight: number; // balances are read AT this height; confirmed txs above it wait a poll
  balances: Record<string, bigint>; // "STX" and FT asset ids
  confirmed: WatchedTx[]; // newest first, as Hiro returns them
  mempool: WatchedTx[];
  missingNonces: number[];
  historyTotal: number; // total txs Hiro reports for the address
}

export interface Alert {
  key: string;
  severity: Severity;
  rule: string;
  address: string;
  txid?: string;
  summary: string;
}

export interface AddressState {
  lastHeight: number;
  seen: string[]; // confirmed txids already evaluated (bounded)
  balances: Record<string, string>; // bigint as string
}

export interface WatcherState {
  version: 1;
  network: Network;
  addresses: Record<string, AddressState>;
  alerted: string[]; // alert keys already delivered (bounded)
  outbox: Alert[]; // alerts that failed delivery, retried next poll
  consecutiveFailures: number;
  monitoringAlerted: boolean;
  lastOkAt?: string;
  recoverSince?: number; // set after a corrupt state file; cleared by the next healthy poll
}

export interface Rules {
  network: Network;
  watched: string[];
  owners: Set<string>; // OWNER_ALLOWLIST: human addresses outgoing transfers may go to
  calls: Set<string>; // contract ids the agent may call
  counterparties: Set<string>; // all allowlisted contracts/principals that may receive funds
  largeMovePct: number;
  balanceDropPct: number;
  failedBurst: number;
}

export interface EvaluateOpts {
  // Corrupt-state recovery: confirmed txs newer than this are classified (not just baselined)
  // even though the address has no prior state. Undefined = plain first run (baseline only).
  recoverSince?: number; // unix ms
}

const MAX_SEEN = 1000;
const MAX_ALERTED = 5000;

export function emptyState(network: Network): WatcherState {
  return { version: 1, network, addresses: {}, alerted: [], outbox: [], consecutiveFailures: 0, monitoringAlerted: false };
}

const short = (p: string) => (p.length > 20 && !p.includes(".") ? `${p.slice(0, 6)}…${p.slice(-4)}` : p);
const fmtAmount = (asset: string, n: bigint) => (asset === "STX" ? `${Number(n) / 1e6} STX` : `${n} ${asset.split("::")[1] ?? asset}`);

/** Recipient is acceptable for funds leaving a watched wallet. "" is a burn (LP/position NFTs). */
export function isAllowedRecipient(r: Rules, recipient: string): boolean {
  return recipient === "" || r.watched.includes(recipient) || r.owners.has(recipient) || r.counterparties.has(recipient);
}

interface Finding {
  severity: Severity;
  rule: string;
  summary: string;
}

/**
 * Classify one tx for one watched address. Pure. Rules (see docs/WALLET_WATCHER.md):
 *   CRITICAL deploy | unlisted-contract | stx-transfer-unlisted | transfer-unlisted
 *   HIGH     failed | large-movement
 *   INFO     incoming | allowlisted-call | owner-transfer
 */
export function classifyTx(tx: WatchedTx, address: string, r: Rules, prevBalances: Record<string, bigint> = {}): Finding[] {
  const out: Finding[] = [];
  const mine = tx.sender === address;
  const tag = tx.pending ? " (pending)" : "";
  const failed = !tx.pending && tx.status !== "success";

  if (mine) {
    if (tx.type === "smart_contract") {
      out.push({ severity: "CRITICAL", rule: "deploy", summary: `contract deployed from the wallet: ${tx.deployId}${tag}` });
    } else if (tx.type === "contract_call") {
      const call = `${tx.contractId}::${tx.functionName}`;
      if (!r.calls.has(tx.contractId ?? "")) {
        out.push({ severity: "CRITICAL", rule: "unlisted-contract", summary: `call to non-allowlisted contract ${call}${tag}` });
      } else {
        out.push({ severity: "INFO", rule: "allowlisted-call", summary: `${call}${tag}` });
      }
    } else if (tx.type === "token_transfer") {
      const to = tx.stxRecipient ?? "";
      const amt = fmtAmount("STX", tx.stxAmount ?? 0n);
      if (!isAllowedRecipient(r, to)) {
        out.push({ severity: "CRITICAL", rule: "stx-transfer-unlisted", summary: `STX transfer of ${amt} to non-allowlisted ${to}${tag}` });
      } else {
        out.push({ severity: "INFO", rule: "owner-transfer", summary: `STX transfer of ${amt} to allowlisted ${to}${tag}` });
      }
    }
    if (failed) out.push({ severity: "HIGH", rule: "failed", summary: `tx ${tx.status} (${tx.contractId ? `${tx.contractId}::${tx.functionName}` : tx.type}, nonce ${tx.nonce})` });
  }

  if (tx.pending || failed) return out; // nothing moved (or not yet known)

  // Asset movements: anything leaving to a stranger is CRITICAL regardless of what was called.
  const outflow: Record<string, bigint> = {};
  const strangers: string[] = [];
  let incoming = false;
  for (const t of tx.transfers) {
    if (t.sender === address) {
      outflow[t.asset] = (outflow[t.asset] ?? 0n) + t.amount;
      if (!isAllowedRecipient(r, t.recipient)) strangers.push(`${fmtAmount(t.asset, t.amount)} → ${t.recipient}`);
    } else if (t.recipient === address && !mine) {
      incoming = true;
    }
  }
  // A plain token_transfer to a stranger is already reported by stx-transfer-unlisted.
  if (strangers.length && !(tx.type === "token_transfer" && out.some((f) => f.rule === "stx-transfer-unlisted"))) {
    out.push({ severity: "CRITICAL", rule: "transfer-unlisted", summary: `funds sent to non-allowlisted recipient: ${strangers.slice(0, 5).join(", ")}${strangers.length > 5 ? ` (+${strangers.length - 5} more)` : ""}` });
  }
  for (const [asset, amt] of Object.entries(outflow)) {
    const prev = prevBalances[asset];
    if (prev && prev > 0n && Number(amt) / Number(prev) * 100 > r.largeMovePct) {
      out.push({ severity: "HIGH", rule: "large-movement", summary: `${fmtAmount(asset, amt)} left the wallet (${((Number(amt) / Number(prev)) * 100).toFixed(1)}% of prior balance)` });
      break; // one per tx is enough
    }
  }
  if (incoming) {
    const recv = tx.transfers.filter((t) => t.recipient === address).map((t) => fmtAmount(t.asset, t.amount));
    out.push({ severity: "INFO", rule: "incoming", summary: `incoming from ${short(tx.sender)}: ${recv.slice(0, 3).join(", ")}` });
  }
  return out;
}

/** Net balance change of `address` implied by a confirmed tx (fees included). */
export function txDelta(tx: WatchedTx, address: string): Record<string, bigint> {
  const d: Record<string, bigint> = {};
  for (const t of tx.transfers) {
    if (t.kind === "nft") continue; // balances endpoint tracks FTs; NFTs are counted separately
    if (t.sender === address) d[t.asset] = (d[t.asset] ?? 0n) - t.amount;
    if (t.recipient === address) d[t.asset] = (d[t.asset] ?? 0n) + t.amount;
  }
  if (tx.sender === address && !tx.sponsored) d.STX = (d.STX ?? 0n) - tx.fee;
  return d;
}

export interface PollResult {
  state: WatcherState;
  alerts: Alert[]; // new, deduplicated, all severities
  baselined: { address: string; txs: number; wouldBe: Record<Severity, number> }[];
}

const toBig = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, BigInt(v)]));
const toStr = (m: Record<string, bigint>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString()]));

/** Evaluate one healthy poll. Pure: returns the next state and the new alerts. */
export function evaluatePoll(prev: WatcherState, observations: Observation[], r: Rules, opts: EvaluateOpts = {}): PollResult {
  const state: WatcherState = structuredClone(prev);
  const alerted = new Set(state.alerted);
  const alerts: Alert[] = [];
  const baselined: PollResult["baselined"] = [];
  const emit = (a: Alert) => {
    if (alerted.has(a.key) || alerts.some((x) => x.key === a.key)) return;
    alerts.push(a);
  };

  for (const obs of observations) {
    const A = obs.address;
    const st = state.addresses[A];
    const prevBal = st ? toBig(st.balances) : {};
    const seen = new Set(st?.seen ?? []);
    // Confirmed txs at or below the balance read height, not yet evaluated.
    // Anything at or below lastHeight was already reflected in the last balance read.
    const fresh = obs.confirmed.filter(
      (t) => (t.blockHeight ?? 0) <= obs.tipHeight && (!st || (t.blockHeight ?? 0) > st.lastHeight) && !seen.has(t.txid),
    );

    if (!st) {
      // First sight of this address: baseline history. Only txs inside a corrupt-state
      // recovery window are classified; the rest are counted, not alerted.
      const wouldBe: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, INFO: 0 };
      for (const tx of fresh) {
        const inWindow = opts.recoverSince !== undefined && tx.time && Date.parse(tx.time) >= opts.recoverSince;
        for (const f of classifyTx(tx, A, r)) {
          if (inWindow && f.severity !== "INFO") emit({ key: `${tx.txid}:${f.rule}`, severity: f.severity, rule: f.rule, address: A, txid: tx.txid, summary: f.summary });
          else wouldBe[f.severity]++;
        }
      }
      baselined.push({ address: A, txs: fresh.length, wouldBe });
      emit({
        key: `baseline:${A}:${obs.tipHeight}`,
        severity: "INFO",
        rule: "baseline",
        address: A,
        summary: `baselined ${fresh.length} historical txs (of ${obs.historyTotal}) at height ${obs.tipHeight}; not alerted — would have been CRITICAL ${wouldBe.CRITICAL}, HIGH ${wouldBe.HIGH}, INFO ${wouldBe.INFO}`,
      });
    } else {
      // History gap: every fetched confirmed tx is new and there are more we did not fetch.
      const older = obs.confirmed.some((t) => seen.has(t.txid) || (t.blockHeight ?? 0) <= st.lastHeight);
      if (!older && obs.confirmed.length < obs.historyTotal && fresh.length > 0) {
        emit({ key: `history-gap:${A}:${obs.tipHeight}`, severity: "HIGH", rule: "history-gap", address: A, summary: `more new txs than one poll fetches (${fresh.length} fetched, ${obs.historyTotal} total) — some may not be classified; check the explorer` });
      }
      let failedNew = 0;
      const expected: Record<string, bigint> = { ...prevBal };
      for (const tx of fresh) {
        const fs = classifyTx(tx, A, r, prevBal);
        for (const f of fs) emit({ key: `${tx.txid}:${f.rule}`, severity: f.severity, rule: f.rule, address: A, txid: tx.txid, summary: f.summary });
        if (fs.some((f) => f.rule === "failed")) failedNew++;
        // Balance-drop explanation counts only non-CRITICAL (i.e. allowlisted) activity.
        if (!fs.some((f) => f.severity === "CRITICAL")) {
          for (const [k, v] of Object.entries(txDelta(tx, A))) expected[k] = (expected[k] ?? 0n) + v;
        }
      }
      if (failedNew >= r.failedBurst) {
        emit({ key: `failed-burst:${A}:${fresh[0]?.txid}`, severity: "HIGH", rule: "failed-burst", address: A, summary: `${failedNew} failed txs since the last poll` });
      }
      for (const [asset, before] of Object.entries(prevBal)) {
        if (before <= 0n) continue;
        const now = obs.balances[asset] ?? 0n;
        const unexplained = (expected[asset] ?? 0n) - now;
        if (unexplained > 0n && (Number(unexplained) / Number(before)) * 100 > r.balanceDropPct) {
          emit({
            key: `balance-drop:${A}:${asset}:${now}`,
            severity: "CRITICAL",
            rule: "balance-drop",
            address: A,
            summary: `${asset} balance fell ${fmtAmount(asset, before)} → ${fmtAmount(asset, now)}; ${fmtAmount(asset, unexplained)} not explained by allowlisted activity`,
          });
        }
      }
    }

    // Mempool: always classified (a pending drain on the first run still matters).
    for (const tx of obs.mempool) {
      for (const f of classifyTx(tx, A, r)) emit({ key: `${tx.txid}:${f.rule}`, severity: f.severity, rule: f.rule, address: A, txid: tx.txid, summary: f.summary });
    }

    if (obs.missingNonces.length) {
      emit({ key: `nonce-gap:${A}:${obs.missingNonces.join(",")}`, severity: "HIGH", rule: "nonce-gap", address: A, summary: `missing nonces ${obs.missingNonces.join(", ")} — a tx is stuck or was dropped` });
    }

    state.addresses[A] = {
      lastHeight: obs.tipHeight,
      seen: [...fresh.map((t) => t.txid), ...(st?.seen ?? [])].slice(0, MAX_SEEN),
      balances: toStr(obs.balances),
    };
  }

  state.alerted = [...alerts.map((a) => a.key), ...state.alerted].slice(0, MAX_ALERTED);
  return { state, alerts, baselined };
}

export function maxSeverity(alerts: Alert[]): Severity {
  return alerts.reduce<Severity>((m, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[m] ? a.severity : m), "INFO");
}
