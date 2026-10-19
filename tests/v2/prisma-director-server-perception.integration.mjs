import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { sha } from './helpers/perception-snapshot-fixtures.mjs'
import { commitSealedChild, planPlayingRecordings } from './helpers/pg-output-world.mjs'
import { seedDirectorOcrWorld } from './helpers/s3c-director-ocr-world.mjs'
import { FACE_ROWS, produceSnapshotEvidence } from './helpers/server-perception-pg-world.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
const { runProjectDirectorService } = await import('../../src/v2/application/run-project-director.ts')
const { readServerPerceptionSnapshotService } = await import('../../src/v2/application/server-perception-snapshots.ts')
const { stableSerialize } = await import('../../src/v2/domain/canonical-hash.ts')
const { createMediaTranscript } = await import('../../src/v2/domain/media-transcript.ts')
const { createEvidenceBoundBriefCompiler } = await import('../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts')
const { PrismaDirectorRunRepository } = await import('../../src/v2/infrastructure/prisma/director-run-repository.ts')
const { PrismaServerPerceptionEvidenceReader } = await import('../../src/v2/infrastructure/prisma/server-perception-evidence-reader.ts')
const { PrismaServerPerceptionSnapshotRepository } = await import('../../src/v2/infrastructure/prisma/server-perception-snapshot-repository.ts')

/**
 * W63a PostgreSQL proof that the Director's perception IS the server perception snapshot (written for the supervised disposable
 * cluster; not run in hosted CI). The OCR, temporal and source-keyed face evidence is written by the products' own writers over the
 * Director world of the OCR suite (a real transcript row, the plan retimed from it, a sealed input Version); the analyzers are
 * stand-ins in what they look at only.
 *
 * It must establish: the Director and the public snapshot hold the same bytes (the run's timeline is the stored snapshot's, and
 * it names it by hash); the Director writes that snapshot once, in its own commit; evidence that moves between its read and its
 * commit refuses the run and leaves nothing behind; what the Director decides is what it decided before (face safety unknown,
 * review required); and the stored run reads back through the strict parser.
 */
test('W63a PostgreSQL Director: its perception is the server snapshot, written once by its commit, refused when the evidence moves',
  { skip: !process.env.V2_DATABASE_URL, timeout: 480_000 }, async () => {
    const db = new PrismaClient()
    let primaryError
    try {
      const suffix = randomUUID().slice(0, 8)
      const workspaceId = `w61-admission-${suffix}`
      const world = await seedDirectorOcrWorld(db, { suffix, artifactKey: `${workspaceId}/source.mp4`, sourceSha256: sha('a'), byteSize: 1024n })
      const manifestId = `w63a-manifest-${suffix}`
      await db.v2MediaArtifactManifest.create({ data: { id: manifestId, workspaceId, artifactId: world.sourceId,
        schemaVersion: 'media-artifact-manifest/v2', manifestHash: sha('b'), recipeId: 'w63a-controlled-source', recipeVersion: '1.0.0',
        parametersHash: sha('c'), manifestJson: stableSerialize({ artifact: { artifactKey: world.artifactKey }, probe: { width: 640, height: 360, duration: 4, fps: 30 } }) } })
      const transcriptId = `w63a-transcript-${suffix}`
      const transcript = createMediaTranscript({ language: 'pt-BR', text: 'Bem vindo ao Apollo', provider: 'groq', model: 'whisper-large-v3',
        words: [{ word: 'Bem', start: 0.2, end: 0.5 }, { word: 'vindo', start: 0.5, end: 0.9 }, { word: 'ao', start: 0.9, end: 1.1 }, { word: 'Apollo', start: 1.1, end: 1.7 }],
        segments: [{ id: 0, start: 0.2, end: 1.7, text: 'Bem vindo ao Apollo' }] })
      await db.v2MediaTranscript.create({ data: { id: transcriptId, workspaceId, projectId: world.projectId, sourceArtifactId: world.sourceId,
        sourceManifestId: manifestId, schemaVersion: transcript.schemaVersion, language: transcript.language, provider: transcript.provider,
        model: transcript.model, providerVersion: 'controlled-v1', transcriptHash: transcript.transcriptHash, transcriptJson: stableSerialize(transcript) } })
      const inputPlanOf = (playing) => ({ ...playing, sources: [{ id: world.sourceId, artifactId: world.sourceId, kind: 'video', durationSeconds: 4 }],
        overlayTracks: [], subtitleTracks: [], audioTracks: [], effectTracks: [], markers: [], transitions: [], protectedElements: [],
        localeVariantRefs: [], formatVariantRefs: [], lineageRefs: [world.sourceId],
        editorial: { commandType: 'remove-spoken-content', exclusions: [], retainedSourceRanges: [{ sourceStartSeconds: 0, sourceEndSeconds: 4 }] },
        subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
        retimedTranscript: { sourceTranscriptId: transcriptId, sourceTranscriptHash: transcript.transcriptHash,
          words: [{ text: 'Bem', sourceStartSeconds: 0.2, sourceEndSeconds: 0.5, timelineStartFrame: 6, timelineEndFrame: 15 },
            { text: 'vindo', sourceStartSeconds: 0.5, sourceEndSeconds: 0.9, timelineStartFrame: 15, timelineEndFrame: 27 },
            { text: 'ao', sourceStartSeconds: 0.9, sourceEndSeconds: 1.1, timelineStartFrame: 27, timelineEndFrame: 33 },
            { text: 'Apollo', sourceStartSeconds: 1.1, sourceEndSeconds: 1.7, timelineStartFrame: 33, timelineEndFrame: 51 }] },
        createdAt: new Date().toISOString() })
      const inputHead = await commitSealedChild(db, { workspaceId, projectId: world.projectId, actor: world.actor, suffix: `w63a-${suffix}-input`,
        adopt: [world.sourceId], mutatePlan: (parentPlan) => inputPlanOf(planPlayingRecordings([world.recording])(parentPlan)) })
      world.head = inputHead
      world.versionId = inputHead.version.id
      world.editId = inputHead.editPlanSnapshot.id
      const evidenceWorld = { ...world, suffix, sourceSha256: sha('a'), actor: world.actor }
      const built = await produceSnapshotEvidence(db, evidenceWorld)
      const director = new PrismaDirectorRunRepository(db)
      const snapshots = new PrismaServerPerceptionSnapshotRepository(db)
      const publicSnapshot = readServerPerceptionSnapshotService({ evidence: new PrismaServerPerceptionEvidenceReader(db), snapshots, clock: () => new Date() })
      const actorContext = createExternalAuditContext({ clientId: world.clientId, credentialId: `w61-credential-${suffix}`, workspaceId, environment: 'production' })
      const actor = { ...actorContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false,
        workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext: actorContext }

      // the Director's context carries the same evidence the public snapshot is made of
      const context = await director.readContext({ workspaceId, projectId: world.projectId })
      assert.equal(context.currentVersion.id, world.versionId)
      assert.equal(context.ocrEnvelope.envelopeHash, built.stats.ocr.envelopeHash)
      assert.deepEqual(context.perceptionEvidence.temporal.map((envelope) => envelope.envelopeHash), [built.stats.temporal.envelopeHash])
      assert.equal(context.perceptionEvidence.faceWindows.length, 2)
      assert.equal(context.perceptionEvidence.editPlan.snapshotHash.length, 64)
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId } }), 0, 'reading the context writes nothing')

      const counters = new Map()
      const service = (repository) => runProjectDirectorService({ repository, clock: () => new Date(), createEventId: randomUUID,
        createId: (kind) => `${kind}-w63a-${suffix}-${counters.set(kind, (counters.get(kind) ?? 0) + 1).get(kind)}`,
        compileBrief: createEvidenceBoundBriefCompiler() })
      const request = (key) => ({ workspaceId, projectId: world.projectId, baseVersionId: world.versionId, baseHash: world.head.version.baseHash, actor,
        idempotency: { key }, reason: 'Plan with the server perception snapshot as evidence input only.' })
      const rowsBefore = async () => ({
        versions: await db.v2ProjectVersion.count({ where: { projectId: world.projectId } }),
        runs: await db.v2DirectorRun.count({ where: { projectId: world.projectId } }),
        commands: await db.v2EditCommand.count({ where: { projectId: world.projectId } }),
        snapshots: await db.v2ProjectSnapshot.count({ where: { projectId: world.projectId } }),
        perception: await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId } }),
      })

      // evidence that moves between the Director's read and its commit refuses the run and leaves nothing behind
      const before = await rowsBefore()
      const racing = Object.create(director)
      racing.commitWithCanonicalSnapshots = async (scope, prepare) => {
        await built.faces.publish('w63a-late', { startSourceFrame: 30, endSourceFrame: 90 }, (frame) => (frame % 10 === 0 ? FACE_ROWS : []))
        return director.commitWithCanonicalSnapshots(scope, prepare)
      }
      await assert.rejects(service(racing)(request(`w63a-stale-${suffix}`)),
        (error) => error?.code === 'PERSISTENCE_CONFLICT' && /evidence changed before commit/i.test(error.message))
      assert.deepEqual(await rowsBefore(), before, 'a refused run writes no Version, run, Command, snapshot or perception row')

      // the next run reads the evidence as it now is, and commits
      const directed = await service(director)(request(`w63a-director-${suffix}`))
      const perception = directed.run.perception
      assert.equal(perception.schemaVersion, 2)
      assert.equal(perception.inputVersionId, world.versionId)
      assert.equal(perception.serverSnapshot.schemaVersion, 'server-perception-snapshot/v1')
      assert.equal(perception.ocrEvidence.envelopeHash, built.stats.ocr.envelopeHash)
      // decisions are what they were: the new evidence kinds decide nothing, face safety stays unknown
      assert.equal(directed.run.qualityReport.status, 'review-required')
      assert.equal(directed.run.qualityReport.faceSafety.status, 'unknown')
      assert.equal(directed.run.qualityReport.hardChecks.subtitlesFaceSafe, false)
      assert.equal(perception.summary.confidence, 0.82)
      assert.equal(perception.summary.faceCoverage, 'partial')
      assert.equal(perception.summary.visualCoverage, 'partial')

      // the Director wrote the snapshot, once, in its commit; the public read finds the same bytes
      const stored = await db.v2ServerPerceptionSnapshot.findMany({ where: { workspaceId }, include: { coverage: true } })
      assert.equal(stored.length, 1)
      assert.equal(stored[0].snapshotHash, perception.serverSnapshot.snapshotHash)
      assert.equal(stored[0].projectVersionId, world.versionId)
      assert.equal(stored[0].coverage.length, 9)
      const created = stored[0].createdAt.toISOString()
      const api = await publicSnapshot({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId })
      assert.equal(api.id, stored[0].id)
      assert.equal(api.snapshot.snapshotHash, perception.serverSnapshot.snapshotHash)
      assert.equal(api.createdAt, created, 'the API found the Director\'s row; it wrote nothing')
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId } }), 1)
      const record = await snapshots.findByHash({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
        snapshotHash: perception.serverSnapshot.snapshotHash })
      assert.equal(stableSerialize(perception.timeline), stableSerialize(record.snapshot.timeline), 'the run\'s timeline IS the snapshot\'s')
      assert.equal(perception.timeline.timelineHash, api.snapshot.timelineHash)
      for (const kind of ['transcript-word', 'ocr', 'shot', 'motion', 'face']) {
        assert.ok(perception.timeline.observations.some((item) => item.kind === kind), kind)
      }
      assert.equal(perception.timeline.coverage.find((entry) => entry.kind === 'object').reasonCode, 'NO_VERIFIED_DETECTOR')
      assert.equal(perception.timeline.coverage.find((entry) => entry.kind === 'object').state, 'absent')
      // the late face window is among the inputs the snapshot lists
      assert.equal(record.snapshot.inputs.filter((input) => input.kind === 'face').length, 3)

      // the stored run reads back through the strict parser (replay of the same request)
      const replay = await service(director)(request(`w63a-director-${suffix}`))
      assert.equal(replay.replayed, true)
      assert.equal(stableSerialize(replay.run.perception), stableSerialize(perception))
      const quality = await director.readQualityReport({ workspaceId, projectId: world.projectId, directorRunId: directed.run.id })
      assert.equal(quality.report.faceSafety.status, 'unknown')

      // the head moved: the older Version keeps exactly the evidence and snapshot the run was made from
      const older = await publicSnapshot({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId })
      assert.equal(older.snapshot.snapshotHash, perception.serverSnapshot.snapshotHash)
      const head = await publicSnapshot({ workspaceId, projectId: world.projectId })
      assert.equal(head.projectVersionId, directed.version.id)
      assert.equal(head.result.coverage.find((entry) => entry.kind === 'ocr').reasonCode, 'NO_PRODUCER_RUN')
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })
