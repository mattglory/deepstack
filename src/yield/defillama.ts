// Live yield data from DefiLlama's public yields API (no key required).
// We use it as the read-only data source for Stacks lending pools — the same
// "use a public endpoint, verify on-chain later" approach as the Bitflow PoC.

export interface LlamaPool {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number | null; // total
  apyBase: number | null;
  apyReward: number | null;
  pool: string; // DefiLlama pool UUID
  stablecoin?: boolean;
}

const YIELDS_API = "https://yields.llama.fi/pools";

// Fetch all pools on a given chain (default Stacks), optionally limited to
// certain project slugs (e.g. zest-v2, granite).
export async function fetchChainPools(
  chain = "Stacks",
  projects?: string[],
): Promise<LlamaPool[]> {
  const res = await fetch(YIELDS_API);
  if (!res.ok) {
    throw new Error(`DefiLlama yields fetch failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: LlamaPool[] };
  const want = projects?.map((p) => p.toLowerCase());
  return (json.data ?? [])
    .filter((p) => (p.chain ?? "").toLowerCase() === chain.toLowerCase())
    .filter((p) => !want || want.includes((p.project ?? "").toLowerCase()))
    .map((p) => ({
      ...p,
      tvlUsd: Number(p.tvlUsd) || 0,
      apy: p.apy == null ? null : Number(p.apy),
      apyBase: p.apyBase == null ? null : Number(p.apyBase),
      apyReward: p.apyReward == null ? null : Number(p.apyReward),
    }));
}
