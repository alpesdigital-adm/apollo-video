import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  MulticamDiarizationRun,
  MulticamDiarizationSource,
} from '../../application/ports/multicam-evidence-sources.ts'
import { DomainError } from '../../domain/errors.ts'
import { hydrateSpeakerDiarizationRun } from '../../domain/speaker-diarization.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

/**
 * The persisted diarization the direction reads as speech evidence (F4.012).
 *
 * A read-only projection over `speaker_diarization_runs` and its segments —
 * deliberately not `SpeakerDiarizationRepository`, which can also persist runs
 * with a lease. The direction has no business writing one, and a port it cannot
 * write through is the cheapest way to keep it that way.
 *
 * **Read-only is not the same as unverified.** This class read `startMs`,
 * `endMs` and `speakerKey` straight off the columns, which meant a row edited
 * underneath produced observations, an evidence set, a `directionHash` and an
 * `evidenceRef` that all claimed a provenance nobody had checked — while the
 * authority repository for the same rows (`speaker-diarization-repository.ts:313`
 * and `:338`) refuses on exactly those hashes. It re-derives the run from
 * `runJson` here too: `hydrateSpeakerDiarizationRun` recomputes the run hash and
 * every segment hash from the stored body and refuses a body that does not
 * reproduce them, and the columns this projection actually returns are then
 * compared against that verified body. What is deliberately NOT re-checked is
 * the execution/workflow projection the authority repository also validates —
 * that is provenance of the analysis job, not of the segments, and requiring it
 * would drag the whole workflow aggregate into a read that needs three fields
 * per segment.
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
    return Object.freeze([...newest.values()].map((row) => Object.freeze(this.verify(row))))
  }

  /**
   * The row, proved against its own hashes before a single field escapes.
   *
   * Fail-closed and by name: an edited `startMs` is a different segment hash, an
   * edited `runJson` is a different run hash, and a `runJson` that no longer
   * describes the columns is a projection nobody can trust. Each is refused
   * with PERSISTENCE_CONFLICT rather than allowed to become an observation the
   * direction then cites as measured.
   */
  private verify(row: {
    id: string
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    providerId: string
    providerModel: string
    createdAt: Date
    runJson: string
    runHash: string
    segments: readonly Readonly<{
      id: string
      ordinal: number
      speakerKey: string
      startMs: number
      endMs: number
      segmentHash: string
    }>[]
  }): MulticamDiarizationRun {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.runJson)
    } catch {
      throw new DomainError('PERSISTENCE_CONFLICT', `Stored diarization run ${row.id} is not readable JSON`)
    }
    // Recomputes `runHash` and every `segmentHash` from the stored body and
    // refuses a body that does not reproduce them.
    const run = hydrateSpeakerDiarizationRun(parsed)
    if (
      run.id !== row.id ||
      run.workspaceId !== row.workspaceId ||
      run.projectId !== row.projectId ||
      run.sourceArtifactId !== row.sourceArtifactId ||
      run.provider.id !== row.providerId ||
      run.provider.model !== row.providerModel ||
      run.createdAt !== row.createdAt.toISOString() ||
      run.runHash !== row.runHash ||
      run.segments.length !== row.segments.length
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', `Stored diarization run ${row.id} does not match its verified body`)
    }
    const segments = run.segments.map((segment, index) => {
      const stored = row.segments[index]
      if (
        !stored ||
        stored.id !== segment.id ||
        stored.ordinal !== segment.ordinal ||
        stored.speakerKey !== segment.speakerKey ||
        stored.startMs !== segment.startMs ||
        stored.endMs !== segment.endMs ||
        stored.segmentHash !== segment.segmentHash
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          `Stored diarization segment ${stored?.id ?? index} of run ${row.id} does not match its verified body`,
        )
      }
      return Object.freeze({
        segmentId: segment.id,
        ordinal: segment.ordinal,
        speakerKey: segment.speakerKey,
        startMs: segment.startMs,
        endMs: segment.endMs,
      })
    })
    return {
      runId: run.id,
      sourceArtifactId: run.sourceArtifactId,
      provider: `${run.provider.id}/${run.provider.model}`,
      producedAt: run.createdAt,
      segments: Object.freeze(segments),
    }
  }
}
