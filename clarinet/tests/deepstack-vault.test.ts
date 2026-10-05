// Unit tests for deepstack-vault.clar -- the AUM vault, Phase 1. These pin down the four
// properties the contract's own header calls out as load-bearing: share pricing that closes
// the donation-attack gap StackingDAO's own audited code leaves open, withdrawals that are
// structurally impossible for the admin to pause (the CR-01 lesson), a timelock with no
// cancel path, and the sweep/return liquidity invariant.

import { describe, expect, it, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { Cl } from "@stacks/transactions";

const TOKEN = "deepstack-vault-token";
const VAULT = "deepstack-vault";
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!; // admin, by default (admin = tx-sender at deploy)
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;
const wallet3 = accounts.get("wallet_3")!;

const ERR = {
  NOT_ADMIN: 100,
  DEPOSITS_PAUSED: 101,
  STRATEGY_PAUSED: 102,
  ZERO_AMOUNT: 103,
  BELOW_MIN_FIRST_DEPOSIT: 104,
  ZERO_SHARES: 105,
  OVER_CAP: 106,
  INSUFFICIENT_LIQUIDITY: 107,
  WITHDRAWAL_NOT_FOUND: 108,
  NOT_WITHDRAWAL_OWNER: 109,
  ALREADY_CLAIMED: 110,
  NOT_YET_CLAIMABLE: 111,
  STRATEGY_ALREADY_DEPLOYED: 112,
  NO_STRATEGY_CAPITAL: 113,
  NOTHING_QUEUED: 114,
  NOT_YET_EXECUTABLE: 115,
  NOT_PENDING_ADMIN: 116,
  FEE_TOO_HIGH: 117,
};

const vaultPrincipal = () => Cl.contractPrincipal(deployer, VAULT);
const deposit = (amount: number, sender = wallet1) => simnet.callPublicFn(VAULT, "deposit", [Cl.uint(amount)], sender);
const requestWithdrawal = (shares: number, sender = wallet1) => simnet.callPublicFn(VAULT, "request-withdrawal", [Cl.uint(shares)], sender);
const claimWithdrawal = (id: number, sender = wallet1) => simnet.callPublicFn(VAULT, "claim-withdrawal", [Cl.uint(id)], sender);
const sweepToStrategy = (amount: number, sender = deployer) => simnet.callPublicFn(VAULT, "sweep-to-strategy", [Cl.uint(amount)], sender);
const returnFromStrategy = (amount: number, sender = deployer) => simnet.callPublicFn(VAULT, "return-from-strategy", [Cl.uint(amount)], sender);
const totalAssets = () => simnet.callReadOnlyFn(VAULT, "get-total-assets", [], deployer).result;

beforeEach(() => {
  const r = simnet.callPublicFn(TOKEN, "set-vault-contract", [vaultPrincipal()], deployer);
  if (r.result.type !== "ok") throw new Error("test setup: linking vault to token failed");
});

// ============================================================================
// Donation-attack defense (contract header, point 1)
// ============================================================================

describe("donation-attack defense", () => {
  it("a bare STX transfer straight to the vault's address is invisible to get-total-assets", () => {
    deposit(1_000_000); // MIN-FIRST-DEPOSIT, mints 1:1
    const before = totalAssets();
    expect(before).toEqual(Cl.uint(1_000_000)); // get-total-assets returns a bare uint, not (ok uint) -- it's an internal arithmetic helper, not a response-wrapped getter

    // The attack setup: donate a large amount directly, bypassing deposit() entirely.
    simnet.transferSTX(100_000_000, `${deployer}.${VAULT}`, wallet2);

    const after = totalAssets();
    expect(after).toEqual(before); // completely unaffected -- the ledger, not raw balance, is truth
  });

  it("a second depositor gets a fair share count even after a large bare donation was attempted", () => {
    deposit(1_000_000, wallet1); // attacker-shaped first deposit: exactly the floor, nothing more
    simnet.transferSTX(100_000_000, `${deployer}.${VAULT}`, wallet1); // the donation/inflation attempt

    const victim = deposit(2_000_000, wallet2);
    // Without the defense this would round toward ~0 (2,000,000 * 1,000,000 / 101,000,000 ≈
    // 19,801); with it, the donation never touched the ledger, so pricing is untouched and
    // wallet2 gets the fair, undiluted amount.
    expect(victim.result).toBeOk(Cl.uint(2_000_000));
  });

  it("the first deposit below MIN-FIRST-DEPOSIT is rejected outright (closes the tiny-seed half of the attack setup)", () => {
    const r = deposit(999_999, wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.BELOW_MIN_FIRST_DEPOSIT));
  });
});

// ============================================================================
// Deposit math
// ============================================================================

describe("deposit math", () => {
  it("first deposit at exactly the floor mints 1:1 (virtual offset == 1,000,000 on both sides)", () => {
    const r = deposit(1_000_000);
    expect(r.result).toBeOk(Cl.uint(1_000_000));
  });

  it("a second deposit with no intervening gain/loss also mints 1:1", () => {
    deposit(5_000_000, wallet1);
    const r = deposit(3_000_000, wallet2);
    expect(r.result).toBeOk(Cl.uint(3_000_000));
  });

  it("deposit over the cap is rejected, and no state change survives", () => {
    const cap = Number((simnet.callReadOnlyFn(VAULT, "get-max-tvl", [], deployer).result as any).value.value);
    const r = deposit(cap + 1, wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.OVER_CAP));
    expect(totalAssets()).toEqual(Cl.uint(0)); // the stx-transfer? + ledger update inside deposit rolled back too
  });

  it("deposit while paused is rejected", () => {
    simnet.callPublicFn(VAULT, "pause-deposits", [], deployer);
    const r = deposit(1_000_000, wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.DEPOSITS_PAUSED));
  });

  it("zero-amount deposit is rejected", () => {
    const r = deposit(0, wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.ZERO_AMOUNT));
  });
});

// ============================================================================
// Liquidity invariant: sweep-to-strategy can never touch STX reserved for a pending withdrawal
// ============================================================================

describe("liquidity invariant", () => {
  it("sweep-to-strategy is rejected for an amount that would dip below STX already reserved by a pending withdrawal", () => {
    deposit(10_000_000, wallet1); // total-stx-balance = 10,000,000, free balance = 10,000,000
    requestWithdrawal(4_000_000, wallet1); // reserves 4,000,000 -> free balance now 6,000,000

    const tooMuch = sweepToStrategy(6_000_001);
    expect(tooMuch.result).toBeErr(Cl.uint(ERR.INSUFFICIENT_LIQUIDITY));

    const exactlyFree = sweepToStrategy(6_000_000);
    expect(exactlyFree.result).toBeOk(Cl.bool(true)); // sweep-to-strategy's final expr is stx-transfer?, which returns (ok true), not the amount
  });

  it("request-withdrawal itself is rejected if the vault doesn't currently hold enough free STX, even for a legitimate share-holder", () => {
    deposit(10_000_000, wallet1);
    sweepToStrategy(9_000_000); // only 1,000,000 free remains
    // wallet1 owns all 10,000,000 shares and tries to redeem shares worth more than what's free
    const r = requestWithdrawal(5_000_000, wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.INSUFFICIENT_LIQUIDITY));
  });
});

// ============================================================================
// Fee / high-water-mark
// ============================================================================

describe("performance fee + high-water mark", () => {
  it("a gain round-trip mints the expected fee shares (10% of the gain, fee-bps default)", () => {
    deposit(10_000_000, wallet1);
    sweepToStrategy(10_000_000);
    const r = returnFromStrategy(11_000_000); // 1,000,000 gain
    expect(r.result).toBeOk(Cl.uint(11_000_000));

    // fee-stx = 1,000,000 * 1000bps / 10000 = 100,000; minted at the POST-return price.
    // Post-return: supply=10,000,000, assets=11,000,000 (before the fee mint itself).
    // fee-shares = 100,000 * (10,000,000+1,000,000) / (11,000,000+1,000,000) = 100,000 * 11,000,000/12,000,000 = 91,666
    const feeRecipientBal = simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(deployer)], deployer).result;
    expect(feeRecipientBal).toBeOk(Cl.uint(91_666));
  });

  it("a loss followed by recovery to the SAME prior peak charges zero fee on the way back up", () => {
    deposit(10_000_000, wallet1);
    sweepToStrategy(10_000_000);
    returnFromStrategy(9_000_000); // loss of 1,000,000; cumulative = -1,000,000, HWM stays 0

    const feeRecipientBalAfterLoss = simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(deployer)], deployer).result;
    expect(feeRecipientBalAfterLoss).toBeOk(Cl.uint(0)); // no negative fee, obviously

    sweepToStrategy(9_000_000);
    returnFromStrategy(10_000_000); // +1,000,000 gain; cumulative back to 0 == the ORIGINAL HWM (0), not a new high
    const feeRecipientBalAfterRecovery = simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(deployer)], deployer).result;
    expect(feeRecipientBalAfterRecovery).toBeOk(Cl.uint(0)); // recovering to the old peak still owes nothing
  });

  it("fee is charged only on the excess above the prior peak, once a new high is actually made", () => {
    deposit(10_000_000, wallet1);
    sweepToStrategy(10_000_000);
    returnFromStrategy(9_000_000); // loss; cumulative -1,000,000, HWM 0
    sweepToStrategy(9_000_000);
    returnFromStrategy(9_500_000); // +500,000; cumulative -500,000 -- still below HWM 0, no fee
    expect(simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(deployer)], deployer).result).toBeOk(Cl.uint(0));

    sweepToStrategy(9_500_000);
    returnFromStrategy(10_200_000); // +700,000; cumulative +200,000 -- NEW high, 200,000 above old HWM 0
    // fee-stx = 200,000 * 1000/10000 = 20,000, minted at whatever the post-return price is by then
    const bal = simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(deployer)], deployer).result as any;
    expect(Number(bal.value.value)).toBeGreaterThan(0);
  });

  it("queue-fee-bps rejects a value above MAX-PERFORMANCE-FEE-BPS even at queue time", () => {
    const r = simnet.callPublicFn(VAULT, "queue-fee-bps", [Cl.uint(2001)], deployer);
    expect(r.result).toBeErr(Cl.uint(ERR.FEE_TOO_HIGH));
  });
});

// ============================================================================
// Withdrawal flow
// ============================================================================

describe("withdrawal flow", () => {
  it("request escrows the shares and reserves the locked STX amount", () => {
    deposit(10_000_000, wallet1);
    const before = simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(wallet1)], deployer).result;
    expect(before).toBeOk(Cl.uint(10_000_000));

    const r = requestWithdrawal(4_000_000, wallet1);
    expect(r.result).toBeOk(Cl.uint(0)); // first withdrawal id

    const after = simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(wallet1)], deployer).result;
    expect(after).toBeOk(Cl.uint(6_000_000)); // shares moved to vault custody
    expect(simnet.callReadOnlyFn(VAULT, "get-total-pending-withdrawals", [], deployer).result).toBeOk(Cl.uint(4_000_000));
  });

  it("claim before maturity is rejected", () => {
    deposit(10_000_000, wallet1);
    requestWithdrawal(4_000_000, wallet1);
    const r = claimWithdrawal(0, wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_YET_CLAIMABLE));
  });

  it("claim by a non-owner is rejected", () => {
    deposit(10_000_000, wallet1);
    requestWithdrawal(4_000_000, wallet1);
    simnet.mineEmptyBlocks(30_000);
    const r = claimWithdrawal(0, wallet2);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_WITHDRAWAL_OWNER));
  });

  it("claim after maturity succeeds, pays out the STX, and burns the escrowed shares", () => {
    deposit(10_000_000, wallet1);
    requestWithdrawal(4_000_000, wallet1);
    simnet.mineEmptyBlocks(30_000);

    const r = claimWithdrawal(0, wallet1);
    expect(r.result).toBeOk(Cl.uint(4_000_000));
    expect(simnet.callReadOnlyFn(VAULT, "get-total-pending-withdrawals", [], deployer).result).toBeOk(Cl.uint(0));
  });

  it("double-claim is rejected", () => {
    deposit(10_000_000, wallet1);
    requestWithdrawal(4_000_000, wallet1);
    simnet.mineEmptyBlocks(30_000);
    claimWithdrawal(0, wallet1);
    const r = claimWithdrawal(0, wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.ALREADY_CLAIMED));
  });

  it("claiming a nonexistent request is rejected", () => {
    const r = claimWithdrawal(999, wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.WITHDRAWAL_NOT_FOUND));
  });

  it("payout is the amount LOCKED AT REQUEST TIME -- a fee mint between request and claim does not move it", () => {
    deposit(10_000_000, wallet1);
    requestWithdrawal(4_000_000, wallet1); // locked at 1:1 price -> 4,000,000 STX

    // Move the share price via a profitable round-trip on the REMAINING free capital.
    sweepToStrategy(6_000_000);
    returnFromStrategy(7_000_000); // +1,000,000 gain, mints fee shares, changes the live price

    simnet.mineEmptyBlocks(30_000);
    const r = claimWithdrawal(0, wallet1);
    expect(r.result).toBeOk(Cl.uint(4_000_000)); // unchanged from the amount locked at request time
  });
});

// ============================================================================
// CR-01: withdrawals cannot be paused, as a structural property (contract header, point 2)
// ============================================================================

describe("CR-01: withdrawals cannot be paused", () => {
  it("every pause function engaged immediately before a claim does not affect it", () => {
    deposit(10_000_000, wallet1);
    requestWithdrawal(4_000_000, wallet1);
    simnet.mineEmptyBlocks(30_000);

    simnet.callPublicFn(VAULT, "pause-deposits", [], deployer);
    simnet.callPublicFn(VAULT, "pause-strategy", [], deployer);

    const r = claimWithdrawal(0, wallet1);
    expect(r.result).toBeOk(Cl.uint(4_000_000));
  });

  it("no identifier matching a withdrawal-pause/shutdown pattern exists anywhere in the source -- a cheap, automatic regression guard", () => {
    const source = readFileSync(new URL("../../contracts/deepstack-vault.clar", import.meta.url), "utf8");
    // Strip ;; comments first -- the header prose deliberately discusses why no such
    // mechanism exists (using exactly these words), which would otherwise false-positive
    // this check. Only actual CODE should ever be allowed to match.
    const codeOnly = source
      .split("\n")
      .map((line) => line.replace(/;;.*$/, ""))
      .join("\n");
    expect(codeOnly).not.toMatch(/pause.*withdraw|withdraw.*pause|shutdown/i);
  });
});

// ============================================================================
// Timelock: no cancel path, for any parameter, ever
// ============================================================================

describe("timelock", () => {
  it("confirm before maturity is rejected", () => {
    simnet.callPublicFn(VAULT, "queue-max-tvl", [Cl.uint(999_000_000)], deployer);
    const r = simnet.callPublicFn(VAULT, "confirm-max-tvl", [], deployer);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_YET_EXECUTABLE));
  });

  it("confirm after maturity succeeds and is callable by a NON-admin account", () => {
    simnet.callPublicFn(VAULT, "queue-max-tvl", [Cl.uint(999_000_000)], deployer);
    simnet.mineEmptyBlocks(40_000);
    const r = simnet.callPublicFn(VAULT, "confirm-max-tvl", [], wallet3); // not the admin
    expect(r.result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(VAULT, "get-max-tvl", [], deployer).result).toBeOk(Cl.uint(999_000_000));
  });

  it("confirm with nothing queued is rejected", () => {
    const r = simnet.callPublicFn(VAULT, "confirm-max-tvl", [], deployer);
    expect(r.result).toBeErr(Cl.uint(ERR.NOTHING_QUEUED));
  });

  it("re-queuing before confirmation overwrites the pending value", () => {
    simnet.callPublicFn(VAULT, "queue-max-tvl", [Cl.uint(111)], deployer);
    simnet.callPublicFn(VAULT, "queue-max-tvl", [Cl.uint(222)], deployer);
    simnet.mineEmptyBlocks(40_000);
    simnet.callPublicFn(VAULT, "confirm-max-tvl", [], deployer);
    expect(simnet.callReadOnlyFn(VAULT, "get-max-tvl", [], deployer).result).toBeOk(Cl.uint(222));
  });

  it("no cancel-* function exists for any queued change -- calling one fails because it doesn't exist, proven by source inspection", () => {
    const source = readFileSync(new URL("../../contracts/deepstack-vault.clar", import.meta.url), "utf8");
    expect(source).not.toMatch(/define-public \(cancel-/i);
  });

  it("only the admin can queue a change; anyone can confirm one once matured (already covered above), but only the admin can start one", () => {
    const r = simnet.callPublicFn(VAULT, "queue-max-tvl", [Cl.uint(123)], wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_ADMIN));
  });
});

// ============================================================================
// Admin succession: two-step, gated to the proposed principal specifically
// ============================================================================

describe("admin succession", () => {
  it("queue is admin-only", () => {
    const r = simnet.callPublicFn(VAULT, "queue-admin-change", [Cl.principal(wallet2)], wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_ADMIN));
  });

  it("accept is rejected before maturity, and rejected from anyone other than the proposed principal", () => {
    simnet.callPublicFn(VAULT, "queue-admin-change", [Cl.principal(wallet2)], deployer);

    const tooEarly = simnet.callPublicFn(VAULT, "accept-admin-change", [], wallet2);
    expect(tooEarly.result).toBeErr(Cl.uint(ERR.NOT_YET_EXECUTABLE));

    simnet.mineEmptyBlocks(40_000);
    const wrongCaller = simnet.callPublicFn(VAULT, "accept-admin-change", [], wallet3);
    expect(wrongCaller.result).toBeErr(Cl.uint(ERR.NOT_PENDING_ADMIN));

    // old admin retains full control until acceptance completes
    expect(simnet.callReadOnlyFn(VAULT, "get-admin", [], deployer).result).toBeOk(Cl.principal(deployer));
  });

  it("the proposed principal accepting after maturity completes the succession", () => {
    simnet.callPublicFn(VAULT, "queue-admin-change", [Cl.principal(wallet2)], deployer);
    simnet.mineEmptyBlocks(40_000);
    const r = simnet.callPublicFn(VAULT, "accept-admin-change", [], wallet2);
    expect(r.result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(VAULT, "get-admin", [], deployer).result).toBeOk(Cl.principal(wallet2));

    // old admin has lost control
    const oldAdminTries = sweepToStrategy(1, deployer);
    expect(oldAdminTries.result).toBeErr(Cl.uint(ERR.NOT_ADMIN));
  });
});

// ============================================================================
// Pause scope: deposits/strategy only, never returns (symmetric to CR-01's withdrawal case)
// ============================================================================

describe("pause scope", () => {
  it("pause-strategy blocks sweep-to-strategy but not return-from-strategy", () => {
    deposit(10_000_000, wallet1);
    simnet.callPublicFn(VAULT, "pause-strategy", [], deployer);
    expect(sweepToStrategy(1_000_000).result).toBeErr(Cl.uint(ERR.STRATEGY_PAUSED));

    simnet.callPublicFn(VAULT, "unpause-strategy", [], deployer);
    sweepToStrategy(1_000_000);
    simnet.callPublicFn(VAULT, "pause-strategy", [], deployer); // re-pause before returning
    const r = returnFromStrategy(1_000_000);
    expect(r.result).toBeOk(Cl.uint(1_000_000)); // unaffected by strategy-paused
  });

  it("only one strategy tranche at a time", () => {
    deposit(10_000_000, wallet1);
    sweepToStrategy(5_000_000);
    const r = sweepToStrategy(1_000_000);
    expect(r.result).toBeErr(Cl.uint(ERR.STRATEGY_ALREADY_DEPLOYED));
  });

  it("returning with nothing deployed is rejected", () => {
    const r = returnFromStrategy(1_000_000);
    expect(r.result).toBeErr(Cl.uint(ERR.NO_STRATEGY_CAPITAL));
  });
});
