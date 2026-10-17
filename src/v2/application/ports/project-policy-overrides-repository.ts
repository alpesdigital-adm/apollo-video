import type { CommandArtifactInvalidationV1, CommandImpactOutputReference } from '../../domain/command-impact.ts'
import type { EditCommand } from '../../domain/edit-command.ts'
import type { OperationalOutputParentV3, OperationalOutputVersionBundleV3 } from '../../domain/output-version-bundle.ts'
import type { ProjectPolicyOverridesImpactV1 } from '../../domain/project-policy-overrides-impact.ts'
import type { ProjectOverrides, ResolvedProjectOverrides, WorkspaceProjectPolicyValues } from '../../domain/project-overrides.ts'
import type { ProjectSnapshot } from '../../domain/project-snapshot.ts'
import type { ProjectVersionV2, ProjectVersionV3 } from '../../domain/project-version.ts'
import type { PublicEvent } from '../../domain/public-event.ts'

export interface ProjectPolicyOverridesPayloadV1 {
  schemaVersion: 1
  overrides: Readonly<ProjectOverrides>
  policySnapshotId: string
  policySnapshotHash: string
  impact: Readonly<ProjectPolicyOverridesImpactV1>
  nextRequiredCapability: 'apollo.projects.commands.apply:run-director'
}

export interface ProjectPolicyOverridesContext {
  /** The sealed output bundle of the current head: the exact parent the Command's Version is born from. */
  parent: OperationalOutputParentV3
  currentPolicySnapshot: Readonly<{
    id: string
    contentSchemaVersion: number
    contentHash: string
    content: Readonly<Record<string, unknown>>
  }>
  currentDurationFrames: number
  proxyVariantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}

export interface ProjectPolicyOverridesResult {
  command: Readonly<EditCommand<ProjectPolicyOverridesPayloadV1>>
  version: Readonly<ProjectVersionV3>
  policySnapshot: Readonly<ProjectSnapshot>
  workspaceDefaults: Readonly<WorkspaceProjectPolicyValues>
  overrides: Readonly<ProjectOverrides>
  resolved: Readonly<ResolvedProjectOverrides>
  impact: Readonly<ProjectPolicyOverridesImpactV1>
  invalidations: readonly Readonly<CommandArtifactInvalidationV1>[]
  replayed: boolean
}

export interface CurrentProjectPolicyOverrides {
  version: Readonly<ProjectVersionV2 | ProjectVersionV3>
  policySnapshot: Readonly<{ id: string; contentSchemaVersion: number; contentHash: string }>
  workspaceDefaults: Readonly<WorkspaceProjectPolicyValues>
  overrides: Readonly<ProjectOverrides>
  resolved: Readonly<ResolvedProjectOverrides>
}

export interface ProjectPolicyOverridesCommit {
  /** Version, State, the unchanged EditPlan, the new Policy Snapshot, Command and credential audit, sealed together. */
  bundle: Readonly<OperationalOutputVersionBundleV3>
  workspaceDefaults: Readonly<WorkspaceProjectPolicyValues>
  overrides: Readonly<ProjectOverrides>
  resolved: Readonly<ResolvedProjectOverrides>
  event: Readonly<PublicEvent>
}

export interface ProjectPolicyOverridesRepository {
  findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorContextHash: string }): Promise<Readonly<{ requestFingerprint: string; result: Readonly<ProjectPolicyOverridesResult> }> | null>
  readContext(input: { workspaceId: string; projectId: string }): Promise<Readonly<ProjectPolicyOverridesContext> | null>
  readCurrent(input: { workspaceId: string; projectId: string }): Promise<Readonly<CurrentProjectPolicyOverrides> | null>
  commitOrReplay(input: Readonly<ProjectPolicyOverridesCommit>): Promise<Readonly<ProjectPolicyOverridesResult>>
}
