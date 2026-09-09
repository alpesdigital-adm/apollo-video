import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { LocalizationMediaContextLoader } from '../../application/localization-media-processor.ts'
import { calculateVersionHash } from '../../application/version-hash.ts'
import type { DirectedEditPlan } from '../../domain/director-run.ts'
import { validateDirectedEditPlan } from '../../domain/director-run.ts'
import { DomainError } from '../../domain/errors.ts'
import { createCanonicalScriptVersion, type CanonicalScriptVersion, type LocalizationVariant } from '../../domain/localization.ts'
import { assertLocalizationVariantIntegrity } from '../../domain/localization.ts'
import { hydrateScriptAlignmentRun } from '../../domain/script-alignment.ts'
import { createMediaTranscript, type MediaTranscript } from '../../domain/media-transcript.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function parse<T>(value: string, label: string): T {
  try { return JSON.parse(value) as T } catch { throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${label} is invalid JSON`) }
}

export class PrismaLocalizationMediaContextLoader implements LocalizationMediaContextLoader {
  constructor(private readonly prisma: PrismaClient = getV2PostgresClient()) {}

  async load(run: Parameters<LocalizationMediaContextLoader['load']>[0]) {
    const [canonicalRow, variantRow] = await Promise.all([
      this.prisma.v2LocalizationCanonicalScript.findFirst({ where: {
        workspaceId: run.workspaceId, projectId: run.projectId, contentHash: run.canonicalContentHash,
      } }),
      this.prisma.v2LocalizationVariantRevision.findFirst({ where: {
        workspaceId: run.workspaceId, variantId: run.variantId,
        revision: run.variantRevision, variantHash: run.variantHash,
      } }),
    ])
    if (!canonicalRow || !variantRow) throw new DomainError('VERSION_CONFLICT', 'Localization media authority disappeared')
    const rawCanonical = parse<CanonicalScriptVersion>(canonicalRow.snapshotJson, 'localization canonical')
    const { contentHash: _contentHash, ...canonicalBody } = rawCanonical
    const canonical = createCanonicalScriptVersion({ ...canonicalBody, blocks: rawCanonical.blocks.map(({ blockHash: _hash, ...block }) => block) })
    const variant = assertLocalizationVariantIntegrity(Object.freeze(parse<LocalizationVariant>(variantRow.variantJson, 'localization variant')))
    if (canonical.contentHash !== canonicalRow.contentHash || variant.canonicalScriptVersionId !== canonical.id) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Localization canonical or variant hash is inconsistent')
    }
    const [alignmentRow, version] = await Promise.all([
      this.prisma.v2ScriptAlignmentRun.findFirst({ where: {
        id: canonicalRow.alignmentId, workspaceId: run.workspaceId, projectId: run.projectId,
        runHash: canonicalRow.alignmentRunHash, status: 'reviewed', reviewRequiredCount: 0,
      } }),
      this.prisma.v2ProjectVersion.findFirst({ where: {
        id: canonical.projectVersionId, workspaceId: run.workspaceId, projectId: run.projectId,
      }, include: { editPlanSnapshot: true } }),
    ])
    if (!alignmentRow || !version) throw new DomainError('PRECONDITION_REQUIRED', 'Exact alignment or base EditPlan is unavailable')
    const alignment = hydrateScriptAlignmentRun(parse(alignmentRow.resultJson, 'script alignment'))
    const sourceRef = alignment.sourceRefs.find((ref) => ref.sourceArtifactId === run.source.artifactId)
    if (alignment.runHash !== canonicalRow.alignmentRunHash || !sourceRef) {
      throw new DomainError('VERSION_CONFLICT', 'Canonical alignment is not bound to the localization source transcript')
    }
    const transcriptRow = await this.prisma.v2MediaTranscript.findFirst({ where: {
      id: sourceRef.transcriptId, workspaceId: run.workspaceId, projectId: run.projectId,
      sourceArtifactId: run.source.artifactId, transcriptHash: sourceRef.transcriptHash,
    } })
    if (!transcriptRow) throw new DomainError('VERSION_CONFLICT', 'Exact canonical source transcript disappeared')
    const storedBasePlan = validateDirectedEditPlan(parse<DirectedEditPlan>(version.editPlanSnapshot.contentJson, 'base localization EditPlan'))
    if (calculateVersionHash(storedBasePlan) !== version.editPlanSnapshot.contentHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Base localization EditPlan changed or is inconsistent')
    }
    // A Command-created ProjectVersion may legitimately retain the same immutable
    // EditPlan snapshot. Validate that stored authority first, then bind the plan
    // compiled for this run to the selected version without rewriting the snapshot.
    const basePlan = storedBasePlan.projectVersionId === version.id
      ? storedBasePlan
      : validateDirectedEditPlan({ ...storedBasePlan, projectVersionId: version.id })
    const clips = basePlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
    if (clips.length !== 1 || clips[0]!.sourceArtifactId !== run.source.artifactId || clips[0]!.rate !== 1 ||
      clips[0]!.sourceInFrame !== clips[0]!.timelineInFrame || clips[0]!.sourceOutFrame !== clips[0]!.timelineOutFrame) {
      throw new DomainError('PRECONDITION_REQUIRED', 'Localization timing requires an exact source-to-timeline mapping; edited or repeated timelines are not yet supported')
    }
    const rawTranscript = parse<MediaTranscript>(transcriptRow.transcriptJson, 'localization transcript')
    const { transcriptHash: _transcriptHash, schemaVersion: _schemaVersion, ...transcriptBody } = rawTranscript
    const transcript = createMediaTranscript(transcriptBody)
    if (transcript.transcriptHash !== transcriptRow.transcriptHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Exact localization transcript content hash is inconsistent')
    const words = Object.freeze(transcript.words.map((word) => Object.freeze({ word: word.word, startMs: Math.round(word.start * 1000), endMs: Math.round(word.end * 1000) })))
    const blockWordRanges = canonical.blocks.map((block) => {
      const selected = alignment.alignments.find((item) => item.blockId === block.sourceScriptBlockId)?.selectedCandidate
      if (!selected) throw new DomainError('PERSISTENCE_CONFLICT', `Canonical block ${block.id} has no reviewed alignment`)
      const startWord = words.findIndex((word) => word.endMs > selected.sourceRangeMs[0])
      let endWord = words.findIndex((word) => word.startMs >= selected.sourceRangeMs[1])
      if (endWord < 0) endWord = words.length
      if (startWord < 0 || endWord <= startWord) throw new DomainError('PERSISTENCE_CONFLICT', `Canonical block ${block.id} has no measured words`)
      return Object.freeze({ blockId: block.id, startWord, endWord })
    })
    return Object.freeze({
      variant, canonical, basePlan,
      audio: Object.freeze({ artifactId: run.source.artifactId, sha256: run.source.artifactSha256,
        rightsSnapshotId: run.source.rightsSnapshotId, durationMs: words.at(-1)?.endMs ?? 0,
        words, alignmentArtifactId: transcriptRow.id, alignmentSha256: transcriptRow.transcriptHash }),
      blockWordRanges: Object.freeze(blockWordRanges),
    })
  }
}
