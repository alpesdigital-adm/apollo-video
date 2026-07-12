import type { Project } from '../../domain/project.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'

export interface ProjectCreationIdempotency {
  id: string
  workspaceId: string
  clientId: string
  key: string
  requestFingerprint: string
  expiresAt: string
}

export interface ProjectCreationBundle {
  project: Project
  version: ProjectVersion
  snapshots: readonly ProjectSnapshot[]
  idempotency: ProjectCreationIdempotency
}

export interface ProjectCreationResult {
  project: Project
  version: ProjectVersion
  replayed: boolean
}

export interface ProjectCreationRepository {
  createOrReplay(bundle: ProjectCreationBundle): Promise<ProjectCreationResult>
}
