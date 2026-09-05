import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  MulticamDiarizationRun,
  MulticamDiarizationSource,
} from '../../application/ports/multicam-evidence-sources.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

/**
 * The persisted diarization the direction reads as speech evidence (F4.012).
 *
 * A read-only projection over `speaker_diarization_runs` and its segments —
 * deliberately not `SpeakerDiarizationRepository`, which can also persist runs
 * with a lease. The direction has no business writing one, and a port it cannot
 * write through is the cheapest way to keep it that way.
 *
 * One run per artifact, the newest. Two runs of the same file are two opinions
 * about the same speech; directing on both would count one person's turn twice,
 * and picking the older one would direct on a superseded analysis. The index
 * `[workspaceId, sourceArtifactId, createdAt desc]` (`schema.prisma:5307`)
 * exists for exactly this query.
 *
 * Nothing here interprets: the milliseconds stay relative to the file, and
 * `speakerKey` stays a cluster key. Mapping onto the session clock and labelling
 * the observation `identityResolved: false` is the producer's work, in one
 * place.
 */
export class PrismaMulticamDiarizationSource implements MulticamDiarizationSource {
  private readonly client: PrismaClient

  // No parameter property: plain `node` in strip-only mode refuses one, and
  // this class is reachable from suites that run under it.
  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async listLatestRunsForArtifacts(input: {
    workspaceId: string
    projectId: string
    sourceArtifactIds: readonly string[]
  }): Promise<readonly Readonly<MulticamDiarizationRun>[]> {
    const artifactIds = [...new Set(input.sourceArtifactIds)].filter((id) => id.length > 0)
    if (artifactIds.length === 0) return Object.freeze([])
    const rows = await this.client.v2SpeakerDiarizationRun.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        sourceArtifactId: { in: artifactIds },
      },
      orderBy: [{ sourceArtifactId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      include: { segments: { orderBy: { ordinal: 'asc' } } },
    })
    const newest = new Map<string, (typeof rows)[number]>()
    for (const row of rows) {
      // Ordered newest-first per artifact, so the first one seen wins and the
      // rest are the superseded opinions.
      if (!newest.has(row.sourceArtifactId)) newest.set(row.sourceArtifactId, row)
    }
    return Object.freeze([...newest.values()].map((row) => Object.freeze({
      runId: row.id,
      sourceArtifactId: row.sourceArtifactId,
      provider: `${row.providerId}/${row.providerModel}`,
      producedAt: row.createdAt.toISOString(),
      segments: Object.freeze(row.segments.map((segment) => Object.freeze({
        segmentId: segment.id,
        ordinal: segment.ordinal,
        speakerKey: segment.speakerKey,
        startMs: segment.startMs,
        endMs: segment.endMs,
      }))),
    })))
  }
}
