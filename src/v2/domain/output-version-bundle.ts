import { createHash } from 'node:crypto'
import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION, serializeOutputCanonicalJson, validateOutputCanonicalPolicy } from './output-canonical-policy.ts'
import { createOutputVariantCommand } from './output-variant-command.ts'
import { freezeOutputJson, requireOutputHash, requireOutputId, type OutputJson } from './output-spec-revision.ts'
import { createProjectCreationCommand, type ProjectCreationCommand } from './project-creation-command.ts'
import { calculateOutputBoundVersionHash, outputBoundVersionHashBody, createProjectOutputState,
  type OutputPlanFacts, type ProjectOutputState, type ProjectOutputStateBody } from './project-output-state.ts'
import { rebuildRetiredContractOneVersion, type ProjectVersion, type ProjectVersionInput } from './project-version.ts'
import { createProjectSnapshot, type ProjectSnapshot } from './project-snapshot.ts'

type AllocatedVersion = Omit<ProjectVersionInput, 'baseHash' | 'outputState' | 'previousBaseHash'>
type StateInput = Omit<ProjectOutputStateBody, 'schemaVersion' | 'transitionPolicyVersion'>
type OutputCommand = ReturnType<typeof createOutputVariantCommand>
const NON_OUTPUT_SNAPSHOT_KINDS = ['brief', 'policies', 'treatment', 'story'] as const
export interface NonOutputSnapshotFacts {
  brief: Readonly<ProjectSnapshot>
  policies: Readonly<ProjectSnapshot>
  treatment: Readonly<ProjectSnapshot> | null
  story: Readonly<ProjectSnapshot> | null
}
export interface OutputEditCommandSeal {
  commandJson: string
  commandHash: string
  outputPayloadJson: string
  outputPayloadHash: string
}
export interface OutputVersionBundle {
  version: Readonly<ProjectVersion>
  state: Readonly<ProjectOutputState>
  facts: Readonly<OutputPlanFacts>
  nonOutputSnapshotFacts: Readonly<NonOutputSnapshotFacts>
  previousBaseHash: string | null
  editCommandSeal: Readonly<OutputEditCommandSeal> | null
  outputBaseHashJson: string
}
export interface BuildOutputVersionBundleInput {
  version: AllocatedVersion
  state: StateInput
  facts: OutputPlanFacts
  nonOutputSnapshotFacts: NonOutputSnapshotFacts
  parent: Readonly<OutputVersionBundle> | null
  // Null explicitly requests computation for a new allocation; a non-null
  // expectation must match the complete computed bundle. Never a stored fallback.
  expectedBaseHash: string | null
  origin: Readonly<{ kind: 'creation-command'; command: Readonly<ProjectCreationCommand> }> |
    Readonly<{ kind: 'output-variant-command'; result: OutputCommand }>
}

function copyFacts(facts: OutputPlanFacts): Readonly<OutputPlanFacts> {
  return Object.freeze({ editPlanDocument: freezeOutputJson(facts.editPlanDocument),
    renderablePlanDocument: facts.renderablePlanDocument === null ? null : freezeOutputJson(facts.renderablePlanDocument) })
}
function copyNonOutputFacts(facts: NonOutputSnapshotFacts, version: AllocatedVersion | ProjectVersion): Readonly<NonOutputSnapshotFacts> {
  assertDomain(facts !== null && typeof facts === 'object' && Object.keys(facts).length === NON_OUTPUT_SNAPSHOT_KINDS.length &&
    NON_OUTPUT_SNAPSHOT_KINDS.every((kind) => Object.hasOwn(facts, kind)),
  'INVALID_PROJECT_VERSION', 'Bundle requires every non-output snapshot fact, including explicit absent facts')
  const result = {} as Record<typeof NON_OUTPUT_SNAPSHOT_KINDS[number], Readonly<ProjectSnapshot> | null>
  for (const kind of NON_OUTPUT_SNAPSHOT_KINDS) {
    const present = Object.hasOwn(version.snapshotRefs, kind), snapshot = facts[kind]
    assertDomain((kind !== 'brief' && kind !== 'policies') || present,
      'INVALID_PROJECT_VERSION', 'Bundle requires explicit brief and policies references')
    if (!present) {
      assertDomain(snapshot === null, 'INVALID_PROJECT_VERSION', 'Absent snapshot reference cannot carry hidden facts')
      result[kind] = null
      continue
    }
    assertDomain(typeof version.snapshotRefs[kind] === 'string' && version.snapshotRefs[kind]!.length > 0 &&
      snapshot !== null && typeof snapshot === 'object' && snapshot.schemaVersion === 1 && snapshot.id === version.snapshotRefs[kind] &&
      snapshot.workspaceId === version.workspaceId && snapshot.projectId === version.projectId && snapshot.kind === kind,
    'INVALID_PROJECT_VERSION', 'Non-output snapshot identity, kind or scope mismatch')
    const fresh = createProjectSnapshot(snapshot)
    const document = JSON.parse(fresh.contentJson)
    assertDomain(fresh.contentJson === stableSerialize(document) && fresh.contentHash === calculateCanonicalHash(document) &&
      fresh.contentHash === createHash('sha256').update(fresh.contentJson, 'utf8').digest('hex'),
    'INVALID_PROJECT_VERSION', 'Non-output snapshot historical text and content hash mismatch')
    result[kind] = Object.freeze({ ...fresh })
  }
  return Object.freeze({ brief: result.brief!, policies: result.policies!, treatment: result.treatment, story: result.story })
}
function requireRootProducerFacts(state: StateInput | ProjectOutputStateBody, facts: Readonly<NonOutputSnapshotFacts>): void {
  const expected = { canonicalPolicyVersion: state.canonicalPolicyVersion, schemaVersion: 'project-created-version/v1',
    briefHash: facts.brief.contentHash, policyHash: facts.policies.contentHash }
  assertDomain(calculateOutputCanonicalHash(state.producer.document) === calculateOutputCanonicalHash(expected),
    'INVALID_PROJECT_VERSION', 'Root producer must bind its actual scoped brief and policies snapshot facts')
}
function revalidateParent(parent: Readonly<OutputVersionBundle>): void {
  assertDomain(parent.version.outputContractVersion === 1, 'INVALID_PROJECT_VERSION', 'Bundle parent must be operational contract one')
  validateOutputCanonicalPolicy(parent.version)
  const nonOutputFacts = copyNonOutputFacts(parent.nonOutputSnapshotFacts, parent.version)
  if (parent.state.document.provenance.kind === 'creation-command') requireRootProducerFacts(parent.state.document, nonOutputFacts)
  const state = createProjectOutputState(parent.state.document, parent.facts)
  assertDomain(state.stateHash === parent.state.stateHash, 'INVALID_PROJECT_VERSION', 'Bundle parent State seal mismatch')
  assertDomain(parent.outputBaseHashJson === serializeOutputCanonicalJson(outputBoundVersionHashBody({
    workspaceId: parent.version.workspaceId, projectId: parent.version.projectId, resultVersionId: parent.version.id,
    parentVersionId: state.document.parentVersionId, previousBaseHash: parent.previousBaseHash,
    producerHash: state.document.producer.hash, outputStateId: state.document.id, outputStateHash: state.stateHash })),
  'INVALID_PROJECT_VERSION', 'Bundle parent base hash authority text mismatch')
  rebuildRetiredContractOneVersion({ ...parent.version, outputState: state, previousBaseHash: parent.previousBaseHash })
}
function timelineDuration(facts: OutputPlanFacts): number {
  const document = (facts.renderablePlanDocument ?? facts.editPlanDocument) as Record<string, OutputJson>
  assertDomain(document !== null && typeof document === 'object' && !Array.isArray(document) &&
    typeof document.durationFrames === 'number' && Number.isSafeInteger(document.durationFrames) && document.durationFrames >= 0,
  'INVALID_OUTPUT_SPEC', 'Bundle requires materialized timeline duration')
  return document.durationFrames
}
function planSemantics(document: OutputJson): Record<string, OutputJson> {
  assertDomain(document !== null && typeof document === 'object' && !Array.isArray(document),
    'INVALID_OUTPUT_SPEC', 'Bundle plan facts must be explicit objects')
  const body = { ...document } as Record<string, OutputJson>
  for (const field of ['id', 'projectVersionId', 'createdAt']) delete body[field]
  return body
}
function requireUnchangedPlans(parent: Readonly<OutputVersionBundle>, facts: OutputPlanFacts): void {
  assertDomain(calculateOutputCanonicalHash(planSemantics(parent.facts.editPlanDocument)) ===
    calculateOutputCanonicalHash(planSemantics(facts.editPlanDocument)) &&
    (parent.facts.renderablePlanDocument === null) === (facts.renderablePlanDocument === null),
  'INVALID_COMMAND', 'Output Command cannot edit plan semantics or introduce an unbound renderable plan')
  if (parent.facts.renderablePlanDocument !== null && facts.renderablePlanDocument !== null) {
    assertDomain(calculateOutputCanonicalHash(planSemantics(parent.facts.renderablePlanDocument)) ===
      calculateOutputCanonicalHash(planSemantics(facts.renderablePlanDocument)),
    'INVALID_COMMAND', 'Output Command cannot edit renderable plan semantics')
  }
}

/** Pure isolated contract, with no persistence, clock, allocation or authority
 * discovery. Caller supplies sealed plan facts and the exact parent. DB writers
 * must still lock/revalidate authoritative rows and commit this bundle atomically.
 * Only existing root and output-variant Command contracts are admitted here;
 * ingest/manual/director producers need their own reviewed contracts. */
export function buildOutputVersionBundle(input: BuildOutputVersionBundleInput): Readonly<OutputVersionBundle> {
  const { version, state: proposed } = input
  validateOutputCanonicalPolicy(version)
  validateOutputCanonicalPolicy(proposed)
  assertDomain(!['baseHash', 'outputState', 'previousBaseHash', 'outputContractVersion', 'outputStateId', 'outputStateHash']
    .some((field) => Object.hasOwn(version, field)), 'INVALID_PROJECT_VERSION', 'Version allocations cannot contain computed output fields')
  if (input.expectedBaseHash !== null) requireOutputHash(input.expectedBaseHash, 'expectedBaseHash')
  assertDomain(version.id === proposed.resultVersionId && version.workspaceId === proposed.workspaceId &&
    version.projectId === proposed.projectId && version.createdAt === proposed.createdAt &&
    version.snapshotRefs.editPlan === proposed.editPlan.snapshotId,
  'INVALID_PROJECT_VERSION', 'Bundle allocations must identify the exact result Version and State')
  const facts = copyFacts(input.facts)
  const nonOutputSnapshotFacts = copyNonOutputFacts(input.nonOutputSnapshotFacts, version)
  let previousBaseHash: string | null = null
  let editCommandSeal: Readonly<OutputEditCommandSeal> | null = null
  if (input.parent === null) {
    assertDomain(input.origin.kind === 'creation-command' && version.sequence === 1 && version.parentVersionId === undefined &&
      proposed.parentVersionId === null && proposed.parentStateId === null && proposed.parentStateHash === null,
    'INVALID_PROJECT_VERSION', 'Root bundle requires an explicit CreationCommand and no parent')
    const command = createProjectCreationCommand(input.origin.command)
    const fork = command.action === 'duplicate'
    assertDomain(command.commandHash === input.origin.command.commandHash && command.workspaceId === version.workspaceId &&
      command.projectId === version.projectId && command.versionId === version.id && command.createdAt === version.createdAt &&
      command.audit.clientId === version.createdBy && proposed.provenance.kind === 'creation-command' &&
      proposed.provenance.id === command.id && proposed.provenance.hash === command.commandHash && version.commandId === undefined &&
      proposed.transition === (fork ? 'fork-empty' : 'initialize-empty') &&
      version.forkedFromProjectId === command.sourceProjectId && version.forkedFromVersionId === command.sourceVersionId,
    'INVALID_PROJECT_VERSION', 'Root producer must be its real scoped CreationCommand with an empty transition')
    // These facts prove the persisted input content, not the original caller's
    // intent: CreationCommand v1 stores no brief/policies payload seal.
    requireRootProducerFacts(proposed, nonOutputSnapshotFacts)
  } else {
    const parent = input.parent
    revalidateParent(parent)
    previousBaseHash = parent.version.baseHash
    assertDomain(input.origin.kind === 'output-variant-command' && version.workspaceId === parent.version.workspaceId &&
      version.projectId === parent.version.projectId && version.sequence === parent.version.sequence + 1 &&
      version.parentVersionId === parent.version.id && proposed.parentVersionId === parent.version.id &&
      proposed.parentStateId === parent.state.document.id && proposed.parentStateHash === parent.state.stateHash &&
      version.id !== parent.version.id && proposed.id !== parent.state.document.id &&
      version.forkedFromProjectId === undefined && version.forkedFromVersionId === undefined,
    'INVALID_PROJECT_VERSION', 'Child bundle requires the exact operational parent Version and State')
    assertDomain(NON_OUTPUT_SNAPSHOT_KINDS.every((kind) =>
      Object.hasOwn(version.snapshotRefs, kind) === Object.hasOwn(parent.version.snapshotRefs, kind) &&
      version.snapshotRefs[kind] === parent.version.snapshotRefs[kind]) &&
      calculateOutputCanonicalHash(nonOutputSnapshotFacts) === calculateOutputCanonicalHash(parent.nonOutputSnapshotFacts),
    'INVALID_COMMAND', 'Output Command cannot replace non-output snapshot references or facts')
    requireUnchangedPlans(parent, facts)
    const supplied = input.origin.result, command = supplied.command, type = command.type
    assertDomain(type === 'create-output-variant' || type === 'revise-output-spec', 'INVALID_COMMAND', 'Unsupported bundle producer Command')
    const fresh = createOutputVariantCommand({ command: { ...command, type }, audit: supplied.audit,
      base: parent.version, baseState: parent.state, historicalBaselineRequested: false,
      revision: command.payload.revision, expectedRevisionId: command.payload.expectedRevisionId,
      expectedSpecHash: command.payload.expectedSpecHash, durationFrames: timelineDuration(parent.facts) })
    assertDomain(command.createdAt === version.createdAt && command.author.id === version.createdBy &&
      command.commandHash === fresh.command.commandHash && supplied.requestFingerprint === fresh.requestFingerprint &&
      calculateOutputCanonicalHash(command.payload) === calculateOutputCanonicalHash(fresh.command.payload) &&
      calculateOutputCanonicalHash(supplied.producer) === calculateOutputCanonicalHash(fresh.producer) &&
      proposed.provenance.kind === 'edit-command' && proposed.provenance.id === command.id &&
      proposed.provenance.hash === command.commandHash && version.commandId === command.id &&
      proposed.transition === (type === 'create-output-variant' ? 'create-variant' : 'revise-output') &&
      calculateOutputCanonicalHash(proposed.producer) === calculateOutputCanonicalHash(fresh.producer),
    'INVALID_COMMAND', 'Child producer must match its canonical payload, historical Command and exact base')
    const payload = fresh.command.payload, target = proposed.entries.find((entry) => entry.variantId === payload.variantId)
    const previous = parent.state.document.entries.filter((entry) => entry.variantId !== payload.variantId)
    const untouched = proposed.entries.filter((entry) => entry.variantId !== payload.variantId)
    const order = (entries: readonly ProjectOutputStateBody['entries'][number][]) =>
      [...entries].sort((a, b) => a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0)
    assertDomain(target !== undefined && target.outputSpecRevisionId === payload.revision.id &&
      target.specHash === payload.revisionSpecHash && calculateOutputCanonicalHash(target.spec) === payload.revisionSpecHash &&
      calculateOutputCanonicalHash(order(previous)) === calculateOutputCanonicalHash(order(untouched)) &&
      calculateOutputCanonicalHash(proposed.overlays) === calculateOutputCanonicalHash(parent.state.document.overlays) &&
      calculateOutputCanonicalHash(proposed.invalidations) === calculateOutputCanonicalHash(parent.state.document.invalidations),
    'INVALID_COMMAND', 'Output Command may only change its explicitly declared state member')
    const { commandHash: _commandHash, ...body } = fresh.command
    editCommandSeal = Object.freeze({ commandJson: stableSerialize(body), commandHash: fresh.command.commandHash,
      outputPayloadJson: serializeOutputCanonicalJson(payload), outputPayloadHash: calculateOutputCanonicalHash(payload) })
  }
  const state = createProjectOutputState(proposed, facts)
  const baseHashBody = outputBoundVersionHashBody({ workspaceId: version.workspaceId, projectId: version.projectId,
    resultVersionId: version.id, parentVersionId: proposed.parentVersionId, previousBaseHash,
    producerHash: state.document.producer.hash, outputStateId: state.document.id, outputStateHash: state.stateHash })
  const outputBaseHashJson = serializeOutputCanonicalJson(baseHashBody)
  const baseHash = calculateOutputBoundVersionHash(baseHashBody)
  assertDomain(input.expectedBaseHash === null || input.expectedBaseHash === baseHash,
    'INVALID_PROJECT_VERSION', 'Expected Version hash does not bind this exact output bundle')
  return Object.freeze({ state, version: rebuildRetiredContractOneVersion({ ...version, baseHash, outputState: state, previousBaseHash }),
    facts, nonOutputSnapshotFacts, previousBaseHash, editCommandSeal, outputBaseHashJson })
}

import { validateProjectCreationOutputCommandV2, type ProjectCreationOutputCommandV2 } from './project-creation-command.ts'
import { createProjectCreationOutputStateV2, validateProjectCreationOutputStateV2, type ProjectOutputStateV2 } from './project-output-state.ts'
import { createProjectCreationVersionV2, validateProjectCreationVersionV2, outputBoundVersionHashBodyV2, type ProjectVersionV2 } from './project-version.ts'

export interface CreationOutputVersionBundleV2 {
  schemaVersion: 'project-creation-output-bundle/v2'
  command: Readonly<ProjectCreationOutputCommandV2>
  state: Readonly<ProjectOutputStateV2>
  version: Readonly<ProjectVersionV2>
  outputBaseHashJson: string
}
const validatedCreationBundlesV2 = new WeakSet<object>()
export function buildCreationOutputVersionBundleV2(commandInput: ProjectCreationOutputCommandV2): Readonly<CreationOutputVersionBundleV2> {
  const command = validateProjectCreationOutputCommandV2(commandInput)
  const state = createProjectCreationOutputStateV2(command)
  const version = createProjectCreationVersionV2(command, state)
  const bundle = freezeOutputJson({ schemaVersion: 'project-creation-output-bundle/v2', command, state, version,
    outputBaseHashJson: serializeOutputCanonicalJson(outputBoundVersionHashBodyV2(command, state)) } as unknown as OutputJson) as unknown as Readonly<CreationOutputVersionBundleV2>
  validatedCreationBundlesV2.add(bundle)
  return bundle
}
export function validateCreationOutputVersionBundleV2(input: CreationOutputVersionBundleV2): Readonly<CreationOutputVersionBundleV2> {
  if (validatedCreationBundlesV2.has(input)) return input
  const command = validateProjectCreationOutputCommandV2(input.command)
  const state = validateProjectCreationOutputStateV2(input.state, command)
  const version = validateProjectCreationVersionV2(input.version, command, state)
  const text = serializeOutputCanonicalJson(outputBoundVersionHashBodyV2(command, state))
  assertDomain(input.schemaVersion === 'project-creation-output-bundle/v2' && input.outputBaseHashJson === text &&
    createHash('sha256').update(text, 'utf8').digest('hex') === version.baseHash,
    'INVALID_PROJECT_VERSION', 'Creation bundle2 base hash authority mismatch')
  const bundle = freezeOutputJson({ schemaVersion: input.schemaVersion, command, state, version, outputBaseHashJson: text } as unknown as OutputJson) as unknown as Readonly<CreationOutputVersionBundleV2>
  validatedCreationBundlesV2.add(bundle)
  return bundle
}


import { createProjectOutputStateV3, type ProjectOutputStateV3, type ProjectOutputStateBodyV3, type OutputStateEntryV3 } from './project-output-state.ts'
import { createProjectVersionV3, outputBoundVersionHashBodyV3, type ProjectVersionV3 } from './project-version.ts'
import { validateOperationalOutputOriginV3, type OperationalOutputOriginV3, type OutputOriginAllocation } from './output-version-origin.ts'
import { materializeOutputV3, materializeEditorialDerivedOutputV1, createEditorialSourceBindingV1, type MaterializationPlanV3, type SealedOutputNormalizationV3 } from './output-materialization.ts'
import { createOutputPlanAuthority } from './project-output-state.ts'
import { materializeManualEditPlan, materializeManualRestorePlan } from './manual-editing.ts'
import { createManualCommandImpact } from './command-impact.ts'
import { materializeEditorialCutPlanV3, createEditorialAudioProjectionV1, createEditorialCutImpactV2 } from './editorial-cut-impact.ts'
import { CHILD_COMMAND_TRANSITIONS } from './output-child-command.ts'

export type OperationalOutputParentV3 = Readonly<CreationOutputVersionBundleV2|OperationalOutputVersionBundleV3>
export interface OperationalOutputVersionBundleV3 {
  schemaVersion:'operational-output-version-bundle/v3'
  origin: OperationalOutputOriginV3
  version:Readonly<ProjectVersionV3>
  state:Readonly<ProjectOutputStateV3>
  snapshots:readonly Readonly<ProjectSnapshot>[]
  editPlanSnapshot:Readonly<ProjectSnapshot>
  outputBaseHashJson:string
}
export interface BuildOperationalOutputVersionBundleV3 {
  allocation:OutputOriginAllocation
  parent:OperationalOutputParentV3
  origin:OperationalOutputOriginV3
  /** Restore carries an exact factual target, never latest/ancestor inference. */
  restoreTarget:OperationalOutputParentV3|null
  editPlanSnapshot:Readonly<ProjectSnapshot>
  /** Non-output snapshots a child Command replaces, exactly the kinds its origin declares. */
  replacementSnapshots?:readonly Readonly<ProjectSnapshot>[]
  normalizations:readonly SealedOutputNormalizationV3[]
  materializationIds:Readonly<Record<string,string>>
}
export function operationalBundlePlanV3(bundle:OperationalOutputParentV3): Readonly<ProjectSnapshot> {
  if(bundle.schemaVersion==='project-creation-output-bundle/v2') {
    const checked=validateCreationOutputVersionBundleV2(bundle)
    return checked.command.payload.snapshots.find(s=>s.kind==='edit-plan')!
  }
  return bundle.editPlanSnapshot
}
function snapshotV3(input:ProjectSnapshot,workspaceId:string,projectId:string) {
  assertDomain(input.schemaVersion===1 && input.workspaceId===workspaceId && input.projectId===projectId &&
    Object.keys(input).sort().join('|')===['schemaVersion','id','workspaceId','projectId','kind','contentSchemaVersion',
      'contentJson','contentHash','createdAt'].sort().join('|'),'INVALID_PROJECT_VERSION','Operational snapshot envelope differs')
  const s=createProjectSnapshot(input)
  assertDomain(s.contentJson===stableSerialize(JSON.parse(s.contentJson)) &&
    s.contentHash===createHash('sha256').update(s.contentJson,'utf8').digest('hex'),
    'INVALID_PROJECT_VERSION','Operational snapshot historical bytes differ')
  return s
}
function parentFactsV3(bundle:OperationalOutputParentV3) {
  const v=bundle.version,s=bundle.state
  assertDomain((v.outputContractVersion===2||v.outputContractVersion===3) && v.outputStateId===s.document.id &&
    v.outputStateHash===s.stateHash && s.document.resultVersionId===v.id &&
    v.workspaceId===s.document.workspaceId && v.projectId===s.document.projectId &&
    calculateOutputCanonicalHash(s.document)===s.stateHash &&
    createHash('sha256').update(bundle.outputBaseHashJson,'utf8').digest('hex')===v.baseHash,
    'INVALID_PROJECT_VERSION','Operational parent State/Version seals differ')
  if(bundle.schemaVersion==='project-creation-output-bundle/v2')validateCreationOutputVersionBundleV2(bundle)
  const plan=operationalBundlePlanV3(bundle)
  snapshotV3(plan,v.workspaceId,v.projectId)
  assertDomain(plan.id===s.document.editPlan.snapshotId && plan.contentHash===s.document.editPlan.hash,
    'INVALID_PROJECT_VERSION','Operational parent EditPlan facts differ')
  return plan
}
function semanticsV3(plan:ProjectSnapshot) {
  const d=JSON.parse(plan.contentJson) as Record<string,OutputJson>
  return planSemantics(d)
}
export function buildOperationalOutputVersionBundleV3(input:BuildOperationalOutputVersionBundleV3):Readonly<OperationalOutputVersionBundleV3> {
  const a=input.allocation,parent=input.parent,pp=parentFactsV3(parent)
  assertDomain(input.origin.kind==='editorial-cut-command' || parent.version.outputContractVersion!==2 || parent.state.document.transition==='initialize-empty' &&
    JSON.parse(pp.contentJson).durationFrames===0 && !JSON.parse(pp.contentJson).videoTracks.some((t:{clips:unknown[]})=>t.clips.length>0),
    'PRECONDITION_REQUIRED','Fork2 content requires target transcript/perception/geometry authority before child3')
  const origin=validateOperationalOutputOriginV3(input.origin,parent,a)
  const edit=snapshotV3(input.editPlanSnapshot,a.workspaceId,a.projectId),p=JSON.parse(edit.contentJson) as MaterializationPlanV3
  assertDomain(edit.kind==='edit-plan' && edit.createdAt===a.createdAt && p.projectVersionId===a.resultVersionId &&
    edit.id!==pp.id && edit.id.length>0,'INVALID_PROJECT_VERSION','Child3 needs freshly materialized EditPlan identity')
  assertDomain(input.restoreTarget!==null?origin.kind==='restore-command':origin.kind!=='restore-command',
    'INVALID_COMMAND','Restore target presence differs')
  const source=origin.kind==='restore-command'?input.restoreTarget!:parent
  if(input.restoreTarget) {
    parentFactsV3(input.restoreTarget)
    const t=input.restoreTarget.version
    assertDomain(t.outputContractVersion===3,'PRECONDITION_REQUIRED','Restore requires a factual operational State3 target')
    assertDomain(origin.kind==='restore-command' && t.workspaceId===a.workspaceId && t.projectId===a.projectId &&
      t.id===origin.target.versionId && t.baseHash===origin.target.baseHash && t.outputStateId===origin.target.stateId &&
      t.outputStateHash===origin.target.stateHash && t.sequence<=parent.version.sequence &&
      (origin.command.payload.action!=='undo'||t.id===(parent.version as Readonly<{parentVersionId?:string}>).parentVersionId),'INVALID_COMMAND','Restore target seal/scope differs')
  }
  if(origin.kind==='editorial-cut-command') {
    const c=origin.command,payload=c.payload,b=createEditorialSourceBindingV1(payload.sourceBinding.document),d=b.document,authority=d.authority
    if(parent.schemaVersion==='project-creation-output-bundle/v2') {
      const derivation=parent.command.payload.forkDerivation
      assertDomain(derivation?.schemaVersion==='project-fork-derivation/v3'&&authority.kind==='fork-derivation3'&&
        authority.forkRootVersionId===parent.version.id&&authority.forkRootStateId===parent.state.document.id&&
        authority.forkRootStateHash===parent.state.stateHash&&authority.derivationId===derivation.document.id&&
        authority.derivationHash===derivation.derivationHash,'INVALID_COMMAND','Editorial root needs its exact fork3 derivation authority')
      const original=derivation.document.kernel.document.source
      assertDomain(authority.sourceProjectId===original.version.projectId&&authority.sourceVersionId===original.version.id&&
        authority.sourceBaseHash===original.version.baseHash&&authority.sourceStateId===original.state.document.id&&
        authority.sourceStateHash===original.state.stateHash&&original.bundle.schemaVersion==='operational-output-version-bundle/v3',
        'PRECONDITION_REQUIRED','Fork editorial authority must be its actual observed State3 source')
      const observations=new Map(original.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?
        e.consumption.materialization.document.normalizations:[]).map(n=>[n.document.id,n]))
      assertDomain(input.normalizations.length===observations.size&&input.normalizations.every(n=>
        stableSerialize(n)===stableSerialize(observations.get(n.document.id)))&&d.inventory.length===derivation.document.sourceReferences.length&&
        d.inventory.every(i=>derivation.document.sourceReferences.some(r=>r.targetLinkId===i.linkId&&r.artifactId===i.artifactId&&r.role===i.role)),
        'INVALID_COMMAND','Fork editorial observations/inventory must retain literal derivation membership')
    } else {
      const prior=parent.origin.kind==='editorial-cut-command'?parent.origin.command.payload.sourceBinding:null
      if(prior)assertDomain(stableSerialize(authority)===stableSerialize(prior.document.authority)&&
        stableSerialize(d.transcript)===stableSerialize(prior.document.transcript),'INVALID_COMMAND','Editorial continuity must retain original source authority')
      else assertDomain(authority.kind==='same-project-state3'&&authority.sourceProjectId===parent.version.projectId&&
        authority.sourceVersionId===parent.version.id&&authority.sourceBaseHash===parent.version.baseHash&&
        authority.sourceStateId===parent.state.document.id&&authority.sourceStateHash===parent.state.stateHash,
        'INVALID_COMMAND','Editorial source must be the exact current factual State3')
      const observations=new Map(parent.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?
        e.consumption.materialization.document.normalizations:[]).map(n=>[n.document.id,n]))
      assertDomain(input.normalizations.length===observations.size&&input.normalizations.every(n=>stableSerialize(n)===stableSerialize(observations.get(n.document.id))),
        'INVALID_COMMAND','Editorial child must reuse exact parent normalization observations')
    }
    const before=JSON.parse(pp.contentJson)
    assertDomain(before.retimedTranscript?.sourceTranscriptId===d.transcript.id&&
      before.retimedTranscript?.sourceTranscriptHash===d.transcript.document.transcriptHash,
      'INVALID_COMMAND','Editorial source must be the actual aligned parent transcript')
    const expected=materializeEditorialCutPlanV3({before,versionId:a.resultVersionId,planId:p.id,commandId:c.id,
      createdAt:a.createdAt,sourceBinding:b,exclusions:payload.exclusions})
    assertDomain(edit.contentJson===stableSerialize(expected)&&edit.contentHash===payload.editPlanHash&&stableSerialize(createEditorialAudioProjectionV1(expected))===stableSerialize(payload.audioProjection),
      'INVALID_COMMAND','Editorial plan differs from exact parent timing/content rematerialization')
    const impact=createEditorialCutImpactV2({commandId:c.id,baseVersionId:parent.version.id,resultVersionId:a.resultVersionId,
      sourceTranscriptId:d.transcript.id,sourceTranscriptHash:d.transcript.document.transcriptHash,
      affectedEndFrame:Math.max(before.durationFrames,p.durationFrames),renderEndFrame:p.durationFrames,
      proxyVariantId:payload.variantId,outputReferences:payload.impact.affectedArtifacts,variantIds:parent.state.document.entries.map(e=>e.variantId)})
    assertDomain(stableSerialize(impact)===stableSerialize(payload.impact),'INVALID_COMMAND','Editorial impact differs from exact plan effect')
  }
  if(origin.kind==='inherit-command'||origin.kind==='restore-command') {
    const payload=origin.command.payload,original=JSON.parse(operationalBundlePlanV3(source).contentJson)
    const expected=origin.kind==='inherit-command'?materializeManualEditPlan({editPlan:original,
      operation:payload.operation!,newVersionId:a.resultVersionId,createdAt:a.createdAt,availableAssetIds:[],
      variantId:payload.variantId}):materializeManualRestorePlan({targetEditPlan:original,action:payload.action as 'restore'|'undo'|'redo',
      targetVersionId:origin.target.versionId,newVersionId:a.resultVersionId,createdAt:a.createdAt,variantId:payload.variantId})
    assertDomain(edit.contentJson===stableSerialize(expected),'INVALID_COMMAND','Origin target differs from real manual constructor')
    const before=JSON.parse(operationalBundlePlanV3(parent).contentJson),impact=createManualCommandImpact({
      commandId:origin.command.id,baseVersionId:parent.version.id,resultVersionId:a.resultVersionId,variantId:payload.variantId,
      targetId:payload.targetId,action:payload.action,...(payload.operation?{operation:payload.operation}:{}),
      beforeEditPlan:before,afterEditPlan:expected,outputReferences:payload.impact!.affectedArtifacts})
    assertDomain(stableSerialize(impact)===stableSerialize(payload.impact),'INVALID_COMMAND','Manual impact differs from real plan effect')
    const sourceNormalizations=source.state.document.schemaVersion==='project-output-state/v3'?
      source.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?e.consumption.materialization.document.normalizations:[]):[]
    const factual=new Map(sourceNormalizations.map(n=>[n.document.id,n]))
    assertDomain(input.normalizations.length===factual.size && new Set(input.normalizations.map(n=>n.document.id)).size===factual.size &&
      input.normalizations.every(n=>factual.has(n.document.id) && stableSerialize(n)===stableSerialize(factual.get(n.document.id))),
      'INVALID_COMMAND','Manual child must reuse exact source normalization observations')
  } else if(origin.kind==='child-command') {
    const effect=CHILD_COMMAND_TRANSITIONS[origin.command.type as keyof typeof CHILD_COMMAND_TRANSITIONS]!
    if(effect.planEffect==='preserves-plan')assertDomain(
      calculateOutputCanonicalHash(semanticsV3(operationalBundlePlanV3(source)))===calculateOutputCanonicalHash(semanticsV3(edit)),
      'INVALID_COMMAND','Child Command declared an unchanged plan but changed its semantics')
    const parentNormalizations=parent.state.document.schemaVersion==='project-output-state/v3'?
      parent.state.document.entries.flatMap(e=>e.consumption.status==='materialized'?e.consumption.materialization.document.normalizations:[]):[]
    const factual=new Map(parentNormalizations.map(n=>[n.document.id,n]))
    // A child may use fewer of its parent's observations (always the parent's exact ones) and may ADOPT the persisted,
    // observed receipts of the project's other recordings: those, and only those, are named by the origin. Nothing is invented.
    assertDomain(new Set(input.normalizations.map(n=>n.document.id)).size===input.normalizations.length &&
      input.normalizations.every(n=>!factual.has(n.document.id) || stableSerialize(n)===stableSerialize(factual.get(n.document.id))),
      'INVALID_COMMAND','Child Command must reuse the exact parent normalization observations')
    const outside=input.normalizations.filter(n=>!factual.has(n.document.id)),named=new Map(origin.adoptions.map(adoption=>[adoption.receiptId,adoption]))
    assertDomain(outside.length===origin.adoptions.length && named.size===origin.adoptions.length && outside.every(n=>named.has(n.document.id)),
      'INVALID_COMMAND','Child adoptions differ from the observations outside the parent State')
    const parentSources=new Set(parentNormalizations.map(n=>n.document.source.artifactId))
    for(const n of outside) {
      const adoption=named.get(n.document.id)!
      // The materializer below validates every receipt's seal; here the origin only has to name the receipt it adopts.
      assertDomain(n.receiptHash===adoption.receiptHash && n.document.workspaceId===a.workspaceId &&
        n.document.projectId===a.projectId && n.document.source.artifactId===adoption.sourceArtifactId &&
        n.document.source.manifestId===adoption.sourceManifestId && n.document.source.manifest.manifestHash===adoption.sourceManifestHash,
        'INVALID_COMMAND','Child adoption differs from the receipt it names or belongs to another workspace or project')
      assertDomain(!parentSources.has(adoption.sourceArtifactId),'INVALID_COMMAND','Child adoption repeats a source the parent State already observes')
    }
  } else if(origin.kind!=='ingest-operation'&&origin.kind!=='editorial-cut-command')assertDomain(
    calculateOutputCanonicalHash(semanticsV3(operationalBundlePlanV3(source)))===calculateOutputCanonicalHash(semanticsV3(edit)),
    'INVALID_COMMAND','Origin changed plan semantics outside its declared effect')
  const nonOutput=source.schemaVersion==='project-creation-output-bundle/v2'?source.command.payload.snapshots:source.snapshots
  let snapshots=nonOutput.filter(s=>s.kind!=='edit-plan').map(s=>snapshotV3(s,a.workspaceId,a.projectId))
  const declaredReplacements:readonly string[]=origin.kind==='child-command'?origin.replaces:[]
  const replacements=(input.replacementSnapshots??[]).map(s=>snapshotV3(s,a.workspaceId,a.projectId))
  assertDomain(replacements.length===declaredReplacements.length && new Set(replacements.map(s=>s.kind)).size===replacements.length &&
    replacements.every(s=>declaredReplacements.includes(s.kind) && s.createdAt<=a.createdAt && !snapshots.some(x=>x.id===s.id) && s.id!==edit.id),
    'INVALID_COMMAND','Replacement snapshots differ from the declared child effect')
  snapshots=[...snapshots.filter(s=>!declaredReplacements.includes(s.kind)),...replacements]
  assertDomain(snapshots.some(s=>s.kind==='brief') && snapshots.some(s=>s.kind==='policies'),
    'INVALID_PROJECT_VERSION','Child3 requires actual non-output snapshots')
  let entries:OutputStateEntryV3[]=[]
  if(source.state.document.schemaVersion==='project-output-state/v3') entries=source.state.document.entries.map(e=>({
    ...e,consumption:{status:'blocked',reasons:['normalization-required']}}))
  else if(origin.kind==='editorial-cut-command')entries=source.state.document.entries.map(e=>{
    assertDomain(e.spec.schemaVersion==='output-spec-revision/v3','PRECONDITION_REQUIRED','Editorial fork requires literal revision3')
    return {canonicalPolicyVersion:e.canonicalPolicyVersion,variantId:e.variantId,outputSpecRevisionId:e.outputSpecRevisionId,
      specHash:e.specHash,spec:e.spec,consumption:{status:'blocked',reasons:['normalization-required']}}
  })
  else assertDomain(source.state.document.entries.length===0,'PRECONDITION_REQUIRED',
    'Fork2 source revisions require explicit target revision materialization before child3')
  if(origin.kind==='child-command')assertDomain(entries.length>0,'PRECONDITION_REQUIRED','A child Command requires an explicit output variant')
  let provenance:ProjectOutputStateBodyV3['provenance'],transition:ProjectOutputStateBodyV3['transition'],commandId:string|null
  let producerBody:Record<string,OutputJson>
  if(origin.kind==='create-output-variant'||origin.kind==='revise-output-spec') {
    const r=origin.result,c=r.command,payload=c.payload
    const fresh=createOutputVariantCommand({command:{...c,type:origin.kind},audit:r.audit,base:parent.version,
      baseState:parent.state,historicalBaselineRequested:false,revision:payload.revision,
      expectedRevisionId:payload.expectedRevisionId,expectedSpecHash:payload.expectedSpecHash,durationFrames:p.durationFrames})
    assertDomain(c.commandHash===fresh.command.commandHash && calculateOutputCanonicalHash(r.producer)===calculateOutputCanonicalHash(fresh.producer),
      'INVALID_COMMAND','Child3 output Command payload/impact/producer differs')
    entries=entries.filter(e=>e.variantId!==payload.variantId)
    entries.push({canonicalPolicyVersion:OUTPUT_CANONICAL_POLICY_VERSION,variantId:payload.variantId,
      outputSpecRevisionId:payload.revision.id,specHash:payload.revisionSpecHash,spec:payload.revision,
      consumption:{status:'blocked',reasons:[p.durationFrames===0?'empty-project':'normalization-required']}})
    provenance={kind:'edit-command',id:c.id,hash:c.commandHash};commandId=c.id
    transition=origin.kind==='create-output-variant'?'create-variant':'revise-output'
    producerBody={schemaVersion:'output-child-command-producer/v3',canonicalPolicyVersion:OUTPUT_CANONICAL_POLICY_VERSION,
      kind:origin.kind,commandId:c.id,commandHash:c.commandHash,requestFingerprint:r.requestFingerprint,
      payloadHash:calculateOutputCanonicalHash(payload)}
  } else if(origin.kind==='ingest-operation') {
    assertDomain(parent.state.document.schemaVersion==='project-output-state/v3' && entries.length>0,
      'PRECONDITION_REQUIRED','Ingest requires an explicit stable variant child before media')
    provenance={kind:'media-ingest-operation',id:origin.operation.id,hash:origin.requestFingerprint};commandId=null;transition='ingest'
    assertDomain(input.normalizations.length>0 && input.normalizations.every(n=>
      n.document.operationId===origin.operation.id && n.document.attempt===origin.operation.attempt &&
      n.document.leaseOwner===origin.leaseOwner && n.document.source.artifactId===origin.detail.sourceArtifactId &&
      n.document.source.manifestId===origin.detail.sourceManifestId),
      'INVALID_COMMAND','Ingest normalization producer/detail differs')
    producerBody={schemaVersion:'output-ingest-producer/v3',canonicalPolicyVersion:OUTPUT_CANONICAL_POLICY_VERSION,
      operationId:origin.operation.id,requestFingerprint:origin.requestFingerprint,attempt:origin.operation.attempt,
      leaseOwner:origin.leaseOwner,uploadId:origin.detail.uploadId,sourceArtifactId:origin.detail.sourceArtifactId,
      sourceManifestId:origin.detail.sourceManifestId,transcriptId:origin.transcript.id,
      transcriptHash:origin.transcript.document.transcriptHash}
  } else {
    const c=(origin as Extract<typeof origin,{command:unknown}>).command
    provenance={kind:'edit-command',id:c.id,hash:c.commandHash};commandId=c.id
    transition=origin.kind==='restore-command'?'restore':origin.kind==='editorial-cut-command'?'editorial-cut':'inherit'
    producerBody={schemaVersion:origin.kind==='editorial-cut-command'?'output-editorial-derived-producer/v1':'output-child-command-producer/v3',canonicalPolicyVersion:OUTPUT_CANONICAL_POLICY_VERSION,
      kind:origin.kind,commandId:c.id,commandHash:c.commandHash,payloadHash:calculateOutputCanonicalHash(c.payload),
      target:origin.kind==='restore-command'?origin.target:null,
      // The adoptions (receipts, seals, sources and the rights they were adopted under) are part of the State's producer.
      ...(origin.kind==='child-command'?{adoptions:JSON.parse(stableSerialize(origin.adoptions)) as OutputJson}:{})}
  }
  const ids=new Set<string>()
  for(const e of entries) {
    const id=input.materializationIds[e.variantId]
    if(p.durationFrames===0) {
      assertDomain(id===undefined && input.normalizations.length===0,'INVALID_PROJECT_VERSION','Empty child cannot hide materialization')
      e.consumption={status:'blocked',reasons:['empty-project']}
    } else {
      requireOutputHash(edit.contentHash,'EditPlan hash')
      requireOutputId(id,'materializationId');assertDomain(!ids.has(id),'INVALID_PROJECT_VERSION','Materialization allocation reused');ids.add(id)
      e.consumption={status:'materialized',materialization:origin.kind==='editorial-cut-command'?materializeEditorialDerivedOutputV1({id,workspaceId:a.workspaceId,projectId:a.projectId,
        resultVersionId:a.resultVersionId,planSnapshotId:edit.id,planHash:edit.contentHash,plan:p,spec:e.spec,
        normalizations:input.normalizations,createdAt:a.createdAt,sourceBinding:origin.command.payload.sourceBinding}):materializeOutputV3({id,workspaceId:a.workspaceId,projectId:a.projectId,
        resultVersionId:a.resultVersionId,planSnapshotId:edit.id,planHash:edit.contentHash,plan:p,spec:(assertDomain(e.spec.schemaVersion==='output-spec-revision/v1','PRECONDITION_REQUIRED','Non-editorial child requires its declared revision contract'),e.spec),
        normalizations:input.normalizations,createdAt:a.createdAt})}
    }
  }
  assertDomain(Object.keys(input.materializationIds).length===ids.size,'INVALID_PROJECT_VERSION','Unused materialization allocation')
  entries.sort((x,y)=>x.variantId<y.variantId?-1:x.variantId>y.variantId?1:0)
  const state=createProjectOutputStateV3({schemaVersion:'project-output-state/v3',canonicalPolicyVersion:OUTPUT_CANONICAL_POLICY_VERSION,
    transitionPolicyVersion:'project-output-transition/v3',id:a.stateId,workspaceId:a.workspaceId,projectId:a.projectId,
    resultVersionId:a.resultVersionId,parentVersionId:parent.version.id,parentStateId:parent.state.document.id,
    parentStateHash:parent.state.stateHash,transition,provenance,producer:{document:producerBody,hash:calculateOutputCanonicalHash(producerBody)},
    editPlan:{snapshotId:edit.id,hash:edit.contentHash,authority:createOutputPlanAuthority({canonicalPolicyVersion:OUTPUT_CANONICAL_POLICY_VERSION,
      kind:'project-edit-plan',planDocument:JSON.parse(edit.contentJson)})},renderablePlan:null,entries,
    overlays:source.state.document.overlays,invalidations:source.state.document.invalidations,
    sourceDependencies:source.state.document.sourceDependencies,createdAt:a.createdAt},
  {editPlanDocument:JSON.parse(edit.contentJson),renderablePlanDocument:null})
  const refs={brief:snapshots.find(s=>s.kind==='brief')!.id,policies:snapshots.find(s=>s.kind==='policies')!.id,editPlan:edit.id,
    ...(snapshots.find(s=>s.kind==='treatment')?{treatment:snapshots.find(s=>s.kind==='treatment')!.id}:{}),
    ...(snapshots.find(s=>s.kind==='story')?{story:snapshots.find(s=>s.kind==='story')!.id}:{})}
  const version=createProjectVersionV3({state,parent:parent.version,snapshotRefs:refs,createdBy:a.createdBy,commandId})
  const outputBaseHashJson=serializeOutputCanonicalJson(outputBoundVersionHashBodyV3({state,previousBaseHash:parent.version.baseHash}))
  return Object.freeze({schemaVersion:'operational-output-version-bundle/v3',origin,version,state,
    snapshots:Object.freeze([...snapshots,edit]),editPlanSnapshot:edit,outputBaseHashJson})
}
