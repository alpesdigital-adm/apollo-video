import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { ProjectMediaRepository } from '../../application/ports/media-ingest.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { projectStatusTransitionPath } from '../../domain/project.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { PrismaOperationalOutputBundleRepositoryV3 } from './output-version-bundle-repository.ts'
import { mediaLibrarySearchField } from '../../domain/media-library.ts'
import { validateOutputNormalizationV3 } from '../../domain/output-materialization.ts'
import { serializeOutputCanonicalJson } from '../../domain/output-canonical-policy.ts'

export class PrismaProjectMediaRepository implements ProjectMediaRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async readIngestRequestFingerprint(input:{workspaceId:string;projectId:string;operationId:string}) {
    const row=await this.client.v2PublicOperation.findFirst({where:{id:input.operationId,workspaceId:input.workspaceId,
      projectId:input.projectId,type:'media-ingest'},select:{requestFingerprint:true}})
    if(!row||!/^[a-f0-9]{64}$/.test(row.requestFingerprint))throw new DomainError('PERSISTENCE_CONFLICT','Ingest request fingerprint missing')
    return row.requestFingerprint
  }
  async readProject(input:{workspaceId:string;projectId:string}) {
    const project=await this.client.v2Project.findFirst({where:{id:input.projectId,workspaceId:input.workspaceId},select:{id:true,locale:true,currentVersionId:true}})
    if(!project?.currentVersionId)return null
    const bundle=await readPersistedOperationalOutputBundleV3(this.client,{...input,versionId:project.currentVersionId})
    if(!bundle||bundle.schemaVersion!=='operational-output-version-bundle/v3'||bundle.state.document.entries.length===0)
      throw new DomainError('PRECONDITION_REQUIRED','Ingest requires an explicit operational output variant')
    // The language is the project's when it declares one; otherwise the provider detects it from the speech (ADR-160): none is assumed.
    return Object.freeze({id:project.id,...(project.locale?{locale:project.locale}:{}),currentVersion:bundle.version,outputBundle:bundle})
  }
  async persistCompletedIngest(input:Parameters<ProjectMediaRepository['persistCompletedIngest']>[0]):Promise<void> {
    if(input.proposal.origin.kind!=='ingest-operation'||input.ingestFacts===null)
      throw new DomainError('PERSISTENCE_CONFLICT','Ingest requires typed facts and an operation fence')
    await new PrismaOperationalOutputBundleRepositoryV3(this.client).persistChild(input)
  }

  async persistCatalogedInput(input: Parameters<ProjectMediaRepository['persistCatalogedInput']>[0]): Promise<void> {
    await this.client.$transaction(async (transaction) => {
      if((input.mediaType==='audio')!==(input.normalization!==null))throw new DomainError('PERSISTENCE_CONFLICT','Catalog audio normalization authority missing or unexpected')
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
      if(input.normalization) {
        const n=validateOutputNormalizationV3(input.normalization),d=n.document
        if(d.kind!=='ffprobe-original-audio'||d.workspaceId!==input.workspaceId||d.projectId!==input.projectId||
          d.source.artifactId!==input.artifactId||d.source.manifestId!==input.manifestId)
          throw new DomainError('PERSISTENCE_CONFLICT','Catalog observed audio scope differs')
        await transaction.$queryRawUnsafe('SELECT id FROM media_artifacts WHERE id=$1 AND "workspaceId"=$2 FOR UPDATE',input.artifactId,input.workspaceId)
        await transaction.$queryRawUnsafe('SELECT 1 AS verified FROM w66_assert_artifact_fact_v3($1::jsonb,$2)',serializeOutputCanonicalJson(d.source),input.workspaceId)
        const data={id:d.id,workspaceId:d.workspaceId,projectId:d.projectId,operationId:d.operationId,sourceArtifactId:d.source.artifactId,
          sourceManifestId:d.source.manifestId,sourceManifestHash:d.source.manifest.manifestHash,derivativeArtifactId:d.derivative.artifactId,
          derivativeManifestId:d.derivative.manifestId,derivativeManifestHash:d.derivative.manifest.manifestHash,
          receiptJson:serializeOutputCanonicalJson(d),receiptHash:n.receiptHash,createdAt:new Date(d.createdAt)}
        const existing=await transaction.v2OutputNormalizationReceipt.findUnique({where:{id:d.id}})
        if(existing) {
          if(existing.receiptJson!==data.receiptJson||existing.receiptHash!==data.receiptHash)throw new DomainError('PERSISTENCE_CONFLICT','Catalog normalization collision')
        } else await transaction.v2OutputNormalizationReceipt.create({data})
      }
      const emptyPeople = mediaLibrarySearchField([], 'people')
      const emptyTopics = mediaLibrarySearchField([], 'topics')
      await transaction.v2MediaLibraryEntry.upsert({
        where: { artifactId: input.artifactId },
        create: {
          artifactId: input.artifactId, workspaceId: input.workspaceId,
          label: input.originalFileName, peopleJson: stableSerialize(emptyPeople.values), peopleSearch: emptyPeople.search,
          topicsJson: stableSerialize(emptyTopics.values), topicsSearch: emptyTopics.search,
          originType: 'upload', createdAt: new Date(input.createdAt),
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
