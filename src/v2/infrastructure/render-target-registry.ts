import type { RenderTargetRegistry } from '../application/ports/render-reconstruction-readiness.ts'
import type { RenderInputSpecV1 } from '../domain/render-input.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/

export function readConfiguredRenderTargetIdentity(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<{ id: string; version: string }> {
  return Object.freeze({
    id: environment.APOLLO_RENDERER_ID?.trim().toLowerCase() || 'remotion',
    version: environment.APOLLO_RENDERER_VERSION?.trim().toLowerCase() || '4.0.489',
  })
}

export function createConfiguredRenderTargetRegistry(
  environment: NodeJS.ProcessEnv = process.env,
): RenderTargetRegistry {
  const identity = readConfiguredRenderTargetIdentity(environment)
  const renderer = {
    ...identity,
    digest: environment.APOLLO_RENDERER_DIGEST?.trim().toLowerCase() || '',
  }
  const rendererConfigured = SHA256_PATTERN.test(renderer.digest)

  return Object.freeze({
    supportsRenderer(candidate: RenderInputSpecV1['renderer']) {
      return (
        rendererConfigured &&
        candidate.id === renderer.id &&
        candidate.version === renderer.version &&
        candidate.digest === renderer.digest
      )
    },
    supportsComposition(candidate: RenderInputSpecV1['composition']) {
      return (
        candidate.id === 'apollo-video' &&
        candidate.version === 'v1' &&
        candidate.propsSchemaRef === 'apollo://render-props/apollo-video/v1'
      )
    },
  })
}
