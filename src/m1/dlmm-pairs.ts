// Which DLMM pairs the agent manages, and where each one keeps its state.
//
// The PRIMARY pair is DLMM_OBSERVE_PAIR, exactly as before: its state files, its metrics fields
// (dlmmBasis, dlmmFees, the samples' dlmmValueY/dlmmActiveBin) and its settings (DLMM_LIVE,
// DLMM_TARGET_USD, DLMM_PIN_HALF_WIDTH, ...) are unchanged, so a box without DLMM_EXTRA_PAIRS
// behaves exactly as it did.
//
// EXTRA pairs (DLMM_EXTRA_PAIRS, comma-separated pool keys) are managed alongside it, each with
// its own state: the same file names with ".<pair>" before the extension, metrics under
// m.dlmmPairs[pair], and per-pair settings named <SETTING>__<PAIR> (pair upper-cased, "-" -> "_"),
// for example DLMM_TARGET_USD__STX_SBTC. An extra pair never falls back to the primary's
// settings: a target or width sized for one pool is not a safe default for another.
//
// Off by default, twice over: an extra pair only broadcasts when DLMM_LIVE=1 AND
// DLMM_EXTRA_LIVE=1, and the agent never OPENS an extra pair's position on its own (it only
// recenters one that exists). Opening is attended (m1:dlmm-recenter -- open), because an open
// sizes from wallet balances that the XYK position and the primary pair also draw on.

// Pools a position can live in (keys of DLMM_POOLS in dlmm-read.ts; a test keeps the two in step).
// stx-usdcx-v1 is a conversion route, not a position pair. No import of dlmm-read here: metrics.ts
// uses this module, and must stay free of the RPC layer.
export const POSITION_PAIRS: readonly string[] = ["stx-usdcx", "sbtc-usdcx", "stx-sbtc", "ststx-stx"];

export function primaryDlmmPair(): string | null {
  const p = process.env.DLMM_OBSERVE_PAIR?.trim();
  return p ? p : null;
}

/** The extra pairs, validated. Throws on an unknown or non-position pool, or the primary listed again. */
export function extraDlmmPairs(): string[] {
  const raw = process.env.DLMM_EXTRA_PAIRS ?? "";
  const primary = primaryDlmmPair();
  const out: string[] = [];
  for (const k of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!POSITION_PAIRS.includes(k)) throw new Error(`DLMM_EXTRA_PAIRS: '${k}' is not a known DLMM position pair`);
    if (k === primary) throw new Error(`DLMM_EXTRA_PAIRS: '${k}' is already the primary pair (DLMM_OBSERVE_PAIR)`);
    if (!out.includes(k)) out.push(k);
  }
  if (out.length && !primary) throw new Error("DLMM_EXTRA_PAIRS needs a primary pair (DLMM_OBSERVE_PAIR) first");
  return out;
}

/**
 * True for no pair, the primary pair, or any pair when no primary is configured: the state and
 * settings that existed before extra pairs. Without DLMM_OBSERVE_PAIR (tests, a laptop CLI run)
 * everything behaves exactly as before.
 */
export function isPrimaryPair(pair: string | null | undefined): boolean {
  const primary = primaryDlmmPair();
  return !pair || !primary || pair === primary;
}

/** True for a pair listed in DLMM_EXTRA_PAIRS (false for the primary, or any other pair). */
export function isExtraPair(pair: string | null | undefined): boolean {
  if (!pair || pair === primaryDlmmPair()) return false;
  try {
    return extraDlmmPairs().includes(pair);
  } catch {
    return false;
  }
}

/**
 * The state file for `pair`: `path` itself for the primary pair (or no pair), otherwise
 * `path` with ".<pair>" inserted before its extension (journal/dlmm-deposit.stx-sbtc.json).
 * Keyed on "not the primary" rather than "is listed as extra", so a manual CLI run for some
 * other pair can never write into the primary's files.
 */
export function pairScopedPath(path: string, pair?: string | null): string {
  if (!pair || isPrimaryPair(pair)) return path;
  if (!/^[a-z0-9-]+$/.test(pair)) throw new Error(`bad pair key '${pair}'`);
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? `${path.slice(0, dot)}.${pair}${path.slice(dot)}` : `${path}.${pair}`;
}

/** The per-pair name of a setting: DLMM_TARGET_USD + stx-sbtc -> DLMM_TARGET_USD__STX_SBTC. */
export function pairSettingName(name: string, pair: string): string {
  return `${name}__${pair.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * A setting for `pair`: the plain variable for the primary pair (or no pair), the per-pair one
 * for any other pair, with no fallback between them. undefined when unset.
 */
export function pairSetting(name: string, pair?: string | null): string | undefined {
  const v = isPrimaryPair(pair) ? process.env[name] : process.env[pairSettingName(name, pair as string)];
  return v === undefined || v.trim() === "" ? undefined : v;
}

/** Extra pairs may broadcast only with both switches on. */
export function extraPairsLive(): boolean {
  return process.env.DLMM_LIVE === "1" && process.env.DLMM_EXTRA_LIVE === "1";
}
