// deepstack-vault-v2: test suite built from docs/VAULT_V2_DESIGN.md (approved 2026-10-11).
// Each v1 FINDING from the independent review (clarinet/tests/audit-vault.test.ts) has a
// FIXED counterpart here asserting the opposite outcome, plus the design review's D1-D13 cases
// and a seeded invariant run. Amounts are uSTX (6 decimals); shares have 9 decimals.

import { describe, expect, it, beforeEach } from "vitest";
import { Cl, ClarityValue, getAddressFromPrivateKey, randomPrivateKey } from "@stacks/transactions";

const TOKEN = "deepstack-vault-v2-token";
const VAULT = "deepstack-vault-v2";
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;
const newAddr = () => getAddressFromPrivateKey(randomPrivateKey(), "testnet");
// Distinct principals for every role, as in the design (section 2).
const admin = newAddr();
const strategy = newAddr();
const guardian = newAddr();
const feeTo = newAddr();
const STX = 1_000_000n;
const MAX_EPOCH = 432;
const TIMELOCK = 1008;
const WITHDRAWAL_DELAY = 288;
const vaultId = () => `${deployer}.${VAULT}`;

// ---- value helpers -------------------------------------------------------------------------
const js = (cv: any): any => {
  switch (cv.type) {
    case "uint": case "int": return BigInt(cv.value);
    case "true": return true;
    case "false": return false;
    case "address": case "contract": return cv.value;
    case "none": return null;
    case "some": case "ok": return js(cv.value);
    case "err": throw new Error("err " + js(cv.value));
    case "tuple": return Object.fromEntries(Object.entries(cv.value).map(([k, v]) => [k, js(v)]));
    default: return cv.value;
  }
};
const ok = (r: { result: ClarityValue }) => {
  if ((r.result as any).type !== "ok") throw new Error("expected ok, got " + JSON.stringify(r.result, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
  return js((r.result as any).value);
};
const errCode = (r: { result: ClarityValue }) => {
  expect((r.result as any).type).toBe("err");
  return Number((r.result as any).value.value);
};
const ro = (fn: string, args: ClarityValue[] = [], c = VAULT) => js(simnet.callReadOnlyFn(c, fn, args, deployer).result);
const st = () => ro("get-state");
const stxOf = (who: string) => simnet.getAssetsMap().get("STX")!.get(who) ?? 0n;
const shares = (who: string) => ro("get-balance", [Cl.principal(who)], TOKEN) as bigint;
const valueOf = (who: string) => ro("assets-for-shares", [Cl.uint(shares(who))]) as bigint;
const call = (fn: string, args: ClarityValue[], who: string) => simnet.callPublicFn(VAULT, fn, args, who);

const deposit = (amt: bigint, who: string) => call("deposit", [Cl.uint(amt)], who);
const request = (sh: bigint, who: string) => call("request-withdrawal", [Cl.uint(sh)], who);
const claimReq = (id: bigint, who: string) => call("claim-withdrawal", [Cl.uint(id)], who);
const claimDep = (e: bigint, who: string) => call("claim-deposit", [Cl.uint(e)], who);
const claimWd = (e: bigint, who: string) => call("claim-epoch-withdrawal", [Cl.uint(e)], who);
const sweep = (amt: bigint, who = admin) => call("sweep", [Cl.uint(amt)], who);
const ret = (amt: bigint, who = strategy) => call("return-from-strategy", [Cl.uint(amt)], who);
const burn = (n: number) => simnet.mineEmptyBurnBlocks(n);

// Exit everything an IDLE holder has: request, wait, claim. Returns uSTX received.
const exitIdle = (who: string) => {
  const before = stxOf(who);
  const { id } = ok(request(shares(who), who));
  burn(WITHDRAWAL_DELAY);
  ok(claimReq(id, who));
  return stxOf(who) - before;
};
const near = (a: bigint, b: bigint, tol: bigint) => expect(a > b ? a - b : b - a).toBeLessThanOrEqual(tol);

beforeEach(() => {
  ok(simnet.callPublicFn(TOKEN, "set-vault-contract", [Cl.contractPrincipal(deployer, VAULT)], deployer));
  ok(call("initialize", [Cl.principal(admin), Cl.principal(strategy), Cl.principal(guardian), Cl.principal(feeTo)], deployer));
  simnet.transferSTX(10_000n * STX, strategy, deployer); // so the strategy can return gains
});

// ============================================================================================
describe("setup", () => {
  it("initialize runs once, deployer only; nothing works before it", () => {
    expect(errCode(call("initialize", [Cl.principal(alice), Cl.principal(alice), Cl.principal(alice), Cl.principal(alice)], deployer))).toBe(304);
    expect(errCode(call("initialize", [Cl.principal(alice), Cl.principal(alice), Cl.principal(alice), Cl.principal(alice)], alice))).toBe(303);
    expect(st().admin).toBe(admin);
  });

  it("the token is dsSTX2 with 9 decimals, and only the vault can mint", () => {
    expect(ro("get-symbol", [], TOKEN)).toBe("dsSTX2");
    expect(ro("get-decimals", [], TOKEN)).toBe(9n);
    expect(errCode(simnet.callPublicFn(TOKEN, "mint-for-vault", [Cl.uint(1), Cl.principal(alice)], alice))).toBe(202);
  });
});

// ============================================================================================
describe("custody (C1 fixed)", () => {
  it("FIXED C-1: only the admin can sweep, the STX goes to the strategy address, and a sweep is capped at 50%", () => {
    ok(deposit(100n * STX, alice));
    for (const who of [strategy, guardian, alice]) expect(errCode(sweep(10n * STX, who))).toBe(300);
    expect(errCode(sweep(50n * STX + 1n))).toBe(312);
    const adminBefore = stxOf(admin), stratBefore = stxOf(strategy);
    ok(sweep(50n * STX));
    expect(stxOf(admin)).toBe(adminBefore); // nothing to the admin
    expect(stxOf(strategy) - stratBefore).toBe(50n * STX);
  });

  it("FIXED C-1b: even a total strategy loss leaves the never-swept half redeemable", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    burn(MAX_EPOCH + 1);
    ok(call("settle-overdue", [], bob)); // anyone
    const got = exitIdle(alice);
    near(got, 50n * STX, 2n);
  });

  it("guardian can pause deposits and sweeps but cannot unpause; only the admin unpauses", () => {
    ok(call("pause-deposits", [], guardian));
    ok(call("pause-sweeps", [], guardian));
    expect(errCode(deposit(STX, alice))).toBe(306);
    expect(errCode(call("unpause-deposits", [], guardian))).toBe(300);
    ok(call("unpause-deposits", [], admin));
    ok(deposit(10n * STX, alice));
    expect(errCode(sweep(STX))).toBe(307);
    ok(call("unpause-sweeps", [], admin));
    ok(sweep(STX));
  });
});

// ============================================================================================
describe("liquidity and overdue settlement (H1, D1 fixed)", () => {
  it("FIXED H-1: settle-overdue is refused before MAX-EPOCH, allowed after, and reopens exits", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    burn(MAX_EPOCH - 1);
    expect(errCode(call("settle-overdue", [], bob))).toBe(315);
    burn(2);
    expect(st().overdue).toBe(true);
    ok(call("settle-overdue", [], bob));
    expect(st()["epoch-open"]).toBe(false);
    ok(request(shares(alice), alice)); // exits open again
  });

  it("D1: a return of 0 from the strategy settles instead of failing", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(ret(0n));
    expect(st()["epoch-open"]).toBe(false);
    expect(st()["realized-pnl"]).toBe(-50n * STX);
  });

  it("D1: return-from-strategy still settles normally while overdue reads true", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    burn(MAX_EPOCH + 5);
    expect(st().overdue).toBe(true);
    ok(ret(50n * STX));
    near(valueOf(alice), 100n * STX, 2n);
  });

  it("D1: a late recovery after a write-off goes to the holders at that time", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    burn(MAX_EPOCH + 1);
    ok(call("settle-overdue", [], bob));
    near(valueOf(alice), 50n * STX, 2n);
    expect(errCode(call("recover-from-strategy", [Cl.uint(STX)], alice))).toBe(301);
    ok(call("recover-from-strategy", [Cl.uint(50n * STX)], strategy));
    near(valueOf(alice), 100n * STX, 2n);
  });
});

// ============================================================================================
describe("timelock exit window (H2 fixed)", () => {
  it("FIXED H-2: no queuing while deployed, no sweep while a change is pending, holders exit before it lands", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    expect(errCode(call("queue-fee-bps", [Cl.uint(2000)], admin))).toBe(310);
    ok(ret(50n * STX));
    ok(call("queue-fee-bps", [Cl.uint(2000)], admin));
    expect(errCode(sweep(10n * STX))).toBe(314);
    const got = exitIdle(alice); // well inside the timelock
    near(got, 100n * STX, 2n);
    burn(TIMELOCK);
    ok(call("confirm-fee-bps", [], mallory)); // anyone confirms once matured
    expect(st()["fee-bps"]).toBe(2000n);
  });

  it("timelock rules: ceilings, maturity, two-step admin change", () => {
    expect(errCode(call("queue-fee-bps", [Cl.uint(2001)], admin))).toBe(324);
    expect(errCode(call("queue-max-deploy-bps", [Cl.uint(8001)], admin))).toBe(324);
    expect(errCode(call("queue-fee-bps", [Cl.uint(500)], alice))).toBe(300);
    ok(call("queue-admin-change", [Cl.principal(bob)], admin));
    burn(TIMELOCK - 2);
    expect(errCode(call("accept-admin-change", [], bob))).toBe(322);
    burn(2);
    expect(errCode(call("accept-admin-change", [], mallory))).toBe(323);
    ok(call("accept-admin-change", [], bob));
    expect(st().admin).toBe(bob);
  });
});

// ============================================================================================
describe("epoch pricing (H3 fixed)", () => {
  it("FIXED H-3: a deposit made while capital is out is priced after the return, not at cost", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(deposit(100n * STX, mallory)); // queued
    ok(ret(70n * STX)); // +20
    ok(claimDep(0n, mallory));
    near(valueOf(mallory), 100n * STX, 2n); // Mallory gets exactly what she put in
    near(valueOf(alice), 118n * STX, 2n);   // Alice keeps the gain minus the 10% fee
  });

  it("FIXED H-3b: a withdrawal requested while capital is out bears that epoch's loss", () => {
    ok(deposit(100n * STX, alice));
    ok(deposit(100n * STX, mallory));
    ok(sweep(100n * STX));
    ok(request(shares(mallory), mallory)); // queued
    ok(ret(50n * STX)); // -50 across both holders
    const before = stxOf(mallory);
    ok(claimWd(0n, mallory));
    near(stxOf(mallory) - before, 75n * STX, 2n);
    near(valueOf(alice), 75n * STX, 2n);
  });
});

// ============================================================================================
describe("performance fee (M1, L1 fixed)", () => {
  it("FIXED L-1: the fee recipient receives the nominal fee, not less", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(ret(100n * STX)); // +50 gain, fee 5 STX
    near(valueOf(feeTo), 5n * STX, 2n);
    near(valueOf(alice), 145n * STX, 2n);
  });

  it("FIXED M-1: a newcomer after a loss pays the fee once the price passes the per-share high", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(ret(42n * STX)); // -8%: price 0.92, under the drawdown block
    ok(deposit(300n * STX, bob)); // enters at 0.92: about 326.09 share-equivalents
    ok(sweep(190n * STX)); // within the 50% cap of 392
    ok(ret(230n * STX)); // +40: assets 432 over about 426.09 equivalents, price about 1.0139
    // v1 charged nothing here (its high was in absolute STX). v2: 10% of the ~5.913 STX
    // that the vault now sits above its per-share high.
    near(valueOf(feeTo), 591_304n, 2_000n);
  });

  it("FIXED M-1b: recovering a loss back up to the per-share high charges no fee", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(ret(60n * STX)); // +10: fee charged, new high
    const feeAfter1 = shares(feeTo);
    ok(deposit(200n * STX, bob)); // enters at the high
    ok(sweep(150n * STX));
    ok(ret(130n * STX)); // -20, about -6.5%, so sweeps stay allowed
    ok(sweep(100n * STX));
    ok(ret(120n * STX)); // +20, back exactly to the high
    expect(shares(feeTo)).toBe(feeAfter1); // no fee on a recovery
  });

  it("zero-profit epoch charges no fee and leaves the price unchanged", () => {
    ok(deposit(100n * STX, alice));
    const p0 = st().pps;
    ok(sweep(50n * STX));
    ok(ret(50n * STX));
    expect(shares(feeTo)).toBe(0n);
    expect(st().pps).toBe(p0);
  });
});

// ============================================================================================
describe("dust and rounding (L2, L4, L5 fixed)", () => {
  it("FIXED L-2: zero-value deposits and requests are rejected", () => {
    expect(errCode(deposit(0n, alice))).toBe(308);
    ok(deposit(10n * STX, alice));
    ok(sweep(5n * STX));
    ok(ret(STX)); // big loss: one share unit is now worth well under 1 uSTX
    expect(ro("assets-for-shares", [Cl.uint(1)])).toBe(0n);
    expect(errCode(request(1n, alice))).toBe(325);
  });

  it("FIXED L-4: the last holder can fully exit after a loss, to within a micro-STX", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(ret(25n * STX));
    const got = exitIdle(alice);
    near(got, 75n * STX, 1n);
    expect(st()["vault-stx"]).toBeLessThanOrEqual(1n);
  });

  it("FIXED L-5: the IDLE withdrawal delay is counted in burn blocks", () => {
    ok(deposit(10n * STX, alice));
    const { id } = ok(request(shares(alice), alice));
    burn(WITHDRAWAL_DELAY - 1);
    expect(errCode(claimReq(id, alice))).toBe(318);
    burn(1);
    ok(claimReq(id, alice));
  });

  it("FIXED L-3: state changes print events", () => {
    const r = deposit(10n * STX, alice);
    expect(r.events.some((e: any) => e.event === "print_event")).toBe(true);
    const q = call("queue-max-tvl", [Cl.uint(600n * STX)], admin);
    expect(q.events.some((e: any) => e.event === "print_event")).toBe(true);
  });
});

// ============================================================================================
describe("design review cases (D2-D4, D8)", () => {
  it("D2: a queued deposit through a zero-profit epoch leaves the price unchanged, and the next epoch charges no phantom fee", () => {
    ok(deposit(100n * STX, alice));
    const p0 = st().pps;
    ok(sweep(50n * STX));
    ok(deposit(100n * STX, bob)); // queued
    ok(ret(50n * STX)); // zero profit; Bob's shares minted into escrow, unclaimed
    near(st().pps, p0, 1n);
    ok(sweep(50n * STX));
    ok(ret(50n * STX));
    expect(shares(feeTo)).toBe(0n);
  });

  it("D3: an IDLE request is fixed at request time and does not share the next epoch's loss", () => {
    ok(deposit(100n * STX, alice));
    ok(deposit(100n * STX, bob));
    const { id } = ok(request(shares(bob), bob)); // 100 STX ring-fenced, shares burned now
    ok(sweep(50n * STX));
    ok(ret(25n * STX)); // -25, borne by Alice alone
    burn(WITHDRAWAL_DELAY);
    const before = stxOf(bob);
    ok(claimReq(id, bob));
    near(stxOf(bob) - before, 100n * STX, 1n);
    near(valueOf(alice), 75n * STX, 2n);
  });

  it("D4: claims cannot repeat, and cancels are refused after settlement", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(deposit(10n * STX, bob));
    ok(request(shares(alice) / 2n, alice));
    ok(ret(50n * STX));
    expect(errCode(call("cancel-deposit", [], bob))).toBe(311);
    expect(errCode(call("cancel-withdrawal", [], alice))).toBe(311);
    ok(claimDep(0n, bob));
    expect(errCode(claimDep(0n, bob))).toBe(316);
    ok(claimWd(0n, alice));
    expect(errCode(claimWd(0n, alice))).toBe(316);
  });

  it("D4: a queued deposit and a queued withdrawal can be cancelled before settlement", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    const b0 = stxOf(bob);
    ok(deposit(10n * STX, bob));
    ok(call("cancel-deposit", [], bob));
    expect(stxOf(bob)).toBe(b0);
    const s0 = shares(alice);
    ok(request(s0 / 2n, alice));
    ok(call("cancel-withdrawal", [], alice));
    expect(shares(alice)).toBe(s0);
  });

  it("D8: queued deposits count toward the vault cap", () => {
    ok(deposit(400n * STX, alice));
    ok(sweep(100n * STX));
    ok(deposit(90n * STX, bob)); // queued, 490 of 500
    expect(errCode(deposit(11n * STX, mallory))).toBe(309);
  });
});

// ============================================================================================
describe("write-off entry (D12)", () => {
  it("D12: after a write-off, deposits pause, queued deposits are refunded 1:1, and a recovery goes to the holders who bore the loss", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(deposit(20n * STX, bob)); // queued in the epoch that gets written off
    burn(MAX_EPOCH + 1);
    ok(call("settle-overdue", [], mallory));
    expect(st()["deposits-paused"]).toBe(true);
    expect(errCode(deposit(50n * STX, mallory))).toBe(306); // no entry at the written-down price
    const before = stxOf(bob);
    ok(claimDep(0n, bob));
    expect(stxOf(bob) - before).toBe(20n * STX); // refunded, not priced
    ok(call("recover-from-strategy", [Cl.uint(50n * STX)], strategy));
    near(valueOf(alice), 100n * STX, 2n); // v1 model: 70.83 without D12
  });
});

// ============================================================================================
describe("drawdown sweep block (D5, D13)", () => {
  it("D13: a loss over 10% blocks sweeps; a timelocked resume resets the reference; HWM is untouched; a further 10% loss blocks again", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(ret(20n * STX)); // -30%
    const hwm = st()["hwm-pps"];
    expect(errCode(sweep(STX))).toBe(313);
    ok(call("queue-resume-sweeps", [], admin));
    burn(TIMELOCK);
    ok(call("confirm-resume-sweeps", [], bob));
    ok(sweep(30n * STX)); // allowed again
    ok(ret(25n * STX)); // -5 on 70: about -7%, still allowed next time
    expect(st()["hwm-pps"]).toBe(hwm);
    ok(sweep(20n * STX));
    ok(ret(15n * STX)); // cumulative past -10% from the reset point
    expect(errCode(sweep(STX))).toBe(313);
  });
});

// ============================================================================================
describe("max values (decision 7)", () => {
  it("the 1e18-scaled fee path holds at tens of millions of STX", () => {
    ok(call("queue-max-tvl", [Cl.uint(50_000_000n * STX)], admin));
    burn(TIMELOCK);
    ok(call("confirm-max-tvl", [], admin));
    simnet.transferSTX(30_000_000n * STX, strategy, deployer);
    ok(deposit(40_000_000n * STX, bob));
    ok(sweep(20_000_000n * STX));
    ok(ret(40_000_000n * STX)); // +100% on the swept half
    near(valueOf(feeTo), 2_000_000n * STX, 2n);
  });
});

// ============================================================================================
describe("seeded invariants", () => {
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const users = [alice, bob, mallory];

  const checkInvariants = () => {
    const s = st();
    expect(s["vault-stx"]).toBe(stxOf(vaultId())); // ledger == real STX (no donations here)
    expect(s["total-assets"] + s["pending-deposits"] + s.ringfenced).toBe(s["vault-stx"] + s["capital-at-strategy"]);
    expect(s["pending-deposits"] + s.ringfenced).toBeLessThanOrEqual(s["vault-stx"]);
    const holders = [...users, feeTo, vaultId()];
    expect(holders.reduce((acc, h) => acc + shares(h), 0n)).toBe(s.supply);
  };

  for (const seed of [3, 11, 99, 2026, 31415]) {
    it(`invariants hold for seed ${seed}`, () => {
      const r = rng(seed);
      const reqs: { id: bigint; who: string; at: number }[] = [];
      const epochsTouched = new Set<bigint>();
      ok(deposit(20n * STX, alice));
      for (let step = 0; step < 70; step++) {
        const op = Math.floor(r() * 9);
        const who = users[Math.floor(r() * users.length)];
        const s = st();
        if (op === 0) {
          const res = deposit(BigInt(Math.floor(r() * 30_000_000)) + 1n, who);
          if ((res.result as any).type === "ok" && s["epoch-open"]) epochsTouched.add(s["current-epoch"]);
        } else if (op === 1 && shares(who) > 0n) {
          const res = request((shares(who) * BigInt(Math.floor(r() * 100) + 1)) / 100n, who);
          if ((res.result as any).type === "ok") {
            const v = ok(res);
            if (v.queued) epochsTouched.add(v.id); else reqs.push({ id: v.id, who, at: simnet.burnBlockHeight });
          }
        } else if (op === 2 && !s["epoch-open"] && s["total-assets"] > 10n) {
          sweep((s["total-assets"] * BigInt(Math.floor(r() * 50) + 1)) / 100n);
        } else if (op === 3 && s["epoch-open"]) {
          const dep = s["capital-at-strategy"];
          ret((dep * BigInt(Math.floor(r() * 60) + 70)) / 100n); // -30%..+30%
        } else if (op === 4 && s["epoch-open"]) {
          burn(MAX_EPOCH + 1);
          call("settle-overdue", [], who);
          if (st()["deposits-paused"]) call("unpause-deposits", [], admin);
        } else if (op === 5) {
          burn(Math.floor(r() * 300));
          for (const q of reqs.splice(0)) {
            const res = claimReq(q.id, q.who);
            if ((res.result as any).type !== "ok") reqs.push(q);
          }
        } else if (op === 6) {
          for (const e of epochsTouched) for (const u of users) { claimDep(e, u); claimWd(e, u); }
        } else if (op === 7 && s["epoch-open"]) {
          call(r() < 0.5 ? "cancel-deposit" : "cancel-withdrawal", [], who);
        } else if (op === 8 && !s["epoch-open"] && st()["sweeps-paused"] === false && r() < 0.2) {
          // occasionally a drawdown block trips; resume it so the run keeps exercising epochs
          if ((sweep(1n).result as any).type === "err") {
            call("queue-resume-sweeps", [], admin); burn(TIMELOCK); call("confirm-resume-sweeps", [], admin);
          } else ret(1n);
        }
        checkInvariants();
      }
    });
  }
});
