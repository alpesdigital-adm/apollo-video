import type {
  LongFormIndexWorkflowPage,
  PersistedLongFormIndexWorkflow,
} from '../application/ports/long-form-index-workflow-repository.ts'
import { DomainError } from '../domain/errors.ts'
import {
  LONG_FORM_INDEX_STAGES,
  type LongFormIndexStage,
  type LongFormIndexStageBudget,
  type LongFormIndexStageVersion,
} from '../domain/long-form-index-workflow.ts'
import { presentPublicOperationV2 } from './presenters.ts'

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
  allowed: readonly string[],
  field: string,
) {
  const unknown = Object.keys(value).filter(
    (key) => !allowed.includes(key),
  )
  if (unknown.length > 0) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} contains unknown fields`,
      { fields: unknown },
    )
  }
}

function string(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < minimum ||
    value.trim().length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain ${minimum} to ${maximum} characters`,
    )
  }
  return value.trim()
}

function sha256(value: unknown, field: string): string {
  const normalized = string(value, field, 64, 64)
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be a lowercase SHA-256`,
    )
  }
  return normalized
}

function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an integer between ${minimum} and ${maximum}`,
    )
  }
  return Number(value)
}

function version(
  value: unknown,
  field: string,
): Readonly<LongFormIndexStageVersion> {
  const body = record(value, field)
  exactFields(body, ['provider', 'model', 'version'], field)
  return Object.freeze({
    provider: string(body.provider, `${field}.provider`, 1, 128),
    model: string(body.model, `${field}.model`, 1, 128),
    version: string(body.version, `${field}.version`, 1, 128),
  })
}

function stageBudget(
  value: unknown,
  field: string,
): Readonly<LongFormIndexStageBudget> {
  const body = record(value, field)
  exactFields(
    body,
    [
      'estimatedCostMinorUnits',
      'maximumCostMinorUnits',
      'maximumElapsedMs',
    ],
    field,
  )
  const estimatedCostMinorUnits = integer(
    body.estimatedCostMinorUnits,
    `${field}.estimatedCostMinorUnits`,
    0,
    10_000_000,
  )
  const maximumCostMinorUnits = integer(
    body.maximumCostMinorUnits,
    `${field}.maximumCostMinorUnits`,
    0,
    10_000_000,
  )
  if (estimatedCostMinorUnits > maximumCostMinorUnits) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} estimate exceeds its maximum`,
    )
  }
  return Object.freeze({
    estimatedCostMinorUnits,
    maximumCostMinorUnits,
    maximumElapsedMs: integer(
      body.maximumElapsedMs,
      `${field}.maximumElapsedMs`,
      1,
      86_400_000,
    ),
  })
}

function stageMap<T>(
  value: unknown,
  field: string,
  parse: (value: unknown, field: string) => T,
): Readonly<Record<LongFormIndexStage, T>> {
  const body = record(value, field)
  exactFields(body, LONG_FORM_INDEX_STAGES, field)
  if (
    !LONG_FORM_INDEX_STAGES.every((stage) =>
      Object.hasOwn(body, stage))
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must define every long-form stage`,
    )
  }
  return Object.freeze(Object.fromEntries(
    LONG_FORM_INDEX_STAGES.map((stage) => [
      stage,
      parse(body[stage], `${field}.${stage}`),
    ]),
  ) as Record<LongFormIndexStage, T>)
}

export function parseCreateLongFormIndexWorkflowBody(
  raw: unknown,
) {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'sourceArtifactId',
      'expectedArtifactSha256',
      'sourceManifestId',
      'expectedManifestHash',
      'sourceTranscript',
      'policyVersion',
      'versions',
      'stageBudgets',
      'budget',
    ],
    'body',
  )
  const transcript = body.sourceTranscript === undefined
    ? undefined
    : record(body.sourceTranscript, 'sourceTranscript')
  if (transcript) {
    exactFields(
      transcript,
      ['id', 'expectedHash'],
      'sourceTranscript',
    )
  }
  const budget = record(body.budget, 'budget')
  exactFields(
    budget,
    [
      'currency',
      'maximumCostMinorUnits',
      'maximumElapsedMs',
      'maximumConcurrency',
    ],
    'budget',
  )
  if (budget.currency !== 'USD') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'budget.currency must be USD',
    )
  }
  return Object.freeze({
    sourceArtifactId: string(
      body.sourceArtifactId,
      'sourceArtifactId',
      3,
      128,
    ),
    expectedArtifactSha256: sha256(
      body.expectedArtifactSha256,
      'expectedArtifactSha256',
    ),
    sourceManifestId: string(
      body.sourceManifestId,
      'sourceManifestId',
      3,
      128,
    ),
    expectedManifestHash: sha256(
      body.expectedManifestHash,
      'expectedManifestHash',
    ),
    ...(transcript
      ? {
          sourceTranscriptId: string(
            transcript.id,
            'sourceTranscript.id',
            3,
            128,
          ),
          expectedTranscriptHash: sha256(
            transcript.expectedHash,
            'sourceTranscript.expectedHash',
          ),
        }
      : {}),
    policyVersion: string(
      body.policyVersion,
      'policyVersion',
      3,
      64,
    ),
    versions: stageMap(body.versions, 'versions', version),
    stageBudgets: stageMap(
      body.stageBudgets,
      'stageBudgets',
      stageBudget,
    ),
    budget: Object.freeze({
      currency: 'USD' as const,
      maximumCostMinorUnits: integer(
        budget.maximumCostMinorUnits,
        'budget.maximumCostMinorUnits',
        0,
        10_000_000,
      ),
      maximumElapsedMs: integer(
        budget.maximumElapsedMs,
        'budget.maximumElapsedMs',
        1,
        86_400_000,
      ),
      maximumConcurrency: integer(
        budget.maximumConcurrency,
        'budget.maximumConcurrency',
        1,
        32,
      ),
    }),
  })
}

export function presentLongFormIndexWorkflow(
  value: Readonly<PersistedLongFormIndexWorkflow>,
) {
  return Object.freeze({
    workflow: value.workflow,
    operation: presentPublicOperationV2(value.operation, {
      includeProjectId: true,
    }),
  })
}

export function presentLongFormIndexWorkflowPage(
  value: Readonly<LongFormIndexWorkflowPage>,
) {
  return Object.freeze({
    workflows: Object.freeze(
      value.workflows.map(presentLongFormIndexWorkflow),
    ),
    ...(value.nextCursor
      ? { nextCursor: value.nextCursor }
      : {}),
  })
}
