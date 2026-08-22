import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createMediaArtifactManifestV2 } from '../domain/media-artifact.ts'
import { renderElementMapHash, validateRenderElementMap } from '../domain/review-system.ts'
import {
  collectRenderedSubtitleCues,
  encodeSubtitleSidecar,
  subtitleSidecarFrameToMs,
  subtitleSidecarLineageHash,
  SUBTITLE_SIDECAR_FORMATS,
  SUBTITLE_SIDECAR_RECIPE_ID,
  SUBTITLE_SIDECAR_RECIPE_VERSION,
  SUBTITLE_SIDECAR_SCHEMA_VERSION,
  type SubtitleSidecarFormat,
  type SubtitleSidecarLineage,
} from '../domain/subtitle-sidecar.ts'
import {
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { MediaArtifactPersistenceRepository } from './ports/media-artifact-repository.ts'
import type { VerifiedMediaStorage } from './ports/media-ingest.ts'
import type {
  PersistedSubtitleSidecar,
  RenderedSubtitleAlignmentSource,
  SubtitleSidecarRepository,
} from './ports/subtitle-sidecar-repository.ts'
import { calculateVersionHash } from './version-hash.ts'

/** Default sidecar locale until FR-176 introduces per-locale subtitle tracks. */
export const DEFAULT_SUBTITLE_SIDECAR_LOCALE = 'pt-BR'
const SIDECAR_ARTIFACT_PREFIX = 'subtitles'
const SIDECAR_TOOL_ID = 'apollo-subtitle-sidecar'

/** Recipe that must have produced the rendered artifact of each output kind. */
const RENDER_RECIPE_ID = Object.freeze({
  proxy: 'editorial-proxy',
  final: 'editorial-final',
} as const)

/**
 * Writes the encoded bytes somewhere the content-addressed storage can promote
 * from. It exists because `promoteDerived` only accepts a file path: the sidecar
 * is produced in memory, so it needs one temporary file and a guaranteed cleanup.
 */
export interface SubtitleSidecarStagingArea {
  stage(input: { bytes: Buffer; extension: string }): Promise<Readonly<{
    path: string
    dispose: () => Promise<void>
  }>>
}

export interface SubtitleSidecarExportResult {
  sidecar: Readonly<PersistedSubtitleSidecar>
  projectVersion: Readonly<{ id: string; sequence: number; current: boolean }>
  alignment: Readonly<{
    renderElementMapHash: string
    renderInputHash: string
    outputArtifactId: string
    outputSha256: string
    cueCount: number
    firstCueStartMs: number
    lastCueEndMs: number
  }>
  replayed: boolean
}

function toolDigest(): string {
  return createHash('sha256')
    .update(`${SIDECAR_TOOL_ID}/${SUBTITLE_SIDECAR_RECIPE_VERSION}`)
    .digest('hex')
}

/**
 * Re-validates the persisted alignment against the persisted artifact before a
 * single byte is produced. A hand-edited RenderElementMap row, a map bound to a
 * different proxy hash, a manifest that no longer carries the RenderInput of the
 * render operation, or an artifact whose checksum moved all fail here — the
 * sidecar is never written from a source that stopped matching the MP4.
 */
async function assertAlignmentMatchesArtifact(
  artifacts: MediaArtifactQueryRepository,
  workspaceId: string,
  alignment: Readonly<RenderedSubtitleAlignmentSource>,
) {
  const artifact = await artifacts.findById(workspaceId, alignment.outputArtifactId)
  assertDomain(
    Boolean(artifact) && artifact!.status === 'available',
    'MEDIA_ARTIFACT_NOT_FOUND',
    'The rendered output artifact was not found',
  )
  assertDomain(
    artifact!.sha256 === alignment.outputSha256 &&
      artifact!.artifactKey === alignment.outputArtifactKey,
    'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    'The rendered output artifact no longer matches the render operation',
  )
  const manifest = artifact!.manifests.find((entry) => entry.id === alignment.outputManifestId)
  assertDomain(
    Boolean(manifest),
    'MEDIA_ARTIFACT_MANIFEST_NOT_FOUND',
    'The rendered output manifest was not found',
  )
  // The manifest must be the render manifest of the output kind the alignment
  // names. A proxy manifest is written by the proxy render worker and a final
  // manifest by the final export worker, so a sidecar can never be derived from
  // an artifact that some other recipe produced.
  assertDomain(
    manifest!.recipe.id === RENDER_RECIPE_ID[alignment.outputKind],
    'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    'The rendered output manifest was not produced by the render of this output kind',
  )
  // A reconstructable manifest additionally carries the protected RenderInput.
  // When it does, it must be the RenderInput of this render operation. Proxy
  // renders are not reconstructable and carry none: requiring one there would
  // make the sidecar unreachable for every proxy the worker ever produced.
  assertDomain(
    manifest!.renderInput === undefined ||
      manifest!.renderInput.inputHash === alignment.renderInputHash,
    'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    'The rendered output manifest does not carry the RenderInput of its render operation',
  )
  // The map validates its own binding to the artifact hash and, re-hashed, must
  // still equal the hash stored beside it.
  const map = validateRenderElementMap({ ...alignment.map }, alignment.outputSha256)
  assertDomain(
    renderElementMapHash(map) === alignment.renderElementMapHash,
    'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
    'The persisted cue alignment does not match its immutable hash',
  )
  return { artifact: artifact!, manifest: manifest!, map }
}

export function exportProjectSubtitleSidecarService(dependencies: {
  sidecars: SubtitleSidecarRepository
  artifacts: MediaArtifactQueryRepository
  persistence: MediaArtifactPersistenceRepository
  storage: VerifiedMediaStorage
  staging: SubtitleSidecarStagingArea
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function exportSidecar(input: {
    workspaceId: string
    actor: AuthenticatedExternalActor
    projectId: string
    variantId: string
    format: SubtitleSidecarFormat
    locale?: string
    projectVersionId?: string
    idempotencyKey: string
  }): Promise<Readonly<SubtitleSidecarExportResult>> {
    requireScope(input.actor, 'projects:write')
    if (input.actor.workspaceId !== input.workspaceId) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    }
    assertDomain(
      SUBTITLE_SIDECAR_FORMATS.includes(input.format),
      'INVALID_ARGUMENT',
      'format must be srt or vtt',
    )
    assertDomain(
      Boolean(input.idempotencyKey.trim()),
      'INVALID_ARGUMENT',
      'idempotencyKey is required',
    )
    const locale = input.locale?.trim() || DEFAULT_SUBTITLE_SIDECAR_LOCALE

    const alignment = await dependencies.sidecars.readRenderedAlignment({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      variantId: input.variantId,
      ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
    })
    if (!alignment) {
      throw new DomainError(
        'RENDER_ELEMENT_MAP_NOT_FOUND',
        'No rendered output with a persisted cue alignment exists for this project version and variant',
      )
    }
    const verified = await assertAlignmentMatchesArtifact(
      dependencies.artifacts,
      input.workspaceId,
      alignment,
    )

    const cues = collectRenderedSubtitleCues({ map: verified.map, texts: alignment.cueTexts })
    const encoded = encodeSubtitleSidecar({
      cues,
      format: input.format,
      locale,
      durationMs: subtitleSidecarFrameToMs(verified.map.durationFrames, verified.map.fps),
    })

    const lineage: SubtitleSidecarLineage = {
      schemaVersion: SUBTITLE_SIDECAR_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      projectId: alignment.projectId,
      projectVersionId: alignment.projectVersionId,
      variantId: alignment.variantId,
      outputArtifactId: alignment.outputArtifactId,
      outputSha256: alignment.outputSha256,
      outputKind: alignment.outputKind,
      renderInputHash: alignment.renderInputHash,
      editPlanSnapshotId: alignment.editPlanSnapshotId,
      editPlanHash: alignment.editPlanHash,
      renderElementMapHash: alignment.renderElementMapHash,
      format: input.format,
      locale,
    }
    const lineageHash = subtitleSidecarLineageHash(lineage)
    const artifactId = `artifact-subtitle-sidecar-${lineageHash.slice(0, 40)}`
    const manifestId = `manifest-subtitle-sidecar-${lineageHash.slice(0, 40)}`
    const sidecarId = `subtitle-sidecar-${lineageHash.slice(0, 40)}`

    const staged = await dependencies.staging.stage({
      bytes: encoded.bytes,
      extension: input.format,
    })
    let stored
    try {
      stored = await dependencies.storage.promoteDerived({
        workspaceId: input.workspaceId,
        sourcePath: staged.path,
        sha256: encoded.sha256,
        extension: input.format,
        prefix: SIDECAR_ARTIFACT_PREFIX,
      })
    } finally {
      await staged.dispose()
    }
    assertDomain(
      stored.sha256 === encoded.sha256 && stored.byteSize === encoded.byteSize,
      'PERSISTENCE_CONFLICT',
      'The persisted sidecar bytes do not match the encoded sidecar',
    )

    const digest = toolDigest()
    const manifest = createMediaArtifactManifestV2({
      artifactKey: stored.key,
      artifactSha256: stored.sha256,
      byteSize: stored.byteSize,
      mediaType: 'data',
      container: input.format,
      recipe: {
        id: SUBTITLE_SIDECAR_RECIPE_ID,
        version: SUBTITLE_SIDECAR_RECIPE_VERSION,
        parameters: {
          ...lineage,
          lineageHash,
          encoding: encoded.encoding,
          eol: encoded.eol === '\r\n' ? 'crlf' : 'lf',
          cueCount: encoded.cueCount,
          byteSize: encoded.byteSize,
          sha256: encoded.sha256,
          cueAlignment: cues.map((cue) => ({
            cueId: cue.cueId,
            startFrame: cue.startFrame,
            endFrame: cue.endFrame,
            startMs: cue.startMs,
            endMs: cue.endMs,
            textHash: calculateCanonicalHash(cue.text),
          })),
        },
      },
      sources: [{
        artifactKey: alignment.outputArtifactKey,
        sha256: alignment.outputSha256,
        role: alignment.outputKind === 'final' ? 'rendered-final' : 'rendered-proxy',
        execution: {
          tool: { id: SIDECAR_TOOL_ID, version: SUBTITLE_SIDECAR_RECIPE_VERSION, digest },
        },
      }],
    })
    const persisted = await dependencies.persistence.persistOrReplay({
      workspaceId: input.workspaceId,
      artifactId,
      manifestId,
      lineageIds: [`lineage-${createHash('sha256')
        .update(`${input.workspaceId}:${lineageHash}:${alignment.outputArtifactId}:0`)
        .digest('hex')}`],
      manifest,
      createdAt: clock().toISOString(),
    })

    const record: PersistedSubtitleSidecar = {
      id: sidecarId,
      workspaceId: input.workspaceId,
      projectId: alignment.projectId,
      projectVersionId: alignment.projectVersionId,
      variantId: alignment.variantId,
      outputKind: alignment.outputKind,
      outputArtifactId: alignment.outputArtifactId,
      outputManifestId: alignment.outputManifestId,
      outputSha256: alignment.outputSha256,
      format: input.format,
      locale,
      artifactId: persisted.artifactId,
      manifestId: persisted.manifestId,
      artifactKey: stored.key,
      sha256: encoded.sha256,
      byteSize: encoded.byteSize,
      encoding: encoded.encoding,
      cueCount: encoded.cueCount,
      lineageHash,
      renderElementMapHash: alignment.renderElementMapHash,
      renderInputHash: alignment.renderInputHash,
      editPlanSnapshotId: alignment.editPlanSnapshotId,
      createdAt: clock().toISOString(),
    }
    const result = await dependencies.sidecars.persistOrReplay({
      record,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: calculateVersionHash({
        schemaVersion: 'subtitle-sidecar-export/v1',
        lineageHash,
        sha256: encoded.sha256,
      }),
    })
    assertDomain(
      result.record.sha256 === encoded.sha256 && result.record.lineageHash === lineageHash,
      'PERSISTENCE_CONFLICT',
      'The persisted sidecar diverged from the reconstructed sidecar',
    )
    return Object.freeze({
      sidecar: Object.freeze(result.record),
      projectVersion: Object.freeze({
        id: alignment.projectVersionId,
        sequence: alignment.projectVersionSequence,
        current: alignment.isCurrentVersion,
      }),
      alignment: Object.freeze({
        renderElementMapHash: alignment.renderElementMapHash,
        renderInputHash: alignment.renderInputHash,
        outputArtifactId: alignment.outputArtifactId,
        outputSha256: alignment.outputSha256,
        cueCount: cues.length,
        firstCueStartMs: cues[0]!.startMs,
        lastCueEndMs: cues[cues.length - 1]!.endMs,
      }),
      replayed: result.replayed,
    })
  }
}

export function listProjectSubtitleSidecarsService(dependencies: {
  sidecars: SubtitleSidecarRepository
}) {
  return async function list(input: {
    workspaceId: string
    actor: AuthenticatedExternalActor
    projectId: string
    projectVersionId?: string
    variantId?: string
    format?: SubtitleSidecarFormat
    limit?: number
  }) {
    requireScope(input.actor, 'projects:read')
    if (input.actor.workspaceId !== input.workspaceId) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    }
    const limit = input.limit ?? 50
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be from 1 to 100',
    )
    assertDomain(
      input.format === undefined || SUBTITLE_SIDECAR_FORMATS.includes(input.format),
      'INVALID_ARGUMENT',
      'format must be srt or vtt',
    )
    const sidecars = await dependencies.sidecars.list({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
      ...(input.variantId ? { variantId: input.variantId } : {}),
      ...(input.format ? { format: input.format } : {}),
      limit,
    })
    return Object.freeze({ sidecars: Object.freeze(sidecars.map((item) => Object.freeze(item))) })
  }
}
