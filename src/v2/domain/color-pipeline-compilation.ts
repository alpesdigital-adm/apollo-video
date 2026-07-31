import { calculateCanonicalHash } from './canonical-hash.ts'
import {
  resolveColorPlan,
  type ColorMetadata,
  type ColorTransform,
  type MediaColorProbe,
} from './color-and-export.ts'
import { assertDomain } from './errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

export interface ColorPipelineCompilation {
  schemaVersion: 'color-pipeline-compilation/v1'
  id: string
  workspaceId: string
  projectId: string
  sourceArtifactId: string
  sourceManifestId: string
  colorProbeId: string
  colorProbeHash: string
  pipeline: Readonly<ReturnType<typeof resolveColorPlan>>
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  compilationHash: string
}

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

export function createColorPipelineCompilation(input: {
  id: string
  workspaceId: string
  projectId: string
  sourceArtifactId: string
  sourceManifestId: string
  probe: Readonly<MediaColorProbe>
  outputMetadata: Readonly<ColorMetadata>
  stages: readonly Readonly<ColorTransform>[]
  createdByClientId: string
  createdAt: string
}): Readonly<ColorPipelineCompilation> {
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const sourceArtifactId = identity(
    input.sourceArtifactId,
    'sourceArtifactId',
  )
  const sourceManifestId = identity(
    input.sourceManifestId,
    'sourceManifestId',
  )
  assertDomain(
    input.probe.workspaceId === workspaceId &&
      input.probe.artifactId === sourceArtifactId &&
      input.probe.manifestId === sourceManifestId,
    'INVALID_ARGUMENT',
    'Color probe does not match the requested source manifest',
  )
  assertDomain(
    input.probe.detection.state === 'ready',
    'INVALID_ARGUMENT',
    'Source colorimetry is unavailable and cannot be compiled',
  )
  const pipeline = resolveColorPlan(
    {
      schemaVersion: 'color-plan/v1',
      metadata: input.probe.detection.metadata,
      outputMetadata: input.outputMetadata,
      global: [...input.stages],
    },
    { sourceId: sourceArtifactId },
  )
  const createdAt = new Date(input.createdAt)
  assertDomain(
    !Number.isNaN(createdAt.getTime()) &&
      createdAt.toISOString() === input.createdAt,
    'INVALID_ARGUMENT',
    'createdAt is invalid',
  )
  const content = Object.freeze({
    schemaVersion: 'color-pipeline-compilation/v1' as const,
    id: identity(input.id, 'id'),
    workspaceId,
    projectId: identity(input.projectId, 'projectId'),
    sourceArtifactId,
    sourceManifestId,
    colorProbeId: input.probe.id,
    colorProbeHash: input.probe.probeHash,
    pipeline,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: identity(input.createdByClientId, 'createdByClientId'),
    }),
    createdAt: input.createdAt,
  })
  return Object.freeze({
    ...content,
    compilationHash: calculateCanonicalHash(content),
  })
}
