import {
  createApiAccessAuditContext,
  type ApiAccessAuditContext,
} from './api-access-control.ts'
import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const PROJECT_CREATION_ACTIONS = ['create', 'duplicate'] as const
export type ProjectCreationAction = (typeof PROJECT_CREATION_ACTIONS)[number]

export interface ProjectCreationCommand {
  readonly schemaVersion: 1
  readonly id: string
  readonly workspaceId: string
  readonly action: ProjectCreationAction
  readonly projectId: string
  readonly versionId: string
  readonly sourceProjectId?: string
  readonly sourceVersionId?: string
  readonly audit: Readonly<ApiAccessAuditContext>
  readonly requestFingerprint: string
  readonly commandHash: string
  readonly createdAt: string
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/

export function createProjectCreationCommand(
  input: Omit<ProjectCreationCommand, 'schemaVersion' | 'commandHash'>,
): Readonly<ProjectCreationCommand> {
  assertDomain(
    ID_PATTERN.test(input.id) && ID_PATTERN.test(input.workspaceId) &&
      ID_PATTERN.test(input.projectId) && ID_PATTERN.test(input.versionId),
    'INVALID_ARGUMENT',
    'Project creation command identity is invalid',
  )
  assertDomain(
    PROJECT_CREATION_ACTIONS.includes(input.action) &&
      HASH_PATTERN.test(input.requestFingerprint),
    'INVALID_ARGUMENT',
    'Project creation command intent is invalid',
  )
  const hasSource = Boolean(input.sourceProjectId || input.sourceVersionId)
  assertDomain(
    input.action === 'duplicate'
      ? Boolean(
          input.sourceProjectId && input.sourceVersionId &&
          ID_PATTERN.test(input.sourceProjectId) && ID_PATTERN.test(input.sourceVersionId),
        )
      : !hasSource,
    'INVALID_ARGUMENT',
    'Project creation source does not match its action',
  )
  const audit = createApiAccessAuditContext({
    clientId: input.audit.clientId,
    credentialId: input.audit.credentialId,
    workspaceId: input.audit.workspaceId,
    environment: input.audit.environment,
    authenticationKind: input.audit.authenticationKind,
    ...(input.audit.delegatedUserId ? { delegatedUserId: input.audit.delegatedUserId } : {}),
    ...(input.audit.delegatedIdentityId
      ? { delegatedIdentityId: input.audit.delegatedIdentityId }
      : {}),
    ...(input.audit.workspaceRole ? { workspaceRole: input.audit.workspaceRole } : {}),
  })
  assertDomain(
    audit.contextHash === input.audit.contextHash && audit.workspaceId === input.workspaceId,
    'AUTH_INVALID',
    'Project creation command actor is invalid',
  )
  const createdAt = new Date(input.createdAt)
  assertDomain(
    !Number.isNaN(createdAt.getTime()),
    'INVALID_ARGUMENT',
    'Project creation command timestamp is invalid',
  )
  const canonical = {
    schemaVersion: 1 as const,
    id: input.id,
    workspaceId: input.workspaceId,
    action: input.action,
    projectId: input.projectId,
    versionId: input.versionId,
    sourceProjectId: input.sourceProjectId ?? null,
    sourceVersionId: input.sourceVersionId ?? null,
    actorContextHash: audit.contextHash,
    requestFingerprint: input.requestFingerprint,
    createdAt: createdAt.toISOString(),
  }
  return Object.freeze({
    ...input,
    audit,
    schemaVersion: 1 as const,
    createdAt: canonical.createdAt,
    commandHash: calculateCanonicalHash(canonical),
  })
}

// Separate V2 authority. V1 above remains byte-for-byte historical authority.
import { DomainError } from './errors.ts'
import { createDesiredAction, parseDesiredAction, parseDesiredActionInput, type DesiredActionInput, type DesiredAction } from './desired-action.ts'
import { normalizeProjectName } from './project.ts'
import { createProductionBrief } from './production-brief.ts'
import { parseBriefInterpretation, parseBriefInterpretationAudit } from './editorial-request.ts'
import { resolveStrategicObjective, type StrategicObjectiveId } from './strategic-objective.ts'
import { createProjectSnapshot, type ProjectSnapshot } from './project-snapshot.ts'
import { stableSerialize } from './canonical-hash.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION,
  serializeOutputCanonicalJson, validateOutputCanonicalPolicy, type OutputCanonicalPolicy } from './output-canonical-policy.ts'
import { freezeOutputJson, type OutputJson } from './output-spec-revision.ts'
import type { CommandActor } from './edit-command.ts'
import { FORK_IDENTITY_KINDS_V2, indexForkIdentityBijectionV2, createV2RenderablePlanSnapshotFacts, isForkIdentityV2,
  type ForkIdentityKindV2, type ForkIdentityRemapV2, type V2RenderablePlanSnapshotFacts,
  type ForkRenderablePlanMaterializationV2, type ProjectForkDerivation, createProjectForkDerivation,
  createForkRenderablePlanCandidate, forkOwnedIdentities, forkSourceSnapshotFacts, remapForkSnapshotDocument, materializeForkEditPlan } from './project-fork-derivation.ts'
export { FORK_IDENTITY_KINDS_V2, indexForkIdentityBijectionV2, createV2RenderablePlanSnapshotFacts } from './project-fork-derivation.ts'
export type { ForkIdentityKindV2, ForkIdentityRemapV2, V2RenderablePlanSnapshotFacts, ForkRenderablePlanMaterializationV2 } from './project-fork-derivation.ts'

/**
 * The brief a creation Command carries is the one its caller intent states, and nothing else. The one thing it may add is the READING of that same
 * briefing (ADR-160: the interpretation belongs to the text): an interpretation that is bound to the exact text (its hash and every citation are
 * checked against it) and the audit of the call that made it. A reading of other words, or any other extra content, is refused.
 */
function creationBriefMatchesIntent(contentJson: string, intent: Readonly<{ objective: StrategicObjectiveId; desiredAction: unknown; briefing: string | null }>, createdAt: string): boolean {
  const base = { schemaVersion: 1, objective: intent.objective, desiredAction: intent.desiredAction,
    productionBrief: createProductionBrief({ ...(intent.briefing === null ? {} : { ownerText: intent.briefing }) }), createdAt }
  if (contentJson === stableSerialize(base)) return true
  const document = JSON.parse(contentJson) as Record<string, unknown>
  const reading = document.editorialRequest as Record<string, unknown> | undefined
  if (intent.briefing === null || reading === undefined || reading === null || typeof reading !== 'object' || Array.isArray(reading) ||
    Object.keys(reading).sort().join('|') !== 'interpretation|interpretationAudit') return false
  const briefingText = createProductionBrief({ ownerText: intent.briefing }).ownerInput?.text
  if (briefingText === undefined) return false
  try {
    const interpretation = parseBriefInterpretation(reading.interpretation, briefingText)
    // The audit is the record of the call that read THIS text: it is checked against the text and the interpretation, not taken as handed over.
    const interpretationAudit = parseBriefInterpretationAudit(reading.interpretationAudit, briefingText, interpretation)
    return contentJson === stableSerialize({ ...base,
      productionBrief: createProductionBrief({ ownerText: intent.briefing, interpretedCoverage: (interpretation.coverage ?? []).map((item) => item.topic) }),
      editorialRequest: { interpretation, interpretationAudit } })
  } catch (error) {
    if (error instanceof DomainError) return false
    throw error
  }
}

export type ProjectCreationCallerIntentV2 = Readonly<
  { schemaVersion: 'project-creation-intent/v2'; kind: 'initialize-empty'; name: string;
    objective: StrategicObjectiveId; locale: string | null; briefing: string | null;
    desiredAction: Readonly<DesiredActionInput> } |
  { schemaVersion: 'project-creation-intent/v2'; kind: 'fork-with-content'; name: string }
>
export type NormalizedProjectCreationIntentV2 = Readonly<
  { schemaVersion: 'project-creation-intent/v2'; kind: 'initialize-empty'; name: string;
    objective: StrategicObjectiveId; locale: string | null; briefing: string | null;
    desiredAction: Readonly<DesiredAction> } |
  { schemaVersion: 'project-creation-intent/v2'; kind: 'fork-with-content'; name: string }
>
export interface ProjectCreationSourceBaselineV2 {
  workspaceId: string; projectId: string; versionId: string; baseHash: string; stateId: string; stateHash: string
  snapshots: readonly Readonly<{ kind: string; id: string; hash: string }>[]
  renderablePlanSnapshot: Readonly<V2RenderablePlanSnapshotFacts> | null
  ownedIdentities: readonly Readonly<{ kind: ForkIdentityKindV2; id: string }>[]
}
export interface ProjectCreationPayloadV2 extends OutputCanonicalPolicy {
  schemaVersion: 'project-creation-payload/v2'
  callerIntent: NormalizedProjectCreationIntentV2
  sourceBaseline: Readonly<ProjectCreationSourceBaselineV2> | null
  allocations: Readonly<{ stateId: string; snapshotRefs: Readonly<Record<string, string>>; renderablePlanSnapshotId: string | null }>
  snapshots: readonly Readonly<ProjectSnapshot>[]
  identityMap: readonly Readonly<ForkIdentityRemapV2>[]
  renderablePlan: Readonly<ForkRenderablePlanMaterializationV2> | null
  forkDerivation: Readonly<ProjectForkDerivation> | null
  // Target crop decisions remain intent, not verified geometry or persisted audit.
  cropDecisions: readonly OutputJson[]
}
export interface ProjectCreationCommandV2 extends OutputCanonicalPolicy {
  schemaVersion: 2; id: string; workspaceId: string; projectId: string; versionId: string; actorContextHash: string
  audit: Readonly<ApiAccessAuditContext>; author: Readonly<CommandActor>; createdAt: string
  payload: Readonly<ProjectCreationPayloadV2>; payloadHash: string; requestFingerprint: string; commandHash: string
}
function creationV2Exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(','),
  'INVALID_COMMAND', 'Creation V2 fields are missing or unsupported')
}
export function normalizeProjectCreationIntentV2(input: ProjectCreationCallerIntentV2): NormalizedProjectCreationIntentV2 {
  creationV2Exact(input, ['schemaVersion', 'kind', 'name', ...(input.kind === 'initialize-empty'
    ? ['objective', 'locale', 'briefing', 'desiredAction'] : [])])
  assertDomain(input.schemaVersion === 'project-creation-intent/v2' &&
    ['initialize-empty', 'fork-with-content'].includes(input.kind) && typeof input.name === 'string',
  'INVALID_COMMAND', 'Creation V2 caller intent is invalid')
  const name = normalizeProjectName(input.name)
  assertDomain(name.length >= 1 && name.length <= 120, 'INVALID_COMMAND', 'Creation V2 name is invalid')
  if (input.kind === 'fork-with-content') return Object.freeze({ schemaVersion: input.schemaVersion, kind: input.kind, name })
  // A project may be created without a language (ADR-160: no locale is assumed); when one is given it must be a valid language tag.
  assertDomain((input.locale === null || (typeof input.locale === 'string' && input.locale.trim().length > 0)) &&
    (input.briefing === null || typeof input.briefing === 'string'), 'INVALID_COMMAND', 'Creation V2 requires an explicit locale (or its explicit absence) and briefing presence')
  let locale: string | null = null
  if (input.locale !== null) {
    try { locale = Intl.getCanonicalLocales(input.locale.trim())[0] ?? '' } catch { locale = '' }
    assertDomain(locale.length > 0, 'INVALID_COMMAND', 'Creation V2 locale is invalid')
  }
  const objective = resolveStrategicObjective(input.objective).id
  const productionBrief = createProductionBrief({ ...(input.briefing === null ? {} : { ownerText: input.briefing }) })
  const desiredAction = createDesiredAction({ objective, desiredAction: parseDesiredActionInput(input.desiredAction) })
  return Object.freeze({ schemaVersion: input.schemaVersion, kind: input.kind, name, objective, locale,
    briefing: productionBrief.ownerInput?.text ?? null, desiredAction })
}

/** Persisted intent is already a complete DesiredAction, not raw API input.
 * Check its exact envelope before projecting the known constructor inputs;
 * canonical comparison rejects normalization and objective/kind contradictions.
 */
export function validateNormalizedProjectCreationIntentV2(input: NormalizedProjectCreationIntentV2): NormalizedProjectCreationIntentV2 {
  creationV2Exact(input, ['schemaVersion', 'kind', 'name', ...(input.kind === 'initialize-empty'
    ? ['objective', 'locale', 'briefing', 'desiredAction'] : [])])
  assertDomain(input.schemaVersion === 'project-creation-intent/v2' &&
    ['initialize-empty', 'fork-with-content'].includes(input.kind), 'INVALID_COMMAND', 'Stored Creation V2 intent version/kind is invalid')
  let fresh: NormalizedProjectCreationIntentV2
  if (input.kind === 'initialize-empty') {
    const action = input.desiredAction
    creationV2Exact(action, ['schemaVersion', 'kind', 'disclosures',
      ...(['destination','verbalCta','visualCta'] as const).filter(key => Object.hasOwn(action,key))])
    assertDomain(action.schemaVersion === 1 && typeof action.kind === 'string' &&
      Array.isArray(action.disclosures) && action.disclosures.every(value => typeof value === 'string'),
      'INVALID_COMMAND', 'Stored Creation V2 desired action schema/type is invalid')
    for (const field of ['verbalCta','visualCta'] as const) if (Object.hasOwn(action,field))
      assertDomain(typeof action[field] === 'string', 'INVALID_COMMAND', 'Stored Creation V2 CTA type is invalid')
    if (Object.hasOwn(action,'destination')) {
      creationV2Exact(action.destination,['type','value'])
      assertDomain(typeof action.destination.type === 'string' && typeof action.destination.value === 'string',
        'INVALID_COMMAND', 'Stored Creation V2 destination type is invalid')
    }
    let desiredAction: Readonly<DesiredAction>
    try { desiredAction = parseDesiredAction(action,input.objective) }
    catch (error) {
      if (error instanceof DomainError) throw new DomainError('INVALID_COMMAND','Stored Creation V2 desired action is invalid')
      throw error
    }
    assertDomain(serializeOutputCanonicalJson(desiredAction) === serializeOutputCanonicalJson(action),
      'INVALID_COMMAND','Stored Creation V2 desired action must already be canonical')
    // Explicit typed projection follows full validation; no unknown field is
    // discarded or accepted by feeding the stored envelope to the raw parser.
    const rawAction: DesiredActionInput = {
      ...(desiredAction.destination !== undefined ? {destination:desiredAction.destination} : {}),
      ...(desiredAction.verbalCta !== undefined ? {verbalCta:desiredAction.verbalCta} : {}),
      ...(desiredAction.visualCta !== undefined ? {visualCta:desiredAction.visualCta} : {}), disclosures:desiredAction.disclosures,
    }
    fresh = normalizeProjectCreationIntentV2({...input,desiredAction:rawAction})
  } else fresh = normalizeProjectCreationIntentV2(input)
  assertDomain(serializeOutputCanonicalJson(fresh) === serializeOutputCanonicalJson(input),
    'INVALID_COMMAND','Stored Creation V2 intent must already be normalized')
  return fresh
}

/** Low-level seal of explicit materialization. The origin builder additionally
 * confronts the source/target graph. This constructor grants no persistence. */
export function createProjectCreationCommandV2(input: OutputCanonicalPolicy & Readonly<{
  id: string; workspaceId: string; projectId: string; versionId: string; audit: Readonly<ApiAccessAuditContext>; createdAt: string
  payload: Readonly<ProjectCreationPayloadV2>
}>): Readonly<ProjectCreationCommandV2> {
  creationV2Exact(input, ['canonicalPolicyVersion', 'id', 'workspaceId', 'projectId', 'versionId', 'audit', 'createdAt', 'payload'])
  validateOutputCanonicalPolicy(input); validateOutputCanonicalPolicy(input.payload)
  const payload = input.payload
  creationV2Exact(payload, ['schemaVersion', 'canonicalPolicyVersion', 'callerIntent', 'sourceBaseline', 'allocations', 'snapshots', 'identityMap', 'cropDecisions', 'renderablePlan', 'forkDerivation'])
  creationV2Exact(payload.allocations, ['stateId', 'snapshotRefs', 'renderablePlanSnapshotId'])
  assertDomain(Array.isArray(payload.snapshots) && Array.isArray(payload.identityMap) && Array.isArray(payload.cropDecisions) &&
    payload.snapshots.length >= 3 && payload.snapshots.length <= 5, 'INVALID_COMMAND', 'Creation V2 requires explicit bounded arrays')
  assertDomain(payload.allocations.snapshotRefs !== null && typeof payload.allocations.snapshotRefs === 'object' &&
    !Array.isArray(payload.allocations.snapshotRefs), 'INVALID_COMMAND', 'Creation V2 requires explicit snapshot refs')
  assertDomain(payload.schemaVersion === 'project-creation-payload/v2' && [input.id, input.workspaceId, input.projectId,
    input.versionId, payload.allocations.stateId].every((id) => typeof id === 'string' && ID_PATTERN.test(id)) &&
    typeof input.createdAt === 'string' && Number.isFinite(Date.parse(input.createdAt)) && new Date(input.createdAt).toISOString() === input.createdAt,
  'INVALID_COMMAND', 'Creation V2 allocation or timestamp is invalid')
  // Normalized action is the actual domain action, not a second request parser.
  const intent = payload.callerIntent
  validateNormalizedProjectCreationIntentV2(intent)
  const audit = createApiAccessAuditContext(input.audit)
  assertDomain(audit.workspaceId === input.workspaceId && audit.contextHash === input.audit.contextHash,
    'AUTH_INVALID', 'Creation V2 actor scope or seal mismatch')
  const snapshots = payload.snapshots.map((snapshot) => {
    // `as unknown`: the assertion stays a runtime check; it must not narrow the typed snapshot to a record.
    creationV2Exact(snapshot as unknown, ['schemaVersion', 'id', 'workspaceId', 'projectId', 'kind', 'contentSchemaVersion', 'contentJson', 'contentHash', 'createdAt'])
    const fresh = createProjectSnapshot(snapshot), document = JSON.parse(fresh.contentJson)
    assertDomain(snapshot.schemaVersion === 1 && ID_PATTERN.test(snapshot.id), 'INVALID_COMMAND', 'Creation V2 snapshot identity/schema is invalid')
    assertDomain(fresh.workspaceId === input.workspaceId && fresh.projectId === input.projectId && fresh.createdAt === input.createdAt &&
      fresh.contentJson === stableSerialize(document) && fresh.contentHash === calculateCanonicalHash(document) &&
      ['brief', 'policies', 'treatment', 'story', 'edit-plan'].includes(fresh.kind),
    'INVALID_COMMAND', 'Creation V2 snapshot scope or historical hash mismatch')
    return fresh
  })
  assertDomain(new Set(snapshots.map((s) => s.id)).size === snapshots.length && new Set(snapshots.map((s) => s.kind)).size === snapshots.length &&
    snapshots.some((s) => s.kind === 'brief') && snapshots.some((s) => s.kind === 'policies') && snapshots.some((s) => s.kind === 'edit-plan') &&
    Object.keys(payload.allocations.snapshotRefs).length === snapshots.length && snapshots.every((s) => payload.allocations.snapshotRefs[s.kind] === s.id),
  'INVALID_COMMAND', 'Creation V2 snapshot allocations are incomplete')
  assertDomain(new Set([input.id, input.projectId, input.versionId, payload.allocations.stateId, ...snapshots.map((s) => s.id)]).size === snapshots.length + 4,
    'INVALID_COMMAND', 'Creation V2 allocated identities must be distinct')
  const edit = snapshots.find((s) => s.kind === 'edit-plan')!, editDocument = JSON.parse(edit.contentJson) as Record<string, unknown>
  assertDomain(edit.contentSchemaVersion === 2 && editDocument !== null && typeof editDocument === 'object' &&
    editDocument.schemaVersion === 2 && editDocument.projectVersionId === input.versionId && editDocument.createdAt === input.createdAt &&
    typeof editDocument.id === 'string' && ID_PATTERN.test(editDocument.id), 'INVALID_COMMAND', 'Creation V2 EditPlan identity/schema mismatch')
  if (intent.kind === 'initialize-empty') {
    assertDomain(snapshots.length === 3 && editDocument.durationFrames === 0 && Number.isInteger(editDocument.fps) &&
      (editDocument.fps as number) >= 1 && (editDocument.fps as number) <= 120 &&
      ['sources', 'videoTracks', 'overlayTracks', 'subtitleTracks', 'audioTracks', 'effectTracks'].every((key) =>
        Array.isArray(editDocument[key]) && (editDocument[key] as unknown[]).length === 0) &&
      ['markers', 'protectedElements', 'transitions', 'localeVariantRefs', 'formatVariantRefs', 'lineageRefs'].every((key) =>
        editDocument[key] === undefined || Array.isArray(editDocument[key]) && (editDocument[key] as unknown[]).length === 0),
    'INVALID_COMMAND', 'Creation V2 empty intent cannot hide source content')
    assertDomain(creationBriefMatchesIntent(snapshots.find((s) => s.kind === 'brief')!.contentJson, intent, input.createdAt) &&
      snapshots.find((s) => s.kind === 'policies')!.contentJson === stableSerialize({ schemaVersion: 1, workspaceId: input.workspaceId,
        state: 'unconfigured', brandKitMode: 'inherit', guardrails: [], createdAt: input.createdAt }),
    'INVALID_COMMAND', 'Creation V2 snapshots contradict its caller intent')
  }
  assertDomain(![input.id, input.projectId, input.versionId, payload.allocations.stateId, ...snapshots.map((s) => s.id)]
    .includes(editDocument.id as string), 'INVALID_COMMAND', 'Creation V2 plan must have its own allocated identity')
  const source = payload.sourceBaseline
  assertDomain(intent.kind === 'initialize-empty' ? source === null && payload.identityMap.length === 0 && payload.cropDecisions.length === 0 &&
      payload.renderablePlan === null && payload.forkDerivation === null && payload.allocations.renderablePlanSnapshotId === null
    : source !== null && source.workspaceId === input.workspaceId && source.projectId !== input.projectId &&
      source.versionId !== input.versionId && source.stateId !== payload.allocations.stateId &&
      HASH_PATTERN.test(source.baseHash) && HASH_PATTERN.test(source.stateHash),
  'INVALID_COMMAND', 'Creation V2 source baseline does not match its intent')
  if (source) {
    creationV2Exact(source, ['workspaceId', 'projectId', 'versionId', 'baseHash', 'stateId', 'stateHash', 'snapshots', 'ownedIdentities', 'renderablePlanSnapshot'])
    assertDomain([source.workspaceId, source.projectId, source.versionId, source.stateId].every((id) => ID_PATTERN.test(id)) &&
      Array.isArray(source.snapshots) && Array.isArray(source.ownedIdentities) && source.ownedIdentities.length >= 2 &&
      source.ownedIdentities.length <= 100_000 && source.snapshots.length >= 3 && source.snapshots.length <= 5,
    'INVALID_COMMAND', 'Creation V2 source identity inventory is invalid')
    for (const s of source.snapshots) { creationV2Exact(s as unknown, ['kind', 'id', 'hash'])
      assertDomain(ID_PATTERN.test(s.id) && HASH_PATTERN.test(s.hash), 'INVALID_COMMAND', 'Creation V2 source snapshot seal is invalid') }
    for (const i of source.ownedIdentities) { creationV2Exact(i as unknown, ['kind', 'id'])
      assertDomain(FORK_IDENTITY_KINDS_V2.includes(i.kind) && isForkIdentityV2(i.kind, i.id), 'INVALID_COMMAND', 'Creation V2 source member is invalid') }
    const index = indexForkIdentityBijectionV2(source.ownedIdentities, payload.identityMap)
    const excluded = new Set([input.id, input.projectId, input.workspaceId, source.projectId, source.workspaceId])
    assertDomain([...index.values()].every((id) => !excluded.has(id)), 'INVALID_COMMAND', 'Fork targets cannot reuse command/project/workspace identities')
    assertDomain(new Set(source.snapshots.map((s) => s.kind)).size === source.snapshots.length,
      'INVALID_COMMAND', 'Creation V2 source inventory repeats snapshot kinds')
    assertDomain(source.renderablePlanSnapshot === null ? payload.renderablePlan === null && payload.allocations.renderablePlanSnapshotId === null
      : payload.renderablePlan !== null, 'INVALID_COMMAND', 'Fork compiled snapshot presence mismatch')
    assertDomain(payload.forkDerivation !== null, 'INVALID_COMMAND', 'Fork V2 requires its preallocated derivation')
    creationV2Exact(payload.forkDerivation, ['schemaVersion', 'document', 'derivationHash'])
    const derivation = createProjectForkDerivation(payload.forkDerivation.document), d = derivation.document
    const equivalent = (left: unknown, right: unknown) => serializeOutputCanonicalJson(left) === serializeOutputCanonicalJson(right)
    assertDomain(payload.forkDerivation.schemaVersion === derivation.schemaVersion &&
      payload.forkDerivation.derivationHash === derivation.derivationHash &&
      equivalent(d.callerIntent, intent) && equivalent(d.audit, audit) &&
      d.target.commandId === input.id && d.target.workspaceId === input.workspaceId && d.target.projectId === input.projectId &&
      d.target.resultVersionId === input.versionId && d.target.stateId === payload.allocations.stateId &&
      d.target.createdAt === input.createdAt && equivalent(d.identityMap, payload.identityMap) && equivalent(d.cropDecisions, payload.cropDecisions),
    'INVALID_COMMAND', 'Fork Command does not reciprocate its exact derivation')
    const sourceSnapshots = forkSourceSnapshotFacts(d.source)
    const baseline = { workspaceId: d.source.version.workspaceId, projectId: d.source.version.projectId, versionId: d.source.version.id,
      baseHash: d.source.version.baseHash, stateId: d.source.state.document.id, stateHash: d.source.state.stateHash,
      snapshots: sourceSnapshots.map((snapshot) => ({ kind: snapshot.kind, id: snapshot.id, hash: snapshot.contentHash })),
      renderablePlanSnapshot: d.sourceRenderablePlanSnapshot, ownedIdentities: forkOwnedIdentities(d.source, d.sourceRenderablePlanSnapshot) }
    assertDomain(equivalent(baseline, source) && snapshots.length === sourceSnapshots.length,
      'INVALID_COMMAND', 'Fork Command source baseline differs from actual derivation facts')
    for (const original of sourceSnapshots) {
      const copied = snapshots.find((snapshot) => snapshot.kind === original.kind)
      const expected = original.kind === 'edit-plan' ? materializeForkEditPlan(derivation)
        : remapForkSnapshotDocument(JSON.parse(original.contentJson), original.kind, d.source, d.target, d.identityMap, d.sourceRenderablePlanSnapshot)
      assertDomain(copied !== undefined && copied.id === index.get('snapshot:' + original.id) &&
        copied.contentSchemaVersion === original.contentSchemaVersion && copied.contentJson === stableSerialize(expected) &&
        copied.contentHash === calculateCanonicalHash(expected), 'INVALID_COMMAND', 'Fork Command target snapshot is not its typed derivation')
    }
    if (source.renderablePlanSnapshot !== null && payload.renderablePlan !== null) {
      const original = createV2RenderablePlanSnapshotFacts(source.renderablePlanSnapshot)
      const materialization = payload.renderablePlan
      creationV2Exact(materialization, ['sourceSnapshotId', 'sourcePlanHash', 'targetCandidate', 'targetDerivationStatus'])
      const target = createForkRenderablePlanCandidate(materialization.targetCandidate, derivation)
      assertDomain(materialization.sourceSnapshotId === original.id && materialization.sourcePlanHash === original.planHash &&
        materialization.targetDerivationStatus === 'requires-target-materialization' &&
        target.id === payload.allocations.renderablePlanSnapshotId,
      'INVALID_COMMAND', 'Fork compiled candidate allocation or source lineage mismatch')
    }
    assertDomain(index.get('version:' + source.versionId) === input.versionId &&
      index.get('state:' + source.stateId) === payload.allocations.stateId,
    'INVALID_COMMAND', 'Creation V2 fork allocation mismatch')
  }
  const immutablePayload = freezeOutputJson(payload as unknown as OutputJson) as unknown as Readonly<ProjectCreationPayloadV2>
  const policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
  const requestFingerprint = calculateOutputCanonicalHash({ ...policy, schemaVersion: 'project-creation-request/v2',
    workspaceId: input.workspaceId, callerIntent: intent, actorContextHash: audit.contextHash, sourceBaseline: source })
  const payloadHash = calculateOutputCanonicalHash(immutablePayload)
  const author = Object.freeze({ type: 'api-client' as const, id: audit.clientId,
    ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}) })
  const body = { ...policy, schemaVersion: 2 as const, id: input.id, workspaceId: input.workspaceId, projectId: input.projectId,
    versionId: input.versionId, actorContextHash: audit.contextHash, payloadHash, requestFingerprint, createdAt: input.createdAt }
  return Object.freeze({ ...body, audit, author, payload: immutablePayload, commandHash: calculateOutputCanonicalHash(body) })
}


import { createProjectForkDerivationV2, buildForkRenderablePlanCandidateV2, materializeForkEditPlanV2,
  type ProjectForkDerivationV2, type ForkRenderablePlanCandidateV2 } from './project-fork-derivation.ts'
import { validateProjectForkDerivationV3, buildForkRenderablePlanCandidateV3, materializeForkEditPlanV3,
  forkOwnedIdentitiesV3, remapForkSnapshotDocumentV3, forkCreationSourceBaselineV3,
  type ProjectForkDerivationV3, type ForkRenderablePlanCandidateV3 } from './project-fork-derivation.ts'

export interface ProjectCreationOutputPayloadV2 extends OutputCanonicalPolicy {
  schemaVersion: 'project-creation-output-payload/v2'
  callerIntent: NormalizedProjectCreationIntentV2
  allocations: ProjectCreationPayloadV2['allocations']
  snapshots: readonly Readonly<ProjectSnapshot>[]
  forkDerivation: Readonly<ProjectForkDerivationV2 | ProjectForkDerivationV3> | null
  renderableCandidate: Readonly<ForkRenderablePlanCandidateV2 | ForkRenderablePlanCandidateV3> | null
}
export interface ProjectCreationOutputCommandV2 extends Omit<ProjectCreationCommandV2, 'payload'> {
  payload: Readonly<ProjectCreationOutputPayloadV2>
}
/** Operational seal is separate from the isolated V2 draft: it requires actual
 * source row facts in derivation/v2 and materializes only typed target content.
 * It never adds a resulting State/base hash to the Command payload. */
// No input, hash or superficially frozen object is cached. Every member was
// constructed with all semantic guards, then copied/frozen recursively as JSON.
const validatedCreationCommandsV2 = new WeakSet<object>()
export function createProjectCreationOutputCommandV2(input: Readonly<{
  id: string; workspaceId: string; projectId: string; versionId: string; createdAt: string
  audit: Readonly<ApiAccessAuditContext>; canonicalPolicyVersion: OutputCanonicalPolicy['canonicalPolicyVersion']
  payload: Readonly<ProjectCreationOutputPayloadV2>
}>): Readonly<ProjectCreationOutputCommandV2> {
  creationV2Exact(input, ['id', 'workspaceId', 'projectId', 'versionId', 'createdAt', 'audit', 'canonicalPolicyVersion', 'payload'])
  creationV2Exact(input.payload, ['schemaVersion', 'canonicalPolicyVersion', 'callerIntent', 'allocations', 'snapshots', 'forkDerivation', 'renderableCandidate'])
  validateOutputCanonicalPolicy(input); validateOutputCanonicalPolicy(input.payload)
  assertDomain(input.payload.schemaVersion === 'project-creation-output-payload/v2', 'INVALID_COMMAND', 'Creation operational payload version mismatch')
  const p = input.payload, audit = createApiAccessAuditContext(input.audit)
  creationV2Exact(p.allocations, ['stateId', 'snapshotRefs', 'renderablePlanSnapshotId'])
  validateNormalizedProjectCreationIntentV2(p.callerIntent)
  // The historical constructor normalizes schemaVersion; operational input must
  // already have the exact persisted envelope in both root and fork branches.
  assertDomain(Array.isArray(p.snapshots), 'INVALID_COMMAND', 'Operational snapshots must be an explicit array')
  for (const snapshot of p.snapshots) {
    creationV2Exact(snapshot as unknown, ['schemaVersion', 'id', 'workspaceId', 'projectId', 'kind', 'contentSchemaVersion', 'contentJson', 'contentHash', 'createdAt'])
    assertDomain(snapshot.schemaVersion === 1, 'INVALID_COMMAND', 'Operational snapshot envelope version mismatch')
    assertDomain(serializeOutputCanonicalJson(snapshot) === serializeOutputCanonicalJson(createProjectSnapshot(snapshot)),
      'INVALID_COMMAND', 'Operational snapshot must not normalize its persisted envelope')
  }
  const policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
  let sourceBaseline: (ProjectCreationSourceBaselineV2 & { sourceProject: ProjectForkDerivationV2['document']['sourceProject'];
    sourceReferences: readonly Omit<ProjectForkDerivationV2['document']['sourceReferences'][number], 'targetLinkId'>[] }) |
    ReturnType<typeof forkCreationSourceBaselineV3> | null = null
  if (p.callerIntent.kind === 'initialize-empty') {
    assertDomain(p.forkDerivation === null && p.renderableCandidate === null, 'INVALID_COMMAND', 'Empty Creation cannot hide fork facts')
    createProjectCreationCommandV2({ ...input, payload: { ...policy, schemaVersion: 'project-creation-payload/v2',
      callerIntent: p.callerIntent, allocations: p.allocations, snapshots: p.snapshots, sourceBaseline: null,
      identityMap: [], cropDecisions: [], renderablePlan: null, forkDerivation: null } })
  } else if (p.forkDerivation?.schemaVersion === 'project-fork-derivation/v3') {
    const derivation = validateProjectForkDerivationV3(p.forkDerivation), d = derivation.document.kernel.document
    assertDomain(d.target.commandId === input.id && d.target.workspaceId === input.workspaceId && d.target.projectId === input.projectId &&
      d.target.resultVersionId === input.versionId && d.target.stateId === p.allocations.stateId && d.target.createdAt === input.createdAt &&
      serializeOutputCanonicalJson(d.callerIntent) === serializeOutputCanonicalJson(p.callerIntent) &&
      serializeOutputCanonicalJson(d.audit) === serializeOutputCanonicalJson(audit),
    'INVALID_COMMAND', 'Creation2 fork3 target/audit/intent differs')
    const sourceSnapshots = [...Object.values(d.source.nonOutputSnapshotFacts).filter((s): s is ProjectSnapshot => s !== null), derivation.document.sourceEditPlanSnapshot]
    const index = indexForkIdentityBijectionV2(forkOwnedIdentitiesV3(d.source, d.sourceRenderablePlanSnapshot), d.identityMap)
    assertDomain(p.snapshots.length === sourceSnapshots.length && new Set(p.snapshots.map(s => s.kind)).size === sourceSnapshots.length &&
      Object.keys(p.allocations.snapshotRefs).length === sourceSnapshots.length, 'INVALID_COMMAND', 'Creation2 fork3 snapshot bijection differs')
    for (const original of sourceSnapshots) {
      const row = p.snapshots.find(s => s.kind === original.kind)
      const expected = original.kind === 'edit-plan' ? materializeForkEditPlanV3(derivation) :
        remapForkSnapshotDocumentV3(JSON.parse(original.contentJson), original.kind, d.source, d.target, d.identityMap, d.sourceRenderablePlanSnapshot)
      assertDomain(row !== undefined && row.id === index.get('snapshot:' + original.id) && p.allocations.snapshotRefs[original.kind] === row.id &&
        row.workspaceId === input.workspaceId && row.projectId === input.projectId && row.createdAt === input.createdAt &&
        row.contentSchemaVersion === original.contentSchemaVersion && row.contentJson === stableSerialize(expected) &&
        row.contentHash === calculateCanonicalHash(expected), 'INVALID_COMMAND', 'Creation2 fork3 target snapshot contradicts actual typed source')
    }
    const candidate = buildForkRenderablePlanCandidateV3(derivation)
    assertDomain(serializeOutputCanonicalJson(p.renderableCandidate) === serializeOutputCanonicalJson(candidate) &&
      p.allocations.renderablePlanSnapshotId === (candidate?.id ?? null), 'INVALID_COMMAND', 'Creation2 fork3 complete candidate differs')
    sourceBaseline = forkCreationSourceBaselineV3(derivation)
  } else {
    assertDomain(p.forkDerivation !== null, 'INVALID_COMMAND', 'Content fork requires derivation/v2')
    const derivation = createProjectForkDerivationV2(p.forkDerivation.document), d = derivation.document.kernel.document
    assertDomain(p.forkDerivation.schemaVersion === derivation.schemaVersion && p.forkDerivation.derivationHash === derivation.derivationHash &&
      d.target.commandId === input.id && d.target.workspaceId === input.workspaceId && d.target.projectId === input.projectId &&
      d.target.resultVersionId === input.versionId && d.target.stateId === p.allocations.stateId && d.target.createdAt === input.createdAt &&
      serializeOutputCanonicalJson(d.callerIntent) === serializeOutputCanonicalJson(p.callerIntent) &&
      serializeOutputCanonicalJson(d.audit) === serializeOutputCanonicalJson(audit),
    'INVALID_COMMAND', 'Creation operational fork allocation/audit/intent mismatch')
    const sourceSnapshots = [...forkSourceSnapshotFacts(d.source).filter((s) => s.kind !== 'edit-plan'), derivation.document.sourceEditPlanSnapshot]
    const index = indexForkIdentityBijectionV2(forkOwnedIdentities(d.source, d.sourceRenderablePlanSnapshot), d.identityMap)
    assertDomain(p.snapshots.length === sourceSnapshots.length && Object.keys(p.allocations.snapshotRefs).length === sourceSnapshots.length,
      'INVALID_COMMAND', 'Fork snapshot allocations are incomplete')
    for (const source of sourceSnapshots) {
      const row = p.snapshots.find((s) => s.kind === source.kind)
      const expected = source.kind === 'edit-plan' ? materializeForkEditPlanV2(derivation)
        : remapForkSnapshotDocument(JSON.parse(source.contentJson), source.kind, d.source, d.target, d.identityMap, d.sourceRenderablePlanSnapshot)
      assertDomain(row !== undefined && row.id === index.get('snapshot:' + source.id) && p.allocations.snapshotRefs[source.kind] === row.id &&
        row.workspaceId === input.workspaceId && row.projectId === input.projectId && row.createdAt === input.createdAt &&
        row.contentSchemaVersion === source.contentSchemaVersion && row.contentJson === stableSerialize(expected) &&
        row.contentHash === calculateCanonicalHash(expected), 'INVALID_COMMAND', 'Fork target snapshot contradicts typed factual derivation')
      createProjectSnapshot(row)
    }
    const expectedCandidate = buildForkRenderablePlanCandidateV2(derivation)
    assertDomain(serializeOutputCanonicalJson(p.renderableCandidate) === serializeOutputCanonicalJson(expectedCandidate) &&
      p.allocations.renderablePlanSnapshotId === (expectedCandidate?.id ?? null), 'INVALID_COMMAND', 'Fork candidate allocation or full content mismatch')
    sourceBaseline = { workspaceId: d.source.version.workspaceId, projectId: d.source.version.projectId,
      versionId: d.source.version.id, baseHash: d.source.version.baseHash, stateId: d.source.state.document.id,
      stateHash: d.source.state.stateHash, snapshots: sourceSnapshots.map((s) => ({ kind: s.kind, id: s.id, hash: s.contentHash })),
      sourceProject: derivation.document.sourceProject, sourceReferences: derivation.document.sourceReferences.map(({ targetLinkId, ...fact }) => { void targetLinkId; return fact }),
      renderablePlanSnapshot: d.sourceRenderablePlanSnapshot, ownedIdentities: forkOwnedIdentities(d.source, d.sourceRenderablePlanSnapshot).toSorted((a,b) => Buffer.compare(Buffer.from(a.kind + ':' + a.id), Buffer.from(b.kind + ':' + b.id))) }
  }
  assertDomain(audit.workspaceId === input.workspaceId && audit.contextHash === input.audit.contextHash &&
    [input.id, input.projectId, input.versionId, p.allocations.stateId].every((id) => ID_PATTERN.test(id)) &&
    new Set([input.id, input.projectId, input.versionId, p.allocations.stateId, ...p.snapshots.map((s) => s.id)]).size === p.snapshots.length + 4 &&
    new Date(input.createdAt).toISOString() === input.createdAt, 'INVALID_COMMAND', 'Creation operational identities/audit/time mismatch')
  const payload = freezeOutputJson(p as unknown as OutputJson) as unknown as Readonly<ProjectCreationOutputPayloadV2>
  const payloadHash = calculateOutputCanonicalHash(payload)
  const requestFingerprint = calculateOutputCanonicalHash({ ...policy, schemaVersion: 'project-creation-output-request/v2',
    workspaceId: input.workspaceId, callerIntent: payload.callerIntent, actorContextHash: audit.contextHash, sourceBaseline })
  const body = { ...policy, schemaVersion: 2 as const, id: input.id, workspaceId: input.workspaceId, projectId: input.projectId,
    versionId: input.versionId, actorContextHash: audit.contextHash, payloadHash, requestFingerprint, createdAt: input.createdAt }
  const author = Object.freeze({ type: 'api-client' as const, id: audit.clientId,
    ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}) })
  const command = freezeOutputJson({ ...body, audit, author, payload, commandHash: calculateOutputCanonicalHash(body) } as unknown as OutputJson) as unknown as Readonly<ProjectCreationOutputCommandV2>
  validatedCreationCommandsV2.add(command)
  return command
}

export function validateProjectCreationOutputCommandV2(input: ProjectCreationOutputCommandV2): Readonly<ProjectCreationOutputCommandV2> {
  if (validatedCreationCommandsV2.has(input)) return input
  creationV2Exact(input, ['schemaVersion', 'canonicalPolicyVersion', 'id', 'workspaceId', 'projectId', 'versionId',
    'actorContextHash', 'audit', 'author', 'createdAt', 'payload', 'payloadHash', 'requestFingerprint', 'commandHash'])
  const fresh = createProjectCreationOutputCommandV2({ id: input.id, workspaceId: input.workspaceId,
    projectId: input.projectId, versionId: input.versionId, createdAt: input.createdAt, audit: input.audit,
    canonicalPolicyVersion: input.canonicalPolicyVersion, payload: input.payload })
  assertDomain(serializeOutputCanonicalJson(input) === serializeOutputCanonicalJson(fresh),
    'INVALID_COMMAND', 'Creation operational Command document or seals differ')
  return fresh
}

/** Creation2 administrative metadata only; format never supplies output geometry. */
export function creationProjectMetadataV2(input: ProjectCreationOutputCommandV2): Readonly<{
  name: string; ownerId: string; format: string | null; objective: string; locale: string | null
}> {
  const command = validateProjectCreationOutputCommandV2(input), intent = command.payload.callerIntent
  const source = command.payload.forkDerivation?.document.sourceProject
  return Object.freeze({ name: intent.name, ownerId: command.author.id,
    format: intent.kind === 'initialize-empty' ? null : source!.format,
    objective: intent.kind === 'initialize-empty' ? intent.objective : source!.objective,
    locale: intent.kind === 'initialize-empty' ? intent.locale : source!.locale })
}
