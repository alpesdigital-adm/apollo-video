import { createHash, randomUUID } from 'node:crypto'

import { assertDomain } from '../domain/errors.ts'
import type { MediaUpload } from '../domain/media-transfer.ts'
import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import { stableSerialize } from './version-hash.ts'

export function enqueueMediaIngestService(dependencies: {
  operations: PublicOperationRepository
  clock?: () => Date
  createId?: (kind: 'operation') => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? ((kind) => `${kind}-${randomUUID()}`)
  return async function enqueue(input: { upload: Readonly<MediaUpload> }) {
    const upload = input.upload
    assertDomain(upload.status === 'verified' && upload.actualSha256 === upload.expectedSha256, 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Upload must be verified before ingest')
    assertDomain(Boolean(upload.projectId && upload.fileName && upload.rightsConfirmed), 'MEDIA_UPLOAD_TRANSITION_REJECTED', 'Project, file name and rights confirmation are required before ingest')
    const idempotencyKey = `media-ingest:${upload.id}`
    const requestFingerprint = createHash('sha256').update(stableSerialize({
      uploadId: upload.id,
      projectId: upload.projectId,
      fileName: upload.fileName,
      sha256: upload.expectedSha256,
      byteSize: upload.byteSize,
      mimeType: upload.mimeType,
      rightsConfirmed: upload.rightsConfirmed,
    })).digest('hex')
    const workspaceNamespace = createHash('sha256').update(upload.workspaceId).digest('hex').slice(0, 12)
    const sourceArtifactId = `artifact-${workspaceNamespace}-${upload.expectedSha256}`
    // The immutable upload manifest represents content, not one transfer attempt.
    // Re-uploading identical bytes must converge on the same artifact + manifest.
    const sourceManifestId = `manifest-upload-${workspaceNamespace}-${upload.expectedSha256}`
    const operation = createQueuedPublicOperation({
      id: createId('operation'),
      workspaceId: upload.workspaceId,
      clientId: upload.clientId,
      type: 'media-ingest',
      target: { type: 'media-artifact', id: sourceArtifactId, manifestId: sourceManifestId },
      createdAt: clock().toISOString(),
    })
    return dependencies.operations.createOrReplay({
      operation,
      context: {
        kind: 'media-ingest',
        uploadId: upload.id,
        projectId: upload.projectId!,
        originalFileName: upload.fileName!,
        sourceArtifactId,
        sourceManifestId,
      },
      idempotencyKey,
      requestFingerprint,
    })
  }
}
