import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const SPEAKER_DIARIZATION_SCHEMA_VERSION =
  'speaker-diarization-run/v1' as const
export const SPEAKER_DIARIZATION_POLICY_VERSION =
  'anonymous-speaker-clusters/v1' as const

export interface SpeakerDiarizationSegment {
  id: string
  ordinal: number
  providerSegmentId: string
  providerLabel: string
  speakerKey: string
  startMs: number
  endMs: number
  text: string
  textHash: string
  segmentHash: string
}

export interface SpeakerDiarizationRun {
  schemaVersion: typeof SPEAKER_DIARIZATION_SCHEMA_VERSION
  policyVersion: typeof SPEAKER_DIARIZATION_POLICY_VERSION
  id: string
  workspaceId: string
  projectId: string
  workflowId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  durationMs: number
  providerInput: Readonly<{
    sha256: string
    byteSize: number
    durationMs: number
    preparation: Readonly<{
      toolId: string
      toolVersion: string
      configurationHash: string
    }>
  }>
  provider: Readonly<{
    id: string
    model: string
    version: string
  }>
  segments: readonly Readonly<SpeakerDiarizationSegment>[]
  speakerCount: number
  segmentCount: number
  usageSeconds: number
  costMinorUnits: number
  elapsedMs: number
  identityResolved: false
  physicalMaterialized: false
  requestFingerprint: string
  idempotencyKey: string
  createdByClientId: string
  createdAt: string
  runHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const PROVIDER_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HASH = /^[a-f0-9]{64}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function token(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && TOKEN.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      Number(value) >= minimum &&
      Number(value) <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be an integer between ${minimum} and ${maximum}`,
  )
  return Number(value)
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical UTC instant`,
  )
  return value
}

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY.test(value.trim()),
    'INVALID_ARGUMENT',
    'idempotencyKey is invalid',
  )
  return value.trim()
}

function normalizeText(value: unknown, field: string): string {
  const text = typeof value === 'string'
    ? value.trim().replace(/\s+/gu, ' ')
    : ''
  assertDomain(
    text.length >= 1 && text.length <= 10_000,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return text
}

function calculateSpeakerKey(input: {
  sourceArtifactSha256: string
  provider: Readonly<{ id: string; model: string; version: string }>
  providerLabel: string
}): string {
  return `speaker-cluster-${calculateCanonicalHash(input).slice(0, 40)}`
}

function createSegment(input: {
  sourceArtifactSha256: string
  provider: Readonly<{ id: string; model: string; version: string }>
  durationMs: number
  ordinal: number
  providerSegmentId: unknown
  providerLabel: unknown
  startMs: unknown
  endMs: unknown
  text: unknown
}): Readonly<SpeakerDiarizationSegment> {
  const providerSegmentId = identity(
    input.providerSegmentId,
    `segments[${input.ordinal}].providerSegmentId`,
  )
  const providerLabel =
    typeof input.providerLabel === 'string'
      ? input.providerLabel.trim()
      : ''
  assertDomain(
    PROVIDER_LABEL.test(providerLabel),
    'INVALID_ARGUMENT',
    `segments[${input.ordinal}].providerLabel is invalid`,
  )
  const startMs = integer(
    input.startMs,
    `segments[${input.ordinal}].startMs`,
    0,
    input.durationMs - 1,
  )
  const endMs = integer(
    input.endMs,
    `segments[${input.ordinal}].endMs`,
    startMs + 1,
    input.durationMs,
  )
  const text = normalizeText(
    input.text,
    `segments[${input.ordinal}].text`,
  )
  const textHash = calculateCanonicalHash(text)
  const speakerKey = calculateSpeakerKey({
    sourceArtifactSha256: input.sourceArtifactSha256,
    provider: input.provider,
    providerLabel,
  })
  const body = Object.freeze({
    id: `diarization-segment-${calculateCanonicalHash({
      sourceArtifactSha256: input.sourceArtifactSha256,
      provider: input.provider,
      providerSegmentId,
      providerLabel,
      startMs,
      endMs,
      textHash,
    }).slice(0, 40)}`,
    ordinal: input.ordinal,
    providerSegmentId,
    providerLabel,
    speakerKey,
    startMs,
    endMs,
    text,
    textHash,
  })
  return Object.freeze({
    ...body,
    segmentHash: calculateCanonicalHash(body),
  })
}

export function createSpeakerDiarizationRun(input: {
  id: string
  workspaceId: string
  projectId: string
  workflowId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  durationMs: number
  providerInput: Readonly<{
    sha256: string
    byteSize: number
    durationMs: number
    preparation: Readonly<{
      toolId: string
      toolVersion: string
      configurationHash: string
    }>
  }>
  provider: Readonly<{
    id: string
    model: string
    version: string
  }>
  segments: readonly Readonly<{
    providerSegmentId: string
    providerLabel: string
    startMs: number
    endMs: number
    text: string
  }>[]
  usageSeconds: number
  costMinorUnits: number
  elapsedMs: number
  requestFingerprint: string
  idempotencyKey: string
  createdByClientId: string
  createdAt: string
}): Readonly<SpeakerDiarizationRun> {
  const sourceArtifactSha256 = hash(
    input.sourceArtifactSha256,
    'sourceArtifactSha256',
  )
  const durationMs = integer(
    input.durationMs,
    'durationMs',
    1_000,
    43_200_000,
  )
  const providerInput = Object.freeze({
    sha256: hash(
      input.providerInput?.sha256,
      'providerInput.sha256',
    ),
    byteSize: integer(
      input.providerInput?.byteSize,
      'providerInput.byteSize',
      1,
      512 * 1024 * 1024,
    ),
    durationMs: integer(
      input.providerInput?.durationMs,
      'providerInput.durationMs',
      1_000,
      43_200_000,
    ),
    preparation: Object.freeze({
      toolId: token(
        input.providerInput?.preparation?.toolId,
        'providerInput.preparation.toolId',
      ),
      toolVersion: token(
        input.providerInput?.preparation?.toolVersion,
        'providerInput.preparation.toolVersion',
      ),
      configurationHash: hash(
        input.providerInput?.preparation?.configurationHash,
        'providerInput.preparation.configurationHash',
      ),
    }),
  })
  assertDomain(
    Math.abs(providerInput.durationMs - durationMs) <= 3_000,
    'INVALID_ARGUMENT',
    'providerInput.durationMs is not aligned to the source duration',
  )
  const provider = Object.freeze({
    id: token(input.provider?.id, 'provider.id'),
    model: token(input.provider?.model, 'provider.model'),
    version: token(input.provider?.version, 'provider.version'),
  })
  assertDomain(
    Array.isArray(input.segments) &&
      input.segments.length >= 1 &&
      input.segments.length <= 100_000,
    'INVALID_ARGUMENT',
    'Diarization requires 1 to 100000 speaker segments',
  )
  let previousStartMs = 0
  const providerSegmentIds = new Set<string>()
  const segments = Object.freeze(input.segments.map(
    (segment, ordinal) => {
      const normalized = createSegment({
        sourceArtifactSha256,
        provider,
        durationMs,
        ordinal,
        ...segment,
      })
      assertDomain(
        (ordinal === 0 || normalized.startMs >= previousStartMs) &&
          !providerSegmentIds.has(normalized.providerSegmentId),
        'INVALID_ARGUMENT',
        'Diarization segments must be ordered with unique provider IDs',
      )
      previousStartMs = normalized.startMs
      providerSegmentIds.add(normalized.providerSegmentId)
      return normalized
    },
  ))
  const speakerCount = new Set(
    segments.map((segment) => segment.speakerKey),
  ).size
  const body = Object.freeze({
    schemaVersion: SPEAKER_DIARIZATION_SCHEMA_VERSION,
    policyVersion: SPEAKER_DIARIZATION_POLICY_VERSION,
    id: identity(input.id, 'id'),
    workspaceId: identity(input.workspaceId, 'workspaceId'),
    projectId: identity(input.projectId, 'projectId'),
    workflowId: identity(input.workflowId, 'workflowId'),
    sourceArtifactId: identity(
      input.sourceArtifactId,
      'sourceArtifactId',
    ),
    sourceArtifactSha256,
    sourceManifestId: identity(
      input.sourceManifestId,
      'sourceManifestId',
    ),
    sourceManifestHash: hash(
      input.sourceManifestHash,
      'sourceManifestHash',
    ),
    sourceTranscriptId: identity(
      input.sourceTranscriptId,
      'sourceTranscriptId',
    ),
    sourceTranscriptHash: hash(
      input.sourceTranscriptHash,
      'sourceTranscriptHash',
    ),
    durationMs,
    providerInput,
    provider,
    segments,
    speakerCount,
    segmentCount: segments.length,
    usageSeconds: integer(
      input.usageSeconds,
      'usageSeconds',
      1,
      43_200,
    ),
    costMinorUnits: integer(
      input.costMinorUnits,
      'costMinorUnits',
      0,
      10_000_000,
    ),
    elapsedMs: integer(
      input.elapsedMs,
      'elapsedMs',
      0,
      86_400_000,
    ),
    identityResolved: false as const,
    physicalMaterialized: false as const,
    requestFingerprint: hash(
      input.requestFingerprint,
      'requestFingerprint',
    ),
    idempotencyKey: idempotencyKey(input.idempotencyKey),
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt: instant(input.createdAt, 'createdAt'),
  })
  return Object.freeze({
    ...body,
    runHash: calculateCanonicalHash(body),
  })
}

export function hydrateSpeakerDiarizationRun(
  value: unknown,
): Readonly<SpeakerDiarizationRun> {
  assertDomain(
    typeof value === 'object' && value !== null,
    'PERSISTENCE_CONFLICT',
    'Stored speaker diarization run is invalid',
  )
  const stored = value as SpeakerDiarizationRun
  assertDomain(
    stored.schemaVersion === SPEAKER_DIARIZATION_SCHEMA_VERSION &&
      stored.policyVersion === SPEAKER_DIARIZATION_POLICY_VERSION,
    'PERSISTENCE_CONFLICT',
    'Stored speaker diarization version is invalid',
  )
  const hydrated = createSpeakerDiarizationRun({
    id: stored.id,
    workspaceId: stored.workspaceId,
    projectId: stored.projectId,
    workflowId: stored.workflowId,
    sourceArtifactId: stored.sourceArtifactId,
    sourceArtifactSha256: stored.sourceArtifactSha256,
    sourceManifestId: stored.sourceManifestId,
    sourceManifestHash: stored.sourceManifestHash,
    sourceTranscriptId: stored.sourceTranscriptId,
    sourceTranscriptHash: stored.sourceTranscriptHash,
    durationMs: stored.durationMs,
    providerInput: stored.providerInput,
    provider: stored.provider,
    segments: stored.segments.map((segment) => ({
      providerSegmentId: segment.providerSegmentId,
      providerLabel: segment.providerLabel,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text,
    })),
    usageSeconds: stored.usageSeconds,
    costMinorUnits: stored.costMinorUnits,
    elapsedMs: stored.elapsedMs,
    requestFingerprint: stored.requestFingerprint,
    idempotencyKey: stored.idempotencyKey,
    createdByClientId: stored.createdByClientId,
    createdAt: stored.createdAt,
  })
  assertDomain(
    stableSerialize(hydrated) === stableSerialize(stored),
    'PERSISTENCE_CONFLICT',
    'Stored speaker diarization run failed integrity validation',
  )
  return hydrated
}
