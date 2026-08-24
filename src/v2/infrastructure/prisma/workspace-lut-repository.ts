import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient, type V2WorkspaceLut, type V2WorkspaceLutDefaultVersion, type V2WorkspaceLutStatusCommand, type V2WorkspaceLutVersion } from '../../../../generated/prisma-v2/index.js'

import type { PersistedWorkspaceLutImport, WorkspaceLutDefaultVersion, WorkspaceLutRecord, WorkspaceLutRepository, WorkspaceLutStatusCommand } from '../../application/ports/workspace-lut-repository.ts'
import { createApiAccessAuditContext, type ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { createWorkspaceLutVersion, type LutColorSpace, type LutLicensePolicy } from '../../domain/workspace-lut.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function json<T>(value: string, field: string): T {
  try {
    const parsed = JSON.parse(value) as T
    if (stableSerialize(parsed) !== value) throw new Error('non-canonical')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

interface StoredLutAudit {
  workspaceId: string
  createdByClientId: string
  actorCredentialId: string
  actorEnvironment: string
  actorAuthenticationKind: string
  actorContextHash: string
  actorDelegatedUserId: string | null
  actorDelegatedIdentityId: string | null
  actorWorkspaceRole: string | null
}

function auditData(audit: Readonly<ApiAccessAuditContext>) {
  return {
    actorCredentialId: audit.credentialId,
    actorEnvironment: audit.environment,
    actorAuthenticationKind: audit.authenticationKind,
    actorContextHash: audit.contextHash,
    actorDelegatedUserId: audit.delegatedUserId,
    actorDelegatedIdentityId: audit.delegatedIdentityId,
    actorWorkspaceRole: audit.workspaceRole,
  }
}

function assertAuditBinding(input: {
  workspaceId: string
  createdByClientId: string
  audit: Readonly<ApiAccessAuditContext>
}): void {
  const canonical = hydrateAudit({
    workspaceId: input.workspaceId,
    createdByClientId: input.createdByClientId,
    actorCredentialId: input.audit.credentialId,
    actorEnvironment: input.audit.environment,
    actorAuthenticationKind: input.audit.authenticationKind,
    actorContextHash: input.audit.contextHash,
    actorDelegatedUserId: input.audit.delegatedUserId ?? null,
    actorDelegatedIdentityId: input.audit.delegatedIdentityId ?? null,
    actorWorkspaceRole: input.audit.workspaceRole ?? null,
  })
  if (
    canonical.clientId !== input.createdByClientId ||
    canonical.workspaceId !== input.workspaceId
  ) {
    throw new DomainError('AUTH_INVALID', 'LUT actor audit does not match its mutation')
  }
}

function hydrateAudit(row: StoredLutAudit): Readonly<ApiAccessAuditContext> {
  try {
    const audit = createApiAccessAuditContext({
      clientId: row.createdByClientId,
      credentialId: row.actorCredentialId,
      workspaceId: row.workspaceId,
      environment: row.actorEnvironment as 'sandbox' | 'production',
      authenticationKind: row.actorAuthenticationKind as 'bearer' | 'ui-session',
      ...(row.actorDelegatedUserId ? { delegatedUserId: row.actorDelegatedUserId } : {}),
      ...(row.actorDelegatedIdentityId
        ? { delegatedIdentityId: row.actorDelegatedIdentityId }
        : {}),
      ...(row.actorWorkspaceRole
        ? { workspaceRole: row.actorWorkspaceRole as WorkspaceMemberRole }
        : {}),
    })
    if (audit.contextHash !== row.actorContextHash) throw new Error('context hash mismatch')
    return audit
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored LUT actor audit is invalid')
  }
}

function hydrateVersion(row: V2WorkspaceLutVersion) {
  hydrateAudit(row)
  const preview = Buffer.from(row.previewPng)
  if (preview.length !== row.previewByteSize || createHash('sha256').update(preview).digest('hex') !== row.previewSha256) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored LUT preview failed integrity validation')
  }
  const value = createWorkspaceLutVersion({
    id: row.id, workspaceId: row.workspaceId, lutId: row.lutId, version: row.version,
    name: row.name, owner: row.owner,
    license: { policy: row.licensePolicy as LutLicensePolicy, name: row.licenseName, ...(row.licenseUsageNotes ? { usageNotes: row.licenseUsageNotes } : {}) },
    tags: json<readonly string[]>(row.tagsJson, 'LUT tags'),
    compatibility: { inputColorSpace: row.inputColorSpace as LutColorSpace, outputColorSpace: row.outputColorSpace as LutColorSpace },
    intensity: row.intensityDefault, cubeContent: row.cubeContent,
    preview: { byteSize: row.previewByteSize, sha256: row.previewSha256 },
    createdByClientId: row.createdByClientId, createdAt: row.createdAt.toISOString(),
  })
  if (row.schemaVersion !== value.schemaVersion || row.cubeSize !== value.cube.size ||
    row.cubeContentHash !== value.cube.contentHash || row.recordHash !== value.recordHash ||
    stableSerialize(value.cube.domainMin) !== row.cubeDomainMinJson || stableSerialize(value.cube.domainMax) !== row.cubeDomainMaxJson) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored LUT version failed integrity validation')
  }
  return value
}

function record(head: V2WorkspaceLut, version: V2WorkspaceLutVersion): Readonly<WorkspaceLutRecord> {
  if (!head.currentVersionId || head.currentVersionId !== version.id || head.id !== version.lutId || head.workspaceId !== version.workspaceId || !['active', 'inactive'].includes(head.status)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored LUT head is invalid')
  }
  if (!Number.isSafeInteger(head.revision) || head.revision < 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored LUT revision is invalid')
  return Object.freeze({ lutId: head.id, workspaceId: head.workspaceId, status: head.status as 'active' | 'inactive', revision: head.revision, currentVersion: hydrateVersion(version) })
}

function statusCommand(row: V2WorkspaceLutStatusCommand): Readonly<WorkspaceLutStatusCommand> {
  if (!['active', 'inactive'].includes(row.status) || row.baseRevision < 1 || row.resultRevision !== row.baseRevision + 1) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored LUT status command is invalid')
  return Object.freeze({
    id: row.id, workspaceId: row.workspaceId, lutId: row.lutId, baseRevision: row.baseRevision, resultRevision: row.resultRevision,
    status: row.status as 'active' | 'inactive', resultVersionId: row.resultVersionId, requestFingerprint: row.requestFingerprint, idempotencyKey: row.idempotencyKey,
    createdByClientId: row.createdByClientId, audit: hydrateAudit(row),
    createdAt: row.createdAt.toISOString(),
  })
}

function defaultVersion(row: V2WorkspaceLutDefaultVersion, lutRow: V2WorkspaceLutVersion | null): Readonly<WorkspaceLutDefaultVersion> {
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !['none', 'lut-version'].includes(row.mode) ||
    (row.mode === 'none' && (row.lutVersionId || lutRow)) || (row.mode === 'lut-version' && (!row.lutVersionId || !lutRow || lutRow.id !== row.lutVersionId))) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored workspace LUT default is invalid')
  }
  const lutVersion = lutRow ? hydrateVersion(lutRow) : undefined
  const expectedHash = calculateCanonicalHash({ schemaVersion: 'workspace-lut-default-version/v1', workspaceId: row.workspaceId, revision: row.revision, mode: row.mode, lutVersionId: lutVersion?.id ?? null, lutRecordHash: lutVersion?.recordHash ?? null })
  if (expectedHash !== row.selectionHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored workspace LUT default hash is invalid')
  return Object.freeze({
    id: row.id, workspaceId: row.workspaceId, revision: row.revision, mode: row.mode as 'none' | 'lut-version',
    ...(lutVersion ? { lutVersion } : {}), selectionHash: row.selectionHash, requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey, createdByClientId: row.createdByClientId,
    audit: hydrateAudit(row), createdAt: row.createdAt.toISOString(),
  })
}

export class PrismaWorkspaceLutRepository implements WorkspaceLutRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) { this.client = client }

  async findIdempotent(input: { workspaceId: string; createdByClientId: string; idempotencyKey: string }) {
    const version = await this.client.v2WorkspaceLutVersion.findUnique({
      where: { workspaceId_createdByClientId_idempotencyKey: input },
    })
    if (!version) return null
    const head = await this.client.v2WorkspaceLut.findUnique({ where: { id_workspaceId: { id: version.lutId, workspaceId: input.workspaceId } } })
    if (!head) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent LUT head disappeared')
    return Object.freeze({
      record: record(head, version), audit: hydrateAudit(version),
      idempotencyKey: version.idempotencyKey, requestFingerprint: version.requestFingerprint,
    })
  }

  async import(
    input: { value: Readonly<PersistedWorkspaceLutImport>; previewPng: Uint8Array },
    serializationAttempt = 1,
  ): Promise<Readonly<{ value: Readonly<PersistedWorkspaceLutImport>; replayed: boolean }>> {
    const item = input.value.record.currentVersion
    assertAuditBinding({
      workspaceId: item.workspaceId,
      createdByClientId: item.createdByClientId,
      audit: input.value.audit,
    })
    try {
      return await this.client.$transaction(async (transaction) => {
        const [workspace, client, existingHead] = await Promise.all([
          transaction.v2Workspace.findFirst({ where: { id: item.workspaceId, status: 'active' }, select: { id: true } }),
          transaction.v2ApiClient.findFirst({ where: { id: item.createdByClientId, workspaceId: item.workspaceId, status: 'active' }, select: { id: true } }),
          transaction.v2WorkspaceLut.findUnique({ where: { id_workspaceId: { id: item.lutId, workspaceId: item.workspaceId } }, select: { id: true } }),
        ])
        if (!workspace || !client) throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace and API client are required')
        if (existingHead) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace LUT already exists; create a new immutable version instead')
        const head = await transaction.v2WorkspaceLut.create({ data: { id: item.lutId, workspaceId: item.workspaceId, status: 'active', createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt) } })
        const version = await transaction.v2WorkspaceLutVersion.create({ data: {
          id: item.id, workspaceId: item.workspaceId, lutId: item.lutId, version: item.version,
          schemaVersion: item.schemaVersion, name: item.name, owner: item.owner,
          licensePolicy: item.license.policy, licenseName: item.license.name, licenseUsageNotes: item.license.usageNotes,
          tagsJson: stableSerialize(item.tags), inputColorSpace: item.compatibility.inputColorSpace,
          outputColorSpace: item.compatibility.outputColorSpace, intensityDefault: item.intensity.default,
          cubeSize: item.cube.size, cubeDomainMinJson: stableSerialize(item.cube.domainMin), cubeDomainMaxJson: stableSerialize(item.cube.domainMax),
          cubeContent: item.cube.canonicalContent, cubeContentHash: item.cube.contentHash,
          previewPng: Buffer.from(input.previewPng), previewSha256: item.preview.sha256, previewByteSize: item.preview.byteSize,
          recordHash: item.recordHash, requestFingerprint: input.value.requestFingerprint, idempotencyKey: input.value.idempotencyKey,
          createdByClientId: item.createdByClientId, ...auditData(input.value.audit),
          createdAt: new Date(item.createdAt),
        } })
        const updated = await transaction.v2WorkspaceLut.update({ where: { id_workspaceId: { id: item.lutId, workspaceId: item.workspaceId } }, data: { currentVersionId: item.id, updatedAt: new Date(item.createdAt) } })
        return Object.freeze({ value: Object.freeze({
          record: record(updated, version), audit: input.value.audit,
          idempotencyKey: input.value.idempotencyKey,
          requestFingerprint: input.value.requestFingerprint,
        }), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findIdempotent({ workspaceId: item.workspaceId, createdByClientId: item.createdByClientId, idempotencyKey: input.value.idempotencyKey })
        if (replay && replay.requestFingerprint === input.value.requestFingerprint) return Object.freeze({ value: replay, replayed: true })
        if (replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another LUT import')
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && serializationAttempt < 3) return this.import(input, serializationAttempt + 1)
      throw error
    }
  }

  async createVersion(input: { value: Readonly<PersistedWorkspaceLutImport>; previewPng: Uint8Array; expectedCurrentVersionId: string }, serializationAttempt = 1): Promise<Readonly<{ value: Readonly<PersistedWorkspaceLutImport>; replayed: boolean }>> {
    const item = input.value.record.currentVersion
    assertAuditBinding({
      workspaceId: item.workspaceId,
      createdByClientId: item.createdByClientId,
      audit: input.value.audit,
    })
    try {
      return await this.client.$transaction(async (transaction) => {
        const [head, client] = await Promise.all([
          transaction.v2WorkspaceLut.findUnique({ where: { id_workspaceId: { id: item.lutId, workspaceId: item.workspaceId } } }),
          transaction.v2ApiClient.findFirst({ where: { id: item.createdByClientId, workspaceId: item.workspaceId, status: 'active' }, select: { id: true } }),
        ])
        if (!head?.currentVersionId) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Workspace LUT was not found')
        if (!client) throw new DomainError('WORKSPACE_NOT_FOUND', 'Active API client is required')
        if (head.currentVersionId !== input.expectedCurrentVersionId || item.version < 2) throw new DomainError('VERSION_CONFLICT', 'Workspace LUT current version changed')
        const previous = await transaction.v2WorkspaceLutVersion.findUnique({ where: { id: head.currentVersionId }, select: { version: true } })
        if (!previous || item.version !== previous.version + 1) throw new DomainError('VERSION_CONFLICT', 'Workspace LUT version sequence changed')
        const version = await transaction.v2WorkspaceLutVersion.create({ data: {
          id: item.id, workspaceId: item.workspaceId, lutId: item.lutId, version: item.version,
          schemaVersion: item.schemaVersion, name: item.name, owner: item.owner, licensePolicy: item.license.policy,
          licenseName: item.license.name, licenseUsageNotes: item.license.usageNotes, tagsJson: stableSerialize(item.tags),
          inputColorSpace: item.compatibility.inputColorSpace, outputColorSpace: item.compatibility.outputColorSpace,
          intensityDefault: item.intensity.default, cubeSize: item.cube.size, cubeDomainMinJson: stableSerialize(item.cube.domainMin),
          cubeDomainMaxJson: stableSerialize(item.cube.domainMax), cubeContent: item.cube.canonicalContent, cubeContentHash: item.cube.contentHash,
          previewPng: Buffer.from(input.previewPng), previewSha256: item.preview.sha256, previewByteSize: item.preview.byteSize,
          recordHash: item.recordHash, requestFingerprint: input.value.requestFingerprint, idempotencyKey: input.value.idempotencyKey,
          createdByClientId: item.createdByClientId, ...auditData(input.value.audit),
          createdAt: new Date(item.createdAt),
        } })
        const updated = await transaction.v2WorkspaceLut.update({
          where: { id_workspaceId: { id: item.lutId, workspaceId: item.workspaceId } },
          data: { currentVersionId: item.id, updatedAt: new Date(item.createdAt) },
        })
        return Object.freeze({ value: Object.freeze({
          record: record(updated, version), audit: input.value.audit,
          idempotencyKey: input.value.idempotencyKey,
          requestFingerprint: input.value.requestFingerprint,
        }), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findIdempotent({ workspaceId: item.workspaceId, createdByClientId: item.createdByClientId, idempotencyKey: input.value.idempotencyKey })
        if (replay?.requestFingerprint === input.value.requestFingerprint) return Object.freeze({ value: replay, replayed: true })
        if (replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another LUT mutation')
        throw new DomainError('VERSION_CONFLICT', 'Workspace LUT version was concurrently changed')
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && serializationAttempt < 3) return this.createVersion(input, serializationAttempt + 1)
      throw error
    }
  }

  async read(input: { workspaceId: string; lutId: string }) {
    const head = await this.client.v2WorkspaceLut.findUnique({ where: { id_workspaceId: { id: input.lutId, workspaceId: input.workspaceId } } })
    if (!head?.currentVersionId) return null
    const version = await this.client.v2WorkspaceLutVersion.findFirst({ where: { id: head.currentVersionId, workspaceId: input.workspaceId, lutId: input.lutId } })
    return version ? record(head, version) : null
  }

  async readVersion(input: { workspaceId: string; lutId: string; version: number }) {
    const row = await this.client.v2WorkspaceLutVersion.findUnique({ where: { workspaceId_lutId_version: input } })
    return row ? hydrateVersion(row) : null
  }

  async readVersionById(input: { workspaceId: string; versionId: string }) {
    const row = await this.client.v2WorkspaceLutVersion.findFirst({ where: { id: input.versionId, workspaceId: input.workspaceId } })
    return row ? hydrateVersion(row) : null
  }

  async list(input: { workspaceId: string; status?: 'active' | 'inactive'; limit: number }) {
    const heads = await this.client.v2WorkspaceLut.findMany({ where: { workspaceId: input.workspaceId, ...(input.status ? { status: input.status } : {}) }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: input.limit })
    const ids = heads.flatMap((head) => head.currentVersionId ? [head.currentVersionId] : [])
    const versions = await this.client.v2WorkspaceLutVersion.findMany({ where: { workspaceId: input.workspaceId, id: { in: ids } } })
    return Object.freeze(heads.map((head) => {
      const version = versions.find((item) => item.id === head.currentVersionId)
      if (!version) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace LUT current version disappeared')
      return record(head, version)
    }))
  }

  async readPreview(input: { workspaceId: string; lutId: string; version: number }) {
    const row = await this.client.v2WorkspaceLutVersion.findUnique({
      where: { workspaceId_lutId_version: input },
      select: {
        workspaceId: true,
        createdByClientId: true,
        actorCredentialId: true,
        actorEnvironment: true,
        actorAuthenticationKind: true,
        actorContextHash: true,
        actorDelegatedUserId: true,
        actorDelegatedIdentityId: true,
        actorWorkspaceRole: true,
        previewPng: true,
        previewSha256: true,
        previewByteSize: true,
      },
    })
    if (!row) return null
    hydrateAudit(row)
    const png = new Uint8Array(row.previewPng)
    if (
      png.byteLength !== row.previewByteSize ||
      createHash('sha256').update(png).digest('hex') !== row.previewSha256
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored LUT preview failed integrity validation')
    }
    return Object.freeze({ png, sha256: row.previewSha256 })
  }

  async findStatusIdempotent(input: { workspaceId: string; createdByClientId: string; idempotencyKey: string }) {
    const row = await this.client.v2WorkspaceLutStatusCommand.findUnique({ where: { workspaceId_createdByClientId_idempotencyKey: input } })
    if (!row) return null
    const head = await this.client.v2WorkspaceLut.findUnique({ where: { id_workspaceId: { id: row.lutId, workspaceId: row.workspaceId } } })
    if (!head?.currentVersionId) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent LUT status head disappeared')
    const version = await this.client.v2WorkspaceLutVersion.findUnique({ where: { id: row.resultVersionId } })
    if (!version) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent LUT status version disappeared')
    return Object.freeze({ command: statusCommand(row), record: record({ ...head, status: row.status, revision: row.resultRevision, currentVersionId: row.resultVersionId }, version) })
  }

  async setStatus(input: { command: Readonly<WorkspaceLutStatusCommand> }, serializationAttempt = 1): Promise<Readonly<{ command: Readonly<WorkspaceLutStatusCommand>; record: Readonly<WorkspaceLutRecord>; replayed: boolean }>> {
    const command = input.command
    assertAuditBinding({
      workspaceId: command.workspaceId,
      createdByClientId: command.createdByClientId,
      audit: command.audit,
    })
    try {
      return await this.client.$transaction(async (transaction) => {
        const [head, client] = await Promise.all([
          transaction.v2WorkspaceLut.findUnique({ where: { id_workspaceId: { id: command.lutId, workspaceId: command.workspaceId } } }),
          transaction.v2ApiClient.findFirst({ where: { id: command.createdByClientId, workspaceId: command.workspaceId, status: 'active' }, select: { id: true } }),
        ])
        if (!head?.currentVersionId) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Workspace LUT was not found')
        if (!client) throw new DomainError('WORKSPACE_NOT_FOUND', 'Active API client is required')
        if (head.revision !== command.baseRevision || command.resultRevision !== head.revision + 1 || command.resultVersionId !== head.currentVersionId) throw new DomainError('VERSION_CONFLICT', 'Workspace LUT revision or version changed')
        const version = await transaction.v2WorkspaceLutVersion.findUnique({ where: { id: head.currentVersionId } })
        if (!version) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace LUT current version disappeared')
        const persisted = await transaction.v2WorkspaceLutStatusCommand.create({ data: {
          id: command.id, workspaceId: command.workspaceId, lutId: command.lutId, baseRevision: command.baseRevision,
          resultRevision: command.resultRevision, status: command.status, resultVersionId: command.resultVersionId, requestFingerprint: command.requestFingerprint,
          idempotencyKey: command.idempotencyKey, createdByClientId: command.createdByClientId,
          ...auditData(command.audit), createdAt: new Date(command.createdAt),
        } })
        const updated = await transaction.v2WorkspaceLut.update({
          where: { id_workspaceId: { id: command.lutId, workspaceId: command.workspaceId } },
          data: { status: command.status, revision: command.resultRevision, updatedAt: new Date(command.createdAt) },
        })
        return Object.freeze({ command: statusCommand(persisted), record: record(updated, version), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findStatusIdempotent({ workspaceId: command.workspaceId, createdByClientId: command.createdByClientId, idempotencyKey: command.idempotencyKey })
        if (replay?.command.requestFingerprint === command.requestFingerprint) return Object.freeze({ ...replay, replayed: true })
        if (replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another LUT status command')
        throw new DomainError('VERSION_CONFLICT', 'Workspace LUT status was concurrently changed')
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && serializationAttempt < 3) return this.setStatus(input, serializationAttempt + 1)
      throw error
    }
  }

  async readDefault(input: { workspaceId: string }) {
    const head = await this.client.v2WorkspaceLutDefault.findUnique({ where: { workspaceId: input.workspaceId } })
    if (!head) return Object.freeze({ workspaceId: input.workspaceId, revision: 0, current: null })
    const row = await this.client.v2WorkspaceLutDefaultVersion.findUnique({ where: { id: head.currentVersionId } })
    if (!row || row.workspaceId !== input.workspaceId || row.revision !== head.revision) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace LUT default head is invalid')
    const lutRow = row.lutVersionId ? await this.client.v2WorkspaceLutVersion.findUnique({ where: { id: row.lutVersionId } }) : null
    return Object.freeze({ workspaceId: input.workspaceId, revision: head.revision, current: defaultVersion(row, lutRow) })
  }

  async findDefaultIdempotent(input: { workspaceId: string; createdByClientId: string; idempotencyKey: string }) {
    const row = await this.client.v2WorkspaceLutDefaultVersion.findUnique({ where: { workspaceId_createdByClientId_idempotencyKey: input } })
    if (!row) return null
    const lutRow = row.lutVersionId ? await this.client.v2WorkspaceLutVersion.findUnique({ where: { id: row.lutVersionId } }) : null
    return defaultVersion(row, lutRow)
  }

  async setDefault(input: { value: Readonly<WorkspaceLutDefaultVersion>; expectedRevision: number }, serializationAttempt = 1): Promise<Readonly<{ value: Readonly<WorkspaceLutDefaultVersion>; replayed: boolean }>> {
    const value = input.value
    assertAuditBinding({
      workspaceId: value.workspaceId,
      createdByClientId: value.createdByClientId,
      audit: value.audit,
    })
    try {
      return await this.client.$transaction(async (transaction) => {
        const [workspace, client, head] = await Promise.all([
          transaction.v2Workspace.findFirst({ where: { id: value.workspaceId, status: 'active' }, select: { id: true } }),
          transaction.v2ApiClient.findFirst({ where: { id: value.createdByClientId, workspaceId: value.workspaceId, status: 'active' }, select: { id: true } }),
          transaction.v2WorkspaceLutDefault.findUnique({ where: { workspaceId: value.workspaceId } }),
        ])
        if (!workspace || !client) throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace and API client are required')
        const revision = head?.revision ?? 0
        if (revision !== input.expectedRevision || value.revision !== revision + 1) throw new DomainError('VERSION_CONFLICT', 'Workspace LUT default revision changed')
        let lutRow: V2WorkspaceLutVersion | null = null
        if (value.mode === 'lut-version') {
          if (!value.lutVersion) throw new DomainError('INVALID_ARGUMENT', 'Workspace LUT default version is missing')
          const [candidate, lutHead] = await Promise.all([
            transaction.v2WorkspaceLutVersion.findUnique({ where: { id: value.lutVersion.id } }),
            transaction.v2WorkspaceLut.findUnique({ where: { id_workspaceId: { id: value.lutVersion.lutId, workspaceId: value.workspaceId } } }),
          ])
          if (!candidate || candidate.workspaceId !== value.workspaceId || candidate.recordHash !== value.lutVersion.recordHash || lutHead?.status !== 'active' || lutHead.currentVersionId !== candidate.id) {
            throw new DomainError('VERSION_CONFLICT', 'Workspace LUT default candidate changed or is inactive')
          }
          lutRow = candidate
        }
        const row = await transaction.v2WorkspaceLutDefaultVersion.create({ data: {
          id: value.id, workspaceId: value.workspaceId, revision: value.revision, mode: value.mode,
          lutVersionId: value.lutVersion?.id, selectionHash: value.selectionHash, requestFingerprint: value.requestFingerprint,
          idempotencyKey: value.idempotencyKey, createdByClientId: value.createdByClientId,
          ...auditData(value.audit), createdAt: new Date(value.createdAt),
        } })
        if (head) {
          await transaction.v2WorkspaceLutDefault.update({ where: { workspaceId: value.workspaceId }, data: { revision: value.revision, currentVersionId: value.id, updatedAt: new Date(value.createdAt) } })
        } else {
          await transaction.v2WorkspaceLutDefault.create({ data: { workspaceId: value.workspaceId, revision: value.revision, currentVersionId: value.id, createdAt: new Date(value.createdAt), updatedAt: new Date(value.createdAt) } })
        }
        return Object.freeze({ value: defaultVersion(row, lutRow), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findDefaultIdempotent({ workspaceId: value.workspaceId, createdByClientId: value.createdByClientId, idempotencyKey: value.idempotencyKey })
        if (replay?.requestFingerprint === value.requestFingerprint) return Object.freeze({ value: replay, replayed: true })
        if (replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another workspace LUT default')
        throw new DomainError('VERSION_CONFLICT', 'Workspace LUT default was concurrently changed')
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && serializationAttempt < 3) return this.setDefault(input, serializationAttempt + 1)
      throw error
    }
  }
}
