import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { createExternalAuditContext } from '../../../src/v2/application/authenticate-api-client.ts'
import { enqueueFaceSourceWindowRunService } from '../../../src/v2/application/enqueue-face-source-window-run.ts'
import { runNextFaceSourceWindowOperationService } from '../../../src/v2/application/run-face-source-window-worker.ts'
import { PrismaFaceSourceWindowRepository } from '../../../src/v2/infrastructure/prisma/face-source-window-repository.ts'
import { PrismaFaceSourceWindowRequestContextRepository } from '../../../src/v2/infrastructure/prisma/face-source-window-request-context-repository.ts'
import { PrismaPublicOperationRepository } from '../../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { acceptedProducer, detectorConfig, observedSample, unknownSample } from './face-envelope-v2.mjs'
import { commitSealedChild, seedSealedProject } from './pg-output-world.mjs'
import { cancelProducerFenceCase } from './producer-publish-lock-race.mjs'

/**
 * Shared PostgreSQL fixtures of the SOURCE-keyed V9 face windows (W65b): the actor, the detector stand-in, the window harness
 * (enqueue -> real worker -> real repository) and the two ways a world grows - a peer project that has the same source attached,
 * and a Director-cut Version that plays that source through several trimmed clips.
 *
 * The detector is a stand-in only in what it LOOKS at: it returns real V9 output tensors, sealed, stored and re-derived by the real
 * worker, repository and decoder. No frame of any video is analysed here.
 */
export function actorFor(world) {
  const auditContext = createExternalAuditContext({ clientId: world.clientId, credentialId: `face-source-credential-${world.suffix}`,
    workspaceId: world.workspaceId, environment: 'production' })
  return { ...auditContext, scopes: new Set(['projects:write', 'projects:read', 'operations:cancel']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
    workspaceAccessStatus: 'active', auditContext }
}

/**
 * `rowsAt(sourceFrame)` returns the detector rows of that frame ([score, xmin, ymin, xmax, ymax], normalised), or 'unknown' for a
 * frame the detector fails on. The analyzer answers for exactly the frames of the claimed SOURCE window.
 */
export function sourceAnalyzerFor(rowsAt = () => [], { producer = acceptedProducer(), sourceFps = { num: 30, den: 1 } } = {}) {
  return {
    analyze: async (request) => {
      const first = Math.ceil(request.sourceInFrame / request.sampleIntervalFrames) * request.sampleIntervalFrames
      const built = []
      for (let frame = first; frame < request.sourceOutFrame; frame += request.sampleIntervalFrames) {
        const rows = rowsAt(frame)
        built.push(rows === 'unknown'
          ? { sample: unknownSample({ timelineFrame: frame, sourceFrame: frame }), raw: null }
          : observedSample({ timelineFrame: frame, sourceFrame: frame, rows }))
      }
      return {
        sourceFps, sourceTimebase: { num: 1, den: 15360 }, sourcePtsStart: 0, sourceClock: 'constant-frame-rate',
        sourcePtsRounding: 'nearest', sourceWidth: 1280, sourceHeight: 720, sourceOrientation: 'rotation-0-exif-neutral',
        detectorConfig: { ...detectorConfig }, producer,
        samples: built.map(({ sample: { timelineFrame: _unused, ...rest } }) => rest),
        rawOutputs: built.map(({ raw }) => raw),
      }
    },
  }
}

export const sourceMaterializer = {
  materialize: async (request) => ({ path: 'C:/private/face-source-window.mp4', sha256: request.sha256, byteSize: request.byteSize }),
  cleanup: async () => {},
}

/** The window harness of one world: enqueue through the real admission, run the real worker over the real repository. */
export function sourceWindowHarness(db, world) {
  const operations = new PrismaPublicOperationRepository(db)
  const operationIds = []
  const enqueue = async (label, window, { projectId = world.projectId, sourceArtifactId = world.sourceId, actor = actorFor(world) } = {}) => {
    const queued = await enqueueFaceSourceWindowRunService({
      context: new PrismaFaceSourceWindowRequestContextRepository(db), operations,
      createOperationId: () => `face-source-operation-${randomUUID()}`,
    })({ workspaceId: actor.workspaceId, projectId, sourceArtifactId, window, actor, idempotencyKey: `face-source-${label}-${world.suffix}` })
    operationIds.push(queued.operation.id)
    return queued
  }
  const worker = (analyzer = sourceAnalyzerFor()) => runNextFaceSourceWindowOperationService({
    repository: new PrismaFaceSourceWindowRepository(db), materializer: sourceMaterializer, analyzer })
  /** Enqueues one window and runs the worker to completion; returns the stored envelope row. */
  const publish = async (label, window, rowsAt = () => [], options = {}) => {
    const queued = await enqueue(label, window, options)
    const result = await worker(sourceAnalyzerFor(rowsAt, options.analyzer))(`face-source-worker-${label}-${world.suffix}`)
    assert.equal(result?.status, 'succeeded', `${label}: ${JSON.stringify(result)}`)
    assert.equal(result.operationId, queued.operation.id)
    return db.v2FaceSourceWindowEnvelope.findFirstOrThrow({ where: { operationId: queued.operation.id } })
  }
  const cleanup = async () => {
    const failures = []
    for (const operationId of operationIds) {
      try { await cancelProducerFenceCase(db, operations, world, actorFor(world), operationId, 'face-source-cleanup') }
      catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'face source window cleanup failed')
  }
  return { operations, enqueue, worker, publish, cleanup }
}

export async function finish(db, cleanup, primaryError) {
  let cleanupError
  try { await cleanup() } catch (error) { cleanupError = error }
  try { await db.$disconnect() } catch (error) { cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'face source window test and cleanup failed')
  if (primaryError) throw primaryError
  if (cleanupError) throw cleanupError
}

/**
 * Another project of the same workspace (its own sealed root), with the world's source attached as its source master - the project
 * the evidence is reused from. `locale` is the locale the rights are evaluated for when THAT project reads the evidence. With
 * `attach: false` the project exists but does not have the source.
 */
export async function peerProject(db, world, { locale = 'pt-BR', attach = true, label = 'peer' } = {}) {
  const sealed = await seedSealedProject(db, { workspaceId: world.workspaceId, actor: world.actor, prefix: `w65b-${label}`, locale })
  if (attach) {
    await db.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId: world.workspaceId, projectId: sealed.projectId,
      artifactId: world.sourceId, role: 'source-master', originalFileName: `${label}-source.mp4`, createdAt: new Date() } })
  }
  return Object.freeze({ projectId: sealed.projectId, locale })
}

/**
 * A Director-cut Version of the world's project: the same source, played through `clips` (trimmed, reordered, with jumps). It becomes
 * the head, exactly as a Director run's Version does; the windows already produced were requested under an earlier head.
 */
export async function directorCut(db, world, clips, { label = 'cut' } = {}) {
  const durationFrames = Math.max(...clips.map((clip) => clip.timelineOutFrame))
  const built = clips.map((clip, index) => Object.freeze({ id: `clip-${label}-${index + 1}`, sourceArtifactId: world.sourceId, rate: 1, ...clip }))
  const head = await commitSealedChild(db, { workspaceId: world.workspaceId, projectId: world.projectId, actor: world.actor,
    suffix: `w65b-${label}-${world.suffix}`,
    mutatePlan: (plan) => ({ ...plan, durationFrames, videoTracks: [{ ...plan.videoTracks[0], clips: built }] }) })
  return Object.freeze({ versionId: head.version.id, editPlanSnapshotId: head.editPlanSnapshot.id,
    plan: JSON.parse(head.editPlanSnapshot.contentJson), clips: built, durationFrames })
}
