import type { PrismaClient as SqlitePrismaClient } from '@prisma/client'

import type { ApiClientRepository } from '../application/ports/api-client-repository.ts'
import type { ApiClientAdministrationRepository } from '../application/ports/api-client-administration-repository.ts'
import type { ProjectCreationRepository } from '../application/ports/project-creation-repository.ts'
import type { ProjectQueryRepository } from '../application/ports/project-query-repository.ts'
import type { WorkspaceRepository } from '../application/ports/workspace-repository.ts'
import { prisma } from '../../lib/db.ts'
import { resolveV2PersistenceMode } from './persistence-mode.ts'
import { PrismaApiClientRepository } from './prisma/api-client-repository.ts'
import { PrismaProjectCreationRepository } from './prisma/project-creation-repository.ts'
import { PrismaProjectQueryRepository } from './prisma/project-query-repository.ts'
import { PrismaWorkspaceRepository } from './prisma/workspace-repository.ts'
import { getV2PostgresClient } from './prisma-postgres/client.ts'

// The two generated clients expose the same v2 model delegates. This cast is
// kept at the persistence boundary so application and public API code remain
// provider-agnostic while the SQLite prototype still exists.
function resolveV2Client(): SqlitePrismaClient {
  if (resolveV2PersistenceMode() === 'postgres') {
    return getV2PostgresClient() as unknown as SqlitePrismaClient
  }

  return prisma
}

export function createApiClientRepository(): ApiClientRepository {
  return new PrismaApiClientRepository(resolveV2Client())
}

export function createApiClientAdministrationRepository(): ApiClientAdministrationRepository {
  return new PrismaApiClientRepository(resolveV2Client())
}

export function createProjectCreationRepository(): ProjectCreationRepository {
  return new PrismaProjectCreationRepository(resolveV2Client())
}

export function createProjectQueryRepository(): ProjectQueryRepository {
  return new PrismaProjectQueryRepository(resolveV2Client())
}

export function createWorkspaceRepository(): WorkspaceRepository {
  return new PrismaWorkspaceRepository(resolveV2Client())
}
