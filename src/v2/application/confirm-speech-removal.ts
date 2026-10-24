import { assertDomain, DomainError } from '../domain/errors.ts'
import { applyEditorialCutCommandService, type ApplyEditorialCutCommandRequest, type ApplyEditorialCutCommandDependencies } from './apply-editorial-cut-command.ts'
import { requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { EditorialCommandRepository } from './ports/editorial-command-repository.ts'
import type { EditorialRequestRepository } from './ports/editorial-request-repository.ts'
import { describeEditorialRequest } from './revise-editorial-request.ts'
import { confirmSpeechPassages, type SpeechPassageAdjustment } from './speech-passage.ts'
import { proposeSpeechRemoval } from './speech-removal-proposal.ts'

/**
 * The owner CONFIRMS a cut the Apollo proposed (ADR-160): "tire o trecho que fala de X" became a question with the PASSAGES that would go (each a block of speech
 * from the first sentence that mentions the subject to the last), and this is the answer. The caller names the SUBJECT, never the words: the rule of the removal
 * Command is the one the Apollo proposes for that subject from the transcript, so what is cut is exactly what the owner was shown, and a caller cannot dress another
 * cut up as a confirmation.
 *
 * The person may ADJUST where a passage starts and ends (`adjustments`), only to the start of a word or segment and the end of one, within the limits the proposal
 * gave (not into the neighbouring passage, not beyond the speech), and never leaving out a mention that anchors the passage. Without an adjustment the passage is the
 * proposed one. The cut is exactly the passages as confirmed, and the Command records them (`confirmation.passages`: the bounds cut, the bounds proposed, whether
 * the person moved them).
 *
 * Who may confirm (the id and the words of a proposal are computable and are shown in the refusal of the Director, so they prove nothing):
 *  - a person on a screen: the user session (`ui-session`) is the person;
 *  - any other client: the scope `speech-removals:confirm`, which the owner grants explicitly (an agent through MCP also needs the human approval of its tool).
 * The means is written into the Command (`confirmation.medium`), beside the actor of its audit. A removal sent through the general Command carries no confirmation: it is
 * a valid cut, asked for explicitly, and it does not satisfy the question of any proposal.
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
  /** The passages the person moved, by id: where each one starts and ends instead. A passage not named here is cut as proposed. */
  adjustments?: readonly Readonly<SpeechPassageAdjustment>[]
  reason?: string
  actor: Readonly<AuthenticatedExternalActor>
  idempotency: ApplyEditorialCutCommandRequest['idempotency']
}

/** The means by which this actor is a verified human or a client the owner granted: a screen session, or the explicit scope. Anything else is refused. */
export function speechRemovalConfirmationMedium(actor: Readonly<AuthenticatedExternalActor>): 'ui-session' | 'api-key-scope' {
  if (actor.authenticationKind === 'ui-session') return 'ui-session'
  requireScope(actor, 'speech-removals:confirm')
  return 'api-key-scope'
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
    requireScope(request.actor, 'projects:write')
    const medium = speechRemovalConfirmationMedium(request.actor)
    const subject = typeof request.subject === 'string' ? request.subject : ''
    assertDomain(subject.trim().length > 0 && subject.length <= 200, 'INVALID_ARGUMENT', 'subject must be the words of a remove-speech directive of the request')
    const current = await dependencies.requests.readCurrent({ workspaceId: request.workspaceId, projectId: request.projectId })
    if (!current) throw new DomainError('PROJECT_NOT_FOUND', 'Project editorial request was not found')
    if (current.version.id !== request.baseVersionId) {
      throw new DomainError('VERSION_CONFLICT', 'The cut was proposed for another Version than the current one', { currentVersionId: current.version.id })
    }
    const view = describeEditorialRequest({ ...(current.objective !== undefined ? { objective: current.objective } : {}), briefSnapshot: current.briefSnapshot })
    const says = (directives: readonly Readonly<{ kind: string; param?: unknown }>[]) => directives.some((directive) => directive.kind === 'remove-speech' && String(directive.param) === subject)
    const forAll = says(view.request.directives) || says(view.interpretation?.directives ?? [])
    const forOutputs = Object.entries(view.request.variantOverrides).filter(([, directives]) => says(directives)).map(([variantId]) => variantId)
    assertDomain(forAll || forOutputs.length > 0, 'INVALID_ARGUMENT', 'The request does not ask to take this subject out of the speech')
    const context = await dependencies.cuts.readContext({
      workspaceId: request.workspaceId, projectId: request.projectId, transcriptId: request.sourceTranscriptId, variantId: request.variantId,
    })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project or aligned transcript was not found')
    // A cut takes stretches out of the timeline that every output plays. A request for one output among several asks for something the plan cannot do (the
    // resolution lists it as not executable), so it is not confirmed; a request for the only output of the project is a request for the plan.
    if (!forAll) {
      const outputs = context.parent.state.document.entries.map((entry) => entry.variantId)
      assertDomain(outputs.length === 1 && forOutputs.includes(outputs[0]!), 'INVALID_COMMAND',
        'The request asks for this cut for one output of several; a cut takes the stretches out of the video every output plays, so it is not confirmed for one output alone')
    }
    const proposal = proposeSpeechRemoval(subject, context.transcript, { sourceTranscriptId: request.sourceTranscriptId })
    assertDomain(proposal.searchable && proposal.matches.length > 0 && proposal.passages !== undefined && proposal.passages.length > 0 && proposal.search !== undefined,
      'INVALID_COMMAND', 'The speech does not say this subject, so there is nothing to confirm')
    // Refused whole when any adjustment leaves its limits: the cut is what the person confirmed or it is not made.
    const passages = confirmSpeechPassages({
      passages: proposal.passages!, words: context.transcript.words, segments: context.transcript.segments,
      ...(request.adjustments !== undefined ? { adjustments: request.adjustments } : {}),
    })
    const { maxGapSeconds, maxGapSentences, maxSentenceSeconds, name } = proposal.search!.policy
    return (dependencies.apply ?? applyEditorialCutCommandService)({
      repository: dependencies.cuts, clock: dependencies.clock, createId: dependencies.createId, createEventId: dependencies.createEventId,
    })({
      workspaceId: request.workspaceId, projectId: request.projectId, baseVersionId: request.baseVersionId, baseHash: request.baseHash,
      sourceTranscriptId: request.sourceTranscriptId, variantId: request.variantId,
      rules: [{ id: proposal.ruleId, label: proposal.label, alternatives: [...proposal.alternatives] }],
      exclusionOverrides: passages.map((passage) => ({
        sourceStartSeconds: passage.startSeconds, sourceEndSeconds: passage.endSeconds, ruleIds: [proposal.ruleId],
        reason: `Passage ${passage.id} confirmed by a person ${passage.adjusted ? 'with adjusted bounds' : 'as proposed'}`,
      })),
      confirmation: {
        subject, medium, passages: [...passages],
        search: {
          matching: proposal.search!.matching, language: proposal.search!.language, lexicon: proposal.search!.lexicon,
          policy: { name, maxGapSeconds, maxGapSentences, maxSentenceSeconds },
        },
      },
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      actor: request.actor, idempotency: request.idempotency,
    })
  }
}
