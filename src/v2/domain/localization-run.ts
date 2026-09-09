import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { LocalizedBlockDraft } from './localization.ts'

export const LOCALIZATION_RUN_SCHEMA_VERSION = 'localization-run/v1' as const
export type LocalizationRunStatus = 'requested' | 'translating' | 'awaiting-human-review' | 'failed' | 'cancelled'

export interface LocalizationRun {
  schemaVersion: typeof LOCALIZATION_RUN_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  variantId: string
  variantRevision: number
  variantHash: string
  canonicalScriptVersionId: string
  canonicalContentHash: string
  status: LocalizationRunStatus
  attempt: number
  translation?: Readonly<{ providerId: string; adapterVersion: string; model: string; configHash: string; blocks: readonly LocalizedBlockDraft[]; translationHash: string }>
  failure?: Readonly<{ code: string; message: string; retryable: boolean }>
  requestedByClientId: string
  createdAt: string
  updatedAt: string
  runHash: string
}

function instant(value: string) { return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value }
export function createLocalizationRun(input: Omit<LocalizationRun, 'schemaVersion' | 'status' | 'attempt' | 'createdAt' | 'updatedAt' | 'runHash'> & { at: string }) {
  assertDomain(instant(input.at) && input.variantRevision >= 1 && /^[a-f0-9]{64}$/.test(input.variantHash) && /^[a-f0-9]{64}$/.test(input.canonicalContentHash), 'INVALID_ARGUMENT', 'Localization run request is invalid')
  const body = { schemaVersion: LOCALIZATION_RUN_SCHEMA_VERSION, id: input.id, workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId, variantRevision: input.variantRevision, variantHash: input.variantHash, canonicalScriptVersionId: input.canonicalScriptVersionId, canonicalContentHash: input.canonicalContentHash, status: 'requested' as const, attempt: 0, requestedByClientId: input.requestedByClientId, createdAt: input.at, updatedAt: input.at }
  return Object.freeze({ ...body, runHash: calculateCanonicalHash(body) })
}

export function beginLocalizationTranslation(run: Readonly<LocalizationRun>, at: string) {
  assertDomain(run.status === 'requested' || (run.status === 'failed' && Boolean(run.failure?.retryable)), 'VERSION_CONFLICT', 'Localization run is not claimable')
  const body = { ...run, status: 'translating' as const, attempt: run.attempt + 1, failure: undefined, updatedAt: at, runHash: undefined }
  return Object.freeze({ ...body, runHash: calculateCanonicalHash(body) })
}

export function recordLocalizationTranslation(run: Readonly<LocalizationRun>, provider: Readonly<{ providerId: string; adapterVersion: string; model: string; configHash: string }>, blocks: readonly LocalizedBlockDraft[], at: string) {
  assertDomain(run.status === 'translating' && blocks.length > 0 && blocks.every((block) => block.reviewStatus === 'machine-translated'), 'VERSION_CONFLICT', 'Localization translation result is not admissible')
  const frozen = Object.freeze(blocks.map((block) => Object.freeze({ ...block, protectedValues: Object.freeze({ ...block.protectedValues }) })))
  const translationBody = { ...provider, blocks: frozen }
  const translation = Object.freeze({ ...translationBody, translationHash: calculateCanonicalHash(translationBody) })
  const body = { ...run, status: 'awaiting-human-review' as const, translation, updatedAt: at, runHash: undefined }
  return Object.freeze({ ...body, runHash: calculateCanonicalHash(body) })
}

export function failLocalizationTranslation(run: Readonly<LocalizationRun>, failure: Readonly<{ code: string; message: string; retryable: boolean }>, at: string) {
  assertDomain(run.status === 'translating', 'VERSION_CONFLICT', 'Only an active localization translation can fail')
  const body = { ...run, status: 'failed' as const, failure: Object.freeze({ ...failure }), updatedAt: at, runHash: undefined }
  return Object.freeze({ ...body, runHash: calculateCanonicalHash(body) })
}
