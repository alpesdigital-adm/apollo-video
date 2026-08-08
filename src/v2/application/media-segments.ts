import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { createMediaSegment, materializeSegment } from '../domain/media-segment.ts'
import type { MediaSegmentRepository } from './ports/media-segment-repository.ts'

const validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)

export function listMediaSegmentsService(dependencies: { repository: MediaSegmentRepository }) {
  return async (input: { workspaceId: string; artifactId: string }) => {
    const workspaceId = input.workspaceId.trim(); const artifactId = input.artifactId.trim()
    if (!validId(workspaceId) || !validId(artifactId)) throw new DomainError('INVALID_ARGUMENT', 'Segment list identity is invalid')
    if (!await dependencies.repository.readSource(workspaceId, artifactId)) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Segment source artifact was not found')
    return Object.freeze({ items: await dependencies.repository.list(workspaceId, artifactId) })
  }
}

export function createMediaSegmentService(dependencies: { repository: MediaSegmentRepository; clock?: () => Date }) {
  return async (input: { workspaceId: string; artifactId: string; parentSegmentId?: string; label: string; description?: string; startMs: number; endMs: number }) => {
    const workspaceId = input.workspaceId.trim(); const artifactId = input.artifactId.trim()
    if (!validId(workspaceId) || !validId(artifactId)) throw new DomainError('INVALID_ARGUMENT', 'Segment identity is invalid')
    const source = await dependencies.repository.readSource(workspaceId, artifactId)
    if (!source) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Segment source artifact was not found')
    const parentSegment = input.parentSegmentId ? (await dependencies.repository.find(workspaceId, input.parentSegmentId.trim()) ?? undefined) : undefined
    if (input.parentSegmentId && !parentSegment) throw new DomainError('INVALID_ARGUMENT', 'Parent segment was not found')
    const identity = calculateCanonicalHash({ schemaVersion: 'media-segment-identity/v1', workspaceId, artifactId, parentSegmentId: parentSegment?.id ?? null, label: input.label.trim(), description: input.description?.trim() ?? '', startMs: input.startMs, endMs: input.endMs })
    const segment = createMediaSegment({ id: `segment-${identity.slice(0, 48)}`, workspaceId, parentAssetId: artifactId, parentDurationMs: source.durationMs, parentSegment, label: input.label, description: input.description, startMs: input.startMs, endMs: input.endMs, createdAt: (dependencies.clock?.() ?? new Date()).toISOString() })
    return dependencies.repository.create(segment)
  }
}

export function requestMediaSegmentMaterializationService(dependencies: { repository: MediaSegmentRepository }) {
  return async (input: { workspaceId: string; segmentId: string; consumerKey: string; requiresPhysicalDerivative: boolean }) => {
    const segment = await dependencies.repository.find(input.workspaceId.trim(), input.segmentId.trim())
    if (!segment) throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media segment was not found')
    const recipe = materializeSegment(segment, { key: input.consumerKey, requiresPhysicalDerivative: input.requiresPhysicalDerivative })
    if (!recipe) return Object.freeze({ segmentId: segment.id, physicalDerivative: null, sourceImmutable: true as const })
    const existing = await dependencies.repository.findMaterialization(segment.workspaceId, segment.id, input.consumerKey.trim().toLowerCase())
    if (existing) return Object.freeze({ segmentId: segment.id, physicalDerivative: existing, sourceImmutable: true as const })
    return Object.freeze({ segmentId: segment.id, recipe, sourceImmutable: true as const, materializationRequired: true as const })
  }
}

export function segmentDerivativeIdentity(input: { workspaceId: string; segmentId: string; consumerKey: string; sourceSha256: string }) {
  const digest = createHash('sha256').update(`${input.workspaceId}\0${input.segmentId}\0${input.consumerKey}\0${input.sourceSha256}`).digest('hex')
  return Object.freeze({ artifactId: `artifact-segment-${digest.slice(0, 48)}`, manifestId: `manifest-segment-${digest.slice(0, 48)}`, materializationId: `materialization-${digest.slice(0, 48)}` })
}
