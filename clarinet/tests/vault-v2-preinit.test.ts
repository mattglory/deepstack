// deepstack-vault-v2 before initialize (re-review 2026-10-12). Kept apart from vault-v2.test.ts,
// whose beforeEach initializes the vault.
import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

const deployer = simnet.getAccounts().get("deployer")!;
const alice = simnet.getAccounts().get("wallet_1")!;
const call = (fn: string, args: any[]) => simnet.callPublicFn("deepstack-vault-v2", fn, args, deployer);
const errCode = (r: any) => { expect(r.result.type).toBe("err"); return Number(r.result.value.value); };

describe("before initialize", () => {
  it("the deployer cannot queue any change, so none can survive initialize and land on the multisig", () => {
    expect(errCode(call("queue-admin-change", [Cl.principal(alice)]))).toBe(305);
    expect(errCode(call("queue-strategy", [Cl.principal(alice)]))).toBe(305);
    expect(errCode(call("queue-fee-recipient", [Cl.principal(alice)]))).toBe(305);
    expect(errCode(call("queue-resume-sweeps", []))).toBe(305);
  });
});
