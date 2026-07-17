// Keeps a long-running agent alive across transient failures.
//
// A cycle depends on third-party reads (chain RPC, the external price reference, the
// tuner). Over a 30-day pilot those WILL fail transiently. A failed cycle must be a
// SKIPPED cycle, not a dead agent: the pilot's uptime requirement leaves little room, and
// an agent that exits at 2am on a DNS blip has already lost hours before anyone notices.
//
// The supervisor also counts CONSECUTIVE failures. One failure is weather; twenty in a row
// is an outage, and the two deserve different reactions — the caller gets the count and
// decides. A live process that cannot read the market is not healthy, so callers should
// report failures to the dead-man's switch rather than let silence do it slowly.

export interface FailureReport {
  error: string;
  consecutive: number; // 1 on the first failure after any success
}

export interface Supervisor {
  /** Run one cycle. Returns true on success. Never throws. */
  run(step: () => Promise<void>): Promise<boolean>;
  /** Consecutive failures; 0 immediately after any success. */
  consecutiveFailures(): number;
}

export function createSupervisor(onFailure?: (r: FailureReport) => void | Promise<void>): Supervisor {
  let consecutive = 0;
  return {
    async run(step: () => Promise<void>): Promise<boolean> {
      try {
        await step();
        consecutive = 0;
        return true;
      } catch (e) {
        consecutive++;
        try {
          await onFailure?.({ error: (e as Error)?.message ?? String(e), consecutive });
        } catch {
          // Reporting is best-effort. If journalling or alerting is itself broken, that
          // must not become the thing that kills the agent — the whole point is to survive.
        }
        return false;
      }
    },
    consecutiveFailures: () => consecutive,
  };
}
