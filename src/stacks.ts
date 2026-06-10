// On-chain reads against a pool's Clarity contract.
//
// Two capabilities the grant PoC needs to prove:
//  1) introspect ANY pool contract (list its read-only functions) without
//     hardcoding/guessing signatures — via the Hiro contract-interface endpoint.
//  2) actually call a read-only Clarity function and decode the result —
//     via fetchCallReadOnlyFunction from @stacks/transactions (v7).

import { config } from "./config.js";

export interface ContractFn {
  name: string;
  access: string; // "read_only" | "public" | "private"
  args: { name: string; type: unknown }[];
}

// Split "SP....address.contract-name" into its two parts.
export function splitPrincipal(principal: string): {
  address: string;
  name: string;
} {
  const [address, name] = principal.split(".");
  if (!address || !name) {
    throw new Error(`Not a contract principal: ${principal}`);
  }
  return { address, name };
}

// GET the contract ABI/interface and return its read-only functions.
export async function getReadOnlyFunctions(principal: string): Promise<ContractFn[]> {
  const { address, name } = splitPrincipal(principal);
  const url = `${config.stacksApi}/v2/contracts/interface/${address}/${name}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`interface fetch failed for ${principal}: ${res.status}`);
  }
  const abi = (await res.json()) as { functions: ContractFn[] };
  return abi.functions.filter((f) => f.access === "read_only");
}

// Fetch a SIP-010 token's decimals via its get-decimals read-only function.
export async function getDecimals(tokenPrincipal: string): Promise<number> {
  const json = (await callNoArgReadOnly(tokenPrincipal, "get-decimals")) as any;
  // (response uint) -> json.value.value is the uint string
  const raw = json?.value?.value ?? json?.value;
  return Number(raw);
}

// Call a zero-argument read-only function and return a plain JS value.
// Kept narrow on purpose: for the spike we only auto-call no-arg readers so we
// never have to fabricate argument encodings we haven't verified.
export async function callNoArgReadOnly(
  principal: string,
  functionName: string,
): Promise<unknown> {
  const { address, name } = splitPrincipal(principal);
  // Imported lazily so the introspection path works even before deps install.
  const { fetchCallReadOnlyFunction, cvToJSON } = await import(
    "@stacks/transactions"
  );
  const cv = await fetchCallReadOnlyFunction({
    contractAddress: address,
    contractName: name,
    functionName,
    functionArgs: [],
    network: "mainnet",
    senderAddress: config.senderAddress,
  });
  return cvToJSON(cv);
}
