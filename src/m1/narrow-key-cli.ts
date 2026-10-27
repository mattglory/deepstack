// Replace a recovery phrase in .env with the single account key the agent actually uses.
//
// A 24-word phrase on the server derives EVERY account of that wallet (and, in wallets like
// Leather, its Bitcoin keys too), so a server compromise would expose all of them. The agent needs
// only one account: STACKS_ACCOUNT_INDEX (default 0). This swaps the phrase for that account's raw
// key, in place, without moving any funds, and checks the address is unchanged.
//
// Never prints a key or the phrase. Keeps a backup (.env.phrase-backup, owner-only) until you
// remove it with --remove-backup once the agent is confirmed running on the new key.
//
//   npm run m1:narrow-key -- --expect=SP23…WK60           # swap, verify, keep backup
//   npm run m1:narrow-key -- --remove-backup              # after the agent is confirmed healthy

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync, chmodSync, statSync, chownSync } from "node:fs";
import { generateWallet, generateNewAccount } from "@stacks/wallet-sdk";
import { getAddressFromPrivateKey } from "@stacks/transactions";

const argv = process.argv.slice(2);
const envPath = argv.find((a) => a.startsWith("--env="))?.slice(6) ?? ".env";
const expect = argv.find((a) => a.startsWith("--expect="))?.slice(9) ?? "";
const backup = `${envPath}.phrase-backup`;

function readKeyLine(text: string): string | null {
  const m = /^STACKS_PRIVATE_KEY=(.*)$/m.exec(text);
  if (!m) return null;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

async function main(): Promise<void> {
  if (argv.includes("--remove-backup")) {
    if (!existsSync(backup)) return void console.log("no backup to remove");
    writeFileSync(backup, "0".repeat(readFileSync(backup).length)); // overwrite before unlinking
    rmSync(backup);
    return void console.log(`removed ${backup}`);
  }
  if (!/^S[PM][0-9A-Z]+$/.test(expect)) throw new Error("pass --expect=<the agent's mainnet address> so the result can be checked");
  const text = readFileSync(envPath, "utf8");
  const value = readKeyLine(text);
  if (!value) throw new Error(`no STACKS_PRIVATE_KEY in ${envPath}`);
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 12) return void console.log("already a single raw key; nothing to do");

  const idx = Number(/^STACKS_ACCOUNT_INDEX=(\d+)/m.exec(text)?.[1] ?? 0);
  let wallet = await generateWallet({ secretKey: words.join(" "), password: "" });
  while (wallet.accounts.length <= idx) wallet = generateNewAccount(wallet);
  const key = wallet.accounts[idx].stxPrivateKey;
  const address = getAddressFromPrivateKey(key, "mainnet");
  console.log(`account ${idx} derives ${address}`);
  if (address !== expect) throw new Error(`refusing: that is not ${expect}; nothing changed`);

  copyFileSync(envPath, backup);
  chmodSync(backup, 0o600);
  const next = text.replace(/^STACKS_PRIVATE_KEY=.*$/m, `STACKS_PRIVATE_KEY=${key}`);
  // Keep the original owner and mode: the agent runs as its own user and must still read .env.
  const orig = statSync(envPath);
  const tmp = `${envPath}.tmp-${process.pid}`;
  writeFileSync(tmp, next, { mode: orig.mode & 0o777 });
  try { chownSync(tmp, orig.uid, orig.gid); } catch { /* not root: the file is already ours */ }
  renameSync(tmp, envPath);

  const check = readKeyLine(readFileSync(envPath, "utf8"));
  const after = check ? getAddressFromPrivateKey(check, "mainnet") : "";
  if (after !== expect) {
    copyFileSync(backup, envPath);
    throw new Error("verification failed; the original .env was restored");
  }
  console.log(`done: .env now holds only the key for ${after} (the phrase is in ${backup} until --remove-backup)`);
  console.log("next: restart the agent, confirm its next report, then run with --remove-backup");
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
