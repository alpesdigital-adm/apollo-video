import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  RenderSourceRepository,
  ResolvedRenderSource,
} from '../../application/ports/render-source-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

/**
 * Resolve a plan's declared sources exactly the way the renderer will.
 *
 * `PrismaProjectProxyRenderRepository` (`project-proxy-render-repository.ts`)
 * takes every `clip.sourceArtifactId` from the stored plan and looks it up in
 * `project.mediaAssets`, refusing with `PERSISTENCE_CONFLICT` — "Referenced
 * render source <id> is unavailable" — when the link is missing, the artifact
 * is not `available`, its media type is not video or audio, or it carries no
 * manifest. This adapter asks the same question at compile time, so a plan that
 * would fail at render time fails while the refusal can still name the
 * derivation that produced it.
 *
 * The measured duration comes from the artifact manifest's `probe.duration`
 * (`domain/media-artifact.ts:104-108`), which is what FFprobe reported on the
 * ingested file. It is optional in the manifest schema, so it is `null` here
 * when absent rather than 0: a compiler that needs it refuses by name, and one
 * that does not is not forced to invent a reason to care.
 */
export class PrismaRenderSourceRepository implements RenderSourceRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async resolveForProject(input: {
    workspaceId: string
    projectId: string
    artifactIds: readonly string[]
  }): Promise<readonly Readonly<ResolvedRenderSource>[]> {
    const wanted = [...new Set(input.artifactIds)]
    if (wanted.length === 0) return Object.freeze([])
    const links = await this.client.v2ProjectMediaAsset.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        artifactId: { in: wanted },
      },
      select: {
        artifactId: true,
        artifact: {
          select: {
            sha256: true,
            byteSize: true,
            mediaType: true,
            status: true,
            manifests: {
              select: { id: true, manifestJson: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
        },
      },
    })

    const resolved = new Map<string, Readonly<ResolvedRenderSource>>()
    for (const link of links) {
      // One artifact can be linked to a project under more than one role
      // (source-master and editorial-proxy name different artifacts, but a
      // duplicate row is not forbidden by the schema). The artifact is the same
      // either way, so the first reading wins rather than the last.
      if (resolved.has(link.artifactId)) continue
      const artifact = link.artifact
      const manifest = artifact.manifests[0]
      const byteSize = Number(artifact.byteSize)
      if (
        artifact.status !== 'available' ||
        !['video', 'audio'].includes(artifact.mediaType) ||
        !manifest ||
        !Number.isSafeInteger(byteSize) ||
        byteSize <= 0
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          `Referenced render source ${link.artifactId} is unavailable`,
          { artifactId: link.artifactId, status: artifact.status, mediaType: artifact.mediaType },
        )
      }
      resolved.set(link.artifactId, Object.freeze({
        artifactId: link.artifactId,
        sha256: artifact.sha256,
        byteSize,
        mediaType: artifact.mediaType as 'video' | 'audio',
        durationSeconds: probeDuration(manifest.manifestJson, manifest.id),
      }))
    }
    // Ordered by what was asked for, not by what the database returned: a caller
    // that reports "these are missing" must not have that list depend on a row
    // order nothing declares.
    return Object.freeze(wanted.flatMap((artifactId) => {
      const entry = resolved.get(artifactId)
      return entry ? [entry] : []
    }))
  }
}

function probeDuration(manifestJson: string, manifestId: string): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestJson)
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored media artifact manifest ${manifestId} is invalid`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored media artifact manifest ${manifestId} is invalid`,
    )
  }
  const probe = (parsed as Record<string, unknown>).probe
  if (typeof probe !== 'object' || probe === null || Array.isArray(probe)) return null
  const duration = (probe as Record<string, unknown>).duration
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null
  return duration
}
