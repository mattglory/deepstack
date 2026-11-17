// npm audit with a reviewed allowlist (.github/audit-allowlist.json).
//
// Fails on any high or critical advisory, like `npm audit --audit-level=high`, EXCEPT one listed in
// the allowlist for this directory, with a reason and an expiry date. An entry past its expiry fails
// again, so an exception cannot outlive its review. An entry that no longer matches anything is
// reported, so the list stays short. Same idea as .gitleaksignore: reviewed exceptions, each with
// a reason, nothing silent.
//
//   node scripts/audit-check.mjs <dir>     (from the repo root)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = process.argv[2] ?? ".";
const allow = JSON.parse(readFileSync(new URL("../.github/audit-allowlist.json", import.meta.url), "utf8"))
  .filter((e) => e.dir === dir);
const today = new Date().toISOString().slice(0, 10);

let raw;
try {
  raw = execFileSync("npm", ["audit", "--json"], { cwd: resolve(dir), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
  raw = e.stdout; // npm audit exits non-zero when it finds anything; the JSON is still on stdout
}
const report = JSON.parse(raw);
const found = new Map(); // advisory id (GHSA-...) -> { severity, packages }
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via ?? []) {
    if (typeof via !== "object" || !["high", "critical"].includes(via.severity)) continue;
    const id = String(via.url ?? "").split("/").pop() || String(via.source);
    const f = found.get(id) ?? { severity: via.severity, packages: new Set() };
    f.packages.add(name);
    found.set(id, f);
  }
}

let fail = false;
for (const [id, f] of found) {
  const entry = allow.find((e) => e.id === id);
  const pkgs = [...f.packages].join(", ");
  if (!entry) { console.log(`FAIL ${id} (${f.severity}) in ${pkgs}: not allowlisted`); fail = true; }
  else if (entry.expires < today) { console.log(`FAIL ${id}: allowlist entry expired ${entry.expires}; review it again`); fail = true; }
  else console.log(`allowed ${id} (${f.severity}) in ${pkgs} until ${entry.expires}: ${entry.reason}`);
}
for (const e of allow) if (!found.has(e.id)) console.log(`note: allowlist entry ${e.id} no longer matches anything in ${dir}; remove it`);
console.log(fail ? `audit ${dir}: FAILED` : `audit ${dir}: ok (${found.size} high/critical advisories, all reviewed)`);
process.exit(fail ? 1 : 0);
