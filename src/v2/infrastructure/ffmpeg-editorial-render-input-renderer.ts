import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EditorialCutClip, EditorialCutEditPlan } from '../application/apply-editorial-cut-command.ts'
import type { RenderInputRenderer, StagedRender } from '../application/ports/render-input-renderer.ts'
import type { ColorPipelineCompilation } from '../domain/color-pipeline-compilation.ts'
import { createDirectedAudioTimelineHash, type DirectedEditPlan } from '../domain/director-run.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { assertRenderInputSpec, type MaterializedRenderInputAsset, type MaterializedRenderInputV1 } from '../domain/render-input.ts'
import { createEditorialAudioTimelineHash } from '../domain/production-modes.ts'
import { parseProjectColorPlan, type ProjectColorPlan } from '../domain/project-color-plan.ts'
import { FFMPEG_EDITORIAL_RENDERER_VERSION } from '../application/ports/editorial-proxy-renderer.ts'
import { FfmpegEditorialProxyRenderer } from './media/ffmpeg-editorial-proxy-renderer.ts'
import { resolveFfmpegBinary } from './media/ffmpeg-binary.ts'
import { calculateFileSha256 } from './media/local-artifact-manifest.ts'
import { probeVideo } from './media/video-probe.ts'

type EditorialPlan = EditorialCutEditPlan | DirectedEditPlan
const SHA256 = /^[a-f0-9]{64}$/
const rendererDigest = createHash('sha256').update(`apollo-v2-ffmpeg-editorial/${FFMPEG_EDITORIAL_RENDERER_VERSION}`).digest('hex')

function invalid(message: string): never { throw new DomainError('INVALID_RENDER_INPUT', message) }
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function contained(root: string, path: string): boolean { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel) }

function editorialProps(input: MaterializedRenderInputV1) {
  assertRenderInputSpec({ ...input, assets: input.assets.map(({ uri: _uri, ...asset }) => asset) })
  if (input.renderer.id !== 'ffmpeg' || input.renderer.version !== 'static' || input.renderer.digest !== rendererDigest ||
    input.composition.id !== 'apollo-editorial' || input.composition.version !== 'v2' ||
    input.composition.propsSchemaRef !== 'apollo://render-props/apollo-editorial/v2') invalid('Editorial reconstruction target is unsupported')
  const props = input.props as Record<string, unknown>
  if (props.renderSchemaVersion !== 'apollo-editorial-final/v2' || !object(props.editPlan) || !object(props.outputSpec) ||
    !Array.isArray(props.sourceArtifactIds) || !Array.isArray(props.colorPipelineBindings) ||
    !Array.isArray(props.colorPipelineCompilations) || !Array.isArray(props.lutBindings) ||
    typeof props.audioTimelineHash !== 'string' || typeof props.expectedOutputSha256 !== 'string' ||
    typeof props.ffmpegBinarySha256 !== 'string' || !SHA256.test(props.ffmpegBinarySha256) ||
    !SHA256.test(props.expectedOutputSha256) || !Number.isSafeInteger(props.expectedOutputByteSize) ||
    Number(props.expectedOutputByteSize) <= 0) invalid('Editorial final reconstruction props are incomplete')
  const editPlan = props.editPlan as unknown as EditorialPlan
  const outputSpec = props.outputSpec as Record<string, unknown>
  const sourceIds = props.sourceArtifactIds as string[]
  const sourceAssets = input.assets.slice(0, sourceIds.length)
  if (sourceIds.length < 1 || new Set(sourceIds).size !== sourceIds.length ||
    sourceAssets.some((asset, index) => asset.artifactId !== sourceIds[index] || !['video', 'audio'].includes(asset.kind)) ||
    input.assets.slice(sourceIds.length).some((asset) => asset.kind !== 'lut') ||
    editPlan.id !== input.plan.id || editPlan.projectVersionId !== input.plan.versionId ||
    !Array.isArray(editPlan.videoTracks) || !Array.isArray(editPlan.subtitleTracks) ||
    !Number.isFinite(editPlan.fps) || Math.abs(editPlan.fps - input.output.fps) > 0.01 || outputSpec.fps !== input.output.fps ||
    outputSpec.width !== input.output.width || outputSpec.height !== input.output.height ||
    outputSpec.aspectRatio !== input.output.aspectRatio || outputSpec.codec !== 'h264' ||
    outputSpec.audioCodec !== 'aac' || outputSpec.container !== 'mp4' || outputSpec.quality !== 'final') {
    invalid('Editorial final plan, assets or output specification changed')
  }
  const clips = (editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []) as readonly EditorialCutClip[]
  if (clips.length < 1 || clips.reduce((sum, clip) => sum + clip.sourceOutFrame - clip.sourceInFrame, 0) !== input.output.durationInFrames ||
    clips.some((clip) => !sourceIds.includes(clip.sourceArtifactId))) invalid('Editorial final clip timeline is invalid')
  const musicTracks = 'audioTracks' in editPlan && Array.isArray(editPlan.audioTracks) ? editPlan.audioTracks : []
  const actualAudioHash = musicTracks.length > 0
    ? createDirectedAudioTimelineHash({ fps: editPlan.fps, clips, musicTracks })
    : createEditorialAudioTimelineHash({ fps: editPlan.fps, clips })
  if (actualAudioHash !== props.audioTimelineHash) invalid('Editorial final audio timeline hash changed')
  const compilations = props.colorPipelineCompilations as unknown as ColorPipelineCompilation[]
  const bindings = props.colorPipelineBindings as unknown as Array<{ sourceArtifactId: string; sourceManifestId: string; compilationId: string; compilationHash: string; pipelineHash: string }>
  const videoAssets = sourceAssets.filter((asset) => asset.kind === 'video')
  if (compilations.length !== videoAssets.length || bindings.length !== videoAssets.length ||
    compilations.some((item) => {
      if (!object(item) || !object(item.pipeline) || !SHA256.test(item.compilationHash)) return true
      const { compilationHash, ...body } = item
      return calculateCanonicalHash(body) !== compilationHash
    }) ||
    bindings.some((item) => !object(item) || typeof item.sourceArtifactId !== 'string') ||
    videoAssets.some((asset) => {
      const compilation = compilations.find((item) => item.sourceArtifactId === asset.artifactId)
      const binding = bindings.find((item) => item.sourceArtifactId === asset.artifactId)
      return !compilation || !binding || compilation.id !== binding.compilationId ||
        compilation.sourceManifestId !== binding.sourceManifestId ||
        compilation.compilationHash !== binding.compilationHash || compilation.pipeline.pipelineHash !== binding.pipelineHash
    })) invalid('Editorial final color compilations do not match bound video assets')
  const lutBindings = props.lutBindings as unknown as Array<{ assetId: string; artifactId: string; parametersHash: string; cubeHash: string; intensity: number }>
  if (lutBindings.length !== input.assets.length - sourceIds.length || new Set(lutBindings.map((item) => item.assetId)).size !== lutBindings.length ||
    lutBindings.some((item) => {
      if (!object(item)) return true
      const asset = input.assets.find((candidate) => candidate.id === item.assetId)
      return !asset || asset.kind !== 'lut' || asset.artifactId !== item.artifactId || asset.role !== `creative-lut-${item.parametersHash}` ||
        !SHA256.test(item.parametersHash) || !SHA256.test(item.cubeHash) || !Number.isFinite(item.intensity)
    })) invalid('Editorial final LUT bindings are incomplete')
  const colorPlan = props.colorPlan === null ? null : parseProjectColorPlan(props.colorPlan)
  if ((colorPlan?.plan.planHash ?? null) !== props.colorPlanHash ||
    (colorPlan?.compiled.manifestHash ?? null) !== props.compiledColorPlanManifestHash) invalid('Editorial final ColorPlan identity changed')
  return { editPlan, clips, musicTracks, sourceAssets, compilations, lutBindings, colorPlan,
    expectedSha256: props.expectedOutputSha256, expectedByteSize: Number(props.expectedOutputByteSize),
    audioTimelineHash: props.audioTimelineHash }
}

async function assetPath(asset: MaterializedRenderInputAsset, directory: string, signal?: AbortSignal): Promise<string> {
  const url = new URL(asset.uri)
  if (url.protocol === 'file:') {
    const path = fileURLToPath(url)
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size !== asset.byteSize || await calculateFileSha256(path) !== asset.sha256) invalid('Editorial source bytes changed after authorization')
    return path
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) invalid('Editorial source URI is unsupported')
  const target = resolve(directory, `${asset.ordinal}-${asset.sha256}`)
  const transferSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000)
  const response = await fetch(url, { redirect: 'error', signal: transferSignal })
  if (!response.ok || !response.body) invalid('Editorial source could not be downloaded')
  let byteSize = 0
  const hash = createHash('sha256')
  const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    byteSize += chunk.length
    if (byteSize > asset.byteSize) return callback(new DomainError('INVALID_RENDER_INPUT', 'Editorial source exceeds its authorized byte size'))
    hash.update(chunk)
    callback(null, chunk)
  } })
  await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(target, { flags: 'wx' }), { signal: transferSignal })
  if (byteSize !== asset.byteSize || hash.digest('hex') !== asset.sha256) invalid('Editorial source download changed its immutable identity')
  return target
}

export class FfmpegEditorialRenderInputRenderer implements RenderInputRenderer {
  private readonly outputRoot: string
  private readonly workRoot: string
  private readonly renderer: FfmpegEditorialProxyRenderer
  private readonly binaryPath: string
  private readonly clock: () => Date

  constructor(options: { outputRoot: string; workRoot: string; ffmpegPath?: string; clock?: () => Date }) {
    if (!isAbsolute(options.outputRoot) || !isAbsolute(options.workRoot)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Editorial reconstruction roots must be absolute')
    this.outputRoot = resolve(options.outputRoot)
    this.workRoot = resolve(options.workRoot)
    this.binaryPath = resolveFfmpegBinary(options.ffmpegPath)
    this.renderer = new FfmpegEditorialProxyRenderer({ workRoot: this.workRoot, ffmpegPath: this.binaryPath })
    this.clock = options.clock ?? (() => new Date())
  }

  private async outputPath(outputKey: string, createParent: boolean): Promise<string> {
    if (!outputKey.endsWith('.mp4') || outputKey.split('/').some((part) => !part || part === '.' || part === '..') || outputKey.includes('\\')) invalid('Editorial output key is invalid')
    if (createParent) await mkdir(this.outputRoot, { recursive: true })
    const root = await realpath(this.outputRoot).catch((error: NodeJS.ErrnoException) => {
      if (!createParent && error.code === 'ENOENT') return null
      throw error
    })
    if (!root) return ''
    const path = resolve(root, ...outputKey.split('/'))
    if (!contained(root, path)) invalid('Editorial output escaped its configured root')
    if (createParent) await mkdir(dirname(path), { recursive: true })
    const parent = await realpath(dirname(path)).catch((error: NodeJS.ErrnoException) => {
      if (!createParent && error.code === 'ENOENT') return null
      throw error
    })
    if (!parent) return ''
    const canonical = resolve(parent, basename(path))
    if (!contained(root, canonical)) invalid('Editorial output escaped its configured root')
    return canonical
  }

  async recover(input: MaterializedRenderInputV1, request: { outputKey: string }) {
    const props = editorialProps(input)
    if (await calculateFileSha256(this.binaryPath) !== input.props.ffmpegBinarySha256) invalid('FFmpeg binary differs from the approved final render')
    const path = await this.outputPath(request.outputKey, false)
    if (!path) return null
    const metadata = await stat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (!metadata) return null
    if (!metadata.isFile() || metadata.size !== props.expectedByteSize || await calculateFileSha256(path) !== props.expectedSha256) invalid('Committed editorial output differs from its approved artifact')
    const probe = await probeVideo(path)
    if (probe.width !== input.output.width || probe.height !== input.output.height || Math.abs(probe.fps - input.output.fps) > 0.01 ||
      Math.abs(probe.duration - input.output.durationInFrames / input.output.fps) > Math.max(0.1, 3 / input.output.fps)) invalid('Committed editorial output failed technical validation')
    return Object.freeze({ schemaVersion: 'committed-render-receipt/v1' as const, stageId: `recovered-${props.expectedSha256.slice(0, 16)}`,
      inputHash: input.inputHash, outputSha256: props.expectedSha256, byteSize: metadata.size, width: probe.width, height: probe.height,
      fps: probe.fps, durationInFrames: input.output.durationInFrames, codec: 'h264' as const, container: 'mp4' as const, committedAt: metadata.mtime.toISOString() })
  }

  async stage(input: MaterializedRenderInputV1, request: { outputKey: string; signal?: AbortSignal }): Promise<StagedRender> {
    const props = editorialProps(input)
    if (await calculateFileSha256(this.binaryPath) !== input.props.ffmpegBinarySha256) invalid('FFmpeg binary differs from the approved final render')
    const finalPath = await this.outputPath(request.outputKey, true)
    if (await stat(finalPath).catch(() => null)) throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Editorial output already exists')
    const stageId = randomUUID()
    const operationId = `reconstruct-${stageId}`
    const workDirectory = resolve(this.workRoot, operationId)
    const partialPath = resolve(dirname(finalPath), `.${basename(finalPath, '.mp4')}.${stageId}.partial.mp4`)
    await mkdir(workDirectory, { recursive: true })
    try {
      const resolvedAssets = await Promise.allSettled(input.assets.map((asset) => assetPath(asset, workDirectory, request.signal)))
      const failedAsset = resolvedAssets.find((result) => result.status === 'rejected')
      if (failedAsset?.status === 'rejected') throw failedAsset.reason
      const paths = resolvedAssets.map((result) => (result as PromiseFulfilledResult<string>).value)
      const byAssetId = new Map(input.assets.map((asset, index) => [asset.id, paths[index]!]))
      const compilations = new Map(props.compilations.map((item) => [item.sourceArtifactId, item]))
      const lutPaths: Record<string, string> = {}
      for (const binding of props.lutBindings) {
        const path = byAssetId.get(binding.assetId)!
        lutPaths[`${binding.artifactId}:${binding.parametersHash}`] = path
      }
      if (props.lutBindings.length === 1) lutPaths[props.lutBindings[0]!.artifactId] = byAssetId.get(props.lutBindings[0]!.assetId)!
      const editPlan = props.editPlan
      const subtitleCues = editPlan.subtitleTracks.flatMap((track) => 'cues' in track ? track.cues : [])
      const render = await this.renderer.render({
        operationId, renderKind: 'final',
        sources: props.sourceAssets.map((asset) => ({ artifactId: asset.artifactId, path: byAssetId.get(asset.id)!, mediaType: asset.kind as 'video' | 'audio',
          ...(asset.kind === 'video' ? { colorPipelineCompilation: compilations.get(asset.artifactId)! } : {}) })),
        lutPaths, ...(props.colorPlan ? { colorPlan: props.colorPlan } : {}), clips: props.clips,
        audioTimelineHash: props.audioTimelineHash, fps: input.output.fps, format: input.output.aspectRatio,
        outputSpec: { width: input.output.width, height: input.output.height, fps: input.output.fps }, subtitleCues,
        transitions: 'transitions' in editPlan ? editPlan.transitions : [],
        ...(props.musicTracks[0] ? { backgroundMusic: props.musicTracks[0] } : {}),
        ...('composition' in editPlan && editPlan.composition ? { composition: editPlan.composition } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      })
      if (render.sha256 !== props.expectedSha256 || render.byteSize !== props.expectedByteSize ||
        render.probe.width !== input.output.width || render.probe.height !== input.output.height ||
        Math.abs(render.probe.fps - input.output.fps) > 0.01) invalid('Rebuilt editorial MP4 differs from its approved artifact')
      await copyFile(render.outputPath, partialPath)
      const metadata = await stat(partialPath)
      if (metadata.size !== props.expectedByteSize || await calculateFileSha256(partialPath) !== props.expectedSha256) invalid('Staged editorial MP4 identity changed')
      await this.renderer.cleanup(operationId)
      const receipt = Object.freeze({ schemaVersion: 'staged-render-receipt/v1' as const, stageId, inputHash: input.inputHash,
        outputSha256: render.sha256, byteSize: render.byteSize, width: render.probe.width, height: render.probe.height,
        fps: render.probe.fps, durationInFrames: input.output.durationInFrames, codec: 'h264' as const, container: 'mp4' as const })
      let state: 'staged' | 'committed' | 'discarded' = 'staged'
      let committedReceipt: Awaited<ReturnType<StagedRender['commit']>> | null = null
      return Object.freeze({ receipt,
        commit: async () => {
          if (state === 'committed' && committedReceipt) return committedReceipt
          if (state !== 'staged' || await stat(finalPath).catch(() => null)) throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Editorial stage is no longer available')
          if ((await stat(partialPath)).size !== receipt.byteSize || await calculateFileSha256(partialPath) !== receipt.outputSha256) invalid('Editorial stage changed before promotion')
          await rename(partialPath, finalPath)
          state = 'committed'
          committedReceipt = Object.freeze({ ...receipt, schemaVersion: 'committed-render-receipt/v1' as const, committedAt: this.clock().toISOString() })
          return committedReceipt
        },
        discard: async () => { if (state === 'staged') { await rm(partialPath, { force: true }); state = 'discarded' } },
        toJSON: () => receipt,
      })
    } catch (error) {
      await rm(partialPath, { force: true }).catch(() => undefined)
      await this.renderer.cleanup(operationId).catch(() => undefined)
      throw error
    }
  }
}
