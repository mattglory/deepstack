import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHalfWidth } from "./dlmm-recenter-exec.js";

test("DLMM_PIN_HALF_WIDTH overrides the vol-scaled width, and is validated", () => {
  const prev = process.env.DLMM_PIN_HALF_WIDTH;
  try {
    delete process.env.DLMM_PIN_HALF_WIDTH;
    assert.equal(resolveHalfWidth(0.019, 10, 3), 27); // 2 sigma over 12 h at 1.9%/day, 10 bps bins
    process.env.DLMM_PIN_HALF_WIDTH = "50";
    assert.equal(resolveHalfWidth(0.019, 10, 3), 50);
    assert.equal(resolveHalfWidth(null, 10, 3), 50);
    process.env.DLMM_PIN_HALF_WIDTH = "0";
    assert.throws(() => resolveHalfWidth(0.019, 10, 3));
    process.env.DLMM_PIN_HALF_WIDTH = "";
    assert.equal(resolveHalfWidth(0.019, 10, 3), 27);
  } finally {
    if (prev === undefined) delete process.env.DLMM_PIN_HALF_WIDTH; else process.env.DLMM_PIN_HALF_WIDTH = prev;
  }
});
