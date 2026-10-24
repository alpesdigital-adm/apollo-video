import { assertDomain, DomainError } from '../domain/errors.ts'
import { applyEditorialCutCommandService, type ApplyEditorialCutCommandRequest, type ApplyEditorialCutCommandDependencies } from './apply-editorial-cut-command.ts'
import type { EditorialCommandRepository } from './ports/editorial-command-repository.ts'
import type { EditorialRequestRepository } from './ports/editorial-request-repository.ts'
import { describeEditorialRequest } from './revise-editorial-request.ts'
import { proposeSpeechRemoval } from './speech-removal-proposal.ts'

/**
 * The owner CONFIRMS a cut the Apollo proposed (ADR-160): "tire o trecho que fala de X" became a question with the stretches that would go, and this is the
 * answer. The caller names the SUBJECT, never the words: the rule of the removal Command is the one the Apollo proposes for that subject from the transcript, so what is
 * cut is exactly what the owner was shown, and a caller cannot dress another cut up as a confirmation. A subject the request does not ask to take out, one the speech
 * does not say, or a base that moved, is refused.
 *
 * It is a capability of its own, with human approval, because an agent that could read the proposal out of the refusal and send it back through the general
 * Command would "confirm" in the owner's place.
 */
export interface ConfirmSpeechRemovalRequest {
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  sourceTranscriptId: string
  variantId: string
  /** The subject exactly as a `remove-speech` directive of the current request states it. */
  subject: string
  reason?: string
  actor: ApplyEditorialCutCommandRequest['actor']
  idempotency: ApplyEditorialCutCommandRequest['idempotency']
}

export function confirmSpeechRemovalService(dependencies: Readonly<{
  requests: EditorialRequestRepository
  cuts: EditorialCommandRepository
  clock: ApplyEditorialCutCommandDependencies['clock']
  createId: ApplyEditorialCutCommandDependencies['createId']
  createEventId: ApplyEditorialCutCommandDependencies['createEventId']
  /** The removal Command (a seam for tests; the production one is applyEditorialCutCommandService). */
  apply?: typeof applyEditorialCutCommandService
}>) {
  return async function confirm(request: Readonly<ConfirmSpeechRemovalRequest>) {
    const subject = typeof request.subject === 'string' ? request.subject : ''
    assertDomain(subject.trim().length > 0 && subject.length <= 200, 'INVALID_ARGUMENT', 'subject must be the words of a remove-speech directive of the request')
    const current = await dependencies.requests.readCurrent({ workspaceId: request.workspaceId, projectId: request.projectId })
    if (!current) throw new DomainError('PROJECT_NOT_FOUND', 'Project editorial request was not found')
    if (current.version.id !== request.baseVersionId) {
      throw new DomainError('VERSION_CONFLICT', 'The cut was proposed for another Version than the current one', { currentVersionId: current.version.id })
    }
    const view = describeEditorialRequest({ ...(current.objective !== undefined ? { objective: current.objective } : {}), briefSnapshot: current.briefSnapshot })
    const asked = [...view.request.directives, ...Object.values(view.request.variantOverrides).flat(), ...(view.interpretation?.directives ?? [])]
      .some((directive) => directive.kind === 'remove-speech' && String(directive.param) === subject)
    assertDomain(asked, 'INVALID_ARGUMENT', 'The request does not ask to take this subject out of the speech')
    const context = await dependencies.cuts.readContext({
      workspaceId: request.workspaceId, projectId: request.projectId, transcriptId: request.sourceTranscriptId, variantId: request.variantId,
    })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project or aligned transcript was not found')
    const proposal = proposeSpeechRemoval(subject, context.transcript, { sourceTranscriptId: request.sourceTranscriptId })
    assertDomain(proposal.searchable && proposal.matches.length > 0, 'INVALID_COMMAND', 'The speech does not say this subject, so there is nothing to confirm')
    return (dependencies.apply ?? applyEditorialCutCommandService)({
      repository: dependencies.cuts, clock: dependencies.clock, createId: dependencies.createId, createEventId: dependencies.createEventId,
    })({
      workspaceId: request.workspaceId, projectId: request.projectId, baseVersionId: request.baseVersionId, baseHash: request.baseHash,
      sourceTranscriptId: request.sourceTranscriptId, variantId: request.variantId,
      rules: [{ id: proposal.ruleId, label: proposal.label, alternatives: [...proposal.alternatives] }],
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      actor: request.actor, idempotency: request.idempotency,
    })
  }
}
