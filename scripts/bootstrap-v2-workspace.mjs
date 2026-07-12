import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@apollo/prisma-v2-client'

import { createApiClientService } from '../src/v2/application/create-api-client.ts'
import { createWorkspace } from '../src/v2/domain/workspace.ts'
import { PrismaApiClientRepository } from '../src/v2/infrastructure/prisma/api-client-repository.ts'
import { PrismaWorkspaceRepository } from '../src/v2/infrastructure/prisma/workspace-repository.ts'
import { nodeApiCredentialCrypto } from '../src/v2/infrastructure/security/api-credential.ts'
import { FOUNDATION_CAPABILITIES } from '../src/v2/public-api/capability-registry.ts'

function readArguments(values) {
  const parsed = new Map()
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument near ${key ?? '<end>'}`)
    }
    parsed.set(key.slice(2), value)
  }
  return parsed
}

function requireArgument(argumentsMap, name) {
  const value = argumentsMap.get(name)?.trim()
  if (!value) throw new Error(`--${name} is required`)
  return value
}

const argumentsMap = readArguments(process.argv.slice(2))
const workspaceId = requireArgument(argumentsMap, 'workspace-id')
const workspaceSlug = requireArgument(argumentsMap, 'workspace-slug')
const workspaceName = requireArgument(argumentsMap, 'workspace-name')
const clientId = requireArgument(argumentsMap, 'client-id')
const clientName = requireArgument(argumentsMap, 'client-name')
const environment = requireArgument(argumentsMap, 'environment')
if (environment !== 'sandbox' && environment !== 'production') {
  throw new Error('--environment must be sandbox or production')
}

const scopes = [
  ...new Set(
    FOUNDATION_CAPABILITIES.flatMap((capability) => [...capability.requiredScopes]),
  ),
].sort()
const client = new PrismaClient()

try {
  const workspaceRepository = new PrismaWorkspaceRepository(client)
  const existingWorkspace = await workspaceRepository.findById(workspaceId)
  if (!existingWorkspace) {
    await workspaceRepository.create(
      createWorkspace({
        id: workspaceId,
        slug: workspaceSlug,
        name: workspaceName,
        status: 'active',
        createdAt: new Date().toISOString(),
      }),
    )
  } else if (
    existingWorkspace.slug !== workspaceSlug ||
    existingWorkspace.name !== workspaceName
  ) {
    throw new Error('Existing workspace does not match the requested slug/name')
  }

  const existingClient = await client.v2ApiClient.findUnique({ where: { id: clientId } })
  if (existingClient) {
    throw new Error(
      'Bootstrap client already exists; use the credential rotation endpoint instead',
    )
  }

  const issued = await createApiClientService({
    repository: new PrismaApiClientRepository(client),
    credentialCrypto: nodeApiCredentialCrypto,
    clock: () => new Date(),
  })({
    id: clientId,
    credentialId: `api-credential-${randomUUID()}`,
    workspaceId,
    name: clientName,
    environment,
    scopes,
  })

  process.stdout.write(
    `${JSON.stringify(
      {
        workspace: { id: workspaceId, slug: workspaceSlug },
        client: { id: issued.client.id, scopes: issued.client.scopes },
        credential: { id: issued.credential.id, token: issued.token },
        warning: 'Store the token now. Apollo cannot recover it later.',
      },
      null,
      2,
    )}\n`,
  )
} finally {
  await client.$disconnect()
}
