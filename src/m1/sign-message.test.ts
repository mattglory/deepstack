// Unit tests for off-chain message signing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyMessageSignatureRsv } from "@stacks/encryption";
import { randomPrivateKey, getAddressFromPrivateKey } from "@stacks/transactions";
import { signStacksMessage, messageProblems } from "./sign-message.js";

test("sign: a wallet-style signature over the exact text, from the key's own address", () => {
  const key = randomPrivateKey();
  const msg = "Enroll SP… in Stack Sats\nNonce: 12345";
  const s = signStacksMessage(msg, key, "mainnet");
  assert.equal(s.address, getAddressFromPrivateKey(key, "mainnet"));
  assert.ok(verifyMessageSignatureRsv({ signature: s.signature, message: msg, publicKey: s.publicKey }));
  assert.equal(verifyMessageSignatureRsv({ signature: s.signature, message: msg + " ", publicKey: s.publicKey }), false);
});

test("refuses empty, oversized and unreadable hex messages", () => {
  assert.ok(messageProblems("").length);
  assert.ok(messageProblems("x".repeat(4001)).length);
  assert.ok(messageProblems("0x" + "ab".repeat(40)).length);
  assert.deepEqual(messageProblems("I agree to the Stack Sats terms."), []);
  assert.throws(() => signStacksMessage("0x" + "ab".repeat(40), randomPrivateKey(), "mainnet"), /refusing/);
});
