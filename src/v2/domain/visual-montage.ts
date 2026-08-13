import { calculateCanonicalHash } from './canonical-hash.ts'
import { createAssetBrief, type AssetBrief } from './asset-selection.ts'
import { DomainError } from './errors.ts'

export type VisualMontageAssetKind = 'image' | 'video'
export type VisualMontageSlotKind = VisualMontageAssetKind | 'card'
export type VisualMontageMotion = 'none' | 'push-in' | 'pan-left' | 'pan-right'

export interface VisualMontageSourceAsset {
  id: string
  artifactId: string
  artifactKey: string
  sha256: string
  byteSize: number
  kind: VisualMontageAssetKind
  containsPeople: false
  personEvidence: Readonly<{
    schemaVersion: 'person-presence-evidence/v1'
    method: 'human-review' | 'provider-metadata' | 'synthetic-generation'
    containsPeople: false
    evidenceHash: string
  }>
  content: readonly string[]
  style: readonly string[]
}

export interface VisualMontageBeatInput {
  storyBlockId: string
  endMs: number
  narration: string
  intention: string
  content: readonly string[]
  style: readonly string[]
}

export interface VisualMontageBeat {
  id: string
  storyBlockId: string
  startMs: number
  endMs: number
  narration: string
  assetBrief: Readonly<AssetBrief>
  assetBriefHash: string
}

export interface VisualMontageSlot {
  id: string
  beatId: string
  startMs: number
  endMs: number
  kind: VisualMontageSlotKind
  assetId?: string
  card?: Readonly<{ title: string; description: string }>
  motion: VisualMontageMotion
  containsPeople: false
}

export interface VisualMontageValidation {
  schemaVersion: 'visual-montage-validation/v1'
  signals: Readonly<{
    coverage: Readonly<{ passed: boolean; coveredMs: number; expectedMs: number }>
    repetition: Readonly<{ passed: boolean; repeatedAssetSlots: number }>
    rhythm: Readonly<{ passed: boolean; minimumBeatMs: number; maximumBeatMs: number }>
    legibility: Readonly<{ passed: boolean; unreadableBeatIds: readonly string[] }>
    personFree: Readonly<{ passed: boolean; violatingSlotIds: readonly string[] }>
  }>
  passed: boolean
  validationHash: string
}

export interface VisualMontagePlan {
  schemaVersion: 'visual-montage-plan/v1'
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  storyPlanRef: Readonly<{ id: string; hash: string }>
  montageSelectionRef: Readonly<{
    selectionHash: string
    candidateId: string
    candidateHash: string
  }>
  sourceAudio: Readonly<{ artifactId: string; artifactKey: string; sha256: string; byteSize: number; durationMs: number }>
  fps: 30
  beats: readonly Readonly<VisualMontageBeat>[]
  slots: readonly Readonly<VisualMontageSlot>[]
  assets: readonly Readonly<VisualMontageSourceAsset>[]
  validation: Readonly<VisualMontageValidation>
  audioTimelineHash: string
  planHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
function id(value: string, field: string): string {
  const normalized = value?.trim()
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}
function text(value: string, field: string, maximum: number): string {
  const normalized = value?.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maximum) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}
function hash(value: string, field: string): string {
  if (!HASH.test(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be a lowercase SHA-256`)
  return value
}

export function validateVisualMontage(input: Pick<VisualMontagePlan, 'sourceAudio' | 'beats' | 'slots' | 'assets'>): Readonly<VisualMontageValidation> {
  const durationMs = input.sourceAudio.durationMs
  const ordered = [...input.slots].toSorted((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
  let cursor = 0
  let coveredMs = 0
  for (const slot of ordered) {
    if (slot.startMs === cursor && slot.endMs > slot.startMs) coveredMs += slot.endMs - slot.startMs
    cursor = slot.endMs
  }
  const coverage = Object.freeze({ passed: ordered.length > 0 && ordered[0]?.startMs === 0 && cursor === durationMs && coveredMs === durationMs, coveredMs, expectedMs: durationMs })
  const usedAssetIds = ordered.flatMap((slot) => slot.assetId ? [slot.assetId] : [])
  const repeatedAssetSlots = usedAssetIds.length - new Set(usedAssetIds).size
  const repetition = Object.freeze({ passed: repeatedAssetSlots === 0, repeatedAssetSlots })
  const durations = input.beats.map((beat) => beat.endMs - beat.startMs)
  const minimumBeatMs = Math.min(...durations)
  const maximumBeatMs = Math.max(...durations)
  const rhythm = Object.freeze({ passed: minimumBeatMs >= 600 && maximumBeatMs <= 12_000, minimumBeatMs, maximumBeatMs })
  const unreadableBeatIds = input.beats.filter((beat) => {
    const durationSeconds = (beat.endMs - beat.startMs) / 1000
    return beat.narration.length > 120 || beat.narration.length / durationSeconds > 26
  }).map(({ id: beatId }) => beatId)
  const legibility = Object.freeze({ passed: unreadableBeatIds.length === 0, unreadableBeatIds: Object.freeze(unreadableBeatIds) })
  const assetById = new Map(input.assets.map((asset) => [asset.id, asset]))
  const violatingSlotIds = ordered.filter((slot) => {
    if (slot.containsPeople !== false) return true
    if (!slot.assetId) return false
    const asset = assetById.get(slot.assetId)
    return asset?.containsPeople !== false ||
      asset.personEvidence?.containsPeople !== false ||
      !HASH.test(asset.personEvidence.evidenceHash)
  }).map(({ id: slotId }) => slotId)
  const personFree = Object.freeze({ passed: violatingSlotIds.length === 0, violatingSlotIds: Object.freeze(violatingSlotIds) })
  const signals = Object.freeze({ coverage, repetition, rhythm, legibility, personFree })
  const core = Object.freeze({ schemaVersion: 'visual-montage-validation/v1' as const, signals, passed: Object.values(signals).every(({ passed }) => passed) })
  return Object.freeze({ ...core, validationHash: calculateCanonicalHash(core) })
}

export function assertVisualMontagePlanIntegrity(plan: Readonly<VisualMontagePlan>): void {
  const { planHash, ...core } = plan
  const currentValidation = validateVisualMontage(plan)
  if (
    calculateCanonicalHash(core) !== planHash ||
    currentValidation.validationHash !== plan.validation.validationHash ||
    !currentValidation.passed
  ) {
    throw new DomainError(
      'INVALID_RENDER_INPUT',
      'Visual montage content or validation evidence changed after planning',
    )
  }
}

export function createVisualMontagePlan(input: {
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  storyPlanRef: VisualMontagePlan['storyPlanRef']
  montageSelectionRef: VisualMontagePlan['montageSelectionRef']
  sourceAudio: VisualMontagePlan['sourceAudio']
  beatBoundaries: readonly VisualMontageBeatInput[]
  assets: readonly VisualMontageSourceAsset[]
}): Readonly<VisualMontagePlan> {
  const sourceAudio = Object.freeze({
    artifactId: id(input.sourceAudio.artifactId, 'sourceAudio.artifactId'),
    artifactKey: text(input.sourceAudio.artifactKey, 'sourceAudio.artifactKey', 512),
    sha256: hash(input.sourceAudio.sha256, 'sourceAudio.sha256'),
    byteSize: input.sourceAudio.byteSize,
    durationMs: input.sourceAudio.durationMs,
  })
  if (!Number.isSafeInteger(sourceAudio.byteSize) || sourceAudio.byteSize < 1 || !Number.isSafeInteger(sourceAudio.durationMs) || sourceAudio.durationMs < 600 || sourceAudio.durationMs > 3_600_000) throw new DomainError('INVALID_ARGUMENT', 'sourceAudio metadata is invalid')
  if (!Array.isArray(input.beatBoundaries) || input.beatBoundaries.length < 3 || input.beatBoundaries.length > 120) throw new DomainError('INVALID_ARGUMENT', 'visual montage requires 3 to 120 beats')
  const assets = Object.freeze(input.assets.map((asset, index) => {
    if (!['image', 'video'].includes(asset.kind) || asset.containsPeople !== false || !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 1 || asset.personEvidence?.schemaVersion !== 'person-presence-evidence/v1' || asset.personEvidence.containsPeople !== false || !['human-review', 'provider-metadata', 'synthetic-generation'].includes(asset.personEvidence.method)) throw new DomainError('INVALID_ARGUMENT', `assets[${index}] is invalid or lacks person-free evidence`)
    const personEvidence = Object.freeze({ ...asset.personEvidence, evidenceHash: hash(asset.personEvidence.evidenceHash, `assets[${index}].personEvidence.evidenceHash`) })
    return Object.freeze({ ...asset, id: id(asset.id, `assets[${index}].id`), artifactId: id(asset.artifactId, `assets[${index}].artifactId`), artifactKey: text(asset.artifactKey, `assets[${index}].artifactKey`, 512), sha256: hash(asset.sha256, `assets[${index}].sha256`), personEvidence, content: Object.freeze([...asset.content]), style: Object.freeze([...asset.style]) })
  }))
  if (new Set(assets.map(({ id: assetId }) => assetId)).size !== assets.length || !assets.some(({ kind }) => kind === 'image') || !assets.some(({ kind }) => kind === 'video')) throw new DomainError('INVALID_ARGUMENT', 'visual montage requires unique image and video assets')
  let startMs = 0
  const beats = Object.freeze(input.beatBoundaries.map((boundary, index) => {
    if (!Number.isSafeInteger(boundary.endMs) || boundary.endMs <= startMs || boundary.endMs > sourceAudio.durationMs) throw new DomainError('INVALID_ARGUMENT', `beatBoundaries[${index}] is invalid`)
    const storyBlockId = id(boundary.storyBlockId, `beatBoundaries[${index}].storyBlockId`)
    const beatId = `visual-beat-${index + 1}`
    const duration = boundary.endMs - startMs
    const assetBrief = createAssetBrief({ intention: boundary.intention, content: boundary.content, style: boundary.style, durationMs: { min: Math.max(100, duration - 250), max: Math.min(120_000, duration + 250) }, entry: index === 0 ? 'audio-start' : `beat-${index}-end`, exit: `beat-${index + 1}-end`, prohibited: ['person', 'people', 'human', 'face', 'speaker'] })
    const beat = Object.freeze({ id: beatId, storyBlockId, startMs, endMs: boundary.endMs, narration: text(boundary.narration, `beatBoundaries[${index}].narration`, 120), assetBrief, assetBriefHash: calculateCanonicalHash(assetBrief) })
    startMs = boundary.endMs
    return beat
  }))
  if (new Set(beats.map(({ storyBlockId }) => storyBlockId)).size !== beats.length) throw new DomainError('INVALID_ARGUMENT', 'visual montage beats must reference unique StoryPlan blocks')
  if (startMs !== sourceAudio.durationMs) throw new DomainError('INVALID_ARGUMENT', 'beats must end exactly at the source audio duration')
  const slots = Object.freeze(beats.map((beat, index): Readonly<VisualMontageSlot> => {
    const kind: VisualMontageSlotKind = index % 3 === 0 ? 'image' : index % 3 === 1 ? 'video' : 'card'
    const compatible = assets.filter((asset) => asset.kind === kind)
    const asset = kind === 'card' ? undefined : compatible[Math.floor(index / 3) % compatible.length]
    return Object.freeze({ id: `visual-slot-${index + 1}`, beatId: beat.id, startMs: beat.startMs, endMs: beat.endMs, kind, ...(asset ? { assetId: asset.id } : { card: Object.freeze({ title: beat.assetBrief.intention.slice(0, 44), description: beat.narration.slice(0, 80) }) }), motion: kind === 'card' ? 'none' : index % 2 === 0 ? 'push-in' : 'pan-left', containsPeople: false as const })
  }))
  const validation = validateVisualMontage({ sourceAudio, beats, slots, assets })
  if (!validation.passed) throw new DomainError('INVALID_ARGUMENT', 'visual montage failed coverage validation', { validation })
  const storyPlanRef = Object.freeze({ id: id(input.storyPlanRef.id, 'storyPlanRef.id'), hash: hash(input.storyPlanRef.hash, 'storyPlanRef.hash') })
  const montageSelectionRef = Object.freeze({ selectionHash: hash(input.montageSelectionRef.selectionHash, 'montageSelectionRef.selectionHash'), candidateId: id(input.montageSelectionRef.candidateId, 'montageSelectionRef.candidateId'), candidateHash: hash(input.montageSelectionRef.candidateHash, 'montageSelectionRef.candidateHash') })
  const core = Object.freeze({ schemaVersion: 'visual-montage-plan/v1' as const, id: id(input.id, 'id'), workspaceId: id(input.workspaceId, 'workspaceId'), projectId: id(input.projectId, 'projectId'), projectVersionId: id(input.projectVersionId, 'projectVersionId'), storyPlanRef, montageSelectionRef, sourceAudio, fps: 30 as const, beats, slots, assets, validation, audioTimelineHash: calculateCanonicalHash({ artifactId: sourceAudio.artifactId, sha256: sourceAudio.sha256, durationMs: sourceAudio.durationMs }) })
  return Object.freeze({ ...core, planHash: calculateCanonicalHash(core) })
}
