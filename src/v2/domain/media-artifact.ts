import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PORTABLE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export const MEDIA_ARTIFACT_TYPES = ['video', 'audio', 'image'] as const
export type MediaArtifactType = (typeof MEDIA_ARTIFACT_TYPES)[number]

export interface MediaArtifactSource {
  artifactKey: string
  sha256: string
  role: string
}

export interface MediaArtifactProbe {
  width: number
  height: number
  duration: number
  fps: number
}

export interface MediaArtifactManifestBodyV1 {
  schemaVersion: 'media-artifact-manifest/v1'
  artifact: {
    artifactKey: string
    sha256: string
    byteSize: number
    mediaType: MediaArtifactType
    container: string
  }
  recipe: {
    id: string
    version: string
    parametersHash: string
  }
  sources: MediaArtifactSource[]
  probe?: MediaArtifactProbe
}

export interface MediaArtifactManifestV1 extends MediaArtifactManifestBodyV1 {
  manifestHash: string
}

export interface CreateMediaArtifactManifestInput {
  artifactKey: string
  artifactSha256: string
  byteSize: number
  mediaType: MediaArtifactType
  container: string
  recipe: {
    id: string
    version: string
    parameters: unknown
  }
  sources?: MediaArtifactSource[]
  probe?: MediaArtifactProbe
}

function validatePortableKey(value: string, field: string): string {
  const normalized = value.trim()
  const segments = normalized.split('/')
  assertDomain(normalized.length > 0, 'INVALID_MEDIA_ARTIFACT', `${field} is required`)
  assertDomain(
    !normalized.startsWith('/') &&
      !normalized.includes('\\') &&
      !/^[a-zA-Z]:/.test(normalized) &&
      segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'INVALID_MEDIA_ARTIFACT',
    `${field} must be a portable relative key`,
  )
  return normalized
}

function validateSha256(value: string, field: string): string {
  const normalized = value.trim().toLowerCase()
  assertDomain(
    SHA256_PATTERN.test(normalized),
    'INVALID_MEDIA_ARTIFACT',
    `${field} must be a SHA-256 hex digest`,
  )
  return normalized
}

function validateToken(value: string, field: string): string {
  const normalized = value.trim().toLowerCase()
  assertDomain(
    PORTABLE_TOKEN_PATTERN.test(normalized),
    'INVALID_MEDIA_ARTIFACT',
    `${field} must be a portable token`,
  )
  return normalized
}

function validateProbe(probe: MediaArtifactProbe | undefined): MediaArtifactProbe | undefined {
  if (!probe) return undefined
  for (const [field, value] of Object.entries(probe)) {
    assertDomain(
      Number.isFinite(value) && value > 0,
      'INVALID_MEDIA_ARTIFACT',
      `probe.${field} must be positive`,
    )
  }
  return { ...probe }
}

export function createMediaArtifactManifest(
  input: CreateMediaArtifactManifestInput,
): MediaArtifactManifestV1 {
  assertDomain(
    Number.isSafeInteger(input.byteSize) && input.byteSize > 0,
    'INVALID_MEDIA_ARTIFACT',
    'artifact byteSize must be a positive safe integer',
  )
  assertDomain(
    MEDIA_ARTIFACT_TYPES.includes(input.mediaType),
    'INVALID_MEDIA_ARTIFACT',
    'artifact mediaType is invalid',
  )

  const body: MediaArtifactManifestBodyV1 = {
    schemaVersion: 'media-artifact-manifest/v1',
    artifact: {
      artifactKey: validatePortableKey(input.artifactKey, 'artifactKey'),
      sha256: validateSha256(input.artifactSha256, 'artifactSha256'),
      byteSize: input.byteSize,
      mediaType: input.mediaType,
      container: validateToken(input.container, 'container'),
    },
    recipe: {
      id: validateToken(input.recipe.id, 'recipe.id'),
      version: validateToken(input.recipe.version, 'recipe.version'),
      parametersHash: calculateCanonicalHash(input.recipe.parameters),
    },
    sources: (input.sources ?? []).map((source) => ({
      artifactKey: validatePortableKey(source.artifactKey, 'source.artifactKey'),
      sha256: validateSha256(source.sha256, 'source.sha256'),
      role: validateToken(source.role, 'source.role'),
    })),
    ...(input.probe ? { probe: validateProbe(input.probe) } : {}),
  }

  assertDomain(
    body.sources.every((source) => source.artifactKey !== body.artifact.artifactKey),
    'INVALID_MEDIA_ARTIFACT',
    'artifact cannot reference itself as a source',
  )

  return {
    ...body,
    manifestHash: calculateCanonicalHash(body),
  }
}

export function assertMediaArtifactManifest(manifest: MediaArtifactManifestV1): void {
  assertDomain(
    manifest.schemaVersion === 'media-artifact-manifest/v1',
    'INVALID_MEDIA_ARTIFACT',
    'manifest schemaVersion is invalid',
  )
  validatePortableKey(manifest.artifact.artifactKey, 'artifact.artifactKey')
  validateSha256(manifest.artifact.sha256, 'artifact.sha256')
  assertDomain(
    Number.isSafeInteger(manifest.artifact.byteSize) && manifest.artifact.byteSize > 0,
    'INVALID_MEDIA_ARTIFACT',
    'artifact byteSize must be a positive safe integer',
  )
  assertDomain(
    MEDIA_ARTIFACT_TYPES.includes(manifest.artifact.mediaType),
    'INVALID_MEDIA_ARTIFACT',
    'artifact mediaType is invalid',
  )
  validateToken(manifest.artifact.container, 'artifact.container')
  validateToken(manifest.recipe.id, 'recipe.id')
  validateToken(manifest.recipe.version, 'recipe.version')
  validateSha256(manifest.recipe.parametersHash, 'recipe.parametersHash')
  for (const source of manifest.sources) {
    validatePortableKey(source.artifactKey, 'source.artifactKey')
    validateSha256(source.sha256, 'source.sha256')
    validateToken(source.role, 'source.role')
  }
  validateProbe(manifest.probe)
  validateSha256(manifest.manifestHash, 'manifestHash')

  const { manifestHash, ...body } = manifest
  assertDomain(
    calculateCanonicalHash(body) === manifestHash,
    'INVALID_MEDIA_ARTIFACT',
    'manifestHash does not match the manifest body',
  )
}
