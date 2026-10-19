import { createApiAccessAuditContext, type ApiAccessAuditContext } from './api-access-control.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION,
  validateOutputCanonicalPolicy, type OutputCanonicalPolicy } from './output-canonical-policy.ts'
import { createEditCommand, type EditCommand, type EditCommandInput } from './edit-command.ts'
import { assertDomain } from './errors.ts'
import { createOutputSpecRevisionBody, requireOutputHash, requireOutputId,
  type OutputSpecRevisionBody } from './output-spec-revision.ts'
import type { ProjectOutputState, ProjectOutputStateV2, ProjectOutputStateV3 } from './project-output-state.ts'
import type { HistoricalProjectVersionAudit, ProjectVersion, ProjectVersionV2, ProjectVersionV3 } from './project-version.ts'

export interface OutputVariantCommandPayload extends OutputCanonicalPolicy {
  schemaVersion: 'output-variant-command/v1'
  variantId: string
  expectedRevisionId: string | null
  expectedSpecHash: string | null
  revision: Readonly<OutputSpecRevisionBody>
  revisionSpecHash: string
  impact: Readonly<{
    schemaVersion: 'project-output-state-impact/v1'
    canonicalPolicyVersion: typeof OUTPUT_CANONICAL_POLICY_VERSION
    variantId: string
    previousRevisionId: string | null
    nextRevisionId: string
    renderSemanticsChanged: boolean
    affectedRanges: readonly Readonly<{ startFrame: 0; endFrame: number }>[]
  }>
}
export interface CreateOutputVariantCommandInput {
  command: Omit<EditCommandInput<OutputVariantCommandPayload>, 'type' | 'scope' | 'payload'> & {
    type: 'create-output-variant' | 'revise-output-spec'
  }
  audit: Readonly<ApiAccessAuditContext>
  base: Readonly<ProjectVersion | ProjectVersionV2 | ProjectVersionV3 | HistoricalProjectVersionAudit>
  baseState: Readonly<ProjectOutputState | ProjectOutputStateV2 | ProjectOutputStateV3> | null
  historicalBaselineRequested: boolean
  revision: Readonly<OutputSpecRevisionBody>
  expectedRevisionId: string | null
  expectedSpecHash: string | null
  durationFrames: number
}

/** No public routing is installed by this isolated contract. Application/writer
 * cutover must authenticate, lock/revalidate facts and commit state+Version.
 * Generated revision/Command IDs and timestamps never enter requestFingerprint.
 */
export function createOutputVariantCommand(input: CreateOutputVariantCommandInput): Readonly<{
  command: Readonly<EditCommand<OutputVariantCommandPayload>>
  requestFingerprint: string
  audit: Readonly<ApiAccessAuditContext>
  producer: ProjectOutputState['document']['producer']
}> {
  const audit = createApiAccessAuditContext(input.audit)
  const command = input.command
  assertDomain(audit.contextHash === input.audit.contextHash && audit.workspaceId === command.workspaceId &&
    audit.clientId === command.author.id && command.author.type === 'api-client' &&
    audit.delegatedUserId === command.author.delegatedUserId,
  'AUTH_INVALID', 'Output Command requires its real authenticated actor')
  assertDomain(['create-output-variant', 'revise-output-spec'].includes(command.type),
    'INVALID_COMMAND', 'Unsupported output Command type')
  requireOutputId(command.id, 'command.id')
  requireOutputHash(command.baseHash, 'command.baseHash')
  const revision = createOutputSpecRevisionBody(input.revision)
  assertDomain(revision.workspaceId === command.workspaceId && revision.projectId === command.projectId &&
    revision.createdAt === command.createdAt && input.base.id === command.baseVersionId &&
    input.base.baseHash === command.baseHash && input.base.projectId === command.projectId &&
    input.base.workspaceId === command.workspaceId,
  'VERSION_CONFLICT', 'Output Command base/revision scope mismatch')
  if (input.base.outputContractVersion === 0) {
    assertDomain(input.historicalBaselineRequested === true && command.type === 'create-output-variant' && input.baseState === null,
      'PRECONDITION_REQUIRED', 'Historical versions require an explicitly requested baseline Command')
  } else {
    validateOutputCanonicalPolicy(input.base)
    validateOutputCanonicalPolicy(input.baseState?.document)
    assertDomain(input.historicalBaselineRequested === false && input.baseState !== null &&
      input.baseState.document.resultVersionId === input.base.id && input.baseState.document.id === input.base.outputStateId &&
      input.baseState.stateHash === input.base.outputStateHash &&
      calculateOutputCanonicalHash(input.baseState.document) === input.baseState.stateHash,
    'INVALID_COMMAND', 'Output Command requires the exact base output state')
  }
  const previous = input.baseState?.document.entries.find((entry) => entry.variantId === revision.variantId)
  if (command.type === 'create-output-variant') {
    assertDomain(previous === undefined && revision.revisionNumber === 1 &&
      input.expectedRevisionId === null && input.expectedSpecHash === null,
    'INVALID_COMMAND', 'Create requires a new stable variant and its first revision')
  } else {
    assertDomain(previous !== undefined && previous.outputSpecRevisionId === input.expectedRevisionId &&
      previous.specHash === input.expectedSpecHash && revision.revisionNumber === previous.spec.revisionNumber + 1,
    'VERSION_CONFLICT', 'Revise requires the exact member revision, never the latest revision')
  }
  assertDomain(Number.isInteger(input.durationFrames) && input.durationFrames >= 0,
    'INVALID_COMMAND', 'Output impact requires actual timeline duration')
  const payload: OutputVariantCommandPayload = Object.freeze({ schemaVersion: 'output-variant-command/v1' as const,
    canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    variantId: revision.variantId, expectedRevisionId: input.expectedRevisionId, expectedSpecHash: input.expectedSpecHash,
    revision, revisionSpecHash: calculateOutputCanonicalHash(revision),
    impact: Object.freeze({ schemaVersion: 'project-output-state-impact/v1' as const,
      canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
      variantId: revision.variantId, previousRevisionId: input.expectedRevisionId, nextRevisionId: revision.id,
      renderSemanticsChanged: input.durationFrames > 0,
      affectedRanges: Object.freeze(input.durationFrames === 0 ? [] :
        [Object.freeze({ startFrame: 0 as const, endFrame: input.durationFrames })]) }) })
  // OutputSpec.id names the newly allocated variant; only revise has that
  // identity in the caller's intent. Its effective values always participate.
  const { id: _allocatedOutputId, ...outputIntent } = revision.output
  const requestFingerprint = calculateOutputCanonicalHash({ schemaVersion: 'output-variant-request/v1',
    canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    workspaceId: command.workspaceId, projectId: command.projectId, baseVersionId: command.baseVersionId,
    baseHash: command.baseHash, actorContextHash: audit.contextHash, type: command.type,
    variantId: command.type === 'revise-output-spec' ? revision.variantId : null,
    expectedRevisionId: input.expectedRevisionId, expectedSpecHash: input.expectedSpecHash,
    historicalBaselineRequested: input.historicalBaselineRequested, output: outputIntent,
    profile: revision.profile, preset: revision.preset, reason: command.reason ?? null })
  // Command v1 keeps its historical authority. This new W66 producer seals its
  // intent separately instead of replacing commandHash with a different policy.
  const sealedCommand = createEditCommand({ ...command, scope: { outputVariantIds: [revision.variantId] }, payload })
  const producerDocument = Object.freeze({ schemaVersion: 'output-variant-version-producer/v1',
    canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, commandId: sealedCommand.id,
    commandHash: sealedCommand.commandHash, requestFingerprint, workspaceId: command.workspaceId,
    projectId: command.projectId, baseVersionId: command.baseVersionId, baseHash: command.baseHash,
    payloadHash: calculateOutputCanonicalHash(payload) })
  return Object.freeze({ command: sealedCommand, requestFingerprint, audit,
    producer: Object.freeze({ document: producerDocument, hash: calculateOutputCanonicalHash(producerDocument) }) })
}
