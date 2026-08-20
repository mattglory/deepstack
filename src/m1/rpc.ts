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
const isHiroHost = (baseUrl: string) => /(^|\.)hiro\.so\b/.test(baseUrl);

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

export function endpoints(): string[] {
  const fallbacks = (process.env.STACKS_API_FALLBACKS ?? "")
    .split(",")
    .map(strip)
    .filter(Boolean);
  return [strip(config.stacksApi), ...fallbacks];
}

let preferred = 0; // index of the last endpoint that worked (may exceed the list if env changes)

/** Run a read against the first endpoint that answers. Throws only when ALL endpoints fail. */
export async function withRpc<T>(fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const eps = endpoints();
  if (preferred >= eps.length) preferred = 0;
  let lastErr: unknown;
  for (let i = 0; i < eps.length; i++) {
    const idx = (preferred + i) % eps.length;
    try {
      const out = await fn(eps[idx]);
      if (idx !== preferred) {
        console.warn(`  [rpc] ${eps[preferred]} failing — switched to ${eps[idx]}`);
        preferred = idx;
      }
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
