// Sign a text message with the agent key, on the server, without the key leaving it.
//
//   npm run m1:sign-message -- --file=message.txt     # the exact text the other party gave you
//
// Shows the message and the address, asks you to type SIGN, then prints the address, public key
// and signature to send back. Never prints the key. Signing a message cannot move funds.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { getWallet } from "./wallet.js";
import { signStacksMessage, messageProblems } from "./sign-message.js";

async function main(): Promise<void> {
  const file = process.argv.slice(2).find((a) => a.startsWith("--file="))?.slice(7);
  if (!file) throw new Error("usage: m1:sign-message -- --file=<path to the exact message text>");
  // Keep the text exactly as given, except a single trailing newline an editor adds.
  const message = readFileSync(file, "utf8").replace(/\r?\n$/, "");
  const problems = messageProblems(message);
  if (problems.length) throw new Error(`refusing to sign: ${problems.join("; ")}`);
  const w = await getWallet();
  console.log(`signing as ${w.address} (${w.network})\n----- message (${message.length} characters) -----\n${message}\n-----------------------------`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = (await rl.question("Type SIGN to sign exactly this message: ")).trim();
  rl.close();
  if (typed !== "SIGN") throw new Error("cancelled: nothing signed");
  const s = signStacksMessage(message, w.key, w.network);
  console.log(`\naddress:    ${s.address}\npublic key: ${s.publicKey}\nsignature:  ${s.signature}\n(self-check passed: the signature verifies against this message and key)`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
