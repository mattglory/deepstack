import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdAssets, loadOwnerHolds, ownerClaims, readOwnerClaims } from "./owner-claims.js";

const SRC = { flows: "flows", holds: "holds" };

test("ownerClaims: unallocated deposits (STX) and holds; withdrawals and allocated deposits add nothing", () => {
  const c = ownerClaims(
    [
      { txid: "a", stx: 3300, allocated: "dlmm" },
      { txid: "b", stx: 9000, allocated: "dlmm" },
      { txid: "c", stx: -700 },
      { txid: "d", stx: 25.5 },
    ],
    [{ id: "h", t: "x", asset: "tok::sbtc", amount: "1975890" }, { id: "z", t: "x", asset: "tok::sbtc", amount: "0" }],
    SRC,
  );
  assert.deepEqual(c.map((x) => [x.venue, x.asset, x.amount]), [["owner", "STX", 25_500_000n], ["owner", "tok::sbtc", 1_975_890n]]);
});

test("readOwnerClaims: missing files are empty; unreadable ones are reported (fail closed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-"));
  process.env.CAPITAL_FLOWS_PATH = join(dir, "flows.json");
  process.env.OWNER_HOLDS_PATH = join(dir, "holds.json");
  try {
    assert.deepEqual(readOwnerClaims(), { claims: [], unreadable: [] });
    writeFileSync(process.env.OWNER_HOLDS_PATH, "{ not json");
    writeFileSync(process.env.CAPITAL_FLOWS_PATH, JSON.stringify([{ txid: "x", stx: "oops" }]));
    assert.equal(readOwnerClaims().unreadable.length, 2);
  } finally {
    delete process.env.CAPITAL_FLOWS_PATH;
    delete process.env.OWNER_HOLDS_PATH;
  }
});

test("loadOwnerHolds: a hold on an unknown asset makes the file unreadable (fail closed, R113-3)", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-"));
  const path = join(dir, "holds.json");
  const sbtc = holdAssets().sbtc.asset;
  writeFileSync(path, JSON.stringify([{ id: "a", t: "x", asset: sbtc, amount: "1975890" }]));
  assert.equal(loadOwnerHolds(path).ok, true);
  writeFileSync(path, JSON.stringify([{ id: "a", t: "x", asset: sbtc, amount: "1" }, { id: "b", t: "x", asset: "SP000::typo", amount: "1" }]));
  const r = loadOwnerHolds(path);
  assert.equal(r.ok, false);
});
