import type { RenderInputAssetResolver } from './ports/render-input-asset-resolver.ts'
import { assertDomain } from '../domain/errors.ts'
import {
  assertRenderInputSpec,
  type MaterializedRenderInputAsset,
  type MaterializedRenderInputV1,
  type RenderInputSpecV1,
} from '../domain/render-input.ts'

export function materializeRenderInputService(dependencies: {
  resolver: RenderInputAssetResolver
}) {
  return async function materializeRenderInput(
    spec: RenderInputSpecV1,
  ): Promise<MaterializedRenderInputV1> {
    assertRenderInputSpec(spec)
    const assets: MaterializedRenderInputAsset[] = []
    for (const asset of spec.assets) {
      const resolved = await dependencies.resolver.resolve(asset)
      assertDomain(
        resolved.sha256 === asset.sha256 && resolved.byteSize === asset.byteSize,
        'INVALID_RENDER_INPUT',
        'Resolved render asset does not match its immutable identity',
        { assetId: asset.id },
      )
      let uri: URL
      try {
        uri = new URL(resolved.uri)
      } catch {
        assertDomain(false, 'INVALID_RENDER_INPUT', 'Resolved render asset URI is invalid')
      }
      const supportedLocation =
        uri.protocol === 'https:' ||
        (uri.protocol === 'file:' &&
          (uri.hostname === '' || uri.hostname === 'localhost') &&
          uri.search.length === 0 &&
          uri.hash.length === 0)
      assertDomain(
        supportedLocation &&
          uri.username.length === 0 &&
          uri.password.length === 0,
        'INVALID_RENDER_INPUT',
        'Resolved render asset URI uses an unsupported scheme or credentials',
        { assetId: asset.id },
      )
      assets.push(Object.freeze({ ...asset, uri: resolved.uri }))
    }
    return Object.freeze({ ...spec, assets: Object.freeze(assets) })
  }
}
