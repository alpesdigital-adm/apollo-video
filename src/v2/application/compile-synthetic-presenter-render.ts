import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain } from '../domain/errors.ts'
import {
  OUTPUT_FORMAT_REGISTRY,
  readOutputFormatPreset,
} from '../domain/output-format-registry.ts'
import type { OutputAspectRatio } from '../domain/output-spec.ts'
import { createRenderInputSpec, type RenderInputSpecV1 } from '../domain/render-input.ts'
import {
  assertSyntheticPresenterEditPlan,
  type SyntheticArtifactRef,
  type SyntheticPresenterEditPlan,
} from '../domain/synthetic-production.ts'

const PALETTE = Object.freeze({
  primary: '#FFB800',
  secondary: '#20202A',
  accent: '#FFB800',
  text: '#FFFFFF',
  background: '#050508',
})

function frames(milliseconds: number, fps: number): number {
  return Math.round(milliseconds / 1000 * fps)
}

/**
 * Compiles an approved, locally ingested synthetic plan into the portable
 * RenderInput used by the durable renderer. The provider is intentionally
 * absent: only Apollo artifact identities and checksums cross this boundary.
 */
export function compileSyntheticPresenterRenderInputs(input: {
  plan: Readonly<SyntheticPresenterEditPlan>
  renderer: RenderInputSpecV1['renderer']
  aspectRatio?: OutputAspectRatio
}): Readonly<{
  proxy: RenderInputSpecV1
  final: RenderInputSpecV1
  format: Readonly<{
    registryHash: string
    presetHash: string
  }>
}> {
  assertSyntheticPresenterEditPlan(input.plan)
  const preset = readOutputFormatPreset(input.aspectRatio ?? '9:16')
  const fps = preset.spec.fps
  const durationInFrames = frames(input.plan.durationMs, fps)
  assertDomain(
    durationInFrames > 0,
    'INVALID_RENDER_INPUT',
    'Synthetic plan duration does not produce a renderable frame',
  )
  const format = Object.freeze({
    registryHash: OUTPUT_FORMAT_REGISTRY.registryHash,
    presetHash: preset.presetHash,
  })
  const renderPlanHash = calculateCanonicalHash({
    schemaVersion: 'synthetic-render-plan/v1',
    syntheticEditPlanHash: input.plan.planHash,
    format,
  })

  const assetEntries: Array<Readonly<{
    id: string
    source: Readonly<SyntheticArtifactRef>
    role: string
  }>> = [
    { id: 'synthetic-audio', source: input.plan.audio, role: 'narration' },
    ...input.plan.blocks.map((block, index) => ({
      id: `synthetic-block-${index + 1}`,
      source: block.artifact,
      role: 'synthetic-presenter',
    })),
    ...input.plan.bRoll.map((entry, index) => ({
      id: `synthetic-broll-${index + 1}`,
      source: entry.artifact,
      role: 'b-roll',
    })),
    ...input.plan.overlays.map((entry, index) => ({
      id: `synthetic-overlay-${index + 1}`,
      source: entry.artifact,
      role: 'overlay',
    })),
  ]
  const assets = assetEntries.map((entry, ordinal) => ({
    id: entry.id,
    artifactId: entry.source.artifactId,
    artifactKey: entry.source.artifactKey,
    kind: entry.source.kind,
    role: entry.role,
    ordinal,
    sha256: entry.source.sha256,
    byteSize: entry.source.byteSize,
  }))

  const blockScenes = input.plan.blocks.map((block, index) => ({
    type: 'image-insert',
    fromFrame: frames(block.rangeMs[0], fps),
    toFrame: frames(block.rangeMs[1], fps),
    props: {
      videoAssetId: `synthetic-block-${index + 1}`,
      layout: 'full',
      visualRole: 'context',
      stutter: false,
    },
  }))
  const bRollScenes = input.plan.bRoll.map((entry, index) => ({
    type: 'image-insert',
    fromFrame: frames(entry.rangeMs[0], fps),
    toFrame: frames(entry.rangeMs[1], fps),
    props: {
      ...(entry.artifact.kind === 'video'
        ? { videoAssetId: `synthetic-broll-${index + 1}` }
        : { imageAssetId: `synthetic-broll-${index + 1}` }),
      layout: 'full',
      visualRole: 'context',
      stutter: false,
    },
  }))
  const overlayScenes = input.plan.overlays.map((entry, index) => ({
    type: 'image-insert',
    fromFrame: frames(entry.rangeMs[0], fps),
    toFrame: frames(entry.rangeMs[1], fps),
    props: {
      ...(entry.artifact.kind === 'video'
        ? { videoAssetId: `synthetic-overlay-${index + 1}` }
        : { imageAssetId: `synthetic-overlay-${index + 1}` }),
      layout: 'top-image-compact',
      visualRole: 'context',
      stutter: false,
    },
  }))
  const subtitles = [
    {
      text: input.plan.disclosure,
      fromFrame: 0,
      toFrame: Math.min(durationInFrames, Math.max(1, Math.round(fps * 2))),
      anchor: 'top',
    },
    ...input.plan.captions.map((entry) => ({
      text: entry.text,
      fromFrame: frames(entry.startMs, fps),
      toFrame: frames(entry.endMs, fps),
      anchor: entry.anchor,
    })),
  ]
  const props = {
    primaryAudioAssetId: 'synthetic-audio',
    scenes: [...blockScenes, ...bRollScenes, ...overlayScenes],
    subtitles,
    palette: { ...PALETTE },
    stylePreset: 'creator-clean',
    subtitleStyle: 'clean-color',
    gradePreset: 'natural',
  }
  const compile = (kind: 'proxy' | 'final') => createRenderInputSpec({
    schemaVersion: 'render-input/v1',
    renderer: input.renderer,
    composition: {
      id: 'apollo-video',
      version: 'v1',
      propsSchemaRef: 'apollo://render-props/apollo-video/v1',
    },
    plan: {
      id: `synthetic-${renderPlanHash.slice(0, 20)}-${kind}`,
      versionId: input.plan.projectVersionId,
      hash: renderPlanHash,
    },
    output: {
      id: `synthetic-${kind}-${preset.spec.aspectRatio.replace(':', 'x')}`,
      locale: preset.spec.locale,
      width: kind === 'proxy'
        ? preset.exportDefaults.proxy.width
        : preset.spec.width,
      height: kind === 'proxy'
        ? preset.exportDefaults.proxy.height
        : preset.spec.height,
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
    proxy.composition.propsHash === final.composition.propsHash &&
      proxy.plan.hash === final.plan.hash,
    'INVALID_RENDER_INPUT',
    'Synthetic proxy and final must share the exact timeline and assets',
  )
  return Object.freeze({ proxy, final, format })
}
