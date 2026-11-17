// Every environment variable the code reads must be documented in docs/ENV_REFERENCE.md
// (assessment 2026-11, DSA-22 / roadmap B2): otherwise production configuration cannot be
// rebuilt from the repo plus a backup of the values.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "fixtures" ? [] : sources(p);
    return /\.ts$/.test(name) && !/\.test\.ts$|harness/.test(name) ? [p] : [];
  });
}

test("every process.env variable read in src/ is listed in docs/ENV_REFERENCE.md", () => {
  const doc = readFileSync(join(ROOT, "docs/ENV_REFERENCE.md"), "utf8");
  const missing = new Map<string, string>();
  for (const file of sources(join(ROOT, "src"))) {
    for (const m of readFileSync(file, "utf8").matchAll(/process\.env(?:\.|\[["'])([A-Z][A-Z0-9_]*)/g)) {
      if (!doc.includes(`| \`${m[1]}\` |`)) missing.set(m[1], file.slice(ROOT.length));
    }
  }
  assert.deepEqual([...missing].map(([v, f]) => `${v} (${f})`), [], "add these to docs/ENV_REFERENCE.md");
});
