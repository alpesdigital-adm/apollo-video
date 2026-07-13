import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  createRecipeParameterPayload,
  type RecipeParameterPayload,
} from './recipe-parameters.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PORTABLE_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

function assertExactKeys(
  value: object,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys)
  assertDomain(
    Object.keys(value).every((key) => allowed.has(key)),
    'INVALID_MEDIA_ARTIFACT',
    `${field} contains unsupported properties`,
  )
}

export const MEDIA_ARTIFACT_TYPES = ['video', 'audio', 'image'] as const
export type MediaArtifactType = (typeof MEDIA_ARTIFACT_TYPES)[number]

export interface MediaArtifactSource {
  artifactKey: string
  sha256: string
  role: string
}

export interface MediaArtifactExecutionProvenance {
  tool: {
    id: string
    version: string
    digest: string
  }
  model?: {
    provider: string
    id: string
    version: string
    configHash: string
  }
}

export interface MediaArtifactSourceV2 extends MediaArtifactSource {
  execution: MediaArtifactExecutionProvenance
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

export interface MediaArtifactManifestBodyV2 {
  schemaVersion: 'media-artifact-manifest/v2'
  artifact: MediaArtifactManifestBodyV1['artifact']
  recipe: MediaArtifactManifestBodyV1['recipe']
  sources: MediaArtifactSourceV2[]
  probe?: MediaArtifactProbe
}

export interface MediaArtifactManifestV2 extends MediaArtifactManifestBodyV2 {
  manifestHash: string
}

export interface MediaArtifactManifestBodyV3 {
  schemaVersion: 'media-artifact-manifest/v3'
  artifact: MediaArtifactManifestBodyV1['artifact']
  recipe: MediaArtifactManifestBodyV1['recipe'] & { parametersRef: string }
  sources: MediaArtifactSourceV2[]
  probe?: MediaArtifactProbe
}

export interface MediaArtifactManifestV3 extends MediaArtifactManifestBodyV3 {
  manifestHash: string
}

export type MediaArtifactManifest =
  | MediaArtifactManifestV1
  | MediaArtifactManifestV2
  | MediaArtifactManifestV3

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

export interface CreateMediaArtifactSourceV2 extends MediaArtifactSource {
  execution: {
    tool: MediaArtifactExecutionProvenance['tool']
    model?: {
      provider: string
      id: string
      version: string
      config: unknown
    }
  }
}

export interface CreateMediaArtifactManifestV2Input
  extends Omit<CreateMediaArtifactManifestInput, 'sources'> {
  sources?: CreateMediaArtifactSourceV2[]
}

export interface ReplayableMediaArtifactManifest {
  manifest: MediaArtifactManifestV3
  recipeParameters: RecipeParameterPayload
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

function validateExecutionProvenance(
  execution: MediaArtifactExecutionProvenance,
): MediaArtifactExecutionProvenance {
  assertExactKeys(execution, ['tool', 'model'], 'source.execution')
  assertExactKeys(execution.tool, ['id', 'version', 'digest'], 'source.execution.tool')
  const tool = {
    id: validateToken(execution.tool.id, 'source.execution.tool.id'),
    version: validateToken(execution.tool.version, 'source.execution.tool.version'),
    digest: validateSha256(execution.tool.digest, 'source.execution.tool.digest'),
  }
  if (!execution.model) return { tool }
  assertExactKeys(
    execution.model,
    ['provider', 'id', 'version', 'configHash'],
    'source.execution.model',
  )

  return {
    tool,
    model: {
      provider: validateToken(execution.model.provider, 'source.execution.model.provider'),
      id: validateToken(execution.model.id, 'source.execution.model.id'),
      version: validateToken(execution.model.version, 'source.execution.model.version'),
      configHash: validateSha256(
        execution.model.configHash,
        'source.execution.model.configHash',
      ),
    },
  }
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

export function createMediaArtifactManifestV2(
  input: CreateMediaArtifactManifestV2Input,
): MediaArtifactManifestV2 {
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

  const body: MediaArtifactManifestBodyV2 = {
    schemaVersion: 'media-artifact-manifest/v2',
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
      execution: validateExecutionProvenance({
        tool: source.execution.tool,
        ...(source.execution.model
          ? {
              model: {
                provider: source.execution.model.provider,
                id: source.execution.model.id,
                version: source.execution.model.version,
                configHash: calculateCanonicalHash(source.execution.model.config),
              },
            }
          : {}),
      }),
    })),
    ...(input.probe ? { probe: validateProbe(input.probe) } : {}),
  }

  assertDomain(
    body.sources.every((source) => source.artifactKey !== body.artifact.artifactKey),
    'INVALID_MEDIA_ARTIFACT',
    'artifact cannot reference itself as a source',
  )

  return { ...body, manifestHash: calculateCanonicalHash(body) }
}

export function createReplayableMediaArtifactManifest(
  input: CreateMediaArtifactManifestV2Input,
): ReplayableMediaArtifactManifest {
  const recipeParameters = createRecipeParameterPayload(input.recipe.parameters)
  const v2 = createMediaArtifactManifestV2(input)
  const { manifestHash: _v2Hash, ...v2Body } = v2
  const manifestBody: MediaArtifactManifestBodyV3 = {
    ...v2Body,
    schemaVersion: 'media-artifact-manifest/v3',
    recipe: {
      ...v2.recipe,
      parametersRef: recipeParameters.ref,
    },
  }
  return {
    manifest: {
      ...manifestBody,
      manifestHash: calculateCanonicalHash(manifestBody),
    },
    recipeParameters,
  }
}

export function assertMediaArtifactManifest(manifest: MediaArtifactManifest): void {
  assertExactKeys(
    manifest,
    ['schemaVersion', 'artifact', 'recipe', 'sources', 'probe', 'manifestHash'],
    'manifest',
  )
  assertDomain(
    manifest.schemaVersion === 'media-artifact-manifest/v1' ||
      manifest.schemaVersion === 'media-artifact-manifest/v2' ||
      manifest.schemaVersion === 'media-artifact-manifest/v3',
    'INVALID_MEDIA_ARTIFACT',
    'manifest schemaVersion is invalid',
  )
  assertExactKeys(
    manifest.artifact,
    ['artifactKey', 'sha256', 'byteSize', 'mediaType', 'container'],
    'artifact',
  )
  assertExactKeys(
    manifest.recipe,
    manifest.schemaVersion === 'media-artifact-manifest/v3'
      ? ['id', 'version', 'parametersHash', 'parametersRef']
      : ['id', 'version', 'parametersHash'],
    'recipe',
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
  if (manifest.schemaVersion === 'media-artifact-manifest/v3') {
    assertDomain(
      manifest.recipe.parametersRef ===
        `recipe-parameters/sha256/${manifest.recipe.parametersHash}`,
      'INVALID_MEDIA_ARTIFACT',
      'recipe.parametersRef does not match parametersHash',
    )
  }
  for (const source of manifest.sources) {
    assertExactKeys(
      source,
      manifest.schemaVersion === 'media-artifact-manifest/v1'
        ? ['artifactKey', 'sha256', 'role']
        : ['artifactKey', 'sha256', 'role', 'execution'],
      'source',
    )
    validatePortableKey(source.artifactKey, 'source.artifactKey')
    validateSha256(source.sha256, 'source.sha256')
    validateToken(source.role, 'source.role')
    if (manifest.schemaVersion === 'media-artifact-manifest/v1') {
      assertDomain(
        !('execution' in source),
        'INVALID_MEDIA_ARTIFACT',
        'v1 manifest sources cannot contain execution provenance',
      )
    } else {
      assertDomain(
        'execution' in source,
        'INVALID_MEDIA_ARTIFACT',
        'v2 manifest sources require execution provenance',
      )
      validateExecutionProvenance(source.execution)
    }
  }
  if (manifest.probe) {
    assertExactKeys(manifest.probe, ['width', 'height', 'duration', 'fps'], 'probe')
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
