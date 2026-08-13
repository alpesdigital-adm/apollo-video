import { createAssetRightsSnapshot, type AssetRightsDraft, type AssetRightsSnapshot } from './asset-rights.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError, assertDomain } from './errors.ts'

export const AUTOMATIC_CATALOG_OUTPUT_KINDS = ['final', 'proxy', 'deepfake-raw'] as const
export type AutomaticCatalogOutputKind = (typeof AUTOMATIC_CATALOG_OUTPUT_KINDS)[number]
export type AutomaticCatalogSearchableKind = 'asset' | 'segment'

export interface AutomaticCatalogLineage {
  readonly sourceArtifactId: string
  readonly role: string
  readonly ordinal: number
  readonly provider?: string
  readonly model?: string
  readonly modelVersion?: string
}

export interface AutomaticCatalogCandidate {
  readonly workspaceId: string
  readonly artifactId: string
  readonly manifestId: string
  readonly outputKind: AutomaticCatalogOutputKind
  readonly searchableKind: AutomaticCatalogSearchableKind
  readonly label: string
  readonly sourceDurationMs?: number
  readonly eligibilityEvidenceHash: string
  readonly lineage: readonly AutomaticCatalogLineage[]
}

export interface AutomaticCatalogRecord {
  readonly id: string
  readonly workspaceId: string
  readonly artifactId: string
  readonly manifestId: string
  readonly outputKind: AutomaticCatalogOutputKind
  readonly searchableKind: AutomaticCatalogSearchableKind
  readonly segmentId?: string
  readonly rightsSnapshotId: string
  readonly rightsSnapshotHash: string
  readonly eligibilityEvidenceHash: string
  readonly lineage: readonly AutomaticCatalogLineage[]
  readonly recordHash: string
  readonly createdAt: string
}

function intersection(values: readonly (readonly string[] | undefined)[]): readonly string[] | undefined {
  const constrained = values.filter((value): value is readonly string[] => value !== undefined)
  if (constrained.length === 0) return undefined
  return Object.freeze([...new Set(constrained[0])].filter((value) => constrained.every((scope) => scope.includes(value))).sort())
}

function earliest(values: readonly (string | undefined)[]): string | undefined {
  const present = values.filter((value): value is string => value !== undefined)
  return present.length ? [...present].sort()[0] : undefined
}

function identical(values: readonly (string | undefined)[]): string | undefined {
  const present = values.filter((value): value is string => value !== undefined)
  return present.length > 0 && present.length === values.length && new Set(present).size === 1 ? present[0] : undefined
}

export function createInheritedCatalogRights(input: {
  candidate: AutomaticCatalogCandidate
  sourceSnapshots: readonly AssetRightsSnapshot[]
  sequence: number
  createdAt: string
}): AssetRightsSnapshot {
  const { candidate, sourceSnapshots } = input
  assertDomain(sourceSnapshots.length > 0, 'ASSET_RIGHTS_BLOCKED', 'Catalog output has no source rights evidence')
  const sourceIds = new Set(candidate.lineage.map((edge) => edge.sourceArtifactId))
  assertDomain(
    sourceSnapshots.length === sourceIds.size && sourceSnapshots.every((snapshot) => snapshot.workspaceId === candidate.workspaceId && sourceIds.has(snapshot.artifactId)),
    'ASSET_RIGHTS_BLOCKED',
    'Catalog output source rights evidence is incomplete',
  )
  assertDomain(
    sourceSnapshots.every((snapshot) => snapshot.status === 'approved' && ['approved', 'not-required'].includes(snapshot.consent.status)),
    'ASSET_RIGHTS_BLOCKED',
    'Catalog output source rights or consent is not approved',
  )
  const allowedUses = intersection(sourceSnapshots.map((snapshot) => snapshot.allowedUses)) ?? []
  const prohibitedUses = Object.freeze([...new Set(sourceSnapshots.flatMap((snapshot) => snapshot.prohibitedUses))].sort())
  assertDomain(allowedUses.includes('editorial-reuse') && !prohibitedUses.includes('editorial-reuse'), 'ASSET_RIGHTS_BLOCKED', 'Catalog output is not eligible for editorial reuse')

  const approvedConsent = sourceSnapshots.filter((snapshot) => snapshot.consent.status === 'approved')
  const consentDocuments = approvedConsent.map((snapshot) => snapshot.consent.documentArtifactId)
  assertDomain(new Set(consentDocuments).size <= 1, 'ASSET_RIGHTS_BLOCKED', 'Catalog output consent documents cannot be represented without losing evidence')
  const consentAllowedUses = approvedConsent.length
    ? intersection(approvedConsent.map((snapshot) => snapshot.consent.allowedUses)) ?? []
    : []
  assertDomain(approvedConsent.length === 0 || consentAllowedUses.includes('editorial-reuse'), 'ASSET_RIGHTS_BLOCKED', 'Catalog output consent does not allow editorial reuse')

  const draft: AssetRightsDraft = {
    ...(identical(sourceSnapshots.map((snapshot) => snapshot.owner)) ? { owner: identical(sourceSnapshots.map((snapshot) => snapshot.owner)) } : {}),
    ...(identical(sourceSnapshots.map((snapshot) => snapshot.license)) ? { license: identical(sourceSnapshots.map((snapshot) => snapshot.license)) } : {}),
    status: 'approved',
    allowedUses,
    prohibitedUses,
    ...(intersection(sourceSnapshots.map((snapshot) => snapshot.allowedMarkets)) !== undefined ? { allowedMarkets: intersection(sourceSnapshots.map((snapshot) => snapshot.allowedMarkets)) } : {}),
    ...(intersection(sourceSnapshots.map((snapshot) => snapshot.allowedLocales)) !== undefined ? { allowedLocales: intersection(sourceSnapshots.map((snapshot) => snapshot.allowedLocales)) } : {}),
    ...(intersection(sourceSnapshots.map((snapshot) => snapshot.allowedSyntheticOperations)) !== undefined ? { allowedSyntheticOperations: intersection(sourceSnapshots.map((snapshot) => snapshot.allowedSyntheticOperations)) } : {}),
    ...(earliest(sourceSnapshots.map((snapshot) => snapshot.expiresAt)) ? { expiresAt: earliest(sourceSnapshots.map((snapshot) => snapshot.expiresAt)) } : {}),
    consent: approvedConsent.length === 0 ? { status: 'not-required', allowedUses: [] } : {
      status: 'approved', allowedUses: consentAllowedUses,
      ...(intersection(approvedConsent.map((snapshot) => snapshot.consent.allowedMarkets)) !== undefined ? { allowedMarkets: intersection(approvedConsent.map((snapshot) => snapshot.consent.allowedMarkets)) } : {}),
      ...(intersection(approvedConsent.map((snapshot) => snapshot.consent.allowedLocales)) !== undefined ? { allowedLocales: intersection(approvedConsent.map((snapshot) => snapshot.consent.allowedLocales)) } : {}),
      ...(intersection(approvedConsent.map((snapshot) => snapshot.consent.allowedSyntheticOperations)) !== undefined ? { allowedSyntheticOperations: intersection(approvedConsent.map((snapshot) => snapshot.consent.allowedSyntheticOperations)) } : {}),
      ...(earliest(approvedConsent.map((snapshot) => snapshot.consent.expiresAt)) ? { expiresAt: earliest(approvedConsent.map((snapshot) => snapshot.consent.expiresAt)) } : {}),
      ...(consentDocuments[0] ? { documentArtifactId: consentDocuments[0] } : {}),
    },
    sourceNote: `Inherited fail-closed from ${sourceSnapshots.length} source(s); evidence ${calculateCanonicalHash(sourceSnapshots.map((snapshot) => ({ artifactId: snapshot.artifactId, snapshotHash: snapshot.snapshotHash })).sort((left, right) => left.artifactId.localeCompare(right.artifactId)))}`,
  }
  const draftHash = calculateCanonicalHash(draft)
  return createAssetRightsSnapshot({
    id: `catalog-rights-${draftHash.slice(0, 48)}`,
    workspaceId: candidate.workspaceId,
    artifactId: candidate.artifactId,
    sequence: input.sequence,
    draft,
    createdBy: { type: 'system', id: 'automatic-catalog' },
    createdAt: input.createdAt,
  })
}

export function assertAutomaticCatalogCandidate(candidate: AutomaticCatalogCandidate): void {
  assertDomain(AUTOMATIC_CATALOG_OUTPUT_KINDS.includes(candidate.outputKind), 'PERSISTENCE_CONFLICT', 'Catalog output kind is invalid')
  assertDomain(candidate.searchableKind === (candidate.outputKind === 'deepfake-raw' ? 'segment' : 'asset'), 'PERSISTENCE_CONFLICT', 'Catalog searchable kind does not match output kind')
  assertDomain(candidate.lineage.length > 0 && candidate.lineage.every((edge, index) => edge.ordinal === index), 'PERSISTENCE_CONFLICT', 'Catalog generated-from lineage is incomplete')
  if (candidate.outputKind === 'deepfake-raw') {
    assertDomain(candidate.lineage.every((edge) => edge.provider && edge.model), 'PERSISTENCE_CONFLICT', 'Deepfake catalog lineage requires provider and model')
    assertDomain(Number.isSafeInteger(candidate.sourceDurationMs) && candidate.sourceDurationMs! > 0, 'PERSISTENCE_CONFLICT', 'Deepfake catalog segment duration is invalid')
  }
}

export function automaticCatalogRecordHash(input: Omit<AutomaticCatalogRecord, 'id' | 'recordHash' | 'createdAt'>): string {
  return calculateCanonicalHash({ schemaVersion: 'automatic-catalog-record/v1', ...input })
}
