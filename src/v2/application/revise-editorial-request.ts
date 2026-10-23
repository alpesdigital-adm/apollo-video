import { calculateCanonicalHash, stableSerialize } from '../domain/canonical-hash.ts'
import { createDesiredAction, parseDesiredAction, parseDesiredActionInput } from '../domain/desired-action.ts'
import { createEditCommand } from '../domain/edit-command.ts'
import {
  EDITORIAL_EXECUTABLE_VALUES,
  answerBriefQuestions,
  directivesOfChoices,
  createEditorialRequest,
  deriveEditorialRequestFromBrief,
  parseEditorialDirective,
  type BriefInterpretationV1,
  type BriefQuestionChoice,
  type EditorialDirective,
  type EditorialRequestV1,
} from '../domain/editorial-request.ts'
import { createEditorialRequestRevisionImpact, createEditorialRequestRevisionInvalidations } from '../domain/editorial-request-revision-impact.ts'
import { notExecutableSummary } from '../domain/editorial-request-texts.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import type { StrategicObjectiveId } from '../domain/strategic-objective.ts'
import { normalizeBriefingText, parseProductionBrief, createProductionBrief } from '../domain/production-brief.ts'
import { reidentifiedEditPlanSnapshot, transitionProjectOutputState } from '../domain/project-output-state-transition.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { coveredTopicsOf, type BriefInterpretationAudit, type InterpretBrief } from './interpret-brief.ts'
import type { EditorialRequestRepository } from './ports/editorial-request-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
function id(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  assertDomain(ID.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What the owner sends. Each field that is present REPLACES that part of the request; a field that is absent keeps it. `briefing: null` clears the briefing. */
export interface ReviseEditorialRequestBody {
  briefing?: string | null
  directives?: unknown
  variantOverrides?: unknown
  desiredAction?: unknown
  answers?: unknown
}

function structuredOf(brief: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return isRecord(brief.editorialRequest) ? brief.editorialRequest : {}
}

function parseDirectives(value: unknown, where: string): readonly Readonly<EditorialDirective>[] {
  assertDomain(Array.isArray(value), 'INVALID_ARGUMENT', `${where} must be a list of directives`)
  return (value as unknown[]).map((item) => parseEditorialDirective(item, where))
}

function parseVariantOverrides(value: unknown): Readonly<Record<string, readonly Readonly<EditorialDirective>[]>> {
  assertDomain(isRecord(value), 'INVALID_ARGUMENT', 'variantOverrides must be an object keyed by variantId')
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([variantId, list]) => [variantId, parseDirectives(list, `override ${variantId}`)])))
}

function snapshotOf(workspaceId: string, projectId: string, snapshotId: string, document: Record<string, unknown>, createdAt: string) {
  return createProjectSnapshot({
    id: snapshotId, workspaceId, projectId, kind: 'brief', contentSchemaVersion: Number(document.schemaVersion),
    contentJson: stableSerialize(document), contentHash: calculateCanonicalHash(document), createdAt,
  })
}

export function reviseEditorialRequestService(dependencies: {
  repository: EditorialRequestRepository
  /** Reads a briefing. Absent model inside: a briefing with text then fails closed with PRECONDITION_REQUIRED. */
  interpretBrief: InterpretBrief
  createId: (kind: 'command' | 'version' | 'snapshot' | 'edit-plan-snapshot' | 'state' | 'materialization') => string
  createEventId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (request: {
    workspaceId: string
    projectId: string
    baseVersionId: string
    baseHash: string
    body: Readonly<ReviseEditorialRequestBody>
    reason?: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) => {
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const projectId = id(request.projectId, 'projectId')
    const baseVersionId = id(request.baseVersionId, 'baseVersionId')
    assertDomain(/^[a-f0-9]{64}$/.test(request.baseHash), 'INVALID_ARGUMENT', 'baseHash is invalid')
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Editorial request actor does not match the workspace')
    const idempotencyKey = request.idempotencyKey?.trim()
    assertDomain(Boolean(idempotencyKey) && idempotencyKey.length >= 8 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const reason = request.reason?.replace(/\s+/gu, ' ').trim()
    assertDomain(reason === undefined || (reason.length > 0 && reason.length <= 1_000), 'INVALID_ARGUMENT', 'reason is invalid')

    // The body is validated before anything else: nothing is read, and no model is called, for a request that cannot be this Command's.
    const body = request.body
    assertDomain(isRecord(body) && Object.keys(body).every((key) => ['briefing', 'directives', 'variantOverrides', 'desiredAction', 'answers'].includes(key)),
      'INVALID_ARGUMENT', 'The editorial request body has unsupported fields')
    assertDomain(body.briefing === undefined || body.briefing === null || typeof body.briefing === 'string', 'INVALID_ARGUMENT', 'briefing must be a text or null')
    const bodyBriefing = typeof body.briefing === 'string' ? normalizeBriefingText(body.briefing) : body.briefing
    assertDomain(bodyBriefing === undefined || bodyBriefing === null || (bodyBriefing.length > 0 && bodyBriefing.length <= 10_000), 'INVALID_ARGUMENT',
      'A briefing is any text of 1 to 10000 characters; to remove it send null')
    const bodyDirectives = body.directives === undefined ? undefined : parseDirectives(body.directives, 'request')
    const bodyOverrides = body.variantOverrides === undefined ? undefined : parseVariantOverrides(body.variantOverrides)
    const bodyDesiredAction = body.desiredAction === undefined ? undefined : parseDesiredActionInput(body.desiredAction)
    const answers = body.answers === undefined ? undefined : body.answers
    assertDomain(answers === undefined || Array.isArray(answers), 'INVALID_ARGUMENT', 'answers must be a list')
    assertDomain(Object.keys(body).length > 0, 'INVALID_ARGUMENT', 'The editorial request body names nothing to revise; to read the briefing again name it')

    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'revise-editorial-request-request/v1', workspaceId, projectId, baseVersionId, baseHash: request.baseHash,
      body: { briefing: bodyBriefing === undefined ? 'kept' : bodyBriefing, directives: bodyDirectives ?? 'kept', variantOverrides: bodyOverrides ?? 'kept',
        desiredAction: bodyDesiredAction ?? 'kept', answers: answers ?? 'none' },
      reason: reason ?? null, actorContextHash: authenticationAudit.contextHash,
    })
    // A replay never calls the model again: the Command it finds already holds the interpretation it made.
    const replay = await dependencies.repository.findIdempotent({ workspaceId, projectId, idempotencyKey, actorContextHash: authenticationAudit.contextHash })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different editorial request')
      return Object.freeze({ ...replay.result, replayed: true })
    }

    const context = await dependencies.repository.readContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project editorial request context was not found')
    const parent = context.parent
    const currentVersion = parent.version
    if (currentVersion.id !== baseVersionId || currentVersion.baseHash !== request.baseHash) throw new DomainError('VERSION_CONFLICT', 'Editorial request base version is stale')

    const currentBrief = context.currentBriefSnapshot.content
    const objective = context.project.objective
    const currentRequest = deriveEditorialRequestFromBrief({ ...currentBrief, objective })
    const currentStructured = structuredOf(currentBrief)
    const currentText = currentRequest.briefing?.text
    const nextText = bodyBriefing === undefined ? currentText : bodyBriefing === null ? undefined : bodyBriefing
    const briefingChanged = nextText !== currentText

    // The interpretation only ever belongs to the exact text it read.
    let interpretation: Readonly<BriefInterpretationV1> | undefined
    let interpretationAudit: Readonly<BriefInterpretationAudit> | null = null
    let interpreted = false
    let answered: readonly string[] = []
    let chosen: readonly EditorialDirective[] = []
    if (nextText !== undefined) {
      const keep = !briefingChanged && currentRequest.interpretation !== undefined
      if (keep) {
        interpretation = currentRequest.interpretation
        interpretationAudit = (isRecord(currentStructured.interpretationAudit) ? currentStructured.interpretationAudit : null) as Readonly<BriefInterpretationAudit> | null
      } else {
        assertDomain(answers === undefined, 'INVALID_ARGUMENT',
          'Questions are answered about the interpretation that raised them; this revision reads the briefing again, so there is nothing to answer yet')
        const read = await dependencies.interpretBrief({ briefing: nextText })
        interpretation = read.interpretation
        interpretationAudit = read.audit
        interpreted = true
      }
      if (answers !== undefined) {
        assertDomain(interpretation !== undefined, 'INVALID_ARGUMENT', 'There is no interpretation to answer')
        const typedAnswers = answers as readonly { questionId: string; answer?: string; choiceId?: string }[]
        // A closed answer is the owner's statement and it decides the plan: it becomes the structured directive of this same revision.
        chosen = directivesOfChoices(interpretation!, typedAnswers)
        interpretation = answerBriefQuestions(interpretation!, nextText, typedAnswers)
        answered = (answers as readonly { questionId: string }[]).map((item) => item.questionId).toSorted()
      }
    } else {
      assertDomain(answers === undefined, 'INVALID_ARGUMENT', 'There is no briefing, so there is no question to answer')
    }

    const baseDirectives = bodyDirectives ?? (Array.isArray(currentStructured.directives) ? (currentStructured.directives as readonly EditorialDirective[]) : [])
    const directives = [...baseDirectives.filter((directive) => !chosen.some((item) => item.id === directive.id)), ...chosen]
    const variantOverrides = bodyOverrides ?? (isRecord(currentStructured.variantOverrides)
      ? (currentStructured.variantOverrides as Record<string, readonly EditorialDirective[]>) : {})
    const currentDesiredAction = parseDesiredAction(currentBrief.desiredAction, objective as StrategicObjectiveId)
    const desiredAction = bodyDesiredAction !== undefined
      ? createDesiredAction({ objective: objective as StrategicObjectiveId, desiredAction: bodyDesiredAction })
      : currentDesiredAction
    // The request the Version will carry. The constructor repeats every check (vocabulary, citations, the interpretation of THIS text).
    const nextRequest = createEditorialRequest({
      ...(nextText !== undefined ? { briefing: nextText } : {}),
      objective: objective as StrategicObjectiveId, desiredAction, directives, variantOverrides,
      ...(interpretation ? { interpretation } : {}),
    })
    const unchanged = nextRequest.requestHash === currentRequest.requestHash && !interpreted &&
      stableSerialize(structuredOf(currentBrief).interpretationAudit ?? null) === stableSerialize(interpretationAudit ?? null)
    assertDomain(!unchanged, 'INVALID_ARGUMENT', 'The editorial request is unchanged')

    const createdAt = clock().toISOString()
    const commandId = id(dependencies.createId('command'), 'commandId')
    const versionId = id(dependencies.createId('version'), 'versionId')
    const snapshotId = id(dependencies.createId('snapshot'), 'snapshotId')
    const editPlanSnapshotId = id(dependencies.createId('edit-plan-snapshot'), 'editPlanSnapshotId')
    const stateId = id(dependencies.createId('state'), 'stateId')

    // The Brief Snapshot the Version is born with. The compilation of the previous text is not carried (the Director reads the brief again);
    // the production brief states the coverage the interpreter found, or nothing about it when no interpreter has read this text.
    const { briefCompilation: _staleCompilation, ...kept } = currentBrief as Record<string, unknown>
    const previousProductionBrief = parseProductionBrief(currentBrief.productionBrief)
    const productionBrief = createProductionBrief({
      ...(nextText !== undefined ? { ownerText: nextText } : {}),
      ...(previousProductionBrief.ingestedContext ? { ingestedContextRef: previousProductionBrief.ingestedContext.ref } : {}),
      ...(interpretation ? { interpretedCoverage: coveredTopicsOf(interpretation) } : {}),
    })
    const { editorialRequest: _previousRequest, ...rest } = kept
    const briefDocument = Object.freeze({
      ...rest,
      schemaVersion: Number(currentBrief.schemaVersion) === 3 ? 1 : Number(currentBrief.schemaVersion),
      desiredAction,
      productionBrief,
      editorialRequest: Object.freeze({
        ...(directives.length > 0 ? { directives } : {}),
        ...(Object.keys(variantOverrides).length > 0 ? { variantOverrides } : {}),
        ...(interpretation ? { interpretation } : {}),
        ...(interpretationAudit ? { interpretationAudit } : {}),
        revision: Object.freeze({ commandId, revisedAt: createdAt }),
      }),
    }) as Record<string, unknown>
    const briefSnapshot = snapshotOf(workspaceId, projectId, snapshotId, briefDocument, createdAt)
    assertDomain(deriveEditorialRequestFromBrief({ ...briefDocument, objective }).requestHash === nextRequest.requestHash,
      'PERSISTENCE_CONFLICT', 'The Brief Snapshot of the revision does not state the request it was made from')

    const impact = createEditorialRequestRevisionImpact({
      commandId, baseVersionId, resultVersionId: versionId, briefSnapshotId: snapshotId, briefSnapshotHash: briefSnapshot.contentHash,
      previousRequestHash: currentRequest.requestHash, resultRequestHash: nextRequest.requestHash,
      durationFrames: context.currentDurationFrames, outputReferences: context.outputReferences,
    })
    const payload = Object.freeze({
      schemaVersion: 1 as const,
      change: Object.freeze({
        briefing: bodyBriefing === undefined ? 'kept' as const : bodyBriefing === null ? 'cleared' as const : 'replaced' as const,
        directives: bodyDirectives === undefined ? 'kept' as const : 'replaced' as const,
        variantOverrides: bodyOverrides === undefined ? 'kept' as const : 'replaced' as const,
        desiredAction: bodyDesiredAction === undefined ? 'kept' as const : 'replaced' as const,
        answeredQuestionIds: Object.freeze([...answered]),
      }),
      interpreted,
      previousRequestHash: currentRequest.requestHash,
      requestHash: nextRequest.requestHash,
      interpretationHash: interpretation?.interpretationHash ?? null,
      briefSnapshotId: snapshotId, briefSnapshotHash: briefSnapshot.contentHash,
      impact,
      nextRequiredCapability: 'apollo.projects.commands.apply:run-director' as const,
    })
    const author = Object.freeze({
      type: 'api-client' as const, id: authenticationAudit.clientId,
      ...(authenticationAudit.delegatedUserId ? { delegatedUserId: authenticationAudit.delegatedUserId } : {}),
    })
    const command = createEditCommand({
      id: commandId, workspaceId, projectId, baseVersionId, baseHash: request.baseHash,
      author, type: 'revise-editorial-request', scope: { project: true }, payload,
      ...(reason ? { reason } : {}), idempotencyKey, createdAt,
    })
    const bundle = transitionProjectOutputState({
      parent, command, audit: authenticationAudit, requestFingerprint,
      allocation: { workspaceId, projectId, resultVersionId: versionId, stateId, parentVersionId: currentVersion.id, sequence: currentVersion.sequence + 1, createdBy: author.id, createdAt },
      editPlanSnapshot: reidentifiedEditPlanSnapshot(parent, { snapshotId: editPlanSnapshotId, versionId, createdAt }),
      replacementSnapshots: [briefSnapshot],
      createMaterializationId: () => id(dependencies.createId('materialization'), 'materializationId'),
    })
    const version = bundle.version
    const event = createPublicEvent({
      id: dependencies.createEventId(), type: 'project.version.created', version: '1.0.0',
      workspaceId, occurredAt: createdAt, sequence: version.sequence,
      actor: { clientId: author.id, ...(author.delegatedUserId ? { userId: author.delegatedUserId } : {}) },
      resource: { type: 'project-version', id: version.id },
      data: {
        projectId, sequence: version.sequence, parentVersionId: version.parentVersionId, baseHash: version.baseHash,
        commandId, commandType: command.type, briefSnapshotId: snapshotId, briefSnapshotHash: briefSnapshot.contentHash,
        requestHash: nextRequest.requestHash, commandImpactHash: impact.impactHash,
        artifactInvalidationCount: createEditorialRequestRevisionInvalidations({ impact, createdAt }).length,
        nextRequiredCapability: payload.nextRequiredCapability, createdAt,
      },
    })
    return dependencies.repository.commitOrReplay({ bundle, event })
  }
}

/** What a reader sees of the editorial request of the current Version. */
export interface EditorialRequestView {
  request: Readonly<EditorialRequestV1>
  interpretation: Readonly<BriefInterpretationV1> | null
  interpretationAudit: Readonly<BriefInterpretationAudit> | null
  /** `no-briefing`: nothing to read. `awaiting-interpretation`: a briefing with text nobody has read. `interpreted`. */
  state: 'no-briefing' | 'awaiting-interpretation' | 'interpreted'
  unsupported: readonly Readonly<{ id: string; source: 'interpretation' | 'directive'; reason: 'outside-vocabulary' | 'not-executable'; summary: string; excerpt: string | null }>[]
  openQuestions: readonly Readonly<{ id: string; question: string; excerpt: string | null; choices?: readonly Readonly<BriefQuestionChoice>[] }>[]
  /** True while the Director would refuse the request as it stands (an unread briefing, an unsupported item, an open question). */
  blocksDirector: boolean
  hashes: Readonly<{ requestHash: string; briefingSha256: string | null; interpretationHash: string | null; briefSnapshotId: string; briefSnapshotHash: string }>
}

/** What a reader sees of a request and the way its briefing was read; the same view for a project's Brief Snapshot and for the request stored with a batch. */
export type EditorialRequestReading = Omit<EditorialRequestView, 'hashes'>

export function describeRequestReading(request: Readonly<EditorialRequestV1>, audit: unknown): Readonly<EditorialRequestReading> {
  const interpretation = request.interpretation ?? null
  const directives = [
    ...request.directives.map((directive) => ({ directive, source: 'request-field' as const })),
    ...Object.values(request.variantOverrides).flat().map((directive) => ({ directive, source: 'request-field' as const })),
    ...(interpretation?.directives ?? []).map((directive) => ({ directive, source: 'request-briefing' as const })),
  ]
  const unsupported = [
    ...(interpretation?.unsupported ?? []).map((item) => Object.freeze({
      id: item.id, source: 'interpretation' as const, reason: item.reason, summary: item.summary, excerpt: item.excerpt.text as string | null,
    })),
    ...directives.filter(({ directive }) => !EDITORIAL_EXECUTABLE_VALUES[directive.kind].includes(directive.value)).map(({ directive }) => Object.freeze({
      id: directive.id, source: 'directive' as const, reason: 'not-executable' as const,
      summary: notExecutableSummary(directive.kind, directive.value, directive.param), excerpt: ('excerpt' in directive ? (directive as { excerpt: { text: string } }).excerpt.text : null) as string | null,
    })),
  ]
  const openQuestions = (interpretation?.questions ?? []).filter((question) => question.status === 'open')
    .map((question) => Object.freeze({ id: question.id, question: question.question, excerpt: (question.excerpt?.text ?? null) as string | null, ...(question.choices ? { choices: question.choices } : {}) }))
  const state = request.briefing === undefined ? 'no-briefing' as const : interpretation === null ? 'awaiting-interpretation' as const : 'interpreted' as const
  return Object.freeze({
    request, interpretation, interpretationAudit: (isRecord(audit) ? audit : null) as Readonly<BriefInterpretationAudit> | null, state,
    unsupported: Object.freeze(unsupported), openQuestions: Object.freeze(openQuestions),
    blocksDirector: state === 'awaiting-interpretation' || unsupported.length > 0 || openQuestions.length > 0,
  })
}

export function describeEditorialRequest(input: Readonly<{
  objective: string
  briefSnapshot: Readonly<{ id: string; contentHash: string; content: Readonly<Record<string, unknown>> }>
}>): Readonly<EditorialRequestView> {
  const request = deriveEditorialRequestFromBrief({ ...input.briefSnapshot.content, objective: input.objective })
  const reading = describeRequestReading(request, structuredOf(input.briefSnapshot.content).interpretationAudit)
  return Object.freeze({
    ...reading,
    hashes: Object.freeze({
      requestHash: request.requestHash, briefingSha256: request.briefing?.sha256 ?? null, interpretationHash: reading.interpretation?.interpretationHash ?? null,
      briefSnapshotId: input.briefSnapshot.id, briefSnapshotHash: input.briefSnapshot.contentHash,
    }),
  })
}

export function readEditorialRequestService(dependencies: { repository: EditorialRequestRepository }) {
  return async (input: { workspaceId: string; projectId: string }) => {
    const current = await dependencies.repository.readCurrent({ workspaceId: id(input.workspaceId, 'workspaceId'), projectId: id(input.projectId, 'projectId') })
    if (!current) throw new DomainError('PROJECT_NOT_FOUND', 'Project editorial request was not found')
    return Object.freeze({
      version: current.version,
      ...describeEditorialRequest({ objective: current.objective, briefSnapshot: current.briefSnapshot }),
    })
  }
}
