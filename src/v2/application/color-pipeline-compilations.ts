import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import {
  createColorPipelineCompilation,
} from '../domain/color-pipeline-compilation.ts'
import { DomainError } from '../domain/errors.ts'
import type {
  ColorPipelineCompilationRepository,
  CreateColorPipelineCompilationInput,
} from './ports/color-pipeline-compilation-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(normalized)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return normalized
}

export function createColorPipelineCompilationService(dependencies: {
  repository: ColorPipelineCompilationRepository
  createId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function create(request: Readonly<CreateColorPipelineCompilationInput>) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const sourceArtifactId = identity(request.sourceArtifactId, 'sourceArtifactId')
    const sourceManifestId = identity(request.sourceManifestId, 'sourceManifestId')
    if (request.actor?.type !== 'api-client') {
      throw new DomainError('INVALID_ARGUMENT', 'actor is invalid')
    }
    const createdByClientId = identity(request.actor.id, 'actor.id')
    const idempotencyKey = request.idempotencyKey.trim()
    if (!IDEMPOTENCY.test(idempotencyKey)) {
      throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    }
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'create-color-pipeline-compilation-request/v1',
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceManifestId,
      outputMetadata: request.outputMetadata,
      stages: request.stages,
      createdByClientId,
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      createdByClientId,
      idempotencyKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with another color pipeline request',
        )
      }
      return Object.freeze({ value: replay, replayed: true })
    }
    const probe = await dependencies.repository.loadTrustedProbe({
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceManifestId,
    })
    if (!probe) {
      throw new DomainError(
        'MEDIA_ARTIFACT_NOT_FOUND',
        'Trusted color probe was not found for the project source manifest',
      )
    }
    if (probe.detection.state !== 'ready') {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Source colorimetry is unavailable and cannot be compiled',
      )
    }
    let current = probe.detection.metadata
    const stages = request.stages.map((stage) => {
      const compiled = Object.freeze({ ...stage, input: current })
      current = stage.output
      return compiled
    })
    const createdAt = clock().toISOString()
    const compilation = createColorPipelineCompilation({
      id: identity(dependencies.createId(), 'compilationId'),
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceManifestId,
      probe,
      outputMetadata: request.outputMetadata,
      stages,
      createdByClientId,
      createdAt,
    })
    return dependencies.repository.persist({
      compilation,
      requestFingerprint,
      idempotencyKey,
    })
  }
}

export function readColorPipelineCompilationService(dependencies: {
  repository: ColorPipelineCompilationRepository
}) {
  return async function read(input: {
    workspaceId: string
    projectId: string
    compilationId: string
  }) {
    const normalized = {
      workspaceId: identity(input.workspaceId, 'workspaceId'),
      projectId: identity(input.projectId, 'projectId'),
      compilationId: identity(input.compilationId, 'compilationId'),
    }
    const value = await dependencies.repository.read(normalized)
    if (!value) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Color pipeline compilation was not found')
    }
    return value
  }
}
