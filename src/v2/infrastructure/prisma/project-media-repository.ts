import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { ProjectMediaRepository } from '../../application/ports/media-ingest.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'

export class PrismaProjectMediaRepository implements ProjectMediaRepository {
  constructor(private readonly client: PrismaClient) {}

  async readProject(input: { workspaceId: string; projectId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { id: true, locale: true },
    })
    return project ? Object.freeze({ id: project.id, locale: project.locale ?? 'pt-BR' }) : null
  }

  async persistCompletedIngest(input: Parameters<ProjectMediaRepository['persistCompletedIngest']>[0]): Promise<void> {
    const transcriptJson = stableSerialize(input.transcript)
    await this.client.$transaction(async (transaction) => {
      const [project, source, proxy, sourceManifest, proxyManifest, upload] = await Promise.all([
        transaction.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, select: { id: true } }),
        transaction.v2MediaArtifact.findFirst({ where: { id: input.sourceArtifactId, workspaceId: input.workspaceId }, select: { id: true } }),
        transaction.v2MediaArtifact.findFirst({ where: { id: input.proxyArtifactId, workspaceId: input.workspaceId }, select: { id: true } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.sourceManifestId, workspaceId: input.workspaceId, artifactId: input.sourceArtifactId }, select: { id: true, manifestHash: true } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.proxyManifestId, workspaceId: input.workspaceId, artifactId: input.proxyArtifactId }, select: { id: true, manifestHash: true } }),
        transaction.v2MediaUpload.findFirst({ where: { id: input.uploadId, workspaceId: input.workspaceId, projectId: input.projectId, status: 'verified', rightsConfirmed: true }, select: { id: true } }),
      ])
      if (!project || !source || !proxy || !sourceManifest || !proxyManifest || !upload || sourceManifest.manifestHash !== input.sourceManifest.manifestHash || proxyManifest.manifestHash !== input.proxyManifest.manifestHash) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Completed ingest references are not internally consistent')
      }
      for (const asset of [
        { artifactId: input.sourceArtifactId, role: 'source-master' },
        { artifactId: input.proxyArtifactId, role: 'editing-proxy' },
      ] as const) {
        await transaction.v2ProjectMediaAsset.upsert({
          where: { projectId_artifactId_role: { projectId: input.projectId, artifactId: asset.artifactId, role: asset.role } },
          create: {
            id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId,
            artifactId: asset.artifactId, uploadId: input.uploadId, role: asset.role,
            originalFileName: input.originalFileName, createdAt: new Date(input.createdAt),
          },
          update: {},
        })
      }
      const existingTranscript = await transaction.v2MediaTranscript.findUnique({ where: { id: input.transcriptId } })
      if (existingTranscript) {
        if (
          existingTranscript.workspaceId !== input.workspaceId || existingTranscript.projectId !== input.projectId ||
          existingTranscript.sourceArtifactId !== input.sourceArtifactId || existingTranscript.sourceManifestId !== input.sourceManifestId ||
          existingTranscript.transcriptHash !== input.transcript.transcriptHash || existingTranscript.transcriptJson !== transcriptJson
        ) throw new DomainError('PERSISTENCE_CONFLICT', 'Transcript identity collided with different content')
      } else {
        await transaction.v2MediaTranscript.create({ data: {
          id: input.transcriptId, workspaceId: input.workspaceId, projectId: input.projectId,
          sourceArtifactId: input.sourceArtifactId, sourceManifestId: input.sourceManifestId,
          schemaVersion: input.transcript.schemaVersion, language: input.transcript.language,
          provider: input.transcript.provider, model: input.transcript.model,
          transcriptHash: input.transcript.transcriptHash, transcriptJson, createdAt: new Date(input.createdAt),
        } })
      }
      await transaction.v2Project.updateMany({
        where: { id: input.projectId, workspaceId: input.workspaceId, status: 'ingesting' },
        data: { status: 'draft' },
      })
    })
  }

  async markIngestFailed(input: { workspaceId: string; projectId: string }): Promise<void> {
    await this.client.v2Project.updateMany({
      where: { id: input.projectId, workspaceId: input.workspaceId, status: 'ingesting' },
      data: { status: 'failed' },
    })
  }
}
