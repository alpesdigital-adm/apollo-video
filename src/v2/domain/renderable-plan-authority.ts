import { calculateCanonicalHash } from './canonical-hash.ts'
import type { DirectedEditPlan } from './director-run.ts'

/** Historical authority moved unchanged from application/renderable-edit-plan.
 * Keep its wrapper, compiler version, serializer and sole createdAt exclusion.
 * W66 canonical policy must never reinterpret a stored renderable plan digest.
 * This is both replay identity and tamper detection: every field participates,
 * including director decisions, subtitles, overlays and projectVersionId.
 * createdAt alone is excluded so compiling the same facts on another day is
 * still an idempotent replay, never a weaker projection of editorial state. */
export const RENDERABLE_PLAN_COMPILER_VERSION = 'renderable-edit-plan/2026-09-05-v1'
export function renderablePlanAuthorityBody(plan: Readonly<DirectedEditPlan>): Readonly<Record<string, unknown>> {
  const document: Record<string, unknown> = { ...plan }
  delete document.createdAt
  return { schemaVersion: 'renderable-edit-plan-hash/v2',
    compilerVersion: RENDERABLE_PLAN_COMPILER_VERSION, plan: document }
}
export function calculateRenderablePlanHash(plan: Readonly<DirectedEditPlan>): string {
  return calculateCanonicalHash(renderablePlanAuthorityBody(plan))
}
