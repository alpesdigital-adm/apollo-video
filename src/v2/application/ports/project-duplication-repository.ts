import type { Project } from '../../domain/project.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ProjectCreationCommand } from '../../domain/project-creation-command.ts'

export interface ProjectDuplicationSource {
  project: Readonly<Project>
  version: Readonly<ProjectVersion>
  media: readonly Readonly<{
    artifactId: string
    role: string
    originalFileName: string
  }>[]
}

export interface ProjectDuplicationBundle {
  sourceProjectId: string
  sourceVersionId: string
  sourceVersionHash: string
  project: Readonly<Project>
  version: Readonly<ProjectVersion>
  media: readonly Readonly<{
    id: string
    artifactId: string
    role: string
    originalFileName: string
    createdAt: string
  }>[]
  auditCommand: Readonly<ProjectCreationCommand>
  idempotency: Readonly<{
    id: string
    workspaceId: string
    clientId: string
    key: string
    requestFingerprint: string
    expiresAt: string
  }>
}

export interface ProjectDuplicationResult {
  project: Readonly<Project>
  version: Readonly<ProjectVersion>
  sharedArtifactIds: readonly string[]
  copiedBytes: 0
  replayed: boolean
}

export interface ProjectDuplicationRepository {
  findIdempotent(input: {
    workspaceId: string
    clientId: string
    key: string
    requestFingerprint: string
    audit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<ProjectDuplicationResult> | null>
  readSource(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<ProjectDuplicationSource> | null>
  duplicateOrReplay(
    bundle: Readonly<ProjectDuplicationBundle>,
  ): Promise<Readonly<ProjectDuplicationResult>>
}
