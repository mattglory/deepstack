// deepstack-vault-v2: regressions for the 2026-11-03 assessment (docs/assessment/annex/A2,
// section 4). Each test asserts the FIXED behaviour; on the pre-fix contract (690c5b0) every
// one of them fails. Design note: docs/VAULT_V2_DESIGN.md, sections tagged [assessment W-0n].
//   W-01 (N1, DSA-15) recover-from-strategy could be sandwiched by an IDLE deposit.
//   W-02 (N2, DSA-17) a strategy change landed without the new principal accepting it.
//   W-03 (N3, DSA-16) initialize accepted the deployer, or one principal in two roles.
//   N5               settlement could overflow (and deadlock) once supply >> assets.
import { describe, expect, it, beforeEach } from "vitest";
import { tx } from "@stacks/clarinet-sdk";
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

const recover = (amt: bigint, who = strategy) => call("recover-from-strategy", [Cl.uint(amt)], who);
const writeOff = () => { burn(MAX_EPOCH + 1); ok(call("settle-overdue", [], mallory)); };
const ERR_ROLE_CONFLICT = 326;
const ERR_NO_RECOVERY_WINDOW = 327;
const ERR_NOT_PENDING_STRATEGY = 328;
const ERR_PPS_FLOOR = 329;

// ============================================================================================
describe("W-01: a recovery cannot be sandwiched by an outside deposit", () => {
  it("P1 fixed: after a normal partial return there is no recovery path, so a newcomer cannot capture one", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(ret(25n * STX)); // a partial unwind, booked as a 25 STX loss; deposits stay open
    expect(st()["deposits-paused"]).toBe(false);
    expect(st()["recovery-open"]).toBe(false);
    const before = stxOf(mallory);
    ok(deposit(150n * STX, mallory));
    expect(errCode(recover(25n * STX))).toBe(ERR_NO_RECOVERY_WINDOW);
    const got = exitIdle(mallory);
    expect(got).toBeLessThanOrEqual(150n * STX); // pre-fix: 166.666666
    near(stxOf(mallory) - before, 0n, 2n); // rounding only, in the vault's favour
    near(valueOf(alice), 75n * STX, 2n); // pre-fix: 83.33
  });

  it("an attacker who queued a deposit before the write-off (before the pause) is refunded 1:1 and gets none of the recovery", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    ok(deposit(150n * STX, mallory)); // queued in the epoch that gets written off
    writeOff();
    expect(st()["recovery-open"]).toBe(true);
    ok(recover(50n * STX));
    const before = stxOf(mallory);
    expect(ok(claimDep(0n, mallory))).toBe(150n * STX);
    expect(stxOf(mallory) - before).toBe(150n * STX);
    expect(shares(mallory)).toBe(0n);
    near(valueOf(alice), 100n * STX, 2n);
  });

  it("a depositor who entered IDLE before the sweep is a holder: bears the loss and shares the recovery pro rata, no transfer", () => {
    ok(deposit(100n * STX, alice));
    ok(deposit(100n * STX, mallory));
    ok(sweep(100n * STX));
    writeOff();
    near(valueOf(alice), 50n * STX, 2n);
    ok(recover(100n * STX));
    near(valueOf(alice), 100n * STX, 2n);
    near(valueOf(mallory), 100n * STX, 2n);
  });

  it("unpausing deposits after a write-off closes the recovery window; re-pausing does not reopen it", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    writeOff();
    ok(call("unpause-deposits", [], admin));
    expect(st()["recovery-open"]).toBe(false);
    ok(deposit(150n * STX, mallory)); // enters at the written-down price, which is now final
    near(valueOf(alice), 50n * STX, 2n);
    expect(errCode(recover(50n * STX))).toBe(ERR_NO_RECOVERY_WINDOW);
    ok(call("pause-deposits", [], guardian));
    expect(errCode(recover(50n * STX))).toBe(ERR_NO_RECOVERY_WINDOW);
    near(exitIdle(mallory), 150n * STX, 2n); // no gain for the newcomer
    near(valueOf(alice), 50n * STX, 2n);
  });

  it("several partial recoveries are allowed while the window stays open", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    writeOff();
    ok(recover(20n * STX));
    ok(recover(30n * STX));
    near(valueOf(alice), 100n * STX, 2n);
    expect(st()["realized-pnl"]).toBe(0n);
  });

  it("withdrawal requests around a recovery: a request never moves another holder's value; a leaver before the recovery forfeits it (disclosed)", () => {
    ok(deposit(100n * STX, alice));
    ok(deposit(100n * STX, bob));
    ok(sweep(100n * STX));
    writeOff();
    const a0 = valueOf(alice);
    const { id } = ok(request(shares(bob), bob)); // locks 50 STX at the written-down price
    near(valueOf(alice), a0, 1n);
    ok(recover(100n * STX));
    burn(WITHDRAWAL_DELAY);
    const before = stxOf(bob);
    ok(claimReq(id, bob));
    near(stxOf(bob) - before, 50n * STX, 2n);
    near(valueOf(alice), 150n * STX, 2n);
    near(exitIdle(alice), 150n * STX, 2n);
  });

  it("same-block ordering: deposit-then-recover and recover-then-deposit both leave the newcomer with nothing extra", () => {
    ok(deposit(100n * STX, alice));
    ok(sweep(50n * STX));
    writeOff();
    let [d, r] = simnet.mineBlock([
      tx.callPublicFn(VAULT, "deposit", [Cl.uint(150n * STX)], mallory),
      tx.callPublicFn(VAULT, "recover-from-strategy", [Cl.uint(25n * STX)], strategy),
    ]);
    expect(errCode(d)).toBe(306);
    ok(r);
    [r, d] = simnet.mineBlock([
      tx.callPublicFn(VAULT, "recover-from-strategy", [Cl.uint(25n * STX)], strategy),
      tx.callPublicFn(VAULT, "deposit", [Cl.uint(150n * STX)], mallory),
    ]);
    ok(r);
    expect(errCode(d)).toBe(306);
    expect(shares(mallory)).toBe(0n);
    near(valueOf(alice), 100n * STX, 2n);
    // After the admin declares the loss final, the same ordering cannot book a recovery.
    ok(call("unpause-deposits", [], admin));
    [d, r] = simnet.mineBlock([
      tx.callPublicFn(VAULT, "deposit", [Cl.uint(150n * STX)], mallory),
      tx.callPublicFn(VAULT, "recover-from-strategy", [Cl.uint(25n * STX)], strategy),
    ]);
    ok(d);
    expect(errCode(r)).toBe(ERR_NO_RECOVERY_WINDOW);
    near(valueOf(mallory), 150n * STX, 2n);
  });

  it("several queued deposits and withdrawals around a normal settlement are all priced after the result", () => {
    ok(deposit(100n * STX, alice));
    ok(deposit(100n * STX, bob));
    ok(sweep(100n * STX));
    ok(deposit(50n * STX, mallory));
    ok(deposit(30n * STX, deployer));
    ok(call("cancel-deposit", [], deployer));
    ok(deposit(20n * STX, deployer));
    ok(request(shares(bob) / 2n, bob));
    ok(ret(120n * STX)); // +20 on 200, fee 2: holders +9% each
    ok(claimDep(0n, mallory));
    ok(claimDep(0n, deployer));
    const before = stxOf(bob);
    ok(claimWd(0n, bob));
    near(stxOf(bob) - before, 54_500_000n, 2n);
    near(valueOf(bob), 54_500_000n, 2n);
    near(valueOf(alice), 109n * STX, 2n);
    near(valueOf(mallory), 50n * STX, 2n);
    near(valueOf(deployer), 20n * STX, 2n);
  });
});

// ============================================================================================
describe("W-02: a strategy change needs the new strategy to accept it", () => {
  it("P3 fixed: a typo principal never receives a sweep; nobody else can complete the change", () => {
    ok(deposit(100n * STX, alice));
    const typo = newAddr();
    ok(call("queue-strategy", [Cl.principal(typo)], admin));
    burn(TIMELOCK);
    expect(() => call("confirm-strategy", [], mallory)).toThrow(); // the one-step path is gone
    expect(errCode(call("accept-strategy-change", [], mallory))).toBe(ERR_NOT_PENDING_STRATEGY);
    expect(errCode(call("accept-strategy-change", [], admin))).toBe(ERR_NOT_PENDING_STRATEGY);
    expect(st().strategy).toBe(strategy);
    expect(errCode(sweep(10n * STX))).toBe(314); // the unaccepted change blocks sweeps
    expect(stxOf(typo)).toBe(0n);
    // The admin re-queues the right address; the clock restarts; that address accepts.
    const next = newAddr();
    ok(call("queue-strategy", [Cl.principal(next)], admin));
    burn(TIMELOCK - 1);
    expect(errCode(call("accept-strategy-change", [], next))).toBe(322);
    burn(1);
    ok(call("accept-strategy-change", [], next));
    expect(st().strategy).toBe(next);
    ok(sweep(10n * STX));
    expect(stxOf(next)).toBe(10n * STX);
    expect(stxOf(typo)).toBe(0n);
  });
});

// ============================================================================================
describe("W-03: roles stay separate after initialize", () => {
  it("a queued role change that would merge admin, strategy or guardian, or hand admin or strategy to the deployer, is refused", () => {
    expect(errCode(call("queue-strategy", [Cl.principal(admin)], admin))).toBe(ERR_ROLE_CONFLICT);
    expect(errCode(call("queue-strategy", [Cl.principal(guardian)], admin))).toBe(ERR_ROLE_CONFLICT);
    expect(errCode(call("queue-strategy", [Cl.principal(deployer)], admin))).toBe(ERR_ROLE_CONFLICT);
    expect(errCode(call("queue-guardian", [Cl.principal(admin)], admin))).toBe(ERR_ROLE_CONFLICT);
    expect(errCode(call("queue-guardian", [Cl.principal(strategy)], admin))).toBe(ERR_ROLE_CONFLICT);
    expect(errCode(call("queue-admin-change", [Cl.principal(strategy)], admin))).toBe(ERR_ROLE_CONFLICT);
    expect(errCode(call("queue-admin-change", [Cl.principal(guardian)], admin))).toBe(ERR_ROLE_CONFLICT);
    expect(errCode(call("queue-admin-change", [Cl.principal(deployer)], admin))).toBe(ERR_ROLE_CONFLICT);
    ok(call("queue-guardian", [Cl.principal(deployer)], admin)); // guardian may be the deployer
  });

  it("two changes queued together cannot merge roles: the check runs again when each lands", () => {
    const x = newAddr();
    ok(call("queue-guardian", [Cl.principal(x)], admin));
    ok(call("queue-strategy", [Cl.principal(x)], admin)); // fine against today's guardian
    burn(TIMELOCK);
    ok(call("confirm-guardian", [], bob));
    expect(errCode(call("accept-strategy-change", [], x))).toBe(ERR_ROLE_CONFLICT);
    expect(st().strategy).toBe(strategy);
  });
});

// ============================================================================================
describe("N5: settlement cannot be driven into overflow", () => {
  it("after a price collapse of more than 10,000x deposits are refused, so supply cannot outgrow assets; exits still work", () => {
    ok(call("queue-max-tvl", [Cl.uint(1_000_000_000n * STX)], admin));
    ok(call("queue-max-deploy-bps", [Cl.uint(8000)], admin));
    burn(TIMELOCK);
    ok(call("confirm-max-tvl", [], admin));
    ok(call("confirm-max-deploy-bps", [], admin));
    ok(deposit(90_000_000n * STX, alice));
    for (let k = 0; k < 12; k++) { // twelve 80% losses: assets fall about 2.4e8 times
      ok(sweep((st()["total-assets"] * 8000n) / 10000n));
      ok(ret(0n));
      ok(call("queue-resume-sweeps", [], admin));
      burn(TIMELOCK);
      ok(call("confirm-resume-sweeps", [], admin));
    }
    const s = st();
    expect(s.supply / (s["total-assets"] + 1n)).toBeGreaterThan(100_000_000_000n); // supply >> assets
    // Pre-fix this deposit mints ~2e25 shares; the next settlement then overflows on
    // wd-shares * assets and both return-from-strategy and settle-overdue abort (deadlock).
    expect(errCode(deposit(90_000_000n * STX, bob))).toBe(ERR_PPS_FLOOR);
    ok(sweep(s["total-assets"] / 2n));
    ok(request(shares(alice), alice));
    ok(ret(s["total-assets"] / 2n));
    ok(claimWd(BigInt(s["current-epoch"]), alice));
  });
});
