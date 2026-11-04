// RPC failover — one provider must not be a single point of failure for a ≥95% uptime SLA.
//
// Every read the agent makes (Clarity read-onlys, balances, tx confirmation) previously
// resolved to a single hardcoded endpoint; a Hiro outage would have taken the whole pilot
// with it. withRpc() tries the primary (STACKS_API) then each STACKS_API_FALLBACKS entry
// in order, sticking with the last endpoint that worked so a dead primary costs one
// failure once, not one per call. No fallbacks configured = exactly the old behaviour.
//
// Fallbacks must speak the same Stacks/Hiro API surface (a QuickNode-style provider or a
// self-hosted stacks-blockchain-api). Mainnet only — testnet reads don't carry SLA risk.

import { config } from "../config.js";

const strip = (s: string) => s.trim().replace(/\/+$/, "");

// Hiro's unauthenticated rate limit is 50 requests/min, SHARED across every endpoint,
// easy to exhaust with a single position read (dozens of calls) let alone concurrent
// activity from the live agent and manual CLI checks. An API key raises that to 900/min.
// Attach it only when the target is actually a Hiro host — the QuickNode fallback (or any
// other) neither needs nor recognizes it.
//
// Matched on the PARSED hostname (C8 / DSA-25): the old regex /(^|\.)hiro\.so\b/ also matched
// https://api.hiro.so.attacker.tld or a ".hiro.so" in a path/query, which would send the key to
// a non-Hiro host. https only, so the key never travels in clear text.
const isHiroHost = (baseUrl: string) => {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" && (u.hostname === "hiro.so" || u.hostname.endsWith(".hiro.so"));
  } catch {
    return false;
  }
};

/**
 * An endpoint as it may appear in logs and errors: scheme + host (+ port) only. Providers such
 * as QuickNode put the access token in the path or query, and these strings reach journald and
 * the journal's cycle-error records (C8 / DSA-25).
 */
export function redactEndpoint(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return u.pathname === "/" && !u.search ? u.origin : `${u.origin}/…`;
  } catch {
    return "<invalid endpoint>";
  }
}

/** Extra headers to send a Hiro endpoint — the API key if configured, empty otherwise. */
export function hiroHeaders(baseUrl: string): Record<string, string> {
  const key = process.env.HIRO_API_KEY;
  return key && isHiroHost(baseUrl) ? { "x-api-key": key } : {};
}

/**
 * A fetch that attaches the Hiro API key when baseUrl is a Hiro host. Pass as
 * `client: { baseUrl, fetch: hiroFetch(baseUrl) }` to any @stacks/transactions call that
 * accepts a client — those functions call `client.fetch(url, init)` internally.
 */
export function hiroFetch(baseUrl: string): typeof fetch {
  const extra = hiroHeaders(baseUrl);
  if (Object.keys(extra).length === 0) return fetch;
  return ((url: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...extra } })) as typeof fetch;
}

// Every endpoint must be https (C8 / DSA-25): reads over plain http can be altered in transit,
// and the agent sizes and prices trades from them. A misconfigured endpoint throws, so every
// read fails and nothing is broadcast, rather than silently trusting it.
export function endpoints(): string[] {
  const fallbacks = (process.env.STACKS_API_FALLBACKS ?? "")
    .split(",")
    .map(strip)
    .filter(Boolean);
  const eps = [strip(config.stacksApi), ...fallbacks];
  for (const e of eps) {
    let ok = false;
    try {
      ok = new URL(e).protocol === "https:";
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`refusing non-https Stacks API endpoint ${redactEndpoint(e)} (STACKS_API / STACKS_API_FALLBACKS)`);
  }
  return eps;
}

let preferred = 0; // index of the last endpoint that worked (may exceed the list if env changes)

// A hanging (not erroring) endpoint previously blocked withRpc forever — no fallback ever
// triggered because the loop was waiting on a promise that never settled. Race each attempt
// against a timeout so a stuck endpoint is treated as a failure like any other and the loop
// moves on to the next one.
const DEFAULT_RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS ?? 15_000);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Run a read against the first endpoint that answers. Throws only when ALL endpoints fail
 * (including timing out). `timeoutMs` bounds each individual endpoint attempt, not the whole
 * call — a full pass over N endpoints can take up to N * timeoutMs in the worst case.
 */
export async function withRpc<T>(fn: (baseUrl: string) => Promise<T>, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<T> {
  const eps = endpoints();
  if (preferred >= eps.length) preferred = 0;
  let lastErr: unknown;
  for (let i = 0; i < eps.length; i++) {
    const idx = (preferred + i) % eps.length;
    try {
      const out = await withTimeout(fn(eps[idx]), timeoutMs, `RPC call to ${redactEndpoint(eps[idx])}`);
      if (idx !== preferred) {
        console.warn(`  [rpc] ${redactEndpoint(eps[preferred])} failing — switched to ${redactEndpoint(eps[idx])}`);
        preferred = idx;
      }
      return out;
    } catch (err) {
      // Library errors echo the full request URL ("Attempted to fetch <url>..."); strip the
      // endpoint's path/query from the message before it can reach a log or the journal.
      if (err instanceof Error && err.message.includes(eps[idx])) err.message = err.message.split(eps[idx]).join(redactEndpoint(eps[idx]));
      lastErr = err;
    }
  }
  throw lastErr;
}
