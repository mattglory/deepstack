// Custodian-side recovery check for a rotated agent key (DSA-01). Run on an OFFLINE machine:
//
//   gpg --decrypt .env.rotation.backup.asc | npm run -s m1:key-backup-verify -- --network mainnet
//
// Reads the decrypted backup from stdin and prints ONLY the address it derives to. Compare the address with the one `m1:rotate-key -- new` printed; if they match,
// tell the operator, who records it with `m1:rotate-key -- attest`. Never paste the key anywhere.

import { getAddressFromPrivateKey } from "@stacks/transactions";
import { keyFromBackupText } from "./key-backup.js";

const net = process.argv.includes("--network") ? process.argv[process.argv.indexOf("--network") + 1] : "";
if (net !== "mainnet" && net !== "testnet") throw new Error("pass --network mainnet|testnet");

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const key = keyFromBackupText(Buffer.concat(chunks).toString("utf8"));
console.log(`backup recovers the key for: ${getAddressFromPrivateKey(key, net)}`);
