// Contracts the live agent legitimately touches — duplicated here ON PURPOSE.
//
// The watcher runs off the VPS and must keep working (and keep alerting) even if the agent's
// code is changed or broken, so it does not import the agent's modules. Each entry names the
// source of truth it was copied from; if the agent starts calling something new, add it here
// in the same change (an un-listed call is a CRITICAL alert, which is the point).
//
// Two kinds:
//   "call"         — a contract the agent's wallet calls directly (tx.contract_call target).
//   "counterparty" — a contract that may RECEIVE the wallet's funds inside an allowlisted call
//                    (pools, cores) but that the agent never calls directly.
// Both kinds are acceptable recipients of outgoing transfers. Human/owner addresses that may
// receive transfers are NOT here — they come from OWNER_ALLOWLIST at runtime.

export type Network = "mainnet" | "testnet";

export interface AllowEntry {
  id: string; // "ADDR.contract-name" (or a standard principal for counterparty-only entries)
  kind: "call" | "counterparty";
  label: string;
  source: string; // where the agent references it
}

const BF = "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR"; // Bitflow XYK deployer
const DLMM = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD"; // Bitflow DLMM deployer
const AGENT = "SP23PF43T06AH0BA2XD7XYKH16GECH242S238WK60"; // live agent hot wallet

export const AGENT_WALLET = AGENT;

export const MAINNET_ALLOWLIST: readonly AllowEntry[] = [
  // --- direct call targets ---
  { id: `${BF}.xyk-core-v-1-2`, kind: "call", label: "Bitflow XYK core (swap/add/withdraw)", source: "src/m1/contracts.ts:11-14, src/m1/actions.ts:95-97" },
  { id: `${DLMM}.dlmm-liquidity-router-v-1-2`, kind: "call", label: "Bitflow DLMM liquidity router", source: "src/m1/dlmm-write.ts:15-16, 154-202" },
  { id: `${DLMM}.dlmm-swap-router-v-1-2`, kind: "call", label: "Bitflow DLMM swap router", source: "src/m1/dlmm-write.ts:208, 225-227" },
  { id: "SP20XD46NGAX05ZQZDKFYCCX49A3852BQABNP0VG5.flashstack-stx-core", kind: "call", label: "FlashStack STX core (flash-loan)", source: "src/m2/flash-rebalance-exec.ts:19, 122-124" },
  { id: `${AGENT}.deepstack-rebalance-receiver`, kind: "call", label: "DeepStack flash-rebalance receiver (arm)", source: "src/m2/flash-rebalance-exec.ts:20, 97-99" },
  // SIP-010 `transfer` targets used by key rotation (recipient is still checked against
  // OWNER_ALLOWLIST via the transfer events, so a transfer to a stranger stays CRITICAL).
  { id: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token", kind: "call", label: "sBTC token", source: "src/m1/contracts.ts:44, src/m1/key-rotation.ts:29-33" },
  { id: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx", kind: "call", label: "USDCx token", source: "src/m1/key-rotation.ts:35-39" },
  { id: `${BF}.xyk-pool-sbtc-stx-v-1-1`, kind: "call", label: "XYK sBTC-STX pool / LP token", source: "src/m1/contracts.ts:42-43, src/m1/key-rotation.ts:23-27" },
  // --- counterparties (receive funds inside allowlisted calls) ---
  { id: `${BF}.xyk-pool-stx-aeusdc-v-1-2`, kind: "counterparty", label: "XYK STX-aeUSDC pool (exit-only)", source: "src/m1/contracts.ts:52-53" },
  { id: `${BF}.token-stx-v-1-2`, kind: "counterparty", label: "Bitflow native-STX facade", source: "src/m1/contracts.ts:45, src/m1/dlmm-write.ts:21" },
  { id: `${DLMM}.dlmm-pool-ststx-stx-v-1-bps-1`, kind: "counterparty", label: "DLMM stSTX-STX pool", source: "src/m1/dlmm-read.ts:48" },
  { id: `${DLMM}.dlmm-pool-stx-usdcx-v-2-bps-10`, kind: "counterparty", label: "DLMM STX-USDCx v2 pool", source: "src/m1/dlmm-read.ts:49" },
  { id: `${DLMM}.dlmm-pool-sbtc-usdcx-v-1-bps-10`, kind: "counterparty", label: "DLMM sBTC-USDCx pool", source: "src/m1/dlmm-read.ts:50" },
  { id: `${DLMM}.dlmm-pool-stx-usdcx-v-1-bps-10`, kind: "counterparty", label: "DLMM STX-USDCx v1 pool", source: "src/m1/dlmm-read.ts:55" },
  // Not referenced in source: observed on chain receiving the protocol fee leg of every
  // xyk-core swap from the agent wallet (132 transfers in the wallet's history, 2026-11-03).
  { id: "SP31C60QVZKZ9CMMZX73TQ3F3ZZNS89YX2DCCFT8P", kind: "counterparty", label: "Bitflow XYK protocol-fee address (observed on chain)", source: "on-chain: xyk-core-v-1-2 swap events" },
];

// Testnet: the vault v2 rehearsal contracts (the only testnet activity worth watching).
const TV = "ST2ZBFNYZASTNQHSQSDV2NC04Y0513GVV5SHK3W5A";
export const TESTNET_ALLOWLIST: readonly AllowEntry[] = [
  { id: `${TV}.deepstack-vault-v2`, kind: "call", label: "vault v2 (testnet)", source: "src/m1/vault-v2-cli.ts:41" },
  { id: `${TV}.deepstack-vault-v2-token`, kind: "call", label: "vault v2 share token (testnet)", source: "src/m1/vault-v2-cli.ts:42, src/m1/key-rotation.ts:44-50" },
];

export function defaultAllowlist(network: Network): readonly AllowEntry[] {
  return network === "mainnet" ? MAINNET_ALLOWLIST : TESTNET_ALLOWLIST;
}
