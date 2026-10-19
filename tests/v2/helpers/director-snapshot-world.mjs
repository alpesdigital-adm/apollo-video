import { randomUUID } from 'node:crypto'

import { sha } from './perception-snapshot-fixtures.mjs'
import { commitSealedChild, planPlayingRecordings } from './pg-output-world.mjs'
import { seedDirectorOcrWorld } from './s3c-director-ocr-world.mjs'
import { produceSnapshotEvidence } from './server-perception-pg-world.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { createExternalAuditContext } = await import('../../../src/v2/application/authenticate-api-client.ts')
const { runProjectDirectorService } = await import('../../../src/v2/application/run-project-director.ts')
const { readServerPerceptionSnapshotService } = await import('../../../src/v2/application/server-perception-snapshots.ts')
const { stableSerialize } = await import('../../../src/v2/domain/canonical-hash.ts')
const { createMediaTranscript } = await import('../../../src/v2/domain/media-transcript.ts')
const { createEvidenceBoundBriefCompiler } = await import('../../../src/v2/infrastructure/brief/evidence-bound-brief-compiler-model.ts')
const { PrismaDirectorRunRepository } = await import('../../../src/v2/infrastructure/prisma/director-run-repository.ts')
const { PrismaServerPerceptionEvidenceReader } = await import('../../../src/v2/infrastructure/prisma/server-perception-evidence-reader.ts')
const { PrismaServerPerceptionSnapshotRepository } = await import('../../../src/v2/infrastructure/prisma/server-perception-snapshot-repository.ts')

/**
 * The world of the W63a Director suites: the Director world of the OCR suite (a real transcript row, the plan retimed from it, a sealed
 * input Version playing one 120-frame recording), with the OCR, temporal and source-keyed face evidence written over it by the
 * products' own writers. The output variant is named by its aspect ratio and an output variant id is unique across the database, so a
 * suite that shares a database with another uses a ratio of its own (the OCR suite owns 9:16).
 *
 * Returns the repositories, the Director service over any repository (so a suite can wrap the commit) and the request builder; `request`
 * takes the base Version to direct (the input Version by default, or the head a previous run left).
 */
export async function seedDirectorSnapshotWorld(db, { aspectRatio = '4:5' } = {}) {
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `w61-admission-${suffix}`
  const world = await seedDirectorOcrWorld(db, { suffix, artifactKey: `${workspaceId}/source.mp4`, sourceSha256: sha('a'), byteSize: 1024n, aspectRatio })
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
  const counters = new Map()
  const service = (repository) => runProjectDirectorService({ repository, clock: () => new Date(), createEventId: randomUUID,
    createId: (kind) => `${kind}-w63a-${suffix}-${counters.set(kind, (counters.get(kind) ?? 0) + 1).get(kind)}`,
    compileBrief: createEvidenceBoundBriefCompiler() })
  const request = (key, base = { versionId: world.versionId, baseHash: world.head.version.baseHash }) => ({
    workspaceId, projectId: world.projectId, baseVersionId: base.versionId, baseHash: base.baseHash, actor,
    idempotency: { key }, reason: 'Plan with the server perception snapshot as evidence input only.' })
  const rowsBefore = async () => ({
    versions: await db.v2ProjectVersion.count({ where: { projectId: world.projectId } }),
    runs: await db.v2DirectorRun.count({ where: { projectId: world.projectId } }),
    commands: await db.v2EditCommand.count({ where: { projectId: world.projectId } }),
    snapshots: await db.v2ProjectSnapshot.count({ where: { projectId: world.projectId } }),
    perception: await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId } }),
  })
  return Object.freeze({ suffix, workspaceId, world, built, director, snapshots, publicSnapshot, actor, service, request, rowsBefore })
}
