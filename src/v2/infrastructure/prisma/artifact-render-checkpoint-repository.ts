import type { Prisma, PrismaClient } from '@prisma/client'

import type {
  ArtifactRenderCheckpoint,
  ArtifactRenderCheckpointRepository,
  ArtifactRenderCheckpointResult,
} from '../../application/ports/artifact-render-checkpoint-repository.ts'
import type { PublicOperationLeaseCommand } from '../../application/ports/public-operation-repository.ts'
import type { CommittedRenderReceipt } from '../../application/ports/render-input-renderer.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertMediaArtifactManifest,
  type MediaArtifactManifest,
} from '../../domain/media-artifact.ts'

type StoredRender = Prisma.V2ArtifactRenderOperationGetPayload<{
  include: { artifact: true; manifest: true; operation: true }
}>

const OUTPUT_INCLUDE = {
  artifact: true,
  manifest: true,
  operation: true,
} as const
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const OUTPUT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,510}\.mp4$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function parseDate(value: string, field: string): Date {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new DomainError('INVALID_PUBLIC_OPERATION', `${field} must be a valid date`)
  }
  return date
}

function validateOutputKey(value: string): string {
  const segments = value.split('/')
  if (
    !OUTPUT_KEY_PATTERN.test(value) ||
    value.length > 512 ||
    value.includes('//') ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    throw new DomainError('INVALID_PUBLIC_OPERATION', 'Render checkpoint output key is invalid')
  }
  return value
}

function validateReceipt(output: CommittedRenderReceipt): void {
  if (
    output.schemaVersion !== 'committed-render-receipt/v1' ||
    !ID_PATTERN.test(output.stageId) ||
    !SHA256_PATTERN.test(output.inputHash) ||
    !SHA256_PATTERN.test(output.outputSha256) ||
    !Number.isSafeInteger(output.byteSize) ||
    output.byteSize <= 0 ||
    !Number.isSafeInteger(output.width) ||
    output.width <= 0 ||
    !Number.isSafeInteger(output.height) ||
    output.height <= 0 ||
    !Number.isFinite(output.fps) ||
    output.fps <= 0 ||
    !Number.isSafeInteger(output.durationInFrames) ||
    output.durationInFrames <= 0 ||
    output.codec !== 'h264' ||
    output.container !== 'mp4' ||
    Number.isNaN(Date.parse(output.committedAt))
  ) {
    throw new DomainError('INVALID_PUBLIC_OPERATION', 'Render checkpoint receipt is invalid')
  }
}

function parseManifest(row: StoredRender): MediaArtifactManifest {
  try {
    const manifest = JSON.parse(row.manifest.manifestJson) as MediaArtifactManifest
    assertMediaArtifactManifest(manifest)
    return manifest
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Render target manifest is invalid')
  }
}

function assertTargetMatches(
  row: StoredRender,
  output: CommittedRenderReceipt,
): void {
  const manifest = parseManifest(row)
  const probe = manifest.probe
  const probeMatches = !probe || (
    probe.width === output.width &&
    probe.height === output.height &&
    Math.abs(probe.fps - output.fps) <= 0.01 &&
    Math.abs(probe.duration - output.durationInFrames / output.fps) <=
      Math.max(0.1, 1 / output.fps)
  )
  if (
    row.workspaceId !== row.operation.workspaceId ||
    row.artifactId !== row.operation.targetId ||
    row.manifestId !== row.manifest.id ||
    row.manifest.artifactId !== row.artifactId ||
    manifest.artifact.artifactKey !== row.artifact.artifactKey ||
    manifest.artifact.sha256 !== row.artifact.sha256 ||
    BigInt(manifest.artifact.byteSize) !== row.artifact.byteSize ||
    output.inputHash !== row.inputHash ||
    output.outputSha256 !== row.artifact.sha256 ||
    BigInt(output.byteSize) !== row.artifact.byteSize ||
    output.container !== row.artifact.container ||
    !probeMatches
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Committed render does not match its target artifact manifest',
    )
  }
}

function hasAnyOutput(row: StoredRender): boolean {
  return [
    row.outputKey,
    row.outputSha256,
    row.outputByteSize,
    row.outputWidth,
    row.outputHeight,
    row.outputFps,
    row.outputDurationInFrames,
    row.outputCodec,
    row.outputContainer,
    row.outputAttempt,
    row.outputCommittedAt,
    row.outputRecordedAt,
  ].some((value) => value !== null)
}

function hydrate(row: StoredRender): Readonly<ArtifactRenderCheckpoint> | null {
  if (!hasAnyOutput(row)) return null
  if (
    row.outputKey === null ||
    row.outputSha256 === null ||
    row.outputByteSize === null ||
    row.outputWidth === null ||
    row.outputHeight === null ||
    row.outputFps === null ||
    row.outputDurationInFrames === null ||
    row.outputCodec !== 'h264' ||
    row.outputContainer !== 'mp4' ||
    row.outputAttempt === null ||
    row.outputCommittedAt === null ||
    row.outputRecordedAt === null ||
    row.outputByteSize > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored render checkpoint is incomplete')
  }
  const output: CommittedRenderReceipt = {
    schemaVersion: 'committed-render-receipt/v1',
    stageId: `checkpoint-${row.outputSha256.slice(0, 16)}`,
    inputHash: row.inputHash,
    outputSha256: row.outputSha256,
    byteSize: Number(row.outputByteSize),
    width: row.outputWidth,
    height: row.outputHeight,
    fps: row.outputFps,
    durationInFrames: row.outputDurationInFrames,
    codec: 'h264',
    container: 'mp4',
    committedAt: row.outputCommittedAt.toISOString(),
  }
  validateOutputKey(row.outputKey)
  validateReceipt(output)
  assertTargetMatches(row, output)
  if (
    row.outputAttempt <= 0 ||
    row.outputRecordedAt.getTime() < row.outputCommittedAt.getTime()
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored render checkpoint dates are invalid')
  }
  return Object.freeze({
    operationId: row.operationId,
    workspaceId: row.workspaceId,
    artifactId: row.artifactId,
    manifestId: row.manifestId,
    inputHash: row.inputHash,
    outputKey: row.outputKey,
    output: Object.freeze(output),
    attempt: row.outputAttempt,
    recordedAt: row.outputRecordedAt.toISOString(),
  })
}

function sameOutput(
  checkpoint: ArtifactRenderCheckpoint,
  outputKey: string,
  output: CommittedRenderReceipt,
): boolean {
  return (
    checkpoint.outputKey === outputKey &&
    checkpoint.output.inputHash === output.inputHash &&
    checkpoint.output.outputSha256 === output.outputSha256 &&
    checkpoint.output.byteSize === output.byteSize &&
    checkpoint.output.width === output.width &&
    checkpoint.output.height === output.height &&
    Math.abs(checkpoint.output.fps - output.fps) <= 0.000001 &&
    checkpoint.output.durationInFrames === output.durationInFrames &&
    checkpoint.output.codec === output.codec &&
    checkpoint.output.container === output.container
  )
}

export class PrismaArtifactRenderCheckpointRepository
  implements ArtifactRenderCheckpointRepository
{
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  private findStored(operationId: string): Promise<StoredRender | null> {
    return this.client.v2ArtifactRenderOperation.findUnique({
      where: { operationId },
      include: OUTPUT_INCLUDE,
    })
  }

  async findByOperationId(
    operationId: string,
  ): Promise<Readonly<ArtifactRenderCheckpoint> | null> {
    const stored = await this.findStored(operationId)
    return stored ? hydrate(stored) : null
  }

  async record(input: PublicOperationLeaseCommand & {
    outputKey: string
    output: CommittedRenderReceipt
  }): Promise<ArtifactRenderCheckpointResult | null> {
    const now = parseDate(input.now, 'now')
    const committedAt = parseDate(input.output.committedAt, 'output.committedAt')
    validateReceipt(input.output)
    const outputKey = validateOutputKey(input.outputKey)
    if (
      !ID_PATTERN.test(input.operationId) ||
      !ID_PATTERN.test(input.leaseOwner) ||
      !Number.isSafeInteger(input.attempt) ||
      input.attempt <= 0 ||
      committedAt.getTime() > now.getTime()
    ) {
      throw new DomainError('INVALID_PUBLIC_OPERATION', 'Render checkpoint command is invalid')
    }

    return this.client.$transaction(async (transaction) => {
      const stored = await transaction.v2ArtifactRenderOperation.findUnique({
        where: { operationId: input.operationId },
        include: OUTPUT_INCLUDE,
      })
      if (!stored) return null
      assertTargetMatches(stored, input.output)
      const fenced = await transaction.v2PublicOperation.updateMany({
        where: {
          id: input.operationId,
          status: 'running',
          phase: 'persisting',
          leaseOwner: input.leaseOwner,
          attempt: input.attempt,
          leaseExpiresAt: { gt: now },
          updatedAt: { lte: now },
        },
        data: { updatedAt: now },
      })
      if (fenced.count !== 1) return null

      const existing = hydrate(stored)
      if (existing) {
        if (!sameOutput(existing, outputKey, input.output)) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Render checkpoint conflicts with the committed output',
          )
        }
        return { checkpoint: existing, replayed: true }
      }

      const written = await transaction.v2ArtifactRenderOperation.updateMany({
        where: { operationId: input.operationId, outputKey: null },
        data: {
          outputKey,
          outputSha256: input.output.outputSha256,
          outputByteSize: BigInt(input.output.byteSize),
          outputWidth: input.output.width,
          outputHeight: input.output.height,
          outputFps: input.output.fps,
          outputDurationInFrames: input.output.durationInFrames,
          outputCodec: input.output.codec,
          outputContainer: input.output.container,
          outputAttempt: input.attempt,
          outputCommittedAt: committedAt,
          outputRecordedAt: now,
        },
      })
      if (written.count !== 1) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Render checkpoint write collided')
      }
      const persisted = await transaction.v2ArtifactRenderOperation.findUnique({
        where: { operationId: input.operationId },
        include: OUTPUT_INCLUDE,
      })
      const checkpoint = persisted ? hydrate(persisted) : null
      if (!checkpoint) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Render checkpoint was not persisted')
      }
      return { checkpoint, replayed: false }
    })
  }
}
