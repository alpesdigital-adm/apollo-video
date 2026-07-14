import {
  createRenderInputSpec,
  type CreateRenderInputSpecInput,
} from '../domain/render-input.ts'

export function preflightRenderInputService() {
  return async function preflightRenderInput(input: CreateRenderInputSpecInput) {
    const spec = createRenderInputSpec(input)
    const totalAssetBytes = spec.assets.reduce(
      (total, asset) => total + BigInt(asset.byteSize),
      BigInt(0),
    )
    return {
      schemaVersion: spec.schemaVersion,
      validationScope: 'portable-envelope' as const,
      materializationRequired: true as const,
      inputHash: spec.inputHash,
      renderer: { ...spec.renderer },
      composition: { ...spec.composition },
      plan: { ...spec.plan },
      output: {
        id: spec.output.id,
        locale: spec.output.locale,
        aspectRatio: spec.output.aspectRatio,
        width: spec.output.width,
        height: spec.output.height,
        fps: spec.output.fps,
        durationInFrames: spec.output.durationInFrames,
      },
      assetCount: spec.assets.length,
      totalAssetBytes: totalAssetBytes.toString(),
    }
  }
}
