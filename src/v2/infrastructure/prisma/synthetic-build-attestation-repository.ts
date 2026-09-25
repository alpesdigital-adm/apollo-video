import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedSyntheticBuildAttestation,
  SyntheticBuildAttestationBinding,
  SyntheticBuildAttestationRepository,
} from '../../application/ports/synthetic-build-attestation-repository.ts'
import { calculateSyntheticBuildIdentityHash, assertSyntheticBuildAttestation, type SyntheticBuildAttestation } from '../../domain/synthetic-build-attestation.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { assertCurrentSyntheticRenderAuthority } from './synthetic-production-render-repository.ts'

function prismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function hydrate(row: Readonly<{
  attestationJson: string
  attestationHash: string
  requestFingerprint: string
  idempotencyKey: string
}>): Readonly<PersistedSyntheticBuildAttestation> {
  let parsed: SyntheticBuildAttestation
  try {
    parsed = JSON.parse(row.attestationJson) as SyntheticBuildAttestation
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic build attestation JSON is invalid')
  }
  assertSyntheticBuildAttestation(parsed)
  if (stableSerialize(parsed) !== row.attestationJson || parsed.attestationHash !== row.attestationHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic build attestation lost canonical integrity')
  }
  return Object.freeze({
    attestation: parsed,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
  })
}

async function readBindingFrom(
  client: Prisma.TransactionClient | PrismaClient,
  input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    productionRunId: string
    publicOperationId: string
    renderManifestId: string
  },
): Promise<Readonly<SyntheticBuildAttestationBinding> | null> {
  const render = await client.v2SyntheticProductionRenderOperation.findFirst({
    where: {
      operationId: input.publicOperationId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      productionRunId: input.productionRunId,
      outputManifestId: input.renderManifestId,
    },
    include: { operation: true, qualityReport: true },
  })
  if (!render) return null
  const checkpointFields = [
    render.runtimeCommitSha, render.runtimeTreeHash, render.runtimeContractGraphHash,
    render.runtimeToolchainHash, render.runtimeRenderBundleHash, render.runtimeIdentityHash,
    render.checkpointAttempt, render.checkpointOutputKey, render.checkpointOutputSha256,
    render.checkpointByteSize, render.checkpointWidth, render.checkpointHeight,
    render.checkpointFps, render.checkpointDurationFrames, render.checkpointCodec,
    render.checkpointAudioCodec, render.checkpointContainer, render.checkpointCommittedAt,
    render.checkpointRecordedAt,
  ]
  if (checkpointFields.some((value) => value === null) ||
    render.operation.status !== 'waiting' || render.operation.phase !== 'waiting' ||
    !render.qualityReport?.passed ||
    render.qualityReport.outputArtifactId !== render.outputArtifactId ||
    render.qualityReport.outputManifestId !== render.outputManifestId ||
    render.qualityReport.reportHash.length !== 64) return null
  await assertCurrentSyntheticRenderAuthority(client, render, new Date())
  const manifest = await client.v2MediaArtifactManifest.findFirst({
    where: {
      id: render.outputManifestId,
      workspaceId: render.workspaceId,
      artifactId: render.outputArtifactId,
      artifact: {
        status: 'available',
        sha256: render.checkpointOutputSha256!,
        byteSize: render.checkpointByteSize!,
        mediaType: 'video',
        container: 'mp4',
      },
    },
    select: { manifestHash: true },
  })
  if (!manifest) return null
  const identity = {
    commitSha: render.runtimeCommitSha!,
    treeHash: render.runtimeTreeHash!,
    contractGraphHash: render.runtimeContractGraphHash!,
    toolchainHash: render.runtimeToolchainHash!,
    renderBundleHash: render.runtimeRenderBundleHash!,
  }
  if (calculateSyntheticBuildIdentityHash(identity) !== render.runtimeIdentityHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic render runtime identity is inconsistent')
  }
  return Object.freeze({
    workspaceId: render.workspaceId,
    projectId: render.projectId,
    projectVersionId: render.projectVersionId,
    projectVersionHash: render.projectVersionHash,
    productionRunId: render.productionRunId,
    publicOperationId: render.operationId,
    planSnapshotId: render.editPlanSnapshotId,
    planSnapshotHash: render.editPlanSnapshotHash,
    renderManifestId: render.outputManifestId,
    renderManifestHash: manifest.manifestHash,
    runtimeCommitSha: identity.commitSha,
    runtimeTreeHash: identity.treeHash,
    runtimeContractGraphHash: identity.contractGraphHash,
    runtimeToolchainHash: identity.toolchainHash,
    runtimeRenderBundleHash: identity.renderBundleHash,
    runtimeIdentityHash: render.runtimeIdentityHash!,
  })
}

export class PrismaSyntheticBuildAttestationRepository implements SyntheticBuildAttestationRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  readBinding(input: Parameters<SyntheticBuildAttestationRepository['readBinding']>[0]) {
    return readBindingFrom(this.client, input)
  }

  async findReplay(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const row = await this.client.v2SyntheticBuildAttestation.findFirst({ where: input })
    return row ? hydrate(row) : null
  }

  async create(input: Parameters<SyntheticBuildAttestationRepository['create']>[0]) {
    const attestation = assertSyntheticBuildAttestation(input.attestation)
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2SyntheticBuildAttestation.findFirst({
          where: {
            workspaceId: attestation.workspaceId,
            projectId: attestation.projectId,
            idempotencyKey: input.idempotencyKey,
          },
        })
        if (existing) {
          const replay = hydrate(existing)
          if (replay.requestFingerprint !== input.requestFingerprint || replay.attestation.attestationHash !== attestation.attestationHash) {
            throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Build attestation idempotency key belongs to another payload')
          }
          return Object.freeze({ record: replay, replayed: true })
        }
        const binding = await readBindingFrom(transaction, {
          workspaceId: attestation.workspaceId,
          projectId: attestation.projectId,
          projectVersionId: attestation.projectVersionId,
          productionRunId: attestation.productionRunId,
          publicOperationId: attestation.publicOperationId,
          renderManifestId: attestation.renderManifestId,
        })
        if (!binding ||
          calculateCanonicalHash(binding) !== calculateCanonicalHash({
            workspaceId: attestation.workspaceId,
            projectId: attestation.projectId,
            projectVersionId: attestation.projectVersionId,
            projectVersionHash: attestation.projectVersionHash,
            productionRunId: attestation.productionRunId,
            publicOperationId: attestation.publicOperationId,
            planSnapshotId: attestation.planSnapshotId,
            planSnapshotHash: attestation.planSnapshotHash,
            renderManifestId: attestation.renderManifestId,
            renderManifestHash: attestation.renderManifestHash,
            runtimeCommitSha: attestation.identity.commitSha,
            runtimeTreeHash: attestation.identity.treeHash,
            runtimeContractGraphHash: attestation.identity.contractGraphHash,
            runtimeToolchainHash: attestation.identity.toolchainHash,
            runtimeRenderBundleHash: attestation.identity.renderBundleHash,
            runtimeIdentityHash: calculateSyntheticBuildIdentityHash(attestation.identity),
          })) {
          throw new DomainError('VERSION_CONFLICT', 'Synthetic render binding changed before attestation commit')
        }
        const row = await transaction.v2SyntheticBuildAttestation.create({
          data: {
            id: attestation.id,
            workspaceId: attestation.workspaceId,
            projectId: attestation.projectId,
            projectVersionId: attestation.projectVersionId,
            projectVersionHash: attestation.projectVersionHash,
            productionRunId: attestation.productionRunId,
            publicOperationId: attestation.publicOperationId,
            planSnapshotId: attestation.planSnapshotId,
            planSnapshotHash: attestation.planSnapshotHash,
            renderManifestId: attestation.renderManifestId,
            renderManifestHash: attestation.renderManifestHash,
            runtimeCommitSha: attestation.identity.commitSha,
            runtimeTreeHash: attestation.identity.treeHash,
            runtimeContractGraphHash: attestation.identity.contractGraphHash,
            runtimeToolchainHash: attestation.identity.toolchainHash,
            runtimeRenderBundleHash: attestation.identity.renderBundleHash,
            checksJson: stableSerialize(attestation.checks),
            startedAt: new Date(attestation.startedAt),
            completedAt: new Date(attestation.completedAt),
            attestationJson: stableSerialize(attestation),
            attestationHash: attestation.attestationHash,
            requestFingerprint: input.requestFingerprint,
            idempotencyKey: input.idempotencyKey,
            createdAt: new Date(attestation.completedAt),
          },
        })
        return Object.freeze({ record: hydrate(row), replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (!prismaCode(error, 'P2002')) throw error
      const replay = await this.findReplay({
        workspaceId: attestation.workspaceId,
        projectId: attestation.projectId,
        idempotencyKey: input.idempotencyKey,
      })
      if (!replay || replay.requestFingerprint !== input.requestFingerprint || replay.attestation.attestationHash !== attestation.attestationHash) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Build attestation concurrency winner could not be reconciled')
      }
      return Object.freeze({ record: replay, replayed: true })
    }
  }

  async read(input: { workspaceId: string; projectId: string; attestationId: string }) {
    const row = await this.client.v2SyntheticBuildAttestation.findFirst({
      where: { id: input.attestationId, workspaceId: input.workspaceId, projectId: input.projectId },
    })
    return row ? hydrate(row) : null
  }
}
