import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient, V2RenderElementMap } from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedRenderElementMap,
  RenderElementMapRepository,
} from '../../application/ports/render-element-map-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  renderElementMapHash,
  validateRenderElementMap,
  type RenderElement,
  type RenderElementMap,
} from '../../domain/review-system.ts'

function toRecord(row: V2RenderElementMap): Readonly<PersistedRenderElementMap> {
  let elements: unknown
  try {
    elements = JSON.parse(row.elementsJson)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored RenderElementMap JSON is invalid')
  }
  if (!Array.isArray(elements)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored RenderElementMap elements are invalid')
  const map = validateRenderElementMap({
    schemaVersion: row.schemaVersion as RenderElementMap['schemaVersion'],
    proxyHash: row.proxyHash,
    fps: row.fps,
    durationFrames: row.durationFrames,
    canvas: { width: row.canvasWidth, height: row.canvasHeight },
    elements: elements as RenderElement[],
  }, row.proxyHash)
  if (renderElementMapHash(map) !== row.mapHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored RenderElementMap hash is invalid')
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    proxyArtifactId: row.proxyArtifactId,
    mapHash: row.mapHash,
    map,
    createdAt: row.createdAt.toISOString(),
  })
}

export class PrismaRenderElementMapRepository implements RenderElementMapRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async findExact(input: { workspaceId: string; projectId: string; projectVersionId: string; proxyArtifactId: string }) {
    const row = await this.client.v2RenderElementMap.findFirst({ where: input })
    return row ? toRecord(row) : null
  }

  async persistOrReplay(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    proxyArtifactId: string
    map: Readonly<RenderElementMap>
    createdAt: string
  }) {
    const map = validateRenderElementMap(input.map, input.map.proxyHash)
    const mapHash = renderElementMapHash(map)
    return this.client.$transaction(async (transaction: Prisma.TransactionClient) => {
      const existing = await transaction.v2RenderElementMap.findFirst({
        where: {
          workspaceId: input.workspaceId,
          projectVersionId: input.projectVersionId,
          proxyArtifactId: input.proxyArtifactId,
        },
      })
      if (existing) {
        if (existing.projectId !== input.projectId || existing.proxyHash !== map.proxyHash || existing.mapHash !== mapHash) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'RenderElementMap replay changed immutable content')
        }
        return Object.freeze({ record: toRecord(existing), replayed: true })
      }
      const [version, artifact] = await Promise.all([
        transaction.v2ProjectVersion.findFirst({
          where: { id: input.projectVersionId, workspaceId: input.workspaceId, projectId: input.projectId },
          select: { id: true },
        }),
        transaction.v2MediaArtifact.findFirst({
          where: { id: input.proxyArtifactId, workspaceId: input.workspaceId, sha256: map.proxyHash, status: 'available' },
          select: { id: true },
        }),
      ])
      if (!version || !artifact) throw new DomainError('VERSION_CONFLICT', 'RenderElementMap target no longer matches the rendered artifact')
      const row = await transaction.v2RenderElementMap.create({
        data: {
          id: randomUUID(),
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: input.projectVersionId,
          proxyArtifactId: input.proxyArtifactId,
          proxyHash: map.proxyHash,
          mapHash,
          schemaVersion: map.schemaVersion,
          fps: map.fps,
          durationFrames: map.durationFrames,
          canvasWidth: map.canvas.width,
          canvasHeight: map.canvas.height,
          elementsJson: JSON.stringify(map.elements),
          createdAt: new Date(input.createdAt),
        },
      })
      return Object.freeze({ record: toRecord(row), replayed: false })
    }, { isolationLevel: 'Serializable' })
  }
}
