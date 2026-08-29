import type { Prisma, PrismaClient } from '../../../../generated/prisma-v2/index.js'

import {
  PROVIDER_RESULT_ARTIFACT_ROLES,
  PROVIDER_RESULT_ARTIFACT_SCHEMA_VERSION,
  type ProviderResultArtifactRecord,
  type ProviderResultArtifactRepository,
  type ProviderResultArtifactRole,
} from '../../application/ports/provider-result-artifact-repository.ts'
import { DomainError, assertDomain } from '../../domain/errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const PROVIDER_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/

type ProviderResultArtifactRow = {
  id: string
  workspaceId: string
  projectId: string
  jobId: string
  schemaVersion: string
  role: string
  providerJobRef: string
  artifactId: string
  artifactSha256: string
  byteSize: bigint
  mediaType: string
  container: string
  adapterId: string
  adapterVersion: string
  modelRef: string | null
  adapterConfigHash: string
  inputHash: string
  authorizationHash: string
  scriptHash: string | null
  observedCostCurrency: string | null
  observedCostMinorUnits: number | null
  completedAt: Date
  createdAt: Date
}

function assertRecord(record: Readonly<ProviderResultArtifactRecord>): void {
  assertDomain(record.schemaVersion === PROVIDER_RESULT_ARTIFACT_SCHEMA_VERSION, 'INVALID_ARGUMENT', 'Provider result artifact schema version is invalid')
  for (const [field, value] of Object.entries({ id: record.id, workspaceId: record.workspaceId, projectId: record.projectId, jobId: record.jobId, artifactId: record.artifactId, adapterId: record.adapterId, adapterVersion: record.adapterVersion })) {
    assertDomain(ID.test(value), 'INVALID_ARGUMENT', `Provider result artifact ${field} is invalid`)
  }
  assertDomain(PROVIDER_RESULT_ARTIFACT_ROLES.includes(record.role), 'INVALID_ARGUMENT', 'Provider result artifact role is invalid')
  assertDomain(PROVIDER_REF.test(record.providerJobRef), 'INVALID_ARGUMENT', 'Provider result artifact providerJobRef is invalid')
  assertDomain(HASH.test(record.artifactSha256) && HASH.test(record.adapterConfigHash) && HASH.test(record.inputHash) && HASH.test(record.authorizationHash), 'INVALID_ARGUMENT', 'Provider result artifact hashes are invalid')
  if (record.scriptHash !== undefined) assertDomain(HASH.test(record.scriptHash), 'INVALID_ARGUMENT', 'Provider result artifact scriptHash is invalid')
  assertDomain(Number.isSafeInteger(record.byteSize) && record.byteSize > 0, 'INVALID_ARGUMENT', 'Provider result artifact byteSize is invalid')
  const mediaByRole: Record<ProviderResultArtifactRole, string> = { 'primary-audio': 'audio', 'primary-video': 'video', 'alignment-evidence': 'data' }
  assertDomain(record.mediaType === mediaByRole[record.role], 'INVALID_ARGUMENT', 'Provider result artifact media type does not match its role')
  if (record.observedCost) {
    assertDomain(/^[A-Z]{3}$/.test(record.observedCost.currency) && Number.isSafeInteger(record.observedCost.costMinorUnits) && record.observedCost.costMinorUnits >= 0, 'INVALID_ARGUMENT', 'Provider result artifact observed cost is invalid')
  }
  assertDomain(Number.isFinite(Date.parse(record.completedAt)) && Number.isFinite(Date.parse(record.createdAt)), 'INVALID_ARGUMENT', 'Provider result artifact timestamps are invalid')
}

function toRecord(row: ProviderResultArtifactRow): Readonly<ProviderResultArtifactRecord> {
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    jobId: row.jobId,
    schemaVersion: PROVIDER_RESULT_ARTIFACT_SCHEMA_VERSION,
    role: row.role as ProviderResultArtifactRole,
    providerJobRef: row.providerJobRef,
    artifactId: row.artifactId,
    artifactSha256: row.artifactSha256,
    byteSize: Number(row.byteSize),
    mediaType: row.mediaType as 'audio' | 'video' | 'data',
    container: row.container,
    adapterId: row.adapterId,
    adapterVersion: row.adapterVersion,
    ...(row.modelRef === null ? {} : { modelRef: row.modelRef }),
    adapterConfigHash: row.adapterConfigHash,
    inputHash: row.inputHash,
    authorizationHash: row.authorizationHash,
    ...(row.scriptHash === null ? {} : { scriptHash: row.scriptHash }),
    ...(row.observedCostCurrency === null || row.observedCostMinorUnits === null
      ? {}
      : { observedCost: Object.freeze({ currency: row.observedCostCurrency, costMinorUnits: row.observedCostMinorUnits }) }),
    completedAt: row.completedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  })
}

function contentIdentity(record: Readonly<Pick<ProviderResultArtifactRecord, 'artifactId' | 'artifactSha256' | 'providerJobRef'>>): string {
  return `${record.providerJobRef}:${record.artifactId}:${record.artifactSha256}`
}

export class PrismaProviderResultArtifactRepository implements ProviderResultArtifactRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async persistOrReplay(input: { records: readonly Readonly<ProviderResultArtifactRecord>[] }) {
    assertDomain(input.records.length > 0, 'INVALID_ARGUMENT', 'Provider result artifact set cannot be empty')
    const [first] = input.records
    for (const record of input.records) {
      assertRecord(record)
      assertDomain(record.workspaceId === first!.workspaceId && record.projectId === first!.projectId && record.jobId === first!.jobId, 'INVALID_ARGUMENT', 'Provider result artifacts must belong to one job')
    }
    assertDomain(new Set(input.records.map(({ role }) => role)).size === input.records.length, 'INVALID_ARGUMENT', 'Provider result artifact roles must be unique per job')
    return this.client.$transaction(async (transaction: Prisma.TransactionClient) => {
      const existing = await transaction.v2ProviderResultArtifact.findMany({
        where: { workspaceId: first!.workspaceId, projectId: first!.projectId, jobId: first!.jobId },
        orderBy: { role: 'asc' },
      })
      if (existing.length > 0) {
        const byRole = new Map(existing.map((row: ProviderResultArtifactRow) => [row.role, row]))
        const replayMatches = input.records.length === existing.length && input.records.every((record) => {
          const row = byRole.get(record.role)
          return row !== undefined && contentIdentity(toRecord(row)) === contentIdentity(record)
        })
        if (!replayMatches) throw new DomainError('PERSISTENCE_CONFLICT', 'Provider result artifacts diverge from the previously persisted result')
        return Object.freeze({ records: existing.map(toRecord), replayed: true })
      }
      await transaction.v2ProviderResultArtifact.createMany({
        data: input.records.map((record) => ({
          id: record.id,
          workspaceId: record.workspaceId,
          projectId: record.projectId,
          jobId: record.jobId,
          schemaVersion: record.schemaVersion,
          role: record.role,
          providerJobRef: record.providerJobRef,
          artifactId: record.artifactId,
          artifactSha256: record.artifactSha256,
          byteSize: BigInt(record.byteSize),
          mediaType: record.mediaType,
          container: record.container,
          adapterId: record.adapterId,
          adapterVersion: record.adapterVersion,
          modelRef: record.modelRef ?? null,
          adapterConfigHash: record.adapterConfigHash,
          inputHash: record.inputHash,
          authorizationHash: record.authorizationHash,
          scriptHash: record.scriptHash ?? null,
          observedCostCurrency: record.observedCost?.currency ?? null,
          observedCostMinorUnits: record.observedCost?.costMinorUnits ?? null,
          completedAt: new Date(record.completedAt),
          createdAt: new Date(record.createdAt),
        })),
      })
      const persisted = await transaction.v2ProviderResultArtifact.findMany({
        where: { workspaceId: first!.workspaceId, projectId: first!.projectId, jobId: first!.jobId },
        orderBy: { role: 'asc' },
      })
      return Object.freeze({ records: persisted.map(toRecord), replayed: false })
    })
  }

  async listByJob(input: { workspaceId: string; projectId: string; jobId: string }) {
    const rows = await this.client.v2ProviderResultArtifact.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, jobId: input.jobId },
      orderBy: { role: 'asc' },
    })
    return rows.map(toRecord)
  }
}
