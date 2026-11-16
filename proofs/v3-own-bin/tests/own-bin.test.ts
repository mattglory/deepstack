// Vault v3 step 1 (docs/VAULT_V3_DESIGN_NOTE.md section 8): against mainnet state, a contract adds
// liquidity to a Bitflow HODLMM bin as itself, owns the shares, and withdraws them back to itself.
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { Cl, cvToJSON, randomPrivateKey, getAddressFromPrivateKey } from "@stacks/transactions";

const POOL = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD.dlmm-pool-sbtc-usdcx-v-1-bps-10";
const SBTC = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token";
const USDCX = "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx";
const SBTC_WHALE = "SPMN217717VVAC8VABB76PXX016FVHGDD87HVC6K";
const USDCX_WHALE = "SP1BXRXA0Z67MB6G31FP1R52ZX5GQTZ5008KZG77A";
const CENTER = 500;

// The pool only mints to principals of the current network (`is-standard`), and the simulation runs
// on mainnet state, so the proof contract is deployed under a mainnet (SP) address. Simnet's own
// accounts are testnet (ST) addresses, which the pool rightly refuses (err u3003): that was the
// first run's failure, and it confirms the pool accepts contract principals of the right network.
const OP = getAddressFromPrivateKey(randomPrivateKey(), "mainnet");
const deployer = () => OP;
// Simnet resets between tests, so deploy before each.
beforeEach(() => {
  const r = simnet.deployContract("own-bin-proof", readFileSync("contracts/own-bin-proof.clar", "utf8"), { clarityVersion: 4 }, OP);
  if (cvToJSON(r.result).value !== true) throw new Error("deploy failed: " + JSON.stringify(cvToJSON(r.result)));
});
const proof = () => `${deployer()}.own-bin-proof`;
const ro = (c: string, f: string, args: any[]) => cvToJSON(simnet.callReadOnlyFn(c, f, args, deployer()).result);
const ftBal = (token: string, who: string) => BigInt(ro(token, "get-balance", [Cl.principal(who)]).value.value);
const shares = (bin: number, who: string) => BigInt(ro(POOL, "get-balance", [Cl.uint(bin + CENTER), Cl.principal(who)]).value.value);

describe("v3 step 1: a contract owns a HODLMM position", () => {
  it("reads live mainnet pool state", () => {
    const pool = ro(POOL, "get-pool", []).value.value;
    console.log("active bin at the fork height:", pool["active-bin-id"].value, "bin step:", pool["bin-step"].value);
    expect(Number(pool["bin-step"].value)).toBe(10);
  });

  it("adds to the active bin as itself, owns the shares, withdraws them back", () => {
    const d = deployer();
    // Give the deployer tokens from mainnet holders (simnet does not check signatures).
    expect(simnet.callPublicFn(SBTC, "transfer", [Cl.uint(20_000), Cl.principal(SBTC_WHALE), Cl.principal(d), Cl.none()], SBTC_WHALE).result).toBeOk(Cl.bool(true));
    expect(simnet.callPublicFn(USDCX, "transfer", [Cl.uint(20_000_000), Cl.principal(USDCX_WHALE), Cl.principal(d), Cl.none()], USDCX_WHALE).result).toBeOk(Cl.bool(true));
    expect(simnet.callPublicFn(proof(), "fund", [Cl.uint(20_000), Cl.uint(20_000_000)], d).result).toBeOk(Cl.bool(true));

    const active = Number(ro(POOL, "get-pool", []).value.value["active-bin-id"].value);
    const add = simnet.callPublicFn(proof(), "add-one", [Cl.int(active), Cl.uint(10_000), Cl.uint(8_000_000), Cl.uint(1)], d);
    console.log("add result:", JSON.stringify(cvToJSON(add.result)).slice(0, 300));
    expect(add.result.type).toBe("ok");
    const owned = shares(active, proof());
    console.log("shares owned by the contract in bin", active, ":", owned.toString(), "| deployer:", shares(active, d).toString());
    expect(owned > 0n).toBe(true);
    expect(shares(active, d)).toBe(0n);

    const before = { x: ftBal(SBTC, proof()), y: ftBal(USDCX, proof()) };
    const w = simnet.callPublicFn(proof(), "withdraw-one", [Cl.int(active), Cl.uint(owned), Cl.uint(1), Cl.uint(1)], d); // the core needs min-x + min-y > 0
    console.log("withdraw result:", JSON.stringify(cvToJSON(w.result)).slice(0, 300));
    expect(w.result.type).toBe("ok");
    expect(shares(active, proof())).toBe(0n);
    const after = { x: ftBal(SBTC, proof()), y: ftBal(USDCX, proof()) };
    console.log("tokens back to the contract: sBTC", (after.x - before.x).toString(), "USDCx", (after.y - before.y).toString());
    expect(after.x + after.y > before.x + before.y).toBe(true);
  });

  it("only the owner can move the position", () => {
    const stranger = simnet.getAccounts().get("wallet_1")!;
    const r = simnet.callPublicFn(proof(), "withdraw-one", [Cl.int(0), Cl.uint(1), Cl.uint(0), Cl.uint(1)], stranger);
    expect(r.result).toBeErr(Cl.uint(100));
  });
});
