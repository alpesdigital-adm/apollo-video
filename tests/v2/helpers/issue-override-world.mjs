import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { sourceWindowHarness } from './face-source-pg.mjs'
import { seedTwoOutputIngestedProject } from './multi-output-pg-world.mjs'
import { commitSealedChild, testActor } from './pg-output-world.mjs'
import { drawSourceFrame, FPS, H, makeBaseFrame, standInDetectorRows, W } from './reframe-gt-oracle.mjs'
import { registerColorPipeline } from './review-edit-world.mjs'
import { createWorkspaceRow, issueApiClient } from './capture-journey.mjs'

const { setProjectLutSelectionService } = await import('../../../src/v2/application/project-lut-selections.ts')
const { PrismaProjectLutSelectionRepository } = await import('../../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')

/**
 * W68 browser proof world: ONE project with TWO outputs (9:16 and 16:9) over ONE real recording, with three subtitle cues in the EditPlan
 * and sealed face windows that cover the first two cues and not the third.
 *
 *   cue-1  [10, 40)   covered   -> placed by the plan
 *   cue-2  [50, 90)   covered   -> placed by the plan; the generator's face sits in the upper/middle of the frame
 *   cue-3  [105, 140) NOT covered by any face window -> FACE_PERCEPTION_UNAVAILABLE (a review chip) in the outputs where a band needs evidence
 *
 * Everything but the face detector goes through the product: the recording is a real mp4 the generator drew (so pixels can be measured), the
 * rows are the production writers', the workers are the production workers. The detector is a labelled STAND-IN: its boxes are the generator's
 * own (reframe-gt-oracle.mjs), written by the real V9 decoder into sealed windows.
 */
/**
 * The generator's scene: one person at x = 0.20, who steps right to x = 0.30 in six frames (a speed the 9:16 crop cannot follow: 0.5 per second
 * against the policy's 0.35) and stays there. The whole step fits inside one crop window, so a manual crop CAN keep the subject, which is what an
 * editor fixes by hand. `kind: 'face'` is what the stand-in detector reports.
 */
// A small face in the upper part of the frame (0.06 x 0.12 of the frame): once the published clearance dilation is applied it occupies the TOP
// caption band and leaves the others free, so a caption pinned there is refused and one pinned elsewhere is granted.
const smallFace = (x) => [x, 0.08, x + 0.06, 0.2]
export const SCENE = Object.freeze({
  sourceFrames: 150,
  clips: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150 }],
  subjectsAtSource: (frame) => [{ id: 'A', kind: 'face', color: 'A', box: smallFace(0.2 + 0.1 * Math.min(Math.max(frame - 40, 0), 6) / 6) }],
})
export const CUES = Object.freeze([
  Object.freeze({ id: 'cue-1', startFrame: 10, endFrame: 40, text: 'Primeira legenda do vídeo', anchor: 'bottom' }),
  Object.freeze({ id: 'cue-2', startFrame: 50, endFrame: 90, text: 'Segunda legenda', anchor: 'bottom' }),
  Object.freeze({ id: 'cue-3', startFrame: 105, endFrame: 140, text: 'Terceira legenda', anchor: 'bottom' }),
])
export const FACE_WINDOW = Object.freeze({ startSourceFrame: 0, endSourceFrame: 100 })

const CLIENT_SCOPES = Object.freeze(['projects:read', 'projects:write', 'projects:approve', 'artifacts:read', 'operations:cancel', 'media:write'])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Encodes the GT frames of the scene (drawn by the generator, piped raw) into a 1280x720, 30 fps mp4 with an audio track. */
export async function generateRecording(scene, path, ffmpegPath) {
  await mkdir(dirname(path), { recursive: true })
  const child = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-video_size', `${W}x${H}`, '-framerate', String(FPS), '-i', 'pipe:0',
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${(scene.sourceFrames / FPS + 0.5).toFixed(3)}`,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-shortest', path,
  ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.stdin.on('error', () => {})
  const exited = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`recording encode exited ${code}: ${stderr}`))))
  })
  const base = makeBaseFrame()
  for (let frame = 0; frame < scene.sourceFrames; frame += 1) {
    const buffer = Buffer.allocUnsafe(W * H * 3)
    drawSourceFrame(buffer, base, scene.subjectsAtSource(frame))
    if (!child.stdin.write(buffer)) await new Promise((resolve) => child.stdin.once('drain', resolve))
  }
  child.stdin.end()
  await exited
}

async function tenant(db, suffix, label) {
  const workspaceId = `w68-${suffix}-${label}-ws`
  const clientId = `w68-${suffix}-${label}-client`
  const createdAt = new Date()
  await createWorkspaceRow({ prisma: db, workspaceId, name: `W68 ${label} ${suffix}`, createdAt })
  const issued = await issueApiClient({ prisma: db, workspaceId, clientId, name: `W68 ${label}`, createdAt, scopes: CLIENT_SCOPES })
  const actor = testActor({ workspaceId, clientId, credentialId: `${clientId}-seed`, environment: 'production', scopes: [...CLIENT_SCOPES] })
  return { workspaceId, clientId, issued, token: issued.token, actor }
}

export async function seedIssueOverrideWorld({ db, artifactRoot, suffix, ffmpegPath }) {
  const owner = await tenant(db, suffix, 'owner')
  const stranger = await tenant(db, suffix, 'stranger')
  const scene = SCENE
  const key = `w68/${suffix}/source.mp4`
  const path = join(artifactRoot, key)
  await generateRecording(scene, path, ffmpegPath)
  const bytes = await readFile(path)
  const sourceSha256 = sha256(bytes)
  const seeded = await seedTwoOutputIngestedProject(db, {
    workspaceId: owner.workspaceId, actor: owner.actor, prefix: `w68${suffix}`, ids: { project: `w68-${suffix}-project` },
    recording: { slug: 'source', durationFrames: scene.sourceFrames, sourceSha256, sourceByteSize: (await stat(path)).size, sourceKey: key, width: W, height: H },
  })
  const source = { artifactId: seeded.recording.names.sourceArtifactId, manifestId: seeded.recording.names.sourceManifestId, sha256: sourceSha256, key }
  // The three cues, in a child Version of the same project (the head moves; the recording stays adopted).
  const head = await commitSealedChild(db, {
    workspaceId: owner.workspaceId, projectId: seeded.projectId, actor: owner.actor, suffix: `w68${suffix}-cues`,
    mutatePlan: (plan) => ({ ...plan, subtitleTracks: [{ id: 'track-captions', kind: 'captions', presetId: 'kinetic', cues: CUES.map((cue) => ({ ...cue })) }] }),
  })
  await registerColorPipeline(db, { workspaceId: owner.workspaceId, projectId: seeded.projectId, actor: owner.actor, artifactId: source.artifactId, manifestId: source.manifestId })
  // The render worker refuses a Version with no explicit LUT selection: `none` makes the choice explicit (the Command, not a table write).
  const lut = await setProjectLutSelectionService({
    repository: new PrismaProjectLutSelectionRepository(db), createId: (kind) => `w68-${suffix}-lut-${kind}-${randomUUID()}`, createEventId: () => randomUUID(),
  })({
    baseVersionId: head.version.id, baseHash: head.version.baseHash, selection: { mode: 'none' }, reason: 'W68 browser proof selects no creative LUT.',
    workspaceId: owner.workspaceId, projectId: seeded.projectId, actor: owner.actor, idempotencyKey: `w68-${suffix}-lut-1`,
  })
  const faces = sourceWindowHarness(db, { suffix: `w68${suffix}`, workspaceId: owner.workspaceId, clientId: owner.clientId, projectId: seeded.projectId, sourceId: source.artifactId, actor: owner.actor })
  const windowEnvelope = await faces.publish('cover', FACE_WINDOW, (frame) => standInDetectorRows(scene, frame))
  return Object.freeze({
    owner, stranger, scene, source, projectId: seeded.projectId, wideVariantId: seeded.wideVariantId, verticalVariantId: seeded.verticalVariantId,
    headVersionId: lut.version.id, headVersionHash: lut.version.baseHash, windowEnvelopeHash: windowEnvelope.envelopeHash, suffix,
  })
}

/** One pass of the production proxy-render worker for `workspaceId`; resolves with the outcome (null when nothing was claimable). */
export async function runProxyWorkerOnce({ environment, workspaceId, operationId, onFailure }) {
  const factory = await import('../../../src/v2/infrastructure/repository-factory.ts')
  const create = factory.createProjectProxyRenderWorker ?? factory.default.createProjectProxyRenderWorker
  const worker = create(environment, () => new Date(), ({ operationId: failed, error }) => onFailure?.({ operationId: failed, error }))
  return worker(`w68-test-driver:${process.pid}:${randomUUID().slice(0, 6)}`, { workspaceId, ...(operationId ? { operationId } : {}) })
}
