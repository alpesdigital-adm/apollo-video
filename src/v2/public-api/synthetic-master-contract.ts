import type { PersistedSyntheticMasterAsset } from '../application/ports/synthetic-master-asset-repository.ts'
import { assertDomain } from '../domain/errors.ts'
import type { SyntheticMasterAsset } from '../domain/synthetic-master-asset.ts'
import type { SyntheticSpeechSegment } from '../domain/synthetic-speech-segment.ts'

/**
 * Public contract for the immutable synthetic master (F3.007).
 *
 * Presenters project only what the domain already sealed: identities, content
 * addresses, measured durations, sanitized provenance, cost and critic
 * evidence. No provider payload, adapter configuration, authorization body or
 * storage location ever crosses this boundary — the master carries hashes for
 * exactly that reason.
 */

const MAX_LINEAGE_ENTRIES = 500

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be an object`,
  )
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && value.trim().length > 0,
    'INVALID_ARGUMENT',
    `${field} must be a non-empty string`,
  )
  return (value as string).trim()
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  assertDomain(
    Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value),
    'INVALID_ARGUMENT',
    `${field} contains missing or unsupported properties`,
  )
}

export interface PromoteSyntheticMasterBody {
  providerJobId: string
  profileSnapshotId: string
  scriptText: string
  locale: string
  use: string
  market: string
  lineage: readonly string[]
  cost: Readonly<{ currency: string; minorUnits: number }>
}

export function parsePromoteSyntheticMasterBody(raw: unknown): Readonly<PromoteSyntheticMasterBody> {
  const body = record(raw, 'body')
  exact(
    body,
    ['providerJobId', 'profileSnapshotId', 'scriptText', 'locale', 'use', 'market', 'lineage', 'cost'],
    'body',
  )
  assertDomain(
    Array.isArray(body.lineage) && body.lineage.length > 0 && body.lineage.length <= MAX_LINEAGE_ENTRIES,
    'INVALID_ARGUMENT',
    'body.lineage must be a bounded non-empty array',
  )
  const lineage = (body.lineage as unknown[]).map((entry, index) =>
    string(entry, `body.lineage[${index}]`))
  assertDomain(
    new Set(lineage).size === lineage.length,
    'INVALID_ARGUMENT',
    'body.lineage cannot repeat a generation',
  )
  const cost = record(body.cost, 'body.cost')
  exact(cost, ['currency', 'minorUnits'], 'body.cost')
  assertDomain(
    Number.isSafeInteger(cost.minorUnits) && (cost.minorUnits as number) >= 0,
    'INVALID_ARGUMENT',
    'body.cost.minorUnits must be a non-negative integer',
  )
  return Object.freeze({
    providerJobId: string(body.providerJobId, 'body.providerJobId'),
    profileSnapshotId: string(body.profileSnapshotId, 'body.profileSnapshotId'),
    scriptText: string(body.scriptText, 'body.scriptText'),
    locale: string(body.locale, 'body.locale'),
    use: string(body.use, 'body.use'),
    market: string(body.market, 'body.market'),
    lineage: Object.freeze(lineage),
    cost: Object.freeze({
      currency: string(cost.currency, 'body.cost.currency'),
      minorUnits: cost.minorUnits as number,
    }),
  })
}

function boundedLimit(value: string | null, field: string): number {
  const limit = Number(value)
  assertDomain(
    value !== null && value.trim().length > 0 && Number.isSafeInteger(limit),
    'INVALID_ARGUMENT',
    `${field} must be an integer`,
  )
  return limit
}

export const SYNTHETIC_MASTER_LIST_QUERY_PARAMETERS: ReadonlySet<string> =
  new Set(['profileId', 'scriptHash', 'limit'])

export function parseSyntheticMasterListQuery(parameters: URLSearchParams) {
  return Object.freeze({
    ...(parameters.has('profileId')
      ? { profileId: string(parameters.get('profileId'), 'profileId') }
      : {}),
    ...(parameters.has('scriptHash')
      ? { scriptHash: string(parameters.get('scriptHash'), 'scriptHash') }
      : {}),
    ...(parameters.has('limit') ? { limit: boundedLimit(parameters.get('limit'), 'limit') } : {}),
  })
}

export const SYNTHETIC_SPEECH_SEGMENT_SEARCH_QUERY_PARAMETERS: ReadonlySet<string> = new Set([
  'projectId', 'profileId', 'locale', 'text', 'emotion', 'wardrobe', 'setting', 'scriptHash', 'limit',
])

export function parseSyntheticSpeechSegmentSearchQuery(parameters: URLSearchParams) {
  const optional = ['projectId', 'profileId', 'locale', 'text', 'emotion', 'wardrobe', 'setting', 'scriptHash'] as const
  const query: Record<string, string | number> = {}
  for (const name of optional) {
    if (parameters.has(name)) query[name] = string(parameters.get(name), name)
  }
  if (parameters.has('limit')) query.limit = boundedLimit(parameters.get('limit'), 'limit')
  return Object.freeze(query) as Readonly<{
    projectId?: string
    profileId?: string
    locale?: string
    text?: string
    emotion?: string
    wardrobe?: string
    setting?: string
    scriptHash?: string
    limit?: number
  }>
}

function presentArtifactRef(artifact: Readonly<SyntheticMasterAsset['artifacts'][number]>) {
  return Object.freeze({
    artifactId: artifact.artifactId,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    mediaType: artifact.mediaType,
    container: artifact.container,
  })
}

export function presentSyntheticMaster(
  value: Readonly<PersistedSyntheticMasterAsset> | Readonly<SyntheticMasterAsset>,
) {
  const master = 'master' in value ? value.master : value
  return Object.freeze({
    schemaVersion: master.schemaVersion,
    id: master.id,
    workspaceId: master.workspaceId,
    projectId: master.projectId,
    projectVersionId: master.projectVersionId,
    profileId: master.profileId,
    profileSnapshotId: master.profileSnapshotId,
    profileVersion: master.profileVersion,
    consentSnapshotHash: master.consentSnapshotHash,
    authorizationHash: master.authorizationHash,
    rightsSnapshotId: master.rightsSnapshotId,
    artifacts: master.artifacts.map((artifact) =>
      Object.freeze({ role: artifact.role, ...presentArtifactRef(artifact) })),
    scriptText: master.scriptText,
    scriptHash: master.scriptHash,
    alignmentHash: master.alignmentHash,
    locale: master.locale,
    durationMs: master.durationMs,
    audioDurationMs: master.audioDurationMs,
    videoDurationMs: master.videoDurationMs,
    provenance: Object.freeze({ ...master.provenance }),
    cost: Object.freeze({ ...master.cost }),
    critic: Object.freeze({ ...master.critic }),
    lineage: [...master.lineage],
    createdAt: master.createdAt,
    masterHash: master.masterHash,
  })
}

/**
 * The lineage view answers one question: which exact bytes, in which roles,
 * from which approved generations and which provider run compose this master.
 * Artifacts are keyed by role so a consumer never has to scan an array to find
 * the audio that governs the timeline.
 */
export function presentMasterLineage(
  value: Readonly<PersistedSyntheticMasterAsset> | Readonly<SyntheticMasterAsset>,
) {
  const master = 'master' in value ? value.master : value
  return Object.freeze({
    masterId: master.id,
    masterHash: master.masterHash,
    projectId: master.projectId,
    projectVersionId: master.projectVersionId,
    profileId: master.profileId,
    profileSnapshotId: master.profileSnapshotId,
    profileVersion: master.profileVersion,
    locale: master.locale,
    durationMs: master.durationMs,
    scriptHash: master.scriptHash,
    alignmentHash: master.alignmentHash,
    consentSnapshotHash: master.consentSnapshotHash,
    authorizationHash: master.authorizationHash,
    rightsSnapshotId: master.rightsSnapshotId,
    artifacts: Object.freeze(Object.fromEntries(
      master.artifacts.map((artifact) => [artifact.role, presentArtifactRef(artifact)]),
    )),
    lineage: [...master.lineage],
    provenance: Object.freeze({ ...master.provenance }),
    cost: Object.freeze({ ...master.cost }),
    critic: Object.freeze({ ...master.critic }),
    createdAt: master.createdAt,
  })
}

export function presentSyntheticSpeechSegment(segment: Readonly<SyntheticSpeechSegment>) {
  return Object.freeze({
    schemaVersion: segment.schemaVersion,
    id: segment.id,
    workspaceId: segment.workspaceId,
    projectId: segment.projectId,
    masterId: segment.masterId,
    masterHash: segment.masterHash,
    blockId: segment.blockId,
    occurrence: segment.occurrence,
    sequence: segment.sequence,
    audioArtifactId: segment.audioArtifactId,
    videoArtifactId: segment.videoArtifactId,
    alignmentArtifactId: segment.alignmentArtifactId,
    exactText: segment.exactText,
    normalizedText: segment.normalizedText,
    scriptHash: segment.scriptHash,
    words: segment.words.map((word) =>
      Object.freeze({ word: word.word, startMs: word.startMs, endMs: word.endMs })),
    startMs: segment.startMs,
    endMs: segment.endMs,
    locale: segment.locale,
    identity: Object.freeze({ ...segment.identity }),
    consentSnapshotHash: segment.consentSnapshotHash,
    rightsSnapshotId: segment.rightsSnapshotId,
    criticReportId: segment.criticReportId,
    criticReportHash: segment.criticReportHash,
    createdAt: segment.createdAt,
    segmentHash: segment.segmentHash,
  })
}
