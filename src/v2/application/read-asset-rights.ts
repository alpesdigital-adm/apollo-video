import { DomainError } from '../domain/errors.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  if (normalized.length < 3 || normalized.length > 128) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must contain 3 to 128 characters`)
  }
  return normalized
}

export function readAssetRightsService(dependencies: {
  repository: AssetRightsRepository
}) {
  return async function readAssetRights(workspaceId: string, artifactId: string) {
    const record = await dependencies.repository.findCurrent(
      validateId(workspaceId, 'workspaceId'),
      validateId(artifactId, 'artifactId'),
    )
    if (!record) {
      throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact was not found')
    }
    return record
  }
}
