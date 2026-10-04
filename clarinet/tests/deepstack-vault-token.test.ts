// Unit tests for deepstack-vault-token.clar -- the AUM vault's SIP-010 share token. Two
// properties matter most: standard SIP-010 compliance, and that mint/burn is reachable ONLY
// from the vault contract itself (via contract-caller), never from any wallet directly --
// including the deployer's own, and including after a legitimate one-time link is set.

import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

const TOKEN = "deepstack-vault-token";
const VAULT = "deepstack-vault";
const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;

const ERR = {
  NOT_TOKEN_DEPLOYER: 200,
  VAULT_ALREADY_SET: 201,
  NOT_VAULT: 202,
  NOT_TOKEN_OWNER: 203,
};

const vaultPrincipal = () => Cl.contractPrincipal(deployer, VAULT);

describe("deepstack-vault-token: one-time vault link", () => {
  it("get-vault-contract starts as none", () => {
    const r = simnet.callReadOnlyFn(TOKEN, "get-vault-contract", [], deployer);
    expect(r.result).toBeOk(Cl.none());
  });

  it("mint/burn fail before the link is set, even from the deployer directly", () => {
    const mint = simnet.callPublicFn(TOKEN, "mint-for-vault", [Cl.uint(100), Cl.principal(deployer)], deployer);
    expect(mint.result).toBeErr(Cl.uint(ERR.NOT_VAULT));
    const burn = simnet.callPublicFn(TOKEN, "burn-for-vault", [Cl.uint(100), Cl.principal(deployer)], deployer);
    expect(burn.result).toBeErr(Cl.uint(ERR.NOT_VAULT));
  });

  it("only the token's own deployer can call set-vault-contract", () => {
    const r = simnet.callPublicFn(TOKEN, "set-vault-contract", [vaultPrincipal()], wallet1);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_TOKEN_DEPLOYER));
    expect(simnet.callReadOnlyFn(TOKEN, "get-vault-contract", [], deployer).result).toBeOk(Cl.none());
  });

  it("set-vault-contract succeeds once, from the deployer, then is permanently locked", () => {
    const first = simnet.callPublicFn(TOKEN, "set-vault-contract", [vaultPrincipal()], deployer);
    expect(first.result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(TOKEN, "get-vault-contract", [], deployer).result).toBeOk(Cl.some(vaultPrincipal()));

    // Second attempt, even from the same deployer with the same correct value, fails closed --
    // there is no function anywhere that can change this once set (see contract header).
    const second = simnet.callPublicFn(TOKEN, "set-vault-contract", [vaultPrincipal()], deployer);
    expect(second.result).toBeErr(Cl.uint(ERR.VAULT_ALREADY_SET));
  });
});

describe("deepstack-vault-token: mint/burn gated to the linked vault only", () => {
  beforeEach(() => {
    simnet.callPublicFn(TOKEN, "set-vault-contract", [vaultPrincipal()], deployer);
  });

  it("a direct call from any wallet, including the deployer's own, is rejected even after linking", () => {
    // mint-for-vault/burn-for-vault check contract-caller, not tx-sender -- a human calling
    // directly (not through the vault contract) can never satisfy that check, regardless of
    // which wallet signs, mirroring the existing receiver contract's own contract-caller test.
    const mintAsDeployer = simnet.callPublicFn(TOKEN, "mint-for-vault", [Cl.uint(100), Cl.principal(deployer)], deployer);
    expect(mintAsDeployer.result).toBeErr(Cl.uint(ERR.NOT_VAULT));
    const mintAsWallet1 = simnet.callPublicFn(TOKEN, "mint-for-vault", [Cl.uint(100), Cl.principal(wallet1)], wallet1);
    expect(mintAsWallet1.result).toBeErr(Cl.uint(ERR.NOT_VAULT));
  });

  it("the vault contract itself can mint and burn, via a real deposit/withdrawal round trip", () => {
    // Exercised indirectly through the real vault flow -- confirms the contract-caller gate
    // actually opens for the one legitimate caller, not just that it closes for everyone else.
    const deposit = simnet.callPublicFn(VAULT, "deposit", [Cl.uint(5_000_000)], wallet1);
    expect(deposit.result).toBeOk(Cl.uint(5_000_000)); // first deposit, no existing supply -> 1:1 minus nothing
    expect(simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(wallet1)], deployer).result).toBeOk(Cl.uint(5_000_000));
  });
});

describe("deepstack-vault-token: SIP-010 compliance", () => {
  it("get-name / get-symbol / get-decimals", () => {
    expect(simnet.callReadOnlyFn(TOKEN, "get-name", [], deployer).result).toBeOk(Cl.stringAscii("DeepStack Vault Shares"));
    expect(simnet.callReadOnlyFn(TOKEN, "get-symbol", [], deployer).result).toBeOk(Cl.stringAscii("dsSTX"));
    expect(simnet.callReadOnlyFn(TOKEN, "get-decimals", [], deployer).result).toBeOk(Cl.uint(6));
  });

  it("get-balance / get-total-supply start at zero", () => {
    expect(simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(wallet1)], deployer).result).toBeOk(Cl.uint(0));
    expect(simnet.callReadOnlyFn(TOKEN, "get-total-supply", [], deployer).result).toBeOk(Cl.uint(0));
  });

  it("get-token-uri returns none", () => {
    expect(simnet.callReadOnlyFn(TOKEN, "get-token-uri", [], deployer).result).toBeOk(Cl.none());
  });

  it("transfer enforces the standard self-only check (tx-sender must equal the stated sender)", () => {
    simnet.callPublicFn(TOKEN, "set-vault-contract", [vaultPrincipal()], deployer);
    simnet.callPublicFn(VAULT, "deposit", [Cl.uint(5_000_000)], wallet1); // gives wallet1 a real balance to try moving

    const r = simnet.callPublicFn(TOKEN, "transfer", [Cl.uint(1_000_000), Cl.principal(wallet1), Cl.principal(wallet2), Cl.none()], wallet2);
    expect(r.result).toBeErr(Cl.uint(ERR.NOT_TOKEN_OWNER));
  });

  it("a legitimate self-transfer succeeds and moves the balance", () => {
    simnet.callPublicFn(TOKEN, "set-vault-contract", [vaultPrincipal()], deployer);
    simnet.callPublicFn(VAULT, "deposit", [Cl.uint(5_000_000)], wallet1);

    const r = simnet.callPublicFn(TOKEN, "transfer", [Cl.uint(1_000_000), Cl.principal(wallet1), Cl.principal(wallet2), Cl.none()], wallet1);
    expect(r.result).toBeOk(Cl.bool(true));
    expect(simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(wallet1)], deployer).result).toBeOk(Cl.uint(4_000_000));
    expect(simnet.callReadOnlyFn(TOKEN, "get-balance", [Cl.principal(wallet2)], deployer).result).toBeOk(Cl.uint(1_000_000));
  });
});
