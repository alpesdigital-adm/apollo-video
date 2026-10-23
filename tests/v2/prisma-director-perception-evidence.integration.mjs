import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { seedDirectorSnapshotWorld } from './helpers/director-snapshot-world.mjs'
import { actorFor } from './helpers/face-source-pg.mjs'
import { cancelProducerFenceCase } from './helpers/producer-publish-lock-race.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { calculateCanonicalHash, stableSerialize } = await import('../../src/v2/domain/canonical-hash.ts')
const { DomainError } = await import('../../src/v2/domain/errors.ts')
const { CONFIDENCE_BAND_POLICY_V2_SHA256 } = await import('../../src/v2/domain/decision-confidence.ts')
const { DIRECTOR_EVIDENCE_RUBRIC_SHA256, parseDecisionPerceptionEvidence, verifyDecisionEvidenceAgainstSnapshot } =
  await import('../../src/v2/domain/director-evidence-rubric.ts')
const { assertDirectorRunEvidenceConsistency, parseDirectorPerceptionEvidenceReport, verifyDirectorEvidenceReportAgainstSnapshot } =
  await import('../../src/v2/domain/director-perception-evidence.ts')
const { validateDirectorDecisions } = await import('../../src/v2/domain/director-run.ts')
const { parseDirectorDecisionLog } = await import('../../src/v2/domain/director-decision.ts')
const { serverPerceptionSnapshotId, verifyServerPerceptionSnapshot, assembleServerPerceptionSnapshot } = await import('../../src/v2/domain/server-perception-snapshot.ts')
const { timelineRangesOfSourceWindows } = await import('../../src/v2/application/director-face-window-requests.ts')
const { enqueueFaceSourceWindowRunAsAudit } = await import('../../src/v2/application/enqueue-face-source-window-run.ts')
const { putPerceptionTimelineService } = await import('../../src/v2/application/perception-timelines.ts')
const { PrismaFaceSourceWindowRequestContextRepository } = await import('../../src/v2/infrastructure/prisma/face-source-window-request-context-repository.ts')
const { PrismaPublicOperationRepository } = await import('../../src/v2/infrastructure/prisma/public-operation-repository.ts')
const { PrismaPerceptionTimelineRepository } = await import('../../src/v2/infrastructure/prisma/perception-timeline-repository.ts')
const { PrismaServerPerceptionEvidenceReader } = await import('../../src/v2/infrastructure/prisma/server-perception-evidence-reader.ts')
const { projectConfidenceUncertainties } = await import('../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts')

/**
 * W64 PostgreSQL proof that the Director plans on the persisted server perception snapshot with CONFIDENCE: the tiers it states
 * (high / partial / absent), the bands of its crop, caption and insert decisions, the rights it re-verifies where the run is born, the
 * face windows it asks for (idempotently, never waiting), and the evidence ids that resolve to real sealed rows. Written for the
 * supervised disposable cluster and the hosted perception job.
 *
 * The ORACLE reads only what is persisted - the DirectorRun row, its perception / quality-report snapshots, the decisions and the
 * decision log, the Command payload, the server perception snapshot row and the sealed envelopes - and re-derives every tier from the
 * stored snapshot. Nothing it checks is taken from the object the service returned.
 */
const ENVELOPE_TABLES = [
  ['v2ServerPerceptionSnapshot', 'snapshot'], ['v2PerceptionProducerEnvelope', 'ocr'], ['v2TemporalProducerEnvelope', 'temporal'],
  ['v2FaceSourceWindowEnvelope', 'face'], ['v2MediaTranscript', 'transcript'], ['v2AssetRightsSnapshot', 'rights'],
]

async function resolveEvidenceId(db, id) {
  for (const [model, kind] of ENVELOPE_TABLES) if (await db[model].findUnique({ where: { id }, select: { id: true } })) return kind
  return null
}

function realRequester(db) {
  const enqueue = enqueueFaceSourceWindowRunAsAudit({
    context: new PrismaFaceSourceWindowRequestContextRepository(db), operations: new PrismaPublicOperationRepository(db),
    createOperationId: () => `w64-face-operation-${randomUUID()}`,
  })
  const requester = {
    keys: [],
    async request(input) {
      requester.keys.push(input.idempotencyKey)
      const result = await enqueue({ workspaceId: input.workspaceId, projectId: input.projectId, sourceArtifactId: input.sourceArtifactId,
        window: input.window, audit: input.authenticationAudit, idempotencyKey: input.idempotencyKey })
      return { operationId: result.operation.id, replayed: result.replayed }
    },
  }
  return requester
}

/** The persisted run, read back and re-derived. Returns what the assertions of each scenario then read. */
async function oracle(db, { workspaceId, projectId, runId }) {
  const row = await db.v2DirectorRun.findUniqueOrThrow({ where: { id: runId }, include: { perceptionSnapshot: true, qualitySnapshot: true, policySnapshot: true, command: true } })
  assert.equal(row.workspaceId, workspaceId)
  const perception = JSON.parse(row.perceptionSnapshot.contentJson)
  const quality = JSON.parse(row.qualitySnapshot.contentJson)
  const decisions = JSON.parse(row.decisionsJson)
  // the Command and the run agree on the rows that hold the plan
  const payload = JSON.parse(row.command.payloadJson)
  assert.equal(payload.snapshotRefs.perception, row.perceptionSnapshotId)
  assert.equal(payload.snapshotRefs.quality, row.qualitySnapshotId)
  assert.equal(row.qualitySnapshot.schemaVersion, 5)
  assert.equal(quality.schemaVersion, 'director-quality-report/v5')
  // ADR-160: the run names the request it answers and seals the resolution it was judged against, in the very rows the report names
  assert.equal(row.requestHash, quality.requestHash)
  assert.equal(row.policySnapshot.kind, 'policy-resolution')
  assert.equal(JSON.parse(row.policySnapshot.contentJson).policyResolutionHash, quality.policyResolutionHash)
  assert.equal(calculateCanonicalHash(quality), row.qualitySnapshot.contentHash)
  const report = parseDirectorPerceptionEvidenceReport(quality.perceptionEvidence)
  assert.equal(report.policy.bandPolicy.policyHash, CONFIDENCE_BAND_POLICY_V2_SHA256)
  assert.equal(report.policy.rubric.rubricHash, DIRECTOR_EVIDENCE_RUBRIC_SHA256)
  assert.ok(decisions.every((decision) => decision.bandPolicy.policyHash === CONFIDENCE_BAND_POLICY_V2_SHA256), 'every decision names the policy that graded it')
  validateDirectorDecisions(decisions) // the strict re-read: tier, band, seal and the snapshot named as evidence

  // the snapshot row the run names: stored, re-verified, the very bytes the perception was assembled from
  const snapshotRow = await db.v2ServerPerceptionSnapshot.findFirstOrThrow({
    where: { workspaceId, projectId, projectVersionId: row.baseVersionId, snapshotHash: perception.serverSnapshot.snapshotHash }, include: { coverage: true } })
  assert.equal(snapshotRow.id, report.snapshot.id)
  assert.equal(snapshotRow.id, serverPerceptionSnapshotId(snapshotRow.snapshotHash))
  const snapshot = verifyServerPerceptionSnapshot(JSON.parse(snapshotRow.snapshotJson))
  assert.equal(stableSerialize(snapshot.timeline), stableSerialize(perception.timeline), 'the run\'s timeline IS the stored snapshot\'s')
  assert.equal(snapshotRow.coverage.length, 9)
  for (const entry of report.coverage) {
    const stored = snapshotRow.coverage.find((item) => item.kind === entry.kind)
    assert.deepEqual([stored.state, stored.observedMs, stored.reasonCode], [entry.state, entry.examinedMs, entry.reasonCode], `${entry.kind}: report vs coverage row`)
  }
  assertDirectorRunEvidenceConsistency({ evidence: report, baseVersionId: row.baseVersionId, perception, decisions })

  // the face windows the run asked for are operations that exist, as the actor of the run
  const entries = report.faceWindows.entries
  for (const entry of entries.filter((item) => item.state === 'requested')) {
    const operation = await db.v2PublicOperation.findUniqueOrThrow({ where: { id: entry.operationId } })
    assert.equal(operation.type, 'perception-face-run')
    assert.equal(operation.workspaceId, workspaceId)
    assert.equal(operation.projectId, projectId)
    assert.equal(operation.clientId, row.initiatedById, 'asked as the actor of the run')
  }
  const version = await db.v2ProjectVersion.findUniqueOrThrow({ where: { id: row.baseVersionId }, include: { editPlanSnapshot: true } })
  const plan = JSON.parse(version.editPlanSnapshot.contentJson)
  const clips = plan.videoTracks.flatMap((track) => track.clips)
  const rangesOf = (state) => timelineRangesOfSourceWindows({ fps: plan.fps, durationFrames: plan.durationFrames, clips,
    windows: entries.filter((item) => item.state === state) })
  const faceRequests = { pendingRangesMs: rangesOf('requested'), failedRangesMs: rangesOf('refused') }

  // every tier of the report, and of every gated decision, is what the stored snapshot supports
  verifyDirectorEvidenceReportAgainstSnapshot(report, snapshot, faceRequests)
  const gated = decisions.filter((decision) => decision.perceptionEvidence)
  assert.deepEqual(gated.map((decision) => decision.id).toSorted(), ['decision-insert-selection', 'decision-layout-inset', 'decision-subtitle-bottom'])
  const logRow = parseDirectorDecisionLog(JSON.parse(row.decisionLogJson))
  for (const decision of gated) {
    const evidence = parseDecisionPerceptionEvidence(decision.perceptionEvidence)
    const inserted = decision.choice === 'use_selected_insert'
    verifyDecisionEvidenceAgainstSnapshot(evidence, snapshot, { snapshotId: snapshotRow.id, inserted, faceRequests })
    // evidence ids: the snapshot, and every envelope it names, resolve to real sealed rows of the right table
    assert.ok(decision.evidenceRefs.includes(snapshotRow.id))
    assert.equal(await resolveEvidenceId(db, evidence.snapshot.id), 'snapshot')
    const tableOf = { 'transcript-word': 'transcript', ocr: 'ocr', shot: 'temporal', motion: 'temporal', face: 'face', rights: 'rights' }
    for (const modality of evidence.modalities) {
      for (const id of modality.envelopeIds) assert.equal(await resolveEvidenceId(db, id), tableOf[modality.modality], `${decision.id}/${modality.modality}: ${id}`)
      const ids = new Set(snapshot.timeline.observations.map((item) => item.id))
      for (const id of modality.observationIds) assert.ok(ids.has(id), `${decision.id}/${modality.modality}: observation ${id} is in the snapshot`)
    }
    // the decision log carries the same snapshot id as evidence, and is sealed
    const logged = logRow.entries.find((entry) => entry.id === decision.id)
    assert.ok(logged.evidence.some((item) => item.ref === snapshotRow.id), `${decision.id}: the decision log names the snapshot`)
    // the critic's digest is the decision's
    const digest = report.decisions.find((entry) => entry.decisionId === decision.id)
    assert.deepEqual([digest.tier, digest.band, digest.evidenceHash], [decision.perceptionEvidence.tier, decision.confidenceBand, decision.perceptionEvidence.evidenceHash])
  }
  return { row, perception, quality, report, decisions, snapshot, snapshotRow, entries, faceRequests }
}

const decisionOf = (decisions, id) => decisions.find((decision) => decision.id === id)
const modalityOf = (decision, modality) => decision.perceptionEvidence.modalities.find((item) => item.modality === modality)
const operationCount = (db, workspaceId, type) => db.v2PublicOperation.count({ where: { workspaceId, type } })

test('W64 PostgreSQL Director: complete OCR and partial face give PARTIAL decisions that are review - face is never high - and every id resolves; a replay is the same stored result',
  { skip: !process.env.V2_DATABASE_URL, timeout: 600_000 }, async () => {
    const db = new PrismaClient()
    let primaryError
    try {
      const { workspaceId, world, built, director, service, request, rowsBefore, publicSnapshot } = await seedDirectorSnapshotWorld(db, { uniqueVariant: true, aspectRatio: '4:5' })
      const requester = realRequester(db)
      const faceOperations = await operationCount(db, workspaceId, 'perception-face-run')
      assert.ok(faceOperations >= 2, 'the world published its own windows')

      const first = await service(director, { faceWindows: requester })(request(`w64-run-a-${world.suffix}`))
      const stored = await oracle(db, { workspaceId, projectId: world.projectId, runId: first.run.id })
      // the windows the plan needs are sealed already: nothing is asked for
      assert.deepEqual([stored.report.faceWindows.requiredCount, stored.report.faceWindows.satisfiedCount, stored.report.faceWindows.requestedCount], [1, 1, 0])
      assert.equal(await operationCount(db, workspaceId, 'perception-face-run'), faceOperations)
      assert.deepEqual(requester.keys, [])

      // tiers: OCR is densely examined at a measured confidence above the floor - HIGH; face is dense and still PARTIAL (its ceiling);
      // the transcript's confidence is a prior - PARTIAL; so crop and caption are partial and never auto-apply
      const ocr = stored.report.modalities.find((item) => item.modality === 'ocr')
      assert.deepEqual([ocr.tier, ocr.reasonCode, ocr.confidenceBasis], ['high', 'SEALED_DENSE_COVERAGE', 'producer-reported'])
      const face = stored.report.modalities.find((item) => item.modality === 'face')
      assert.deepEqual([face.tier, face.reasonCode, face.ceilingApplied, face.denseMs === face.rangeMs], ['partial', 'FACE_DETECTOR_NOT_DEPLOYABLE', true, true])
      assert.ok(face.envelopeCount >= 2 && face.observationCount > 0)
      const crop = decisionOf(stored.decisions, 'decision-layout-inset')
      const caption = decisionOf(stored.decisions, 'decision-subtitle-bottom')
      const insert = decisionOf(stored.decisions, 'decision-insert-selection')
      assert.deepEqual([crop.decisionType, crop.perceptionEvidence.tier, crop.confidenceBand], ['crop', 'partial', 'review'])
      assert.deepEqual([caption.decisionType, caption.perceptionEvidence.tier, caption.confidenceBand], ['caption', 'partial', 'review'])
      assert.deepEqual(caption.perceptionEvidence.modalities.map((item) => [item.modality, item.tier]), [['transcript-word', 'partial'], ['face', 'partial'], ['ocr', 'high']])
      assert.deepEqual([insert.decisionType, insert.perceptionEvidence.tier, insert.confidenceBand], ['insert', 'high', 'auto-apply'])
      assert.equal(stored.perception.summary.confidence, 0.82, 'the summary prior is untouched (open item): no decision reads it any more')
      // the critic: face is the partial, unverified warning (not the "unavailable" one), still never approved, face safety unknown
      assert.equal(stored.quality.status, 'review-required')
      assert.deepEqual(stored.quality.faceSafety, { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] })
      assert.equal(stored.quality.hardChecks.find((check) => check.id === 'subtitlesFaceSafe'), undefined, 'face safety is claimed by nobody: no check of the v5 list says it, the faceSafety object does')
      const codes = stored.quality.issues.map((issue) => issue.code)
      assert.ok(codes.includes('FACE_EVIDENCE_PARTIAL_REVIEW_REQUIRED') && !codes.includes('FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED'))
      assert.equal(stored.quality.issues.filter((issue) => issue.severity === 'hard').length, 0)
      // the editor's uncertainty projection reads policy v2 as the stored decisions say it
      assert.deepEqual(projectConfidenceUncertainties(stored.decisions).map((item) => [item.id, item.type, item.band]).toSorted(),
        [['decision-layout-inset', 'crop', 'review'], ['decision-subtitle-bottom', 'caption', 'review']])

      // snapshots: the one the run directed (written in its commit) and the one of the Version it created (after the commit)
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId } }), 2)
      const result = await publicSnapshot({ workspaceId, projectId: world.projectId })
      assert.equal(result.projectVersionId, first.version.id, 'the read is read-only and finds the head the run materialized')
      const readBack = await director.readQualityReport({ workspaceId, projectId: world.projectId, directorRunId: first.run.id })
      assert.equal(readBack.report.perceptionEvidence.evidenceHash, stored.report.evidenceHash)

      // (f) replay: the same request returns the same stored result and writes nothing
      const before = await rowsBefore()
      const replay = await service(director, { faceWindows: requester })(request(`w64-run-a-${world.suffix}`))
      assert.equal(replay.replayed, true)
      assert.equal(stableSerialize(replay.run), stableSerialize(first.run))
      assert.deepEqual(await rowsBefore(), before)
      assert.deepEqual(requester.keys, [])

      // (e) a stale version is refused with the existing conflict code before anything is asked for or written
      await assert.rejects(service(director, { faceWindows: requester })(request(`w64-run-stale-${world.suffix}`)),
        (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT')
      await assert.rejects(service(director, { faceWindows: requester })(request(`w64-run-stale-hash-${world.suffix}`, { versionId: first.version.id, baseHash: 'f'.repeat(64) })),
        (error) => error instanceof DomainError && error.code === 'VERSION_CONFLICT')
      assert.deepEqual(await rowsBefore(), before)
      assert.deepEqual(requester.keys, [])
      void built
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })

test('W64 PostgreSQL Director: with no perception at all the plan is review, face windows are requested once and never waited for, and rights revoked before the commit refuse the run',
  { skip: !process.env.V2_DATABASE_URL, timeout: 600_000 }, async () => {
    const db = new PrismaClient()
    let primaryError
    try {
      const { workspaceId, world, director, service, request, rowsBefore } = await seedDirectorSnapshotWorld(db, { uniqueVariant: true, aspectRatio: '1:1', evidence: false })
      const requester = realRequester(db)
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId } }), 0)
      assert.equal(await operationCount(db, workspaceId, 'perception-face-run'), 0)

      // (g) the first attempt asks for the windows and is then refused at commit; nothing of the run exists
      const racing = Object.create(director)
      racing.commitWithCanonicalSnapshots = async () => { throw new DomainError('PERSISTENCE_CONFLICT', 'raced before commit') }
      const before = await rowsBefore()
      await assert.rejects(service(racing, { faceWindows: requester })(request(`w64-run-b1-${world.suffix}`)), (error) => error.code === 'PERSISTENCE_CONFLICT')
      assert.deepEqual(await rowsBefore(), before)
      const operations = await db.v2PublicOperation.findMany({ where: { workspaceId, type: 'perception-face-run' } })
      assert.equal(operations.length, 1, 'the source needs one window of 120 frames')
      assert.equal(operations[0].status, 'queued', 'asked for, not waited for')

      // the second attempt (another idempotency key, the same plan) is the same operation, not a second one
      const run = await service(director, { faceWindows: requester })(request(`w64-run-b2-${world.suffix}`))
      assert.equal(await operationCount(db, workspaceId, 'perception-face-run'), 1)
      assert.equal(requester.keys.length, 2)
      assert.equal(requester.keys[0], requester.keys[1], 'a key that is a pure function of version, source and window')
      const stored = await oracle(db, { workspaceId, projectId: world.projectId, runId: run.run.id })
      assert.deepEqual(stored.entries.map((entry) => [entry.state, entry.operationId, entry.replayed, entry.startSourceFrame, entry.endSourceFrame]), [['requested', operations[0].id, true, 0, 120]])
      assert.equal(stored.entries[0].idempotencyKey, requester.keys[0])

      // (b) nothing examined: absent everywhere but the words, review for the draft types, auto-apply only for the insert nobody proposed
      assert.deepEqual(stored.report.coverage.map((entry) => [entry.kind, entry.state]), [
        ['transcript-word', 'partial'], ['speaker', 'absent'], ['silence', 'absent'], ['face', 'absent'], ['object', 'absent'],
        ['shot', 'absent'], ['motion', 'absent'], ['ocr', 'absent'], ['image-insert', 'absent']])
      const face = stored.report.modalities.find((item) => item.modality === 'face')
      assert.deepEqual([face.tier, face.reasonCode, face.pendingMs], ['absent', 'FACE_EVIDENCE_PENDING', face.rangeMs], 'requested and not sealed is pending, not "absent for no reason"')
      const crop = decisionOf(stored.decisions, 'decision-layout-inset')
      const caption = decisionOf(stored.decisions, 'decision-subtitle-bottom')
      assert.deepEqual([crop.perceptionEvidence.tier, crop.confidenceBand], ['absent', 'review'])
      assert.deepEqual([caption.perceptionEvidence.tier, caption.confidenceBand], ['absent', 'review'])
      assert.deepEqual(modalityOf(caption, 'ocr').reasonCode, 'NO_PRODUCER_RUN')
      assert.notEqual(decisionOf(stored.decisions, 'decision-insert-selection').confidenceBand, 'block')
      for (const decision of [crop, caption]) assert.notEqual(decision.confidenceBand, 'auto-apply', 'absent evidence is never auto-applied')
      assert.deepEqual(stored.quality.faceSafety, { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] })
      assert.ok(stored.quality.issues.some((issue) => issue.code === 'FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED'))
      assert.equal(stored.quality.status, 'review-required')
      // The operations the Director queued are real work for a real worker. Nobody here runs it, and the face worker of a later suite claims the OLDEST
      // queued window of the cluster, so the queue is left as it was found: they are canceled through the product's own cancellation.
      for (const operation of operations) await cancelProducerFenceCase(db, new PrismaPublicOperationRepository(db), world, actorFor(world), operation.id, 'w64-cancel')
      assert.equal(await db.v2PublicOperation.count({ where: { workspaceId, type: 'perception-face-run', status: 'queued' } }), 0)
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })

test('W64 PostgreSQL Director: rights revoked between claim and commit refuse the run with no trace, on a source no producer envelope guards; re-approved, the next attempt commits',
  { skip: !process.env.V2_DATABASE_URL, timeout: 600_000 }, async () => {
    const db = new PrismaClient()
    let primaryError
    try {
      const { workspaceId, world, director, service, request, rowsBefore } = await seedDirectorSnapshotWorld(db, { uniqueVariant: true, aspectRatio: '21:9', evidence: false })
      const racing = Object.create(director)
      racing.commitWithCanonicalSnapshots = async (scope, prepare) => {
        await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
        return director.commitWithCanonicalSnapshots(scope, prepare)
      }
      const before = await rowsBefore()
      await assert.rejects(service(racing)(request(`w64-run-c1-${world.suffix}`)), (error) => error instanceof DomainError && error.code === 'ASSET_RIGHTS_BLOCKED' &&
        // refused by the Director's own commit-time re-verification (every source of the plan), not by a guard further down the commit
        /no longer has certain rights/.test(error.message) && error.details.artifactId === world.sourceId && error.details.reasonCode === 'RIGHTS_UNKNOWN')
      assert.deepEqual(await rowsBefore(), before, 'a refused run writes no Version, run, Command, snapshot or perception row')
      // unknown rights at claim are a block too: the critic refuses the plan before any commit is attempted
      await assert.rejects(service(director)(request(`w64-run-c2-${world.suffix}`)), (error) => error.code === 'INVALID_RENDER_INPUT' && error.details.gateFailures.includes('rights-compliance') &&
        error.details.uncertainRights.length === 1 && /RIGHTS_UNKNOWN/.test(error.details.uncertainRights[0]))
      assert.deepEqual(await rowsBefore(), before)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: world.rightsId, rightsRevision: 3 } })
      const run = await service(director)(request(`w64-run-c3-${world.suffix}`))
      const stored = await oracle(db, { workspaceId, projectId: world.projectId, runId: run.run.id })
      assert.equal(stored.report.rights.certain, true)
      assert.deepEqual(stored.report.rights.sources.map((source) => [source.artifactId, source.certain, source.snapshotId]), [[world.sourceId, true, world.rightsId]])
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })

test('W64 PostgreSQL Director: low confidence evidence is partial and review, and a caller\'s manual perception timeline changes nothing',
  { skip: !process.env.V2_DATABASE_URL, timeout: 600_000 }, async () => {
    const db = new PrismaClient()
    let primaryError
    try {
      const { workspaceId, world, actor, director, service, request, ensureSnapshot } = await seedDirectorSnapshotWorld(db, {
        uniqueVariant: true, aspectRatio: '16:9', ocrConfidence: 0.2, faceRows: [[0.3, 0.2, 0.1, 0.4, 0.6]] })
      // the snapshot of the input Version as the sealed evidence makes it, before anyone writes a timeline of their own
      const sealedOnly = (await ensureSnapshot({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId })).record.snapshot
      // a caller's manual timeline that claims complete, perfect face coverage of the whole Version
      const durationMs = sealedOnly.timeline.durationMs
      const manual = await putPerceptionTimelineService({ repository: new PrismaPerceptionTimelineRepository(db), clock: () => new Date(), createId: () => randomUUID() })({
        workspaceId, projectId: world.projectId, projectVersionId: world.versionId, baseRevision: null, durationMs, idempotencyKey: `w64-manual-${world.suffix}`, actor,
        observations: [{ id: 'manual-face-everywhere', kind: 'face', startMs: 0, endMs: durationMs, value: { box: [0, 0, 1, 1] }, provenance: { source: 'caller', model: 'manual', version: '1', confidence: 1 } }],
        coverage: ['transcript-word', 'speaker', 'silence', 'face', 'object', 'shot', 'motion', 'ocr', 'image-insert']
          .map((kind) => ({ kind, ranges: kind === 'face' ? [[0, durationMs]] : [] })),
      })
      assert.ok(manual)
      assert.ok(await db.v2PerceptionTimeline.count({ where: { workspaceId, projectId: world.projectId } }) >= 1, 'the caller\'s timeline is stored')

      const run = await service(director)(request(`w64-run-d-${world.suffix}`))
      const stored = await oracle(db, { workspaceId, projectId: world.projectId, runId: run.run.id })
      // the manual timeline is a different record: the Director's snapshot is exactly the sealed-evidence one
      assert.equal(stored.perception.serverSnapshot.snapshotHash, sealedOnly.snapshotHash)
      assert.ok(!stored.snapshot.timeline.observations.some((item) => item.id === 'manual-face-everywhere' || item.provenance.source === 'caller'))
      const reassembled = assembleServerPerceptionSnapshot(await new PrismaServerPerceptionEvidenceReader(db).readForVersion({
        workspaceId, projectId: world.projectId, projectVersionId: world.versionId, now: new Date() }))
      assert.equal(reassembled.snapshotHash, sealedOnly.snapshotHash)
      // low confidence: OCR is examined densely but its measured confidence is under the floor; face stays capped
      const ocr = stored.report.modalities.find((item) => item.modality === 'ocr')
      assert.deepEqual([ocr.tier, ocr.reasonCode, ocr.confidence], ['partial', 'BELOW_CONFIDENCE_FLOOR', 0.2])
      const face = stored.report.modalities.find((item) => item.modality === 'face')
      assert.deepEqual([face.tier, face.confidence < 0.5], ['partial', true])
      const caption = decisionOf(stored.decisions, 'decision-subtitle-bottom')
      assert.deepEqual([caption.perceptionEvidence.tier, caption.confidenceBand], ['partial', 'review'])
      assert.equal(modalityOf(caption, 'ocr').reasonCode, 'BELOW_CONFIDENCE_FLOOR')
      assert.equal(decisionOf(stored.decisions, 'decision-layout-inset').confidenceBand, 'review')
      assert.equal(stored.quality.faceSafety.status, 'unknown')
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })
