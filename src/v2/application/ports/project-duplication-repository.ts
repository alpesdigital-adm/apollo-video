import type { Project } from '../../domain/project.ts'
import type { ProjectVersionV2 } from '../../domain/project-version.ts'
import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ProjectCreationOutputCommandV2 } from '../../domain/project-creation-command.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { OperationalOutputParentV3, CreationOutputVersionBundleV2 } from '../../domain/output-version-bundle.ts'
import type { ProjectForkDerivationBodyV3, ProjectForkCallerRequestV3, ForkMediaReferenceFactsV2, V2RenderablePlanSnapshotFacts } from '../../domain/project-fork-derivation.ts'
import type { CreationOutputBundleWriteV2 } from './output-version-bundle-repository.ts'

export interface ProjectDuplicationSource {
  project: Readonly<Project>
  version: OperationalOutputParentV3['version']
  bundle: OperationalOutputParentV3
  projectFacts: ProjectForkDerivationBodyV3['sourceProject']
  renderablePlanSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null
  snapshots: readonly Readonly<ProjectSnapshot>[]
  media: readonly Readonly<Omit<ForkMediaReferenceFactsV2, 'targetLinkId'>>[]
}

export interface ProjectDuplicationBundle {
  sourceProjectId: string
  sourceVersionId: string
  sourceVersionHash: string
  /** Immutable creation metadata, never a claim about the current head. */
  project: Readonly<Omit<Project, 'currentVersionId'>>
  version: Readonly<ProjectVersionV2>
  bundle: Readonly<CreationOutputVersionBundleV2>
  write: Readonly<CreationOutputBundleWriteV2>
  snapshots: readonly Readonly<ProjectSnapshot>[]
  media: readonly Readonly<{
    id: string
    artifactId: string
    role: string
    originalFileName: string
    createdAt: string
  }>[]
  auditCommand: Readonly<ProjectCreationOutputCommandV2>
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
  project: Readonly<Omit<Project, 'currentVersionId'>>
  version: Readonly<ProjectVersionV2>
  bundle: Readonly<CreationOutputVersionBundleV2>
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
    callerRequest: Readonly<ProjectForkCallerRequestV3>
  }): Promise<Readonly<ProjectDuplicationResult> | null>
  readSource(input: {
    workspaceId: string
    projectId: string
  }): Promise<Readonly<ProjectDuplicationSource> | null>
  duplicateOrReplay(
    bundle: Readonly<ProjectDuplicationBundle>,
  ): Promise<Readonly<ProjectDuplicationResult>>
}
