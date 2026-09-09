import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ArtifactSourceMaterializer } from '../application/ports/media-ingest.ts'
import type { MusicRightsAuthorizer, MusicSourceMaterializer } from '../application/ports/music-led-montage.ts'
import { DomainError } from '../domain/errors.ts'
import type { PrismaClient } from '../../../generated/prisma-v2/index.js'
import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { hydrateAssetRights } from './prisma/asset-rights-repository.ts'

export class ArtifactMusicSourceMaterializer implements MusicSourceMaterializer {
  private readonly sources: ArtifactSourceMaterializer
  constructor(sources: ArtifactSourceMaterializer) { this.sources = sources }
  async materialize(input: Parameters<MusicSourceMaterializer['materialize']>[0]) {
    const operationId = `music-analysis-${randomUUID()}`
    const source = await this.sources.materialize({ operationId, artifactKey: input.artifactKey, sha256: input.expectedSha256, byteSize: input.expectedByteSize })
    if (input.signal?.aborted) { await this.sources.cleanup(operationId); throw input.signal.reason }
    const observed = await fs.stat(source.path)
    return Object.freeze({ filePath: source.path, observedByteSize: observed.size, observedSha256: source.sha256, release: () => this.sources.cleanup(operationId) })
  }
}

export class PrismaMusicRightsAuthorizer implements MusicRightsAuthorizer {
  private readonly prisma: PrismaClient
  constructor(prisma: PrismaClient) { this.prisma = prisma }
  async authorizeCurrent(input: Parameters<MusicRightsAuthorizer['authorizeCurrent']>[0]) {
    const project = await this.prisma.v2Project.findFirst({ where: { workspaceId: input.workspaceId, currentVersionId: input.projectVersionId }, select: { id: true, locale: true } })
    const link = project ? await this.prisma.v2ProjectMediaAsset.findFirst({ where: { workspaceId: input.workspaceId, projectId: project.id, artifactId: input.artifactId }, include: { artifact: { include: { currentRightsSnapshot: true } } } }) : null
    const artifact = link?.artifact, rights = artifact?.currentRightsSnapshot, locale = project?.locale
    const decision = rights && locale ? evaluateAssetUse(hydrateAssetRights(rights), { workspaceId: input.workspaceId, use: 'music-led-montage', locale }, new Date(input.at)) : null
    if (!artifact || !rights || decision?.outcome !== 'allow') throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Music rights changed during analysis', { reasons: decision?.reasonCodes ?? ['RIGHTS_MISSING'] })
    return Object.freeze({ authorized: true as const })
  }
}
