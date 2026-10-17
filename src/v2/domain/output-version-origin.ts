import { type ApiAccessAuditContext } from './api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { createEditCommand, type CommandActor, type EditCommand } from './edit-command.ts'
import { assertDomain } from './errors.ts'
import { type DirectorRun, type RunDirectorCommandPayload } from './director-run.ts'
import type { PersistedManualEditPayload } from './manual-editing.ts'
import { assertMediaArtifactManifest, type MediaArtifactManifest } from './media-artifact.ts'
import { calculateOutputCanonicalHash, serializeOutputCanonicalJson, validateOutputCanonicalPolicy,
  type OutputCanonicalPolicy } from './output-canonical-policy.ts'
import { createOutputVariantCommand, type CreateOutputVariantCommandInput } from './output-variant-command.ts'
import { validateProjectCreationOutputCommandV2, createProjectCreationCommand, createProjectCreationCommandV2, normalizeProjectCreationIntentV2, indexForkIdentityBijectionV2,
  type V2RenderablePlanSnapshotFacts,
  type ProjectCreationCommand, type ProjectCreationCommandV2, type ProjectCreationCallerIntentV2 } from './project-creation-command.ts'
import type { ProjectSnapshot } from './project-snapshot.ts'
import { forkOwnedIdentities, validateForkSourceBundle as validateBundleFacts, validateForkRenderableFacts as validateForkRenderableSnapshot, validateForkCropDecisions as validateForkCropIntents, createProjectForkDerivation, createForkRenderablePlanCandidate,
  PROJECT_FORK_COMPILE_POLICY_VERSION, type ProjectForkDerivation, type ForkRenderablePlanCandidate } from './project-fork-derivation.ts'
export { forkOwnedIdentities, remapForkSnapshotDocument } from './project-fork-derivation.ts'
import { assertPublicOperation, type PublicOperation } from './public-operation.ts'
import { requireOutputId, type SealedOutputDocument } from './output-spec-revision.ts'
import type { OutputVersionBundle } from './output-version-bundle.ts'

/** Isolated proposal. Nothing here persists facts, admits a render, emits a
 * State/Version or upgrades contract zero. Missing real contracts stay blocked.
 * Existing authority is revalidated by its existing constructors, never replaced
 * by a new arbitrary document/hash receipt. */
export const OUTPUT_VERSION_ORIGIN_KINDS = ['creation-empty', 'fork-with-content',
  'create-output-variant', 'revise-output-spec', 'ingest-operation', 'director-command',
  'inherit-command', 'restore-command'] as const
export type OutputVersionOriginKind = (typeof OUTPUT_VERSION_ORIGIN_KINDS)[number]
export interface OutputOriginAllocation {
  workspaceId: string; projectId: string; resultVersionId: string; stateId: string
  parentVersionId: string | null; sequence: number; createdBy: string; createdAt: string
}
export const FORK_IDENTITY_KINDS = ['version', 'state', 'snapshot', 'edit-plan', 'renderable-plan',
  'renderable-snapshot', 'variant', 'revision', 'overlay', 'invalidation', 'plan-source', 'track', 'clip', 'cue',
  'marker', 'protected-element', 'transition'] as const
export type ForkIdentityKind = (typeof FORK_IDENTITY_KINDS)[number]
export interface ForkIdentityRemap { kind: ForkIdentityKind; sourceId: string; targetId: string }
export interface ForkCropDecisionDraft {
  sourceOverlayId: string; sourceOverlayHash: string; newOverlayId: string
  newVariantId: string; newClipId: string; copiedDocument: Readonly<SealedOutputDocument>
  author: Readonly<CommandActor>; createdAt: string
  // A copied crop intent is not active geometry. No arbitrary dependency hash
  // can turn missing rematerialization into a verified crop or critic acceptance.
  geometryStatus: 'requires-target-materialization'
}
interface CommonOriginDraft extends OutputCanonicalPolicy {
  schemaVersion: 'output-version-origin-draft/v1'
  allocation: Readonly<OutputOriginAllocation>
  base: Readonly<OutputVersionBundle> | null
}
export type OutputVersionOriginDraft = CommonOriginDraft & Readonly<
  { kind: 'creation-empty'; command: Readonly<ProjectCreationCommand> | null;
    commandV2: Readonly<ProjectCreationCommandV2> | null } |
  { kind: 'fork-with-content'; command: Readonly<ProjectCreationCommand> | null;
    source: Readonly<OutputVersionBundle>; sourceRenderablePlanSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null; identityMap: readonly Readonly<ForkIdentityRemap>[];
    cropDecisions: readonly Readonly<ForkCropDecisionDraft>[];
    commandV2: Readonly<ProjectCreationCommandV2> | null } |
  { kind: 'create-output-variant' | 'revise-output-spec'; result: ReturnType<typeof createOutputVariantCommand> } |
  { kind: 'ingest-operation'; operation: Readonly<PublicOperation>;
    sourceManifest: Readonly<MediaArtifactManifest>; normalizedManifest: Readonly<MediaArtifactManifest> } |
  { kind: 'director-command'; command: Readonly<EditCommand<RunDirectorCommandPayload>>;
    run: Readonly<DirectorRun> } |
  { kind: 'inherit-command'; command: Readonly<EditCommand> } |
  { kind: 'restore-command'; command: Readonly<EditCommand<PersistedManualEditPayload>>;
    target: Readonly<OutputVersionBundle> }
>
export type OutputOriginMissingFact = 'creation-command-v2-persisted-intent' |
  'fork-complete-target-rematerialization' | 'fork-new-crop-command-audit' | 'fork-new-renderable-derivation-authority' |
  'ingest-operation-detail-and-fence' | 'original-normalized-render-source-clock-receipt' |
  'director-result-state-geometry-effects' | 'exact-geometry-and-invalidation-effects' |
  'restore-target-base-hash-and-command-binding'
export type OutputOriginInspection = Readonly<
  { status: 'ready-for-existing-bundle-only'; kind: 'create-output-variant' | 'revise-output-spec' } |
  { status: 'blocked'; kind: OutputVersionOriginKind; missing: readonly OutputOriginMissingFact[] }
>
function object(value: unknown): Record<string, unknown> {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value),
    'INVALID_COMMAND', 'Origin requires an explicit object')
  return value as Record<string, unknown>
}
function exact(value: unknown, keys: readonly string[]): void {
  const record = object(value), actual = Object.keys(record)
  assertDomain(actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key)),
    'INVALID_COMMAND', 'Origin fields are missing or unsupported')
}
function same(left: unknown, right: unknown): boolean {
  return calculateOutputCanonicalHash(left) === calculateOutputCanonicalHash(right)
}


function blocked(kind: OutputVersionOriginKind, ...missing: OutputOriginMissingFact[]): OutputOriginInspection {
  return Object.freeze({ status: 'blocked', kind, missing: Object.freeze(missing) })
}
/** Inspection deliberately returns no future producerHash or persistence grant. */
export function inspectOutputVersionOriginDraft(input: OutputVersionOriginDraft): OutputOriginInspection {
  // New allocation fields are strict JSON. Historical Command constructors keep
  // their own serializer; their optional undefined scope fields are not rehashed
  // under the new W66 policy. This draft itself is never a sealed authority.
  serializeOutputCanonicalJson(input.allocation)
  validateOutputCanonicalPolicy(input)
  const { allocation, base } = input
  exact(allocation, ['workspaceId', 'projectId', 'resultVersionId', 'stateId', 'parentVersionId', 'sequence', 'createdBy', 'createdAt'])
  for (const key of ['workspaceId', 'projectId', 'resultVersionId', 'stateId', 'createdBy'] as const) requireOutputId(allocation[key], key)
  assertDomain(Number.isSafeInteger(allocation.sequence) && allocation.sequence > 0 &&
    typeof allocation.createdAt === 'string' && Number.isFinite(Date.parse(allocation.createdAt)) &&
    new Date(allocation.createdAt).toISOString() === allocation.createdAt,
  'INVALID_PROJECT_VERSION', 'Origin allocation must use explicit sequence and canonical time')
  assertDomain(input.schemaVersion === 'output-version-origin-draft/v1' && OUTPUT_VERSION_ORIGIN_KINDS.includes(input.kind),
    'INVALID_COMMAND', 'Unknown output origin contract')
  const common = ['schemaVersion', 'canonicalPolicyVersion', 'kind', 'allocation', 'base']
  if (base) {
    validateBundleFacts(base)
    assertDomain(base.version.workspaceId === allocation.workspaceId && base.version.projectId === allocation.projectId &&
      allocation.parentVersionId === base.version.id && allocation.sequence === base.version.sequence + 1 &&
      allocation.resultVersionId !== base.version.id && allocation.stateId !== base.state.document.id,
    'INVALID_PROJECT_VERSION', 'Origin requires the exact operational base and new allocated identities')
  } else assertDomain(allocation.parentVersionId === null && allocation.sequence === 1 &&
    (input.kind === 'creation-empty' || input.kind === 'fork-with-content'),
  'INVALID_PROJECT_VERSION', 'Only explicit creation origins may have no base')
  switch (input.kind) {
    case 'creation-empty':
    case 'fork-with-content': {
      exact(input, [...common, 'command', 'commandV2', ...(input.kind === 'fork-with-content' ? ['source', 'sourceRenderablePlanSnapshot', 'identityMap', 'cropDecisions'] : [])])
      assertDomain((input.command === null) !== (input.commandV2 === null), 'INVALID_COMMAND', 'Creation origin requires exactly one explicit Command version')
      const legacy = input.command === null ? null : createProjectCreationCommand(input.command)
      const v2 = input.commandV2 === null ? null : buildProjectCreationOriginCommandV2({
        ...input.commandV2, allocation, callerIntent: input.commandV2.payload.callerIntent.kind === 'initialize-empty'
          ? { ...input.commandV2.payload.callerIntent, desiredAction: {
            ...(input.commandV2.payload.callerIntent.desiredAction.destination ? { destination: input.commandV2.payload.callerIntent.desiredAction.destination } : {}),
            ...(input.commandV2.payload.callerIntent.desiredAction.verbalCta ? { verbalCta: input.commandV2.payload.callerIntent.desiredAction.verbalCta } : {}),
            ...(input.commandV2.payload.callerIntent.desiredAction.visualCta ? { visualCta: input.commandV2.payload.callerIntent.desiredAction.visualCta } : {}),
            disclosures: input.commandV2.payload.callerIntent.desiredAction.disclosures } }
          : input.commandV2.payload.callerIntent,
        snapshots: input.commandV2.payload.snapshots,
        source: input.kind === 'fork-with-content' ? input.source : null,
        identityMap: input.kind === 'fork-with-content' ? input.identityMap : [],
        cropDecisions: input.kind === 'fork-with-content' ? input.cropDecisions : [],
        sourceRenderablePlanSnapshot: input.kind === 'fork-with-content' ? input.sourceRenderablePlanSnapshot : null,
        targetRenderablePlanCandidate: input.commandV2.payload.renderablePlan?.targetCandidate ?? null,
        derivationId: input.commandV2.payload.forkDerivation?.document.id ?? null,
      })
      if (v2) assertDomain(same(v2, input.commandV2), 'INVALID_COMMAND', 'Creation V2 seal or actual graph mismatch')
      const command = legacy ?? { ...v2!, action: v2!.payload.callerIntent.kind === 'initialize-empty' ? 'create' : 'duplicate',
        sourceProjectId: v2!.payload.sourceBaseline?.projectId, sourceVersionId: v2!.payload.sourceBaseline?.versionId }
      assertDomain(base === null && (legacy === null || legacy.commandHash === input.command!.commandHash) &&
        command.workspaceId === allocation.workspaceId && command.projectId === allocation.projectId && command.versionId === allocation.resultVersionId &&
        command.audit.clientId === allocation.createdBy && command.createdAt === allocation.createdAt &&
        command.action === (input.kind === 'creation-empty' ? 'create' : 'duplicate'),
      'INVALID_COMMAND', 'Creation origin must bind its actual Command version, actor, time and allocation')
      if (input.kind === 'fork-with-content') {
        const identities = forkOwnedIdentities(input.source, input.sourceRenderablePlanSnapshot)
        const index = indexForkIdentityBijectionV2(identities, input.identityMap)
        assertDomain(input.source.version.workspaceId === allocation.workspaceId && input.source.version.projectId !== allocation.projectId &&
          command.sourceProjectId === input.source.version.projectId && command.sourceVersionId === input.source.version.id,
        'INVALID_COMMAND', 'Fork source must be the exact independent project and Version')
        assertDomain(index.get('version:' + input.source.version.id) === allocation.resultVersionId &&
          index.get('state:' + input.source.state.document.id) === allocation.stateId,
        'INVALID_COMMAND', 'Fork Version and State mapping must equal allocation')
        validateForkCropIntents(input.source, input.cropDecisions, index, command.audit, command.createdAt)
        return blocked(input.kind, 'creation-command-v2-persisted-intent', 'fork-complete-target-rematerialization', 'fork-new-crop-command-audit',
          ...(input.sourceRenderablePlanSnapshot ? ['fork-new-renderable-derivation-authority' as const] : []))
      }
      // A domain V2 seal is not evidence that its intent/audit was persisted.
      return blocked(input.kind, 'creation-command-v2-persisted-intent')
    }
    case 'create-output-variant':
    case 'revise-output-spec': {
      exact(input, [...common, 'result']); assertDomain(base !== null, 'INVALID_COMMAND', 'Output origin requires a base')
      const { command, audit } = input.result, payload = command.payload
      assertDomain(command.type === input.kind, 'INVALID_COMMAND', 'Origin kind cannot reinterpret a different Command type')
      const durationFrames = object(base.facts.renderablePlanDocument ?? base.facts.editPlanDocument).durationFrames as number
      // Narrow only after the guard. Pass the actual Command object unchanged;
      // never overwrite its type to regenerate a different Command authority.
      const fresh = createOutputVariantCommand({ command: command as CreateOutputVariantCommandInput['command'], audit,
        base: base.version, baseState: base.state, historicalBaselineRequested: false, revision: payload.revision,
        expectedRevisionId: payload.expectedRevisionId, expectedSpecHash: payload.expectedSpecHash, durationFrames })
      assertDomain(command.type === input.kind && command.createdAt === allocation.createdAt && command.author.id === allocation.createdBy &&
        stableSerialize(input.result) === stableSerialize(fresh), 'INVALID_COMMAND', 'Output origin must match its real Command and exact base facts')
      return Object.freeze({ status: 'ready-for-existing-bundle-only', kind: input.kind })
    }
    case 'ingest-operation': {
      exact(input, [...common, 'operation', 'sourceManifest', 'normalizedManifest'])
      assertPublicOperation(input.operation)
      assertMediaArtifactManifest(input.sourceManifest)
      assertMediaArtifactManifest(input.normalizedManifest)
      assertDomain(base !== null && input.operation.type === 'media-ingest' && input.operation.workspaceId === allocation.workspaceId &&
        input.operation.projectId === allocation.projectId && input.operation.clientId === allocation.createdBy,
      'INVALID_COMMAND', 'Ingest origin must carry its actual scoped operation')
      return blocked(input.kind, 'ingest-operation-detail-and-fence', 'original-normalized-render-source-clock-receipt')
    }
    case 'director-command':
    case 'inherit-command':
    case 'restore-command': {
      exact(input, [...common, 'command', ...(input.kind === 'director-command' ? ['run'] : input.kind === 'restore-command' ? ['target'] : [])])
      assertDomain(base !== null, 'INVALID_COMMAND', 'Command origin requires an exact base')
      const command = createEditCommand(input.command as Parameters<typeof createEditCommand>[0])
      assertDomain(command.commandHash === input.command.commandHash && command.workspaceId === allocation.workspaceId &&
        command.projectId === allocation.projectId && command.baseVersionId === base.version.id && command.baseHash === base.version.baseHash &&
        command.author.id === allocation.createdBy && command.createdAt === allocation.createdAt,
      'INVALID_COMMAND', 'Origin Command must bind its actual base, actor and timestamp')
      if (input.kind === 'director-command') {
        const run = input.run
        assertDomain(command.type === 'run-director' && run.schemaVersion === 2 && run.workspaceId === allocation.workspaceId &&
          run.projectId === allocation.projectId && run.commandId === command.id && run.baseVersionId === base.version.id &&
          run.resultVersionId === allocation.resultVersionId && run.id === input.command.payload.directorRunId &&
          run.initiatedBy.id === allocation.createdBy && run.createdAt === allocation.createdAt,
        'INVALID_COMMAND', 'Director origin requires the exact run, Command, result, actor and time')
        return blocked(input.kind, 'director-result-state-geometry-effects')
      }
      if (input.kind === 'restore-command') {
        validateBundleFacts(input.target)
        assertDomain(input.target.version.workspaceId === allocation.workspaceId && input.target.version.projectId === allocation.projectId,
          'INVALID_COMMAND', 'Restore target must be explicit in the same workspace and project')
        return blocked(input.kind, 'restore-target-base-hash-and-command-binding')
      }
      return blocked(input.kind, 'exact-geometry-and-invalidation-effects')
    }
  }
}
/** Future integration constraint only, not a transaction implementation. Keep
 * final SET CONSTRAINTS ALL IMMEDIATE after ALL writes/events for each of the
 * sixteen writers, then await actual commit before hydrate/readback/return.
 * Seven existing CAS→outbox writers and three without outbox retain their own
 * contracts; this slice creates no new event. Real COMMIT/rollback proof pending. */
export const OUTPUT_ORIGIN_PERSISTENCE_STATUS = 'not-connected' as const

/** Builds a real V2 domain Command from explicit materialized facts; it does not
 * write the Command or target State. No old hash or fingerprint is reinterpreted. */
export function buildProjectCreationOriginCommandV2(input: Readonly<{
  id: string; audit: Readonly<ApiAccessAuditContext>; allocation: Readonly<OutputOriginAllocation>
  callerIntent: ProjectCreationCallerIntentV2; snapshots: readonly Readonly<ProjectSnapshot>[]
  source: Readonly<OutputVersionBundle> | null;
  sourceRenderablePlanSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null
  targetRenderablePlanCandidate: Readonly<ForkRenderablePlanCandidate> | null; derivationId: string | null; identityMap: readonly Readonly<ForkIdentityRemap>[]
  cropDecisions: readonly Readonly<ForkCropDecisionDraft>[]
}>): Readonly<ProjectCreationCommandV2> {
  const a = input.allocation, intent = normalizeProjectCreationIntentV2(input.callerIntent)
  assertDomain(a.parentVersionId === null && a.sequence === 1 && a.createdBy === input.audit.clientId &&
    a.workspaceId === input.audit.workspaceId, 'INVALID_COMMAND', 'Creation V2 root actor/allocation mismatch')
  const snapshots = input.snapshots, edit = snapshots.find((s) => s.kind === 'edit-plan')
  assertDomain(edit !== undefined, 'INVALID_COMMAND', 'Creation V2 requires its materialized EditPlan')
  const editDocument = object(JSON.parse(edit.contentJson))
  assertDomain(editDocument.projectVersionId === a.resultVersionId && editDocument.createdAt === a.createdAt,
    'INVALID_COMMAND', 'Creation V2 EditPlan must name the allocated Version and time')
  let sourceBaseline: import('./project-creation-command.ts').ProjectCreationSourceBaselineV2 | null = null
  let renderablePlan: import('./project-creation-command.ts').ForkRenderablePlanMaterializationV2 | null = null
  let forkDerivation: Readonly<ProjectForkDerivation> | null = null
  if (intent.kind === 'initialize-empty') {
    assertDomain(input.source === null && input.sourceRenderablePlanSnapshot === null && input.targetRenderablePlanCandidate === null && input.derivationId === null && input.identityMap.length === 0 && input.cropDecisions.length === 0 && snapshots.length === 3 &&
      editDocument.durationFrames === 0 && ['sources', 'videoTracks', 'overlayTracks', 'subtitleTracks', 'audioTracks', 'effectTracks']
        .every((key) => Array.isArray(editDocument[key]) && (editDocument[key] as unknown[]).length === 0),
    'INVALID_COMMAND', 'Creation V2 initialize-empty cannot hide source content')

  } else {
    assertDomain(input.source !== null, 'INVALID_COMMAND', 'Fork V2 requires actual source facts')
    const source = input.source
    validateBundleFacts(source)
    assertDomain(source.version.workspaceId === a.workspaceId && source.version.projectId !== a.projectId,
      'INVALID_COMMAND', 'Fork V2 source scope mismatch')
    const sourceCompiled = validateForkRenderableSnapshot(source, input.sourceRenderablePlanSnapshot)
    const ownedIdentities = forkOwnedIdentities(source, sourceCompiled), map = input.identityMap
    // This builder uses the actual inventory, never a caller-provided inventory seal.
    const index = indexForkIdentityBijectionV2(ownedIdentities, map)
    const sourceSnapshots = [source.nonOutputSnapshotFacts.brief, source.nonOutputSnapshotFacts.policies,
      source.nonOutputSnapshotFacts.treatment, source.nonOutputSnapshotFacts.story].filter((s): s is Readonly<ProjectSnapshot> => s !== null)
    const sourceEdit = { schemaVersion: 1 as const, id: source.state.document.editPlan.snapshotId,
      workspaceId: source.version.workspaceId, projectId: source.version.projectId, kind: 'edit-plan' as const,
      contentSchemaVersion: Number(object(source.facts.editPlanDocument).schemaVersion ?? 2),
      contentJson: stableSerialize(source.facts.editPlanDocument), contentHash: source.state.document.editPlan.hash,
      createdAt: source.version.createdAt }
    sourceSnapshots.push(sourceEdit)
    assertDomain(snapshots.length === sourceSnapshots.length && snapshots.every((s) => sourceSnapshots.some((old) => old.kind === s.kind)),
      'INVALID_COMMAND', 'Fork V2 must copy every source snapshot without critic/acceptance snapshots')
    validateForkCropIntents(source, input.cropDecisions, index, input.audit, a.createdAt)
    assertDomain(typeof input.derivationId === 'string', 'INVALID_COMMAND', 'Fork requires an explicitly preallocated derivation ID')
    forkDerivation = createProjectForkDerivation({ canonicalPolicyVersion: 'output-canonical-json/v1',
      schemaVersion: 'project-fork-derivation/v1', id: input.derivationId, callerIntent: intent, audit: input.audit,
      target: { ...a, commandId: input.id },
      source: { version: source.version, state: source.state, facts: source.facts, nonOutputSnapshotFacts: source.nonOutputSnapshotFacts,
        previousBaseHash: source.previousBaseHash, editCommandSeal: source.editCommandSeal, outputBaseHashJson: source.outputBaseHashJson },
      sourceRenderablePlanSnapshot: sourceCompiled, identityMap: map, cropDecisions: input.cropDecisions,
      compilePolicyVersion: PROJECT_FORK_COMPILE_POLICY_VERSION })
    assertDomain(sourceCompiled === null ? input.targetRenderablePlanCandidate === null : input.targetRenderablePlanCandidate !== null,
      'INVALID_COMMAND', 'Fork target compiled candidate presence mismatch')
    if (sourceCompiled && input.targetRenderablePlanCandidate) {
      const candidate = createForkRenderablePlanCandidate(input.targetRenderablePlanCandidate, forkDerivation)
      renderablePlan = { sourceSnapshotId: sourceCompiled.id, sourcePlanHash: sourceCompiled.planHash, targetCandidate: candidate,
        targetDerivationStatus: 'requires-target-materialization' }
    }
    sourceBaseline = { workspaceId: source.version.workspaceId, projectId: source.version.projectId, versionId: source.version.id,
      baseHash: source.version.baseHash, stateId: source.state.document.id, stateHash: source.state.stateHash,
      snapshots: sourceSnapshots.map((s) => ({ kind: s.kind, id: s.id, hash: s.contentHash })),
      renderablePlanSnapshot: sourceCompiled, ownedIdentities }
  }
  return createProjectCreationCommandV2({ canonicalPolicyVersion: 'output-canonical-json/v1',
    id: input.id, workspaceId: a.workspaceId, projectId: a.projectId, versionId: a.resultVersionId, audit: input.audit, createdAt: a.createdAt,
    payload: { canonicalPolicyVersion: 'output-canonical-json/v1', schemaVersion: 'project-creation-payload/v2', callerIntent: intent,
      sourceBaseline, allocations: { stateId: a.stateId, snapshotRefs: Object.fromEntries(snapshots.map((s) => [s.kind, s.id])),
        renderablePlanSnapshotId: renderablePlan?.targetCandidate.id ?? null },
      snapshots, renderablePlan, forkDerivation, identityMap: input.identityMap, cropDecisions: input.cropDecisions as unknown as readonly import('./output-spec-revision.ts').OutputJson[] } })
}

/** Persisted Creation2 has a complete bundle authority, but no operational
 * materialization/critic acceptance. The runtime cutover must use the shared
 * persisted State gate, not this read-only domain inspection as permission. */
export function inspectCreationOutputOriginV2(commandInput: import('./project-creation-command.ts').ProjectCreationOutputCommandV2) {
  const command = validateProjectCreationOutputCommandV2(commandInput)
  return Object.freeze({ status: 'blocked' as const, kind: command.payload.callerIntent.kind,
    commandId: command.id, commandHash: command.commandHash,
    missing: Object.freeze(command.payload.callerIntent.kind === 'fork-with-content'
      ? ['persisted-target-geometry-normalization-clock', 'target-transcript-perception-authority', 'new-critic-and-current-rights']
      : ['explicit-output-variant-command', 'ingest-materialized-source-authority']) })
}


import { createMediaTranscript, type MediaTranscript } from './media-transcript.ts'
import { requireOutputHash } from './output-spec-revision.ts'
import type { ProjectVersionV2, ProjectVersionV3 } from './project-version.ts'
import type { ProjectOutputStateV2, ProjectOutputStateV3 } from './project-output-state.ts'
import { createEditorialSourceBindingV1 } from './output-materialization.ts'
import { CHILD_COMMAND_TRANSITIONS, type ChildCommandOriginV3 } from './output-child-command.ts'
import type { EditorialCutPayloadV3 } from './editorial-cut-impact.ts'
export type OperationalOutputOriginV3 = Readonly<
  { kind:'create-output-variant'|'revise-output-spec'; result:ReturnType<typeof createOutputVariantCommand> } |
  { kind:'ingest-operation'; operation:PublicOperation; requestFingerprint:string; leaseOwner:string;
    detail:Readonly<{uploadId:string;sourceArtifactId:string;sourceManifestId:string}>;
    transcript:Readonly<{id:string;workspaceId:string;projectId:string;sourceArtifactId:string;sourceManifestId:string;
      document:MediaTranscript;createdAt:string}> } |
  { kind:'editorial-cut-command'; command:EditCommand<EditorialCutPayloadV3>; audit:ApiAccessAuditContext; requestFingerprint:string } |
  { kind:'inherit-command'; command:EditCommand<PersistedManualEditPayload>; audit:ApiAccessAuditContext; requestFingerprint:string } |
  { kind:'restore-command'; command:EditCommand<PersistedManualEditPayload>; audit:ApiAccessAuditContext; requestFingerprint:string;
    target:Readonly<{versionId:string;baseHash:string;stateId:string;stateHash:string}> } |
  ChildCommandOriginV3
>
export function validateOperationalOutputOriginV3(input: OperationalOutputOriginV3,
  base: Readonly<{version:ProjectVersionV2|ProjectVersionV3;state:ProjectOutputStateV2|ProjectOutputStateV3}>,
  allocation:OutputOriginAllocation): OperationalOutputOriginV3 {
  assertDomain(base.version.outputContractVersion===2||base.version.outputContractVersion===3,
    'PRECONDITION_REQUIRED','State3 never upgrades historical unsealed versions')
  assertDomain(allocation.workspaceId===base.version.workspaceId && allocation.projectId===base.version.projectId &&
    allocation.parentVersionId===base.version.id && allocation.sequence===base.version.sequence+1,
    'VERSION_CONFLICT','Operational origin requires exact base and allocation')
  if(input.kind==='ingest-operation') {
    exact(input,['kind','operation','requestFingerprint','leaseOwner','detail','transcript'])
    assertPublicOperation(input.operation)
    const op=input.operation,t=input.transcript
    requireOutputHash(input.requestFingerprint,'ingest request fingerprint');requireOutputId(input.leaseOwner,'ingest lease owner')
    exact(input.detail,['uploadId','sourceArtifactId','sourceManifestId'])
    assertDomain(op.type==='media-ingest' && op.status==='running' && op.phase==='persisting' &&
      op.projectId===allocation.projectId && op.workspaceId===allocation.workspaceId && op.clientId===allocation.createdBy &&
      op.target.type==='media-artifact' && op.target.id===input.detail.sourceArtifactId &&
      op.target.manifestId===input.detail.sourceManifestId && op.attempt>0 &&
      t.workspaceId===allocation.workspaceId && t.projectId===allocation.projectId &&
      t.sourceArtifactId===input.detail.sourceArtifactId && t.sourceManifestId===input.detail.sourceManifestId,
      'INVALID_COMMAND','Ingest operation/detail/transcript identity differs')
    const {schemaVersion:_schema,transcriptHash:_seal,...facts}=t.document,fresh=createMediaTranscript(facts)
    assertDomain(fresh.transcriptHash===t.document.transcriptHash && stableSerialize(fresh)===stableSerialize(t.document),
      'INVALID_COMMAND','Ingest transcript authority differs')
  } else if(input.kind==='child-command') {
    exact(input,['kind','command','audit','requestFingerprint','replaces'])
    const c=input.command,transition=CHILD_COMMAND_TRANSITIONS[c.type as keyof typeof CHILD_COMMAND_TRANSITIONS]
    assertDomain(transition!==undefined,'INVALID_COMMAND','Command type has no declared child output transition')
    assertDomain(c.workspaceId===allocation.workspaceId && c.projectId===allocation.projectId &&
      c.baseVersionId===base.version.id && c.baseHash===base.version.baseHash &&
      c.author.id===allocation.createdBy && c.createdAt===allocation.createdAt,
      'INVALID_COMMAND','Child Command scope/base/actor/time differs')
    const {schemaVersion:_schema,commandHash:_seal,...body}=c
    assertDomain(createEditCommand({...body,type:c.type} as unknown as Parameters<typeof createEditCommand>[0]).commandHash===c.commandHash,
      'INVALID_COMMAND','Child Command historical hash differs')
    if(c.type==='manual-edit') {
      // Selection and restore keep their dedicated, fully re-derived origins.
      const manual=c.payload as Partial<PersistedManualEditPayload>
      assertDomain(manual.action==='apply' && manual.operation!==undefined && manual.operation.kind!=='select',
        'INVALID_COMMAND','Manual selection and restore use their dedicated origin')
    }
    if(c.author.type==='api-client') {
      assertDomain(input.audit!==null && input.audit.workspaceId===allocation.workspaceId && input.audit.clientId===c.author.id &&
        input.audit.delegatedUserId===c.author.delegatedUserId,'INVALID_COMMAND','Child Command external actor audit differs')
    } else assertDomain(input.audit===null,'INVALID_COMMAND','Only an external actor carries a credential audit')
    requireOutputHash(input.requestFingerprint,'child request fingerprint')
    assertDomain(Array.isArray(input.replaces) && input.replaces.every((kind,index)=>transition!.replaces.includes(kind) &&
      (index===0||input.replaces[index-1]!<kind)),'INVALID_COMMAND','Child replacement kinds exceed the declared effect or are unsorted')
  } else {
    const result=input.kind==='create-output-variant'||input.kind==='revise-output-spec'?input.result:null
    const command=result?.command??('command' in input?input.command:null)
    assertDomain(command!==null && command.workspaceId===allocation.workspaceId && command.projectId===allocation.projectId &&
      command.baseVersionId===base.version.id && command.baseHash===base.version.baseHash &&
      command.author.id===allocation.createdBy && command.createdAt===allocation.createdAt,
      'INVALID_COMMAND','Operational Command scope/base/actor/time differs')
    const {schemaVersion:_schema,commandHash:_seal,...body}=command!
    const fresh=createEditCommand({...body,type:command!.type} as unknown as Parameters<typeof createEditCommand>[0])
    assertDomain(fresh.commandHash===command!.commandHash,'INVALID_COMMAND','Operational Command historical hash differs')
    if(result) {
      assertDomain(command!.type===input.kind,'INVALID_COMMAND','Variant origin cannot reinterpret Command type')
      const r=command!.payload as ReturnType<typeof createOutputVariantCommand>['command']['payload']
      const reconstructed=createOutputVariantCommand({command:{...command!,type:input.kind as 'create-output-variant'|'revise-output-spec'},
        audit:result.audit,base:base.version,baseState:base.state,historicalBaselineRequested:false,revision:r.revision,
        expectedRevisionId:r.expectedRevisionId,expectedSpecHash:r.expectedSpecHash,
        durationFrames:0})
      // Impact duration is checked against the actual plan by the bundle builder.
      assertDomain(reconstructed.requestFingerprint===result.requestFingerprint,'INVALID_COMMAND','Variant request seal differs')
    } else if(input.kind==='editorial-cut-command') {
      exact(input,['kind','command','audit','requestFingerprint'])
      const c=input.command,p=c.payload,b=createEditorialSourceBindingV1(p.sourceBinding.document)
      exact(p,['schemaVersion','sourceTranscriptId','sourceArtifactId','variantId','rules','exclusions','sourceBinding','editPlanHash','audioProjection','impact',
        ...(p.exclusionOverrides===undefined?[]:['exclusionOverrides'])])
      const d=b.document
      requireOutputHash(p.editPlanHash,'editorial plan seal')
      assertDomain(c.type==='remove-spoken-content'&&p.schemaVersion===3&&c.author.type==='api-client'&&
        input.audit.workspaceId===allocation.workspaceId&&input.audit.clientId===allocation.createdBy&&
        input.audit.delegatedUserId===c.author.delegatedUserId&&b.bindingHash===p.sourceBinding.bindingHash&&
        d.workspaceId===allocation.workspaceId&&d.projectId===allocation.projectId&&d.parentVersionId===base.version.id&&
        d.parentStateId===base.state.document.id&&d.parentStateHash===base.state.stateHash&&d.resultVersionId===allocation.resultVersionId&&
        d.createdAt===allocation.createdAt&&p.sourceTranscriptId===d.transcript.id&&p.sourceArtifactId===d.transcript.sourceArtifactId&&
        base.state.document.entries.some(e=>e.variantId===p.variantId)&&stableSerialize(c.scope)===stableSerialize({project:true})&&
        input.requestFingerprint===calculateCanonicalHash({type:'remove-spoken-content',workspaceId:c.workspaceId,projectId:c.projectId,
          baseVersionId:c.baseVersionId,baseHash:c.baseHash,sourceTranscriptId:p.sourceTranscriptId,variantId:p.variantId,rules:p.rules,
          exclusionOverrides:p.exclusionOverrides??null,reason:c.reason?.trim()||null,actorContextHash:input.audit.contextHash}),
        'INVALID_COMMAND','Editorial source binding, actor, intent or exact parent differs')
      assertDomain(p.rules.length>0&&p.exclusions.length>0&&p.exclusions.every((x,i)=>Number.isFinite(x.sourceStartSeconds)&&
        Number.isFinite(x.sourceEndSeconds)&&x.sourceStartSeconds>=0&&x.sourceEndSeconds>x.sourceStartSeconds&&
        (i===0||x.sourceStartSeconds>=p.exclusions[i-1]!.sourceEndSeconds)&&x.ruleIds.length>0&&
        x.ruleIds.every(id=>p.rules.some(r=>r.id===id))), 'INVALID_COMMAND','Editorial exclusions/rules differ')
    } else {
      exact(input,input.kind==='inherit-command'?['kind','command','audit','requestFingerprint']:['kind','command','audit','requestFingerprint','target'])
      const payload=command!.payload as PersistedManualEditPayload
      // Control flow cannot see that `result` already consumed the variant kinds; only inherit/restore reach here.
      const manual=input as Extract<typeof input,{kind:'inherit-command'|'restore-command'}>
      assertDomain(base.version.outputContractVersion===3,'PRECONDITION_REQUIRED','Manual origin requires an operational State3 base')
      assertDomain(command!.schemaVersion===1 && command!.author.type==='api-client' &&
        manual.audit.workspaceId===allocation.workspaceId && manual.audit.clientId===allocation.createdBy &&
        manual.audit.delegatedUserId===command!.author.delegatedUserId &&
        manual.requestFingerprint===calculateCanonicalHash({type:'manual-edit',workspaceId:command!.workspaceId,
          projectId:command!.projectId,baseVersionId:command!.baseVersionId,baseHash:command!.baseHash,
          expectedRevision:payload.expectedRevision,action:payload.action,variantId:payload.variantId,targetId:payload.targetId,
          operation:payload.operation??null,targetVersionId:payload.restoresVersionId??null,reason:command!.reason?.trim()||null,
          actorContextHash:manual.audit.contextHash}),'INVALID_COMMAND','Manual origin request/audit authority differs')
      assertDomain(command!.type==='manual-edit','INVALID_COMMAND','Only typed manual inheritance/restore admitted by this slice')
      exact(payload,['schemaVersion','action','expectedRevision','variantId','targetId','impact',
        ...(input.kind==='inherit-command'?['operation']:['restoresVersionId'])])
      assertDomain(payload.schemaVersion===2 && payload.expectedRevision===base.version.sequence &&
        base.state.document.entries.some(e=>e.variantId===payload.variantId) &&
        stableSerialize(command!.scope)===stableSerialize({clipIds:[payload.targetId],outputSpecIds:[payload.variantId]}),
        'INVALID_COMMAND','Manual expected revision/variant/scope differs from exact State')
      if(input.kind==='inherit-command') {
        assertDomain(payload.action==='apply' && payload.operation?.kind==='select' && payload.operation.clipId===payload.targetId && payload.impact?.renderSemanticsChanged===false &&
          payload.impact.baseVersionId===base.version.id && payload.impact.resultVersionId===allocation.resultVersionId,
          'INVALID_COMMAND','Inheritance must be a real render-free selection Command')
      } else {
        assertDomain(input.kind==='restore-command','INVALID_COMMAND','Unsupported manual origin')
        exact(input.target,['versionId','baseHash','stateId','stateHash'])
        assertDomain(input.kind==='restore-command' && ['restore','undo','redo'].includes(payload.action) &&
          payload.restoresVersionId===input.target.versionId && input.target.versionId!==allocation.resultVersionId &&
          payload.operation===undefined,
          'INVALID_COMMAND','Restore requires its exact target and real Command')
        for(const h of [input.target.baseHash,input.target.stateHash])requireOutputHash(h,'restore target seal')
      }
    }
  }
  return input
}
