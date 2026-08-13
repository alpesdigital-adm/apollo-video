import { DomainError } from '../domain/errors.ts'
import { MONTAGE_ALTERNATIVE_POLICY_VERSION, type MontageCandidateSeed } from '../domain/montage-candidate.ts'
import type { MontageAlternativeRun, PersistedMontageAlternativeRun } from '../application/ports/montage-alternative-repository.ts'

function record(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  const result = value as Record<string, unknown>
  if (Object.keys(result).some((key) => !keys.includes(key))) throw new DomainError('INVALID_ARGUMENT', `${field} contains an unsupported field`)
  return result
}
function array(value: unknown, field: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new DomainError('INVALID_ARGUMENT', `${field} must be a bounded array`)
  return value
}
function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length < 3 || value.trim().length > 128) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new DomainError('INVALID_ARGUMENT', `${field} must be boolean`)
  return value
}
function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be finite`)
  return value
}
function candidate(value: unknown, index: number, storyPlanRef: Readonly<{ id: string; hash: string }>): Omit<MontageCandidateSeed, 'schemaVersion' | 'seedHash'> {
  const field = `seeds[${index}]`
  const item = record(value, field, ['id', 'seed', 'mode', 'hook', 'blockOrder', 'permittedBlockOrders', 'assets', 'patternBreaks', 'maximumPatternBreaks', 'confidence', 'rubricSignals'])
  const hook = record(item.hook, `${field}.hook`, ['id', 'selfContained'])
  const signals = record(item.rubricSignals, `${field}.rubricSignals`, ['narrative', 'objective', 'continuity', 'evidence'])
  return {
    id: string(item.id, `${field}.id`), seed: string(item.seed, `${field}.seed`), storyPlanRef,
    mode: string(item.mode, `${field}.mode`) as MontageCandidateSeed['mode'],
    hook: { id: string(hook.id, `${field}.hook.id`), selfContained: boolean(hook.selfContained, `${field}.hook.selfContained`) },
    blockOrder: array(item.blockOrder, `${field}.blockOrder`, 1, 64).map((entry, itemIndex) => string(entry, `${field}.blockOrder[${itemIndex}]`)),
    permittedBlockOrders: array(item.permittedBlockOrders, `${field}.permittedBlockOrders`, 1, 32).map((order, orderIndex) => array(order, `${field}.permittedBlockOrders[${orderIndex}]`, 1, 64).map((entry, itemIndex) => string(entry, `${field}.permittedBlockOrders[${orderIndex}][${itemIndex}]`))),
    assets: array(item.assets, `${field}.assets`, 0, 32).map((asset, assetIndex) => { const parsed = record(asset, `${field}.assets[${assetIndex}]`, ['id', 'rightsApproved']); return { id: string(parsed.id, `${field}.assets[${assetIndex}].id`), rightsApproved: boolean(parsed.rightsApproved, `${field}.assets[${assetIndex}].rightsApproved`) } }),
    patternBreaks: array(item.patternBreaks, `${field}.patternBreaks`, 0, 64).map((pattern, patternIndex) => { const parsed = record(pattern, `${field}.patternBreaks[${patternIndex}]`, ['id', 'atMs', 'group']); return { id: string(parsed.id, `${field}.patternBreaks[${patternIndex}].id`), atMs: number(parsed.atMs, `${field}.patternBreaks[${patternIndex}].atMs`), group: string(parsed.group, `${field}.patternBreaks[${patternIndex}].group`) } }),
    maximumPatternBreaks: number(item.maximumPatternBreaks, `${field}.maximumPatternBreaks`), confidence: number(item.confidence, `${field}.confidence`),
    rubricSignals: { narrative: number(signals.narrative, `${field}.rubricSignals.narrative`), objective: number(signals.objective, `${field}.rubricSignals.objective`), continuity: number(signals.continuity, `${field}.rubricSignals.continuity`), evidence: number(signals.evidence, `${field}.rubricSignals.evidence`) },
  }
}

export function parseCreateMontageAlternativeBody(value: unknown) {
  const body = record(value, 'body', ['policyVersion', 'storyPlanRef', 'seeds'])
  const ref = record(body.storyPlanRef, 'storyPlanRef', ['id', 'hash'])
  const storyPlanRef = Object.freeze({ id: string(ref.id, 'storyPlanRef.id'), hash: string(ref.hash, 'storyPlanRef.hash') })
  if (body.policyVersion !== MONTAGE_ALTERNATIVE_POLICY_VERSION) throw new DomainError('INVALID_ARGUMENT', `policyVersion must be ${MONTAGE_ALTERNATIVE_POLICY_VERSION}`)
  return Object.freeze({ policyVersion: MONTAGE_ALTERNATIVE_POLICY_VERSION, storyPlanRef, seeds: array(body.seeds, 'seeds', 1, 32).map((seed, index) => candidate(seed, index, storyPlanRef)) })
}

export function presentMontageAlternativeRun(run: Readonly<PersistedMontageAlternativeRun>): Readonly<MontageAlternativeRun> {
  const { requestFingerprint: _requestFingerprint, idempotencyKey: _idempotencyKey, ...publicRun } = run
  return Object.freeze(publicRun)
}
