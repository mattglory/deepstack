import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { savePending, clearPending, xykHoldReasonForPendingReadd } from "./dlmm-pending-state.js";

test("XYK holds while a DLMM re-add is pending, and only then (2026-11-15 incident)", () => {
  const path = join(mkdtempSync(join(tmpdir(), "xyk-hold-")), "dlmm-pending-readd.json");
  assert.equal(xykHoldReasonForPendingReadd(path), null, "no pending re-add: the XYK step may trade");
  savePending({ pair: "sbtc-usdcx", xBase: 4_118_337n, yBase: 595_848_263n, before: { x: 0.05064562, y: 0 }, t: "2026-11-14T22:25:32.546Z", abortedSwaps: 3 }, path);
  assert.match(xykHoldReasonForPendingReadd(path) ?? "", /DLMM re-add is pending \(sbtc-usdcx/);
  clearPending(path);
  assert.equal(xykHoldReasonForPendingReadd(path), null, "finished or abandoned: trading resumes");
});

test("XYK also holds when the pending re-add file exists but cannot be read (fail closed)", () => {
  const path = join(mkdtempSync(join(tmpdir(), "xyk-hold-")), "dlmm-pending-readd.json");
  writeFileSync(path, '{"pair":"sbtc-usdcx","xBase":"4118');
  assert.match(xykHoldReasonForPendingReadd(path) ?? "", /cannot be read/);
});
