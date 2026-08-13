import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { compileVisualMontageRenderInputs } from '../../src/v2/application/compile-visual-montage-render.ts'
import { preflightRenderInputService } from '../../src/v2/application/preflight-render-input.ts'
import { renderAuthorizedInputService } from '../../src/v2/application/render-authorized-input.ts'
import { runNextPublicOperationService } from '../../src/v2/application/run-public-operation-worker.ts'
import { createVisualMontagePlan } from '../../src/v2/domain/visual-montage.ts'
import { RemotionRenderInputRenderer } from '../../src/v2/infrastructure/remotion-render-input-renderer.ts'

const execFileAsync = promisify(execFile)
const ffmpeg = 'ffmpeg'
const ffprobe = 'ffprobe'

async function run(binary, args) {
  await execFileAsync(binary, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
}

async function identity(file) {
  const bytes = await readFile(file)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.byteLength }
}

function materialized(spec, filesById) {
  return Object.freeze({
    ...spec,
    assets: Object.freeze(spec.assets.map((asset) => Object.freeze({
      ...asset,
      uri: pathToFileURL(filesById.get(asset.id)).href,
    }))),
  })
}

function operationRepository({ authorizationId, artifactId, manifestId, inputHash }) {
  const phases = []
  let claimed = false
  let completed = false
  const operation = {
    id: `operation-${authorizationId}`,
    workspaceId: 'workspace-visual-montage',
    clientId: 'client-visual-montage',
    type: 'artifact-render',
    status: 'queued',
    phase: 'materializing',
    attempt: 1,
    maxAttempts: 1,
    target: { type: 'media-artifact', id: artifactId, manifestId },
  }
  return {
    phases,
    get completed() { return completed },
    repository: {
      async claimNext(input) {
        if (claimed || input.type !== 'artifact-render') return null
        claimed = true
        return {
          operation,
          context: { kind: 'artifact-render', authorizationId, inputHash },
          lease: { owner: input.leaseOwner, attempt: 1, heartbeatAt: input.now, expiresAt: input.leaseUntil },
        }
      },
      async heartbeat() { return true },
      async advancePhase(input) { phases.push(input.phase); return true },
      async succeed() { completed = true; operation.status = 'succeeded'; return { operation } },
      async failOrRetry() { operation.status = 'failed'; return { operation } },
    },
  }
}

async function probe(file) {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', file,
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return JSON.parse(stdout)
}

async function frameHash(file, seconds) {
  const { stdout } = await execFileAsync(ffmpeg, [
    '-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
  return createHash('sha256').update(stdout).digest('hex')
}

test('T-FR-091 real worker renders person-free voiceover montage to proxy and final MP4', { timeout: 360_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apollo-visual-montage-'))
  try {
    const audioPath = path.join(directory, 'narration.m4a')
    const imagePath = path.join(directory, 'abstract-red.png')
    const videoPath = path.join(directory, 'abstract-blue.mp4')
    const outputRoot = path.join(directory, 'outputs')
    await mkdir(outputRoot, { recursive: true })
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=523:duration=2.7', '-c:a', 'aac', '-b:a', '128k', audioPath])
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xD53939:s=360x640', '-frames:v', '1', '-threads', '1', imagePath])
    await run(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2457A7:s=360x640:d=0.9:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath])

    const [audio, image, video] = await Promise.all([identity(audioPath), identity(imagePath), identity(videoPath)])
    const plan = createVisualMontagePlan({
      id: 'visual-montage-e2e', workspaceId: 'workspace-visual-montage', projectId: 'project-visual-montage', projectVersionId: 'version-visual-montage',
      storyPlanRef: { id: 'story-visual-montage', hash: '1'.repeat(64) },
      montageSelectionRef: { selectionHash: '2'.repeat(64), candidateId: 'candidate-visual-montage', candidateHash: '3'.repeat(64) },
      sourceAudio: { artifactId: 'artifact-narration', artifactKey: 'voice/narration.m4a', ...audio, durationMs: 2700 },
      beatBoundaries: [
        { storyBlockId: 'story-block-one', endMs: 900, narration: 'Uma ideia ganha forma.', intention: 'Abrir o conceito', content: ['formas abstratas'], style: ['vermelho'] },
        { storyBlockId: 'story-block-two', endMs: 1800, narration: 'O movimento cria ritmo.', intention: 'Criar progressao', content: ['cor e movimento'], style: ['azul'] },
        { storyBlockId: 'story-block-three', endMs: 2700, narration: 'A mensagem fica clara.', intention: 'Fechar a mensagem', content: ['tipografia limpa'], style: ['alto contraste'] },
      ],
      assets: [
        { id: 'abstract-image', artifactId: 'artifact-image', artifactKey: 'visuals/abstract-red.png', ...image, kind: 'image', containsPeople: false, personEvidence: { schemaVersion: 'person-presence-evidence/v1', method: 'synthetic-generation', containsPeople: false, evidenceHash: image.sha256 }, content: ['cor solida'], style: ['abstrato'] },
        { id: 'abstract-video', artifactId: 'artifact-video', artifactKey: 'visuals/abstract-blue.mp4', ...video, kind: 'video', containsPeople: false, personEvidence: { schemaVersion: 'person-presence-evidence/v1', method: 'synthetic-generation', containsPeople: false, evidenceHash: video.sha256 }, content: ['cor em movimento'], style: ['abstrato'] },
      ],
    })
    assert.equal(plan.validation.passed, true)
    assert.equal(plan.validation.signals.personFree.passed, true)

    const rendererIdentity = { id: 'remotion', version: '4.0.344', digest: 'f'.repeat(64) }
    const inputs = compileVisualMontageRenderInputs({ plan, renderer: rendererIdentity })
    const filesById = new Map([['voiceover-audio', audioPath], ['abstract-image', imagePath], ['abstract-video', videoPath]])

    for (const [kind, spec] of [['proxy', inputs.proxy], ['final', inputs.final]]) {
      const { inputHash: _inputHash, composition: compiledComposition, ...portableSpec } = spec
      const { propsHash: _propsHash, ...composition } = compiledComposition
      const { schemaVersion: _outputSchemaVersion, ...output } = spec.output
      const preflight = await preflightRenderInputService()({ ...portableSpec, composition, output })
      assert.equal(preflight.inputHash, spec.inputHash)
      assert.equal(preflight.materializationRequired, true)
      const authorizationId = `authorization-${kind}`
      const artifactId = `artifact-output-${kind}`
      const manifestId = `manifest-output-${kind}`
      const input = materialized(spec, filesById)
      const receipt = Object.freeze({
        schemaVersion: 'materialized-render-input-receipt/v1', authorizationId, artifactId, manifestId,
        inputHash: input.inputHash, revalidationHash: 'e'.repeat(64), assetCount: input.assets.length,
        revalidatedAt: '2026-08-13T12:00:00.000Z', validUntil: '2026-08-13T13:00:00.000Z',
      })
      const lease = Object.freeze({ receipt, getRenderInput: () => input, toJSON: () => receipt })
      const outputKey = `workspaces/visual-montage/${kind}.mp4`
      const render = renderAuthorizedInputService({
        materialize: async () => lease,
        renderer: new RemotionRenderInputRenderer({ projectRoot: process.cwd(), outputRoot, timeoutMs: 300_000, createId: () => `stage-${kind}` }),
        outputKeyFor: () => outputKey,
      })
      const operations = operationRepository({ authorizationId, artifactId, manifestId, inputHash: input.inputHash })
      let checkpoint
      const worker = runNextPublicOperationService({
        operations: operations.repository,
        checkpoints: { async findByOperationId() { return checkpoint ?? null }, async record(value) { checkpoint = value; return { checkpoint: value, replayed: false } } },
        render,
        leaseDurationMs: 30_000,
        heartbeatIntervalMs: 5_000,
      })
      assert.deepEqual(await worker(`worker-${kind}`), { operationId: `operation-${authorizationId}`, status: 'succeeded' })
      assert.equal(operations.completed, true)
      assert.deepEqual(operations.phases, ['rendering', 'verifying', 'persisting'])
      assert.equal(checkpoint.output.inputHash, input.inputHash)

      const outputPath = path.join(outputRoot, ...outputKey.split('/'))
      const metadata = await probe(outputPath)
      const videoStream = metadata.streams.find((stream) => stream.codec_type === 'video')
      const audioStream = metadata.streams.find((stream) => stream.codec_type === 'audio')
      assert.equal(Number(videoStream.width), spec.output.width)
      assert.equal(Number(videoStream.height), spec.output.height)
      assert.equal(Number(videoStream.nb_read_frames), 81)
      assert.equal(audioStream.codec_name, 'aac')
      assert.ok(Math.abs(Number(metadata.format.duration) - 2.7) <= 0.1)
      const hashes = await Promise.all([0.45, 1.35, 2.25].map((seconds) => frameHash(outputPath, seconds)))
      assert.equal(new Set(hashes).size, 3, 'image, video and card beats must all be visibly present')
      assert.equal((await stat(outputPath)).size, checkpoint.output.byteSize)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
