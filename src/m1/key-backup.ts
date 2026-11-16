// Off-server backup of a newly generated agent key, and proof that it can be recovered, before any
// funds move to that key (assessment 2026-11, DSA-01 / roadmap A1).
//
// Without this, rotate-key-cli keeps the new key only on the server, so losing the server would
// mean losing the funds. The design:
// - At `new`, the key is encrypted on the server to TWO OR MORE custodians' OpenPGP public keys
//   (gpg --recipient-file). Any one custodian can decrypt alone (1-of-n), so recovery does not
//   depend on a single person. The server holds only public keys and the ciphertext.
// - The ciphertext is copied off the server to separate places. Its sha256 is printed so every
//   copy can be checked.
// - A custodian decrypts on an offline machine and pipes the plaintext into
//   `m1:key-backup-verify`. That prints only the derived address, never the key. The custodian
//   compares it with the address `new` printed.
// - `attest` records that check (address, ciphertext sha256, the recipients' fingerprints, who
//   verified it). `move` refuses to send anything until the attestation matches the new key's
//   address and the ciphertext on disk.
//
// Pure helpers only; rotate-key-cli.ts runs gpg and touches files.

import { createHash } from "node:crypto";

export const BACKUP_PATH = ".env.rotation.backup.asc"; // `.env*`: gitignored and kept across deploys
export const ATTESTATION_PATH = "journal/key-backup-attestation.json";
export const MIN_RECIPIENTS = 2;

export interface Attestation {
  address: string; // address of the backed-up key
  backupSha256: string; // sha256 of the ciphertext file
  recipients: string[]; // fingerprints the ciphertext is encrypted to
  verifiedBy: { name: string; fingerprint: string; at: string }[];
  at: string;
}

export const sha256Hex = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** Recipient public-key files from a comma-separated list. At least MIN_RECIPIENTS distinct files. */
export function parseRecipientFiles(list: string | undefined): string[] {
  const files = [...new Set((list ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (files.length < MIN_RECIPIENTS) {
    throw new Error(`need at least ${MIN_RECIPIENTS} custodian public-key files in KEY_BACKUP_RECIPIENT_FILES (got ${files.length}): one person must not be the only way to recover the key`);
  }
  return files;
}

/** Primary-key fingerprints from `gpg --show-keys --with-colons <file>` output. */
export function parseFingerprints(colons: string): string[] {
  const out: string[] = [];
  let wantPrimary = false;
  for (const line of colons.split("\n")) {
    const f = line.split(":");
    if (f[0] === "pub") wantPrimary = true;
    else if (f[0] === "fpr" && wantPrimary) {
      if (/^[0-9A-F]{40,64}$/i.test(f[9] ?? "")) out.push(f[9].toUpperCase());
      wantPrimary = false;
    }
  }
  return out;
}

/** gpg arguments for encrypting stdin to every recipient file. The plaintext never touches disk. */
export function gpgEncryptArgs(recipientFiles: string[], outPath: string): string[] {
  const args = ["--batch", "--yes", "--armor", "--encrypt"];
  for (const f of recipientFiles) args.push("--recipient-file", f);
  args.push("--output", outPath);
  return args;
}

/** Extracts the key from decrypted backup text (`NEW_STACKS_PRIVATE_KEY=<hex>`, or bare hex). */
export function keyFromBackupText(text: string): string {
  const m = /^(?:NEW_STACKS_PRIVATE_KEY=)?([0-9a-f]{64,66})\s*$/im.exec(text.trim());
  if (!m) throw new Error("backup text does not contain a key in the expected format");
  return m[1];
}

/** Problems that stop `move`; an empty list means the backup of `address` is proven recoverable. */
export function attestationProblems(att: Attestation | null, expect: { address: string; backupSha256: string | null }): string[] {
  if (!att) return ["no recovery attestation: a custodian must decrypt the backup offline, check the address, then run `attest`"];
  const p: string[] = [];
  if (!expect.backupSha256) p.push(`backup ${BACKUP_PATH} is missing`);
  if (att.address !== expect.address) p.push(`attestation is for ${att.address}, not the new key ${expect.address}`);
  if (expect.backupSha256 && att.backupSha256 !== expect.backupSha256) p.push("attestation does not match the backup file on disk (sha256 differs)");
  if (new Set(att.recipients).size < MIN_RECIPIENTS) p.push(`backup is encrypted to fewer than ${MIN_RECIPIENTS} custodians`);
  const ok = att.verifiedBy.filter((v) => att.recipients.includes(v.fingerprint.toUpperCase()));
  if (ok.length === 0) p.push("no verification by one of the recipients recorded");
  return p;
}
