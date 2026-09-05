import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  PlaybackMapDependencyRef,
  PlaybackMapRepository,
} from '../../application/ports/playback-map-repository.ts'
import { childRowId } from './child-row-id.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  PLAYBACK_MAP_SCHEMA_VERSION,
  assertPlaybackMapIntegrity,
  type PlaybackAnchor,
  type PlaybackDetectionMethod,
  type PlaybackDirection,
  type PlaybackDiscontinuityReason,
  type PlaybackMap,
  type PlaybackMapStatus,
  type PlaybackMapWarning,
  type PlaybackMode,
  type PlaybackPiece,
  type PlaybackUncoveredReason,
} from '../../domain/playback-map.ts'
import { createTickInterval, createTimebase, rational } from '../../domain/session-time.ts'
import type { AnchorOrigin } from '../../domain/sync-diagnostic.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function parse<T>(json: string, what: string): T {
  try {
    return JSON.parse(json) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${what} is not valid JSON`)
  }
}

/**
 * The workspace leads the key because the primary key is global while a
 * session id is only unique inside one workspace.
 */
function mapRowId(workspaceId: string, sessionId: string, reactionTrackId: string, version: number): string {
  return childRowId([workspaceId, sessionId, reactionTrackId, `pm${version}`], 160)
}

/**
 * Who a manual anchor's evidence names.
 *
 * `anchorEvidenceRef` (playback-map.ts:1396) writes `operator:<actorId>` with
 * the note in brackets after it, and the actor comes first precisely so a
 * caller-supplied note cannot displace it. The columns the CHECK reads are
 * therefore projected back out of that string rather than taken from anywhere
 * else — there is nowhere else, because `PlaybackAnchor` carries the evidence
 * and not the actor. An anchor whose evidence does not have that shape is
 * refused rather than stored with an invented actor.
 */
function manualActorOf(anchor: Readonly<PlaybackAnchor>): Readonly<{ actorId: string; note: string | null }> {
  const match = /^operator:([^\s(]+)(?: \((.+)\))?$/.exec(anchor.evidenceRef)
  if (!match || !match[1]) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Manual playback anchor ${anchor.anchorId} does not name the operator who placed it`,
      { evidenceRef: anchor.evidenceRef },
    )
  }
  return Object.freeze({ actorId: match[1], note: match[2] ?? null })
}

function hydratePiece(row: {
  pieceId: string
  ordinal: number
  mode: string
  reactionStartTicks: bigint
  reactionEndTicks: bigint
  referenceStartTicks: bigint | null
  referenceEndTicks: bigint | null
  rateNum: bigint | null
  rateDen: bigint | null
  direction: string
  confidence: number
  evidenceRefsJson: string
  detectionMethod: string
  residualTicks: bigint | null
  discontinuityReason: string | null
  pieceHash: string
}): Readonly<PlaybackPiece> {
  return Object.freeze({
    pieceId: row.pieceId,
    ordinal: row.ordinal,
    mode: row.mode as PlaybackMode,
    reactionRange: createTickInterval(row.reactionStartTicks, row.reactionEndTicks),
    referenceRange: row.referenceStartTicks === null || row.referenceEndTicks === null
      ? null
      : createTickInterval(row.referenceStartTicks, row.referenceEndTicks),
    // A rate is a measured slope. Null means nobody measured one, and 1/1 here
    // would be an unverified piece wearing a verified piece's clothes.
    rate: row.rateNum === null || row.rateDen === null ? null : rational(row.rateNum, row.rateDen),
    direction: row.direction as PlaybackDirection,
    confidence: row.confidence,
    evidenceRefs: Object.freeze(parse<string[]>(row.evidenceRefsJson, `piece ${row.pieceId} evidence refs`)),
    detectionMethod: row.detectionMethod as PlaybackDetectionMethod,
    residualTicks: row.residualTicks,
    discontinuityReason: row.discontinuityReason as PlaybackDiscontinuityReason | null,
    pieceHash: row.pieceHash,
  })
}

function hydrateAnchor(row: {
  anchorId: string
  ordinal: number
  origin: string
  reactionTick: bigint
  referenceTick: bigint | null
  mode: string | null
  method: string
  confidence: number
  evidenceRef: string
  createdAt: Date
}): Readonly<PlaybackAnchor> {
  return Object.freeze({
    anchorId: row.anchorId,
    origin: row.origin as AnchorOrigin,
    reactionTick: row.reactionTick,
    referenceTick: row.referenceTick,
    mode: row.mode as PlaybackMode | null,
    method: row.method as PlaybackDetectionMethod,
    confidence: row.confidence,
    evidenceRef: row.evidenceRef,
    createdAt: row.createdAt.toISOString(),
  })
}

interface MapRow {
  workspaceId: string
  sessionId: string
  schemaVersion: string
  mapId: string
  version: number
  previousVersionHash: string | null
  supersedesMapId: string | null
  sessionVersion: number
  referenceEpoch: number
  reactionTrackId: string
  referenceTrackId: string
  referenceAssetId: string
  referenceSha256: string
  referenceDurationTicks: bigint
  referenceTimebaseNum: bigint
  referenceTimebaseDen: bigint
  reactionAssetId: string
  reactionSha256: string
  reactionDurationTicks: bigint
  status: string
  warningsJson: string
  mapHash: string
  pieces: readonly Parameters<typeof hydratePiece>[0][]
  anchors: readonly Parameters<typeof hydrateAnchor>[0][]
  uncovered: readonly {
    ordinal: number
    reactionStartTicks: bigint
    reactionEndTicks: bigint
    reason: string
  }[]
}

function hydrateMap(row: MapRow): Readonly<PlaybackMap> {
  if (row.schemaVersion !== PLAYBACK_MAP_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored playback map ${row.mapId} carries an unknown schema version`,
    )
  }
  const map: PlaybackMap = {
    schemaVersion: PLAYBACK_MAP_SCHEMA_VERSION,
    mapId: row.mapId,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sessionVersion: row.sessionVersion,
    referenceEpoch: row.referenceEpoch,
    reactionTrackId: row.reactionTrackId,
    referenceTrackId: row.referenceTrackId,
    referenceMedia: Object.freeze({
      assetId: row.referenceAssetId,
      sha256: row.referenceSha256,
      durationTicks: row.referenceDurationTicks,
      // Seconds per tick as two integers: 1/48000 is exact, 0.0000208333 is not.
      timebase: createTimebase(rational(row.referenceTimebaseNum, row.referenceTimebaseDen)),
    }),
    reactionMedia: Object.freeze({
      assetId: row.reactionAssetId,
      sha256: row.reactionSha256,
      durationTicks: row.reactionDurationTicks,
    }),
    version: row.version,
    previousVersionHash: row.previousVersionHash,
    supersedesMapId: row.supersedesMapId,
    pieces: Object.freeze(
      [...row.pieces].sort((left, right) => left.ordinal - right.ordinal).map(hydratePiece),
    ),
    uncovered: Object.freeze(
      [...row.uncovered].sort((left, right) => left.ordinal - right.ordinal).map((range) => Object.freeze({
        range: createTickInterval(range.reactionStartTicks, range.reactionEndTicks),
        reason: range.reason as PlaybackUncoveredReason,
      })),
    ),
    // The order the map was hashed in, read back from the column that stores
    // it. Deriving it from `(reactionTick, anchorId)` was the same order only
    // while every map had at most one anchor: `applyPlaybackAnchor` appends,
    // so an operator who answers the later uncovered stretch first holds
    // [late, early], and a re-derived sort hands back [early, late] — a
    // different hash, and a map that could never be read again.
    anchors: Object.freeze(
      [...row.anchors].sort((left, right) => left.ordinal - right.ordinal).map(hydrateAnchor),
    ),
    status: row.status as PlaybackMapStatus,
    warnings: Object.freeze(
      parse<PlaybackMapWarning[]>(row.warningsJson, `playback map ${row.mapId} warnings`),
    ),
    mapHash: row.mapHash,
  }
  // Recomputes every piece hash and then the map hash, and proves the pieces
  // are a gap-free ordered sequence. A `paused` piece quietly given a
  // reference range in the database fails here rather than telling a reader
  // the reference advanced while it was stopped.
  return assertPlaybackMapIntegrity(Object.freeze(map))
}

const MAP_INCLUDE = {
  pieces: { orderBy: { ordinal: 'asc' } },
  anchors: { orderBy: { ordinal: 'asc' } },
  uncovered: { orderBy: { ordinal: 'asc' } },
} as const

export class PrismaPlaybackMapRepository implements PlaybackMapRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async appendVersion(input: {
    map: Readonly<PlaybackMap>
    expectedVersion?: number
    expectedHash?: string
    occurredAt: string
  }): Promise<Readonly<{ map: Readonly<PlaybackMap>; replayed: boolean }>> {
    const { map } = input
    const id = mapRowId(map.workspaceId, map.sessionId, map.reactionTrackId, map.version)
    const at = new Date(input.occurredAt)
    const referenced = map.pieces.filter((piece) => piece.referenceRange !== null).length
    const manualAnchors = map.anchors.filter((anchor) => anchor.origin === 'manual').length

    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.v2PlaybackMap.create({
          data: {
            id,
            workspaceId: map.workspaceId,
            sessionId: map.sessionId,
            schemaVersion: map.schemaVersion,
            mapId: map.mapId,
            version: map.version,
            previousVersionHash: map.previousVersionHash,
            supersedesMapId: map.supersedesMapId,
            sessionVersion: map.sessionVersion,
            referenceEpoch: map.referenceEpoch,
            reactionTrackId: map.reactionTrackId,
            referenceTrackId: map.referenceTrackId,
            referenceAssetId: map.referenceMedia.assetId,
            referenceSha256: map.referenceMedia.sha256,
            referenceDurationTicks: map.referenceMedia.durationTicks,
            referenceTimebaseNum: map.referenceMedia.timebase.secondsPerTick.num,
            referenceTimebaseDen: map.referenceMedia.timebase.secondsPerTick.den,
            reactionAssetId: map.reactionMedia.assetId,
            reactionSha256: map.reactionMedia.sha256,
            reactionDurationTicks: map.reactionMedia.durationTicks,
            status: map.status,
            warningsJson: JSON.stringify(map.warnings),
            pieceCount: map.pieces.length,
            referencedPieceCount: referenced,
            uncoveredCount: map.uncovered.length,
            anchorCount: map.anchors.length,
            manualAnchorCount: manualAnchors,
            mapHash: map.mapHash,
            createdAt: at,
          },
        })

        await transaction.v2PlaybackPiece.createMany({
          data: map.pieces.map((piece) => ({
            id: childRowId([id, `p${piece.ordinal}`], 160),
            workspaceId: map.workspaceId,
            mapId: id,
            pieceId: piece.pieceId,
            ordinal: piece.ordinal,
            mode: piece.mode,
            reactionStartTicks: piece.reactionRange.start,
            reactionEndTicks: piece.reactionRange.end,
            referenceStartTicks: piece.referenceRange?.start ?? null,
            referenceEndTicks: piece.referenceRange?.end ?? null,
            rateNum: piece.rate?.num ?? null,
            rateDen: piece.rate?.den ?? null,
            direction: piece.direction,
            confidence: piece.confidence,
            evidenceRefsJson: JSON.stringify(piece.evidenceRefs),
            evidenceRefCount: piece.evidenceRefs.length,
            detectionMethod: piece.detectionMethod,
            residualTicks: piece.residualTicks,
            discontinuityReason: piece.discontinuityReason,
            pieceHash: piece.pieceHash,
          })),
        })

        if (map.anchors.length > 0) {
          await transaction.v2PlaybackAnchor.createMany({
            data: map.anchors.map((anchor, ordinal) => {
              const actor = anchor.origin === 'manual' ? manualActorOf(anchor) : null
              return {
                id: childRowId([id, anchor.anchorId], 160),
                workspaceId: map.workspaceId,
                mapId: id,
                anchorId: anchor.anchorId,
                // The index in the array the map hash covers, not a re-derived
                // rank: the anchors are appended, never sorted.
                ordinal,
                origin: anchor.origin,
                reactionTick: anchor.reactionTick,
                referenceTick: anchor.referenceTick,
                mode: anchor.mode,
                method: anchor.method,
                confidence: anchor.confidence,
                evidenceRef: anchor.evidenceRef,
                actorKind: actor === null ? null : 'human',
                actorId: actor?.actorId ?? null,
                note: actor?.note ?? null,
                createdAt: new Date(anchor.createdAt),
              }
            }),
          })
        }

        if (map.uncovered.length > 0) {
          await transaction.v2PlaybackUncoveredRange.createMany({
            data: map.uncovered.map((range, ordinal) => ({
              id: childRowId([id, `u${ordinal}`], 160),
              workspaceId: map.workspaceId,
              mapId: id,
              ordinal,
              reactionStartTicks: range.range.start,
              reactionEndTicks: range.range.end,
              reason: range.reason,
            })),
          })
        }

        if (map.version === 1) {
          await transaction.v2PlaybackMapHead.create({
            data: {
              id: childRowId([map.workspaceId, map.sessionId, map.reactionTrackId], 160),
              workspaceId: map.workspaceId,
              sessionId: map.sessionId,
              reactionTrackId: map.reactionTrackId,
              mapId: map.mapId,
              version: 1,
              mapHash: map.mapHash,
              status: map.status,
              createdAt: at,
              updatedAt: at,
            },
          })
          return
        }

        // Both halves of the fence, in the predicate: two operators resolving
        // the same uncovered stretch from two machines cannot both write
        // version N+1, and the one that loses is told what it lost to.
        const expectedVersion = input.expectedVersion ?? map.version - 1
        const expectedHash = input.expectedHash ?? map.previousVersionHash
        const advanced = await transaction.v2PlaybackMapHead.updateMany({
          where: {
            workspaceId: map.workspaceId,
            sessionId: map.sessionId,
            reactionTrackId: map.reactionTrackId,
            version: expectedVersion,
            ...(expectedHash === null || expectedHash === undefined ? {} : { mapHash: expectedHash }),
          },
          data: {
            mapId: map.mapId,
            version: map.version,
            mapHash: map.mapHash,
            status: map.status,
            updatedAt: at,
          },
        })
        if (advanced.count !== 1) {
          const current = await transaction.v2PlaybackMapHead.findFirst({
            where: {
              workspaceId: map.workspaceId,
              sessionId: map.sessionId,
              reactionTrackId: map.reactionTrackId,
            },
            select: { version: true, mapHash: true },
          })
          throw new DomainError(
            'PLAYBACK_MAP_VERSION_STALE',
            `The playback map for ${map.sessionId}/${map.reactionTrackId} is at version ${current?.version ?? 'none'}; this one was computed against ${expectedVersion}`,
            { currentVersion: current?.version ?? null, currentHash: current?.mapHash ?? null },
          )
        }
      })
      return Object.freeze({ map, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.readVersion({
        workspaceId: map.workspaceId,
        sessionId: map.sessionId,
        reactionTrackId: map.reactionTrackId,
        version: map.version,
      })
      if (stored && stored.mapHash === map.mapHash) {
        return Object.freeze({ map: stored, replayed: true })
      }
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `The playback map for ${map.sessionId}/${map.reactionTrackId} already has a different version ${map.version}`,
      )
    }
  }

  async readHead(input: { workspaceId: string; sessionId: string; reactionTrackId: string }) {
    const head = await this.client.v2PlaybackMapHead.findFirst({
      where: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        reactionTrackId: input.reactionTrackId,
      },
      select: { version: true },
    })
    return head ? this.readVersion({ ...input, version: head.version }) : null
  }

  async readVersion(input: {
    workspaceId: string
    sessionId: string
    reactionTrackId: string
    version: number
  }) {
    const row = await this.client.v2PlaybackMap.findFirst({
      where: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        reactionTrackId: input.reactionTrackId,
        version: input.version,
      },
      include: MAP_INCLUDE,
    })
    return row ? hydrateMap(row) : null
  }

  async listVersions(input: {
    workspaceId: string
    sessionId: string
    reactionTrackId: string
    limit?: number
  }) {
    const rows = await this.client.v2PlaybackMap.findMany({
      where: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        reactionTrackId: input.reactionTrackId,
      },
      orderBy: { version: 'desc' },
      take: Math.min(Math.max(input.limit ?? 25, 1), 200),
      include: MAP_INCLUDE,
    })
    return Object.freeze(rows.map(hydrateMap))
  }

  async findDependentsOfReference(input: {
    workspaceId: string
    referenceAssetId: string
    referenceSha256: string
  }): Promise<readonly Readonly<PlaybackMapDependencyRef>[]> {
    const rows = await this.client.v2PlaybackMap.findMany({
      where: {
        workspaceId: input.workspaceId,
        referenceAssetId: input.referenceAssetId,
        referenceSha256: input.referenceSha256,
      },
      orderBy: [{ sessionId: 'asc' }, { reactionTrackId: 'asc' }, { version: 'desc' }],
      select: {
        sessionId: true,
        reactionTrackId: true,
        mapId: true,
        version: true,
        mapHash: true,
        status: true,
      },
    })
    if (rows.length === 0) return Object.freeze([])
    const heads = await this.client.v2PlaybackMapHead.findMany({
      where: {
        workspaceId: input.workspaceId,
        sessionId: { in: [...new Set(rows.map((row) => row.sessionId))] },
      },
      select: { sessionId: true, reactionTrackId: true, mapHash: true },
    })
    const headHashes = new Map(
      heads.map((head) => [`${head.sessionId}/${head.reactionTrackId}`, head.mapHash]),
    )
    return Object.freeze(rows.map((row) => Object.freeze({
      ...row,
      isHead: headHashes.get(`${row.sessionId}/${row.reactionTrackId}`) === row.mapHash,
    })))
  }
}
