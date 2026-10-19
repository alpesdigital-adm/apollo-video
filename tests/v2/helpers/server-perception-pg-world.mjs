import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { digest, sha, temporalAnalysis } from './perception-snapshot-fixtures.mjs'
import { actorFor, sourceMaterializer, sourceWindowHarness } from './face-source-pg.mjs'
import { seedPerceptionProducerContext } from './perception-producer-pg-world.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { createExternalAuditContext } = await import('../../../src/v2/application/authenticate-api-client.ts')
const { enqueuePerceptionProducerRunService } = await import('../../../src/v2/application/enqueue-perception-producer-run.ts')
const { enqueueTemporalProducerRunService } = await import('../../../src/v2/application/enqueue-temporal-producer-run.ts')
const { runNextPerceptionProducerOperationService } = await import('../../../src/v2/application/run-perception-producer-worker.ts')
const { runNextTemporalProducerOperationService } = await import('../../../src/v2/application/run-temporal-producer-worker.ts')
const { readServerPerceptionSnapshotService } = await import('../../../src/v2/application/server-perception-snapshots.ts')
const { PrismaPerceptionProducerEnvelopeRepository } = await import('../../../src/v2/infrastructure/prisma/perception-producer-envelope-repository.ts')
const { PrismaPerceptionProducerRequestContextRepository } = await import('../../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts')
const { PrismaTemporalProducerRequestContextRepository } = await import('../../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts')
const { PrismaPublicOperationRepository } = await import('../../../src/v2/infrastructure/prisma/public-operation-repository.ts')
const { PrismaServerPerceptionEvidenceReader } = await import('../../../src/v2/infrastructure/prisma/server-perception-evidence-reader.ts')
const { PrismaServerPerceptionSnapshotRepository } = await import('../../../src/v2/infrastructure/prisma/server-perception-snapshot-repository.ts')
const { PrismaTemporalProducerEnvelopeRepository } = await import('../../../src/v2/infrastructure/prisma/temporal-producer-envelope-repository.ts')

/**
 * W63a PostgreSQL world: one project whose head Version plays one recording (120 frames at 30 fps), and the sealed evidence of that
 * recording written ONLY through the products' own writers (admission, claim, fenced publish):
 *
 * - OCR: four sampled frames (0, 30, 60, 90), three with a text region, one with none;
 * - temporal: 119 adjacent-frame pairs of shot and motion, the pairs 10 and 11 above the reliability gate (motion gap);
 * - face v3: windows of the SOURCE's own frames over the whole recording, sampled every 5 frames, a box every tenth frame.
 *
 * The three analyzers are stand-ins in what they LOOK at (no pixel of any video is read); everything they return is sealed, hashed,
 * stored and re-derived by the real workers, constructors and repositories.
 */
export const OCR_FRAMES = Object.freeze([0, 30, 60, 90])
export const FACE_ROWS = Object.freeze([[0.9, 0.2, 0.1, 0.4, 0.6]])

function actor(world, scopes, label) {
  const auditContext = createExternalAuditContext({ clientId: world.clientId, credentialId: `w61-credential-${world.suffix}`,
    workspaceId: world.workspaceId, environment: 'production' })
  void label
  return { ...auditContext, scopes: new Set(scopes), authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext }
}

export async function seedSnapshotWorld(db, options = {}) {
  const world = await seedPerceptionProducerContext(db, { durationFrames: 120, ...options })
  return produceSnapshotEvidence(db, world)
}

/**
 * The three producers over a world whose head Version plays one 120-frame recording (`world.versionId`, `world.sourceId`,
 * `world.sourceSha256`, `world.clientId`, `world.suffix`, `world.projectId`): each runs through admission, claim and the fenced publish.
 */
export async function produceSnapshotEvidence(db, world) {
  const operations = new PrismaPublicOperationRepository(db)
  const writer = actor(world, ['projects:write'], 'writer')
  const createOperationId = () => `w63a-operation-${randomUUID()}`
  const materializer = sourceMaterializer
  const stats = { ocr: null, temporal: null, faceWindows: [] }

  const ocrQueued = await enqueuePerceptionProducerRunService({
    context: new PrismaPerceptionProducerRequestContextRepository(db), operations, createOperationId,
  })({ workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
    sourceArtifactId: world.sourceId, sampleIntervalFrames: 30, actor: writer, idempotencyKey: `w63a-ocr-${world.suffix}` })
  const ocrResult = await runNextPerceptionProducerOperationService({
    repository: new PrismaPerceptionProducerEnvelopeRepository(db), materializer,
    adapter: { analyze: async () => ({
      sourceTimebase: { num: 1, den: 15360 }, sourceFps: { num: 30, den: 1 }, sourcePtsStart: 0, sourceClock: 'constant-frame-rate',
      producer: { name: 'tesseract', executableSha256: sha('6'), executableVersion: 'w63a-stand-in',
        traineddata: [{ language: 'por', sha256: sha('7'), licenseSha256: sha('8') }] },
      runtime: { ffmpegSha256: sha('4'), ffprobeSha256: sha('5') },
      samples: OCR_FRAMES.map((sourceFrame) => ({ sourcePts: sourceFrame * 512, sourcePtsEvidenceHash: sha('9'), sourceFrame,
        imageSha256: digest(`w63a-image-${sourceFrame}`),
        ocr: sourceFrame === 90 ? [] : [{ text: `Prova ${sourceFrame}`, language: 'por', box: [0.1, 0.75, 0.3, 0.1], confidence: 0.76 }] })),
    }) },
  })(`w63a-ocr-worker-${world.suffix}`)
  assert.equal(ocrResult?.status, 'succeeded', JSON.stringify(ocrResult))
  assert.equal(ocrResult.operationId, ocrQueued.operation.id)
  stats.ocr = await db.v2PerceptionProducerEnvelope.findFirstOrThrow({ where: { operationId: ocrQueued.operation.id } })

  const temporalQueued = await enqueueTemporalProducerRunService({
    context: new PrismaTemporalProducerRequestContextRepository(db), operations, createOperationId,
  })({ workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
    sourceArtifactId: world.sourceId, actor: writer, idempotencyKey: `w63a-temporal-${world.suffix}` })
  const temporalResult = await runNextTemporalProducerOperationService({
    repository: new PrismaTemporalProducerEnvelopeRepository(db), materializer,
    analyzer: { analyze: async () => temporalAnalysis({ frames: 120, sourceSha256: world.sourceSha256, unreliableAt: [10, 11] }) },
  })(`w63a-temporal-worker-${world.suffix}`)
  assert.equal(temporalResult?.status, 'succeeded', JSON.stringify(temporalResult))
  assert.equal(temporalResult.operationId, temporalQueued.operation.id)
  stats.temporal = await db.v2TemporalProducerEnvelope.findFirstOrThrow({ where: { operationId: temporalQueued.operation.id } })

  const faces = sourceWindowHarness(db, world)
  for (const window of [{ startSourceFrame: 0, endSourceFrame: 60 }, { startSourceFrame: 60, endSourceFrame: 120 }]) {
    stats.faceWindows.push(await faces.publish(`w63a-${window.startSourceFrame}`, window, (frame) => (frame % 10 === 0 ? FACE_ROWS : [])))
  }

  const evidence = new PrismaServerPerceptionEvidenceReader(db)
  const snapshots = new PrismaServerPerceptionSnapshotRepository(db)
  const service = (clock = () => new Date()) => readServerPerceptionSnapshotService({ evidence, snapshots, clock })
  return Object.freeze({ world, stats, evidence, snapshots, service, faces, operations, writer, faceActor: actorFor(world) })
}

export const coverageOf = (result, kind) => result.result.coverage.find((entry) => entry.kind === kind)

/** The detector stand-in of the world's windows: a box every tenth source frame, nothing on the others. */
export const faceRowsEveryTenthFrame = (frame) => (frame % 10 === 0 ? FACE_ROWS : [])

/**
 * `count` DISTINCT windows of the 120-frame recording, each holding at least one sampled frame (a multiple of 5), enumerated by length
 * and then by start; `skip` lists [start, end) pairs that must not be among them. They overlap each other heavily and, being answered by
 * the same stand-in, agree on every frame they share - the way re-runs of the same source do.
 */
export function distinctFaceWindows(count, { skip = [] } = {}) {
  const skipped = new Set(skip.map(([start, end]) => `${start}-${end}`))
  const windows = []
  for (let length = 5; length <= 60 && windows.length < count; length += 1) {
    for (let start = 0; start + length <= 120 && windows.length < count; start += 1) {
      if (skipped.has(`${start}-${start + length}`)) continue
      windows.push({ startSourceFrame: start, endSourceFrame: start + length })
    }
  }
  assert.equal(windows.length, count, 'the recording holds enough distinct windows')
  return windows
}

/** Publishes the windows one after the other through the real admission, worker and repository (the stored rows are returned). */
export async function publishFaceWindows(faces, windows, label, rowsAt = faceRowsEveryTenthFrame) {
  const rows = []
  for (const [index, window] of windows.entries()) rows.push(await faces.publish(`${label}-${index}`, window, rowsAt))
  return rows
}
