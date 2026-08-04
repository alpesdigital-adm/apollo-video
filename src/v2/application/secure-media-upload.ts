import { DomainError } from '../domain/errors.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

export function authorizeMediaUploadActor(
  workspaceId: string,
  actor: AuthenticatedExternalActor,
) {
  requireScope(actor, 'media:write')
  if (actor.workspaceId !== workspaceId) {
    throw new DomainError('MEDIA_UPLOAD_NOT_FOUND', 'Upload was not found')
  }
  return materializeActorAuditContext(actor)
}
