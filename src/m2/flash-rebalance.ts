// Autonomous flash-rebalance — pure sizing and sequencing logic (no I/O), the same split as
// src/m1/dlmm-recenter.ts: decide here, broadcast in flash-rebalance-exec.ts. A flash loan
// here is NOT extra capital — the borrowed STX buys sBTC, the sBTC goes to the operator, and
// the loan is repaid from the operator's OWN existing wallet balance (see
// contracts/deepstack-rebalance-receiver.clar's execute-stx-flash). The benefit is letting a
// single correction safely exceed the direct-swap cap using a mechanism with its own audited
// slippage protection and atomicity — not unlocking money the agent doesn't have.

// FlashStack's live fee: 5bps, floored at 1 µSTX for tiny amounts (matches the core
// contract's own rounding rule, and src/m2/receiver-cli.ts's existing flashFee()).
export function flashFee(amountBase: bigint): bigint {
  const raw = (amountBase * 5n) / 10_000n;
  return raw > 0n ? raw : 1n;
}

export interface SizeFlashRebalanceOpts {
  maxAmountBase: bigint; // configured ceiling (FLASH_MAX_SWAP_Y_BASE)
  maxSingleLoan: bigint; // FlashStack core's own per-loan limit, read live
  reserveBalance: bigint; // FlashStack core's own lendable reserve, read live
  availableNativeStxBase: bigint; // wallet's current STX balance, read fresh
  gasReserveBase: bigint; // kept out of the usable balance — repayment draws from this wallet
  directCapBase: bigint; // params.maxSwapYBase — the bar a flash amount must clear to be worth the fee
}

export interface SizeFlashRebalanceResult {
  amountBase: bigint;
  worthwhile: boolean;
  reason: string;
}

/**
 * Size an autonomous flash-rebalance from the real deficit, clamped by every actual
 * constraint in order: the configured cap, FlashStack's own live limits, and the wallet's
 * actual spendable balance (since repayment comes from it, not from the loan's proceeds).
 * If what survives all of that still isn't bigger than the direct-swap cap, it's not worth
 * paying FlashStack's fee for — the direct swap already handles it.
 */
export function sizeFlashRebalance(deficitBase: bigint, opts: SizeFlashRebalanceOpts): SizeFlashRebalanceResult {
  if (deficitBase <= 0n) return { amountBase: 0n, worthwhile: false, reason: "no deficit" };

  const usableBalance = opts.availableNativeStxBase > opts.gasReserveBase ? opts.availableNativeStxBase - opts.gasReserveBase : 0n;

  let amount = deficitBase;
  if (amount > opts.maxAmountBase) amount = opts.maxAmountBase;
  if (amount > opts.maxSingleLoan) amount = opts.maxSingleLoan;
  if (amount > opts.reserveBalance) amount = opts.reserveBalance;
  if (amount > usableBalance) amount = usableBalance;

  if (amount <= 0n) {
    return { amountBase: 0n, worthwhile: false, reason: "no usable balance after the gas reserve / FlashStack's own limits" };
  }
  if (amount <= opts.directCapBase) {
    return {
      amountBase: amount,
      worthwhile: false,
      reason: `clamped to ${amount} µSTX — not larger than the direct-swap cap (${opts.directCapBase}), not worth the flash fee`,
    };
  }
  return { amountBase: amount, worthwhile: true, reason: `sized to ${amount} µSTX (deficit ${deficitBase})` };
}

export interface FlashRebalanceSequenceOutcome {
  executed: boolean;
  reason: string;
}

/**
 * Pure interpretation of the two-step arm-then-flash-loan broadcast sequence — the sequencing
 * RULE itself, mirroring dlmm-recenter.ts's recenterSequenceOutcome(). An arm that doesn't
 * confirm successfully must abort before the flash-loan call is ever attempted (the armed
 * trade just expires after 10 blocks or can be disarmed — no funds ever move on a failed arm).
 *
 * `flashStatus` is null when no flash-loan call was attempted (i.e. the arm itself already
 * failed); the caller never calls this with a null flashStatus after a successful arm in
 * practice, but the null case still fails closed rather than claim a successful rebalance
 * with no evidence.
 */
export function flashRebalanceSequenceOutcome(armStatus: string, flashStatus: string | null): FlashRebalanceSequenceOutcome {
  if (armStatus !== "success") {
    return { executed: false, reason: `arm ${armStatus} — aborted before the flash-loan call` };
  }
  if (flashStatus === null) {
    return { executed: false, reason: "armed successfully but no flash-loan call was attempted" };
  }
  return {
    executed: flashStatus === "success",
    reason: flashStatus === "success" ? "flash-rebalanced" : `flash-loan ${flashStatus}`,
  };
}
