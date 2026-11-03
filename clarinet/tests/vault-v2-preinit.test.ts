// deepstack-vault-v2 before initialize (re-review 2026-10-12). Kept apart from vault-v2.test.ts,
// whose beforeEach initializes the vault.
import { describe, expect, it } from "vitest";
import { Cl, getAddressFromPrivateKey, randomPrivateKey } from "@stacks/transactions";

const deployer = simnet.getAccounts().get("deployer")!;
const alice = simnet.getAccounts().get("wallet_1")!;
const newAddr = () => getAddressFromPrivateKey(randomPrivateKey(), "testnet");
const call = (fn: string, args: any[]) => simnet.callPublicFn("deepstack-vault-v2", fn, args, deployer);
const errCode = (r: any) => { expect(r.result.type).toBe("err"); return Number(r.result.value.value); };

describe("before initialize", () => {
  it("the deployer cannot queue any change, so none can survive initialize and land on the multisig", () => {
    expect(errCode(call("queue-admin-change", [Cl.principal(alice)]))).toBe(305);
    expect(errCode(call("queue-strategy", [Cl.principal(alice)]))).toBe(305);
    expect(errCode(call("queue-fee-recipient", [Cl.principal(alice)]))).toBe(305);
    expect(errCode(call("queue-resume-sweeps", []))).toBe(305);
  });

  // Assessment W-03 (N3, DSA-16): initialize refuses a deployer admin or strategy and any merge
  // of admin, strategy and guardian. Guardian and fee recipient may be the deployer (testnet).
  const init = (a: string, s: string, g: string, f: string) =>
    call("initialize", [Cl.principal(a), Cl.principal(s), Cl.principal(g), Cl.principal(f)]);
  const [A, S, G, F] = [newAddr(), newAddr(), newAddr(), newAddr()];
  for (const [name, args] of [
    ["admin = deployer", [deployer, S, G, F]],
    ["strategy = deployer", [A, deployer, G, F]],
    ["admin = strategy", [A, A, G, F]],
    ["admin = guardian", [A, S, A, F]],
    ["strategy = guardian", [A, S, S, F]],
  ] as [string, [string, string, string, string]][]) {
    it(`W-03: initialize refuses ${name}`, () => {
      expect(errCode(init(...args))).toBe(326);
      const st = simnet.callReadOnlyFn("deepstack-vault-v2", "get-state", [], deployer).result as any;
      expect(st.value.initialized.type).toBe("false");
    });
  }
  it("W-03: initialize accepts distinct roles, with the deployer as guardian and fee recipient", () => {
    expect((init(A, S, deployer, deployer).result as any).type).toBe("ok");
  });
});
