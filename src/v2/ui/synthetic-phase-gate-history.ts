/**
 * List and selection rules of the synthetic phase gate history in the editor.
 *
 * The server already orders the list (`createdAt desc, id desc`), so nothing
 * here sorts: the history is the server order, cut at the visual limit. What
 * lives here is only what three moving parts have to agree on — a gate chosen
 * by the operator, a gate returned by a new evaluation and a canonical read
 * that lands afterwards — kept free of React and of any request.
 */

/** The panel shows at most the last twenty evaluations of the project. */
export const SYNTHETIC_PHASE_GATE_HISTORY_LIMIT = 20

export interface SyntheticPhaseGateHistoryEntry {
  id: string
  projectVersionId: string
  projectVersionHash: string
}

/**
 * Who fixed the current selection: the operator (`user`), a successful
 * evaluation (`mutation`) or nobody. A pinned selection survives any later
 * read that still lists it; an unpinned one follows the first gate.
 */
export type SyntheticPhaseGateSelectionPin = 'user' | 'mutation' | null

export interface SyntheticPhaseGateSelection {
  selectedGateId: string | null
  selectionPinned: SyntheticPhaseGateSelectionPin
}

export const NO_SYNTHETIC_PHASE_GATE_SELECTION: Readonly<SyntheticPhaseGateSelection> = Object.freeze({
  selectedGateId: null,
  selectionPinned: null,
})

/**
 * The visible history: the list in the order it arrived, never longer than
 * the limit. A real server never returns more than `limit`; a transport that
 * does still shows only the first twenty.
 */
export function capSyntheticPhaseGateHistory<T>(gates: readonly T[]): T[] {
  return gates.slice(0, SYNTHETIC_PHASE_GATE_HISTORY_LIMIT)
}

/**
 * Places the gate returned by an evaluation into the history on screen. An
 * entry with the same id (an idempotent replay) is replaced where it stands;
 * any other gate becomes the first entry. The result keeps the limit.
 */
export function insertSyntheticPhaseGateFirst<T extends { id: string }>(
  gates: readonly T[],
  gate: T,
): T[] {
  const index = gates.findIndex((candidate) => candidate.id === gate.id)
  const next = index === -1
    ? [gate, ...gates]
    : gates.map((candidate, position) => position === index ? gate : candidate)
  return capSyntheticPhaseGateHistory(next)
}

/**
 * The selection once a list lands. A pinned gate still present in the list
 * stays selected, wherever it sits; otherwise the first gate of the server
 * order is selected and nothing remains pinned.
 */
export function reconcileSyntheticPhaseGateSelection(
  gates: readonly { id: string }[],
  current: Readonly<SyntheticPhaseGateSelection>,
): Readonly<SyntheticPhaseGateSelection> {
  if (
    current.selectionPinned !== null &&
    current.selectedGateId !== null &&
    gates.some((gate) => gate.id === current.selectedGateId)
  ) {
    return current
  }
  return { selectedGateId: gates[0]?.id ?? null, selectionPinned: null }
}

/**
 * - `divergent`: the gate is about another version or hash than the editor's,
 *   wherever it sits in the list;
 * - `historical`: same version and hash, but not the first of the list;
 * - `latest`: same version and hash, and the first of the list.
 */
export type SyntheticPhaseGateSnapshotKind = 'latest' | 'historical' | 'divergent'

export function classifySyntheticPhaseGateSnapshot(input: {
  gate: Readonly<SyntheticPhaseGateHistoryEntry>
  gates: readonly { id: string }[]
  projectVersionId: string
  projectVersionHash: string
}): SyntheticPhaseGateSnapshotKind {
  if (
    input.gate.projectVersionId !== input.projectVersionId ||
    input.gate.projectVersionHash !== input.projectVersionHash
  ) {
    return 'divergent'
  }
  return input.gates[0]?.id === input.gate.id ? 'latest' : 'historical'
}
