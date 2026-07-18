import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { evaluateAssetUse, createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { createMaterializationAuthorization } from '../../src/v2/domain/materialization-authorization.ts'
import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import { materializeAuthorizedRenderInputService } from '../../src/v2/application/materialize-authorized-render-input.ts'
import { renderAuthorizedInputService } from '../../src/v2/application/render-authorized-input.ts'
import { LocalArtifactRenderInputResolver } from '../../src/v2/infrastructure/local-artifact-render-input-resolver.ts'
import { RemotionRenderInputRenderer } from '../../src/v2/infrastructure/remotion-render-input-renderer.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import { probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'

const execFileAsync = promisify(execFile)
const executableSuffix = process.platform === 'win32' ? '.exe' : ''
const ffmpegPath = path.join(
  process.cwd(),
  'node_modules',
  'ffmpeg-static',
  `ffmpeg${executableSuffix}`,
)

async function createSource(outputPath) {
  await execFileAsync(ffmpegPath, [
    '-f',
    'lavfi',
    '-i',
    'color=c=0x183153:s=270x480:r=30:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    outputPath,
  ])
}

test('authorized materialized lease produces and promotes a real Remotion smoke render', { timeout: 180_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apollo-remotion-v2-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const artifactRoot = path.join(directory, 'artifacts')
  const outputRoot = path.join(directory, 'outputs')
  const artifactKey = 'workspaces/golden/masters/source.mp4'
  const sourcePath = path.join(artifactRoot, ...artifactKey.split('/'))
  await mkdir(path.dirname(sourcePath), { recursive: true })
  await mkdir(outputRoot, { recursive: true })
  await createSource(sourcePath)
  const sourceMetadata = await stat(sourcePath)
  const sourceSha256 = await calculateFileSha256(sourcePath)

  const input = createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: 'a'.repeat(64) },
    composition: {
      id: 'apollo-video',
      version: 'v1',
      propsSchemaRef: 'apollo://render-props/apollo-video/v1',
    },
    plan: { id: 'golden-plan', versionId: 'golden-plan-version', hash: 'b'.repeat(64) },
    output: {
      id: 'golden-9x16',
      locale: 'pt-BR',
      aspectRatio: '9:16',
      width: 270,
      height: 480,
      fps: 30,
      safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
      durationInFrames: 30,
    },
    assets: [
      {
        id: 'primary-video',
        artifactId: 'golden-source-artifact',
        artifactKey,
        kind: 'video',
        role: 'primary',
        ordinal: 0,
        sha256: sourceSha256,
        byteSize: sourceMetadata.size,
      },
    ],
    props: {
      primaryVideoAssetId: 'primary-video',
      scenes: [
        {
          type: 'fullscreen',
          fromFrame: 15,
          toFrame: 30,
          props: { title: 'Apollo V2', subtitle: 'render autorizado' },
        },
      ],
      subtitles: [{ text: 'Primeiro render seguro', fromFrame: 0, toFrame: 15 }],
      palette: {
        primary: '#FFB800',
        secondary: '#20202A',
        accent: '#FF6B35',
        text: '#FFFFFF',
        background: '#050508',
      },
      stylePreset: 'creator-clean',
      subtitleStyle: 'kinetic',
      gradePreset: 'natural',
    },
  })
  const rights = createAssetRightsSnapshot({
    id: 'golden-rights',
    workspaceId: 'golden-workspace',
    artifactId: 'golden-source-artifact',
    sequence: 1,
    draft: {
      status: 'approved',
      allowedUses: ['quality-assurance'],
      prohibitedUses: [],
      allowedLocales: ['pt-BR'],
      consent: { status: 'not-required', allowedUses: [] },
    },
    createdBy: { type: 'system', id: 'golden-worker' },
    createdAt: '2026-07-14T12:00:00.000Z',
  })
  const evaluatedAt = new Date('2026-07-14T12:00:00.000Z')
  const authorization = createMaterializationAuthorization({
    id: 'golden-authorization',
    workspaceId: 'golden-workspace',
    artifactId: 'golden-output-artifact',
    manifestId: 'golden-output-manifest',
    inputHash: input.inputHash,
    use: 'quality-assurance',
    locale: 'pt-BR',
    syntheticOperations: [],
    issues: [],
    decisions: [
      {
        artifactId: 'golden-source-artifact',
        assetOrdinal: 0,
        assetKind: 'video',
        ...evaluateAssetUse(
          rights,
          { workspaceId: 'golden-workspace', use: 'quality-assurance', locale: 'pt-BR' },
          evaluatedAt,
        ),
      },
    ],
    evaluatedAt: evaluatedAt.toISOString(),
    actor: { type: 'api-client', id: 'golden-client' },
  })
  const resolver = new LocalArtifactRenderInputResolver(
    {
      v2MediaArtifact: {
        async findFirst() {
          return {
            id: 'golden-source-artifact',
            workspaceId: 'golden-workspace',
            artifactKey,
            sha256: sourceSha256,
            byteSize: BigInt(sourceMetadata.size),
            mediaType: 'video',
            status: 'available',
          }
        },
      },
    },
    { root: artifactRoot, workspaceId: 'golden-workspace' },
  )
  const materialize = materializeAuthorizedRenderInputService({
    artifacts: {
      async findById() {
        return {
          id: 'golden-output-artifact',
          manifests: [
            {
              id: 'golden-output-manifest',
              renderInput: {
                ref: `render-input/sha256/${input.inputHash}`,
                inputHash: input.inputHash,
              },
            },
          ],
        }
      },
    },
    protectedRenderInputs: { async read() { return input } },
    assetAvailability: { async inspect() { return { available: true } } },
    targets: { supportsRenderer() { return true }, supportsComposition() { return true } },
    rights: {
      async findCurrentForArtifacts() {
        return new Map([['golden-source-artifact', rights]])
      },
    },
    authorizations: { async findById() { return authorization } },
    resolverForWorkspace: () => resolver,
    clock: () => new Date('2026-07-14T12:01:00.000Z'),
  })
  const outputKey = 'workspaces/golden/renders/smoke.mp4'
  const render = renderAuthorizedInputService({
    materialize,
    renderer: new RemotionRenderInputRenderer({
      projectRoot: process.cwd(),
      outputRoot,
      timeoutMs: 120_000,
      createId: () => 'golden-stage',
      clock: () => new Date('2026-07-14T12:02:00.000Z'),
    }),
    outputKeyFor: () => outputKey,
  })
  const receipt = await render({
    workspaceId: 'golden-workspace',
    authorizationId: 'golden-authorization',
  })

  const outputPath = path.join(outputRoot, ...outputKey.split('/'))
  const probe = await probeVideo(outputPath)
  assert.deepEqual(
    { width: probe.width, height: probe.height, fps: probe.fps },
    { width: 270, height: 480, fps: 30 },
  )
  assert.ok(probe.duration >= 0.9 && probe.duration <= 1.1)
  assert.equal(receipt.output.outputSha256, await calculateFileSha256(outputPath))
  assert.equal(receipt.output.byteSize, (await stat(outputPath)).size)
  const serialized = JSON.stringify(receipt)
  assert.equal(serialized.includes('file:'), false)
  assert.equal(serialized.includes(artifactKey), false)
  assert.equal(serialized.includes(directory), false)
  const recovered = await render({
    workspaceId: 'golden-workspace',
    authorizationId: 'golden-authorization',
  })
  assert.equal(recovered.output.outputSha256, receipt.output.outputSha256)
  assert.match(recovered.output.stageId, /^recovered-/)
  assert.equal(JSON.stringify(recovered).includes(outputKey), false)
  const outputEntries = await readdir(path.dirname(outputPath))
  assert.deepEqual(outputEntries, ['smoke.mp4'])
})
