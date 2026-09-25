import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import {
  PROVIDER_EXECUTION_RECEIPT_SCHEMA_VERSION,
  PROVIDER_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
  PROVIDER_TRANSPORT_OBSERVATION_SCHEMA_VERSION,
  type ProviderExecutionProvenanceRepository,
  type ProviderExecutionReceipt,
  type ProviderExecutionReceiptResult,
  type ProviderTransportEvidence,
} from '../../application/ports/provider-execution-provenance-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../../domain/errors.ts'
import { providerExecutionReceiptBody } from '../../application/provider-transport-observation.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const PROVIDER_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/
type EvidenceRow = Prisma.V2ProviderTransportEvidenceGetPayload<Record<string, never>>
type ReceiptRow = Prisma.V2ProviderExecutionReceiptGetPayload<{ include: typeof receiptInclude }>
type ResultRow = Prisma.V2ProviderResultArtifactGetPayload<Record<string, never>>

function observationBody(value: Readonly<ProviderTransportEvidence>) {
  return {
    schemaVersion: PROVIDER_TRANSPORT_OBSERVATION_SCHEMA_VERSION,
    phase: value.phase, runtimeClass: value.runtimeClass, adapterId: value.adapterId,
    adapterVersion: value.adapterVersion, adapterConfigHash: value.adapterConfigHash,
    endpointClass: value.endpointClass, method: value.method, requestHash: value.requestHash,
    responseHash: value.responseHash, responseStatus: value.responseStatus,
    ...(value.providerJobRef === undefined ? {} : { providerJobRef: value.providerJobRef }),
    observedAt: value.observedAt,
  }
}

function evidenceBody(value: Readonly<ProviderTransportEvidence>) {
  const { evidenceHash: _evidenceHash, ...body } = value
  return body
}

function assertEvidence(value: Readonly<ProviderTransportEvidence>): void {
  assertDomain(value.schemaVersion === PROVIDER_TRANSPORT_EVIDENCE_SCHEMA_VERSION, 'INVALID_ARGUMENT', 'Provider transport evidence schema is invalid')
  for (const id of [value.id, value.workspaceId, value.projectId, value.jobId, value.adapterId, value.adapterVersion, value.endpointClass, value.leaseOwner, value.leaseToken]) {
    assertDomain(ID.test(id), 'INVALID_ARGUMENT', 'Provider transport evidence identity is invalid')
  }
  for (const hash of [value.adapterConfigHash, value.requestHash, value.responseHash, value.observationHash, value.inputHash, value.authorizationHash, value.jobHash, value.evidenceHash]) {
    assertDomain(HASH.test(hash), 'INVALID_ARGUMENT', 'Provider transport evidence hash is invalid')
  }
  assertDomain(value.attempt >= 1 && Number.isSafeInteger(value.attempt), 'INVALID_ARGUMENT', 'Provider transport evidence attempt is invalid')
  assertDomain(value.phase === 'submit' || value.phase === 'retrieve', 'INVALID_ARGUMENT', 'Provider transport evidence phase is invalid')
  assertDomain(value.runtimeClass === 'controlled' || value.runtimeClass === 'live', 'INVALID_ARGUMENT', 'Provider transport runtime class is invalid')
  assertDomain(/^[A-Z]{3,10}$/.test(value.method) && value.responseStatus >= 100 && value.responseStatus <= 599, 'INVALID_ARGUMENT', 'Provider transport response is invalid')
  assertDomain(Number.isFinite(Date.parse(value.observedAt)), 'INVALID_ARGUMENT', 'Provider transport evidence time is invalid')
  if (value.providerJobRef !== undefined) assertDomain(PROVIDER_REF.test(value.providerJobRef), 'INVALID_ARGUMENT', 'Provider transport reference is invalid')
  assertDomain(calculateCanonicalHash(observationBody(value)) === value.observationHash, 'INVALID_ARGUMENT', 'Provider transport observation hash does not match')
  assertDomain(calculateCanonicalHash(evidenceBody(value)) === value.evidenceHash, 'INVALID_ARGUMENT', 'Provider transport evidence hash does not match')
}

function assertReceipt(value: Readonly<ProviderExecutionReceipt>): void {
  assertDomain(value.schemaVersion === PROVIDER_EXECUTION_RECEIPT_SCHEMA_VERSION, 'INVALID_ARGUMENT', 'Provider execution receipt schema is invalid')
  assertDomain(value.attempt >= 1 && Number.isSafeInteger(value.attempt), 'INVALID_ARGUMENT', 'Provider execution receipt attempt is invalid')
  assertDomain(value.results.length > 0 && new Set(value.results.map(({ role }) => role)).size === value.results.length, 'INVALID_ARGUMENT', 'Provider execution receipt results are invalid')
  assertDomain(Boolean(value.retrieveEvidenceId) === Boolean(value.retrieveEvidenceHash), 'INVALID_ARGUMENT', 'Provider execution retrieve evidence is incomplete')
  for (const hash of [value.adapterConfigHash, value.inputHash, value.authorizationHash, value.submitEvidenceHash, value.receiptHash, ...(value.retrieveEvidenceHash ? [value.retrieveEvidenceHash] : []), ...value.results.flatMap((result) => [result.resultRecordHash, result.artifactSha256])]) {
    assertDomain(HASH.test(hash), 'INVALID_ARGUMENT', 'Provider execution receipt hash is invalid')
  }
  assertDomain(calculateCanonicalHash(providerExecutionReceiptBody(value)) === value.receiptHash, 'INVALID_ARGUMENT', 'Provider execution receipt hash does not match')
}

function toEvidence(row: EvidenceRow): Readonly<ProviderTransportEvidence> {
  const value: ProviderTransportEvidence = {
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, jobId: row.jobId,
    schemaVersion: row.schemaVersion as ProviderTransportEvidence['schemaVersion'], attempt: row.attempt, phase: row.phase as ProviderTransportEvidence['phase'], runtimeClass: row.runtimeClass as ProviderTransportEvidence['runtimeClass'],
    adapterId: row.adapterId, adapterVersion: row.adapterVersion, adapterConfigHash: row.adapterConfigHash,
    endpointClass: row.endpointClass, method: row.method, requestHash: row.requestHash,
    responseHash: row.responseHash, responseStatus: row.responseStatus,
    ...(row.providerJobRef === null ? {} : { providerJobRef: row.providerJobRef }),
    observedAt: row.observedAt.toISOString(), observationHash: row.observationHash,
    inputHash: row.inputHash, authorizationHash: row.authorizationHash, jobHash: row.jobHash,
    leaseOwner: row.leaseOwner, leaseToken: row.leaseToken, evidenceHash: row.evidenceHash,
  }
  try { assertEvidence(value) } catch (error) {
    if (error instanceof DomainError && error.code === 'INVALID_ARGUMENT') throw new DomainError('PERSISTENCE_CONFLICT', 'Persisted provider transport evidence is invalid')
    throw error
  }
  return Object.freeze(value)
}

function resultFromRow(row: ReceiptRow['results'][number]): Readonly<ProviderExecutionReceiptResult> {
  return Object.freeze({ resultRecordId: row.resultRecordId, resultRecordHash: row.resultRecordHash, role: row.role as ProviderExecutionReceiptResult['role'], artifactId: row.artifactId, artifactSha256: row.artifactSha256, byteSize: Number(row.byteSize) })
}

function validatedResultRecordHash(row: ResultRow): string {
  assertDomain(row.schemaVersion === 'provider-result-artifact/v1' && typeof row.recordJson === 'string' && HASH.test(row.recordHash ?? ''), 'PERSISTENCE_CONFLICT', 'Provider execution result ledger is unattested')
  let parsed: unknown
  try { parsed = JSON.parse(row.recordJson) } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Provider execution result record JSON is invalid') }
  assertDomain(calculateCanonicalHash(parsed) === row.recordHash, 'PERSISTENCE_CONFLICT', 'Provider execution result record hash does not match')
  const projected = {
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, jobId: row.jobId,
    schemaVersion: row.schemaVersion, role: row.role, providerJobRef: row.providerJobRef,
    artifactId: row.artifactId, artifactSha256: row.artifactSha256, byteSize: Number(row.byteSize),
    mediaType: row.mediaType, container: row.container, adapterId: row.adapterId,
    adapterVersion: row.adapterVersion, ...(row.modelRef === null ? {} : { modelRef: row.modelRef }),
    adapterConfigHash: row.adapterConfigHash, inputHash: row.inputHash, authorizationHash: row.authorizationHash,
    ...(row.scriptHash === null ? {} : { scriptHash: row.scriptHash }),
    ...(row.observedCostCurrency === null || row.observedCostMinorUnits === null ? {} : { observedCost: { currency: row.observedCostCurrency, costMinorUnits: row.observedCostMinorUnits } }),
  }
  assertDomain(stableSerialize(parsed) === stableSerialize(projected), 'PERSISTENCE_CONFLICT', 'Provider execution result projections diverge from its record')
  return row.recordHash
}

function toReceipt(row: ReceiptRow): Readonly<ProviderExecutionReceipt> {
  let parsed: unknown
  try { parsed = JSON.parse(row.receiptJson) } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Provider execution receipt JSON is invalid') }
  const results = Object.freeze(row.results.map(resultFromRow))
  for (const entry of row.results) {
    assertDomain(validatedResultRecordHash(entry.result) === entry.resultRecordHash && entry.result.jobId === row.jobId && entry.result.projectId === row.projectId, 'PERSISTENCE_CONFLICT', 'Provider execution receipt result ledger diverged')
  }
  assertDomain((row.retrieveEvidenceId === null) === (row.retrieveEvidenceHash === null), 'PERSISTENCE_CONFLICT', 'Provider execution retrieve evidence is incomplete')
  const retrieve = row.retrieveEvidenceId === null ? {} : { retrieveEvidenceId: row.retrieveEvidenceId, retrieveEvidenceHash: row.retrieveEvidenceHash! }
  const value: ProviderExecutionReceipt = {
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, jobId: row.jobId,
    attempt: row.attempt, schemaVersion: row.schemaVersion as ProviderExecutionReceipt['schemaVersion'], runtimeClass: row.runtimeClass as ProviderExecutionReceipt['runtimeClass'],
    adapterId: row.adapterId, adapterVersion: row.adapterVersion, adapterConfigHash: row.adapterConfigHash,
    inputHash: row.inputHash, authorizationHash: row.authorizationHash, providerJobRef: row.providerJobRef,
    leaseOwner: row.leaseOwner, leaseToken: row.leaseToken,
    submitEvidenceId: row.submitEvidenceId, submitEvidenceHash: row.submitEvidenceHash,
    ...retrieve,
    results, createdAt: row.createdAt.toISOString(), receiptHash: row.receiptHash,
  }
  try { assertReceipt(value) } catch (error) {
    if (error instanceof DomainError && error.code === 'INVALID_ARGUMENT') throw new DomainError('PERSISTENCE_CONFLICT', 'Persisted provider execution receipt is invalid')
    throw error
  }
  assertDomain(stableSerialize(parsed) === stableSerialize(providerExecutionReceiptBody(value)), 'PERSISTENCE_CONFLICT', 'Provider execution receipt projections diverge from its record')
  return Object.freeze(value)
}

const receiptInclude = { results: { orderBy: { role: 'asc' as const }, include: { result: true } } } as const

export class PrismaProviderExecutionProvenanceRepository implements ProviderExecutionProvenanceRepository {
  private readonly client: PrismaClient
  private readonly clock: () => Date
  constructor(client: PrismaClient, clock: () => Date = () => new Date()) { this.client = client; this.clock = clock }

  async recordEvidence(input: { evidence: Readonly<ProviderTransportEvidence> }) {
    const evidence = input.evidence
    assertEvidence(evidence)
    const persist = () => this.client.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "provider_jobs" WHERE "id" = ${evidence.jobId} AND "workspaceId" = ${evidence.workspaceId} AND "projectId" = ${evidence.projectId} FOR UPDATE`)
      const job = await tx.v2ProviderJob.findUnique({ where: { id_workspaceId_projectId: { id: evidence.jobId, workspaceId: evidence.workspaceId, projectId: evidence.projectId } } })
      const expectedStatus = evidence.phase === 'submit' ? 'submitting' : 'retrieving'
      assertDomain(Boolean(job) && job!.status === expectedStatus && job!.attempt === evidence.attempt && job!.inputHash === evidence.inputHash && job!.authorizationHash === evidence.authorizationHash && job!.jobHash === evidence.jobHash && job!.adapterId === evidence.adapterId && job!.adapterVersion === evidence.adapterVersion && job!.leaseOwner === evidence.leaseOwner && job!.leaseToken === evidence.leaseToken && Boolean(job!.leaseExpiresAt && job!.leaseExpiresAt.getTime() > this.clock().getTime()), 'VERSION_CONFLICT', 'Provider transport evidence no longer matches the claimed job')
      const existing = await tx.v2ProviderTransportEvidence.findUnique({ where: { id: evidence.id } })
      if (existing) {
        const persisted = toEvidence(existing)
        assertDomain(persisted.evidenceHash === evidence.evidenceHash, 'PERSISTENCE_CONFLICT', 'Provider transport evidence replay diverged')
        return Object.freeze({ evidence: persisted, replayed: true })
      }
      const created = await tx.v2ProviderTransportEvidence.create({ data: {
        ...evidence, providerJobRef: evidence.providerJobRef ?? null,
        observedAt: new Date(evidence.observedAt), createdAt: new Date(evidence.observedAt),
      } })
      return Object.freeze({ evidence: toEvidence(created), replayed: false })
    })
    try { return await persist() } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')) throw error
      const row = await this.client.v2ProviderTransportEvidence.findUnique({ where: { id: evidence.id } })
      const persisted = row ? toEvidence(row) : null
      assertDomain(Boolean(persisted) && persisted!.evidenceHash === evidence.evidenceHash, 'PERSISTENCE_CONFLICT', 'Provider transport evidence concurrent replay diverged')
      return Object.freeze({ evidence: persisted!, replayed: true })
    }
  }

  async listEvidenceByJob(input: { workspaceId: string; projectId: string; jobId: string }) {
    return (await this.client.v2ProviderTransportEvidence.findMany({ where: input, orderBy: [{ attempt: 'asc' }, { observedAt: 'asc' }, { id: 'asc' }] })).map(toEvidence)
  }

  async createReceipt(input: { receipt: Readonly<ProviderExecutionReceipt> }) {
    const receipt = input.receipt
    assertReceipt(receipt)
    const persist = () => this.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.v2ProviderExecutionReceipt.findUnique({ where: { jobId_workspaceId_projectId: { jobId: receipt.jobId, workspaceId: receipt.workspaceId, projectId: receipt.projectId } }, include: receiptInclude })
      if (existing) {
        const persisted = toReceipt(existing)
        assertDomain(persisted.receiptHash === receipt.receiptHash, 'PERSISTENCE_CONFLICT', 'Provider execution receipt replay diverged')
        return Object.freeze({ receipt: persisted, replayed: true })
      }
      const [job, transportState, submit, retrieve, results] = await Promise.all([
        tx.v2ProviderJob.findUnique({ where: { id_workspaceId_projectId: { id: receipt.jobId, workspaceId: receipt.workspaceId, projectId: receipt.projectId } } }),
        tx.v2ProviderJobTransportState.findUnique({ where: { jobId_workspaceId: { jobId: receipt.jobId, workspaceId: receipt.workspaceId } } }),
        tx.v2ProviderTransportEvidence.findUnique({ where: { id: receipt.submitEvidenceId } }),
        receipt.retrieveEvidenceId ? tx.v2ProviderTransportEvidence.findUnique({ where: { id: receipt.retrieveEvidenceId } }) : Promise.resolve(null),
        tx.v2ProviderResultArtifact.findMany({ where: { workspaceId: receipt.workspaceId, projectId: receipt.projectId, jobId: receipt.jobId } }),
      ])
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "provider_jobs" WHERE "id" = ${receipt.jobId} AND "workspaceId" = ${receipt.workspaceId} AND "projectId" = ${receipt.projectId} FOR UPDATE`)
      const lockedJob = await tx.v2ProviderJob.findUnique({ where: { id_workspaceId_projectId: { id: receipt.jobId, workspaceId: receipt.workspaceId, projectId: receipt.projectId } } })
      assertDomain(Boolean(job) && Boolean(lockedJob) && lockedJob!.status === 'retrieving' && lockedJob!.leaseOwner === receipt.leaseOwner && lockedJob!.leaseToken === receipt.leaseToken && Boolean(lockedJob!.leaseExpiresAt && lockedJob!.leaseExpiresAt.getTime() > this.clock().getTime()) && lockedJob!.attempt === receipt.attempt && lockedJob!.inputHash === receipt.inputHash && lockedJob!.authorizationHash === receipt.authorizationHash && lockedJob!.adapterId === receipt.adapterId && lockedJob!.adapterVersion === receipt.adapterVersion, 'VERSION_CONFLICT', 'Provider execution receipt does not match its claimed job')
      assertDomain(Boolean(submit), 'PERSISTENCE_CONFLICT', 'Provider execution submit evidence was not found')
      toEvidence(submit!)
      assertDomain(Boolean(submit) && submit!.workspaceId === receipt.workspaceId && submit!.projectId === receipt.projectId && submit!.jobId === receipt.jobId && submit!.phase === 'submit' && submit!.attempt === receipt.attempt && submit!.evidenceHash === receipt.submitEvidenceHash && submit!.providerJobRef === receipt.providerJobRef && submit!.inputHash === receipt.inputHash && submit!.authorizationHash === receipt.authorizationHash && submit!.adapterId === receipt.adapterId && submit!.adapterVersion === receipt.adapterVersion && submit!.adapterConfigHash === receipt.adapterConfigHash, 'PERSISTENCE_CONFLICT', 'Provider execution submit evidence does not match')
      const asynchronous = transportState === null ? lockedJob!.operation !== 'tts' : transportState.completion !== 'synchronous'
      assertDomain(!asynchronous || Boolean(receipt.retrieveEvidenceId && retrieve), 'PERSISTENCE_CONFLICT', 'Asynchronous provider execution requires retrieve evidence')
      assertDomain(!receipt.retrieveEvidenceId || Boolean(retrieve), 'PERSISTENCE_CONFLICT', 'Provider execution retrieve evidence was not found')
      if (retrieve) toEvidence(retrieve)
      assertDomain(!retrieve || retrieve.workspaceId === receipt.workspaceId && retrieve.projectId === receipt.projectId && retrieve.jobId === receipt.jobId && retrieve.phase === 'retrieve' && retrieve.attempt === receipt.attempt && retrieve.evidenceHash === receipt.retrieveEvidenceHash && retrieve.providerJobRef === receipt.providerJobRef && retrieve.inputHash === receipt.inputHash && retrieve.authorizationHash === receipt.authorizationHash && retrieve.adapterId === receipt.adapterId && retrieve.adapterVersion === receipt.adapterVersion && retrieve.adapterConfigHash === receipt.adapterConfigHash, 'PERSISTENCE_CONFLICT', 'Provider execution retrieve evidence does not match')
      assertDomain(results.length === receipt.results.length, 'PERSISTENCE_CONFLICT', 'Provider execution receipt must cover the exact result ledger')
      const byId = new Map(results.map((row) => [row.id, row]))
      for (const result of receipt.results) {
        const row = byId.get(result.resultRecordId)
        assertDomain(Boolean(row), 'PERSISTENCE_CONFLICT', 'Provider execution receipt result is absent from the ledger')
        assertDomain(validatedResultRecordHash(row!) === result.resultRecordHash && row!.role === result.role && row!.artifactId === result.artifactId && row!.artifactSha256 === result.artifactSha256 && Number(row!.byteSize) === result.byteSize && row!.providerJobRef === receipt.providerJobRef && row!.adapterId === receipt.adapterId && row!.adapterVersion === receipt.adapterVersion && row!.adapterConfigHash === receipt.adapterConfigHash && row!.inputHash === receipt.inputHash && row!.authorizationHash === receipt.authorizationHash, 'PERSISTENCE_CONFLICT', 'Provider execution receipt result does not match the ledger')
      }
      assertDomain(Boolean(lockedJob!.resultArtifactId && receipt.results.some((result) => result.artifactId === lockedJob!.resultArtifactId && result.artifactSha256 === lockedJob!.resultArtifactSha256)), 'PERSISTENCE_CONFLICT', 'Provider execution receipt does not cover the job result artifact')
      const expectedRuntime = [submit, ...(retrieve ? [retrieve] : [])].every((row) => row!.runtimeClass === 'live') ? 'live' : 'controlled'
      assertDomain(receipt.runtimeClass === expectedRuntime, 'PERSISTENCE_CONFLICT', 'Provider execution receipt runtime class is not supported by its evidence')
      await tx.v2ProviderExecutionReceipt.create({
        data: {
          id: receipt.id, workspaceId: receipt.workspaceId, projectId: receipt.projectId, jobId: receipt.jobId,
          attempt: receipt.attempt, schemaVersion: receipt.schemaVersion, runtimeClass: receipt.runtimeClass,
          adapterId: receipt.adapterId, adapterVersion: receipt.adapterVersion, adapterConfigHash: receipt.adapterConfigHash,
          inputHash: receipt.inputHash, authorizationHash: receipt.authorizationHash, providerJobRef: receipt.providerJobRef,
          leaseOwner: receipt.leaseOwner, leaseToken: receipt.leaseToken,
          submitEvidenceId: receipt.submitEvidenceId, submitEvidenceHash: receipt.submitEvidenceHash,
          retrieveEvidenceId: receipt.retrieveEvidenceId ?? null, retrieveEvidenceHash: receipt.retrieveEvidenceHash ?? null,
          receiptJson: stableSerialize(providerExecutionReceiptBody(receipt)), receiptHash: receipt.receiptHash, createdAt: new Date(receipt.createdAt),
        },
      })
      await tx.v2ProviderExecutionReceiptResult.createMany({
        data: receipt.results.map((result) => ({
          receiptId: receipt.id,
          workspaceId: receipt.workspaceId,
          projectId: receipt.projectId,
          jobId: receipt.jobId,
          resultRecordId: result.resultRecordId,
          resultRecordHash: result.resultRecordHash,
          role: result.role,
          artifactId: result.artifactId,
          artifactSha256: result.artifactSha256,
          byteSize: BigInt(result.byteSize),
        })),
      })
      const created = await tx.v2ProviderExecutionReceipt.findUnique({
        where: { id_workspaceId: { id: receipt.id, workspaceId: receipt.workspaceId } },
        include: receiptInclude,
      })
      assertDomain(Boolean(created), 'PERSISTENCE_CONFLICT', 'Provider execution receipt was not readable after persistence')
      return Object.freeze({ receipt: toReceipt(created!), replayed: false })
    })
    try { return await persist() } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')) throw error
      const row = await this.client.v2ProviderExecutionReceipt.findUnique({ where: { jobId_workspaceId_projectId: { jobId: receipt.jobId, workspaceId: receipt.workspaceId, projectId: receipt.projectId } }, include: receiptInclude })
      const persisted = row ? toReceipt(row) : null
      assertDomain(Boolean(persisted) && persisted!.receiptHash === receipt.receiptHash, 'PERSISTENCE_CONFLICT', 'Provider execution receipt concurrent replay diverged')
      return Object.freeze({ receipt: persisted!, replayed: true })
    }
  }

  async readReceiptByJob(input: { workspaceId: string; projectId: string; jobId: string }) {
    const row = await this.client.v2ProviderExecutionReceipt.findUnique({ where: { jobId_workspaceId_projectId: { jobId: input.jobId, workspaceId: input.workspaceId, projectId: input.projectId } }, include: receiptInclude })
    return row ? toReceipt(row) : null
  }
}
