import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { ProjectWorkspaceQueryRepository, ProjectWorkspaceMediaRecord } from '../../application/ports/project-workspace-query-repository.ts'
import { DomainError } from '../../domain/errors.ts'

function parseJson(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function probeFromManifest(value: string): ProjectWorkspaceMediaRecord['probe'] {
  const manifest = parseJson(value, 'media manifest')
  const probe = manifest.probe
  if (typeof probe !== 'object' || probe === null || Array.isArray(probe)) return undefined
  const candidate = probe as Record<string, unknown>
  if (![candidate.width, candidate.height, candidate.duration, candidate.fps].every((item) => typeof item === 'number' && Number.isFinite(item) && item > 0)) return undefined
  return { width: candidate.width as number, height: candidate.height as number, duration: candidate.duration as number, fps: candidate.fps as number }
}

export class PrismaProjectWorkspaceQueryRepository implements ProjectWorkspaceQueryRepository {
  constructor(private readonly client: PrismaClient) {}

  async read(input: { workspaceId: string; projectId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: {
        currentVersion: { include: { briefSnapshot: true } },
        mediaAssets: {
          orderBy: { createdAt: 'asc' },
          include: {
            artifact: {
              include: {
                currentRightsSnapshot: { select: { status: true } },
                manifests: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 },
              },
            },
          },
        },
        mediaTranscripts: { orderBy: { createdAt: 'desc' } },
        mediaIngestOperations: { orderBy: { createdAt: 'desc' }, select: { operationId: true } },
      },
    })
    if (!project) return null
    const media = project.mediaAssets.map((link) => {
      const manifest = link.artifact.manifests[0]
      if (!manifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Project media artifact has no manifest')
      return Object.freeze({
        id: link.id,
        role: link.role as 'source-master' | 'editing-proxy',
        originalFileName: link.originalFileName,
        artifactId: link.artifactId,
        manifestId: manifest.id,
        mediaType: link.artifact.mediaType as 'video' | 'audio' | 'image',
        container: link.artifact.container,
        byteSize: link.artifact.byteSize.toString(),
        sha256: link.artifact.sha256,
        status: link.artifact.status,
        ...(link.artifact.currentRightsSnapshot ? { rightsStatus: link.artifact.currentRightsSnapshot.status } : {}),
        ...(probeFromManifest(manifest.manifestJson) ? { probe: probeFromManifest(manifest.manifestJson) } : {}),
        createdAt: link.createdAt.toISOString(),
      })
    })
    const transcripts = project.mediaTranscripts.map((row) => {
      const transcript = parseJson(row.transcriptJson, 'media transcript')
      return Object.freeze({
        id: row.id, sourceArtifactId: row.sourceArtifactId, language: row.language,
        provider: row.provider, model: row.model, transcriptHash: row.transcriptHash,
        text: typeof transcript.text === 'string' ? transcript.text : '',
        wordCount: Array.isArray(transcript.words) ? transcript.words.length : 0,
        segmentCount: Array.isArray(transcript.segments) ? transcript.segments.length : 0,
        createdAt: row.createdAt.toISOString(),
      })
    })
    return Object.freeze({
      project: Object.freeze({
        id: project.id, workspaceId: project.workspaceId, name: project.name, status: project.status,
        ...(project.objective ? { objective: project.objective } : {}), ...(project.format ? { format: project.format } : {}),
        ...(project.locale ? { locale: project.locale } : {}), ...(project.currentVersionId ? { currentVersionId: project.currentVersionId } : {}),
        createdAt: project.createdAt.toISOString(),
      }),
      ...(project.currentVersion ? { version: Object.freeze({ id: project.currentVersion.id, sequence: project.currentVersion.sequence, baseHash: project.currentVersion.baseHash, createdAt: project.currentVersion.createdAt.toISOString() }) } : {}),
      ...(project.currentVersion ? { brief: parseJson(project.currentVersion.briefSnapshot.contentJson, 'project brief') } : {}),
      media: Object.freeze(media),
      transcripts: Object.freeze(transcripts),
      operationIds: Object.freeze(project.mediaIngestOperations.map((item) => item.operationId)),
    })
  }
}
