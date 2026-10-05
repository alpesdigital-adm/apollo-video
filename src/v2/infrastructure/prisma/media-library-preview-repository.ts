import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type { MediaLibraryPreviewRepository } from '../../application/create-media-library-previews.ts'
import { DomainError } from '../../domain/errors.ts'
export class PrismaMediaLibraryPreviewRepository implements MediaLibraryPreviewRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient) { this.client = client }
  async find(workspaceId: string, artifactId: string) {
    return this.client.v2MediaLibraryEntry.findFirst({ where: { workspaceId, artifactId }, select: { thumbnailArtifactId: true, waveformArtifactId: true } })
  }
  async publish(input: Parameters<MediaLibraryPreviewRepository['publish']>[0]) {
    await this.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "public_operations" WHERE "id" = ${input.operationId} AND "workspaceId" = ${input.workspaceId} FOR UPDATE`
      const operation = await tx.v2PublicOperation.findFirst({ where: { id: input.operationId, workspaceId: input.workspaceId } })
      const assertLease = () => {
        if (input.signal?.aborted || !operation || operation.type !== 'media-ingest' || operation.status !== 'running' || operation.leaseOwner !== input.leaseOwner || operation.attempt !== input.attempt || !operation.leaseExpiresAt || operation.leaseExpiresAt <= new Date()) throw new DomainError('PERSISTENCE_CONFLICT', 'Preview publication requires its current unexpired ingest lease')
      }
      assertLease()
      const ids = [input.artifactId, input.thumbnailArtifactId, input.waveformArtifactId].filter((id): id is string => Boolean(id))
      if (await tx.v2MediaArtifact.count({ where: { id: { in: ids }, workspaceId: input.workspaceId, status: 'available' } }) !== ids.length) throw new DomainError('PERSISTENCE_CONFLICT', 'Preview artifacts are incomplete')
      assertLease()
      await tx.v2MediaLibraryEntry.upsert({ where: { artifactId: input.artifactId }, create: { artifactId: input.artifactId, workspaceId: input.workspaceId, label: input.label, peopleJson: '[]', peopleSearch: '\n', topicsJson: '[]', topicsSearch: '\n', originType: 'upload', thumbnailArtifactId: input.thumbnailArtifactId, waveformArtifactId: input.waveformArtifactId, createdAt: new Date(input.createdAt) }, update: { thumbnailArtifactId: input.thumbnailArtifactId, waveformArtifactId: input.waveformArtifactId } })
      assertLease()
    })
  }
}
