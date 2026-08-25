import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain } from '../domain/errors.ts'
import {
  OUTPUT_FORMAT_REGISTRY,
  readOutputFormatPreset,
} from '../domain/output-format-registry.ts'
import type { OutputAspectRatio } from '../domain/output-spec.ts'
import { createRenderInputSpec, type RenderInputSpecV1 } from '../domain/render-input.ts'
import {
  validateStoryPlan,
  type PersistableStoryPlan,
  type StorySourceKind,
} from '../domain/story-plan.ts'

export interface HybridStoryArtifact {
  artifactId: string
  artifactKey: string
  kind: 'audio' | 'video' | 'image'
  sha256: string
  byteSize: number
}

const PALETTE = Object.freeze({
  primary: '#FFB800',
  secondary: '#20202A',
  accent: '#FFB800',
  text: '#FFFFFF',
  background: '#050508',
})

const visualKinds = new Set<StorySourceKind>(['real', 'synthetic', 'proof', 'b-roll'])

function frames(milliseconds: number, fps: number): number {
  return Math.round(milliseconds / 1000 * fps)
}

/**
 * Compiles the immutable hybrid StoryPlan into the portable renderer contract.
 * Provider and storage access stay outside this boundary: every source must
 * already be an Apollo artifact whose digest matches the render authorization.
 */
export function compileHybridStoryRenderInputs(input: {
  storyPlan: Readonly<PersistableStoryPlan>
  artifacts: readonly Readonly<HybridStoryArtifact>[]
  renderer: RenderInputSpecV1['renderer']
  captionsByBlockId: Readonly<Record<string, string>>
  aspectRatio?: OutputAspectRatio
}): Readonly<{
  proxy: RenderInputSpecV1
  final: RenderInputSpecV1
  format: Readonly<{ registryHash: string; presetHash: string }>
}> {
  const validated = validateStoryPlan(input.storyPlan).plan
  assertDomain(
    validated.schemaVersion === 4 && validated.productionMode === 'hybrid',
    'INVALID_RENDER_INPUT',
    'Hybrid rendering requires a StoryPlan v4',
  )
  const { storyHash, ...storyBody } = input.storyPlan
  assertDomain(
    calculateCanonicalHash(storyBody) === storyHash,
    'PERSISTENCE_CONFLICT',
    'Hybrid StoryPlan hash does not match its persisted content',
  )

  const ranges = new Map(validated.sourceRanges!.map((range) => [range.id, range]))
  const candidates = new Map(validated.sourceCandidates!.map((candidate) => [candidate.id, candidate]))
  const artifacts = new Map<string, Readonly<HybridStoryArtifact>>()
  for (const artifact of input.artifacts) {
    assertDomain(!artifacts.has(artifact.artifactId), 'INVALID_RENDER_INPUT', `Duplicate hybrid artifact ${artifact.artifactId}`)
    artifacts.set(artifact.artifactId, artifact)
  }
  const expectedArtifactIds = new Set(validated.sourceRanges!.map((range) => range.artifactId))
  assertDomain(
    artifacts.size === expectedArtifactIds.size && [...artifacts.keys()].every((id) => expectedArtifactIds.has(id)),
    'INVALID_RENDER_INPUT',
    'Hybrid artifacts must exactly match the StoryPlan source ranges',
  )

  const blocks = new Map(validated.blocks.map((block) => [block.id, block]))
  const orderedBlocks = validated.acts.flatMap((act) => act.blockIds.map((id) => blocks.get(id)!))
  const resolved = orderedBlocks.map((block, index) => {
    const candidate = candidates.get(block.sourceCandidateIds[0]!)!
    const range = ranges.get(candidate.sourceRangeId)!
    const artifact = artifacts.get(range.artifactId)!
    const sourceKind = range.sourceKind!
    if (sourceKind === 'voiceover') {
      assertDomain(artifact.kind === 'audio', 'INVALID_RENDER_INPUT', `Voiceover block ${block.id} requires an audio artifact`)
    } else if (['real', 'synthetic'].includes(sourceKind)) {
      assertDomain(artifact.kind === 'video', 'INVALID_RENDER_INPUT', `${sourceKind} block ${block.id} requires a video artifact`)
    } else {
      assertDomain(['image', 'video'].includes(artifact.kind), 'INVALID_RENDER_INPUT', `${sourceKind} block ${block.id} requires a visual artifact`)
    }
    return Object.freeze({ block, range, artifact, assetId: `hybrid-source-${index + 1}` })
  })
  const audioSources = resolved.filter(({ range }) => range.sourceKind === 'voiceover')
  assertDomain(audioSources.length === 1, 'INVALID_RENDER_INPUT', 'Hybrid rendering requires exactly one canonical voiceover audio source')

  const preset = readOutputFormatPreset(input.aspectRatio ?? '9:16')
  const fps = preset.spec.fps
  let cursorMs = 0
  const timed = resolved.map((entry) => {
    const startMs = cursorMs
    cursorMs += entry.block.durationTargetMs.ideal
    return Object.freeze({ ...entry, startMs, endMs: cursorMs })
  })
  const durationInFrames = frames(cursorMs, fps)
  assertDomain(durationInFrames > 0, 'INVALID_RENDER_INPUT', 'Hybrid StoryPlan has no renderable duration')

  const assets = timed.map(({ artifact, assetId, range }, ordinal) => ({
    id: assetId,
    artifactId: artifact.artifactId,
    artifactKey: artifact.artifactKey,
    kind: artifact.kind,
    role: range.sourceKind!,
    ordinal,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
  }))
  const scenes = timed.flatMap(({ artifact, assetId, range, startMs, endMs }) => {
    if (!visualKinds.has(range.sourceKind!)) return []
    return [{
      type: 'image-insert',
      fromFrame: frames(startMs, fps),
      toFrame: frames(endMs, fps),
      props: {
        ...(artifact.kind === 'image' ? { imageAssetId: assetId } : { videoAssetId: assetId }),
        layout: 'full',
        visualRole: range.sourceKind,
        stutter: false,
      },
    }]
  })
  const subtitles = timed.flatMap(({ block, range, startMs, endMs }) => {
    const result = []
    if (range.sourceKind === 'synthetic') {
      result.push({ text: range.disclosure!, fromFrame: frames(startMs, fps), toFrame: frames(endMs, fps), anchor: 'top' })
    }
    const caption = input.captionsByBlockId[block.id]
    assertDomain(typeof caption === 'string' && caption.trim().length > 0, 'INVALID_RENDER_INPUT', `Hybrid block ${block.id} requires a caption`)
    result.push({ text: caption.trim(), fromFrame: frames(startMs, fps), toFrame: frames(endMs, fps), anchor: 'bottom' })
    return result
  })
  const format = Object.freeze({ registryHash: OUTPUT_FORMAT_REGISTRY.registryHash, presetHash: preset.presetHash })
  const renderPlanHash = calculateCanonicalHash({
    schemaVersion: 'hybrid-story-render-plan/v1',
    storyHash,
    artifacts: assets.map(({ id, artifactId, sha256, byteSize, role }) => ({ id, artifactId, sha256, byteSize, role })),
    format,
  })
  const props = {
    primaryAudioAssetId: audioSources[0]!.assetId,
    scenes,
    subtitles,
    palette: { ...PALETTE },
    stylePreset: 'creator-clean',
    subtitleStyle: 'clean-color',
    gradePreset: 'natural',
  }
  const compile = (kind: 'proxy' | 'final') => createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: input.renderer,
    composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
    plan: { id: `hybrid-${renderPlanHash.slice(0, 20)}-${kind}`, versionId: input.storyPlan.projectVersionId, hash: renderPlanHash },
    output: {
      id: `hybrid-${kind}-${preset.spec.aspectRatio.replace(':', 'x')}`,
      locale: preset.spec.locale,
      width: kind === 'proxy' ? preset.exportDefaults.proxy.width : preset.spec.width,
      height: kind === 'proxy' ? preset.exportDefaults.proxy.height : preset.spec.height,
      fps,
      aspectRatio: preset.spec.aspectRatio,
      safeArea: preset.spec.safeArea,
      durationInFrames,
    },
    assets,
    props,
  })
  const proxy = compile('proxy')
  const final = compile('final')
  assertDomain(
    proxy.composition.propsHash === final.composition.propsHash && proxy.plan.hash === final.plan.hash,
    'INVALID_RENDER_INPUT',
    'Hybrid proxy and final must share the exact timeline and artifacts',
  )
  return Object.freeze({ proxy, final, format })
}
