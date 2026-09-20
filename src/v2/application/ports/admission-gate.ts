/**
 * Whether this worker process may admit new work right now.
 *
 * The gate is host state, not product state: jobs, operations, versions and
 * artifacts stay exclusively in PostgreSQL. It exists because the production
 * host is shared and a deploy/monitor run needs a way to stop admission without
 * killing the workers — a paused worker keeps its connections, its leases and
 * its in-flight attempt, so reopening the gate costs nothing.
 *
 * Deliberately narrow: a reading, not a subscription. Workers ask between
 * claims, so a closed gate is observed at the only moment it can be acted on
 * without abandoning work already admitted.
 */
export interface AdmissionGateReading {
  /** True when a new claim may be issued. */
  readonly admits: boolean
  /**
   * Why admission is refused, or why an unusual open reading was produced.
   * `null` only for the ordinary open reading, so a caller can log every
   * transition it sees without inventing its own vocabulary.
   */
  readonly reason: string | null
}

export interface AdmissionGate {
  read(): Promise<Readonly<AdmissionGateReading>>
}

/**
 * The reading used when no gate is configured at all.
 *
 * Absence of the contract is not a closed gate: a developer running one worker
 * locally, and every test that never heard of the ops-state directory, must keep
 * claiming. Fail-closed applies to a gate that exists and cannot be read.
 */
export const ADMISSION_GATE_NOT_CONFIGURED: Readonly<AdmissionGateReading> =
  Object.freeze({ admits: true, reason: 'ops-state-not-configured' })

export const ADMISSION_GATE_OPEN: Readonly<AdmissionGateReading> =
  Object.freeze({ admits: true, reason: null })

/** An admission gate that never refuses — the default for callers with no host contract. */
export const alwaysAdmittingGate: AdmissionGate = Object.freeze({
  read: async () => ADMISSION_GATE_NOT_CONFIGURED,
})
