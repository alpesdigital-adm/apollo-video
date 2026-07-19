import type { EditorialCutEditPlan } from '../apply-editorial-cut-command.ts'
import type { DirectorRun, RunDirectorCommandPayload } from '../../domain/director-run.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersion } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

export interface DirectorRunContext {
  workspaceId: string
  project: Readonly<{
    id: string
    objective: string
    format: string
    locale: string
  }>
  currentVersion: Readonly<ProjectVersion>
  brief: Readonly<Record<string, unknown>>
  policies: Readonly<Record<string, unknown>>
  editPlan: Readonly<EditorialCutEditPlan>
  transcript: Readonly<{
    id: string
    sourceArtifactId: string
    language: string
    provider: string
    model: string
    transcriptHash: string
  }>
}

export interface DirectorRunCommit {
  command: Readonly<EditCommand<RunDirectorCommandPayload>>
  requestFingerprint: string
  snapshots: readonly Readonly<ProjectSnapshot>[]
  version: Readonly<ProjectVersion>
  run: Readonly<DirectorRun>
  event: Readonly<PublicEvent>
  sourceEvidence: Readonly<{
    transcriptId: string
    transcriptHash: string
    sourceArtifactId: string
  }>
}

export interface DirectorRunResult {
  run: Readonly<DirectorRun>
  command: Readonly<EditCommand<RunDirectorCommandPayload>>
  version: Readonly<ProjectVersion>
  replayed: boolean
}

export interface DirectorRunRepository {
  findIdempotentResult(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<{ requestFingerprint: string; result: DirectorRunResult }> | null>
  readContext(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<DirectorRunContext> | null>
  commitOrReplay(input: DirectorRunCommit): Promise<Readonly<DirectorRunResult>>
}
