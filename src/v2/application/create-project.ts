import { assertDomain, DomainError } from '../domain/errors.ts'
import { createProject } from '../domain/project.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createProductionBrief, normalizeBriefingText } from '../domain/production-brief.ts'
import { coveredTopicsOf, type BriefInterpretationAudit, type InterpretBrief } from './interpret-brief.ts'
import { BRIEF_INTERPRETATION_FAILED_REASON, BRIEF_INTERPRETER_UNAVAILABLE_REASON, parseBriefInterpretation, parseBriefInterpretationAudit, type BriefInterpretationV1 } from '../domain/editorial-request.ts'
import { createProjectCreationOutputCommandV2, normalizeProjectCreationIntentV2 } from '../domain/project-creation-command.ts'
import { createOutputVariantCommand } from '../domain/output-variant-command.ts'
import { createOutputSpecRevisionBody, type OutputSpecRevisionBody } from '../domain/output-spec-revision.ts'
import { assertSubtitleDeliverySupportedAtFps } from '../domain/output-spec.ts'
import { OUTPUT_CANONICAL_POLICY_VERSION, serializeOutputCanonicalJson } from '../domain/output-canonical-policy.ts'
import { buildOperationalOutputVersionBundleV3, operationalBundlePlanV3,
  type BuildOperationalOutputVersionBundleV3 } from '../domain/output-version-bundle.ts'
import type { DesiredActionInput } from '../domain/desired-action.ts'
import type { StrategicObjectiveId } from '../domain/strategic-objective.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { CreationOutputBundleRepositoryV2, OperationalOutputBundleRepositoryV3 } from './ports/output-version-bundle-repository.ts'
import { calculateVersionHash, stableSerialize } from './version-hash.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}
function exact(value: unknown, fields: readonly string[], field: string, optional: readonly string[] = []) {
  const body = record(value, field)
  if (fields.some(k => !(k in body)) || Object.keys(body).some(k => !fields.includes(k) && !optional.includes(k)))
    throw new DomainError('INVALID_ARGUMENT', `${field} has missing or unsupported fields`)
  return body
}
function sealed(value: unknown, field: string) { if (value !== null) exact(value, ['schemaVersion', 'document', 'hash'], field) }
export function parseCreateProjectOutputVariantBody(raw: unknown): CreateProjectOutputVariantInput {
  serializeOutputCanonicalJson(raw)
  const body = exact(raw, ['baseVersionId', 'baseHash', 'output', 'profile', 'preset'], 'body', ['reason'])
  if (typeof body.baseVersionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(body.baseVersionId) ||
    typeof body.baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.baseHash) ||
    body.reason !== undefined && (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000))
    throw new DomainError('INVALID_ARGUMENT', 'Output base or reason is invalid')
  const output = exact(body.output, ['locale', 'aspectRatio', 'width', 'height', 'fps', 'safeArea', 'deliveryProfileId'], 'output')
  if (!Number.isInteger(output.fps) || Number(output.fps) < 1 || Number(output.fps) > 120 ||
    !Number.isInteger(output.width) || Number(output.width) < 1 || !Number.isInteger(output.height) || Number(output.height) < 1)
    throw new DomainError('INVALID_ARGUMENT', 'Operational output canvas and FPS must be positive integers')
  exact(output.safeArea, ['top', 'right', 'bottom', 'left'], 'output.safeArea')
  const profile = exact(body.profile, ['schemaVersion', 'id', 'version', 'rendererContractVersion', 'final', 'proxy',
    'proxyToFinal', 'subtitles'], 'profile')
  for (const kind of ['final', 'proxy']) {
    const encoding = exact(profile[kind], ['codec', 'encoder', 'pixelFormat', 'container', 'faststart', 'width', 'height',
      'fps', 'quality', 'audio'], `profile.${kind}`)
    if (!Number.isInteger(encoding.fps) || Number(encoding.fps) < 1 || Number(encoding.fps) > 120 ||
      !Number.isInteger(encoding.width) || Number(encoding.width) < 1 || !Number.isInteger(encoding.height) || Number(encoding.height) < 1)
      throw new DomainError('INVALID_ARGUMENT', 'Delivery canvas and FPS must be positive integers')
    exact(encoding.quality, ['mode', 'value', 'preset'], `profile.${kind}.quality`)
    exact(encoding.audio, ['codec', 'bitrateKbps', 'sampleRateHz', 'channels'], `profile.${kind}.audio`)
  }
  exact(profile.proxyToFinal, ['schemaVersion', 'scaleX', 'scaleY'], 'profile.proxyToFinal')
  const subtitles = exact(profile.subtitles, ['mode', 'configuration', 'fontAssets'], 'profile.subtitles')
  if (!Array.isArray(subtitles.fontAssets) || subtitles.fontAssets.length > 128)
    throw new DomainError('INVALID_ARGUMENT', 'Font assets must be an explicit bounded array')
  for (const font of subtitles.fontAssets) exact(font, ['artifactId', 'sha256'], 'font')
  sealed(subtitles.configuration, 'subtitle configuration'); sealed(body.preset, 'preset')
  // Typed refusal before any repository read: burned-in subtitles are not offered above BURN_IN_SUBTITLE_MAX_FPS.
  // The sealed OutputSpec revision enforces the same rule, so no other path can reach a render with this pair.
  if (subtitles.mode === 'burn-in') assertSubtitleDeliverySupportedAtFps('burn-in', output.fps as number)
  return { ...body, ...(body.reason === undefined ? {} : { reason: (body.reason as string).trim() }) } as unknown as CreateProjectOutputVariantInput
}

const policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
type AllocationKind = 'project' | 'project-version' | 'project-output-state' | 'project-snapshot' | 'edit-plan' |
  'project-creation-command' | 'idempotency-record' | 'edit-command' | 'output-variant' | 'output-spec-revision' | 'output-materialization'
type ClockAndIds = { clock: () => Date; createId: (kind: AllocationKind) => string; createEventId: () => string }
function authenticated(actor: AuthenticatedExternalActor, workspaceId: string) {
  requireScope(actor, 'projects:write')
  const audit = materializeActorAuditContext(actor)
  assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Output Command workspace differs from its authenticated actor')
  return audit
}
function key(value: string) {
  assertDomain(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value),
    'INVALID_ARGUMENT', 'Idempotency-Key must contain 3 to 128 portable characters')
  return value
}
function snapshot(workspaceId: string, projectId: string, id: string, kind: 'brief' | 'policies' | 'edit-plan',
  document: Record<string, unknown>, createdAt: string) {
  return createProjectSnapshot({ workspaceId, projectId, id, kind, contentSchemaVersion: Number(document.schemaVersion),
    contentJson: stableSerialize(document), contentHash: calculateVersionHash(document), createdAt })
}

/** What became of the briefing's reading at creation (for the caller and the tests; the sealed brief is the authority). */
export type BriefReadingAtCreation =
  | Readonly<{ status: 'none' }>
  | Readonly<{ status: 'read' }>
  | Readonly<{ status: 'replay' }>
  | Readonly<{ status: 'unread'; reason: typeof BRIEF_INTERPRETER_UNAVAILABLE_REASON | typeof BRIEF_INTERPRETATION_FAILED_REASON }>

/** Public creation has no implicit OutputSpec. The independent variant Command
 * is the only admission to the existing operational ingest path. */
export function createProjectService(dependencies: ClockAndIds & {
  repository: CreationOutputBundleRepositoryV2
  /**
   * ADR-160. The interpretation belongs to the TEXT of the briefing, not to a render, so a briefing is read when the project is created and the
   * reading is sealed in the brief the creation Command carries. Absent, or when the reading cannot be made (no interpreter configured, a refused
   * answer), the briefing is kept as written and unread: the Director stays blocked with its reason, never an empty reading.
   */
  interpretBrief?: InterpretBrief
}) {
  return async (request: { workspaceId: string; name: string; /** Optional (ADR-160): without one the Apollo presumes none. */ objective?: StrategicObjectiveId | null; locale?: string;
    briefing?: string; desiredAction?: Readonly<DesiredActionInput>; actor: AuthenticatedExternalActor; idempotencyKey: string }) => {
    assertDomain(Object.keys(request).every(k => ['workspaceId', 'name', 'objective', 'locale', 'briefing',
      'desiredAction', 'actor', 'idempotencyKey'].includes(k)), 'INVALID_ARGUMENT', 'Creation cannot specify an implicit output')
    const audit = authenticated(request.actor, request.workspaceId), idempotencyKey = key(request.idempotencyKey)
    const callerIntent = normalizeProjectCreationIntentV2({ schemaVersion: 'project-creation-intent/v2', kind: 'initialize-empty',
      name: request.name, objective: request.objective ?? null, locale: request.locale ?? null,
      briefing: request.briefing ?? null, desiredAction: request.desiredAction ?? {} })
    assertDomain(callerIntent.kind === 'initialize-empty', 'INVALID_COMMAND', 'Public creation requires empty root intent')
    // All allocations are fixed before repository retries, including the plan's
    // independent identity. Caller intent/fingerprint contains none of them.
    let reading: { interpretation: Readonly<BriefInterpretationV1>; audit: Readonly<BriefInterpretationAudit> } | null = null
    let briefReading: BriefReadingAtCreation = { status: 'none' }
    const briefingText = callerIntent.briefing === null ? null : normalizeBriefingText(callerIntent.briefing)
    if (briefingText !== null) {
      // A replay answers with the first creation and never spends a reading; the persist step still checks that the request is the same one.
      const replay = dependencies.repository.hasCompletedCreation
        ? await dependencies.repository.hasCompletedCreation({ workspaceId: request.workspaceId, clientId: audit.clientId, idempotencyKey })
        : false
      if (replay) briefReading = { status: 'replay' }
      else if (!dependencies.interpretBrief) briefReading = { status: 'unread', reason: BRIEF_INTERPRETER_UNAVAILABLE_REASON }
      else {
        try {
          const read = await dependencies.interpretBrief({ briefing: briefingText })
          // The reading is sealed only if it is of THIS text (hash and every citation checked again); any other reading is no reading.
          const interpretation = parseBriefInterpretation(JSON.parse(JSON.stringify(read.interpretation)), briefingText)
          // The audit is sealed with the reading, so it is checked against the same text and the same interpretation (a bad audit is no reading).
          const audit = parseBriefInterpretationAudit(JSON.parse(JSON.stringify(read.audit)), briefingText, interpretation) as unknown as Readonly<BriefInterpretationAudit>
          reading = { interpretation, audit }
          briefReading = { status: 'read' }
        } catch (error) {
          // The project is the owner's and must not be lost to the interpreter: ANY failure of the reading (no interpreter, a timeout, an abort, a
          // provider error, a reply the Apollo refused) leaves the briefing as written and unread. The Director then blocks with its reason; the
          // briefing is never read as empty and never read in silence.
          const unavailable = error instanceof DomainError && error.details?.reason === BRIEF_INTERPRETER_UNAVAILABLE_REASON
          briefReading = { status: 'unread', reason: unavailable ? BRIEF_INTERPRETER_UNAVAILABLE_REASON : BRIEF_INTERPRETATION_FAILED_REASON }
        }
      }
    }
    const createdAt = dependencies.clock().toISOString(), projectId = dependencies.createId('project'),
      versionId = dependencies.createId('project-version'), stateId = dependencies.createId('project-output-state'),
      commandId = dependencies.createId('project-creation-command')
    const snapshots = [
      snapshot(request.workspaceId, projectId, dependencies.createId('project-snapshot'), 'brief', {
        schemaVersion: 1, objective: callerIntent.objective, desiredAction: callerIntent.desiredAction,
        productionBrief: createProductionBrief({
          ...(callerIntent.briefing === null ? {} : { ownerText: callerIntent.briefing }),
          ...(reading ? { interpretedCoverage: coveredTopicsOf(reading.interpretation) } : {}),
        }),
        ...(reading ? { editorialRequest: { interpretation: reading.interpretation, interpretationAudit: reading.audit } } : {}),
        createdAt,
      }, createdAt),
      snapshot(request.workspaceId, projectId, dependencies.createId('project-snapshot'), 'edit-plan', {
        schemaVersion: 2, state: 'uncompiled', id: dependencies.createId('edit-plan'), projectVersionId: versionId,
        fps: 30, durationFrames: 0, sources: [], videoTracks: [], subtitleTracks: [], audioTracks: [],
        overlayTracks: [], effectTracks: [], createdAt,
      }, createdAt),
      snapshot(request.workspaceId, projectId, dependencies.createId('project-snapshot'), 'policies', {
        schemaVersion: 1, workspaceId: request.workspaceId, state: 'unconfigured', brandKitMode: 'inherit', guardrails: [], createdAt,
      }, createdAt),
    ]
    const proposal = createProjectCreationOutputCommandV2({ ...policy, id: commandId, workspaceId: request.workspaceId,
      projectId, versionId, audit, createdAt, payload: { ...policy, schemaVersion: 'project-creation-output-payload/v2',
        callerIntent, allocations: { stateId, snapshotRefs: Object.fromEntries(snapshots.map(s => [s.kind, s.id])),
          renderablePlanSnapshotId: null }, snapshots, forkDerivation: null, renderableCandidate: null } })
    const result = await dependencies.repository.persist({ proposal, idempotencyKey,
      idempotencyRecordId: dependencies.createId('idempotency-record'),
      eventIds: [dependencies.createEventId(), dependencies.createEventId()], recompose: facts => {
        if (facts !== null) throw new DomainError('PERSISTENCE_CONFLICT', 'Empty creation acquired unexpected source facts')
        return proposal
      } })
    const c = result.bundle.command, intent = c.payload.callerIntent
    assertDomain(intent.kind === 'initialize-empty', 'PERSISTENCE_CONFLICT', 'Creation replay intent differs')
    const projectAtCreation = createProject({ id: c.projectId, workspaceId: c.workspaceId, name: intent.name, status: 'draft',
      ...(intent.objective !== null ? { objective: intent.objective } : {}), ...(intent.locale !== null ? { locale: intent.locale } : {}), ownerId: c.author.id,
      createdBy: c.author, createdAt: c.createdAt })
    return Object.freeze({ projectAtCreation, creationVersion: result.bundle.version, bundle: result.bundle, replayed: result.replayed, briefReading })
  }
}

export type CreateProjectOutputVariantInput = Readonly<{ baseVersionId: string; baseHash: string;
  output: Omit<OutputSpecRevisionBody['output'], 'id' | 'schemaVersion'>;
  profile: OutputSpecRevisionBody['profile']; preset: OutputSpecRevisionBody['preset']; reason?: string }>

export function createProjectOutputVariantService(dependencies: ClockAndIds & { repository: OperationalOutputBundleRepositoryV3 }) {
  return async (request: CreateProjectOutputVariantInput & { workspaceId: string; projectId: string;
    actor: AuthenticatedExternalActor; idempotencyKey: string }) => {
    const audit = authenticated(request.actor, request.workspaceId), idempotencyKey = key(request.idempotencyKey)
    assertDomain(Object.keys(request).every(k => ['workspaceId', 'projectId', 'actor', 'idempotencyKey', 'baseVersionId',
      'baseHash', 'output', 'profile', 'preset', 'reason'].includes(k)), 'INVALID_ARGUMENT', 'Output Command contains unsupported fields')
    request = { ...request, ...parseCreateProjectOutputVariantBody(JSON.parse(serializeOutputCanonicalJson({
      baseVersionId: request.baseVersionId, baseHash: request.baseHash, output: request.output,
      profile: request.profile, preset: request.preset, ...(request.reason === undefined ? {} : { reason: request.reason }),
    }))) }
    const parent = await dependencies.repository.read({ workspaceId: request.workspaceId, projectId: request.projectId,
      versionId: request.baseVersionId })
    if (!parent) throw new DomainError('PROJECT_NOT_FOUND', 'Output Command base was not found')
    assertDomain(parent.version.baseHash === request.baseHash, 'VERSION_CONFLICT', 'Output Command base hash differs')
    const createdAt = dependencies.clock().toISOString(), versionId = dependencies.createId('project-version'),
      variantId = dependencies.createId('output-variant'), stateId = dependencies.createId('project-output-state')
    const revision = createOutputSpecRevisionBody({ ...policy, id: dependencies.createId('output-spec-revision'), variantId,
      workspaceId: request.workspaceId, projectId: request.projectId, revisionNumber: 1, createdAt,
      output: { ...request.output, schemaVersion: 1, id: variantId }, profile: request.profile, preset: request.preset })
    const plan = JSON.parse(operationalBundlePlanV3(parent).contentJson)
    const result = createOutputVariantCommand({ command: { id: dependencies.createId('edit-command'),
      workspaceId: request.workspaceId, projectId: request.projectId, baseVersionId: parent.version.id,
      baseHash: parent.version.baseHash, type: 'create-output-variant', author: { type: 'api-client', id: audit.clientId,
        ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}) }, idempotencyKey, createdAt,
      ...(request.reason === undefined ? {} : { reason: request.reason }) }, audit, base: parent.version,
      baseState: parent.state, historicalBaselineRequested: false, revision, expectedRevisionId: null,
      expectedSpecHash: null, durationFrames: plan.durationFrames })
    const normalizations = [...new Map(parent.state.document.schemaVersion === 'project-output-state/v3'
      ? parent.state.document.entries.flatMap(e => e.consumption.status === 'materialized'
        ? e.consumption.materialization.document.normalizations.map(n => [n.document.id, n] as const) : []) : []).values()]
    const variantIds = [...parent.state.document.entries.map(e => e.variantId), variantId]
    const proposal: BuildOperationalOutputVersionBundleV3 = { allocation: { workspaceId: request.workspaceId,
      projectId: request.projectId, resultVersionId: versionId, stateId, parentVersionId: parent.version.id,
      sequence: parent.version.sequence + 1, createdBy: audit.clientId, createdAt }, parent,
      origin: { kind: 'create-output-variant', result }, restoreTarget: null,
      editPlanSnapshot: snapshot(request.workspaceId, request.projectId, dependencies.createId('project-snapshot'), 'edit-plan',
        { ...plan, id: dependencies.createId('edit-plan'), projectVersionId: versionId, createdAt }, createdAt),
      normalizations, materializationIds: plan.durationFrames === 0 ? {} : Object.fromEntries(
        variantIds.map(id => [id, dependencies.createId('output-materialization')])) }
    buildOperationalOutputVersionBundleV3(proposal)
    return dependencies.repository.persistChild({ proposal, audit, versionEventId: dependencies.createEventId(),
      operationEventId: null, ingestFacts: null, recompose: facts => ({ ...proposal, parent: facts.parent,
        restoreTarget: facts.restoreTarget, normalizations: facts.normalizations }) })
  }
}
