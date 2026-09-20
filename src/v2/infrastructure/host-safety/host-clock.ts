/**
 * The one monotonic clock the host-safety state is allowed to use.
 *
 * `performance.now()` counts from the process's own `timeOrigin`, so two
 * processes on the same host produce numbers that look comparable and are not:
 * the monitor could publish a decision "issued at 4 200 ms" that the deploy,
 * started later, reads as 4 200 ms in its own future. `process.hrtime.bigint()`
 * is `CLOCK_MONOTONIC`, whose origin is the boot of the kernel — shared by every
 * process on the host, including processes in different containers, because
 * Docker does not put containers in a separate time namespace by default. That
 * is what makes `gate.json`'s `issuedAtMonotonicMs` a number the deploy in one
 * container can subtract from its own reading in another.
 *
 * It is also immune to the correction a wall clock suffers: an NTP step cannot
 * forge the 60 s of preflight or the 5 min of stability the policy measures.
 */

/** Milliseconds on the host's `CLOCK_MONOTONIC` (since boot), as a float. */
export function hostMonotonicNowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6
}
