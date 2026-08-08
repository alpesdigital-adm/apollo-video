import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { ProjectMediaRepository } from '../../application/ports/media-ingest.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { projectStatusTransitionPath } from '../../domain/project.ts'
import type { MediaColorProbe } from '../../domain/color-and-export.ts'
import { createProjectVersion } from '../../domain/project-version.ts'

function colorProbeData(probe: Readonly<MediaColorProbe>) {
  const { probeHash, ...content } = probe
  if (calculateCanonicalHash(content) !== probeHash) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Media color probe hash is invalid',
    )
  }
  return {
    id: probe.id,
    workspaceId: probe.workspaceId,
    artifactId: probe.artifactId,
    manifestId: probe.manifestId,
    schemaVersion: probe.schemaVersion,
    state: probe.detection.state,
    metadataJson: stableSerialize(
      probe.detection.state === 'ready'
        ? probe.detection.metadata
        : null,
    ),
    pixelFormat: probe.detection.pixelFormat ?? null,
    hdrMode: probe.detection.state === 'ready'
      ? probe.detection.hdrMode
      : null,
    reasonsJson: stableSerialize(
      probe.detection.state === 'unavailable'
        ? probe.detection.reasons
        : [],
    ),
    producerProvider: probe.producer.provider,
    producerVersion: probe.producer.version,
    producerBinaryDigest: probe.producer.binaryDigest,
    createdAt: new Date(probe.createdAt),
    probeHash,
  }
}

function storedColorProbeMatches(
  stored: object,
  expected: ReturnType<typeof colorProbeData>,
) {
  return Object.entries(expected).every(([key, value]) => {
    const actual = (stored as Record<string, unknown>)[key]
    return value instanceof Date && actual instanceof Date
      ? value.getTime() === actual.getTime()
      : actual === value
  })
}

export class PrismaProjectMediaRepository implements ProjectMediaRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async readProject(input: { workspaceId: string; projectId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: true },
    })
    if (!project?.currentVersion) return null
    const version = project.currentVersion
    if (!version.briefSnapshotId || !version.policiesSnapshotId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Ingest project version is missing foundation snapshots')
    }
    return Object.freeze({
      id: project.id,
      locale: project.locale ?? 'pt-BR',
      currentVersion: createProjectVersion({
        id: version.id,
        workspaceId: version.workspaceId,
        projectId: version.projectId,
        sequence: version.sequence,
        ...(version.parentVersionId ? { parentVersionId: version.parentVersionId } : {}),
        snapshotRefs: {
          brief: version.briefSnapshotId,
          ...(version.treatmentSnapshotId ? { treatment: version.treatmentSnapshotId } : {}),
          ...(version.storySnapshotId ? { story: version.storySnapshotId } : {}),
          editPlan: version.editPlanSnapshotId,
          policies: version.policiesSnapshotId,
        },
        baseHash: version.baseHash,
        createdBy: version.createdBy,
        ...(version.commandId ? { commandId: version.commandId } : {}),
        createdAt: version.createdAt.toISOString(),
      }),
    })
  }

  async persistCompletedIngest(input: Parameters<ProjectMediaRepository['persistCompletedIngest']>[0]): Promise<void> {
    const transcriptJson = stableSerialize(input.transcript)
    const sourceColorProbe = colorProbeData(input.sourceColorProbe)
    const proxyColorProbe = colorProbeData(input.proxyColorProbe)
    await this.client.$transaction(async (transaction) => {
      const [project, source, proxy, sourceManifest, proxyManifest, upload] = await Promise.all([
        transaction.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, select: { id: true, currentVersionId: true } }),
        transaction.v2MediaArtifact.findFirst({ where: { id: input.sourceArtifactId, workspaceId: input.workspaceId }, select: { id: true } }),
        transaction.v2MediaArtifact.findFirst({ where: { id: input.proxyArtifactId, workspaceId: input.workspaceId }, select: { id: true } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.sourceManifestId, workspaceId: input.workspaceId, artifactId: input.sourceArtifactId }, select: { id: true, manifestHash: true } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.proxyManifestId, workspaceId: input.workspaceId, artifactId: input.proxyArtifactId }, select: { id: true, manifestHash: true } }),
        transaction.v2MediaUpload.findFirst({ where: { id: input.uploadId, workspaceId: input.workspaceId, projectId: input.projectId, status: 'verified', rightsConfirmed: true }, select: { id: true } }),
      ])
      if (!project || !source || !proxy || !sourceManifest || !proxyManifest || !upload || sourceManifest.manifestHash !== input.sourceManifest.manifestHash || proxyManifest.manifestHash !== input.proxyManifest.manifestHash) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Completed ingest references are not internally consistent')
      }
      const { snapshot, version, event } = input.initialPlan
      if (
        snapshot.workspaceId !== input.workspaceId || snapshot.projectId !== input.projectId ||
        snapshot.kind !== 'edit-plan' || snapshot.id !== version.snapshotRefs.editPlan ||
        version.workspaceId !== input.workspaceId || version.projectId !== input.projectId ||
        !version.parentVersionId ||
        !version.snapshotRefs.brief || !version.snapshotRefs.policies ||
        event.workspaceId !== input.workspaceId || event.resource.type !== 'project-version' ||
        event.resource.id !== version.id || event.sequence !== version.sequence ||
        (project.currentVersionId !== version.parentVersionId && project.currentVersionId !== version.id)
      ) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Initial ingest EditPlan lineage is invalid')
      }
      if (
        sourceColorProbe.workspaceId !== input.workspaceId ||
        sourceColorProbe.artifactId !== input.sourceArtifactId ||
        sourceColorProbe.manifestId !== input.sourceManifestId ||
        proxyColorProbe.workspaceId !== input.workspaceId ||
        proxyColorProbe.artifactId !== input.proxyArtifactId ||
        proxyColorProbe.manifestId !== input.proxyManifestId
      ) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Completed ingest color probe identity is invalid',
        )
      }
      for (const probe of [sourceColorProbe, proxyColorProbe]) {
        const existing = await transaction.v2MediaColorProbe.findUnique({
          where: {
            workspaceId_artifactId_manifestId: {
              workspaceId: probe.workspaceId,
              artifactId: probe.artifactId,
              manifestId: probe.manifestId,
            },
          },
        })
        if (existing) {
          if (!storedColorProbeMatches(existing, probe)) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Media color probe identity collided with different evidence',
            )
          }
        } else {
          await transaction.v2MediaColorProbe.create({ data: probe })
        }
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
      const storedSnapshot = await transaction.v2ProjectSnapshot.findUnique({
        where: { id: snapshot.id },
      })
      if (storedSnapshot) {
        if (
          storedSnapshot.workspaceId !== snapshot.workspaceId ||
          storedSnapshot.projectId !== snapshot.projectId ||
          storedSnapshot.kind !== snapshot.kind ||
          storedSnapshot.schemaVersion !== snapshot.contentSchemaVersion ||
          storedSnapshot.contentJson !== snapshot.contentJson ||
          storedSnapshot.contentHash !== snapshot.contentHash
        ) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Initial ingest EditPlan snapshot collided')
        }
      } else {
        await transaction.v2ProjectSnapshot.create({
          data: {
            id: snapshot.id,
            workspaceId: snapshot.workspaceId,
            projectId: snapshot.projectId,
            kind: snapshot.kind,
            schemaVersion: snapshot.contentSchemaVersion,
            contentJson: snapshot.contentJson,
            contentHash: snapshot.contentHash,
            createdAt: new Date(snapshot.createdAt),
          },
        })
      }
      const storedVersion = await transaction.v2ProjectVersion.findUnique({
        where: { id: version.id },
      })
      if (storedVersion) {
        if (
          storedVersion.workspaceId !== version.workspaceId ||
          storedVersion.projectId !== version.projectId ||
          storedVersion.sequence !== version.sequence ||
          storedVersion.parentVersionId !== version.parentVersionId ||
          storedVersion.editPlanSnapshotId !== version.snapshotRefs.editPlan ||
          storedVersion.baseHash !== version.baseHash
        ) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Initial ingest ProjectVersion collided')
        }
      } else {
        await transaction.v2ProjectVersion.create({
          data: {
            id: version.id,
            workspaceId: version.workspaceId,
            projectId: version.projectId,
            sequence: version.sequence,
            parentVersionId: version.parentVersionId,
            briefSnapshotId: version.snapshotRefs.brief!,
            treatmentSnapshotId: version.snapshotRefs.treatment,
            storySnapshotId: version.snapshotRefs.story,
            editPlanSnapshotId: version.snapshotRefs.editPlan,
            policiesSnapshotId: version.snapshotRefs.policies,
            baseHash: version.baseHash,
            createdBy: version.createdBy,
            createdAt: new Date(version.createdAt),
          },
        })
      }
      const storedEvent = await transaction.v2PublicEventOutbox.findUnique({
        where: { id: event.id },
      })
      const eventDataJson = stableSerialize(event.data)
      if (storedEvent) {
        if (
          storedEvent.workspaceId !== event.workspaceId ||
          storedEvent.type !== event.type ||
          storedEvent.resourceId !== event.resource.id ||
          storedEvent.dataJson !== eventDataJson
        ) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'Initial ingest event collided')
        }
      } else {
        await transaction.v2PublicEventOutbox.create({
          data: {
            id: event.id,
            workspaceId: event.workspaceId,
            type: event.type,
            version: event.version,
            occurredAt: new Date(event.occurredAt),
            sequence: event.sequence,
            actorClientId: event.actor?.clientId,
            actorUserId: event.actor?.userId,
            resourceType: event.resource.type,
            resourceId: event.resource.id,
            dataJson: eventDataJson,
          },
        })
      }
      const updatedProject = await transaction.v2Project.updateMany({
        where: {
          id: input.projectId, workspaceId: input.workspaceId,
          status: { in: projectStatusTransitionPath('ingesting', 'draft', { includeSame: true }) },
          currentVersionId: { in: [version.parentVersionId, version.id] },
        },
        data: { status: 'draft', currentVersionId: version.id },
      })
      if (updatedProject.count !== 1) {
        throw new DomainError('PROJECT_TRANSITION_REJECTED', 'Project cannot complete ingest from its current status')
      }
    })
  }

  async persistCatalogedInput(input: Parameters<ProjectMediaRepository['persistCatalogedInput']>[0]): Promise<void> {
    await this.client.$transaction(async (transaction) => {
      const [project, upload, artifact, manifest] = await Promise.all([
        transaction.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, select: { id: true } }),
        transaction.v2MediaUpload.findFirst({ where: {
          id: input.uploadId, workspaceId: input.workspaceId, projectId: input.projectId,
          status: 'verified', inspectionStatus: 'usable', kind: input.mediaType, rightsConfirmed: true,
        }, select: { id: true } }),
        transaction.v2MediaArtifact.findFirst({ where: { id: input.artifactId, workspaceId: input.workspaceId, mediaType: input.mediaType, status: 'available' }, select: { id: true } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.manifestId, workspaceId: input.workspaceId, artifactId: input.artifactId }, select: { id: true } }),
      ])
      if (!project || !upload || !artifact || !manifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Cataloged media input references are incomplete')
      await transaction.v2ProjectMediaAsset.upsert({
        where: { projectId_artifactId_role: { projectId: input.projectId, artifactId: input.artifactId, role: `source-${input.mediaType}` } },
        create: {
          id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId,
          artifactId: input.artifactId, uploadId: input.uploadId, role: `source-${input.mediaType}`,
          originalFileName: input.originalFileName, createdAt: new Date(input.createdAt),
        },
        update: {},
      })
    })
  }

  async markIngestFailed(input: { workspaceId: string; projectId: string }): Promise<void> {
    const project = await this.client.v2Project.updateMany({
      where: {
        id: input.projectId, workspaceId: input.workspaceId,
        status: { in: projectStatusTransitionPath('ingesting', 'failed', { includeSame: true }) },
      },
      data: { status: 'failed' },
    })
    if (project.count !== 1) {
      throw new DomainError('PROJECT_TRANSITION_REJECTED', 'Project cannot fail ingest from its current status')
    }
  }
}
