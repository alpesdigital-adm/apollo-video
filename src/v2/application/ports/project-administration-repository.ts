import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { Project } from '../../domain/project.ts'
import type {
  ProjectAdministrationCommand,
  ProjectAdministrationState,
} from '../../domain/project-administration-command.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

export interface AdministrableProject {
  project: Readonly<Project>
  state: Readonly<ProjectAdministrationState>
}

export interface ProjectAdministrationResult extends AdministrableProject {
  command: Readonly<ProjectAdministrationCommand>
  replayed: boolean
}

export interface ProjectAdministrationRepository {
  findReplay(input: {
    workspaceId: string
    actorContextHash: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<Readonly<ProjectAdministrationResult> | null>
  read(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<AdministrableProject> | null>
  apply(input: {
    project: Readonly<Project>
    command: Readonly<ProjectAdministrationCommand>
    audit: Readonly<ApiAccessAuditContext>
    event: Readonly<PublicEvent>
  }): Promise<Readonly<ProjectAdministrationResult>>
}
