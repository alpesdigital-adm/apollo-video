import { createRenderInputSpec, type RenderInputSpecV1 } from '../domain/render-input.ts'
import { assertVisualMontagePlanIntegrity, type VisualMontagePlan } from '../domain/visual-montage.ts'
import { DomainError } from '../domain/errors.ts'

export function compileVisualMontageRenderInputs(input: {
  plan: Readonly<VisualMontagePlan>
  renderer: RenderInputSpecV1['renderer']
}): Readonly<{ proxy: RenderInputSpecV1; final: RenderInputSpecV1 }> {
  assertVisualMontagePlanIntegrity(input.plan)
  const durationInFrames = Math.round(input.plan.sourceAudio.durationMs / 1000 * input.plan.fps)
  const usedAssetIds = new Set(input.plan.slots.flatMap((slot) => slot.assetId ? [slot.assetId] : []))
  const assets = [
    { id: 'voiceover-audio', artifactId: input.plan.sourceAudio.artifactId, artifactKey: input.plan.sourceAudio.artifactKey, kind: 'audio' as const, role: 'narration', ordinal: 0, sha256: input.plan.sourceAudio.sha256, byteSize: input.plan.sourceAudio.byteSize },
    ...input.plan.assets.filter((asset) => usedAssetIds.has(asset.id)).map((asset, index) => ({ id: asset.id, artifactId: asset.artifactId, artifactKey: asset.artifactKey, kind: asset.kind, role: `visual-${asset.kind}`, ordinal: index + 1, sha256: asset.sha256, byteSize: asset.byteSize })),
  ]
  const toFrame = (milliseconds: number) => Math.round(milliseconds / 1000 * input.plan.fps)
  const scenes = input.plan.slots.map((slot, index) => ({
    type: slot.kind === 'card' ? 'card' : 'image-insert',
    fromFrame: toFrame(slot.startMs),
    toFrame: toFrame(slot.endMs),
    props: slot.kind === 'card'
      ? { number: index + 1, title: slot.card!.title, description: slot.card!.description }
      : { ...(slot.kind === 'image' ? { imageAssetId: slot.assetId } : { videoAssetId: slot.assetId }), layout: 'full', visualRole: 'context', stutter: false },
  }))
  const subtitles = input.plan.beats.map((beat) => ({ text: beat.narration, fromFrame: toFrame(beat.startMs), toFrame: toFrame(beat.endMs), anchor: 'bottom' }))
  const props = { primaryAudioAssetId: 'voiceover-audio', scenes, subtitles, palette: { primary: '#4ECDC4', secondary: '#2457A7', accent: '#FFB800', text: '#FFFFFF', background: '#07111F' }, stylePreset: 'creator-clean', subtitleStyle: 'clean-color' }
  const compile = (kind: 'proxy' | 'final') => createRenderInputSpec({
    schemaVersion: 'render-input/v1', renderer: input.renderer,
    composition: { id: 'apollo-video', version: 'v1', propsSchemaRef: 'apollo://render-props/apollo-video/v1' },
    plan: { id: `${input.plan.id}-${kind}`, versionId: input.plan.projectVersionId, hash: input.plan.planHash },
    output: { id: kind === 'proxy' ? 'visual-montage-proxy-9x16' : 'visual-montage-final-9x16', locale: 'pt-BR', width: kind === 'proxy' ? 540 : 1080, height: kind === 'proxy' ? 960 : 1920, fps: input.plan.fps, aspectRatio: '9:16', safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 }, durationInFrames },
    assets, props,
  })
  const proxy = compile('proxy')
  const final = compile('final')
  if (proxy.composition.propsHash !== final.composition.propsHash || proxy.plan.hash !== final.plan.hash) throw new DomainError('INVALID_RENDER_INPUT', 'Proxy and final must share the exact visual montage and audio timeline')
  return Object.freeze({ proxy, final })
}
