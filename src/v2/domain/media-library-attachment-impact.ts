import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export interface MediaLibraryAttachmentImpactV1 {
  schemaVersion: 'media-library-attachment-impact/v1'
  commandType: 'attach-media-library-reference'
  commandId: string
  baseVersionId: string
  resultVersionId: string
  preservedEditPlanSnapshotId: string | null
  selectionKind: 'asset' | 'segment'
  selectionId: string
  parentArtifactId: string
  sourceSha256: string
  rightsSnapshotId: string
  changeKinds: readonly ['library-reference']
  dependencyTypes: readonly never[]
  affectedRanges: readonly never[]
  affectedVariantIds: readonly never[]
  affectedArtifacts: readonly never[]
  minimalRenders: readonly never[]
  renderSemanticsChanged: false
  impactHash: string
}

type ImpactInput = Pick<MediaLibraryAttachmentImpactV1, 'commandId' | 'baseVersionId' | 'resultVersionId' | 'preservedEditPlanSnapshotId' | 'selectionKind' | 'selectionId' | 'parentArtifactId' | 'sourceSha256' | 'rightsSnapshotId'>
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

/** A selected-insert reference changes metadata only; the exact EditPlan snapshot is retained. */
export function createMediaLibraryAttachmentImpact(input: ImpactInput): Readonly<MediaLibraryAttachmentImpactV1> {
  for (const field of ['commandId', 'baseVersionId', 'resultVersionId', 'selectionId', 'parentArtifactId', 'rightsSnapshotId'] as const) assertDomain(typeof input[field] === 'string' && ID.test(input[field]), 'INVALID_ARGUMENT', `${field} is invalid`)
  assertDomain(input.preservedEditPlanSnapshotId === null || (typeof input.preservedEditPlanSnapshotId === 'string' && ID.test(input.preservedEditPlanSnapshotId)), 'INVALID_ARGUMENT', 'Preserved EditPlan snapshot is invalid')
  assertDomain(input.selectionKind === 'asset' || input.selectionKind === 'segment', 'INVALID_ARGUMENT', 'Library selection kind is invalid')
  assertDomain(/^[a-f0-9]{64}$/.test(input.sourceSha256), 'INVALID_ARGUMENT', 'Library source hash is invalid')
  assertDomain(input.baseVersionId !== input.resultVersionId, 'INVALID_ARGUMENT', 'Library attachment requires a distinct metadata version')
  const body = {
    schemaVersion: 'media-library-attachment-impact/v1' as const, commandType: 'attach-media-library-reference' as const,
    commandId: input.commandId, baseVersionId: input.baseVersionId, resultVersionId: input.resultVersionId,
    preservedEditPlanSnapshotId: input.preservedEditPlanSnapshotId, selectionKind: input.selectionKind, selectionId: input.selectionId,
    parentArtifactId: input.parentArtifactId, sourceSha256: input.sourceSha256, rightsSnapshotId: input.rightsSnapshotId,
    changeKinds: Object.freeze(['library-reference'] as const),
    dependencyTypes: Object.freeze([] as never[]), affectedRanges: Object.freeze([] as never[]), affectedVariantIds: Object.freeze([] as never[]),
    affectedArtifacts: Object.freeze([] as never[]), minimalRenders: Object.freeze([] as never[]), renderSemanticsChanged: false as const,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function parseMediaLibraryAttachmentImpact(value: unknown): Readonly<MediaLibraryAttachmentImpactV1> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'PERSISTENCE_CONFLICT', 'Stored library attachment impact must be an object')
  const impact = value as MediaLibraryAttachmentImpactV1
  const recreated = createMediaLibraryAttachmentImpact({ commandId: impact.commandId, baseVersionId: impact.baseVersionId, resultVersionId: impact.resultVersionId, preservedEditPlanSnapshotId: impact.preservedEditPlanSnapshotId, selectionKind: impact.selectionKind, selectionId: impact.selectionId, parentArtifactId: impact.parentArtifactId, sourceSha256: impact.sourceSha256, rightsSnapshotId: impact.rightsSnapshotId })
  assertDomain(stableSerialize(recreated) === stableSerialize(impact), 'PERSISTENCE_CONFLICT', 'Stored library attachment impact is inconsistent')
  return recreated
}
