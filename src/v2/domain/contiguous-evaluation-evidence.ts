import { calculateCanonicalHash } from './canonical-hash.ts'
import type {
  ContiguousEvaluationProducer,
  ContiguousQualityDimension,
} from './contiguous-extraction.ts'
import { assertDomain } from './errors.ts'

export type ContiguousEvaluationEvidenceKind =
  | 'transcript-boundary'
  | 'transcript-density'
  | 'rights-integrity'
  | 'audio-analysis'
  | 'visual-analysis'

export interface ContiguousEvaluationEvidence {
  id: string
  sourceIndexRunId: string
  sourceIndexRunHash: string
  sourceMomentId: string
  sourceMomentHash: string
  kind: ContiguousEvaluationEvidenceKind
  dimensions: readonly ContiguousQualityDimension[]
  rangeMs: readonly [number, number]
  producer: Readonly<ContiguousEvaluationProducer>
  evidenceHash: string
  facts: Readonly<Record<string, string | number | boolean>>
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const FACT = /^[a-z][A-Za-z0-9._-]{0,63}$/
const ALLOWED_DIMENSIONS = Object.freeze({
  'transcript-boundary': Object.freeze([
    'selfContained',
    'integrity',
  ] as const),
  'transcript-density': Object.freeze(['density'] as const),
  'rights-integrity': Object.freeze(['integrity'] as const),
  'audio-analysis': Object.freeze(['audio'] as const),
  'visual-analysis': Object.freeze(['visual'] as const),
}) satisfies Readonly<Record<
  ContiguousEvaluationEvidenceKind,
  readonly ContiguousQualityDimension[]
>>

function identity(value: string, field: string): string {
  const normalized = value?.trim()
  assertDomain(
    ID.test(normalized),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function hash(value: string, field: string): string {
  assertDomain(
    HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function producer(
  value: Readonly<ContiguousEvaluationProducer>,
) {
  const normalized = Object.freeze({
    provider: value?.provider?.trim(),
    model: value?.model?.trim(),
    version: value?.version?.trim(),
    inputHash: value?.inputHash,
    outputHash: value?.outputHash,
  })
  assertDomain(
    TOKEN.test(normalized.provider) &&
      TOKEN.test(normalized.model) &&
      TOKEN.test(normalized.version) &&
      HASH.test(normalized.inputHash) &&
      HASH.test(normalized.outputHash),
    'INVALID_ARGUMENT',
    'producer is invalid',
  )
  return normalized
}

export function createContiguousEvaluationEvidence(
  input: Omit<ContiguousEvaluationEvidence, 'evidenceHash'>,
): Readonly<ContiguousEvaluationEvidence> {
  const kind = input.kind
  const allowed = ALLOWED_DIMENSIONS[kind]
  assertDomain(
    Array.isArray(allowed),
    'INVALID_ARGUMENT',
    'kind is invalid',
  )
  const dimensions = [...input.dimensions]
  assertDomain(
    dimensions.length > 0 &&
      dimensions.length <= allowed.length &&
      new Set(dimensions).size === dimensions.length &&
      dimensions.every((dimension) => allowed.includes(dimension)),
    'INVALID_ARGUMENT',
    'dimensions are invalid for evidence kind',
  )
  assertDomain(
    Array.isArray(input.rangeMs) &&
      input.rangeMs.length === 2 &&
      Number.isSafeInteger(input.rangeMs[0]) &&
      Number.isSafeInteger(input.rangeMs[1]) &&
      input.rangeMs[0] >= 0 &&
      input.rangeMs[1] > input.rangeMs[0] &&
      input.rangeMs[1] <= 43_200_000,
    'INVALID_ARGUMENT',
    'rangeMs is invalid',
  )
  assertDomain(
    typeof input.facts === 'object' &&
      input.facts !== null &&
      !Array.isArray(input.facts),
    'INVALID_ARGUMENT',
    'facts are invalid',
  )
  const factEntries = Object.entries(input.facts)
  assertDomain(
    factEntries.length > 0 &&
      factEntries.length <= 32 &&
      factEntries.every(([key, value]) =>
        FACT.test(key) &&
        (
          typeof value === 'boolean' ||
          typeof value === 'number' && Number.isFinite(value) ||
          typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 1_000
        ),
      ),
    'INVALID_ARGUMENT',
    'facts are invalid',
  )
  const body = Object.freeze({
    schemaVersion: 'contiguous-evaluation-evidence/v1',
    policyVersion: 'contiguous-extraction/v1',
    id: identity(input.id, 'id'),
    sourceIndexRunId: identity(
      input.sourceIndexRunId,
      'sourceIndexRunId',
    ),
    sourceIndexRunHash: hash(
      input.sourceIndexRunHash,
      'sourceIndexRunHash',
    ),
    sourceMomentId: identity(
      input.sourceMomentId,
      'sourceMomentId',
    ),
    sourceMomentHash: hash(
      input.sourceMomentHash,
      'sourceMomentHash',
    ),
    kind,
    dimensions: Object.freeze(dimensions),
    rangeMs: Object.freeze([...input.rangeMs]) as
      readonly [number, number],
    producer: producer(input.producer),
    facts: Object.freeze(Object.fromEntries(
      factEntries.toSorted(([left], [right]) =>
        left.localeCompare(right)),
    )),
  })
  return Object.freeze({
    ...body,
    evidenceHash: calculateCanonicalHash(body),
  })
}
