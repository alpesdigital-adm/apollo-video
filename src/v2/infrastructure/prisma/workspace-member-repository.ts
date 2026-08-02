import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { WorkspaceMemberRepository } from '../../application/ports/workspace-member-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import type { SelectableWorkspaceMembership, WorkspaceMember, WorkspaceMemberRole, WorkspaceMemberStatus } from '../../domain/workspace-member.ts'

function hydrate(row: {
  id: string; workspaceId: string; identityId: string; role: string; status: string; createdAt: Date
}): Readonly<WorkspaceMember> {
  return Object.freeze({
    id: row.id, workspaceId: row.workspaceId, identityId: row.identityId,
    role: row.role as WorkspaceMemberRole, status: row.status as WorkspaceMemberStatus,
    createdAt: row.createdAt.toISOString(),
  })
}

function retryable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && ['P2002', 'P2034'].includes(String(error.code))
}

function hydrateSelection(row: {
  id: string
  workspaceId: string
  role: string
  workspace: { slug: string; name: string; uiPrincipal: { clientId: string } | null }
}): Readonly<SelectableWorkspaceMembership> {
  if (!row.workspace.uiPrincipal) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace UI principal is missing')
  return Object.freeze({
    memberId: row.id,
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspace.slug,
    workspaceName: row.workspace.name,
    role: row.role as WorkspaceMemberRole,
    uiClientId: row.workspace.uiPrincipal.clientId,
  })
}

export class PrismaWorkspaceMemberRepository implements WorkspaceMemberRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) { this.client = client }

  async provisionBootstrapMembership(input: Parameters<WorkspaceMemberRepository['provisionBootstrapMembership']>[0], retry = 0): Promise<Readonly<WorkspaceMember>> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const identity = await transaction.v2HumanIdentity.upsert({
          where: { issuer_subjectHash: { issuer: input.issuer, subjectHash: input.subjectHash } },
          create: { id: input.identityId, issuer: input.issuer, subjectHash: input.subjectHash, status: 'active', createdAt: new Date(input.now), updatedAt: new Date(input.now) },
          update: {},
        })
        if (identity.status !== 'active') throw new DomainError('AUTH_INVALID', 'Human identity is not active')
        const existing = await transaction.v2WorkspaceMember.findUnique({
          where: { workspaceId_identityId: { workspaceId: input.workspaceId, identityId: identity.id } },
        })
        if (existing) {
          if (existing.status !== 'active') throw new DomainError('AUTH_INVALID', 'Workspace membership is not active')
          return hydrate(existing)
        }
        return hydrate(await transaction.v2WorkspaceMember.create({ data: {
          id: input.memberId, workspaceId: input.workspaceId, identityId: identity.id,
          role: input.role, status: 'active', createdAt: new Date(input.now), updatedAt: new Date(input.now),
        } }))
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (retryable(error) && retry < 3) return this.provisionBootstrapMembership(input, retry + 1)
      if (retryable(error)) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace membership could not be provisioned')
      throw error
    }
  }

  async findActiveById(input: Parameters<WorkspaceMemberRepository['findActiveById']>[0]) {
    const row = await this.client.v2WorkspaceMember.findFirst({
      where: { id: input.memberId, workspaceId: input.workspaceId, status: 'active', identity: { status: 'active' } },
    })
    return row ? hydrate(row) : null
  }

  async provisionBootstrapUiPrincipal(input: Parameters<WorkspaceMemberRepository['provisionBootstrapUiPrincipal']>[0], retry = 0): Promise<void> {
    try {
      await this.client.$transaction(async (transaction) => {
        const client = await transaction.v2ApiClient.findFirst({
          where: { id: input.clientId, workspaceId: input.workspaceId, status: 'active', workspace: { status: 'active' } },
        })
        if (!client) throw new DomainError('AUTH_INVALID', 'Workspace UI principal client is not active')
        const principal = await transaction.v2WorkspaceUiPrincipal.upsert({
          where: { workspaceId: input.workspaceId },
          create: { workspaceId: input.workspaceId, clientId: input.clientId, createdAt: new Date(input.now), updatedAt: new Date(input.now) },
          update: {},
        })
        if (principal.clientId !== input.clientId) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace UI principal is already bound')
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (retryable(error) && retry < 3) return this.provisionBootstrapUiPrincipal(input, retry + 1)
      if (retryable(error)) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace UI principal could not be provisioned')
      throw error
    }
  }

  async listSelectableForMember(input: Parameters<WorkspaceMemberRepository['listSelectableForMember']>[0]) {
    const current = await this.client.v2WorkspaceMember.findFirst({
      where: { id: input.memberId, status: 'active', identity: { status: 'active' } },
      select: { identityId: true },
    })
    if (!current) return Object.freeze([])
    const rows = await this.client.v2WorkspaceMember.findMany({
      where: {
        identityId: current.identityId,
        status: 'active',
        identity: { status: 'active' },
        workspace: { status: 'active', uiPrincipal: { is: { client: { status: 'active' } } } },
      },
      include: { workspace: { include: { uiPrincipal: true } } },
      orderBy: [{ workspace: { name: 'asc' } }, { workspaceId: 'asc' }],
    })
    return Object.freeze(rows.map(hydrateSelection))
  }

  async resolveSelectableForMember(input: Parameters<WorkspaceMemberRepository['resolveSelectableForMember']>[0]) {
    const current = await this.client.v2WorkspaceMember.findFirst({
      where: { id: input.memberId, status: 'active', identity: { status: 'active' } },
      select: { identityId: true },
    })
    if (!current) return null
    const row = await this.client.v2WorkspaceMember.findFirst({
      where: {
        identityId: current.identityId,
        workspaceId: input.workspaceId,
        status: 'active',
        identity: { status: 'active' },
        workspace: { status: 'active', uiPrincipal: { is: { client: { status: 'active' } } } },
      },
      include: { workspace: { include: { uiPrincipal: true } } },
    })
    return row ? hydrateSelection(row) : null
  }

  async resolveActiveOidcMembership(input: Parameters<WorkspaceMemberRepository['resolveActiveOidcMembership']>[0]) {
    const row = await this.client.v2WorkspaceMember.findFirst({
      where: {
        status: 'active',
        identity: { issuer: input.issuer, subjectHash: input.subjectHash, status: 'active' },
        workspace: { status: 'active', uiPrincipal: { is: { client: { status: 'active' } } } },
      },
      include: { workspace: { include: { uiPrincipal: true } } },
      orderBy: [{ createdAt: 'asc' }, { workspaceId: 'asc' }],
    })
    return row ? hydrateSelection(row) : null
  }
}
