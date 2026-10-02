// Unit tests for deepstack-rebalance-receiver.clar (external review, issue #7 — "the Clarity
// contract ... untested"). This contract is LIVE on mainnet with real funds, so scope here is
// deliberate: everything testable against the contract's OWN state and auth logic is covered.
//
// NOT covered, on purpose: the actual swap+repay execution inside execute-stx-flash (legs
// against the real Bitflow pool, sBTC token, and FlashStack core). Reaching those branches
// requires a call where contract-caller really is flashstack-stx-core — i.e. invoking through
// FlashStack's own flash-loan entrypoint, which itself needs the FlashStack core, Bitflow's
// sBTC-STX pool, and sBTC's token contract seeded with real simnet liquidity/balances. That's
// a substantial multi-protocol integration-test effort in its own right (and getting the
// seeding subtly wrong would produce a test that passes for the wrong reason — worse than no
// test at all for a contract this is real money). Test #11 below proves the one property that
// matters most for THAT boundary without needing any of that setup: a direct call — even from
// the owner's own wallet, with every other field matching — cannot pass the contract-caller
// gate, so execute-stx-flash can only ever be entered via a real flash-loan callback.

import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

const CONTRACT = "deepstack-rebalance-receiver";
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;

const ERR = {
  NOT_OWNER: 400,
  NOT_ARMED: 401,
  ARM_EXPIRED: 402,
  UNAUTHORIZED: 403,
  AMOUNT_MISMATCH: 404,
  BAD_PARAMS: 405,
};

const arm = (amount: number, minDx: number, sender = deployer) =>
  simnet.callPublicFn(CONTRACT, "arm", [Cl.uint(amount), Cl.uint(minDx)], sender);
const disarm = (sender = deployer) => simnet.callPublicFn(CONTRACT, "disarm", [], sender);
const getPending = () => simnet.callReadOnlyFn(CONTRACT, "get-pending", [], deployer).result;
const getOwner = () => simnet.callReadOnlyFn(CONTRACT, "get-owner", [], deployer).result;

beforeEach(() => {
  // Each test starts from a clean, disarmed state regardless of what the previous test left
  // armed — disarm is itself owner-gated and idempotent (works whether or not anything is armed).
  disarm();
});

describe("get-owner / get-pending: read-only state", () => {
  it("get-owner returns the deployer (binds to whoever deployed it, not a hardcoded address)", () => {
    expect(getOwner()).toBeOk(Cl.standardPrincipal(deployer));
  });

  it("get-pending starts as none", () => {
    expect(getPending()).toBeOk(Cl.none());
  });
});

describe("arm: owner-only, validated params", () => {
  it("owner can arm; get-pending reflects amount/min-dx and an expiry 10 blocks out", () => {
    const r = arm(1_000_000, 500_000);
    expect(r.result).toBeOk(Cl.bool(true));
    const expectedExpires = simnet.blockHeight + 10; // ARM-TTL-BLOCKS; arm's own tx mined the block we're now at
    expect(getPending()).toBeOk(
      Cl.some(
        Cl.tuple({
          amount: Cl.uint(1_000_000),
          "min-dx": Cl.uint(500_000),
          expires: Cl.uint(expectedExpires),
        }),
      ),
    );
  });

  it("a non-owner cannot arm — ERR-NOT-OWNER, and nothing gets armed", () => {
    const r = arm(1_000_000, 500_000, wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_OWNER));
    expect(getPending()).toBeOk(Cl.none());
  });

  it("amount = 0 is rejected — ERR-BAD-PARAMS", () => {
    expect(arm(0, 500_000).result).toBeErr(Cl.uint(ERR.BAD_PARAMS));
  });

  it("min-dx = 0 is rejected — ERR-BAD-PARAMS (the whole point: never arm a floor min-out)", () => {
    expect(arm(1_000_000, 0).result).toBeErr(Cl.uint(ERR.BAD_PARAMS));
  });

  it("re-arming overwrites the previous pending trade (intentional — re-quote without a separate disarm)", () => {
    arm(1_000_000, 500_000);
    arm(2_000_000, 900_000);
    const expectedExpires = simnet.blockHeight + 10;
    expect(getPending()).toBeOk(
      Cl.some(Cl.tuple({ amount: Cl.uint(2_000_000), "min-dx": Cl.uint(900_000), expires: Cl.uint(expectedExpires) })),
    );
  });
});

describe("disarm: owner-only", () => {
  it("owner can disarm an armed trade", () => {
    arm(1_000_000, 500_000);
    expect(getPending()).not.toBeOk(Cl.none());
    expect(disarm().result).toBeOk(Cl.bool(true));
    expect(getPending()).toBeOk(Cl.none());
  });

  it("a non-owner cannot disarm — ERR-NOT-OWNER, armed trade survives", () => {
    arm(1_000_000, 500_000);
    const r = disarm(wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_OWNER));
    expect(getPending()).not.toBeOk(Cl.none());
  });
});

describe("execute-stx-flash: the flash-loan callback's guards", () => {
  it("nothing armed → ERR-NOT-ARMED, regardless of who calls", () => {
    const r = simnet.callPublicFn(CONTRACT, "execute-stx-flash", [Cl.uint(1_000_000), Cl.principal(deployer)], deployer);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_ARMED));
  });

  it("a direct call (not via flashstack-stx-core) is rejected even with the correct amount and the owner's own wallet — proves the contract-caller gate, not just tx-sender, protects the callback", () => {
    arm(1_000_000, 500_000);
    const r = simnet.callPublicFn(CONTRACT, "execute-stx-flash", [Cl.uint(1_000_000), Cl.principal(deployer)], deployer);
    // contract-caller when called directly is the caller itself (the deployer), never
    // FLASHSTACK-CORE's hardcoded principal — so this fails ERR-UNAUTHORIZED even though
    // tx-sender and the amount both match what was armed.
    expect(r.result).toBeErr(Cl.uint(ERR.UNAUTHORIZED));
  });

  it("the one-shot consumption rule means a reverted direct call leaves the trade armed, not cleared", () => {
    arm(1_000_000, 500_000);
    simnet.callPublicFn(CONTRACT, "execute-stx-flash", [Cl.uint(1_000_000), Cl.principal(deployer)], deployer);
    // Clarity rolls back ALL state changes from a failed tx, including the function's own
    // `(var-set pending none)` — so despite that line having run, the failed call must not
    // have actually cleared it.
    expect(getPending()).not.toBeOk(Cl.none());
  });
});

describe("rescue-stx / rescue-sbtc: owner-only admin escape hatches", () => {
  it("rescue-stx: a non-owner is rejected — ERR-NOT-OWNER", () => {
    const r = simnet.callPublicFn(CONTRACT, "rescue-stx", [Cl.uint(1), Cl.principal(wallet1)], wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_OWNER));
  });

  it("rescue-sbtc: a non-owner is rejected — ERR-NOT-OWNER", () => {
    const r = simnet.callPublicFn(CONTRACT, "rescue-sbtc", [Cl.uint(1), Cl.principal(wallet1)], wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_OWNER));
  });
});
