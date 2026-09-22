// DLMM recenter — the shared execution orchestrator used by BOTH the CLI (manual) and the
// agent loop (autonomous). One source of truth for the critical, gotcha-prone bits: token
// asset-name/decimals resolution (from source, never hardcoded), two-sided sizing, input
// caps, and the withdraw→re-add sequence.
//
// recenterOnce() decides open / hold / recenter and, ONLY when live===true, executes it:
//   open      (flat wallet)     -> two-sided add centered on the active bin
//   hold      (active in band)  -> nothing
//   recenter  (active drifted)  -> withdraw ALL bins, then re-add centered on the NEW active bin
// live===false is pure observe: it decides and returns, touches no key and no capital.
//
// SAFETY: Allow-mode input caps on every add (STX .ustx(), USDCx .ft with the resolved asset);
// withdraw uses nominal min-out on the value side (min-sum>0 rule); a gas reserve is always
// kept; target is hard-capped. If a withdraw does not confirm, the recenter aborts before the
// re-add (funds sit safely in the wallet as loose tokens — no half-built position).

import { existsSync } from "node:fs";
import { fetchNonce, fetchCallReadOnlyFunction, cvToJSON } from "@stacks/transactions";
import { withRpc, hiroFetch, hiroHeaders } from "./rpc.js";
import { getStxBalance, type Wallet } from "./wallet.js";
import { DLMM_POOLS, readDlmmState, readBinLiquidityStates, readShareFloors, type DlmmPool, type DlmmState } from "./dlmm-read.js";
import { readUserPosition } from "./dlmm-position.js";
import { distributeAcrossRange, buildAddLiquidity, buildWithdrawLiquidity, buildInputCaps, isNativeStxToken, type PoolRefs, type BinWithdraw } from "./dlmm-write.js";
import { sizeTwoSidedDeposit, decideRecenter, expectedDlp, minDlpFromExpected } from "./dlmm-recenter.js";
import { binRangeFromVol, type RangeOpts } from "./dlmm-position.js";
import { executeDescriptor } from "./dlmm-execute.js";
import { checkNonceSafety } from "./nonce-safety.js";

const API = "https://api.mainnet.hiro.so";
const GAS_RESERVE_USTX = 100_000_000n; // keep 100 STX for gas
// Slippage margin for the per-bin min-dlp guard (dlmm-recenter.ts's expectedDlp), matching the
// codebase's other default slippage (agent.ts's slippageBps: 100). Covers price movement between
// simulation and confirmation, and the active-bin liquidity fee expectedDlp deliberately doesn't
// model. NOT the old MIN_DLP flat-10000 constant — that was the Sep 21 incident's root cause
// (see docs/… incident note): every bin in a multi-position add shared one floor regardless of
// its own size, aborting the whole transaction whenever any thin outer bin couldn't clear it.
const ADD_MIN_DLP_SLIPPAGE_BPS = 100;
const FEE_USTX = 300_000n;
const DEADLINE_SECS = 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TokenMeta { principal: string; native: boolean; asset: string; decimals: number }

/** Resolve a token's real SIP-010 asset name + decimals from its own contract (never hardcode). */
export async function resolveToken(principal: string): Promise<TokenMeta> {
  if (isNativeStxToken(principal)) return { principal, native: true, asset: "", decimals: 6 };
  const [addr, name] = principal.split(".");
  const iface = await (await fetch(`${API}/v2/contracts/interface/${addr}/${name}`, { headers: hiroHeaders(API) })).json();
  const asset = ((iface.fungible_tokens ?? []).map((f: any) => f.name).find((n: string) => !/locked/.test(n))) ?? name;
  let decimals = 6;
  try {
    const dj = cvToJSON(await withRpc((baseUrl) => fetchCallReadOnlyFunction({ contractAddress: addr, contractName: name, functionName: "get-decimals", functionArgs: [], network: "mainnet", senderAddress: addr, client: { baseUrl, fetch: hiroFetch(baseUrl) } }))) as any;
    decimals = Number(dj?.value?.value ?? dj?.value ?? 6);
  } catch { /* keep default */ }
  return { principal, native: false, asset, decimals };
}

export async function ftBalance(addr: string, assetId: string): Promise<bigint> {
  const j = await (await fetch(`${API}/extended/v1/address/${addr}/balances`, { headers: hiroHeaders(API) })).json();
  const ft = j.fungible_tokens ?? {};
  return ft[assetId] ? BigInt(ft[assetId].balance) : 0n;
}

export async function stxPriceUsd(): Promise<number> {
  const j = await (await fetch("https://coins.llama.fi/prices/current/coingecko:blockstack")).json();
  const p = j?.coins?.["coingecko:blockstack"]?.price;
  if (!(p > 0)) throw new Error("could not read STX price");
  return p;
}

export async function btcPriceUsd(): Promise<number> {
  const j = await (await fetch("https://coins.llama.fi/prices/current/coingecko:bitcoin")).json();
  const p = j?.coins?.["coingecko:bitcoin"]?.price;
  if (!(p > 0)) throw new Error("could not read BTC price");
  return p;
}

/** USD price of a pool's X token: STX facade -> STX, sBTC -> BTC, a stablecoin -> $1. */
export async function priceOfToken(tok: TokenMeta): Promise<number> {
  if (tok.native || /token-stx/.test(tok.principal)) return stxPriceUsd();
  if (/sbtc/i.test(tok.asset) || /sbtc/i.test(tok.principal)) return btcPriceUsd();
  if (/usdc|usdh|usda|susd/i.test(tok.asset)) return 1;
  throw new Error(`no USD price mapping for token ${tok.principal} (asset ${tok.asset})`);
}

export async function waitForTx(txid: string, log: (s: string) => void): Promise<string> {
  log(`  ${txid} — confirming…`);
  for (let i = 0; i < 40; i++) {
    await sleep(6000);
    const res = await fetch(`${API}/extended/v1/tx/${txid}`, { headers: hiroHeaders(API) });
    if (res.ok) {
      const j = (await res.json()) as { tx_status?: string; tx_result?: { repr?: string } };
      if (j.tx_status && j.tx_status !== "pending") { log(`  status: ${j.tx_status}${j.tx_result?.repr ? `  ${j.tx_result.repr}` : ""}`); return j.tx_status; }
    }
  }
  return "timeout";
}

export interface RecenterConfig {
  pair: string;
  halfWidth: number; // fallback/floor when sigmaDaily is absent — always used by the manual CLI
  targetUsd: number;
  maxTargetUsd?: number;
  // Vol-adaptive width (opt-in): when set and usable, the DLMM pair's OWN realised vol (not the
  // XYK pair's — see agent-cli.ts) replaces halfWidth via binRangeFromVol, using the pool's real
  // on-chain bin step. Widens the deployed range — and so the recenter trigger, since decideRecenter
  // treats halfWidth as both — during vol spikes, instead of thrashing a fixed-width band against a
  // trending price (the DLMM analogue of bandBpsFromVol for the XYK rebalance band).
  sigmaDaily?: number | null;
  rangeOpts?: RangeOpts;
}
export interface RecenterResult {
  action: "open" | "hold" | "recenter" | "skip";
  reason: string;
  activeBin: number;
  posLo: number | null;
  posHi: number | null;
  posX: number;
  posY: number;
  halfWidth: number;
  executed: boolean;
  // True only for a deliberate pre-broadcast skip (kill switch, nonce-gate) — distinguishes
  // "chose not to try this cycle" from "tried and the chain rejected it", so a caller counting
  // consecutive failures (agent-cli.ts's DLMM_FAIL_STREAK_LIMIT) doesn't penalize a condition
  // that's expected to clear on its own next cycle.
  skipped?: boolean;
  withdrawTxid?: string;
  addTxid?: string;
}

// Read a token's wallet balance (native STX or SIP-010), in the token's base units.
async function tokenBalance(w: Wallet, tok: TokenMeta): Promise<bigint> {
  if (tok.native) return (await getStxBalance(w.address, w.network)).microStx;
  return ftBalance(w.address, `${tok.principal}::${tok.asset}`);
}

// Build + broadcast a two-sided add centered on `activeBin`. Handles X = native STX (stx-usdcx)
// or a SIP-010 like sBTC (sbtc-usdcx): price + decimals come from the resolved token, input caps
// branch native/FT automatically. Returns txid, or throws.
async function executeAdd(w: Wallet, poolDef: DlmmPool, st: DlmmState, xTok: TokenMeta, yTok: TokenMeta, cfg: RecenterConfig, log: (s: string) => void): Promise<string> {
  const cap = cfg.maxTargetUsd ?? 250;
  if (!(cfg.targetUsd > 0) || cfg.targetUsd > cap) throw new Error(`target must be >0 and ≤ ${cap}`);
  const xPrice = await priceOfToken(xTok);
  const nativeStx = (await getStxBalance(w.address, w.network)).microStx;
  if (nativeStx < FEE_USTX) throw new Error(`insufficient native STX for gas (need ~${Number(FEE_USTX) / 1e6})`);
  // X available: if X IS native STX, keep the gas reserve out of it; otherwise use the full FT balance.
  const xBalRaw = await tokenBalance(w, xTok);
  const availX = xTok.native ? (xBalRaw > GAS_RESERVE_USTX ? xBalRaw - GAS_RESERVE_USTX : 0n) : xBalRaw;
  const availY = await tokenBalance(w, yTok);
  const size = sizeTwoSidedDeposit(cfg.targetUsd, xPrice, availX, availY, xTok.decimals, yTok.decimals);
  if (size.xBase <= 0n || size.yBase <= 0n)
    throw new Error(`cannot size two-sided: ${xTok.asset || "STX"} ${Number(availX) / 10 ** xTok.decimals}, ${yTok.asset} ${Number(availY) / 10 ** yTok.decimals}`);
  const deposits = distributeAcrossRange(st.activeBinId, cfg.halfWidth, size.xBase, size.yBase);

  // Per-bin min-dlp, sized from each bin's OWN live state (dlmm-recenter.ts's expectedDlp) — the
  // Sep 21 incident (15 real aborted transactions) happened because a single flat floor was
  // applied to every bin in a multi-position add regardless of how many shares that bin's slice
  // actually mints. Throws if any bin can't be read: an incomplete pre-flight must not broadcast
  // a real transaction on a partial guess, same discipline dlmm-position.ts's readUserPosition
  // already applies to reading an existing position.
  const bins = await readBinLiquidityStates(poolDef, st.coreAddress, st.initialPrice, st.binStep, deposits.map((d) => d.signedBin));
  const { minBinShares, minBurntShares } = await readShareFloors(st.coreAddress);
  const sized = deposits.map((d) => {
    const bin = bins.get(d.signedBin);
    if (!bin) throw new Error(`no live state for bin ${d.signedBin} — aborting add rather than guessing min-dlp`);
    const expected = expectedDlp(d.xAmount, d.yAmount, bin, minBurntShares);
    const floor = bin.binShares === 0n ? minBinShares : 1n; // the core's own floor is EMPTY-bin-only
    return { ...d, minDlp: minDlpFromExpected(expected, ADD_MIN_DLP_SLIPPAGE_BPS, floor) };
  });

  const desc = buildAddLiquidity({ poolName: poolDef.name, xToken: xTok.principal, yToken: yTok.principal } as PoolRefs, sized, { deadlineTime: Math.floor(Date.now() / 1000) + DEADLINE_SECS });
  const sumX = deposits.reduce((s, d) => s + d.xAmount, 0n);
  const sumY = deposits.reduce((s, d) => s + d.yAmount, 0n);
  const pcs = buildInputCaps(w.address, [
    // 2% headroom for the pool's liquidity fee; +0.3 STX only when X is native STX (the fee leg).
    { token: xTok.principal, asset: xTok.asset, max: sumX + sumX / 50n + (xTok.native ? 300_000n : 0n) },
    { token: yTok.principal, asset: yTok.asset, max: sumY + sumY / 50n },
  ]);
  const xh = (Number(sumX) / 10 ** xTok.decimals).toFixed(xTok.decimals === 8 ? 6 : 3);
  log(`  add: ${xh} ${xTok.asset || "STX"} + ${(Number(sumY) / 10 ** yTok.decimals).toFixed(3)} ${yTok.asset} across ${deposits.length} bins [${deposits[0].signedBin}..${deposits[deposits.length - 1].signedBin}]`);
  const nonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
  const r = await executeDescriptor(desc, { live: true, yesMainnet: true, senderKey: w.key, postConditions: pcs, feeMicroStx: FEE_USTX, nonce });
  if (!r.txid) throw new Error("add broadcast returned no txid");
  return r.txid;
}

/**
 * One recenter cycle. live===false: decide + return (observe). live===true: execute the decision.
 * Never throws to the caller on execution failure of a sub-step is the caller's concern — here we
 * throw so the agent's own try/catch journals it and the tick survives.
 */
export async function recenterOnce(w: Wallet, cfg: RecenterConfig, live: boolean, log: (s: string) => void = () => {}): Promise<RecenterResult> {
  const poolDef = DLMM_POOLS.find((p) => p.key === cfg.pair);
  if (!poolDef) throw new Error(`unknown DLMM pair '${cfg.pair}'`);
  const st = await readDlmmState(poolDef);
  if (!st) throw new Error(`could not read pool state for ${cfg.pair}`);
  const halfWidth =
    cfg.sigmaDaily != null && cfg.sigmaDaily > 0
      ? binRangeFromVol(cfg.sigmaDaily, st.binStep, { maxHalfWidthBins: 50, ...cfg.rangeOpts }).halfWidthBins
      : cfg.halfWidth;
  const effCfg: RecenterConfig = { ...cfg, halfWidth };
  const [xTok, yTok] = await Promise.all([resolveToken(st.xToken), resolveToken(st.yToken)]);
  const pos = await readUserPosition(poolDef, w.address);
  const dec = decideRecenter(st.activeBinId, { lo: pos.lowerSignedBin, hi: pos.upperSignedBin }, halfWidth);
  const base: RecenterResult = {
    action: dec.action, reason: dec.reason, activeBin: st.activeBinId,
    posLo: pos.lowerSignedBin, posHi: pos.upperSignedBin,
    posX: +(Number(pos.totalX) / 1e6).toFixed(4), posY: +(Number(pos.totalY) / 1e6).toFixed(4),
    halfWidth, executed: false,
  };
  if (dec.action === "hold" || !live) return base;

  // The manual kill switch (safety.ts's own check) previously covered only the XYK path — the
  // Sep 21 incident's failure loop ran for ~7 hours with no way to stop it short of editing
  // .env and restarting the whole process. Same check, same file (KILL), now here too.
  if (process.env.KILL_SWITCH === "1" || existsSync("KILL")) {
    return { ...base, reason: "kill switch engaged — DLMM broadcast skipped", skipped: true };
  }

  // Same fail-closed nonce-gap / pending-tx check as the XYK path (agent-cli.ts) — a
  // withdraw-then-add recenter is two sequential broadcasts, so a stuck prior tx here is
  // exactly the condition that risks piling nonces on top of an unconfirmed one.
  const nonceSafety = await checkNonceSafety(w.address).catch(
    (err) => ({ safe: false, reason: `nonce check failed: ${(err as Error).message}`, missingNonces: [], mempoolPending: 0 }),
  );
  if (!nonceSafety.safe) return { ...base, reason: nonceSafety.reason ?? "nonce check failed", skipped: true };

  if (dec.action === "open") {
    const addTxid = await executeAdd(w, poolDef, st, xTok, yTok, effCfg, log);
    const s = await waitForTx(addTxid, log);
    return { ...base, executed: s === "success", addTxid, reason: s === "success" ? "opened" : `open ${s}` };
  }

  // recenter: withdraw all, then re-add centered on the (re-read) active bin
  const withdrawals: BinWithdraw[] = pos.bins.map((b) => ({ signedBin: b.signedBin, amount: b.userShares, minX: b.userX > 0n ? 1n : 0n, minY: b.userY > 0n ? 1n : 0n }));
  const wdesc = buildWithdrawLiquidity({ poolName: poolDef.name, xToken: st.xToken, yToken: st.yToken } as PoolRefs, withdrawals, { deadlineTime: Math.floor(Date.now() / 1000) + DEADLINE_SECS });
  log(`  recenter 1/2 — withdraw ${pos.bins.length} bins`);
  const wnonce = await withRpc((baseUrl) => fetchNonce({ address: w.address, network: "mainnet", client: { baseUrl, fetch: hiroFetch(baseUrl) } }));
  const wr = await executeDescriptor(wdesc, { live: true, yesMainnet: true, senderKey: w.key, allowNoInputCaps: true, feeMicroStx: FEE_USTX, nonce: wnonce });
  if (!wr.txid) throw new Error("withdraw returned no txid");
  const ws = await waitForTx(wr.txid, log);
  if (ws !== "success") return { ...base, withdrawTxid: wr.txid, reason: `withdraw ${ws} — aborted before re-add (funds safe in wallet)` };
  const st2 = (await readDlmmState(poolDef)) ?? st;
  log(`  recenter 2/2 — re-add centered on active ${st2.activeBinId}`);
  const addTxid = await executeAdd(w, poolDef, st2, xTok, yTok, effCfg, log);
  const as = await waitForTx(addTxid, log);
  return { ...base, executed: as === "success", withdrawTxid: wr.txid, addTxid, reason: as === "success" ? "recentered" : `re-add ${as}` };
}
