import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { evaluateAssetUse, createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { createReconstructableMediaArtifactManifest } from '../../src/v2/domain/media-artifact.ts'
import { createMaterializationAuthorization } from '../../src/v2/domain/materialization-authorization.ts'
import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import { assertRenderInputPayload } from '../../src/v2/domain/render-input-payload.ts'
import { authorizeRenderInputMaterializationService } from '../../src/v2/application/authorize-render-input-materialization.ts'
import { materializeAuthorizedRenderInputService } from '../../src/v2/application/materialize-authorized-render-input.ts'
import { renderAuthorizedInputService } from '../../src/v2/application/render-authorized-input.ts'
import { LocalArtifactRenderInputResolver } from '../../src/v2/infrastructure/local-artifact-render-input-resolver.ts'
import { S3ArtifactRenderInputResolver } from '../../src/v2/infrastructure/s3-artifact-render-input-resolver.ts'
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

async function serveVersionedSource(filePath) {
  const metadata = await stat(filePath)
  let getCount = 0
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/source.mp4' || url.searchParams.get('versionId') !== 'render-version-1') {
      response.writeHead(404).end(); return
    }
    const common = { 'accept-ranges': 'bytes', 'content-type': 'video/mp4' }
    if (request.method === 'HEAD') {
      response.writeHead(200, { ...common, 'content-length': metadata.size }).end(); return
    }
    if (request.method !== 'GET') { response.writeHead(405).end(); return }
    getCount += 1
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '')
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Math.min(Number(match[2]), metadata.size - 1) : metadata.size - 1
    response.writeHead(match ? 206 : 200, {
      ...common,
      'content-length': end - start + 1,
      ...(match ? { 'content-range': `bytes ${start}-${end}/${metadata.size}` } : {}),
    })
    createReadStream(filePath, { start, end }).pipe(response)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  return {
    uri: `http://127.0.0.1:${address.port}/source.mp4?versionId=render-version-1&X-Amz-Expires=120&X-Amz-Signature=${'a'.repeat(64)}`,
    getCount: () => getCount,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

async function findLocalTestFont() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'consola.ttf'),
        path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'arial.ttf'),
      ]
    : [
        '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
        '/usr/share/fonts/truetype/liberation2/LiberationMono-Regular.ttf',
      ]
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {}
  }
  return null
}

async function decodedFrameHash(videoPath, second = 1) {
  const { stdout } = await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', videoPath,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 })
  return createHash('sha256').update(stdout).digest('hex')
}

async function decodedTrackHash(videoPath, track) {
  const { stdout } = await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-i', videoPath,
    '-map', `0:${track}:0`, '-f', 'framemd5', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 })
  return createHash('sha256').update(stdout).digest('hex')
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
              sources: [{
                artifactKey,
                sha256: sourceSha256,
                role: 'primary',
              }],
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

  const objectServer = await serveVersionedSource(sourcePath)
  context.after(() => objectServer.close())
  const s3Resolver = new S3ArtifactRenderInputResolver(
    { v2MediaArtifact: { async findFirst() { return {
      id: 'golden-source-artifact', workspaceId: 'golden-workspace', artifactKey,
      sha256: sourceSha256, byteSize: BigInt(sourceMetadata.size), mediaType: 'video', status: 'available',
    } } } },
    'golden-workspace',
    { async resolve(asset) { return { uri: objectServer.uri, sha256: asset.sha256, byteSize: asset.byteSize } } },
    resolver,
    '2026-07-14T12:06:00.000Z',
  )
  const s3Materialize = materializeAuthorizedRenderInputService({
    artifacts: { async findById() { return { id: 'golden-output-artifact', manifests: [{ id: 'golden-output-manifest', renderInput: { ref: `render-input/sha256/${input.inputHash}`, inputHash: input.inputHash }, sources: [{ artifactKey, sha256: sourceSha256, role: 'primary' }] }] } } },
    protectedRenderInputs: { async read() { return input } },
    assetAvailability: { async inspect() { return { available: true } } },
    targets: { supportsRenderer() { return true }, supportsComposition() { return true } },
    rights: { async findCurrentForArtifacts() { return new Map([['golden-source-artifact', rights]]) } },
    authorizations: { async findById() { return authorization } },
    resolverForWorkspace: () => s3Resolver,
    clock: () => new Date('2026-07-14T12:01:00.000Z'),
  })
  const s3OutputKey = 'workspaces/golden/renders/smoke-s3.mp4'
  const s3Receipt = await renderAuthorizedInputService({
    materialize: s3Materialize,
    renderer: new RemotionRenderInputRenderer({ projectRoot: process.cwd(), outputRoot, timeoutMs: 120_000, createId: () => 'golden-s3-stage', clock: () => new Date('2026-07-14T12:02:00.000Z') }),
    outputKeyFor: () => s3OutputKey,
  })({ workspaceId: 'golden-workspace', authorizationId: 'golden-authorization' })
  const s3OutputPath = path.join(outputRoot, ...s3OutputKey.split('/'))
  assert.equal(s3Receipt.output.outputSha256, await calculateFileSha256(s3OutputPath))
  assert.ok(objectServer.getCount() > 0)
  assert.equal(JSON.stringify(s3Receipt).includes('X-Amz-'), false)
  assert.deepEqual((await readdir(path.dirname(outputPath))).sort(), ['smoke-s3.mp4', 'smoke.mp4'])
})

test('T-FR-234 real Remotion output consumes the exact materialized font and typed data bytes', { timeout: 240_000 }, async (context) => {
  const sourceFont = await findLocalTestFont()
  if (!sourceFont) {
    context.skip('No local TrueType font is available for the real font-consumption golden')
    return
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apollo-remotion-resources-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const outputRoot = path.join(directory, 'outputs')
  const sourcePath = path.join(directory, 'source.mp4')
  const fontPath = path.join(directory, 'brand-mono.ttf')
  const dataPath = path.join(directory, 'hook.json')
  await mkdir(outputRoot, { recursive: true })
  await createSource(sourcePath)
  await copyFile(sourceFont, fontPath)
  const dataBytes = Buffer.from(JSON.stringify({
    schemaVersion: 'apollo-video-render-data/v1',
    hookTitle: 'FONTE E DADOS REAIS',
  }))
  await writeFile(dataPath, dataBytes)
  const sourceBytes = await stat(sourcePath)
  const fontBytes = await stat(fontPath)
  const sourceSha256 = await calculateFileSha256(sourcePath)
  const fontSha256 = await calculateFileSha256(fontPath)
  const dataSha256 = createHash('sha256').update(dataBytes).digest('hex')
  const asset = (input) => Object.freeze(input)
  const videoAsset = asset({
    id: 'primary-video', artifactId: 'artifact-resource-video', artifactKey: 'resources/source.mp4',
    kind: 'video', role: 'primary', ordinal: 0, sha256: sourceSha256,
    byteSize: sourceBytes.size, uri: pathToFileURL(sourcePath).href,
  })
  const fontAsset = asset({
    id: 'brand-font', artifactId: 'artifact-resource-font', artifactKey: 'resources/brand-mono.ttf',
    kind: 'font', role: 'hook-font', ordinal: 1, sha256: fontSha256,
    byteSize: fontBytes.size, uri: pathToFileURL(fontPath).href,
  })
  const dataAsset = asset({
    id: 'hook-data', artifactId: 'artifact-resource-data', artifactKey: 'resources/hook.json',
    kind: 'data', role: 'hook-copy', ordinal: 2, sha256: dataSha256,
    byteSize: dataBytes.byteLength, uri: pathToFileURL(dataPath).href,
  })
  const common = {
    schemaVersion: 'materialized-render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: '1'.repeat(64) },
    composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
    plan: { id: 'plan-resource-golden', versionId: 'version-resource-golden', hash: '2'.repeat(64) },
    output: {
      id: 'resource-golden-9x16', locale: 'pt-BR', aspectRatio: '9:16', width: 270, height: 480,
      fps: 30, safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, durationInFrames: 90,
    },
  }
  const palette = {
    primary: '#FFB800', secondary: '#20202A', accent: '#FF6B35', text: '#FFFFFF', background: '#050508',
  }
  const props = (extra = {}) => ({
    primaryVideoAssetId: 'primary-video', scenes: [], subtitles: [], palette, ...extra,
  })
  const inputs = [
    {
      ...common, inputHash: '3'.repeat(64), assets: [videoAsset, fontAsset, dataAsset],
      props: props({ fontAssetId: 'brand-font', renderDataAssetId: 'hook-data' }),
    },
    {
      ...common, inputHash: '4'.repeat(64), assets: [videoAsset, dataAsset],
      props: props({ renderDataAssetId: 'hook-data' }),
    },
    {
      ...common, inputHash: '5'.repeat(64), assets: [videoAsset, fontAsset],
      props: props({ fontAssetId: 'brand-font' }),
    },
  ]
  let stage = 0
  const renderer = new RemotionRenderInputRenderer({
    projectRoot: process.cwd(), outputRoot, timeoutMs: 180_000,
    createId: () => `resource-stage-${++stage}`,
    clock: () => new Date('2026-08-01T12:00:00.000Z'),
  })
  const paths = []
  for (const [index, input] of inputs.entries()) {
    const outputKey = `resources/render-${index}.mp4`
    const staged = await renderer.stage(input, { outputKey })
    await staged.commit()
    paths.push(path.join(outputRoot, ...outputKey.split('/')))
  }
  const [fontAndData, dataOnly, fontOnly] = await Promise.all(paths.map((item) => decodedFrameHash(item)))
  assert.notEqual(fontAndData, dataOnly, 'removing the declared font must change decoded pixels')
  assert.notEqual(fontAndData, fontOnly, 'removing the declared data must remove its visible title')

  await writeFile(dataPath, Buffer.from(JSON.stringify({
    schemaVersion: 'apollo-video-render-data/v1', hookTitle: 'BYTES E DADOS REAIS',
  })))
  await assert.rejects(
    () => renderer.stage(inputs[0], { outputKey: 'resources/tampered.mp4' }),
    (error) => error.code === 'INVALID_RENDER_INPUT' && /identity changed/.test(error.message),
  )
  const invalidUriInput = {
    ...inputs[0],
    assets: inputs[0].assets.map((item) => item.id === 'hook-data'
      ? { ...item, uri: 'not-a-materialized-uri' }
      : item),
  }
  await assert.rejects(
    () => renderer.stage(invalidUriInput, { outputKey: 'resources/invalid-uri.mp4' }),
    (error) => error.code === 'INVALID_RENDER_INPUT' && /URI is invalid/.test(error.message),
  )
})

test('T-FR-234 saved manifest and protected RenderInput alone reconstruct the same decoded golden', { timeout: 240_000 }, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'apollo-remotion-reconstruct-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const workspaceId = 'workspace-reconstruct'
  const artifactRoot = path.join(directory, 'artifacts')
  const outputRoot = path.join(directory, 'outputs')
  const fixturePath = path.join(directory, 'persisted-reconstruction.json')
  const sourceKey = 'workspaces/reconstruct/masters/source.mp4'
  const dataKey = 'workspaces/reconstruct/data/hook.json'
  const sourcePath = path.join(artifactRoot, ...sourceKey.split('/'))
  const dataPath = path.join(artifactRoot, ...dataKey.split('/'))
  await mkdir(path.dirname(sourcePath), { recursive: true })
  await mkdir(path.dirname(dataPath), { recursive: true })
  await mkdir(outputRoot, { recursive: true })
  await createSource(sourcePath)
  const dataBytes = Buffer.from(JSON.stringify({
    schemaVersion: 'apollo-video-render-data/v1',
    hookTitle: 'RECONSTRUCAO PELO MANIFEST',
  }))
  await writeFile(dataPath, dataBytes)
  const sourceMetadata = await stat(sourcePath)
  const sourceSha256 = await calculateFileSha256(sourcePath)
  const dataSha256 = createHash('sha256').update(dataBytes).digest('hex')
  const input = createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: { id: 'remotion', version: '4.0.489', digest: '6'.repeat(64) },
    composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
    plan: { id: 'plan-reconstruct', versionId: 'version-reconstruct', hash: '7'.repeat(64) },
    output: {
      id: 'reconstruct-9x16', locale: 'pt-BR', aspectRatio: '9:16', width: 270, height: 480,
      fps: 30, safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, durationInFrames: 30,
    },
    assets: [
      {
        id: 'primary-video', artifactId: 'artifact-reconstruct-source', artifactKey: sourceKey,
        kind: 'video', role: 'primary', ordinal: 0, sha256: sourceSha256, byteSize: sourceMetadata.size,
      },
      {
        id: 'hook-data', artifactId: 'artifact-reconstruct-data', artifactKey: dataKey,
        kind: 'data', role: 'hook-copy', ordinal: 1, sha256: dataSha256, byteSize: dataBytes.byteLength,
      },
    ],
    props: {
      primaryVideoAssetId: 'primary-video', renderDataAssetId: 'hook-data', scenes: [], subtitles: [],
      palette: { primary: '#FFB800', secondary: '#20202A', accent: '#FF6B35', text: '#FFFFFF', background: '#050508' },
    },
  })
  const reconstructable = createReconstructableMediaArtifactManifest({
    artifactKey: 'workspaces/reconstruct/renders/original.mp4',
    artifactSha256: '8'.repeat(64), byteSize: 1, mediaType: 'video', container: 'mp4',
    recipe: { id: 'render-apollo-video', version: 'v1', parameters: { inputHash: input.inputHash } },
    sources: input.assets.map((item) => ({
      artifactKey: item.artifactKey, sha256: item.sha256, role: item.role,
      execution: { tool: { ...input.renderer } },
    })),
    renderInput: input,
  })
  const rights = input.assets.map((item, index) => createAssetRightsSnapshot({
    id: `rights-reconstruct-${index}`, workspaceId, artifactId: item.artifactId, sequence: 1,
    draft: {
      status: 'approved', allowedUses: ['quality-assurance'], prohibitedUses: [], allowedLocales: ['pt-BR'],
      consent: { status: 'not-required', allowedUses: [] },
    },
    createdBy: { type: 'system', id: 'reconstruction-fixture' },
    createdAt: '2026-08-01T12:00:00.000Z',
  }))
  const persistedManifest = {
    id: 'manifest-reconstruct',
    schemaVersion: reconstructable.manifest.schemaVersion,
    manifestHash: reconstructable.manifest.manifestHash,
    recipe: reconstructable.manifest.recipe,
    renderInput: {
      ...reconstructable.manifest.renderInput,
      canonicalByteSize: reconstructable.renderInput.canonicalByteSize,
      algorithm: 'aes-256-gcm',
    },
    sources: reconstructable.manifest.sources.map((item, index) => ({
      ...item, artifactId: input.assets[index].artifactId, ordinal: index,
    })),
    createdAt: '2026-08-01T12:00:00.000Z',
  }
  await writeFile(fixturePath, JSON.stringify({
    artifact: {
      id: 'artifact-reconstruct-output', workspaceId,
      artifactKey: reconstructable.manifest.artifact.artifactKey,
      sha256: reconstructable.manifest.artifact.sha256,
      byteSize: reconstructable.manifest.artifact.byteSize,
      mediaType: 'video', container: 'mp4', status: 'available',
      manifests: [persistedManifest], createdAt: '2026-08-01T12:00:00.000Z',
    },
    renderInput: reconstructable.renderInput,
    rights,
    assets: input.assets,
  }))

  // Everything below this boundary is rehydrated from the saved fixture. No
  // in-memory props, manifest, rights or asset identity above is consulted.
  const saved = JSON.parse(await readFile(fixturePath, 'utf8'))
  assertRenderInputPayload(saved.renderInput)
  const artifact = { ...saved.artifact, byteSize: BigInt(saved.artifact.byteSize) }
  const storedAssets = new Map(saved.assets.map((item) => [item.artifactId, item]))
  const rightsByArtifact = new Map(saved.rights.map((item) => [item.artifactId, item]))
  const authorizations = new Map()
  let authorizationSequence = 0
  const authorizationRepository = {
    async findById(_workspaceId, id) { return authorizations.get(id) ?? null },
    async findReplay() { return null },
    async createOrReplay({ authorization }) {
      authorizations.set(authorization.id, authorization)
      return { authorization, replayed: false }
    },
  }
  const protectedRenderInputs = {
    async read(_workspaceId, ref, inputHash) {
      if (ref !== saved.renderInput.ref || inputHash !== saved.renderInput.inputHash) return null
      assertRenderInputPayload(saved.renderInput)
      return JSON.parse(saved.renderInput.canonicalJson)
    },
  }
  const artifactRepository = {
    async findById(requestWorkspaceId, id) {
      return requestWorkspaceId === workspaceId && id === artifact.id ? artifact : null
    },
  }
  const targets = { supportsRenderer() { return true }, supportsComposition() { return true } }
  const assetAvailability = {
    async inspect(requestWorkspaceId, item) {
      const stored = storedAssets.get(item.artifactId)
      return { available: requestWorkspaceId === workspaceId && stored?.sha256 === item.sha256 }
    },
  }
  const rightsRepository = {
    async findCurrentForArtifacts(_workspaceId, ids) {
      return new Map(ids.map((id) => [id, rightsByArtifact.get(id)]).filter((entry) => entry[1]))
    },
  }
  const luts = { async readVersion() { return null } }
  const clock = () => new Date('2026-08-01T12:01:00.000Z')
  const authorize = authorizeRenderInputMaterializationService({
    artifactRepository, protectedRenderInputs, assetAvailability, targets,
    rights: rightsRepository, luts, authorizations: authorizationRepository,
    clock, createId: () => `authorization-reconstruct-${++authorizationSequence}`,
  })
  const resolver = new LocalArtifactRenderInputResolver({
    v2MediaArtifact: {
      async findFirst({ where }) {
        const item = storedAssets.get(where.id)
        return item && where.workspaceId === workspaceId
          ? { ...item, workspaceId, byteSize: BigInt(item.byteSize), mediaType: item.kind, status: 'available' }
          : null
      },
    },
  }, { root: artifactRoot, workspaceId })
  const materialize = materializeAuthorizedRenderInputService({
    artifacts: artifactRepository, protectedRenderInputs, assetAvailability, targets,
    rights: rightsRepository, luts, authorizations: authorizationRepository,
    resolverForWorkspace: () => resolver, clock,
  })
  const renderer = new RemotionRenderInputRenderer({
    projectRoot: process.cwd(), outputRoot, timeoutMs: 180_000,
    createId: (() => { let value = 0; return () => `reconstruct-stage-${++value}` })(),
    clock,
  })
  const render = renderAuthorizedInputService({
    materialize, renderer,
    outputKeyFor: ({ authorizationId }) => `reconstructed/${authorizationId}.mp4`,
  })
  const paths = []
  for (const idempotencyKey of ['reconstruct-one', 'reconstruct-two']) {
    const result = await authorize({
      workspaceId, artifactId: artifact.id, manifestId: persistedManifest.id,
      use: 'quality-assurance', actor: { type: 'api-client', id: 'reconstruction-client' }, idempotencyKey,
    })
    const receipt = await render({ workspaceId, authorizationId: result.authorization.id })
    assert.equal(receipt.inputHash, saved.renderInput.inputHash)
    paths.push(path.join(outputRoot, ...receipt.getOutputKey().split('/')))
  }
  const probes = await Promise.all(paths.map((item) => probeVideo(item)))
  assert.ok(probes.every((probe) =>
    probe.width === 270 && probe.height === 480 && probe.fps === 30 &&
    Math.abs(probe.duration - 1) <= 0.1))
  assert.equal(probes[1].duration, probes[0].duration)
  const [firstVideo, secondVideo, firstAudio, secondAudio] = await Promise.all([
    decodedTrackHash(paths[0], 'v'), decodedTrackHash(paths[1], 'v'),
    decodedTrackHash(paths[0], 'a'), decodedTrackHash(paths[1], 'a'),
  ])
  assert.equal(secondVideo, firstVideo, 'reconstruction must preserve every decoded video frame')
  assert.equal(secondAudio, firstAudio, 'reconstruction must preserve every decoded audio frame')
})
