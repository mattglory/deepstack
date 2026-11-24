// Wallet balances read from the node instead of the indexer, so they can be pinned to the same
// block as every contract read in a snapshot (rpc.ts atChainTip, review R105-1).
//
// Hiro's /extended/v1/address/{a}/balances comes from its indexer and takes no block height, so a
// balance read there could be newer or older than the pool and position reads beside it. The node's
// /v2/accounts and a token's SIP-010 `get-balance` accept `tip=`, which hiroFetch adds inside
// atChainTip(). Used only while a tip is pinned; elsewhere the indexer reads stay as they were.

import { fetchCallReadOnlyFunction, cvToJSON, principalCV } from "@stacks/transactions";
import { withRpc, hiroFetch } from "./rpc.js";

/** Unlocked micro-STX from /v2/accounts (the agent wallet never stacks, so this is its spendable balance). */
export async function nodeStxBalance(address: string): Promise<bigint> {
  return withRpc(async (baseUrl) => {
    const r = await hiroFetch(baseUrl)(`${baseUrl}/v2/accounts/${address}?proof=0`);
    if (!r.ok) throw new Error(`account read: HTTP ${r.status}`);
    const j = (await r.json()) as { balance?: string };
    if (typeof j.balance !== "string" || !/^0x[0-9a-f]+$/i.test(j.balance)) throw new Error("account read: unexpected balance");
    return BigInt(j.balance);
  });
}

/** A SIP-010 balance (base units) via the token contract's `get-balance`. `assetId` is "<contract>::<asset>". */
export async function nodeFtBalance(address: string, assetId: string): Promise<bigint> {
  const [contractAddress, contractName] = assetId.split("::")[0].split(".");
  if (!contractAddress || !contractName) throw new Error(`not a token asset id: ${assetId}`);
  const cv = await withRpc((baseUrl) =>
    fetchCallReadOnlyFunction({
      contractAddress,
      contractName,
      functionName: "get-balance",
      functionArgs: [principalCV(address)],
      network: "mainnet",
      senderAddress: address,
      client: { baseUrl, fetch: hiroFetch(baseUrl) },
    }),
  );
  const j = cvToJSON(cv) as { success?: boolean; value?: { value?: string } };
  if (!j.success || typeof j.value?.value !== "string") throw new Error(`get-balance on ${contractAddress}.${contractName}: unexpected result`);
  return BigInt(j.value.value);
}
