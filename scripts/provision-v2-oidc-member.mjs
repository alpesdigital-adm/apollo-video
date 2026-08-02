import { randomUUID } from 'node:crypto'

import { PrismaClient } from '../generated/prisma-v2/index.js'

import { provisionOidcWorkspaceMemberService } from '../src/v2/application/workspace-members.ts'
import { PrismaWorkspaceMemberRepository } from '../src/v2/infrastructure/prisma/workspace-member-repository.ts'
import {
  oidcIdentitySubjectHash,
  resolveOidcProviderConfiguration,
} from '../src/v2/infrastructure/security/oidc-provider.ts'

function argumentsMap(values) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid argument near ${key ?? '<end>'}`)
    result.set(key.slice(2), value)
  }
  return result
}

function required(map, name) {
  const value = map.get(name)?.trim()
  if (!value) throw new Error(`--${name} is required`)
  return value
}

const input = argumentsMap(process.argv.slice(2))
const workspaceId = required(input, 'workspace-id')
const role = required(input, 'role')
const subject = process.env.APOLLO_OIDC_BOOTSTRAP_SUBJECT
if (!subject || subject.length > 512) throw new Error('APOLLO_OIDC_BOOTSTRAP_SUBJECT is required and must remain outside command arguments')
const configuration = resolveOidcProviderConfiguration()
const client = new PrismaClient()

try {
  const workspace = await client.v2Workspace.findFirst({
    where: { id: workspaceId, status: 'active', uiPrincipal: { is: { client: { status: 'active' } } } },
    select: { id: true },
  })
  if (!workspace) throw new Error('Target workspace and its UI principal must both be active')
  const member = await provisionOidcWorkspaceMemberService({
    members: new PrismaWorkspaceMemberRepository(client), id: randomUUID,
  })({
    issuer: configuration.issuer,
    subjectHash: oidcIdentitySubjectHash(configuration.issuer, subject),
    workspaceId,
    role,
  })
  process.stdout.write(`${JSON.stringify({
    identityIssuer: configuration.issuer,
    workspaceId: member.workspaceId,
    memberId: member.id,
    identityId: member.identityId,
    role: member.role,
    status: member.status,
  }, null, 2)}\n`)
} finally {
  await client.$disconnect()
}
