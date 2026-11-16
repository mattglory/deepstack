// Off-chain message signing with the agent key, for registrations that ask a wallet to sign a text
// message (for example a liquidity campaign enrolment). The agent key lives only on the server, so
// it cannot be connected to a browser wallet; this signs the same way a wallet does.
//
// Uses the standard Stacks message format (the "\x17Stacks Signed Message:\n" prefix, as Leather
// and Xverse sign it). That prefix keeps a message signature from ever being valid as a
// transaction signature, so signing a message cannot move funds.

import { hashMessage, verifyMessageSignatureRsv } from "@stacks/encryption";
import { signMessageHashRsv, privateKeyToPublic, publicKeyToAddress } from "@stacks/transactions";

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Problems that stop a message from being signed; empty means it is acceptable. */
export function messageProblems(message: string): string[] {
  const p: string[] = [];
  if (message.trim().length === 0) p.push("the message is empty");
  if (message.length > 4000) p.push("the message is longer than 4000 characters");
  // A bare hex blob is what a transaction or a hash looks like, not a readable message: refuse it,
  // so nobody can be talked into signing something they cannot read.
  if (/^(0x)?[0-9a-fA-F]{40,}$/.test(message.trim())) p.push("the message is a hex string, not readable text; ask for the readable message");
  return p;
}

export function signStacksMessage(message: string, privateKey: string, network: "mainnet" | "testnet"): { address: string; publicKey: string; signature: string } {
  const problems = messageProblems(message);
  if (problems.length) throw new Error(`refusing to sign: ${problems.join("; ")}`);
  const publicKey = privateKeyToPublic(privateKey) as string;
  const signature = signMessageHashRsv({ messageHash: toHex(hashMessage(message)), privateKey });
  if (!verifyMessageSignatureRsv({ signature, message, publicKey })) throw new Error("self-check failed: the signature does not verify");
  return { address: publicKeyToAddress(publicKey, network), publicKey, signature };
}
