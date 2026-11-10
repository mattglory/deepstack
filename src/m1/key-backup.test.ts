// Unit tests for the key backup gate (DSA-01): recipients, fingerprints, gpg args, attestation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRecipientFiles, parseFingerprints, gpgEncryptArgs, keyFromBackupText, attestationProblems, sha256Hex, MIN_RECIPIENTS, type Attestation } from "./key-backup.js";

const A = "A".repeat(40);
const B = "B".repeat(40);
const ADDR = "SP2NEWADDRESS";
const SHA = sha256Hex("ciphertext");
const good = (): Attestation => ({ address: ADDR, backupSha256: SHA, recipients: [A, B], verifiedBy: [{ name: "custodian", fingerprint: B, at: "2026-11-03T00:00:00Z" }], at: "2026-11-03T00:00:00Z" });

test("parseRecipientFiles: needs two distinct custodian files", () => {
  assert.throws(() => parseRecipientFiles(undefined), /at least 2/);
  assert.throws(() => parseRecipientFiles("/k/a.asc"), /at least 2/);
  assert.throws(() => parseRecipientFiles("/k/a.asc, /k/a.asc"), /at least 2/);
  assert.deepEqual(parseRecipientFiles(" /k/a.asc,/k/b.asc ,"), ["/k/a.asc", "/k/b.asc"]);
  assert.equal(MIN_RECIPIENTS, 2);
});

test("parseFingerprints: primary key fingerprint only, not subkeys", () => {
  const colons = [
    "pub:-:255:22:AAAA:1700000000:::-:::scESC::::::23::0:",
    `fpr:::::::::${A.toLowerCase()}:`,
    "uid:-::::1700000000::HASH::custodian a::::::::::0:",
    "sub:-:255:18:SUB1:1700000000::::::e::::::23:",
    `fpr:::::::::${"C".repeat(40)}:`,
  ].join("\n");
  assert.deepEqual(parseFingerprints(colons), [A]);
});

test("gpgEncryptArgs: every recipient file, armored, stdin in, explicit output", () => {
  assert.deepEqual(gpgEncryptArgs(["/k/a.asc", "/k/b.asc"], "out.asc"),
    ["--batch", "--yes", "--armor", "--encrypt", "--recipient-file", "/k/a.asc", "--recipient-file", "/k/b.asc", "--output", "out.asc"]);
});

test("keyFromBackupText: accepts the .env line or bare hex, rejects anything else", () => {
  const k = "ab".repeat(32);
  assert.equal(keyFromBackupText(`NEW_STACKS_PRIVATE_KEY=${k}\n`), k);
  assert.equal(keyFromBackupText(`${k}01`), `${k}01`);
  assert.throws(() => keyFromBackupText("twelve words of a phrase are not accepted here at all ok"), /expected format/);
});

test("attestationProblems: a complete, matching attestation passes", () => {
  assert.deepEqual(attestationProblems(good(), { address: ADDR, backupSha256: SHA }), []);
});

test("attestationProblems: missing, wrong address, changed backup, one custodian, outsider verification all block", () => {
  assert.match(attestationProblems(null, { address: ADDR, backupSha256: SHA })[0], /no recovery attestation/);
  assert.match(attestationProblems(good(), { address: "SP2OTHER", backupSha256: SHA }).join(), /not the new key/);
  assert.match(attestationProblems(good(), { address: ADDR, backupSha256: sha256Hex("other") }).join(), /sha256 differs/);
  assert.match(attestationProblems(good(), { address: ADDR, backupSha256: null }).join(), /missing/);
  assert.match(attestationProblems({ ...good(), recipients: [A, A] }, { address: ADDR, backupSha256: SHA }).join(), /fewer than 2/);
  assert.match(attestationProblems({ ...good(), verifiedBy: [{ name: "x", fingerprint: "D".repeat(40), at: "" }] }, { address: ADDR, backupSha256: SHA }).join(), /no verification/);
});
