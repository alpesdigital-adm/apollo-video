import { DomainError } from '../domain/errors.ts'
import type { NarrativeEditItem } from '../domain/narrative-safety.ts'

function record(value: unknown, field: string): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`); return value as Record<string, unknown> }
function exact(value: Record<string, unknown>, allowed: readonly string[], field: string) { const unknown = Object.keys(value).filter((key) => !allowed.includes(key)); if (unknown.length) throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown }) }
function string(value: unknown, field: string) { if (typeof value !== 'string' || value.trim().length < 3 || value.length > 4_000) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`); return value.trim() }
function sourceRange(value: unknown, field: string): readonly [number, number] { if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isSafeInteger) || value[0] < 0 || value[1] <= value[0]) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`); return Object.freeze([value[0], value[1]]) }

export function parseNarrativeSafetyPreflightBody(value: unknown): Readonly<{ projectVersionId: string; expectedBaseHash: string; storyPlanId: string; edit: readonly NarrativeEditItem[] }> {
  const body = record(value, 'body'); exact(body, ['projectVersionId', 'expectedBaseHash', 'storyPlanId', 'edit'], 'body')
  if (!Array.isArray(body.edit) || body.edit.length === 0 || body.edit.length > 500) throw new DomainError('INVALID_ARGUMENT', 'edit is invalid')
  const edit = body.edit.map((raw, index) => { const item = record(raw, `edit[${index}]`); exact(item, ['statementId', 'speakerId', 'sourceArtifactId', 'sourceRangeMs', 'preservedText'], `edit[${index}]`); return Object.freeze({ statementId: string(item.statementId, `edit[${index}].statementId`), speakerId: string(item.speakerId, `edit[${index}].speakerId`), sourceArtifactId: string(item.sourceArtifactId, `edit[${index}].sourceArtifactId`), sourceRangeMs: sourceRange(item.sourceRangeMs, `edit[${index}].sourceRangeMs`), preservedText: string(item.preservedText, `edit[${index}].preservedText`) }) })
  return Object.freeze({ projectVersionId: string(body.projectVersionId, 'projectVersionId'), expectedBaseHash: string(body.expectedBaseHash, 'expectedBaseHash'), storyPlanId: string(body.storyPlanId, 'storyPlanId'), edit: Object.freeze(edit) })
}
