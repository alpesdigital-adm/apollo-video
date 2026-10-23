import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import {
  answerBriefQuestions,
  createEditorialRequest,
  directivesOfChoices,
  EDITORIAL_REQUEST_BLOCKED_REASON,
  type EditorialDirective,
} from '../domain/editorial-request.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { normalizeBriefingText } from '../domain/production-brief.ts'
import type { ProductionBatch, ProductionBatchEditorialRequest } from '../domain/production-batch.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { InterpretBrief } from './interpret-brief.ts'
import type { ProductionBatchRepository } from './ports/production-batch-repository.ts'
import { describeRequestReading } from './revise-editorial-request.ts'

/**
 * ADR-160 F8. The request of a production batch, as it stands NOW, and what the owner can do with it.
 *
 * The batch document is immutable (its definition hash covers the request it was created with), so a later request is an append-only revision
 * stored beside it. The current request is the highest revision, or the creation request when there is none. A request with an open question
 * or an item the Apollo cannot do is never ignored: it blocks the generation of the batch, with its reason.
 */
export interface CurrentBatchEditorialRequest {
  /** 0 is the request the batch was created with. */
  sequence: number
  editorialRequest: Readonly<ProductionBatchEditorialRequest>
  createdAt: string
}

export async function currentBatchEditorialRequest(
  repository: Pick<ProductionBatchRepository, 'readCurrentEditorialRequest'>,
  batch: Readonly<Pick<ProductionBatch, 'id' | 'workspaceId' | 'editorialRequest' | 'createdAt'>>,
): Promise<Readonly<CurrentBatchEditorialRequest> | null> {
  const revision = await repository.readCurrentEditorialRequest({ workspaceId: batch.workspaceId, batchId: batch.id })
  if (revision) return Object.freeze({ sequence: revision.sequence, editorialRequest: revision.editorialRequest, createdAt: revision.createdAt })
  return batch.editorialRequest ? Object.freeze({ sequence: 0, editorialRequest: batch.editorialRequest, createdAt: batch.createdAt }) : null
}

/** The view of the request of one batch: the briefing as written, how it was read, what the Apollo cannot do, what it still asks. */
export function describeBatchEditorialRequest(
  batch: Readonly<Pick<ProductionBatch, 'id' | 'projectId' | 'name'>>,
  current: Readonly<CurrentBatchEditorialRequest> | null,
) {
  const identityOfBatch = Object.freeze({ id: batch.id, projectId: batch.projectId, name: batch.name })
  if (!current) {
    return Object.freeze({
      batch: identityOfBatch, state: 'no-request' as const, request: null, interpretation: null, interpretationAudit: null,
      unsupported: Object.freeze([]), openQuestions: Object.freeze([]), blocksGeneration: false, revision: null, hashes: null,
    })
  }
  const stored = current.editorialRequest
  const reading = describeRequestReading(stored.request, stored.interpretationAudit)
  return Object.freeze({
    batch: identityOfBatch,
    state: 'interpreted' as const,
    request: stored.request,
    interpretation: reading.interpretation,
    interpretationAudit: reading.interpretationAudit,
    unsupported: reading.unsupported,
    openQuestions: reading.openQuestions,
    blocksGeneration: reading.blocksDirector,
    revision: Object.freeze({ sequence: current.sequence, createdAt: current.createdAt }),
    hashes: Object.freeze({
      requestHash: stored.request.requestHash,
      briefingSha256: stored.request.briefing?.sha256 ?? null,
      interpretationHash: reading.interpretation?.interpretationHash ?? null,
    }),
  })
}

/**
 * Generation is the work a batch starts or restarts (resume, start a step, retry a step). While the request of the batch has an open question or
 * an item the Apollo cannot do, none of it starts: the refusal names its reason and what is missing, and the owner answers or changes the briefing.
 */
export async function assertBatchRequestAllowsGeneration(
  repository: Pick<ProductionBatchRepository, 'readCurrentEditorialRequest'>,
  batch: Readonly<Pick<ProductionBatch, 'id' | 'workspaceId' | 'editorialRequest' | 'createdAt'>>,
): Promise<void> {
  const current = await currentBatchEditorialRequest(repository, batch)
  if (!current) return
  const reading = describeRequestReading(current.editorialRequest.request, current.editorialRequest.interpretationAudit)
  if (!reading.blocksDirector) return
  const parts = [
    reading.openQuestions.length > 0 ? `${reading.openQuestions.length} question(s) of the briefing are still open` : null,
    reading.unsupported.length > 0 ? `${reading.unsupported.length} request(s) of the briefing are not something the Apollo can do` : null,
  ].filter((part): part is string => part !== null)
  throw new DomainError('PRECONDITION_REQUIRED', `The batch cannot be generated: ${parts.join(' and ')}. Answer them or change the briefing of the batch.`, {
    reason: EDITORIAL_REQUEST_BLOCKED_REASON, openQuestions: reading.openQuestions.length, unsupported: reading.unsupported.length,
  })
}

export interface ReviseBatchEditorialRequestBody {
  /** The hash of the request the owner was looking at; null when the batch had no request. A request that changed since is a conflict. */
  expectedRequestHash: string | null
  /** The new briefing of the batch: it is read again, and the answers given to the old text no longer stand. */
  briefing?: string
  /** The answers to the open questions (a closed question is answered by its `choiceId`). Not together with a new briefing. */
  answers?: unknown
}

const REQUEST_HASH = /^[a-f0-9]{64}$/u

export function reviseProductionBatchEditorialRequestService(dependencies: {
  repository: ProductionBatchRepository
  /** Reads a briefing (fail-closed with a typed refusal when the deployment has no interpreter or it did not answer). */
  interpretBrief: InterpretBrief
  createRevisionId: () => string
  clock: () => Date
}) {
  return async function execute(request: Readonly<{
    workspaceId: string
    batchId: string
    body: Readonly<ReviseBatchEditorialRequestBody>
    actor: AuthenticatedExternalActor
    idempotencyKey: string
  }>) {
    const { workspaceId, batchId } = request
    assertDomain(typeof workspaceId === 'string' && workspaceId.length > 0 && typeof batchId === 'string' && batchId.length > 0, 'INVALID_ARGUMENT', 'workspaceId and batchId are required')
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Batch request actor does not belong to the workspace')
    const idempotencyKey = request.idempotencyKey?.trim() ?? ''
    assertDomain(/^[\x21-\x7E]{8,128}$/u.test(idempotencyKey), 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const body = request.body
    assertDomain(body.expectedRequestHash === null || (typeof body.expectedRequestHash === 'string' && REQUEST_HASH.test(body.expectedRequestHash)), 'INVALID_ARGUMENT',
      'expectedRequestHash is the hash of the request you were looking at, or null when the batch has none')
    assertDomain(body.briefing !== undefined || body.answers !== undefined, 'INVALID_ARGUMENT', 'Name the new briefing or the answers: there is nothing to revise')
    assertDomain(body.briefing === undefined || body.answers === undefined, 'INVALID_ARGUMENT',
      'Questions are answered about the reading that raised them; a new briefing is read again, so there is nothing to answer yet')
    const nextText = body.briefing === undefined ? undefined : normalizeBriefingText(typeof body.briefing === 'string' ? body.briefing : '')
    assertDomain(nextText === undefined || (nextText.length > 0 && nextText.length <= 10_000), 'INVALID_ARGUMENT', 'A briefing is any text of 1 to 10000 characters')
    const answers = body.answers
    assertDomain(answers === undefined || (Array.isArray(answers) && answers.length > 0), 'INVALID_ARGUMENT', 'answers must be a non-empty list')

    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'revise-batch-editorial-request-request/v1', workspaceId, batchId,
      expectedRequestHash: body.expectedRequestHash, briefing: nextText ?? 'kept', answers: answers ?? 'none', actorContextHash: audit.contextHash,
    })
    // A replay never calls the model again: the revision it finds already holds the reading it made.
    const replay = await dependencies.repository.findRequestRevisionReplay({ workspaceId, actorClientId: audit.clientId, actorContextHash: audit.contextHash, idempotencyKey })
    const batch = await dependencies.repository.read({ workspaceId, batchId })
    if (!batch) throw new DomainError('PRODUCTION_BATCH_NOT_FOUND', 'Production batch was not found')
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different editorial request revision')
      const sealed = Object.freeze({ sequence: replay.revision.sequence, editorialRequest: replay.revision.editorialRequest, createdAt: replay.revision.createdAt })
      return Object.freeze({ revision: replay.revision, view: describeBatchEditorialRequest(batch, sealed), replayed: true })
    }

    const current = await currentBatchEditorialRequest(dependencies.repository, batch)
    const currentHash = current?.editorialRequest.request.requestHash ?? null
    if (body.expectedRequestHash !== currentHash) throw new DomainError('VERSION_CONFLICT', 'The request of the batch changed since you read it')
    const currentRequest = current?.editorialRequest.request
    const currentText = currentRequest?.briefing?.text
    assertDomain(nextText !== undefined || (currentRequest?.interpretation !== undefined && currentText !== undefined), 'INVALID_ARGUMENT',
      'There is no reading of a briefing to answer: send the briefing of the batch')
    const text = nextText ?? currentText!
    const briefingChanged = nextText !== undefined && nextText !== currentText

    let interpretation = briefingChanged || currentRequest?.interpretation === undefined ? undefined : currentRequest.interpretation
    let interpretationAudit = briefingChanged || currentRequest?.interpretation === undefined ? null : current?.editorialRequest.interpretationAudit ?? null
    let interpreted = false
    if (interpretation === undefined) {
      const read = await dependencies.interpretBrief({ briefing: text })
      interpretation = read.interpretation
      interpretationAudit = read.audit as unknown as Readonly<Record<string, unknown>>
      interpreted = true
    }
    let chosen: readonly Readonly<EditorialDirective>[] = []
    let answered: readonly string[] = []
    if (answers !== undefined) {
      const typed = answers as readonly { questionId: string; answer?: string; choiceId?: string }[]
      chosen = directivesOfChoices(interpretation, typed)
      interpretation = answerBriefQuestions(interpretation, text, typed)
      answered = typed.map((item) => item.questionId).toSorted()
    }
    // A choice is the owner's answer to a question of the reading of THAT text: a new briefing drops the directives the old answers made.
    const kept = (currentRequest?.directives ?? []).filter((directive) => !(briefingChanged && /^answer-q[0-9]+$/u.test(directive.id)))
    const directives = [...kept.filter((directive) => !chosen.some((item) => item.id === directive.id)), ...chosen]
    const nextRequest = createEditorialRequest({ briefing: text, directives, interpretation })
    assertDomain(nextRequest.requestHash !== currentHash || interpreted, 'INVALID_ARGUMENT', 'The request of the batch is unchanged')

    const createdAt = dependencies.clock().toISOString()
    const result = await dependencies.repository.persistRequestRevision({
      id: dependencies.createRevisionId(), workspaceId, batchId, sequence: (current?.sequence ?? 0) + 1,
      previousRequestHash: currentHash,
      editorialRequest: Object.freeze({ request: nextRequest, interpretationAudit }),
      change: Object.freeze({ briefing: briefingChanged || currentRequest === undefined ? 'replaced' : 'kept', answeredQuestionIds: Object.freeze([...answered]), interpreted }),
      createdAt, requestFingerprint, idempotencyKey, actorClientId: audit.clientId, authenticationAudit: audit,
    })
    const sealed = Object.freeze({ sequence: result.revision.sequence, editorialRequest: result.revision.editorialRequest, createdAt: result.revision.createdAt })
    return Object.freeze({ revision: result.revision, view: describeBatchEditorialRequest(batch, sealed), replayed: result.replayed })
  }
}
