import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import { createEditorialAudioTimelineHash } from '../../src/v2/domain/production-modes.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createMediaColorProbe } from '../../src/v2/domain/color-and-export.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
import { FFMPEG_EDITORIAL_RENDERER_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { FfmpegEditorialProxyRenderer } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { FfmpegEditorialRenderInputRenderer } from '../../src/v2/infrastructure/ffmpeg-editorial-render-input-renderer.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'
import { createConfiguredRenderTargetRegistry } from '../../src/v2/infrastructure/render-target-registry.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const metadata = { colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 }
const artifactId = 'artifact-editorial-reconstruct-source'
const manifestId = 'manifest-editorial-reconstruct-source'
const projectVersionId = 'project-version-editorial-reconstruct'

function colorCompilation() {
  const probe = createMediaColorProbe({ id: 'probe-editorial-reconstruct', workspaceId: 'workspace-editorial-reconstruct', artifactId, manifestId,
    detection: { state: 'ready', metadata, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
    producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) }, createdAt: '2026-10-05T12:00:00.000Z' })
  const implementation = (provider, parameters) => ({ provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters) })
  return createColorPipelineCompilation({ id: 'compilation-editorial-reconstruct', workspaceId: probe.workspaceId,
    projectId: 'project-editorial-reconstruct', sourceArtifactId: artifactId, sourceManifestId: manifestId, probe,
    outputMetadata: metadata, createdByClientId: 'client-editorial-reconstruct', createdAt: '2026-10-05T12:01:00.000Z', stages: [
      { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: metadata, output: metadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
      { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: metadata, output: metadata, implementation: implementation('apollo-match', { mode: 'bypass' }) },
      { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: metadata, output: metadata, implementation: implementation('apollo-lut', { mode: 'none' }) },
      { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: metadata, output: metadata, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
    ] })
}

test('approved FFmpeg final reconstructs exact MP4 bytes from materialized input, and incomplete props fail closed', { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-editorial-reconstruct-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source.mp4')
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], { windowsHide: true, timeout: 30_000 })
  const compilation = colorCompilation()
  const clips = [{ id: 'clip-editorial-reconstruct', sourceArtifactId: artifactId, sourceInFrame: 0, sourceOutFrame: 30,
    timelineInFrame: 0, timelineOutFrame: 30, rate: 1 }]
  // A real MOV source can probe at 30.000000097244733 while its final output is 30 fps.
  // The approved Director audio identity retains that probe precision; the renderer targets 30.
  const approvedPlanFps = 30.000000097244733
  const audioTimelineHash = createEditorialAudioTimelineHash({ fps: approvedPlanFps, clips })
  const editPlan = { schemaVersion: 2, state: 'compiled', id: 'edit-plan-editorial-reconstruct', projectVersionId,
    fps: approvedPlanFps, videoTracks: [{ kind: 'base-video', clips }], subtitleTracks: [], transitions: [], audioTracks: [], movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 } }
  const expected = await new FfmpegEditorialProxyRenderer({ workRoot: join(root, 'original-work'), ffmpegPath }).render({
    operationId: 'original-final', renderKind: 'final', sources: [{ artifactId, path: source, mediaType: 'video', colorPipelineCompilation: compilation }],
    lutPaths: {}, clips, audioTimelineHash, fps: 30, format: '16:9', outputSpec: { width: 320, height: 180, fps: 30 }, subtitleCues: [], transitions: [],
  })
  const props = { renderSchemaVersion: 'apollo-editorial-final/v2', editPlan,
    outputSpec: { aspectRatio: '16:9', width: 320, height: 180, fps: 30, codec: 'h264', audioCodec: 'aac', container: 'mp4', quality: 'final' },
    sourceArtifactIds: [artifactId], audioTimelineHash,
    colorPipelineBindings: [{ sourceArtifactId: artifactId, sourceManifestId: manifestId, compilationId: compilation.id,
      compilationHash: compilation.compilationHash, pipelineHash: compilation.pipeline.pipelineHash }],
    colorPipelineCompilations: [compilation], colorPlan: null, lutBindings: [], colorPlanHash: null,
    compiledColorPlanManifestHash: null, projectLutSelectionHash: '1'.repeat(64), materializedCubeHash: null, materializedCubeHashes: [],
    expectedOutputSha256: expected.sha256, expectedOutputByteSize: expected.byteSize, ffmpegBinarySha256: expected.ffmpegBinarySha256 }
  const spec = createRenderInputSpec({ schemaVersion: 'render-input/v1', renderer: { id: 'ffmpeg', version: 'static',
    digest: createHash('sha256').update(`apollo-v2-ffmpeg-editorial/${FFMPEG_EDITORIAL_RENDERER_VERSION}`).digest('hex') },
  composition: { id: 'apollo-editorial', version: 'v2', propsSchemaRef: 'apollo://render-props/apollo-editorial/v2' },
  plan: { id: editPlan.id, versionId: projectVersionId, hash: '2'.repeat(64) },
  output: { id: 'final-16-9', locale: 'pt-BR', aspectRatio: '16:9', width: 320, height: 180, fps: 30,
    safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, durationInFrames: 30 },
  assets: [{ id: 'asset-1', artifactId, artifactKey: 'masters/reconstruction-source.mp4', kind: 'video', role: 'source-master', ordinal: 0,
    sha256: await calculateFileSha256(source), byteSize: (await stat(source)).size }], props })
  const input = { ...spec, assets: spec.assets.map((asset) => ({ ...asset, uri: pathToFileURL(source).href })) }
  const registry = createConfiguredRenderTargetRegistry({ APOLLO_RENDERER_DIGEST: '0'.repeat(64) })
  assert.equal(registry.supportsRenderer(input.renderer), true)
  assert.equal(registry.supportsComposition(input.composition), true)
  const outputRoot = join(root, 'outputs')
  const adapter = new FfmpegEditorialRenderInputRenderer({ outputRoot, workRoot: join(root, 'reconstruction-work') })
  const key = 'workspaces/test/renders/final.mp4'
  assert.equal(await adapter.recover(input, { outputKey: key }), null)
  const staged = await adapter.stage(input, { outputKey: key })
  assert.equal(staged.receipt.outputSha256, expected.sha256)
  const committed = await staged.commit()
  assert.equal(committed.outputSha256, expected.sha256)
  assert.equal((await adapter.recover(input, { outputKey: key })).outputSha256, expected.sha256)
  let slowDownloadCompleted = false
  const mediaServer = createServer((request, response) => {
    if (request.url === '/missing') { response.writeHead(404); response.end(); return }
    if (request.url === '/slow') {
      response.on('finish', () => { slowDownloadCompleted = true })
      setTimeout(() => { response.writeHead(200, { 'Content-Length': spec.assets[0].byteSize }); createReadStream(source).pipe(response) }, 100)
      return
    }
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': spec.assets[0].byteSize })
    createReadStream(source).pipe(response)
  })
  await new Promise((resolve) => mediaServer.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => mediaServer.close(resolve)))
  const port = mediaServer.address().port
  const remoteInput = { ...input, assets: [{ ...input.assets[0], uri: `http://127.0.0.1:${port}/signed-source` }] }
  const remote = await adapter.stage(remoteInput, { outputKey: 'workspaces/test/renders/from-http.mp4' })
  assert.equal((await remote.commit()).outputSha256, expected.sha256)
  const failedProps = { ...props, sourceArtifactIds: [artifactId, 'artifact-editorial-reconstruct-audio'] }
  const failedSpec = createRenderInputSpec({ schemaVersion: spec.schemaVersion, renderer: spec.renderer,
    composition: { id: spec.composition.id, version: spec.composition.version, propsSchemaRef: spec.composition.propsSchemaRef },
    plan: spec.plan, output: { id: spec.output.id, locale: spec.output.locale, aspectRatio: spec.output.aspectRatio,
      width: spec.output.width, height: spec.output.height, fps: spec.output.fps, safeArea: spec.output.safeArea,
      durationInFrames: spec.output.durationInFrames },
    assets: [spec.assets[0], { ...spec.assets[0], id: 'asset-2', artifactId: 'artifact-editorial-reconstruct-audio',
      artifactKey: 'masters/reconstruction-audio.mp4', kind: 'audio', ordinal: 1 }], props: failedProps })
  const failedInput = { ...failedSpec, assets: failedSpec.assets.map((asset, index) => ({ ...asset,
    uri: `http://127.0.0.1:${port}/${index === 0 ? 'missing' : 'slow'}` })) }
  await assert.rejects(adapter.stage(failedInput, { outputKey: 'workspaces/test/renders/failed-download.mp4' }),
    (error) => error.code === 'INVALID_RENDER_INPUT')
  assert.equal(slowDownloadCompleted, true, 'failure waits for the other owned download before cleanup')
  assert.deepEqual(await readdir(join(root, 'reconstruction-work')), [])
  assert.equal(registry.supportsRenderer({ ...input.renderer, version: 'other' }), false)
  assert.equal(registry.supportsComposition({ ...input.composition, id: 'unsupported-editorial' }), false)
  const specWithProps = (nextProps) => createRenderInputSpec({ schemaVersion: spec.schemaVersion, renderer: spec.renderer, composition: {
    id: spec.composition.id, version: spec.composition.version, propsSchemaRef: spec.composition.propsSchemaRef },
  plan: spec.plan, output: { id: spec.output.id, locale: spec.output.locale, aspectRatio: spec.output.aspectRatio,
    width: spec.output.width, height: spec.output.height, fps: spec.output.fps, safeArea: spec.output.safeArea,
    durationInFrames: spec.output.durationInFrames }, assets: spec.assets, props: nextProps })
  const { colorPipelineCompilations: _missing, ...incompleteProps } = props
  const incomplete = specWithProps(incompleteProps)
  await assert.rejects(adapter.stage({ ...incomplete, assets: input.assets }, { outputKey: 'workspaces/test/renders/invalid.mp4' }),
    (error) => error.code === 'INVALID_RENDER_INPUT')
  const wrongBinary = specWithProps({ ...props, ffmpegBinarySha256: '0'.repeat(64) })
  await assert.rejects(adapter.stage({ ...wrongBinary, assets: input.assets }, { outputKey: 'workspaces/test/renders/wrong-binary.mp4' }),
    (error) => error.code === 'INVALID_RENDER_INPUT')
  const wrongExpectedHash = specWithProps({ ...props, expectedOutputSha256: '0'.repeat(64) })
  await assert.rejects(adapter.stage({ ...wrongExpectedHash, assets: input.assets }, { outputKey: 'workspaces/test/renders/wrong-output.mp4' }),
    (error) => error.code === 'INVALID_RENDER_INPUT')
  const wrongPlanFps = specWithProps({ ...props, editPlan: { ...editPlan, fps: 30.02 } })
  await assert.rejects(adapter.stage({ ...wrongPlanFps, assets: input.assets }, { outputKey: 'workspaces/test/renders/wrong-fps.mp4' }),
    (error) => error.code === 'INVALID_RENDER_INPUT')
  assert.equal(await stat(join(outputRoot, 'workspaces', 'test', 'renders', 'wrong-output.mp4')).catch(() => null), null)
})
