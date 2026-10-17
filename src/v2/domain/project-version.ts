import { assertDomain } from './errors.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION,
  validateOutputCanonicalPolicy, type OutputCanonicalPolicy } from './output-canonical-policy.ts'
import { calculateOutputBoundVersionHash, type ProjectOutputState } from './project-output-state.ts'

export interface ProjectSnapshotRefs {
  brief?: string
  treatment?: string
  story?: string
  editPlan: string
  policies: string
}
export interface ProjectVersion extends OutputCanonicalPolicy {
  schemaVersion: 1
  id: string
  workspaceId: string
  projectId: string
  sequence: number
  parentVersionId?: string
  forkedFromProjectId?: string
  forkedFromVersionId?: string
  snapshotRefs: Readonly<ProjectSnapshotRefs>
  baseHash: string
  outputContractVersion: 1
  outputStateId: string
  outputStateHash: string
  createdBy: string
  createdAt: string
  commandId?: string
}

export type ProjectVersionInput = Omit<ProjectVersion,
  'schemaVersion' | 'outputContractVersion' | 'outputStateId' | 'outputStateHash'> & {
  outputState: Readonly<ProjectOutputState>
  previousBaseHash: string | null
}

/** Audit-only history has a separate type. It cannot enter rebuildRetiredContractOneVersion
 * or any operational reader accepting ProjectVersion. No automatic fallback. */
export interface HistoricalProjectVersionAudit {
  kind: 'historical-project-version-audit'
  outputContractVersion: 0
  id: string
  workspaceId: string
  projectId: string
  baseHash: string
  document: Readonly<Record<string, unknown>>
}

function requireIdentifier(value: string, field: string): void {
  assertDomain(
    value.trim().length > 0,
    'INVALID_PROJECT_VERSION',
    `${field} is required`,
    { field },
  )
}

/**
 * Retired contract one. It recomputes the Version a legacy contract-one bundle claims so that history can still be
 * validated; nothing operational constructs a Version through it and it is never written. Operational Versions are
 * only ever sealed by the output state transition (contracts two and three). The domain layer alone may call it.
 */
export function rebuildRetiredContractOneVersion(input: ProjectVersionInput): Readonly<ProjectVersion> {
  validateOutputCanonicalPolicy(input)
  requireIdentifier(input.id, 'id')
  requireIdentifier(input.workspaceId, 'workspaceId')
  requireIdentifier(input.projectId, 'projectId')
  requireIdentifier(input.snapshotRefs.editPlan, 'snapshotRefs.editPlan')
  requireIdentifier(input.snapshotRefs.policies, 'snapshotRefs.policies')
  requireIdentifier(input.baseHash, 'baseHash')
  requireIdentifier(input.createdBy, 'createdBy')
  assertDomain(
    Number.isInteger(input.sequence) && input.sequence >= 1,
    'INVALID_PROJECT_VERSION',
    'ProjectVersion sequence must be a positive integer',
    { sequence: input.sequence },
  )
  assertDomain(
    !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_PROJECT_VERSION',
    'ProjectVersion createdAt must be an ISO-compatible date',
    { createdAt: input.createdAt },
  )
  assertDomain(
    input.sequence === 1 ? !input.parentVersionId : Boolean(input.parentVersionId),
    'INVALID_PROJECT_VERSION',
    'Only the first version may omit parentVersionId',
    { sequence: input.sequence, parentVersionId: input.parentVersionId },
  )

  const state = input.outputState
  assertDomain(state !== undefined && state.document.schemaVersion === 'project-output-state/v1' &&
    state.document.canonicalPolicyVersion === OUTPUT_CANONICAL_POLICY_VERSION &&
    calculateOutputCanonicalHash(state.document) === state.stateHash,
  'INVALID_PROJECT_VERSION', 'An operational ProjectVersion requires its sealed output state')
  const body = state.document
  assertDomain(body.resultVersionId === input.id && body.projectId === input.projectId &&
    body.workspaceId === input.workspaceId && body.parentVersionId === (input.parentVersionId ?? null) &&
    body.editPlan.snapshotId === input.snapshotRefs.editPlan && body.createdAt === input.createdAt,
  'INVALID_PROJECT_VERSION', 'Output state does not belong to this exact ProjectVersion')
  assertDomain(input.sequence === 1 ? input.previousBaseHash === null :
    typeof input.previousBaseHash === 'string' && /^[a-f0-9]{64}$/.test(input.previousBaseHash),
  'INVALID_PROJECT_VERSION', 'Version lineage requires its exact previous base hash')
  assertDomain(input.baseHash === calculateOutputBoundVersionHash({ workspaceId: input.workspaceId,
    projectId: input.projectId, resultVersionId: input.id, parentVersionId: input.parentVersionId ?? null,
    previousBaseHash: input.previousBaseHash, producerHash: body.producer.hash,
    outputStateId: body.id, outputStateHash: state.stateHash }),
  'INVALID_PROJECT_VERSION', 'ProjectVersion hash is not bound to its exact output state')
  assertDomain(input.sequence === 1 ? body.provenance.kind === 'creation-command' &&
    (input.forkedFromVersionId ? body.transition === 'fork-empty' :
      body.transition === 'initialize-empty') : body.provenance.kind !== 'creation-command',
  'INVALID_PROJECT_VERSION', 'Output state root/fork/child provenance mismatch')
  assertDomain(body.provenance.kind === 'edit-command' ? input.commandId === body.provenance.id :
    input.commandId === undefined, 'INVALID_PROJECT_VERSION', 'Version Command provenance mismatch')
  const { outputState: _outputState, previousBaseHash: _previousBaseHash, ...version } = input

  return Object.freeze({
    ...version,
    schemaVersion: 1 as const,
    canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    outputContractVersion: 1 as const,
    outputStateId: body.id,
    outputStateHash: state.stateHash,
    snapshotRefs: Object.freeze({
      ...(input.snapshotRefs.brief !== undefined
        ? { brief: input.snapshotRefs.brief }
        : {}),
      ...(input.snapshotRefs.treatment !== undefined
        ? { treatment: input.snapshotRefs.treatment }
        : {}),
      ...(input.snapshotRefs.story !== undefined
        ? { story: input.snapshotRefs.story }
        : {}),
      editPlan: input.snapshotRefs.editPlan,
      policies: input.snapshotRefs.policies,
    }),
  })
}

export function createHistoricalProjectVersionAudit(input: {
  outputContractVersion: 0
  outputStateId: null
  outputStateHash: null
  id: string
  workspaceId: string
  projectId: string
  baseHash: string
  document: Readonly<Record<string, unknown>>
}): Readonly<HistoricalProjectVersionAudit> {
  assertDomain(input.outputContractVersion === 0 && input.outputStateId === null && input.outputStateHash === null,
    'INVALID_PROJECT_VERSION', 'Historical audit must explicitly be unsealed')
  for (const [field, value] of Object.entries({ id: input.id, workspaceId: input.workspaceId,
    projectId: input.projectId, baseHash: input.baseHash })) requireIdentifier(value, field)
  return Object.freeze({ kind: 'historical-project-version-audit' as const, outputContractVersion: 0 as const,
    id: input.id, workspaceId: input.workspaceId, projectId: input.projectId, baseHash: input.baseHash,
    document: Object.freeze({ ...input.document }) })
}

import { validateProjectCreationOutputStateV2, type ProjectOutputStateV2 } from './project-output-state.ts'
import { validateProjectCreationOutputCommandV2, type ProjectCreationOutputCommandV2 } from './project-creation-command.ts'
import { serializeOutputCanonicalJson } from './output-canonical-policy.ts'

export interface ProjectVersionV2 extends Omit<ProjectVersion,
  'outputContractVersion' | 'parentVersionId' | 'commandId'> {
  outputContractVersion: 2
  sequence: 1
}
export function outputBoundVersionHashBodyV2(commandInput: ProjectCreationOutputCommandV2, stateInput: ProjectOutputStateV2) {
  const command = validateProjectCreationOutputCommandV2(commandInput), state = validateProjectCreationOutputStateV2(stateInput, command)
  return Object.freeze({ canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    schemaVersion: 'project-output-bound-version-hash/v2', workspaceId: command.workspaceId, projectId: command.projectId,
    resultVersionId: command.versionId, parentVersionId: null, previousBaseHash: null,
    producerHash: state.document.producer.hash, outputStateId: state.document.id, outputStateHash: state.stateHash })
}
export function createProjectCreationVersionV2(commandInput: ProjectCreationOutputCommandV2, stateInput: ProjectOutputStateV2): Readonly<ProjectVersionV2> {
  const command = validateProjectCreationOutputCommandV2(commandInput), state = validateProjectCreationOutputStateV2(stateInput, command)
  const refs = command.payload.allocations.snapshotRefs, source = command.payload.forkDerivation?.document.kernel.document.source.version
  const version: ProjectVersionV2 = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, schemaVersion: 1,
    outputContractVersion: 2, id: command.versionId, workspaceId: command.workspaceId, projectId: command.projectId,
    sequence: 1, snapshotRefs: { brief: refs.brief, policies: refs.policies, editPlan: refs['edit-plan'],
      ...(refs.treatment ? { treatment: refs.treatment } : {}), ...(refs.story ? { story: refs.story } : {}) },
    ...(source ? { forkedFromProjectId: source.projectId, forkedFromVersionId: source.id } : {}),
    baseHash: calculateOutputCanonicalHash(outputBoundVersionHashBodyV2(command, state)),
    outputStateId: state.document.id, outputStateHash: state.stateHash, createdBy: command.author.id, createdAt: command.createdAt }
  return Object.freeze({ ...version, snapshotRefs: Object.freeze(version.snapshotRefs) })
}
export function validateProjectCreationVersionV2(version: ProjectVersionV2, command: ProjectCreationOutputCommandV2,
  state: ProjectOutputStateV2): Readonly<ProjectVersionV2> {
  const fresh = createProjectCreationVersionV2(command, state)
  assertDomain(serializeOutputCanonicalJson(version) === serializeOutputCanonicalJson(fresh),
    'INVALID_PROJECT_VERSION', 'Creation Version2 identity/content/seals mismatch')
  return fresh
}


import type { ProjectOutputStateV3 } from './project-output-state.ts'
export interface ProjectVersionV3 extends Omit<ProjectVersion,'outputContractVersion'> { outputContractVersion: 3 }
export function outputBoundVersionHashBodyV3(input: Readonly<{
  state: ProjectOutputStateV3; previousBaseHash:string
}>) {
  const s=input.state
  assertDomain(s.document.schemaVersion==='project-output-state/v3' && calculateOutputCanonicalHash(s.document)===s.stateHash &&
    /^[a-f0-9]{64}$/.test(input.previousBaseHash),'INVALID_PROJECT_VERSION','Version3 requires exact State and parent seal')
  return Object.freeze({schemaVersion:'project-output-bound-version-hash/v3',
    canonicalPolicyVersion:OUTPUT_CANONICAL_POLICY_VERSION,workspaceId:s.document.workspaceId,projectId:s.document.projectId,
    resultVersionId:s.document.resultVersionId,parentVersionId:s.document.parentVersionId,
    previousBaseHash:input.previousBaseHash,producerHash:s.document.producer.hash,
    outputStateId:s.document.id,outputStateHash:s.stateHash})
}
export function createProjectVersionV3(input: Readonly<{
  state:ProjectOutputStateV3; parent:ProjectVersionV2|ProjectVersionV3;
  snapshotRefs:ProjectSnapshotRefs; createdBy:string; commandId:string|null
}>): Readonly<ProjectVersionV3> {
  const {state:s,parent:p}=input,d=s.document
  assertDomain((p.outputContractVersion===2||p.outputContractVersion===3) &&
    p.workspaceId===d.workspaceId && p.projectId===d.projectId && p.id===d.parentVersionId &&
    p.outputStateId===d.parentStateId && p.outputStateHash===d.parentStateHash &&
    input.snapshotRefs.editPlan===d.editPlan.snapshotId && input.snapshotRefs.brief && input.snapshotRefs.policies &&
    (d.provenance.kind==='edit-command'?input.commandId===d.provenance.id:input.commandId===null),
    'INVALID_PROJECT_VERSION','Version3 parent/ref/Command binding differs')
  requireIdentifier(input.createdBy,'createdBy')
  assertDomain(Number.isSafeInteger(p.sequence)&&p.sequence>=1,'INVALID_PROJECT_VERSION','Version3 sequence invalid')
  const body=outputBoundVersionHashBodyV3({state:s,previousBaseHash:p.baseHash})
  return Object.freeze({schemaVersion:1,canonicalPolicyVersion:OUTPUT_CANONICAL_POLICY_VERSION,
    outputContractVersion:3,id:d.resultVersionId,workspaceId:d.workspaceId,projectId:d.projectId,
    sequence:p.sequence+1,parentVersionId:p.id,snapshotRefs:Object.freeze({...input.snapshotRefs}),
    baseHash:calculateOutputCanonicalHash(body),outputStateId:d.id,outputStateHash:s.stateHash,
    createdBy:input.createdBy,createdAt:d.createdAt,...(input.commandId===null?{}:{commandId:input.commandId})})
}
