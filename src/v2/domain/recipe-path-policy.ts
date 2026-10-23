/**
 * ADR-160. The two pure rules of the path of a variant recipe that the server enforces and the screen must announce BEFORE the owner is
 * refused: which objectives may leave the proof out, and how the owner confirms a link the Apollo left for them.
 *
 * Nothing here imports anything: the screen and the domain read the same words.
 */

/** Ids of the strategic objectives (`strategic-objective.ts`) whose recipe may leave out the proof. Every other objective (sale) requires it. */
export const OPTIONAL_PROOF_OBJECTIVES: ReadonlySet<string> = new Set([
  'awareness',
  'booking',
  'discovery',
  'download',
  'lead-generation',
  'warming',
  'whatsapp',
])

/**
 * Whether the objective itself requires a proof in the recipe. The owner can ask for a proof when the objective does not require it (that choice
 * prevails), but cannot skip it when it does. No objective, no requirement: nothing is presumed.
 */
export function objectiveRequiresProof(objective: string | null | undefined): boolean {
  if (objective === null || objective === undefined || objective.trim() === '') return false
  return !OPTIONAL_PROOF_OBJECTIVES.has(objective.trim().toLowerCase())
}

/** The code of the assumption by which the owner confirms the link between two roles that the compatibility map left borderline. */
export function ownerConfirmedLinkCode(from: string, to: string): string {
  return `OWNER_CONFIRMED_LINK_${from.toUpperCase()}_${to.toUpperCase()}`
}
