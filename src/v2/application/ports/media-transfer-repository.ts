import type { MediaUpload } from '../../domain/media-transfer.ts'

export interface BeginMediaUploadRecord {
  upload: Readonly<MediaUpload>
  idempotencyKey: string
  requestFingerprint: string
}

export interface MediaTransferRepository {
  createOrReplayUpload(record: BeginMediaUploadRecord): Promise<Readonly<{ upload: Readonly<MediaUpload>; replayed: boolean }>>
}
