import { assertDirectorSnapshotContent, bindDirectorSnapshotIdentities } from '../../src/v2/application/director-snapshot-identity.ts'
import { parseEditorialPolicyResolution, resolutionOwnsPolicyRef } from '../../src/v2/domain/editorial-policy-resolution.ts'
import { deriveEditorialRequestFromBrief } from '../../src/v2/domain/editorial-request.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createExternalAuditContext, materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { runProjectDirectorService } from '../../src/v2/application/run-project-director.ts'
import { readDirectorQualityReportService } from '../../src/v2/application/read-director-quality-report.ts'
import { enqueueProjectDirectorRunService } from '../../src/v2/application/enqueue-project-director-run.ts'
import { runNextProjectDirectorOperationService } from '../../src/v2/application/run-project-director-operation-worker.ts'
import { stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaDirectorRunRepository, parseDirectorQualityReport } from '../../src/v2/infrastructure/prisma/director-run-repository.ts'
import { assertDirectorRunEvidenceConsistency } from '../../src/v2/domain/director-perception-evidence.ts'
import { serverPerceptionSnapshotId } from '../../src/v2/domain/server-perception-snapshot.ts'
import { childCommandOf } from '../../src/v2/domain/project-output-state-transition.ts'
import { ingestedRecordings, ingestedWorld, recompiledChild, worldActor } from './helpers/output-world.mjs'
import { admitDirectorQualityForFinal, REQUIRED_HARD_CHECKS } from '../../src/v2/domain/final-caption-certification.ts'
import { defineEditorialPhraseRules } from '../../src/v2/application/editorial-phrase-rules.ts'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'
import { createPerceptionProducerEnvelope } from '../../src/v2/domain/perception-producer-envelope.ts'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'
import { readByInterpreter } from './helpers/editorial-request-fixture.mjs'
import { createEvidenceBoundBriefCompiler } from '../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts'
import { createDirectorRunImpact, createDirectorRunInvalidations, parseDirectorRunImpact } from '../../src/v2/domain/director-run-impact.ts'
import { validateDirectorDecisions } from '../../src/v2/domain/director-run.ts'
import { CONFIDENCE_BAND_POLICY_V2_SHA256 } from '../../src/v2/domain/decision-confidence.ts'
import {
  advancePublicOperationPhase,
  cancelPublicOperation,
  createQueuedPublicOperation,
  retryOrFailPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import {
  authenticatedActor,
  authenticationAudit as testAuthenticationAudit,
} from './helpers/authentication-audit.mjs'

// Every run starts from a real sealed Version3/State3 of the shared output world: an ingested 14 second source and
// the compiled editorial timeline below as the head's EditPlan.
const world = await ingestedWorld({
  actor: worldActor({ workspaceId: 'workspace-1', clientId: 'client-1', credentialId: 'credential-director-world', environment: 'production' }),
  sourceDurationSeconds: 14,
})
const head = recompiledChild(world.parent, world.actor, () => structuredClone(compiledEditorialPlan()),
  { suffix: 'director-base', versionId: 'project-version-4', snapshotId: 'snapshot-edit-4' })
const baseHash = head.version.baseHash
const variantIdsOf = (bundle) => bundle.state.document.entries.map((entry) => entry.variantId)

// The same project with TWO outputs (the published variant and a sibling) over the same compiled editorial timeline.
const twoOutputWorld = await ingestedWorld({
  actor: world.actor, sourceDurationSeconds: 14, sibling: true,
})
const twoOutputHead = recompiledChild(twoOutputWorld.parent, twoOutputWorld.actor, () => structuredClone(compiledEditorialPlan()),
  { suffix: 'director-base', versionId: 'project-version-4', snapshotId: 'snapshot-edit-4' })

// The same project when the selected B-roll insert was ingested before the master: the head State observes the master
// alone, and the insert's receipt is the one its own ingest persisted.
const insertWorld = await ingestedRecordings(['artifact-selected-insert-1', 'ingest3'], {
  actor: world.actor, durations: { 'artifact-selected-insert-1': 14, ingest3: 14 },
})
const insertHead = recompiledChild(insertWorld.parent, insertWorld.actor, () => structuredClone(compiledEditorialPlan()),
  { suffix: 'director-base', versionId: 'project-version-4', snapshotId: 'snapshot-edit-4' })

/** The prepared commit with the Command, audit, request fingerprint and Version its sealed bundle carries. */
function directorView(commit) {
  const sealed = childCommandOf(commit.bundle)
  return { ...commit, command: sealed.command, authenticationAudit: sealed.audit, requestFingerprint: sealed.requestFingerprint, version: commit.bundle.version }
}

test('Director quality read is workspace-scoped and returns the exact immutable snapshot binding', async () => {
  const expected = Object.freeze({
    directorRunId: 'director-run-read-1', projectId: 'project-read-1',
    objective: 'discovery', objectiveVersion: 1, rubricRef: 'awareness-discovery/v1',
    qualitySnapshot: Object.freeze({ id: 'quality-snapshot-read-1', contentSchemaVersion: 2, contentHash: 'b'.repeat(64) }),
    report: Object.freeze({ id: 'quality-report-read-1' }),
  })
  const calls = []
  const read = readDirectorQualityReportService({
    repository: {
      async readQualityReport(input) {
        calls.push(input)
        return input.workspaceId === 'workspace-read-1' ? expected : null
      },
    },
  })
  assert.equal(await read({
    workspaceId: 'workspace-read-1', projectId: 'project-read-1', directorRunId: 'director-run-read-1',
  }), expected)
  await assert.rejects(
    read({ workspaceId: 'workspace-read-2', projectId: 'project-read-1', directorRunId: 'director-run-read-1' }),
    (error) => error instanceof DomainError && error.code === 'PROJECT_NOT_FOUND',
  )
  assert.deepEqual(calls, [
    { workspaceId: 'workspace-read-1', projectId: 'project-read-1', directorRunId: 'director-run-read-1' },
    { workspaceId: 'workspace-read-2', projectId: 'project-read-1', directorRunId: 'director-run-read-1' },
  ])
})

function directorEnqueueActor(credentialId = 'credential-director-1') {
  const auditContext = createExternalAuditContext({
    clientId: 'client-1', credentialId, workspaceId: 'workspace-1', environment: 'production',
    delegatedUserId: 'user-director-enqueue-1', delegatedIdentityId: 'identity-director-enqueue-1',
    workspaceRole: 'director',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'ui-session',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function compiledEditorialPlan(selectedInsert = false, ctaText) {
  const words = [
    ['Seja', 0, 8], ['bem-vindo.', 8, 24],
    ['Comunicar', 34, 48], ['bem', 48, 56], ['muda', 56, 66], ['resultados.', 66, 88],
    ['Esta', 112, 120], ['imersão', 120, 136], ['desenvolve', 136, 154], ['clareza.', 154, 174],
    ['Você', 208, 220], ['vai', 220, 228], ['praticar', 228, 244], ['com', 244, 252], ['confiança.', 252, 276],
  ].map(([text, timelineStartFrame, timelineEndFrame], index) => ({
    text,
    sourceStartSeconds: index < 6 ? timelineStartFrame / 30 : (timelineStartFrame + 120) / 30,
    sourceEndSeconds: index < 6 ? timelineEndFrame / 30 : (timelineEndFrame + 120) / 30,
    timelineStartFrame,
    timelineEndFrame,
  }))
  if (ctaText) words.push({
    text: ctaText,
    sourceStartSeconds: 13.4,
    sourceEndSeconds: 13.8,
    timelineStartFrame: 280,
    timelineEndFrame: 294,
  })
  return Object.freeze({
    schemaVersion: 2,
    state: 'compiled',
    id: 'edit-plan-base-1',
    projectVersionId: 'project-version-4',
    storyPlanId: null,
    fps: 30,
    durationFrames: 300,
    sources: Object.freeze([{ id: 'source-1', artifactId: 'artifact-source3', kind: 'video', durationSeconds: 14 }]),
    videoTracks: Object.freeze([{ id: 'track-base', kind: 'base-video', clips: Object.freeze([
      Object.freeze({ id: 'clip-1', sourceArtifactId: 'artifact-source3', sourceInFrame: 0, sourceOutFrame: 100, timelineInFrame: 0, timelineOutFrame: 100, rate: 1 }),
      Object.freeze({
        id: 'clip-2',
        sourceArtifactId: selectedInsert ? 'artifact-selected-insert-1' : 'artifact-source3',
        sourceInFrame: selectedInsert ? 0 : 160,
        sourceOutFrame: selectedInsert ? 100 : 260,
        timelineInFrame: 100,
        timelineOutFrame: 200,
        rate: 1,
        ...(selectedInsert ? {
          audioSourceArtifactId: 'artifact-source3',
          audioSourceInFrame: 160,
          audioSourceOutFrame: 260,
        } : {}),
      }),
      Object.freeze({ id: 'clip-3', sourceArtifactId: 'artifact-source3', sourceInFrame: 320, sourceOutFrame: 420, timelineInFrame: 200, timelineOutFrame: 300, rate: 1 }),
    ]) }]),
    overlayTracks: Object.freeze([]), subtitleTracks: Object.freeze([]), audioTracks: Object.freeze([]), effectTracks: Object.freeze([]),
    markers: Object.freeze([
      Object.freeze({ kind: 'editorial-cut', atFrame: 100, sourceStartSeconds: 3.333, sourceEndSeconds: 5.333, ruleIds: Object.freeze(['date-january-31', 'date-february-1']) }),
      Object.freeze({ kind: 'editorial-cut', atFrame: 200, sourceStartSeconds: 8.666, sourceEndSeconds: 10.666, ruleIds: Object.freeze(['duration-two-days']) }),
    ]),
    protectedElements: Object.freeze([]), localeVariantRefs: Object.freeze([]), formatVariantRefs: Object.freeze([]),
    lineageRefs: Object.freeze(['artifact-source3']),
    editorial: Object.freeze({
      commandType: 'remove-spoken-content',
      exclusions: Object.freeze([
        Object.freeze({ sourceStartSeconds: 3.333, sourceEndSeconds: 5.333, ruleIds: Object.freeze(['date-january-31', 'date-february-1']), labels: Object.freeze(['31 de janeiro', '1 de fevereiro']), matchedText: '31 de janeiro e 1 de fevereiro' }),
        Object.freeze({ sourceStartSeconds: 8.666, sourceEndSeconds: 10.666, ruleIds: Object.freeze(['duration-two-days']), labels: Object.freeze(['dois dias']), matchedText: 'dois dias' }),
      ]),
      retainedSourceRanges: Object.freeze([
        Object.freeze({ sourceStartSeconds: 0, sourceEndSeconds: 3.333 }),
        Object.freeze({ sourceStartSeconds: 5.333, sourceEndSeconds: 8.666 }),
        Object.freeze({ sourceStartSeconds: 10.666, sourceEndSeconds: 14 }),
      ]),
    }),
    retimedTranscript: Object.freeze({ sourceTranscriptId: 'transcript-1', words: Object.freeze(words.map((word) => Object.freeze(word))) }),
    movementPolicy: Object.freeze({ automaticZoom: false, protectedOpeningFrames: 120 }),
    subtitlePolicy: Object.freeze({ faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 42 }),
    createdAt: '2026-07-18T20:00:00.000Z',
  })
}

class InMemoryDirectorRepository {
  constructor(options = {}) {
    this.snapshotRows = new Map()
    this.projectObjective = options.projectObjective ?? 'discovery'
    this.latestDirectorObjective = options.latestDirectorObjective
    this.selectedInsert = options.selectedInsert ?? false
    this.ocrEnvelope = options.ocrEnvelope
    this.ownerText = Object.hasOwn(options, 'ownerText')
      ? options.ownerText
      : 'Tom: direto, natural e sem efeitos gratuitos.'
    this.guardrails = options.guardrails ?? []
    // A briefing with text is a request the Director refuses until an interpreter has read it (ADR-160 F6): unless a test says otherwise, it was read and held nothing to map.
    this.editorialRequest = this.ownerText && !options.unread ? { ...readByInterpreter(this.ownerText), ...(options.editorialRequest ?? {}) } : options.editorialRequest
    this.ctaText = Object.hasOwn(options, 'ctaText')
      ? options.ctaText
      : ({
          'lead-generation': 'Cadastre', sale: 'Compre', whatsapp: 'WhatsApp',
          booking: 'Agende', download: 'Baixe',
        })[this.projectObjective]
    this.sourceRights = options.sourceRights ?? {
      state: 'present', snapshotId: 'rights-snapshot-master-1',
      snapshotHash: 'c'.repeat(64), status: 'approved', consentStatus: 'not-required',
    }
    this.parent = options.head ?? head
    this.outputReferences = options.outputReferences ?? [
      { artifactId: 'artifact-proxy-4', kind: 'proxy', sourceVersionId: 'project-version-4', variantId: variantIdsOf(this.parent)[0] },
      { artifactId: 'artifact-final-4', kind: 'final', sourceVersionId: 'project-version-4', variantId: variantIdsOf(this.parent)[0] },
    ]
    this.offered = options.offered ?? []
    this.transcript = options.transcript ?? {
      id: 'transcript-1', sourceArtifactId: 'artifact-source3', language: 'pt-BR',
      provider: 'groq', model: 'whisper-large-v3', transcriptHash: 'b'.repeat(64),
    }
    // W64. The rights of the insert's source, as the real reader states them for every source the plan plays (the master's are `sourceRights`).
    this.insertRights = options.insertRights ?? {
      state: 'present', snapshotId: 'rights-snapshot-insert-1',
      snapshotHash: 'd'.repeat(64), status: 'approved', consentStatus: 'not-required',
    }
    this.baseEditPlan = options.editPlan
    // The language the project declares; null: it declares none (ADR-160).
    this.projectLocale = options.projectLocale === undefined ? 'pt-BR' : options.projectLocale
    // The speech the project asked to remove (the rules of its remove-spoken-content Commands); none unless a test sends a request.
    this.requestedSpeechRemovals = options.requestedSpeechRemovals ?? []
    this.requested = []
    this.records = new Map()
  }

  /** The persisted receipts of the recordings the plan consumes and the head State does not observe. */
  async readAdoptableObservations({ sourceArtifactIds }) {
    this.requested.push([...sourceArtifactIds])
    return this.offered.filter((offer) => sourceArtifactIds.includes(offer.normalization.document.source.artifactId))
  }

  get currentVersion() { return this.parent.version }

  currentPlan() { return this.baseEditPlan ?? compiledEditorialPlan(this.selectedInsert, this.ctaText) }

  async findIdempotentResult({ workspaceId, projectId, idempotencyKey, actorContextHash }) {
    const record = this.records.get(`${workspaceId}:${projectId}:${idempotencyKey}`) ?? null
    if (record && record.authenticationAudit.contextHash !== actorContextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'actor mismatch')
    }
    return record
  }

  async readContext({ workspaceId, projectId }) {
    if (workspaceId !== 'workspace-1' || projectId !== 'project-1') return null
    return {
      workspaceId,
      project: { id: projectId, objective: this.projectObjective, ...(this.projectLocale ? { locale: this.projectLocale } : {}) },
      ...(this.latestDirectorObjective
        ? { latestDirectorObjective: this.latestDirectorObjective }
        : {}),
      parent: this.parent,
      currentVersion: this.parent.version,
      brief: {
        objective: this.projectObjective,
        desiredAction: createDesiredAction({
          objective: this.projectObjective,
          ...(['lead-generation', 'sale', 'whatsapp', 'booking', 'download'].includes(this.projectObjective)
            ? { desiredAction: { destination: {
                type: {
                  'lead-generation': 'url', sale: 'url', whatsapp: 'whatsapp',
                  booking: 'calendar', download: 'file',
                }[this.projectObjective],
                value: this.projectObjective === 'whatsapp'
                  ? '+5511999999999'
                  : 'https://destination.example/action',
              } } }
            : {}),
        }),
        productionBrief: createProductionBrief({ ownerText: this.ownerText }),
        ...(this.editorialRequest ? { editorialRequest: this.editorialRequest } : {}),
      },
      policies: { automaticZoom: false, faceProtection: true, guardrails: this.guardrails },
      editPlan: this.currentPlan(),
      currentDurationFrames: 300,
      variantIds: variantIdsOf(this.parent),
      sourceRights: this.sourceRights,
      timelineSourceRights: [...new Set(this.currentPlan().videoTracks.flatMap((track) => track.clips.flatMap((clip) =>
        [clip.sourceArtifactId, ...(clip.audioSourceArtifactId ? [clip.audioSourceArtifactId] : [])])))].sort()
        .map((artifactId) => ({ artifactId, rights: artifactId === this.transcript.sourceArtifactId ? this.sourceRights : this.insertRights })),
      outputReferences: this.outputReferences,
      transcript: this.transcript,
      requestedSpeechRemovals: this.requestedSpeechRemovals,
      ...(this.sourceDimensions ? { sourceDimensions: this.sourceDimensions } : {}),
      ...(this.ocrEnvelope ? { ocrEnvelope: this.ocrEnvelope } : {}),
    }
  }

  async commitWithCanonicalSnapshots(scope, prepare) {
    // Controlled in-memory transaction: explicit canonical store, no PG claim.
    const rows = new Map(this.snapshotRows)
    const resolve = async (candidates) => {
      this.resolvedCandidates = [...(this.resolvedCandidates ?? []), ...candidates]
      return candidates.map((candidate) => {
        assert.equal(candidate.workspaceId, scope.workspaceId)
        assert.equal(candidate.projectId, scope.projectId)
        const key = JSON.stringify([candidate.projectId, candidate.kind, candidate.contentHash])
        const stored = rows.get(key)
        if (stored) {
          assertDirectorSnapshotContent(candidate, stored)
          return stored
        }
        rows.set(key, candidate)
        return candidate
      })
    }
    const bundle = directorView(await prepare(resolve))
    assert.equal(bundle.command.baseVersionId, scope.baseVersionId)
    assert.equal(bundle.command.baseHash, scope.baseHash)
    assert.equal(bundle.requestFingerprint, scope.requestFingerprint)
    const result = await this.commitPreparedBundle(bundle)
    this.snapshotRows = rows
    return result
  }

  async commitPreparedBundle(bundle) {
    this.lastBundle = bundle
    const impact = parseDirectorRunImpact(bundle.command.payload.impact)
    const invalidations = createDirectorRunInvalidations({ impact, createdAt: bundle.command.createdAt })
    const result = Object.freeze({ run: bundle.run, command: bundle.command, version: bundle.version, impact, invalidations, replayed: false })
    this.records.set(`${bundle.command.workspaceId}:${bundle.command.projectId}:${bundle.command.idempotencyKey}`, {
      requestFingerprint: bundle.requestFingerprint,
      authenticationAudit: bundle.authenticationAudit,
      result,
    })
    this.parent = bundle.bundle
    this.outputReferences = this.outputReferences.map((reference) => ({
      ...reference,
      sourceVersionId: bundle.version.id,
    }))
    this.projectObjective = bundle.run.objective
    this.latestDirectorObjective = {
      runId: bundle.run.id,
      objective: bundle.run.objective,
      objectiveVersion: bundle.run.objectiveVersion,
      rubricRef: bundle.run.rubricRef,
      ...(bundle.run.supersedesRunId
        ? { supersedesRunId: bundle.run.supersedesRunId }
        : {}),
      approved: ['approved', 'approved-with-warnings'].includes(
        bundle.run.qualityReport.status,
      ),
    }
    return result
  }
}

/** The verdict of one hard check of a v5 report by id (undefined: the report has no such check). */
const hardCheck = (report, id) => report.hardChecks.find((check) => check.id === id)?.passed
/** What final-export admission binds a run's report to when the brief still states the request the run sealed. */
const bindingOf = (run) => ({ currentRequestHash: run.requestHash, sealedRequestHash: run.requestHash, sealedPolicyResolutionHash: run.policyResolution.policyResolutionHash })

function fixture(options = {}) {
  const repository = new InMemoryDirectorRepository(options)
  const counters = new Map()
  let event = 0
  const service = runProjectDirectorService({
    repository,
    clock: () => new Date('2026-07-18T22:00:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      // The sealed output world below numbers its own snapshots `project-snapshot-N`: the Director's own ids live in another namespace, so a
      // run never meets a world snapshot by counting.
      return kind === 'project-snapshot' ? `${kind}-run-${next}` : `${kind}-${next}`
    },
    createEventId: () => `00000000-0000-4000-8000-${String(++event).padStart(12, '0')}`,
    compileBrief: createEvidenceBoundBriefCompiler(),
    ...(options.faceWindows ? { faceWindows: options.faceWindows } : {}),
    ...(options.materializeSnapshot ? { materializeSnapshot: options.materializeSnapshot } : {}),
    ...(options.warn ? { warn: options.warn } : {}),
  })
  return { repository, service }
}

function request(overrides = {}) {
  return {
    workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'project-version-4', baseHash,
    actor: authenticatedActor({
      clientId: 'client-1',
      credentialId: 'credential-director-direct-1',
      workspaceId: 'workspace-1',
    }),
    idempotency: { key: 'director-first-pass' },
    reason: 'Planejar e criticar a composição completa.',
    ...overrides,
  }
}

function controlledOcrEnvelope({ empty = false, regions = 1 } = {}) {
  return createPerceptionProducerEnvelope({
    id: 'ocr-envelope-controlled-1', workspaceId: 'workspace-1', projectId: 'project-1',
    projectVersionId: 'project-version-4', operationId: 'ocr-operation-controlled-1',
    operationAttempt: 1, operationFenceHash: '1'.repeat(64),
    sourceArtifactId: 'artifact-source3', sourceSha256: '2'.repeat(64),
    editPlanSnapshotId: 'snapshot-edit-4', editPlanSnapshotHash: '3'.repeat(64),
    timelineDurationFrames: 300,
    timeMap: compiledEditorialPlan().videoTracks[0].clips.map((clip) => ({
      clipId: clip.id, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
      timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate,
    })),
    sourceTimebase: { num: 1, den: 1000 }, sourceFps: { num: 30, den: 1 },
    timelineFps: { num: 30, den: 1 }, sourcePtsStart: 0,
    sourcePtsRounding: 'nearest', sourceClock: 'constant-frame-rate', modality: 'ocr',
    producer: { name: 'tesseract', ffmpegSha256: '4'.repeat(64), ffprobeSha256: '5'.repeat(64),
      executableSha256: '6'.repeat(64), executableVersion: 'controlled-unit-fixture',
      traineddata: [{ language: 'por', sha256: '7'.repeat(64), licenseSha256: '8'.repeat(64) }] },
    samplePolicy: { strategy: 'fixed-interval', intervalFrames: 1, maxSamples: 2 },
    samples: [
      { sourcePts: 0, sourcePtsEvidenceHash: '9'.repeat(64), sourceFrame: 0, timelineFrame: 0,
        imageSha256: 'a'.repeat(64), ocr: empty ? [] : Array.from({ length: regions }, (_, index) =>
          ({ text: `Texto observado ${index}`, language: 'por',
            box: [0.1, 0.75, 0.3, 0.1], confidence: 0.76 })) },
      { sourcePts: 5333, sourcePtsEvidenceHash: 'b'.repeat(64), sourceFrame: 160,
        timelineFrame: 100, imageSha256: 'c'.repeat(64), ocr: [] },
    ],
    gaps: [
      { startTimelineFrame: 1, endTimelineFrame: 100, reasonCode: 'NOT_SAMPLED' },
      { startTimelineFrame: 101, endTimelineFrame: 300, reasonCode: 'NOT_SAMPLED' },
    ],
    createdAt: '2026-07-18T21:00:00.000Z',
  })
}

test('Director binds controlled OCR samples to snapshot v2 while face safety remains unknown', async () => {
  for (const empty of [false, true]) {
    const envelope = controlledOcrEnvelope({ empty })
    const { repository, service } = fixture({ ocrEnvelope: envelope })
    const result = await service(request())
    const snapshot = repository.lastBundle.snapshots.find((item) => item.kind === 'perception')
    assert.equal(snapshot.contentSchemaVersion, 2)
    assert.equal(result.run.plannerVersion, 'apollo-director-policy/v4')
    assert.equal(result.run.perception.schemaVersion, 2)
    assert.equal(result.run.perception.inputVersionId, 'project-version-4')
    assert.equal(result.run.perception.ocrEvidence.envelopeId, envelope.id)
    assert.deepEqual(result.run.perception.ocrEvidence.sampledTimelineFrames, [0, 100])
    assert.deepEqual(result.run.perception.ocrEvidence.emptyTextTimelineFrames,
      empty ? [0, 100] : [100])
    assert.equal(result.run.perception.timeline.observations.filter((item) => item.kind === 'ocr').length,
      empty ? 0 : 1)
    assert.ok(result.run.perception.timeline.coverage.find((item) => item.kind === 'ocr').observedMs > 0)
    assert.ok(result.run.decisions.some((decision) => decision.evidenceRefs.includes(envelope.id)))
    assert.equal(result.run.perception.summary.confidence, 0.82)
    assert.equal(result.run.qualityReport.status, 'review-required')
    assert.equal(result.run.qualityReport.faceSafety.status, 'unknown')
    assert.equal(hardCheck(result.run.qualityReport, 'subtitlesFaceSafe'), undefined, 'a v5 report keeps no face flag among its checks: the claim is faceSafety alone')
    assert.equal(result.run.qualityReport.issues.some((issue) =>
      issue.code === 'OCR_SOURCE_LOWER_REGION_REVIEW_REQUIRED'), !empty)
  }
})

test('Director rejects OCR bound to a different version or source map before planning', async () => {
  const envelope = controlledOcrEnvelope()
  for (const tampered of [
    { ...envelope, projectVersionId: 'project-version-other' },
    { ...envelope, timeMap: [{ ...envelope.timeMap[0], sourceInFrame: 1 }, ...envelope.timeMap.slice(1)] },
  ]) {
    const { service } = fixture({ ocrEnvelope: tampered })
    await assert.rejects(service(request()), (error) =>
      error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
  }
})

test('Director canonicalizes twelve OCR regions from one sampled frame without changing source authority', async () => {
  const envelope = controlledOcrEnvelope({ regions: 12 })
  const { service } = fixture({ ocrEnvelope: envelope })
  const result = await service(request())
  const ocr = result.run.perception.timeline.observations.filter((item) => item.kind === 'ocr')
  assert.equal(ocr.length, 12)
  assert.equal(ocr[2].id.includes('-10-'), true)
  assert.equal(ocr.every((item) => item.provenance.source === envelope.id &&
    item.provenance.version === envelope.envelopeHash), true)
  assert.equal(result.run.qualityReport.faceSafety.status, 'unknown')
})

test('Director V2 persists perception, treatment, story, edit plan and critic as one immutable version', async () => {
  const { repository, service } = fixture()
  const result = await service(request())
  const plan = result.run.editPlan
  assert.match(plan.audioTimelineHash, /^[a-f0-9]{64}$/)

  assert.equal(result.replayed, false)
  assert.equal(result.command.type, 'run-director')
  assert.equal(result.command.payload.schemaVersion, 3)
  assert.equal(result.version.sequence, 5)
  assert.equal(result.version.parentVersionId, 'project-version-4')
  assert.equal(result.run.status, 'planned')
  assert.equal(result.run.schemaVersion, 2)
  assert.equal(result.run.objective, 'discovery')
  assert.equal(result.run.objectiveVersion, 1)
  assert.equal(result.run.rubricRef, 'awareness-discovery/v1')
  assert.equal(result.command.payload.previousObjective, 'discovery')
  assert.equal(result.command.payload.snapshotRefs.brief, 'project-snapshot-run-1')
  assert.deepEqual(repository.lastBundle.snapshots.map((snapshot) => snapshot.kind), ['brief', 'perception', 'treatment', 'story', 'edit-plan', 'quality-report', 'policy-resolution'])
  const briefSnapshot = repository.lastBundle.snapshots.find((snapshot) => snapshot.kind === 'brief')
  const persistedBrief = JSON.parse(briefSnapshot.contentJson)
  assert.equal(briefSnapshot.contentSchemaVersion, 3)
  assert.equal(persistedBrief.briefCompilation.audit.promptVersion, 'brief-compiler/v1')
  assert.equal(persistedBrief.briefCompilation.audit.modelVersion, '1.0.0')
  assert.deepEqual(persistedBrief.briefCompilation.compiled.fields.tone, ['direto, natural e sem efeitos gratuitos'])
  assert.ok(result.run.decisions.some((decision) =>
    decision.evidenceRefs.includes(persistedBrief.briefCompilation.audit.outputHash)))
  assert.equal(repository.lastBundle.decisionLog.runId, result.run.id)
  assert.equal(repository.lastBundle.decisionLog.commandId, result.command.id)
  assert.equal(repository.lastBundle.decisionLog.resultVersionId, result.version.id)
  assert.deepEqual(repository.lastBundle.decisionLog.entries.map((decision) => decision.id), result.run.decisions.map((decision) => decision.id))
  assert.equal(repository.lastBundle.decisionLog.entries.every((decision) => decision.actor.id === 'client-1' && decision.resultTarget.artifactRole === 'final-output'), true)
  assert.match(repository.lastBundle.decisionLog.logHash, /^[a-f0-9]{64}$/)
  assert.equal(result.run.perception.timeline.observations.length, compiledEditorialPlan().retimedTranscript.words.length)
  assert.equal(result.run.treatmentPlan.patternBreaks.allowed.includes('zoom'), false)
  assert.equal(result.run.storyPlan.blocks.length, 3)
  assert.equal(plan.videoTracks[0].clips.length, 3)
  assert.equal(plan.movementPolicy.automaticZoom, false)
  // No movement is applied and the request names no window: there is no opening to protect (ADR-160 F4).
  assert.equal(plan.movementPolicy.protectedOpeningFrames, 0)
  assert.equal(plan.effectTracks.length, 0)
  assert.equal(plan.transitions.length, 2)
  assert.equal(plan.transitions.every((transition) => transition.type === 'straight-cut' && transition.audioFadeMs === 24), true)
  const cues = plan.subtitleTracks.flatMap((track) => track.cues)
  assert.ok(cues.length > 0)
  assert.equal(cues.every((cue) => cue.anchor === 'bottom' && cue.text.length <= result.run.policyResolution.policies.captions.value.capacityCharacters), true)
  assert.equal(cues.every((cue, index) => index === 0 || cue.startFrame >= cues[index - 1].endFrame), true)
  const captionText = cues.map((cue) => cue.text).join(' ').toLowerCase()
  assert.equal(captionText.includes('31 de janeiro'), false)
  assert.equal(captionText.includes('1 de fevereiro'), false)
  assert.equal(captionText.includes('dois dias'), false)
  assert.equal(result.run.decisions.some((decision) => decision.choice === 'no_effect'), true)
  assert.equal(result.run.decisions.some((decision) => decision.choice === 'no_insert'), true)
  const layoutConfidence = result.run.decisions.find((decision) => decision.id === 'decision-layout-inset')
  // W64: the layout decision IS the crop decision of confidence-band-policy/v2 (it was typed `generation` under v1), graded on (tier, confidence).
  assert.equal(layoutConfidence.decisionType, 'crop')
  assert.equal(layoutConfidence.confidenceBand, 'review')
  assert.deepEqual(layoutConfidence.bandPolicy, { schemaVersion: 'confidence-band-policy/v2', policyHash: CONFIDENCE_BAND_POLICY_V2_SHA256 })
  assert.equal(layoutConfidence.perceptionEvidence.tier, 'absent', 'no face evidence exists in this controlled context')
  assert.equal(layoutConfidence.confidenceDetail.value, layoutConfidence.confidence)
  assert.equal(layoutConfidence.confidenceDetail.calibrationVersion, 'director-confidence-2026-08-v1')
  assert.match(layoutConfidence.confidenceDetail.confidenceHash, /^[a-f0-9]{64}$/)
  assert.throws(
    () => validateDirectorDecisions(result.run.decisions.map((decision) =>
      decision.id === layoutConfidence.id
        ? { ...decision, confidenceDetail: { ...decision.confidenceDetail, reasonCodes: ['TAMPERED'] } }
        : decision)),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(result.run.qualityReport.status, 'review-required')
  assert.deepEqual(result.run.qualityReport.faceSafety, { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] })
  assert.equal(hardCheck(result.run.qualityReport, 'subtitlesFaceSafe'), undefined)
  assert.ok(result.run.qualityReport.issues.some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED'))
  assert.equal(result.run.qualityReport.schemaVersion, 'director-quality-report/v5')
  assert.equal(result.run.qualityReport.strategic.rubric.id, 'awareness-discovery')
  assert.equal(result.run.qualityReport.strategic.rubric.threshold, 68)
  assert.equal(result.run.qualityReport.strategic.rubric.purpose, 'editorial-quality-proxy')
  assert.equal(result.run.qualityReport.strategic.passed, true)
  assert.deepEqual(result.run.qualityReport.strategic.gateFailures, [])
  // The hook criterion measures a role the request did not ask for: it is not scored, and the weights of the other five sum to one (ADR-160 F5).
  assert.equal(result.run.qualityReport.strategic.evidence.length, 5)
  assert.equal(result.run.qualityReport.strategic.evidence.some((item) => item.criterionId === 'hook-clarity'), false)
  assert.ok(Math.abs(result.run.qualityReport.strategic.evidence.reduce((sum, item) => sum + item.weight, 0) - 1) < 1e-9)
  assert.deepEqual(result.run.policyResolution.policies.rubric.value.notRequested, ['hook-clarity', 'cta-clarity', 'friction-reduction'])
  assert.equal(result.run.storyPlan.blocks.every((block) => block.role === 'segment'), true, 'no role by position')
  assert.equal(result.run.qualityReport.score, result.run.qualityReport.strategic.score / 100)
  assert.equal(result.run.qualityReport.hardChecks.every((check) => check.passed), true)
  assert.equal(repository.lastBundle.snapshots.find((snapshot) => snapshot.kind === 'quality-report').contentSchemaVersion, 5)
  assert.equal(repository.lastBundle.event.type, 'project.version.created')
  assert.deepEqual(result.impact.changeKinds, ['director-replan'])
  assert.deepEqual(result.impact.dependencyTypes, ['audio', 'content', 'policy', 'timing', 'visual'])
  assert.deepEqual(result.impact.affectedRanges, [{ startFrame: 0, endFrame: 300 }])
  assert.deepEqual(result.impact.minimalRenders, [{ kind: 'proxy', variantId: variantIdsOf(head)[0], ranges: [{ startFrame: 0, endFrame: 300 }] }])
  assert.deepEqual(result.impact.affectedVariantIds, [variantIdsOf(head)[0]])
  assert.deepEqual(result.impact.affectedArtifacts.map((item) => item.artifactId), ['artifact-final-4', 'artifact-proxy-4'])
  assert.equal(result.invalidations.length, 2)
  assert.equal(result.invalidations.every((item) => item.status === 'stale' && item.impactHash === result.impact.impactHash), true)
  assert.equal(repository.lastBundle.event.data.commandImpactHash, result.impact.impactHash)
  assert.equal(repository.lastBundle.event.data.artifactInvalidationCount, 2)
  assert.deepEqual(
    parseDirectorRunImpact(JSON.parse(stableSerialize(result.impact))),
    result.impact,
  )
  assert.throws(
    () => parseDirectorRunImpact({ ...result.impact, impactHash: 'f'.repeat(64) }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('Director re-evaluates confirmed caption corrections without reusing the old quality snapshot', async () => {
  const { repository, service } = fixture()
  const original = await service(request())
  const reviewed = structuredClone(original.run.editPlan)
  reviewed.reviewPatch = { patchId: 'reviewed-patch-1', annotationIds: ['annotation-caption-1'] }
  reviewed.subtitleTracks[0].cues[0].text = 'Seja bem-vindo!'
  const readContext = repository.readContext.bind(repository)
  repository.readContext = async (input) => ({ ...await readContext(input), editPlan: reviewed })
  const replanned = await service(request({ baseVersionId: original.version.id, baseHash: original.version.baseHash, idempotency: { key: 'reviewed-captions' } }))
  assert.equal(replanned.run.editPlan.subtitleTracks[0].cues[0].text, 'Seja bem-vindo!')
  assert.notEqual(replanned.run.id, original.run.id)
  assert.equal(replanned.version.parentVersionId, original.version.id)
  assert.notEqual(replanned.run.qualityReport.id, original.run.qualityReport.id)
  assert.equal(hardCheck(replanned.run.qualityReport, 'forbiddenSpeechAbsent'), true)
  assert.equal(replanned.run.editPlan.reviewPatch.patchId, 'reviewed-patch-1')
})

test('Director rejects unsafe or stale reviewed captions before persistence', async () => {
  // The project asked, through its remove-spoken-content request, to take this phrase out; a reviewed caption that says it again is refused.
  const requestedSpeechRemovals = defineEditorialPhraseRules([{ id: 'phrase-rule-requested-1', label: 'frase pedida', alternatives: ['promoção relâmpago'] }])
  for (const mutation of [
    (cue) => { cue.text = 'Promoção relâmpago!' },
    (cue) => { cue.anchor = 'center' },
    (cue) => { cue.startFrame += 1 },
  ]) {
    const { repository, service } = fixture({ requestedSpeechRemovals })
    const original = await service(request())
    const reviewed = structuredClone(original.run.editPlan)
    reviewed.reviewPatch = { patchId: 'reviewed-patch-1', annotationIds: ['annotation-caption-1'] }
    mutation(reviewed.subtitleTracks[0].cues[0])
    const readContext = repository.readContext.bind(repository)
    repository.readContext = async (input) => ({ ...await readContext(input), editPlan: reviewed })
    await assert.rejects(service(request({ baseVersionId: original.version.id, baseHash: original.version.baseHash, idempotency: { key: 'unsafe-caption' } })), (error) => error.code === 'INVALID_RENDER_INPUT')
    assert.equal(repository.lastBundle.run.id, original.run.id)
  }
})

// The Director works from what each video's own request asks, never from a context fixed in the product: what it forbids in the
// captions is the speech THIS project asked to remove (the rules of its remove-spoken-content Commands), and nothing else.
function planSaying(words) {
  const plan = structuredClone(compiledEditorialPlan())
  words.forEach((text, index) => { plan.retimedTranscript.words[index].text = text })
  return plan
}

test('a video that says "dois dias" and "31 de janeiro" is not blocked when nothing asked to remove them', async () => {
  const editPlan = planSaying(['Seja', 'bem-vindo.', '31', 'de', 'janeiro,', 'em', 'dois', 'dias.'])
  const { repository, service } = fixture({ editPlan })
  const result = await service(request({ idempotency: { key: 'speech-without-request' } }))
  const captions = result.run.editPlan.subtitleTracks.flatMap((track) => track.cues).map((cue) => cue.text).join(' ')
  assert.match(captions, /31 de janeiro/)
  assert.match(captions, /dois dias/)
  assert.equal(hardCheck(result.run.qualityReport, 'forbiddenSpeechAbsent'), true)
  assert.notEqual(result.run.qualityReport.status, 'blocked')
  assert.equal(admitDirectorQualityForFinal(result.run.qualityReport, bindingOf(result.run)).admitted, true)
  assert.equal(result.run.qualityReport.criticVersion, 'apollo-director-critic/v5')
  assert.ok(repository.lastBundle)
})

test('a request to remove a phrase that the captions still say blocks the Director on forbiddenSpeechAbsent', async () => {
  const editPlan = planSaying(['Seja', 'bem-vindo.', 'Hoje', 'tem', 'promoção', 'relâmpago.'])
  const requestedSpeechRemovals = defineEditorialPhraseRules([
    { id: 'phrase-rule-requested-1', label: 'frase pedida', alternatives: ['promoção relâmpago', 'oferta relampago'] },
  ])
  const asked = fixture({ editPlan, requestedSpeechRemovals })
  await assert.rejects(
    asked.service(request({ idempotency: { key: 'speech-still-present' } })),
    (error) => error instanceof DomainError && error.code === 'INVALID_RENDER_INPUT' &&
      error.details.gateFailures.includes('narrative-integrity') &&
      JSON.stringify(error.details.requestedSpeechStillPresent) === JSON.stringify(['phrase-rule-requested-1']),
  )
  assert.equal(asked.repository.lastBundle, undefined)
  // The same words with no request, and the request over words that do not say it, both pass: the rule is the request, not the words.
  const unasked = fixture({ editPlan })
  assert.equal((await unasked.service(request({ idempotency: { key: 'speech-no-request' } }))).run.qualityReport.hardChecks.find((check) => check.id === 'forbiddenSpeechAbsent').passed, true)
  const removed = fixture({ requestedSpeechRemovals })
  assert.equal((await removed.service(request({ idempotency: { key: 'speech-request-honoured' } }))).run.qualityReport.hardChecks.find((check) => check.id === 'forbiddenSpeechAbsent').passed, true)
})

test('Director blocks material brief conflicts before creating or persisting plans', async () => {
  const { repository, service } = fixture({
    ownerText: 'Tom: formal. Tom: totalmente informal.',
  })
  await assert.rejects(
    () => service(request({ idempotency: { key: 'director-conflicting-brief' } })),
    (error) => error instanceof DomainError &&
      error.code === 'PRECONDITION_REQUIRED' &&
      error.details.conflicts.some((item) => item.code === 'contradiction'),
  )
  assert.equal(repository.lastBundle, undefined)
})

test('Director binds every strategic objective to its canonical rubric in runtime plans', async () => {
  const cases = [
    ['discovery', 'awareness-discovery/v1'],
    ['awareness', 'awareness-level/v1'],
    ['warming', 'awareness-warming/v1'],
    ['lead-generation', 'conversion-lead/v1'],
    ['sale', 'conversion-sale/v1'],
    ['whatsapp', 'conversion-whatsapp/v1'],
    ['booking', 'conversion-booking/v1'],
    ['download', 'conversion-download/v1'],
  ]
  for (const [objective, rubricRef] of cases) {
    const { service } = fixture({ projectObjective: objective })
    const result = await service(request({
      objective,
      idempotency: { key: `director-objective-${objective}` },
    }))
    assert.equal(result.run.objective, objective)
    assert.equal(result.run.rubricRef, rubricRef)
    assert.equal(result.run.objectiveVersion, 1)
    assert.equal(result.run.treatmentPlan.objective, objective)
    assert.equal(result.run.storyPlan.objective, objective)
  }
})

test('an explicitly approved predecessor can be superseded by a new objective', async () => {
  const { repository, service } = fixture({ ctaText: 'Compre' })
  // Unit fixture models an already approved predecessor; this does not claim detector evidence.
  repository.latestDirectorObjective = { runId: 'director-run-approved-0', objective: 'discovery', objectiveVersion: 1, rubricRef: 'awareness-discovery/v1', approved: true }
  const changed = await service(request({
    objective: 'sale',
    desiredAction: {
      destination: { type: 'url', value: 'https://checkout.example/oferta' },
      verbalCta: 'Compre',
      visualCta: 'Comprar agora',
      disclosures: ['Condições no site'],
    },
    reason: 'A campanha aprovada agora precisa levar a uma oferta explícita.',
    idempotency: { key: 'director-objective-change-sale' },
  }))
  assert.equal(changed.run.objective, 'sale')
  assert.equal(changed.run.objectiveVersion, 2)
  assert.equal(changed.run.rubricRef, 'conversion-sale/v1')
  assert.equal(changed.run.supersedesRunId, 'director-run-approved-0')
  assert.equal(changed.command.payload.previousObjective, 'discovery')
  assert.equal(changed.command.payload.supersedesRunId, 'director-run-approved-0')
  assert.notEqual(changed.command.payload.snapshotRefs.brief, 'snapshot-brief-1')
  assert.equal(changed.version.parentVersionId, 'project-version-4')
  assert.equal(repository.projectObjective, 'sale')
  const brief = JSON.parse(repository.lastBundle.snapshots.find((snapshot) => snapshot.kind === 'brief').contentJson)
  assert.equal(brief.objective, 'sale')
  assert.equal(brief.desiredAction.kind, 'buy')
  assert.equal(brief.desiredAction.visualCta, 'Comprar agora')
  assert.equal(brief.objectiveChange.supersedesRunId, 'director-run-approved-0')
  const actionRef = changed.run.storyPlan.desiredActionRef
  assert.equal(actionRef.id, changed.run.editPlan.desiredActionRef.id)
  assert.equal(actionRef.id, changed.run.editPlan.subtitleTracks[0].desiredActionRef.id)
  assert.equal(actionRef.id, changed.run.editPlan.overlayTracks[0].desiredActionRef.id)
  assert.equal(actionRef.id, changed.run.qualityReport.desiredActionRef.id)
  assert.equal(changed.run.editPlan.overlayTracks[0].text, 'Comprar agora')
})

test('an explicitly approved predecessor can be superseded by a new Desired Action', async () => {
  const { repository, service } = fixture({ projectObjective: 'sale', ctaText: 'Compre' })
  repository.latestDirectorObjective = { runId: 'director-run-approved-0', objective: 'sale', objectiveVersion: 1, rubricRef: 'conversion-sale/v1', approved: true }
  const changed = await service(request({
    objective: 'sale',
    desiredAction: {
      destination: { type: 'url', value: 'https://checkout.example/nova-oferta' },
      verbalCta: 'Compre',
      visualCta: 'Ver nova oferta',
    },
    reason: 'A oferta aprovada mudou de destino e texto visual.',
    idempotency: { key: 'director-desired-action-change-sale' },
  }))
  assert.equal(changed.run.objective, 'sale')
  assert.equal(changed.run.objectiveVersion, 2)
  assert.equal(changed.run.supersedesRunId, 'director-run-approved-0')
  assert.notEqual(changed.command.payload.snapshotRefs.brief, 'snapshot-brief-1')
  const brief = JSON.parse(repository.lastBundle.snapshots.find((snapshot) => snapshot.kind === 'brief').contentJson)
  assert.equal(brief.desiredAction.destination.value, 'https://checkout.example/nova-oferta')
  assert.equal(brief.desiredAction.visualCta, 'Ver nova oferta')
})

test('unreviewed face safety cannot supersede a Director objective or Desired Action', async () => {
  const firstFixture = fixture({ ctaText: 'Compre' })
  const first = await firstFixture.service(request())
  assert.equal(first.run.qualityReport.status, 'review-required')
  await assert.rejects(() => firstFixture.service(request({
    baseVersionId: first.version.id, baseHash: first.version.baseHash, objective: 'sale',
    desiredAction: { destination: { type: 'url', value: 'https://checkout.example/oferta' } },
    reason: 'Nova oferta.', idempotency: { key: 'unreviewed-objective-change' },
  })), (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED')
  assert.equal(firstFixture.repository.lastBundle.run.id, first.run.id)
})

test('objective change fails before persistence without reason or required destination', async () => {
  const firstFixture = fixture()
  const first = await firstFixture.service(request())
  await assert.rejects(
    () => firstFixture.service(request({
      baseVersionId: first.version.id,
      baseHash: first.version.baseHash,
      objective: 'sale',
      desiredAction: {
        destination: { type: 'url', value: 'https://checkout.example/oferta' },
      },
      reason: ' ',
      idempotency: { key: 'director-objective-change-no-reason' },
    })),
    (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED',
  )
  await assert.rejects(
    () => firstFixture.service(request({
      baseVersionId: first.version.id,
      baseHash: first.version.baseHash,
      objective: 'sale',
      reason: 'Trocar para venda.',
      idempotency: { key: 'director-objective-change-no-destination' },
    })),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('Director hard gates reject missing rights and missing conversion CTA with explicit evidence', async () => {
  const missingRights = fixture()
  missingRights.repository.sourceRights = { state: 'missing' }
  await assert.rejects(
    () => missingRights.service(request({ idempotency: { key: 'director-rights-missing' } })),
    (error) => error instanceof DomainError &&
      error.code === 'INVALID_RENDER_INPUT' &&
      error.details.gateFailures.includes('rights-compliance'),
  )

  const noCta = fixture({ projectObjective: 'sale', ctaText: null })
  await assert.rejects(
    () => noCta.service(request({
      objective: 'sale',
      idempotency: { key: 'director-sale-cta-missing' },
    })),
    (error) => error instanceof DomainError &&
      error.code === 'INVALID_RENDER_INPUT' &&
      error.details.gateFailures.includes('cta-required'),
  )
})

test('Director V2 replays exactly and rejects payload or version drift', async () => {
  const { service } = fixture()
  const first = await service(request())
  const replay = await service(request())
  assert.equal(replay.replayed, true)
  assert.equal(replay.run.id, first.run.id)
  assert.equal(replay.version.id, first.version.id)

  await assert.rejects(
    () => service(request({ reason: 'Outra intenção para a mesma chave.' })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )

  await assert.rejects(
    () => service(request({
      actor: authenticatedActor({
        clientId: 'client-1',
        credentialId: 'credential-director-other',
        workspaceId: 'workspace-1',
      }),
    })),
    (error) =>
      error instanceof DomainError &&
      error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )

  const unauthorized = fixture()
  await assert.rejects(
    () => unauthorized.service(request({
      actor: authenticatedActor({
        clientId: 'client-1',
        credentialId: 'credential-director-read-only',
        workspaceId: 'workspace-1',
        scopes: ['projects:read'],
      }),
      idempotency: { key: 'director-read-only' },
    })),
    (error) =>
      error instanceof DomainError &&
      error.code === 'AUTH_SCOPE_REQUIRED',
  )

  const stale = fixture()
  await assert.rejects(
    () => stale.service(request({ baseHash: 'c'.repeat(64), idempotency: { key: 'director-stale' } })),
    (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT',
  )
})

test('Director V2 plans a selected B-roll insert with bound source audio, but cannot seal it without an observed insert', async () => {
  const { repository, service } = fixture({ selectedInsert: true })
  // The planner still decides to use the insert, with its own audio kept and an explicit decision...
  await assert.rejects(service(request()), (error) => error.code === 'PRECONDITION_REQUIRED' &&
    error.details.sourceArtifactIds.length === 1 && error.details.sourceArtifactIds[0] === 'artifact-selected-insert-1')
  const planned = JSON.parse(repository.resolvedCandidates.find((item) => item.kind === 'edit-plan').contentJson)
  const treatment = JSON.parse(repository.resolvedCandidates.find((item) => item.kind === 'treatment').contentJson)
  const insertedClip = planned.videoTracks[0].clips[1]
  assert.equal(insertedClip.sourceArtifactId, 'artifact-selected-insert-1')
  assert.equal(insertedClip.audioSourceArtifactId, 'artifact-source3')
  assert.equal(treatment.mode, 'talking-head')
  assert.equal(planned.director.decisions.some((decision) =>
    decision.category === 'insert' && decision.choice === 'use_selected_insert'), true)
  assert.equal(planned.director.assumptions.some((assumption) =>
    assumption.includes('asset-selection') && assumption.includes('rights')), true)
  // ...but a Version whose outputs could not be rendered is never sealed: the insert has no normalization authority yet.
  assert.equal(repository.lastBundle, undefined)
  assert.equal(repository.currentVersion.id, 'project-version-4')
})

test('Director V2 adopts the persisted receipt of a selected B-roll insert and seals the plan that uses it', async () => {
  const { repository, service } = fixture({ selectedInsert: true, head: insertHead, offered: insertWorld.adoptable })
  const result = await service(request({ baseHash: insertHead.version.baseHash }))
  const sealed = repository.lastBundle.bundle
  assert.deepEqual(repository.requested, [['artifact-selected-insert-1']], 'only the recording the head State does not observe is read')
  assert.deepEqual(sealed.origin.adoptions.map((item) => item.sourceArtifactId), ['artifact-selected-insert-1'])
  assert.deepEqual(sealed.state.document.entries[0].consumption.materialization.document.normalizations
    .map((n) => n.document.source.artifactId).sort(), ['artifact-selected-insert-1', 'artifact-source3'])
  assert.equal(sealed.state.document.parentStateHash, insertHead.state.stateHash)
  assert.equal(result.run.editPlan.videoTracks[0].clips[1].sourceArtifactId, 'artifact-selected-insert-1')
  // The same Command with no persisted receipt for the insert stays refused.
  const refused = fixture({ selectedInsert: true, head: insertHead, offered: [] })
  await assert.rejects(refused.service(request({ baseHash: insertHead.version.baseHash, idempotency: { key: 'director-insert-unoffered' } })),
    (error) => error.code === 'PRECONDITION_REQUIRED' && error.details.sourceArtifactIds[0] === 'artifact-selected-insert-1')
})

test('Director V2 persists an evidence-bound media-only treatment before proxy enqueue', async () => {
  const { repository, service } = fixture({ ownerText: undefined })
  const result = await service(request({ idempotency: { key: 'director-media-only' } }))

  assert.equal(result.run.treatmentPlan.schemaVersion, 3)
  assert.equal(result.run.treatmentPlan.mode, 'media-only')
  assert.equal(result.run.treatmentPlan.confidence, .65)
  assert.equal(result.run.treatmentPlan.grammar.primary, 'speaker')
  assert.ok(result.run.treatmentPlan.assumptions.includes('briefing-absent'))
  assert.ok(result.run.treatmentPlan.assumptions.includes('treatment-derived-from-observed-media'))
  assert.ok(result.run.treatmentPlan.claimPolicy.observedClaims.includes('Comunicar bem muda resultados.'))
  assert.deepEqual(result.run.treatmentPlan.claimPolicy.proposedClaims, [])
  assert.equal(repository.lastBundle.snapshots.find((snapshot) => snapshot.kind === 'treatment').contentSchemaVersion, 3)
  const motion = result.run.decisions.find((decision) => decision.id === 'decision-motion-none').reason
  assert.match(motion, /The request does not mention camera movement/u)
  assert.doesNotMatch(motion, /owner|brief/iu, 'a request that said nothing is not attributed to anyone')
})

test('Director V2 still requests one full proxy without fabricating stale artifacts when the base has no completed outputs', async () => {
  const { service } = fixture({ outputReferences: [] })
  const result = await service(request())

  assert.deepEqual(result.impact.affectedArtifacts, [])
  assert.deepEqual(result.impact.affectedVariantIds, [])
  assert.deepEqual(result.impact.minimalRenders, [{ kind: 'proxy', variantId: variantIdsOf(head)[0], ranges: [{ startFrame: 0, endFrame: 300 }] }])
  assert.deepEqual(result.invalidations, [])
})

test('W66 multi-output: a Director re-run on a project with two outputs stales the renders of EVERY output and asks one minimal proxy render per output', async () => {
  const variantIds = variantIdsOf(twoOutputHead)
  assert.equal(variantIds.length, 2)
  assert.equal(new Set(variantIds).size, 2)
  const references = variantIds.flatMap((variantId, index) => [
    { artifactId: `artifact-proxy-two-outputs-${index}`, kind: 'proxy', sourceVersionId: 'project-version-4', variantId },
    { artifactId: `artifact-final-two-outputs-${index}`, kind: 'final', sourceVersionId: 'project-version-4', variantId },
  ])
  const { repository, service } = fixture({ head: twoOutputHead, outputReferences: references })
  const input = request({ baseHash: twoOutputHead.version.baseHash })
  // The Command names no output: a Director re-run replans the one EditPlan every output re-materializes from.
  assert.equal('variantId' in input, false)
  const result = await service(input)
  const sorted = [...variantIds].sort()

  // the child Version carries EVERY entry; each output keeps its own spec revision and spec hash
  const entries = repository.lastBundle.bundle.state.document.entries
  assert.deepEqual(entries.map((entry) => entry.variantId), variantIds)
  for (const [index, entry] of entries.entries()) {
    assert.equal(entry.outputSpecRevisionId, twoOutputHead.state.document.entries[index].outputSpecRevisionId)
    assert.equal(entry.specHash, twoOutputHead.state.document.entries[index].specHash)
  }
  assert.deepEqual(result.impact.affectedVariantIds, sorted)
  assert.deepEqual(result.impact.affectedArtifacts.map((item) => [item.kind, item.artifactId, item.variantId]).toSorted(),
    references.map((item) => [item.kind, item.artifactId, item.variantId]).toSorted())
  assert.deepEqual(result.impact.minimalRenders, sorted.map((variantId) => ({ kind: 'proxy', variantId, ranges: [{ startFrame: 0, endFrame: 300 }] })))
  assert.equal(result.invalidations.length, 4)
  assert.deepEqual([...new Set(result.invalidations.map((item) => item.variantId))].sort(), sorted)
  assert.equal(repository.lastBundle.event.data.artifactInvalidationCount, 4)
  assert.deepEqual(parseDirectorRunImpact(JSON.parse(stableSerialize(result.impact))), result.impact)
  // a stored document that lists a render for one output only (or none) is not accepted back
  const stored = JSON.parse(stableSerialize(result.impact))
  assert.throws(() => parseDirectorRunImpact({ ...stored, minimalRenders: stored.minimalRenders.slice(0, 1) }), /not an output of the project/)
  assert.throws(() => parseDirectorRunImpact({ ...stored, minimalRenders: [] }), /invalid/)
  assert.throws(() => parseDirectorRunImpact({ ...stored, minimalRenders: [stored.minimalRenders[0], { ...stored.minimalRenders[1], ranges: [{ startFrame: 0, endFrame: 200 }] }] }), /invalid/)
})

test('W66 multi-output: the Director impact document refuses a render of a stranger and a project with no output', () => {
  const base = {
    commandId: 'command-director-two-outputs', baseVersionId: 'version-director-two-outputs-base', resultVersionId: 'version-director-two-outputs-result',
    sourceTranscriptId: 'transcript-director-two-outputs', sourceTranscriptHash: 'a'.repeat(64),
    plannerVersion: 'apollo-director-policy/v4', criticVersion: 'apollo-director-critic/v5', affectedEndFrame: 300, renderEndFrame: 280,
  }
  const reference = (variantId) => ({ artifactId: `artifact-${variantId}`, kind: 'proxy', sourceVersionId: base.baseVersionId, variantId })
  const ok = createDirectorRunImpact({ ...base, variantIds: ['variant-wide', 'variant-vertical'], outputReferences: [reference('variant-wide')] })
  assert.deepEqual(ok.minimalRenders.map((render) => [render.variantId, render.ranges[0].endFrame]), [['variant-vertical', 280], ['variant-wide', 280]])
  assert.deepEqual(ok.affectedVariantIds, ['variant-wide'])
  assert.throws(() => createDirectorRunImpact({ ...base, variantIds: ['variant-wide'], outputReferences: [reference('variant-vertical')] }), /not an output of the project/)
  assert.throws(() => createDirectorRunImpact({ ...base, variantIds: [], outputReferences: [] }), /every output/)
  assert.throws(() => createDirectorRunImpact({ ...base, variantIds: ['variant-wide', 'variant-wide'], outputReferences: [] }), /duplicated/)
})

test('Director enqueue allocates one immutable result version and replays before reading mutable project state', async () => {
  const directorRuns = new InMemoryDirectorRepository()
  let contextReads = 0
  const originalReadContext = directorRuns.readContext.bind(directorRuns)
  directorRuns.readContext = async (input) => {
    contextReads += 1
    return originalReadContext(input)
  }
  let stored
  const operations = {
    async findReplay(input) {
      if (!stored) return null
      assert.equal(input.requestFingerprint, stored.requestFingerprint)
      assert.equal(input.actorContextHash, stored.authenticationAudit.contextHash)
      return { operation: stored.operation, context: stored.context, authenticationAudit: stored.authenticationAudit, replayed: true }
    },
    async createOrReplay(input) {
      stored = input
      return { operation: input.operation, context: input.context, authenticationAudit: input.authenticationAudit, replayed: false }
    },
  }
  let sequence = 0
  const enqueue = enqueueProjectDirectorRunService({
    directorRuns,
    operations,
    clock: () => new Date('2026-08-03T22:30:00.000Z'),
    createId: (kind) => `${kind}-director-enqueue-${++sequence}`,
  })
  const input = {
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    baseVersionId: 'project-version-4',
    baseHash,
    actor: directorEnqueueActor(),
    idempotencyKey: 'director-enqueue-key-1',
    reason: 'Recompute the full editorial plan.',
    traceId: 'trace-director-enqueue-1',
  }
  const first = await enqueue(input)
  assert.equal(first.replayed, false)
  assert.equal(first.operation.type, 'project-director-run')
  assert.equal(first.operation.projectId, 'project-1')
  assert.deepEqual(first.authenticationAudit, materializeActorAuditContext(input.actor))
  assert.deepEqual(first.operation.target, {
    type: 'project-version',
    id: 'project-version-director-enqueue-1',
  })
  assert.deepEqual(first.context, {
    kind: 'project-director-run',
    projectId: 'project-1',
    baseVersionId: 'project-version-4',
    baseHash,
    resultVersionId: 'project-version-director-enqueue-1',
    baseObjective: 'discovery',
    objective: 'discovery',
    objectiveVersion: 1,
    rubricRef: 'awareness-discovery/v1',
    delegatedUserId: 'user-director-enqueue-1',
    reason: 'Recompute the full editorial plan.',
  })
  directorRuns.readContext = async () => {
    throw new Error('replay must not read mutable state')
  }
  const replay = await enqueue(input)
  assert.equal(replay.replayed, true)
  assert.equal(replay.operation.id, first.operation.id)
  assert.equal(contextReads, 1)
})

test('Director enqueue fails closed for a stale immutable base', async () => {
  const directorRuns = new InMemoryDirectorRepository()
  const enqueue = enqueueProjectDirectorRunService({
    directorRuns,
    operations: {
      async findReplay() { return null },
      async createOrReplay() { throw new Error('stale requests must not persist') },
    },
    createId: (kind) => `${kind}-stale-director-1`,
  })
  await assert.rejects(
    () => enqueue({
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      baseVersionId: 'project-version-stale-1',
      baseHash,
      actor: directorEnqueueActor(),
      idempotencyKey: 'director-stale-enqueue-1',
    }),
    (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT',
  )
})

test('Director worker fences the atomic commit and settles the allocated version target', async () => {
  const directorRuns = new InMemoryDirectorRepository()
  const workerAuthenticationAudit = materializeActorAuditContext(
    directorEnqueueActor('credential-director-worker-1'),
  )
  let operation = createQueuedPublicOperation({
    id: 'operation-director-worker-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    clientId: 'client-1',
    type: 'project-director-run',
    target: { type: 'project-version', id: 'project-version-worker-result-1' },
    createdAt: '2026-08-03T22:40:00.000Z',
  })
  const context = Object.freeze({
    kind: 'project-director-run',
    projectId: 'project-1',
    baseVersionId: 'project-version-4',
    baseHash,
    resultVersionId: 'project-version-worker-result-1',
    baseObjective: 'discovery',
    objective: 'discovery',
    objectiveVersion: 1,
    rubricRef: 'awareness-discovery/v1',
    delegatedUserId: workerAuthenticationAudit.delegatedUserId,
    reason: 'Run through the durable worker.',
  })
  let lease
  const activeLease = (input) =>
    lease?.owner === input.leaseOwner &&
    lease?.attempt === input.attempt &&
    Date.parse(lease.expiresAt) > Date.parse(input.now)
  const operations = {
    async claimNext(input) {
      assert.equal(input.type, 'project-director-run')
      operation = startPublicOperationAttempt(operation, input.now)
      lease = {
        owner: input.leaseOwner,
        attempt: operation.attempt,
        expiresAt: input.leaseUntil,
      }
      return {
        operation,
        context,
        authenticationAudit: workerAuthenticationAudit,
        lease: { ...lease, heartbeatAt: input.now },
      }
    },
    async heartbeat(input) {
      if (!activeLease(input)) return false
      lease.expiresAt = input.leaseUntil
      return true
    },
    async findById() {
      return { operation, context, authenticationAudit: workerAuthenticationAudit }
    },
    async failOrRetry() { throw new Error('successful worker must not fail') },
  }
  const originalCommit = directorRuns.commitPreparedBundle.bind(directorRuns)
  directorRuns.commitPreparedBundle = async (bundle) => {
    assert.deepEqual(bundle.operationFence, {
      operationId: operation.id,
      leaseOwner: 'worker-director-1',
      attempt: 1,
      now: bundle.operationFence.now,
    })
    assert.equal(bundle.version.id, context.resultVersionId)
    assert.equal(bundle.command.author.delegatedUserId, context.delegatedUserId)
    if (!activeLease(bundle.operationFence)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'lease lost before commit')
    }
    const result = await originalCommit(bundle)
    operation = advancePublicOperationPhase(operation, 'persisting', bundle.operationFence.now)
    operation = succeedPublicOperation(operation, bundle.operationFence.now)
    lease = undefined
    return result
  }
  let counter = 0
  const runNext = runNextProjectDirectorOperationService({
    operations,
    directorRuns,
    clock: () => new Date('2026-08-03T22:40:01.000Z'),
    createId: (kind) => `${kind}-worker-${++counter}`,
    createEventId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    compileBrief: createEvidenceBoundBriefCompiler(),
    leaseDurationMs: 30_000,
    heartbeatIntervalMs: 10_000,
  })
  const outcome = await runNext('worker-director-1')
  assert.deepEqual(outcome, {
    operationId: 'operation-director-worker-1',
    status: 'succeeded',
  })
  assert.equal(operation.status, 'succeeded')
  assert.deepEqual(operation.result.resource, context.kind === 'project-director-run'
    ? { type: 'project-version', id: context.resultVersionId }
    : null)
})

function createResilientDirectorOperation() {
  const authenticationAudit = testAuthenticationAudit({
    clientId: 'client-1',
    credentialId: 'credential-director-resilience-1',
    workspaceId: 'workspace-1',
  })
  let operation = createQueuedPublicOperation({
    id: 'operation-director-resilience-1',
    workspaceId: 'workspace-1',
    projectId: 'project-1',
    clientId: 'client-1',
    type: 'project-director-run',
    target: { type: 'project-version', id: 'project-version-resilience-result-1' },
    maxAttempts: 3,
    createdAt: '2026-08-03T23:00:00.000Z',
  })
  const context = Object.freeze({
    kind: 'project-director-run',
    projectId: 'project-1',
    baseVersionId: 'project-version-4',
    baseHash,
    resultVersionId: 'project-version-resilience-result-1',
    baseObjective: 'discovery',
    objective: 'discovery',
    objectiveVersion: 1,
    rubricRef: 'awareness-discovery/v1',
    reason: 'Exercise durable Director recovery.',
  })
  let lease
  let reclaimExpired = false
  const activeLease = (input) =>
    lease?.owner === input.leaseOwner &&
    lease?.attempt === input.attempt &&
    Date.parse(lease.expiresAt) > Date.parse(input.now)
  const record = () => ({ operation, context, authenticationAudit })
  const repository = {
    async claimNext(input) {
      if (
        !['queued', 'retrying'].includes(operation.status) &&
        !(operation.status === 'running' && reclaimExpired)
      ) return null
      if (
        operation.status === 'retrying' &&
        Date.parse(operation.nextAttemptAt) > Date.parse(input.now)
      ) return null
      operation = startPublicOperationAttempt(operation, input.now)
      reclaimExpired = false
      lease = {
        owner: input.leaseOwner,
        attempt: operation.attempt,
        expiresAt: input.leaseUntil,
      }
      return { ...record(), lease: { ...lease, heartbeatAt: input.now } }
    },
    async heartbeat(input) {
      if (!activeLease(input)) return false
      lease.expiresAt = input.leaseUntil
      return true
    },
    async findById() { return record() },
    async failOrRetry(input) {
      if (!activeLease(input)) return null
      operation = retryOrFailPublicOperation(
        operation,
        input.error,
        input.now,
        input.nextAttemptAt,
      )
      lease = undefined
      return record()
    },
  }
  return {
    context,
    repository,
    get operation() { return operation },
    activeLease,
    expireForReclaim() { reclaimExpired = true },
    cancel(at) {
      operation = cancelPublicOperation(operation, at)
      lease = undefined
    },
    async settle(bundle, commit) {
      if (!activeLease(bundle.operationFence)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director operation fence is stale')
      }
      const result = await commit(bundle)
      operation = advancePublicOperationPhase(
        operation,
        'persisting',
        bundle.operationFence.now,
      )
      operation = succeedPublicOperation(operation, bundle.operationFence.now)
      lease = undefined
      return result
    },
  }
}

function createDirectorResilienceClock() {
  let current = Date.parse('2026-08-03T23:00:00.000Z')
  return () => new Date((current += 100))
}

function resilientDirectorWorker(harness, directorRuns, clock) {
  let counter = 0
  return runNextProjectDirectorOperationService({
    operations: harness.repository,
    directorRuns,
    clock,
    createId: (kind) => `${kind}-resilience-${++counter}`,
    createEventId: () =>
      `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
    compileBrief: createEvidenceBoundBriefCompiler(),
    leaseDurationMs: 10_000,
    heartbeatIntervalMs: 1_000,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 8,
  })
}

test('Director worker retries a transient persistence outage and commits once after restart', async () => {
  const harness = createResilientDirectorOperation()
  const directorRuns = new InMemoryDirectorRepository()
  const originalRead = directorRuns.readContext.bind(directorRuns)
  const originalCommit = directorRuns.commitPreparedBundle.bind(directorRuns)
  let contextReads = 0
  let commits = 0
  directorRuns.readContext = async (input) => {
    contextReads += 1
    if (contextReads === 1) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'temporary database outage')
    }
    return originalRead(input)
  }
  directorRuns.commitPreparedBundle = async (bundle) => {
    commits += 1
    return harness.settle(bundle, originalCommit)
  }
  const runNext = resilientDirectorWorker(
    harness,
    directorRuns,
    createDirectorResilienceClock(),
  )
  assert.equal((await runNext('director-worker-retry-1')).status, 'retrying')
  assert.equal(harness.operation.status, 'retrying')
  assert.equal(harness.operation.attempt, 1)
  assert.equal((await runNext('director-worker-retry-2')).status, 'succeeded')
  assert.equal(harness.operation.attempt, 2)
  assert.equal(harness.operation.status, 'succeeded')
  assert.equal(contextReads, 2)
  assert.equal(commits, 1)
  assert.equal(directorRuns.currentVersion.id, harness.context.resultVersionId)
})

test('Director worker reclaims an expired running attempt without accepting its stale result', async () => {
  const harness = createResilientDirectorOperation()
  const directorRuns = new InMemoryDirectorRepository()
  const originalCommit = directorRuns.commitPreparedBundle.bind(directorRuns)
  const staleClaim = await harness.repository.claimNext({
    type: 'project-director-run',
    leaseOwner: 'director-worker-stale-1',
    now: '2026-08-03T23:00:00.050Z',
    leaseUntil: '2026-08-03T23:00:00.075Z',
  })
  harness.expireForReclaim()
  directorRuns.commitPreparedBundle = (bundle) => harness.settle(bundle, originalCommit)
  const runNext = resilientDirectorWorker(
    harness,
    directorRuns,
    createDirectorResilienceClock(),
  )
  assert.equal((await runNext('director-worker-reclaim-2')).status, 'succeeded')
  assert.equal(harness.operation.attempt, 2)
  await assert.rejects(
    () => harness.settle({ operationFence: {
      operationId: staleClaim.operation.id,
      leaseOwner: 'director-worker-stale-1',
      attempt: 1,
      now: '2026-08-03T23:00:00.200Z',
    } }, async () => {
      throw new Error('stale commit must never execute')
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(directorRuns.currentVersion.id, harness.context.resultVersionId)
})

test('Director cancellation during planning revokes the fence and publishes no version', async () => {
  const harness = createResilientDirectorOperation()
  const directorRuns = new InMemoryDirectorRepository()
  const originalVersionId = directorRuns.currentVersion.id
  directorRuns.commitPreparedBundle = async (bundle) => {
    harness.cancel('2026-08-03T23:00:00.450Z')
    return harness.settle(bundle, async () => {
      throw new Error('canceled Director must not commit')
    })
  }
  const runNext = resilientDirectorWorker(
    harness,
    directorRuns,
    createDirectorResilienceClock(),
  )
  const outcome = await runNext('director-worker-cancel-1')
  assert.equal(outcome.status, 'lease-lost')
  assert.equal(harness.operation.status, 'canceled')
  assert.equal(directorRuns.currentVersion.id, originalVersionId)
  assert.equal(directorRuns.records.size, 0)
})

test('Director transient retry is bounded and dead-letters without publishing a version', async () => {
  const harness = createResilientDirectorOperation()
  const directorRuns = new InMemoryDirectorRepository()
  const originalVersionId = directorRuns.currentVersion.id
  directorRuns.readContext = async () => {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'database remains unavailable')
  }
  const runNext = resilientDirectorWorker(
    harness,
    directorRuns,
    createDirectorResilienceClock(),
  )
  assert.equal((await runNext('director-worker-exhaust-1')).status, 'retrying')
  assert.equal((await runNext('director-worker-exhaust-2')).status, 'retrying')
  assert.equal((await runNext('director-worker-exhaust-3')).status, 'failed')
  assert.equal(harness.operation.attempt, 3)
  assert.equal(harness.operation.status, 'failed')
  assert.equal(harness.operation.retryable, false)
  assert.equal(harness.operation.error.retryable, false)
  assert.equal(harness.operation.deadLetteredAt, harness.operation.completedAt)
  assert.equal(directorRuns.currentVersion.id, originalVersionId)
  assert.equal(directorRuns.records.size, 0)
})

test('Director canonical snapshot binding preserves old row time and rejects incompatible resealed rows', () => {
  const document = { schemaVersion: 1, ownerText: 'Controlled snapshot identity' }
  const contentJson = stableSerialize(document)
  const candidate = { schemaVersion: 1, id: 'snapshot-candidate', workspaceId: 'workspace-1', projectId: 'project-1',
    kind: 'brief', contentSchemaVersion: 1, contentJson,
    contentHash: createHash('sha256').update(contentJson, 'utf8').digest('hex'),
    createdAt: '2026-10-12T12:00:00.000Z' }
  const stored = { ...candidate, id: 'snapshot-canonical', createdAt: '2026-07-18T20:00:00.000Z' }
  assert.deepEqual(bindDirectorSnapshotIdentities([candidate], [stored]), [stored])
  for (const [label, mutate] of [
    ['workspace', (row) => { row.workspaceId = 'workspace-sister' }],
    ['project', (row) => { row.projectId = 'project-sister' }],
    ['kind', (row) => { row.kind = 'policies' }],
    ['content schema', (row) => { row.contentSchemaVersion = 2 }],
    ['invalid content schema', (row) => { row.contentSchemaVersion = 0 }],
    ['malformed JSON', (row) => { row.contentJson = '{' }],
    ['JSON contradicts hash', (row) => { row.contentJson = stableSerialize({ schemaVersion: 1, ownerText: 'changed' }) }],
    ['rehashed different content', (row) => { row.contentJson = stableSerialize({ schemaVersion: 1, ownerText: 'changed' })
      row.contentHash = createHash('sha256').update(row.contentJson, 'utf8').digest('hex') }],
    ['noncanonical raw JSON', (row) => { row.contentJson = JSON.stringify(document, null, 2)
      assert.notEqual(row.contentJson, stableSerialize(JSON.parse(row.contentJson)), 'raw whitespace must differ from the canonical JSON bytes')
      row.contentHash = createHash('sha256').update(row.contentJson, 'utf8').digest('hex') }],
  ]) {
    const row = structuredClone(stored); mutate(row)
    assert.throws(() => bindDirectorSnapshotIdentities([candidate], [row]),
      (error) => error.code === 'PERSISTENCE_CONFLICT', label)
  }
  assert.throws(() => bindDirectorSnapshotIdentities([candidate], []),
    (error) => error.code === 'PERSISTENCE_CONFLICT', 'missing canonical identity')
})

test('Director pure recomposition preserves IDs/time and reuses planned critic with compiler called once', async () => {
  const repository = new InMemoryDirectorRepository()
  const compiled = createEvidenceBoundBriefCompiler()
  const allocations = []
  let compilerCalls = 0, clockCalls = 0, eventCalls = 0
  let first, second, chosenBrief
  repository.commitWithCanonicalSnapshots = async (scope, prepare) => {
    const resolve = (reuse) => async (candidates) => candidates.map((candidate) => {
      if (reuse && candidate.kind === 'brief') {
        chosenBrief = { ...candidate, id: 'snapshot-canonical-before-owner', createdAt: '2026-07-18T20:00:00.000Z' }
        return chosenBrief
      }
      return candidate
    })
    const beforeIds = [...allocations]
    first = directorView(await prepare(resolve(false)))
    second = directorView(await prepare(resolve(true)))
    assert.deepEqual(allocations, beforeIds, 'retry callback cannot allocate an identity')
    assert.equal(first.command.id, second.command.id)
    assert.equal(first.version.id, second.version.id)
    assert.equal(first.run.id, second.run.id)
    assert.equal(first.event.id, second.event.id)
    assert.equal(first.requestFingerprint, second.requestFingerprint)
    assert.equal(first.command.createdAt, second.command.createdAt)
    assert.equal(first.authenticationAudit.contextHash, scope.actorContextHash)
    assert.equal(second.authenticationAudit.contextHash, scope.actorContextHash)
    assert.equal(first.run.qualityReport, second.run.qualityReport, 'critic result is reused, not reassessed')
    assert.match(first.version.baseHash, /^[a-f0-9]{64}$/)
    assert.match(second.version.baseHash, /^[a-f0-9]{64}$/)
    assert.notEqual(first.version.baseHash, second.version.baseHash, 'Version authority incorporates the rematerialized EditPlan hash')
    assert.match(first.decisionLog.logHash, /^[a-f0-9]{64}$/)
    assert.match(second.decisionLog.logHash, /^[a-f0-9]{64}$/)
    assert.notEqual(first.decisionLog.logHash, second.decisionLog.logHash, 'decision evidence authority is resealed before persistence')
    const firstEdit = first.snapshots.find((item) => item.kind === 'edit-plan')
    const secondEdit = second.snapshots.find((item) => item.kind === 'edit-plan')
    assert.notEqual(firstEdit.contentJson, secondEdit.contentJson)
    assert.notEqual(firstEdit.contentHash, secondEdit.contentHash)
    assert.equal(createHash('sha256').update(secondEdit.contentJson, 'utf8').digest('hex'), secondEdit.contentHash)
    assert.deepEqual(JSON.parse(secondEdit.contentJson).director.decisions, second.run.decisions)
    assert.equal(first.snapshots.find((item) => item.kind === 'quality-report').contentHash,
      second.snapshots.find((item) => item.kind === 'quality-report').contentHash, 'critic evidence remains the original planned result')
    assert.equal(second.command.payload.snapshotRefs.brief, chosenBrief.id)
    assert.equal(second.version.snapshotRefs.brief, chosenBrief.id)
    assert.equal(second.snapshots.find((item) => item.kind === 'brief').createdAt, chosenBrief.createdAt)
    const oldBrief = first.command.payload.snapshotRefs.brief
    assert.ok(second.run.decisions.some((decision) => decision.evidenceRefs.includes(chosenBrief.id)))
    assert.equal(second.run.decisions.some((decision) => decision.evidenceRefs.includes(oldBrief)), false)
    validateDirectorDecisions(second.run.decisions)
    return repository.commitPreparedBundle(second)
  }
  const service = runProjectDirectorService({ repository,
    clock: () => { clockCalls += 1; return new Date('2026-07-18T22:00:00.000Z') },
    createId: (kind) => { const id = `${kind}-pure-${allocations.length + 1}`; allocations.push(id); return id },
    createEventId: () => { eventCalls += 1; return '00000000-0000-4000-8000-000000000099' },
    compileBrief: async (input) => { compilerCalls += 1; return compiled(input) },
  })
  const result = await service(request())
  assert.equal(compilerCalls, 1)
  assert.equal(clockCalls, 1)
  assert.equal(eventCalls, 1)
  assert.equal(result.run.qualityReport.status, 'review-required')
  assert.equal(result.run.qualityReport.faceSafety.status, 'unknown')
})

test('Director snapshot owner retries only exact serialization codes and exhausts after three transactions', async () => {
  const scope = { workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'project-version-4',
    baseHash, resultVersionId: 'project-version-next', idempotencyKey: 'snapshot-owner',
    requestFingerprint: 'b'.repeat(64), actorContextHash: 'c'.repeat(64) }
  for (const [label, error, expectedCalls] of [
    ['Prisma serialization', Object.assign(new Error('controlled'), { code: 'P2034' }), 3],
    ['raw SQL serialization', Object.assign(new Error('controlled'), { code: 'P2010', meta: { code: '40001' } }), 3],
    ['different SQLSTATE', Object.assign(new Error('controlled'), { code: 'P2010', meta: { code: '23505' } }), 1],
    ['wrong serialization spelling', Object.assign(new Error('controlled'), { code: 'P2010', meta: { code: 40001 } }), 1],
    ['message alone is not authority', Object.assign(new Error('serialization 40001'), { code: 'P2002' }), 1],
  ]) {
    let calls = 0, prepared = 0
    const repository = new PrismaDirectorRunRepository({
      async $transaction() { calls += 1; throw error },
    })
    await assert.rejects(repository.commitWithCanonicalSnapshots(scope, async () => { prepared += 1 }),
      (caught) => caught === error, label)
    assert.equal(calls, expectedCalls, label)
    assert.equal(prepared, 0, label)
  }
})

// ---- The Director names the transcript words of the captions it generates, so an editorial cut can end inside one ----
async function directorCueWorld(transcriptWords) {
  const { createMediaTranscript } = await import('../../src/v2/domain/media-transcript.ts')
  const base = compiledEditorialPlan()
  const words = transcriptWords ?? base.retimedTranscript.words.map((word) => ({ word: word.text, start: word.sourceStartSeconds, end: word.sourceEndSeconds }))
  const transcript = createMediaTranscript({ language: 'pt-BR', text: words.map((word) => word.word).join(' '), words,
    segments: [{ id: 0, start: words[0].start, end: words.at(-1).end, text: words.map((word) => word.word).join(' ') }], provider: 'groq', model: 'whisper-large-v3' })
  const editPlan = Object.freeze({ ...base, retimedTranscript: Object.freeze({ ...base.retimedTranscript, sourceTranscriptHash: transcript.transcriptHash }) })
  const { service } = fixture({ editPlan, transcript: { id: 'transcript-1', sourceArtifactId: 'artifact-source3', language: 'pt-BR',
    provider: 'groq', model: 'whisper-large-v3', transcriptHash: transcript.transcriptHash, words: transcript.words } })
  return { transcript, result: await service(request()) }
}

test('the Director names the transcript words of every caption cue it generates, in the ingest cue track shape', async () => {
  const { transcript, result } = await directorCueWorld()
  const [track] = result.run.editPlan.subtitleTracks
  assert.equal(track.schemaVersion, 'source-transcript-cue-track/v1')
  assert.equal(track.sourceTranscriptId, 'transcript-1')
  assert.equal(track.sourceTranscriptHash, transcript.transcriptHash)
  assert.ok(track.cues.length > 1)
  for (const cue of track.cues) {
    assert.ok(Array.isArray(cue.sourceWordIndices) && cue.sourceWordIndices.length > 0, cue.id)
    assert.equal(cue.sourceWordIndices.map((index) => transcript.words[index].word).join(' '), cue.text, 'the cue is exactly those words')
  }
  assert.equal(new Set(track.cues.flatMap((cue) => cue.sourceWordIndices)).size, track.cues.flatMap((cue) => cue.sourceWordIndices).length, 'no word twice')
})

test('without the observed transcript words, or with a word the transcript cannot name, no cue claims authority', async () => {
  const plain = await fixture().service(request())
  assert.equal(plain.run.editPlan.subtitleTracks[0].schemaVersion, undefined)
  assert.ok(plain.run.editPlan.subtitleTracks[0].cues.every((cue) => cue.sourceWordIndices === undefined))
  const base = compiledEditorialPlan()
  const words = base.retimedTranscript.words.map((word) => ({ word: word.text, start: word.sourceStartSeconds, end: word.sourceEndSeconds }))
  const missingOne = words.filter((_, index) => index !== 3)
  const { result } = await directorCueWorld(missingOne)
  const [track] = result.run.editPlan.subtitleTracks
  assert.equal(track.schemaVersion, undefined, 'a track is trusted whole or not at all')
  assert.ok(track.cues.every((cue) => cue.sourceWordIndices === undefined))
})

test('an editorial cut that ends inside a Director caption rebuilds the part that remains from the transcript words', async () => {
  const { createEditorialSourceBindingV1 } = await import('../../src/v2/domain/output-materialization.ts')
  const { materializeEditorialCutPlanV3 } = await import('../../src/v2/domain/editorial-cut-impact.ts')
  const { transcript, result } = await directorCueWorld()
  // The fixture's base plan declares retained ranges that do not match its clips; the cut then reads the ranges from the clips.
  const before = structuredClone(result.run.editPlan)
  delete before.editorial.retainedSourceRanges
  const binding = createEditorialSourceBindingV1({ schemaVersion: 'editorial-source-binding/v1', canonicalPolicyVersion: 'output-canonical-json/v1',
    id: 'binding-director-cut-1', workspaceId: 'workspace-1', projectId: 'project-1', parentVersionId: result.version.id, parentStateId: 'state-parent-1',
    parentStateHash: 'd'.repeat(64), resultVersionId: 'version-director-cut-1',
    authority: { kind: 'same-project-state3', sourceProjectId: 'project-1', sourceVersionId: result.version.id, sourceBaseHash: 'e'.repeat(64),
      sourceStateId: 'state-source-1', sourceStateHash: 'f'.repeat(64), forkRootVersionId: null, forkRootStateId: null, forkRootStateHash: null,
      derivationId: null, derivationHash: null },
    transcript: { id: 'transcript-1', workspaceId: 'workspace-1', projectId: 'project-1', sourceArtifactId: 'artifact-source3',
      sourceManifestId: 'manifest-source3', document: transcript, createdAt: '2026-07-18T20:00:00.000Z' },
    normalizationRefs: [{ id: 'normalization-1', projectId: 'project-1', receiptHash: '1'.repeat(64) }],
    inventory: [{ linkId: 'link-1', artifactId: 'artifact-source3', role: 'source-master', manifestId: 'manifest-1', manifestHash: '2'.repeat(64),
      artifactSha256: '3'.repeat(64), rightsSnapshotId: null, rightsHash: null, rightsRevision: 0 }],
    createdAt: '2026-07-18T22:30:00.000Z' })
  // "Seja bem-vindo." is one cue: removing the first word leaves "bem-vindo." in the same cue.
  const first = before.retimedTranscript.words[0]
  const after = materializeEditorialCutPlanV3({ before, sourceBinding: binding, versionId: 'version-director-cut-1', planId: 'plan-director-cut-1',
    commandId: 'command-director-cut-1', createdAt: binding.document.createdAt,
    exclusions: [{ sourceStartSeconds: first.sourceStartSeconds, sourceEndSeconds: first.sourceEndSeconds, ruleIds: ['rule-first-word'] }] })
  const cue = after.subtitleTracks[0].cues[0]
  assert.equal(cue.text, 'bem-vindo.')
  assert.deepEqual(cue.sourceWordIndices, [1])
  assert.equal(after.subtitleTracks[0].schemaVersion, 'source-transcript-cue-track/v1')
  // The same cut is refused for a Director plan that predates the authority: the refusal stays fail-closed.
  const legacy = structuredClone(before)
  delete legacy.subtitleTracks[0].schemaVersion
  for (const legacyCue of legacy.subtitleTracks[0].cues) delete legacyCue.sourceWordIndices
  assert.throws(() => materializeEditorialCutPlanV3({ before: legacy, sourceBinding: binding, versionId: 'version-director-cut-1', planId: 'plan-director-cut-1',
    commandId: 'command-director-cut-1', createdAt: binding.document.createdAt,
    exclusions: [{ sourceStartSeconds: first.sourceStartSeconds, sourceEndSeconds: first.sourceEndSeconds, ruleIds: ['rule-first-word'] }] }),
  (error) => error.code === 'PRECONDITION_REQUIRED' && /Partially cut cue/.test(error.message))
})

test('a review patch that edits a caption drops the transcript words it no longer follows, and only on that cue', async () => {
  const { materializePatchEditPlan } = await import('../../src/v2/domain/review-system.ts')
  const { result } = await directorCueWorld()
  const [first, second] = result.run.editPlan.subtitleTracks[0].cues
  assert.ok(Array.isArray(first.sourceWordIndices) && Array.isArray(second.sourceWordIndices), 'both cues name their words before the patch')
  const patched = materializePatchEditPlan({ editPlan: result.run.editPlan, newVersionId: 'version-patched-1', createdAt: '2026-07-18T23:00:00.000Z',
    availableAssetIds: [], patch: { id: 'patch-1', baseVersionId: result.version.id, annotationIds: ['annotation-1'],
      operations: [{ op: 'update-text', targetId: `subtitle:${first.id}`, value: { text: 'Texto revisado' } }] } })
  const [editedCue, otherCue] = patched.subtitleTracks[0].cues
  assert.equal(editedCue.text, 'Texto revisado')
  assert.equal(editedCue.sourceWordIndices, undefined, 'the reviewer\'s text is not the transcript words\'')
  assert.deepEqual(otherCue.sourceWordIndices, second.sourceWordIndices, 'an untouched cue keeps its words')
})

// ---------------------------------------------------------------------------------------------------------------------
// W64 - the Director decides on the evidence it holds, states how much that is, and asks for what it lacks.
// ---------------------------------------------------------------------------------------------------------------------

function fakeFaceRequester({ refuse, explode } = {}) {
  const operations = new Map()
  const calls = []
  return {
    calls, operations,
    async request(input) {
      calls.push(input)
      if (explode) throw new Error('database unavailable')
      if (refuse) throw new DomainError(refuse, 'refused by the admission')
      const known = operations.get(input.idempotencyKey)
      if (known) return { operationId: known, replayed: true }
      const operationId = `operation-face-${operations.size + 1}`
      operations.set(input.idempotencyKey, operationId)
      return { operationId, replayed: false }
    },
  }
}

const evidenceOf = (run, decisionId) => run.decisions.find((decision) => decision.id === decisionId).perceptionEvidence
const modalityOf = (evidence, modality) => evidence.modalities.find((item) => item.modality === modality)

test('W64 with no perception at all the plan is review - never the old flag, never auto-apply - and every gated decision carries its evidence ids', async () => {
  const { repository, service } = fixture()
  const { run } = await service(request())
  const report = run.qualityReport
  assert.equal(report.schemaVersion, 'director-quality-report/v5')
  assert.equal(report.status, 'review-required')
  assert.equal(report.faceSafety.status, 'unknown')
  assert.equal(hardCheck(report, 'subtitlesFaceSafe'), undefined, 'face safety is claimed by nobody: no check of the list says it')
  // all six decisions were graded by policy v2 and say so; only crop, caption and insert stand on perception
  assert.ok(run.decisions.every((decision) => decision.bandPolicy.policyHash === CONFIDENCE_BAND_POLICY_V2_SHA256))
  assert.deepEqual(run.decisions.filter((decision) => decision.perceptionEvidence).map((decision) => [decision.id, decision.decisionType]).toSorted(),
    [['decision-insert-selection', 'insert'], ['decision-layout-inset', 'crop'], ['decision-subtitle-bottom', 'caption']])
  const crop = run.decisions.find((decision) => decision.id === 'decision-layout-inset')
  const caption = run.decisions.find((decision) => decision.id === 'decision-subtitle-bottom')
  const insert = run.decisions.find((decision) => decision.id === 'decision-insert-selection')
  // absent evidence is review for the draft types and never auto-apply
  assert.deepEqual([crop.perceptionEvidence.tier, crop.confidenceBand], ['absent', 'review'])
  assert.deepEqual([caption.perceptionEvidence.tier, caption.confidenceBand], ['absent', 'review'])
  assert.deepEqual(caption.perceptionEvidence.modalities.map((item) => [item.modality, item.tier, item.reasonCode]), [
    ['transcript-word', 'partial', 'CONFIDENCE_NOT_MEASURED'], ['face', 'absent', 'NO_PRODUCER_RUN'], ['ocr', 'absent', 'NO_PRODUCER_RUN']])
  // nothing is proposed beyond the master, so the omitted insert needs no evidence and is the one decision that auto-applies
  assert.deepEqual([insert.perceptionEvidence.tier, insert.confidenceBand, insert.perceptionEvidence.modalities.length], ['high', 'auto-apply', 0])
  // the evidence ids: the snapshot every decision and the report name is the one the run's perception names
  const snapshotId = serverPerceptionSnapshotId(run.perception.serverSnapshot.snapshotHash)
  assert.equal(report.perceptionEvidence.snapshot.id, snapshotId)
  assert.equal(report.perceptionEvidence.snapshot.snapshotHash, run.perception.serverSnapshot.snapshotHash)
  for (const decision of [crop, caption, insert]) {
    assert.equal(decision.perceptionEvidence.snapshot.id, snapshotId)
    assert.ok(decision.evidenceRefs.includes(snapshotId), `${decision.id} names the snapshot among its evidence`)
    assert.equal(report.perceptionEvidence.decisions.find((entry) => entry.decisionId === decision.id).evidenceHash, decision.perceptionEvidence.evidenceHash)
  }
  // the log carries the same ids
  const logged = repository.lastBundle.decisionLog.entries.find((entry) => entry.id === 'decision-subtitle-bottom')
  assert.ok(logged.evidence.some((item) => item.ref === snapshotId))
  // the critic distinguishes the tiers: the historical code for absent face, one review warning per non-auto decision, no hard issue
  const codes = report.issues.map((issue) => [issue.code, issue.targetId])
  assert.ok(codes.some(([code]) => code === 'FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED'))
  assert.ok(!codes.some(([code]) => code === 'FACE_EVIDENCE_PARTIAL_REVIEW_REQUIRED'))
  assert.deepEqual(codes.filter(([code]) => code === 'DECISION_EVIDENCE_REVIEW_REQUIRED').map(([, target]) => target).toSorted(),
    ['decision-layout-inset', 'decision-subtitle-bottom'])
  assert.equal(report.issues.filter((issue) => issue.severity === 'hard').length, 0)
  // the report's coverage and modalities are the perception timeline's own, kind by kind
  for (const entry of report.perceptionEvidence.coverage) {
    const stated = run.perception.timeline.coverage.find((item) => item.kind === entry.kind)
    assert.deepEqual([entry.state, entry.examinedMs, entry.reasonCode], [stated.state, stated.observedMs, stated.reasonCode ?? null], entry.kind)
  }
  assert.equal(report.perceptionEvidence.modalities.find((item) => item.modality === 'face').tier, 'absent')
  assert.equal(report.perceptionEvidence.rights.certain, true)
  assert.equal(report.perceptionEvidence.faceWindows.status, 'not-configured')
  assert.equal(report.perceptionEvidence.faceWindows.reasonCode, 'FACE_REQUESTER_NOT_CONFIGURED')
  assert.deepEqual(report.perceptionEvidence.faceWindows.entries.map((entry) => [entry.startSourceFrame, entry.endSourceFrame, entry.state]),
    [[0, 115, 'deferred'], [145, 275, 'deferred'], [305, 420, 'deferred']])
  // the stored bytes read back through the strict parser, and a tampered tier does not
  const stored = repository.lastBundle.snapshots.find((item) => item.kind === 'quality-report')
  const parse = (contentJson) => parseDirectorQualityReport({ contentJson, contentHash: stored.contentHash, contentSchemaVersion: 5, objective: run.objective, rubricRef: run.rubricRef })
  assert.equal(parse(stored.contentJson).perceptionEvidence.evidenceHash, report.perceptionEvidence.evidenceHash)
  const forged = JSON.parse(stored.contentJson)
  forged.perceptionEvidence.modalities.find((item) => item.modality === 'face').tier = 'high'
  assert.throws(() => parse(JSON.stringify(forged)), (error) => error.code === 'PERSISTENCE_CONFLICT')
  assertDirectorRunEvidenceConsistency({ evidence: report.perceptionEvidence, baseVersionId: run.perception.inputVersionId, perception: run.perception, decisions: run.decisions })
  // a decision graded under another band than its tier gives is refused by the consistency check
  assert.throws(() => assertDirectorRunEvidenceConsistency({ evidence: report.perceptionEvidence, baseVersionId: run.perception.inputVersionId, perception: run.perception,
    decisions: run.decisions.map((decision) => decision.id === 'decision-layout-inset' ? { ...decision, confidenceBand: 'auto-apply' } : decision) }),
  (error) => error.code === 'PERSISTENCE_CONFLICT')
})

test('W64 the Director asks for the face windows its plan needs, never waits for them, and a window requested is pending evidence, not absent evidence', async () => {
  const requester = fakeFaceRequester()
  const { repository, service } = fixture({ faceWindows: requester })
  const { run } = await service(request())
  assert.deepEqual(requester.calls.map((call) => [call.sourceArtifactId, call.window.startSourceFrame, call.window.endSourceFrame]),
    [['artifact-source3', 0, 115], ['artifact-source3', 145, 275], ['artifact-source3', 305, 420]], 'the windows the three source spans need, widened by the sample gap')
  assert.ok(requester.calls.every((call) => /^dfw-[a-f0-9]{56}$/.test(call.idempotencyKey)), 'a deterministic key')
  assert.equal(new Set(requester.calls.map((call) => call.idempotencyKey)).size, 3)
  assert.ok(requester.calls.every((call) => call.workspaceId === 'workspace-1' && call.projectId === 'project-1' && call.authenticationAudit.clientId === 'client-1'),
    'asked as the actor of the run')
  const windows = run.qualityReport.perceptionEvidence.faceWindows
  assert.deepEqual([windows.status, windows.requiredCount, windows.requestedCount, windows.satisfiedCount, windows.refusedCount], ['planned', 3, 3, 0, 0])
  assert.deepEqual(windows.entries.map((entry) => entry.operationId), ['operation-face-1', 'operation-face-2', 'operation-face-3'])
  // what was asked for is pending: the face tier is absent FOR THAT REASON, over exactly the ranges that were asked for
  const face = modalityOf(evidenceOf(run, 'decision-layout-inset'), 'face')
  assert.deepEqual([face.tier, face.reasonCode, face.pendingMs, face.pendingMs === face.rangeMs], ['absent', 'FACE_EVIDENCE_PENDING', face.rangeMs, true])
  assert.equal(modalityOf(evidenceOf(run, 'decision-subtitle-bottom'), 'face').reasonCode, 'FACE_EVIDENCE_PENDING')
  assert.equal(run.decisions.find((decision) => decision.id === 'decision-layout-inset').confidenceBand, 'review')
  assert.match(run.decisions.find((decision) => decision.id === 'decision-subtitle-bottom').reason, /FACE_EVIDENCE_PENDING/)
  // replay of the same run asks nothing
  const replay = await service(request())
  assert.equal(replay.replayed, true)
  assert.equal(requester.calls.length, 3)
  assert.equal(stableSerialize(replay.run.qualityReport), stableSerialize(run.qualityReport))
  void repository
})

test('W64 asking again for the same plan is the same operations: a run refused at commit leaves requests the next attempt replays', async () => {
  const requester = fakeFaceRequester()
  const { repository, service } = fixture({ faceWindows: requester })
  const commit = repository.commitWithCanonicalSnapshots.bind(repository)
  repository.commitWithCanonicalSnapshots = async () => { throw new DomainError('PERSISTENCE_CONFLICT', 'raced before commit') }
  await assert.rejects(service(request({ idempotency: { key: 'director-attempt-1' } })), (error) => error.code === 'PERSISTENCE_CONFLICT')
  assert.equal(requester.operations.size, 3)
  repository.commitWithCanonicalSnapshots = commit
  const { run } = await service(request({ idempotency: { key: 'director-attempt-2' } }))
  assert.equal(requester.calls.length, 6, 'both attempts asked')
  assert.equal(requester.operations.size, 3, 'and the second created nothing: the same keys are the same operations')
  assert.deepEqual(requester.calls.slice(0, 3).map((call) => call.idempotencyKey), requester.calls.slice(3).map((call) => call.idempotencyKey))
  // the second attempt's report says what the admission answered: every window was a replay of an operation that already existed
  const entries = run.qualityReport.perceptionEvidence.faceWindows.entries
  assert.deepEqual(entries.map((entry) => [entry.state, entry.replayed]), [['requested', true], ['requested', true], ['requested', true]])
  assert.deepEqual(entries.map((entry) => entry.operationId), ['operation-face-1', 'operation-face-2', 'operation-face-3'], 'the very operations the first attempt created')
})

test('W64 a refused request is reported and the run goes on; any other failure is not swallowed; a stale base asks for nothing', async () => {
  const refusing = fakeFaceRequester({ refuse: 'PRECONDITION_REQUIRED' })
  const refused = await fixture({ faceWindows: refusing }).service(request())
  const windows = refused.run.qualityReport.perceptionEvidence.faceWindows
  assert.deepEqual([windows.requestedCount, windows.refusedCount], [0, 3])
  assert.ok(windows.entries.every((entry) => entry.state === 'refused' && entry.reasonCode === 'PRECONDITION_REQUIRED' && entry.operationId === null))
  const face = modalityOf(evidenceOf(refused.run, 'decision-layout-inset'), 'face')
  assert.deepEqual([face.tier, face.reasonCode], ['absent', 'FACE_EVIDENCE_REQUEST_FAILED'])
  assert.equal(refused.run.qualityReport.status, 'review-required')

  const exploding = fakeFaceRequester({ explode: true })
  await assert.rejects(fixture({ faceWindows: exploding }).service(request()), /database unavailable/)

  const stale = fakeFaceRequester()
  await assert.rejects(fixture({ faceWindows: stale }).service(request({ baseHash: 'c'.repeat(64), idempotency: { key: 'director-stale-w64' } })),
    (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT')
  assert.equal(stale.calls.length, 0, 'a stale base is refused before anything is asked for')
})

test('W64 rights are integral: one insert whose rights are revoked, expired or unknown blocks the plan and names it', async () => {
  const insertPlan = { selectedInsert: true, head: insertHead, offered: insertWorld.adoptable }
  const approved = fixture(insertPlan)
  const ok = await approved.service(request({ baseHash: insertHead.version.baseHash }))
  assert.equal(ok.run.qualityReport.perceptionEvidence.rights.certain, true)
  assert.deepEqual(ok.run.qualityReport.perceptionEvidence.rights.sources.map((source) => [source.artifactId, source.certain]),
    [['artifact-selected-insert-1', true], ['artifact-source3', true]])
  const insertDecision = ok.run.decisions.find((decision) => decision.id === 'decision-insert-selection')
  assert.deepEqual([insertDecision.perceptionEvidence.tier, insertDecision.confidenceBand], ['high', 'auto-apply'], 'an insert on certain rights is the one thing that can auto-apply')
  assert.deepEqual(modalityOf(insertDecision.perceptionEvidence, 'rights').envelopeIds, ['rights-snapshot-insert-1'])
  const base = { ...insertPlan, idempotency: { key: 'director-insert-rights' } }
  const cases = {
    revoked: [{ state: 'present', snapshotId: 'rights-revoked', snapshotHash: 'e'.repeat(64), status: 'revoked', consentStatus: 'not-required' }, 'RIGHTS_STATUS_REVOKED'],
    expired: [{ state: 'present', snapshotId: 'rights-expired', snapshotHash: 'e'.repeat(64), status: 'approved', consentStatus: 'not-required', expiresAt: '2026-07-18T21:59:59.000Z' }, 'RIGHTS_EXPIRED'],
    consentPending: [{ state: 'present', snapshotId: 'rights-consent', snapshotHash: 'e'.repeat(64), status: 'approved', consentStatus: 'pending' }, 'CONSENT_STATUS_PENDING'],
    missing: [{ state: 'missing' }, 'RIGHTS_UNKNOWN'],
  }
  for (const [name, [insertRights, reasonCode]] of Object.entries(cases)) {
    await assert.rejects(fixture({ ...base, insertRights }).service(request({ baseHash: insertHead.version.baseHash, idempotency: { key: `director-insert-${name}` } })),
      (error) => error instanceof DomainError && error.code === 'INVALID_RENDER_INPUT' &&
        error.details.gateFailures.includes('rights-compliance') &&
        error.details.uncertainRights.includes(`artifact-selected-insert-1:${reasonCode}`) && error.details.blockedDecisions.includes('decision-insert-selection'), name)
  }
  // a source the context does not list is unknown, which is not certain
  const unlisted = fixture(insertPlan)
  const readContext = unlisted.repository.readContext.bind(unlisted.repository)
  unlisted.repository.readContext = async (input) => {
    const context = await readContext(input)
    return { ...context, timelineSourceRights: context.timelineSourceRights.filter((entry) => entry.artifactId !== 'artifact-selected-insert-1') }
  }
  await assert.rejects(unlisted.service(request({ baseHash: insertHead.version.baseHash, idempotency: { key: 'director-insert-unlisted' } })),
    (error) => error.code === 'INVALID_RENDER_INPUT' && error.details.uncertainRights.includes('artifact-selected-insert-1:RIGHTS_UNKNOWN'))
  // and the master alone being approved is not enough when the context lists no other source: a controlled context states the master only
  const masterOnly = fixture({ ...insertPlan })
  const masterContext = masterOnly.repository.readContext.bind(masterOnly.repository)
  masterOnly.repository.readContext = async (input) => { const { timelineSourceRights: _dropped, ...rest } = await masterContext(input); return rest }
  await assert.rejects(masterOnly.service(request({ baseHash: insertHead.version.baseHash, idempotency: { key: 'director-insert-master-only' } })),
    (error) => error.code === 'INVALID_RENDER_INPUT' && error.details.uncertainRights.length === 1)
})

test('W64 a caller\'s observation set changes nothing: it is not an input of the Director, and a Director given one decides exactly as without', async () => {
  const clean = await fixture().service(request())
  const poisoned = fixture()
  const readContext = poisoned.repository.readContext.bind(poisoned.repository)
  const observationSet = { schemaVersion: 'reframe-observations/v1', id: 'caller-observations-1', observations: [{ id: 'face-everywhere', kind: 'face', startFrame: 0, endFrame: 300 }] }
  poisoned.repository.readContext = async (input) => ({ ...await readContext(input), observationSet, observations: observationSet.observations,
    perception: { observationSet }, faceCoverage: 'complete', faceSafety: { status: 'verified' } })
  const result = await poisoned.service({ ...request(), observationSet, observations: observationSet.observations, faceSafe: true })
  assert.equal(stableSerialize(result.run.decisions), stableSerialize(clean.run.decisions))
  assert.equal(stableSerialize(result.run.qualityReport), stableSerialize(clean.run.qualityReport))
  assert.equal(stableSerialize(result.run.perception), stableSerialize(clean.run.perception))
  assert.equal(result.run.qualityReport.perceptionEvidence.evidenceHash, clean.run.qualityReport.perceptionEvidence.evidenceHash)
  assert.equal(result.run.qualityReport.faceSafety.status, 'unknown')
  assert.ok(result.run.decisions.filter((decision) => decision.perceptionEvidence).every((decision) => decision.perceptionEvidence.tier !== 'high' || decision.id === 'decision-insert-selection'))
  assert.equal(modalityOf(evidenceOf(result.run, 'decision-layout-inset'), 'face').tier, 'absent')
})

test('W64 the result Version is materialized after the commit and never before it; a failure there is not the run\'s failure; a replay asks nothing', async () => {
  const materialized = []
  const warnings = []
  const { repository, service } = fixture({ warn: (event) => warnings.push(event),
    materializeSnapshot: async (input) => { materialized.push(input); throw new DomainError('PERSISTENCE_CONFLICT', 'storage hiccup with a secret=hunter2') } })
  const first = await service(request())
  // not silent: one structured warning names the run and the Version and the kind of failure, never the message
  assert.deepEqual(warnings, [{ level: 'warn', kind: 'director-snapshot-materialization-failed', workspaceId: 'workspace-1', projectId: 'project-1',
    directorRunId: first.run.id, projectVersionId: first.version.id, errorName: 'DomainError', errorCode: 'PERSISTENCE_CONFLICT' }])
  assert.equal(JSON.stringify(warnings).includes('hunter2'), false)
  assert.deepEqual(materialized, [{ workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: first.version.id }])
  assert.equal(repository.currentVersion.id, first.version.id, 'the run is sealed whatever the materialization did')
  assert.equal((await service(request())).replayed, true)
  assert.equal(materialized.length, 1)
  assert.equal(warnings.length, 1, 'a replay neither materializes nor warns')
  // a log sink that throws, or a failure that is not an Error, does not fail a sealed run either; the default sink is one JSON line on console.warn
  const lines = []
  const original = console.warn
  console.warn = (line) => lines.push(line)
  try {
    const plain = fixture({ materializeSnapshot: async () => { throw 'not an error' } })
    await plain.service(request())
    const throwing = fixture({ warn: () => { throw new Error('sink down') }, materializeSnapshot: async () => { throw new Error('x') } })
    assert.ok((await throwing.service(request())).run.id)
  } finally { console.warn = original }
  assert.equal(lines.length, 1)
  assert.deepEqual([JSON.parse(lines[0]).kind, JSON.parse(lines[0]).errorName, JSON.parse(lines[0]).errorCode], ['director-snapshot-materialization-failed', 'NonError', null])
  const refused = []
  const failing = fixture({ materializeSnapshot: async (input) => { refused.push(input) } })
  await assert.rejects(failing.service(request({ baseHash: 'c'.repeat(64), idempotency: { key: 'director-stale-materialize' } })), (error) => error.code === 'VERSION_CONFLICT')
  assert.equal(refused.length, 0)
})

// ---- ADR-160: the plan is made from the policy resolution of the editorial request, and says so.

test('ADR-160 the run seals the request it answers and the policy resolution it was planned and judged against', async () => {
  const { repository, service } = fixture()
  const { run, command } = await service(request({ idempotency: { key: 'request-sealed' } }))
  assert.match(run.requestHash, /^[a-f0-9]{64}$/)
  assert.equal(run.policyResolution.requestHash, run.requestHash)
  assert.equal(run.qualityReport.requestHash, run.requestHash)
  assert.equal(run.qualityReport.policyResolutionHash, run.policyResolution.policyResolutionHash)
  assert.equal(run.qualityReport.criticVersion, 'apollo-director-critic/v5')
  // the sealed resolution is a snapshot of its own, named by the command and by the run
  const sealed = repository.lastBundle.snapshots.find((snapshot) => snapshot.kind === 'policy-resolution')
  assert.equal(command.payload.snapshotRefs.policyResolution, sealed.id)
  assert.equal(parseEditorialPolicyResolution(JSON.parse(sealed.contentJson)).policyResolutionHash, run.policyResolution.policyResolutionHash)
  // the request is the one the brief states: the same reader the final-export admission uses
  const brief = JSON.parse(repository.lastBundle.snapshots.find((snapshot) => snapshot.kind === 'brief').contentJson)
  assert.equal(deriveEditorialRequestFromBrief(brief).requestHash, run.requestHash)
  // every decision names the policy that sustains it, and the policy belongs to this resolution
  for (const decision of run.decisions) {
    assert.ok(decision.evidenceRefs.some((ref) => resolutionOwnsPolicyRef(run.policyResolution, ref)), `${decision.id} names no policy of the sealed resolution`)
  }
  // every hard check is tied to a policy of the resolution, or to none
  for (const check of run.qualityReport.hardChecks) {
    assert.ok(['request', 'invariant'].includes(check.kind))
    assert.ok(check.policyRef === null || resolutionOwnsPolicyRef(run.policyResolution, check.policyRef), `${check.id} names a policy this resolution does not own`)
    assert.ok(check.evidence.length > 0)
  }
  assert.deepEqual(run.qualityReport.hardChecks.map((check) => check.id),
    ['requestHonored', 'movementMatchesPolicy', 'openingMatchesPolicy', 'forbiddenSpeechAbsent', 'captionsFitMeasured', 'timelineContinuous', 'sourceRightsCertain'])
})

test('ADR-160 the reason of a decision is generated from the origin of its policy, never from a wish the request did not state', async () => {
  // A briefing that talks about tone and nothing about movement: the old reason attributed "a direct, natural tone" to the owner for the
  // absence of camera movement. The reason now says that the request is silent about movement.
  const { run } = await fixture().service(request({ idempotency: { key: 'reason-from-origin' } }))
  const motion = run.decisions.find((decision) => decision.id === 'decision-motion-none')
  assert.equal(run.policyResolution.policies.movement.origin, 'silence-rule')
  assert.equal(run.policyResolution.policies.movement.rule, 'minimal-intervention')
  assert.equal(motion.reason, run.policyResolution.policies.movement.reason)
  assert.match(motion.reason, /does not mention camera movement/)
  for (const decision of run.decisions) {
    assert.doesNotMatch(decision.reason, /owner requested|requested a direct|natural tone/i, `${decision.id} attributes to the owner what the request does not say`)
  }
  // When the request DOES say it, the reason says so and points at the field.
  const asked = fixture({ editorialRequest: { directives: [{ id: 'movement-field', kind: 'movement', value: 'none' }] } })
  const { run: answered } = await asked.service(request({ idempotency: { key: 'reason-from-field' } }))
  const answeredMotion = answered.decisions.find((decision) => decision.id === 'decision-motion-none')
  assert.equal(answered.policyResolution.policies.movement.origin, 'request-field')
  assert.match(answeredMotion.reason, /Requested as a structured field of the editorial request \(movement none\)/)
  assert.notEqual(answered.requestHash, run.requestHash)
  assert.notEqual(answered.policyResolution.policyResolutionHash, run.policyResolution.policyResolutionHash)
})

test('ADR-160 different briefings over the same media give different requests and different resolutions; a silent project resolves every policy with origin and reason', async () => {
  const hashes = new Set()
  for (const ownerText of [undefined, 'alpha beta gamma', 'delta epsilon']) {
    const { run } = await fixture({ ownerText }).service(request({ idempotency: { key: `briefing-${String(ownerText).length}` } }))
    hashes.add(run.requestHash)
    hashes.add(run.policyResolution.policyResolutionHash)
    for (const [key, policy] of Object.entries(run.policyResolution.policies)) {
      assert.ok(policy.origin && policy.rule && policy.reason.length > 20 && policy.evidenceRefs.length > 0, `${key} lacks origin, rule, reason or evidence`)
    }
  }
  assert.equal(hashes.size, 6, 'three briefings, three requests and three resolutions')
})

test('ADR-160 a request the Apollo cannot execute stops the Director before any plan is persisted: it is never ignored', async () => {
  const unsupported = fixture({ editorialRequest: { directives: [{ id: 'movement-field', kind: 'movement', value: 'zoom-in' }] } })
  await assert.rejects(unsupported.service(request({ idempotency: { key: 'unsupported-movement' } })),
    (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && error.details.unsupported[0].value === 'movement zoom-in')
  assert.equal(unsupported.repository.lastBundle, undefined)
  const rotten = fixture({ editorialRequest: { directives: [{ id: 'movement-field', kind: 'tone', value: 'warm' }] } })
  await assert.rejects(rotten.service(request({ idempotency: { key: 'unknown-directive' } })), (error) => error instanceof DomainError)
  assert.equal(rotten.repository.lastBundle, undefined)
})

test('ADR-160 the final admission needs the v5 report, critic v4, every check, the request now in the brief and the sealed resolution', async () => {
  const { run } = await fixture().service(request({ idempotency: { key: 'admission' } }))
  const report = run.qualityReport
  const bound = bindingOf(run)
  assert.deepEqual(admitDirectorQualityForFinal(report, bound), { admitted: true, basis: 'per-cue-caption-certification' })
  const refused = (value, binding, pattern) => {
    const verdict = admitDirectorQualityForFinal(value, binding)
    assert.equal(verdict.admitted, false)
    assert.match(verdict.reason, pattern)
  }
  refused(report, undefined, /cannot be bound/)
  refused(report, { ...bound, currentRequestHash: 'f'.repeat(64) }, /request changed/)
  refused(report, { ...bound, sealedRequestHash: null }, /did not seal/)
  refused(report, { ...bound, sealedPolicyResolutionHash: 'e'.repeat(64) }, /policy resolution sealed/)
  refused(report, { ...bound, sealedPolicyResolutionHash: null }, /policy resolution sealed/)
  refused({ ...report, criticVersion: 'apollo-director-critic/v3' }, bound, /superseded/)
  refused({ ...report, criticVersion: 'whatever' }, bound, /not a critic the Apollo admits/)
  refused({ ...report, schemaVersion: 'director-quality-report/v4' }, bound, /superseded/)
  refused({ ...report, schemaVersion: 'director-quality-report/v3' }, bound, /superseded/)
  refused({ ...report, hardChecks: report.hardChecks.map((check) => check.id === 'movementMatchesPolicy' ? { ...check, passed: false } : check) }, bound, /movementMatchesPolicy did not hold/)
  refused({ ...report, hardChecks: report.hardChecks.filter((check) => check.id !== 'requestHonored') }, bound, /requestHonored is missing/)
  refused({ ...report, hardChecks: [] }, bound, /no hard check list/)
  refused({ ...report, requestHash: undefined }, bound, /does not name/)
  refused({ ...report, status: 'blocked' }, bound, /blocked/)
  assert.deepEqual([...REQUIRED_HARD_CHECKS], ['requestHonored', 'timelineContinuous', 'sourceRightsCertain'])
})

test('ADR-160 F5: the call to action is the block where it is spoken, the overlay follows that speech, and no block has a role by position', async () => {
  const { repository, service } = fixture({ projectObjective: 'sale', ctaText: 'Compre' })
  // the call is said in the MIDDLE clip, not in the last one
  const base = compiledEditorialPlan(false, 'Compre')
  const words = base.retimedTranscript.words
    .map((word) => word.text === 'Compre' ? { ...word, timelineStartFrame: 178, timelineEndFrame: 190, sourceStartSeconds: 11.9, sourceEndSeconds: 12.3 } : word)
    .toSorted((left, right) => left.timelineStartFrame - right.timelineStartFrame)
  repository.baseEditPlan = Object.freeze({ ...base, retimedTranscript: Object.freeze({ ...base.retimedTranscript, words: Object.freeze(words) }) })
  const result = await service(request({
    objective: 'sale',
    desiredAction: { destination: { type: 'url', value: 'https://checkout.example/oferta' }, verbalCta: 'Compre', visualCta: 'Ver oferta' },
    reason: 'A oferta pede uma ação.',
    idempotency: { key: 'director-f5-structure' },
  }))
  const blocks = result.run.storyPlan.blocks
  assert.deepEqual(blocks.map((block) => block.role), ['segment', 'cta', 'segment'], 'the call is in clip 2, wherever the clips are')
  assert.deepEqual(result.run.storyPlan.acts.map((act) => act.id), ['sequence'])
  assert.equal(blocks.every((block) => block.actId === 'sequence'), true)
  // the visual call is drawn while the sentence of the call is spoken, not in a closing window of fixed length
  const [overlay] = result.run.editPlan.overlayTracks
  assert.equal(overlay.startFrame, 178)
  assert.equal(overlay.endFrame, 190)
  const policies = result.run.policyResolution.policies
  assert.deepEqual(policies.ctaOverlay.value, { mode: 'window', startSeconds: 5.933, endSeconds: 6.333, anchoredTo: 'spoken-cta' })
  assert.equal(policies.structure.value.roles, 'none')
  assert.equal(result.run.qualityReport.strategic.gateResults.find((gate) => gate.id === 'cta-required').passed, true)
  // the treatment plan carries the budgets of the resolution, not numbers of the planner
  assert.equal(result.run.treatmentPlan.budget.patternBreaksPer30s, policies.budget.value.maxPatternBreaksPer30s)
  assert.equal(result.run.treatmentPlan.budget.proofItems, policies.budget.value.maxProofItems)
  assert.deepEqual([...result.run.treatmentPlan.patternBreaks.allowed], [])
  assert.equal(result.run.treatmentPlan.ctaPolicy.placement, 'at-observed-call')
  // the layout is the policy's: the fixture's source has no probed shape, so the whole frame stays over a backdrop
  assert.equal(result.run.editPlan.composition.layout, 'landscape-inset')
  assert.equal(policies.layout.rule, 'minimal-intervention')
})

test('ADR-160 F5: a source with the frame shape of every output is used as it is, and a source of another shape keeps the whole frame over a backdrop', async () => {
  const native = fixture()
  const ratio = native.repository.parent.state.document.entries[0].spec.output.aspectRatio
  const [w, h] = ratio.split(':').map(Number)
  native.repository.sourceDimensions = { width: w * 100, height: h * 100 }
  const same = await native.service(request({ idempotency: { key: 'director-f5-native' } }))
  assert.equal(same.run.policyResolution.policies.layout.value.mode, 'source-native')
  assert.equal(same.run.policyResolution.policies.layout.origin, 'output-spec')
  assert.equal(same.run.editPlan.composition.layout, 'source-native')
  assert.equal(same.run.editPlan.composition.background, 'none')
  assert.equal(same.run.decisions.find((decision) => decision.id === 'decision-layout-inset').choice, 'source-native-frame')
  const other = fixture()
  other.repository.sourceDimensions = { width: h * 100, height: w * 100 }
  const different = await other.service(request({ idempotency: { key: 'director-f5-other-shape' } }))
  assert.equal(different.run.policyResolution.policies.layout.value.mode, 'fit-with-backdrop')
  assert.equal(different.run.editPlan.composition.layout, 'landscape-inset')
  assert.equal(different.run.editPlan.composition.background, 'blurred-source')
})

test('ADR-160 F6 a briefing with text that no interpreter has read stops the Director: it is not planned over as an empty briefing', async () => {
  const unread = fixture({ ownerText: 'alpha beta gamma', unread: true })
  await assert.rejects(unread.service(request({ idempotency: { key: 'unread-briefing' } })), (error) =>
    error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && error.details.reason === 'brief-interpretation-required')
  assert.equal(unread.repository.lastBundle, undefined)
  // The same briefing, read, plans; an open question the reading raised stops it again, with the question in the error.
  const { readByInterpreter: read } = await import('./helpers/editorial-request-fixture.mjs')
  const asked = fixture({ ownerText: 'alpha beta gamma', editorialRequest: read('alpha beta gamma', {
    questions: [{ id: 'q1', status: 'open', question: 'Which of the two is meant?', excerpt: { start: 0, end: 5, text: 'alpha' } }],
  }) })
  await assert.rejects(asked.service(request({ idempotency: { key: 'open-question' } })), (error) =>
    error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && error.details.openQuestions[0].id === 'q1')
  assert.equal(asked.repository.lastBundle, undefined)
  const answered = fixture({ ownerText: 'alpha beta gamma', editorialRequest: read('alpha beta gamma', {
    questions: [{ id: 'q1', status: 'answered', answer: 'neither', question: 'Which of the two is meant?', excerpt: { start: 0, end: 5, text: 'alpha' } }],
  }) })
  await answered.service(request({ idempotency: { key: 'answered-question' } }))
  assert.ok(answered.repository.lastBundle)
})

test('ADR-160: the caption language of a project that declares none is the language detected in the speech, and the resolution says where it came from', async () => {
  const detected = fixture({ projectLocale: null, transcript: { id: 'transcript-1', sourceArtifactId: 'artifact-source3', language: 'pt', languageBasis: 'detected-from-media',
    provider: 'groq', model: 'whisper-large-v3', transcriptHash: 'b'.repeat(64) } })
  const result = await detected.service(request({ idempotency: { key: 'director-language-detected' } }))
  const language = result.run.policyResolution.policies.language
  assert.deepEqual(language.value, { captionLanguage: 'pt' })
  assert.equal(language.origin, 'media-context')
  assert.equal(language.rule, 'source-observation')
  assert.equal(result.run.policyResolution.openQuestions.some((item) => item.id === 'declared-language-differs-from-speech'), false)
  // the language the project declares is the requester's word: it is never recorded as observed in the media
  const declared = fixture({ transcript: { id: 'transcript-1', sourceArtifactId: 'artifact-source3', language: 'pt-BR', languageBasis: 'declared-not-verified',
    provider: 'groq', model: 'whisper-large-v3', transcriptHash: 'b'.repeat(64) } })
  const declaredLanguage = (await declared.service(request({ idempotency: { key: 'director-language-declared' } }))).run.policyResolution.policies.language
  assert.equal(declaredLanguage.origin, 'request-field')
  assert.match(declaredLanguage.reason, /not verified/)
})

test('ADR-160: a transcript whose language the provider could not tell is the undetermined language - the captions wait for the answer', async () => {
  const unknown = fixture({ projectLocale: null, transcript: { id: 'transcript-1', sourceArtifactId: 'artifact-source3', language: 'und', languageBasis: 'detected-from-media',
    provider: 'groq', model: 'whisper-large-v3', transcriptHash: 'b'.repeat(64) } })
  await assert.rejects(
    () => unknown.service(request({ idempotency: { key: 'director-language-undetermined' } })),
    (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && JSON.stringify(error.details).includes('caption-language-unknown'),
  )
})

test('a Director context that does not state the speech the project asked to remove is refused, never read as "nothing was asked"', async () => {
  const { repository, service } = fixture()
  const readContext = repository.readContext.bind(repository)
  repository.readContext = async (input) => {
    const { requestedSpeechRemovals: _omitted, ...context } = await readContext(input)
    return context
  }
  await assert.rejects(service(request()), (error) => error.code === 'PERSISTENCE_CONFLICT' && /asked to remove/.test(error.message))
  assert.equal(repository.lastBundle, undefined)
})
