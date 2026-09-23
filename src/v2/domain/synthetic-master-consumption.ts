import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain, type DomainErrorCode } from './errors.ts'

export const SYNTHETIC_MASTER_CONSUMPTION_SCHEMA_VERSION =
  'synthetic-master-consumption/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

export interface SyntheticMasterConsumption {
  schemaVersion: typeof SYNTHETIC_MASTER_CONSUMPTION_SCHEMA_VERSION
  id: string
  workspaceId: string
  consumerProjectId: string
  consumerProjectVersionId: string
  productionRunId: string
  sourceMasterId: string
  sourceMasterHash: string
  sourceProjectId: string
  sourceProjectVersionId: string
  sourceProviderJobId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  cacheDecisionId: string
  cacheDecisionHash: string
  productionPlanHash: string
  observationOpenedAt: string
  createdAt: string
  consumptionHash: string
}

type SyntheticMasterConsumptionBody = Omit<SyntheticMasterConsumption, 'consumptionHash'>

const BODY_FIELDS = Object.freeze([
  'schemaVersion', 'id', 'workspaceId', 'consumerProjectId', 'consumerProjectVersionId',
  'productionRunId', 'sourceMasterId', 'sourceMasterHash', 'sourceProjectId',
  'sourceProjectVersionId', 'sourceProviderJobId', 'sourceArtifactId',
  'sourceArtifactSha256', 'cacheDecisionId', 'cacheDecisionHash', 'productionPlanHash',
  'observationOpenedAt', 'createdAt',
] as const)

function instant(value: string, field: string, code: DomainErrorCode): string {
  assertDomain(
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    code,
    `${field} must be a canonical ISO instant`,
  )
  return value
}

export function calculateSyntheticMasterConsumptionHash(
  consumption: Omit<SyntheticMasterConsumption, 'consumptionHash'> | SyntheticMasterConsumption,
): string {
  return calculateCanonicalHash(validateBody(consumption))
}

function validateBody(
  input: Omit<SyntheticMasterConsumption, 'schemaVersion' | 'consumptionHash'> |
    SyntheticMasterConsumptionBody |
    SyntheticMasterConsumption,
  code: DomainErrorCode = 'INVALID_ARGUMENT',
): Readonly<SyntheticMasterConsumptionBody> {
  if ('schemaVersion' in input) {
    assertDomain(
      input.schemaVersion === SYNTHETIC_MASTER_CONSUMPTION_SCHEMA_VERSION,
      'PERSISTENCE_CONFLICT',
      'synthetic master consumption schema version is not supported',
    )
  }
  for (const [field, value] of Object.entries({
    id: input.id,
    workspaceId: input.workspaceId,
    consumerProjectId: input.consumerProjectId,
    consumerProjectVersionId: input.consumerProjectVersionId,
    productionRunId: input.productionRunId,
    sourceMasterId: input.sourceMasterId,
    sourceProjectId: input.sourceProjectId,
    sourceProjectVersionId: input.sourceProjectVersionId,
    sourceProviderJobId: input.sourceProviderJobId,
    sourceArtifactId: input.sourceArtifactId,
    cacheDecisionId: input.cacheDecisionId,
  })) {
    assertDomain(ID.test(value), code, `synthetic master consumption ${field} is invalid`)
  }
  for (const [field, value] of Object.entries({
    sourceMasterHash: input.sourceMasterHash,
    sourceArtifactSha256: input.sourceArtifactSha256,
    cacheDecisionHash: input.cacheDecisionHash,
    productionPlanHash: input.productionPlanHash,
  })) {
    assertDomain(HASH.test(value), code, `synthetic master consumption ${field} is invalid`)
  }
  assertDomain(
    input.sourceProjectId !== input.consumerProjectId,
    code,
    'synthetic master consumption must cross project boundaries',
  )
  const observationOpenedAt = instant(input.observationOpenedAt, 'observationOpenedAt', code)
  const createdAt = instant(input.createdAt, 'createdAt', code)
  assertDomain(
    Date.parse(observationOpenedAt) <= Date.parse(createdAt),
    code,
    'synthetic master consumption observation cannot open after commit',
  )
  return Object.freeze({
    schemaVersion: SYNTHETIC_MASTER_CONSUMPTION_SCHEMA_VERSION,
    id: input.id,
    workspaceId: input.workspaceId,
    consumerProjectId: input.consumerProjectId,
    consumerProjectVersionId: input.consumerProjectVersionId,
    productionRunId: input.productionRunId,
    sourceMasterId: input.sourceMasterId,
    sourceMasterHash: input.sourceMasterHash,
    sourceProjectId: input.sourceProjectId,
    sourceProjectVersionId: input.sourceProjectVersionId,
    sourceProviderJobId: input.sourceProviderJobId,
    sourceArtifactId: input.sourceArtifactId,
    sourceArtifactSha256: input.sourceArtifactSha256,
    cacheDecisionId: input.cacheDecisionId,
    cacheDecisionHash: input.cacheDecisionHash,
    productionPlanHash: input.productionPlanHash,
    observationOpenedAt,
    createdAt,
  })
}

export function createSyntheticMasterConsumption(
  input: Omit<SyntheticMasterConsumption, 'schemaVersion' | 'consumptionHash'>,
): Readonly<SyntheticMasterConsumption> {
  const body = validateBody(input)
  return Object.freeze({
    ...body,
    consumptionHash: calculateSyntheticMasterConsumptionHash(body),
  })
}

export function assertSyntheticMasterConsumptionIntegrity(
  consumption: Readonly<SyntheticMasterConsumption>,
): Readonly<SyntheticMasterConsumption> {
  assertDomain(
    Object.keys(consumption).length === BODY_FIELDS.length + 1 &&
      Object.keys(consumption).every((field) => field === 'consumptionHash' || BODY_FIELDS.includes(field as typeof BODY_FIELDS[number])),
    'PERSISTENCE_CONFLICT',
    'synthetic master consumption contains unsupported fields',
  )
  validateBody(consumption, 'PERSISTENCE_CONFLICT')
  assertDomain(
    HASH.test(consumption.consumptionHash) &&
      calculateSyntheticMasterConsumptionHash(consumption) === consumption.consumptionHash,
    'PERSISTENCE_CONFLICT',
    'synthetic master consumption hash does not match its stored content',
  )
  return consumption
}
