import { DomainError } from '../domain/errors.ts'
import type { StoryPlan } from '../domain/story-plan.ts'
import type { StoredStoryPlan } from '../application/ports/story-plan-repository.ts'

function object(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, fields: readonly string[], field: string) { const unknown = Object.keys(value).filter((key) => !fields.includes(key)); if (unknown.length) throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown }) }
function exactItems(value: unknown, fields: readonly string[], field: string) { if (!Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an array`); value.forEach((item, index) => exact(object(item, `${field}[${index}]`), fields, `${field}[${index}]`)) }
export function parseCreateStoryPlanBody(value: unknown): Readonly<{ projectVersionId: string; plan: Omit<StoryPlan, 'schemaVersion'> }> {
  const body = object(value, 'body'); const plan = object(body.plan, 'plan')
  exact(body, ['projectVersionId', 'plan'], 'body')
  exact(plan, ['objective', 'desiredActionRef', 'treatmentPlanRef', 'targetDurationMs', 'acts', 'blocks', 'sourceRanges', 'sourceCandidates', 'qualifiers', 'claims', 'proofContexts'], 'plan')
  exactItems(plan.acts, ['id', 'role', 'blockIds'], 'plan.acts')
  exactItems(plan.sourceRanges, ['id', 'artifactId', 'startMs', 'endMs', 'rightsRef', 'consentRef'], 'plan.sourceRanges')
  exactItems(plan.sourceCandidates, ['id', 'sourceRangeId', 'purpose', 'rank'], 'plan.sourceCandidates')
  exactItems(plan.qualifiers, ['id', 'text'], 'plan.qualifiers'); exactItems(plan.claims, ['id', 'text', 'qualifierIds', 'proofContextIds'], 'plan.claims'); exactItems(plan.proofContexts, ['id', 'claimIds', 'sourceCandidateIds', 'attribution'], 'plan.proofContexts')
  exactItems(plan.blocks, ['id', 'actId', 'role', 'intent', 'dependencies', 'sourceCandidateIds', 'durationTargetMs', 'content', 'presentation', 'sourceRangeId'], 'plan.blocks')
  for (const [index, rawBlock] of (plan.blocks as unknown[]).entries()) { const block = object(rawBlock, `plan.blocks[${index}]`); exact(object(block.durationTargetMs, `plan.blocks[${index}].durationTargetMs`), ['min', 'ideal', 'max'], `plan.blocks[${index}].durationTargetMs`); exact(object(block.content, `plan.blocks[${index}].content`), ['claimIds', 'qualifierIds', 'proofIds', 'ctaId'], `plan.blocks[${index}].content`) }
  exact(object(plan.targetDurationMs, 'plan.targetDurationMs'), ['min', 'max'], 'plan.targetDurationMs'); exact(object(plan.treatmentPlanRef, 'plan.treatmentPlanRef'), ['id', 'schemaVersion', 'contentHash'], 'plan.treatmentPlanRef')
  if (typeof body.projectVersionId !== 'string') throw new DomainError('INVALID_ARGUMENT', 'projectVersionId is required')
  if (plan.schemaVersion !== undefined) throw new DomainError('INVALID_ARGUMENT', 'StoryPlan schemaVersion is server-owned')
  return Object.freeze({ projectVersionId: body.projectVersionId, plan: plan as unknown as Omit<StoryPlan, 'schemaVersion'> })
}
export function presentStoryPlan(value: Readonly<StoredStoryPlan>) { return Object.freeze({ ...value.plan, requestFingerprint: value.requestFingerprint }) }
