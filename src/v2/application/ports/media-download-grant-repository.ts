import type { MediaDownloadGrant } from '../../domain/media-download-grant.ts'

export interface MediaDownloadGrantRepository {
  createOrReplay(grant: Readonly<MediaDownloadGrant>): Promise<Readonly<{ grant: Readonly<MediaDownloadGrant>; replayed: boolean }>>
  find(input: { workspaceId: string; clientId: string; grantId: string }): Promise<Readonly<MediaDownloadGrant> | undefined>
  revoke(input: { workspaceId: string; clientId: string; grantId: string; revokedAt: string }): Promise<Readonly<MediaDownloadGrant>>
}

export interface MediaDownloadGrantSigner {
  sign(input: { grantId: string; workspaceId: string; clientId: string; artifactId: string; expiresAt: string }): Readonly<{ token: string; downloadUrl: string }>
}
