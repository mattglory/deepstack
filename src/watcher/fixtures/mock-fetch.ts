// Test-only mock fetch serving the recorded Hiro fixtures (offline). Not a test file itself.

import { readFileSync } from "node:fs";

export const fx = (name: string) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
// Honours the AbortSignal exactly like real fetch, so a hang becomes a timeout. The interval
// stands in for the open socket a real hang holds (AbortSignal.timeout alone is unref'd).
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const keepAlive = setInterval(() => {}, 1000);
    init?.signal?.addEventListener("abort", () => {
      clearInterval(keepAlive);
      reject(new Error("aborted (timeout)"));
    });
  });

/** Serves the fixtures; endpoints listed in `bad` error, hang (until aborted) or return 500. */
export function fixtureFetch(opts: { bad?: Record<string, "error" | "hang" | "500"> } = {}) {
  const calls: string[] = [];
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const base = new URL(url).origin;
    const mode = opts.bad?.[base];
    if (mode === "error") throw new Error("ECONNREFUSED");
    if (mode === "hang") return hang(init);
    if (mode === "500") return json({ error: "down" }, 500);
    const path = new URL(url).pathname;
    if (path === "/extended") return json(fx("mainnet-status.json"));
    if (path.endsWith("/balances")) return json(fx("mainnet-balances.json"));
    if (path.endsWith("/transactions_with_transfers")) return json(fx("mainnet-transactions.json"));
    if (path.endsWith("/mempool")) return json({ limit: 50, offset: 0, total: 0, results: [] });
    if (path.endsWith("/nonces")) return json(fx("mainnet-nonces.json"));
    return json({ error: "not found" }, 404);
  }) as typeof fetch;
  return { f, calls };
}

