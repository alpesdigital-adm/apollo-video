import type {
  HierarchicalProcessingBudget,
  PersistedHierarchicalProcessingRun,
} from '../application/ports/hierarchical-processing-repository.ts'
import { DomainError } from '../domain/errors.ts'
import {
  HIERARCHICAL_CHUNK_POLICY_VERSION,
  HIERARCHICAL_PROCESSING_POLICY_VERSION,
  HIERARCHICAL_PROCESSING_TIERS,
} from '../domain/hierarchical-processing.ts'

const BODY_FIELDS = new Set([
  'sourceArtifactId',
  'expectedArtifactSha256',
  'sourceManifestId',
  'expectedManifestHash',
  'sourceTranscriptId',
  'expectedTranscriptHash',
  'processingPolicyVersion',
  'chunking',
  'tierVersions',
  'previousRun',
  'budget',
])
const CHUNKING_FIELDS = new Set([
  'policyVersion',
  'chunkDurationMs',
  'overlapMs',
])
const TIER_VERSION_FIELDS = new Set([
  'provider',
  'model',
  'version',
])
const PREVIOUS_RUN_FIELDS = new Set(['id', 'expectedRunHash'])
const BUDGET_FIELDS = new Set([
  'currency',
  'maxCostMinorUnits',
  'maxWorkingSetBytes',
  'maxElapsedMs',
])

function record(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an object`,
    )
  }
  return value as Record<string, unknown>
}

function exactFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
) {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} contains an unsupported field`,
    )
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number') {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value
}

export function parseHierarchicalProcessingBody(value: unknown) {
  const body = record(value, 'Request body')
  exactFields(body, BODY_FIELDS, 'Request body')
  const chunking = record(body.chunking, 'chunking')
  exactFields(chunking, CHUNKING_FIELDS, 'chunking')
  const rawTierVersions = record(
    body.tierVersions,
    'tierVersions',
  )
  if (
    Object.keys(rawTierVersions).length !==
      HIERARCHICAL_PROCESSING_TIERS.length ||
    HIERARCHICAL_PROCESSING_TIERS.some(
      (tier) => !(tier in rawTierVersions),
    )
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'tierVersions must define every processing tier',
    )
  }
  const tierVersions = Object.fromEntries(
    HIERARCHICAL_PROCESSING_TIERS.map((tier) => {
      const version = record(
        rawTierVersions[tier],
        `tierVersions.${tier}`,
      )
      exactFields(
        version,
        TIER_VERSION_FIELDS,
        `tierVersions.${tier}`,
      )
      return [
        tier,
        {
          provider: string(
            version.provider,
            `tierVersions.${tier}.provider`,
          ),
          model: string(
            version.model,
            `tierVersions.${tier}.model`,
          ),
          version: string(
            version.version,
            `tierVersions.${tier}.version`,
          ),
        },
      ]
    }),
  )
  const budget = record(body.budget, 'budget')
  exactFields(budget, BUDGET_FIELDS, 'budget')
  const parsedBudget: HierarchicalProcessingBudget = {
    currency: string(budget.currency, 'budget.currency') as 'USD',
    maxCostMinorUnits: number(
      budget.maxCostMinorUnits,
      'budget.maxCostMinorUnits',
    ),
    maxWorkingSetBytes: number(
      budget.maxWorkingSetBytes,
      'budget.maxWorkingSetBytes',
    ),
    maxElapsedMs: number(
      budget.maxElapsedMs,
      'budget.maxElapsedMs',
    ),
  }
  let previousRun:
    | Readonly<{ id: string; expectedRunHash: string }>
    | undefined
  if (body.previousRun !== undefined) {
    const previous = record(body.previousRun, 'previousRun')
    exactFields(previous, PREVIOUS_RUN_FIELDS, 'previousRun')
    previousRun = {
      id: string(previous.id, 'previousRun.id'),
      expectedRunHash: string(
        previous.expectedRunHash,
        'previousRun.expectedRunHash',
      ),
    }
  }
  return {
    sourceArtifactId: string(
      body.sourceArtifactId,
      'sourceArtifactId',
    ),
    expectedArtifactSha256: string(
      body.expectedArtifactSha256,
      'expectedArtifactSha256',
    ),
    sourceManifestId: string(
      body.sourceManifestId,
      'sourceManifestId',
    ),
    expectedManifestHash: string(
      body.expectedManifestHash,
      'expectedManifestHash',
    ),
    sourceTranscriptId: string(
      body.sourceTranscriptId,
      'sourceTranscriptId',
    ),
    expectedTranscriptHash: string(
      body.expectedTranscriptHash,
      'expectedTranscriptHash',
    ),
    processingPolicyVersion: string(
      body.processingPolicyVersion,
      'processingPolicyVersion',
    ),
    chunking: {
      policyVersion: string(
        chunking.policyVersion,
        'chunking.policyVersion',
      ),
      chunkDurationMs: number(
        chunking.chunkDurationMs,
        'chunking.chunkDurationMs',
      ),
      overlapMs: number(
        chunking.overlapMs,
        'chunking.overlapMs',
      ),
    },
    tierVersions,
    ...(previousRun ? { previousRun } : {}),
    budget: parsedBudget,
  }
}

export function presentHierarchicalProcessingRun(
  run: Readonly<PersistedHierarchicalProcessingRun>,
) {
  const {
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    authenticationAudit: _authenticationAudit,
    provenance: _provenance,
    evidenceSpans,
    ...publicRun
  } = run
  return Object.freeze({
    ...publicRun,
    processingPolicyVersion:
      HIERARCHICAL_PROCESSING_POLICY_VERSION,
    chunkPolicyVersion: HIERARCHICAL_CHUNK_POLICY_VERSION,
    evidenceSpans: Object.freeze(evidenceSpans.map((span) => {
      const { text: _text, ...publicSpan } = span
      return Object.freeze(publicSpan)
    })),
  })
}
