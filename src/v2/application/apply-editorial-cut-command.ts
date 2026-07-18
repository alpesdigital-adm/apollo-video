import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createEditCommand,
  type CommandActor,
  type EditCommand,
} from '../domain/edit-command.ts'
import type { MediaTranscript, TranscriptWord } from '../domain/media-transcript.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import type {
  EditorialCommandRepository,
  EditorialCommandResult,
} from './ports/editorial-command-repository.ts'
import {
  buildRetainedSourceRanges,
  defineEditorialPhraseRules,
  deriveEditorialExclusions,
  type EditorialExclusionRange,
  type SourceTimeRange,
} from './recovery-project-acceptance.ts'
import { calculateVersionHash, stableSerialize } from './version-hash.ts'

export interface RemoveSpokenContentRuleInput {
  id: string
  label: string
  alternatives: readonly string[]
}

export interface RemoveSpokenContentPayload {
  sourceTranscriptId: string
  sourceArtifactId: string
  rules: readonly Readonly<RemoveSpokenContentRuleInput>[]
  exclusions: readonly Readonly<EditorialExclusionRange>[]
}

export interface EditorialCutClip {
  id: string
  sourceArtifactId: string
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  rate: 1
}

export interface RetimedTranscriptWord {
  text: string
  sourceStartSeconds: number
  sourceEndSeconds: number
  timelineStartFrame: number
  timelineEndFrame: number
}

export interface EditorialCutEditPlan {
  schemaVersion: 2
  state: 'compiled'
  id: string
  projectVersionId: string
  storyPlanId: null
  fps: number
  durationFrames: number
  sources: readonly Readonly<{
    id: string
    artifactId: string
    kind: 'video'
    durationSeconds: number
  }>[]
  videoTracks: readonly Readonly<{
    id: string
    kind: 'base-video'
    clips: readonly Readonly<EditorialCutClip>[]
  }>[]
  overlayTracks: readonly never[]
  subtitleTracks: readonly never[]
  audioTracks: readonly never[]
  effectTracks: readonly never[]
  markers: readonly Readonly<{
    kind: 'editorial-cut'
    atFrame: number
    sourceStartSeconds: number
    sourceEndSeconds: number
    ruleIds: readonly string[]
  }>[]
  protectedElements: readonly never[]
  localeVariantRefs: readonly never[]
  formatVariantRefs: readonly never[]
  lineageRefs: readonly string[]
  editorial: Readonly<{
    commandType: 'remove-spoken-content'
    exclusions: readonly Readonly<EditorialExclusionRange>[]
    retainedSourceRanges: readonly Readonly<SourceTimeRange>[]
  }>
  retimedTranscript: Readonly<{
    sourceTranscriptId: string
    words: readonly Readonly<RetimedTranscriptWord>[]
  }>
  movementPolicy: Readonly<{
    automaticZoom: false
    protectedOpeningFrames: number
  }>
  subtitlePolicy: Readonly<{
    faceProtection: true
    anchor: 'bottom'
    maxCharactersPerBlock: 42
  }>
  createdAt: string
}

export interface ApplyEditorialCutCommandRequest {
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  sourceTranscriptId: string
  rules: readonly Readonly<RemoveSpokenContentRuleInput>[]
  reason?: string
  actor: Readonly<CommandActor>
  idempotency: Readonly<{ clientId: string; key: string }>
}

export interface ApplyEditorialCutCommandDependencies {
  repository: EditorialCommandRepository
  clock: () => Date
  createId: (kind: 'edit-command' | 'project-version' | 'project-snapshot') => string
  createEventId: () => string
}

function frameAtOrAfter(seconds: number, fps: number): number {
  return Math.ceil(seconds * fps - 1e-7)
}

function frameAtOrBefore(seconds: number, fps: number): number {
  return Math.floor(seconds * fps + 1e-7)
}

function compileClips(input: {
  ranges: readonly SourceTimeRange[]
  sourceArtifactId: string
  fps: number
}): { clips: readonly Readonly<EditorialCutClip>[]; durationFrames: number } {
  let timelineCursor = 0
  const clips = input.ranges.map((range, index) => {
    const sourceInFrame = frameAtOrAfter(range.sourceStartSeconds, input.fps)
    const sourceOutFrame = frameAtOrBefore(range.sourceEndSeconds, input.fps)
    assertDomain(sourceOutFrame > sourceInFrame, 'INVALID_COMMAND', 'Editorial cut produced an empty source clip')
    const duration = sourceOutFrame - sourceInFrame
    const clip = Object.freeze({
      id: `clip-${index + 1}`,
      sourceArtifactId: input.sourceArtifactId,
      sourceInFrame,
      sourceOutFrame,
      timelineInFrame: timelineCursor,
      timelineOutFrame: timelineCursor + duration,
      rate: 1 as const,
    })
    timelineCursor += duration
    return clip
  })
  return { clips: Object.freeze(clips), durationFrames: timelineCursor }
}

function timelineFrameAtSourceSecond(
  ranges: readonly SourceTimeRange[],
  sourceSecond: number,
  fps: number,
): number {
  let cursor = 0
  for (const range of ranges) {
    const rangeStartFrame = frameAtOrAfter(range.sourceStartSeconds, fps)
    const rangeEndFrame = frameAtOrBefore(range.sourceEndSeconds, fps)
    if (sourceSecond <= range.sourceStartSeconds) return cursor
    if (sourceSecond < range.sourceEndSeconds) {
      return cursor + Math.max(0, frameAtOrAfter(sourceSecond, fps) - rangeStartFrame)
    }
    cursor += rangeEndFrame - rangeStartFrame
  }
  return cursor
}

function rangeContainingWord(
  ranges: readonly SourceTimeRange[],
  word: Readonly<TranscriptWord>,
): SourceTimeRange | undefined {
  return ranges.find((range) =>
    word.start >= range.sourceStartSeconds - 0.001 && word.end <= range.sourceEndSeconds + 0.001,
  )
}

function retimeTranscriptWords(input: {
  transcript: Readonly<MediaTranscript>
  ranges: readonly SourceTimeRange[]
  fps: number
}): readonly Readonly<RetimedTranscriptWord>[] {
  let elapsedFrames = 0
  const offsets = new Map<SourceTimeRange, number>()
  for (const range of input.ranges) {
    offsets.set(range, elapsedFrames)
    elapsedFrames += frameAtOrBefore(range.sourceEndSeconds, input.fps) -
      frameAtOrAfter(range.sourceStartSeconds, input.fps)
  }
  return Object.freeze(input.transcript.words.flatMap((word) => {
    const range = rangeContainingWord(input.ranges, word)
    if (!range) return []
    const sourceRangeStartFrame = frameAtOrAfter(range.sourceStartSeconds, input.fps)
    const sourceRangeEndFrame = frameAtOrBefore(range.sourceEndSeconds, input.fps)
    const timelineOffset = offsets.get(range)!
    const timelineStartFrame = timelineOffset + Math.max(0, frameAtOrAfter(word.start, input.fps) - sourceRangeStartFrame)
    const timelineEndFrame = timelineOffset + Math.min(
      sourceRangeEndFrame - sourceRangeStartFrame,
      Math.max(timelineStartFrame - timelineOffset + 1, frameAtOrBefore(word.end, input.fps) - sourceRangeStartFrame),
    )
    return [Object.freeze({
      text: word.word,
      sourceStartSeconds: word.start,
      sourceEndSeconds: word.end,
      timelineStartFrame,
      timelineEndFrame: Math.max(timelineStartFrame + 1, timelineEndFrame),
    })]
  }))
}

function compileEditPlan(input: {
  id: string
  projectVersionId: string
  transcriptId: string
  transcript: Readonly<MediaTranscript>
  sourceArtifactId: string
  sourceDurationSeconds: number
  fps: number
  exclusions: readonly EditorialExclusionRange[]
  retainedSourceRanges: readonly SourceTimeRange[]
  createdAt: string
}): Readonly<EditorialCutEditPlan> {
  const { clips, durationFrames } = compileClips({
    ranges: input.retainedSourceRanges,
    sourceArtifactId: input.sourceArtifactId,
    fps: input.fps,
  })
  const markers = input.exclusions.map((exclusion) => ({
    kind: 'editorial-cut' as const,
    atFrame: timelineFrameAtSourceSecond(
      input.retainedSourceRanges,
      exclusion.sourceStartSeconds,
      input.fps,
    ),
    sourceStartSeconds: exclusion.sourceStartSeconds,
    sourceEndSeconds: exclusion.sourceEndSeconds,
    ruleIds: Object.freeze([...exclusion.ruleIds]),
  }))
  return Object.freeze({
    schemaVersion: 2 as const,
    state: 'compiled' as const,
    id: input.id,
    projectVersionId: input.projectVersionId,
    storyPlanId: null,
    fps: input.fps,
    durationFrames,
    sources: Object.freeze([Object.freeze({
      id: input.sourceArtifactId,
      artifactId: input.sourceArtifactId,
      kind: 'video' as const,
      durationSeconds: input.sourceDurationSeconds,
    })]),
    videoTracks: Object.freeze([Object.freeze({
      id: 'track-primary-video',
      kind: 'base-video' as const,
      clips,
    })]),
    overlayTracks: Object.freeze([]),
    subtitleTracks: Object.freeze([]),
    audioTracks: Object.freeze([]),
    effectTracks: Object.freeze([]),
    markers: Object.freeze(markers.map((marker) => Object.freeze(marker))),
    protectedElements: Object.freeze([]),
    localeVariantRefs: Object.freeze([]),
    formatVariantRefs: Object.freeze([]),
    lineageRefs: Object.freeze([input.sourceArtifactId, input.transcriptId]),
    editorial: Object.freeze({
      commandType: 'remove-spoken-content' as const,
      exclusions: input.exclusions,
      retainedSourceRanges: input.retainedSourceRanges,
    }),
    retimedTranscript: Object.freeze({
      sourceTranscriptId: input.transcriptId,
      words: retimeTranscriptWords({
        transcript: input.transcript,
        ranges: input.retainedSourceRanges,
        fps: input.fps,
      }),
    }),
    movementPolicy: Object.freeze({
      automaticZoom: false as const,
      protectedOpeningFrames: Math.round(input.fps * 4),
    }),
    subtitlePolicy: Object.freeze({ faceProtection: true as const, anchor: 'bottom' as const, maxCharactersPerBlock: 42 }),
    createdAt: input.createdAt,
  })
}

export function applyEditorialCutCommandService(dependencies: ApplyEditorialCutCommandDependencies) {
  return async function execute(request: ApplyEditorialCutCommandRequest): Promise<EditorialCommandResult> {
    const workspaceId = request.workspaceId.trim()
    const projectId = request.projectId.trim()
    const baseVersionId = request.baseVersionId.trim()
    const sourceTranscriptId = request.sourceTranscriptId.trim()
    const idempotencyKey = request.idempotency.key.trim()
    assertDomain(workspaceId.length >= 3 && projectId.length >= 3, 'INVALID_COMMAND', 'Editorial command scope is invalid')
    assertDomain(baseVersionId.length >= 3 && /^[a-f0-9]{64}$/.test(request.baseHash), 'INVALID_COMMAND', 'Editorial command base version is invalid')
    assertDomain(sourceTranscriptId.length >= 3, 'INVALID_COMMAND', 'Editorial command transcript is required')
    assertDomain(idempotencyKey.length > 0 && idempotencyKey.length <= 128, 'INVALID_COMMAND', 'Editorial command idempotency key is invalid')
    const rules = defineEditorialPhraseRules(request.rules)
    const normalizedRules = rules.map((rule) => ({
      id: rule.id,
      label: rule.label,
      alternatives: rule.alternatives.map((tokens) => tokens.join(' ')),
    }))
    const requestFingerprint = calculateVersionHash({
      type: 'remove-spoken-content',
      workspaceId,
      projectId,
      baseVersionId,
      baseHash: request.baseHash,
      sourceTranscriptId,
      rules: normalizedRules,
      reason: request.reason?.trim() || null,
    })
    const existing = await dependencies.repository.findIdempotentResult({
      workspaceId,
      projectId,
      idempotencyKey,
    })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different editorial command')
      }
      return Object.freeze({ ...existing.result, replayed: true })
    }
    const context = await dependencies.repository.readContext({ workspaceId, projectId, transcriptId: sourceTranscriptId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project or aligned transcript was not found')
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== request.baseHash) {
      throw new DomainError('VERSION_CONFLICT', 'Editorial command base version is stale', {
        currentVersionId: context.currentVersion.id,
        currentBaseHash: context.currentVersion.baseHash,
      })
    }
    const exclusions = deriveEditorialExclusions(context.transcript, rules)
    const matchedRuleIds = new Set(exclusions.flatMap((range) => range.ruleIds))
    const missingRuleIds = rules.map((rule) => rule.id).filter((ruleId) => !matchedRuleIds.has(ruleId))
    if (missingRuleIds.length > 0) {
      throw new DomainError('INVALID_COMMAND', 'One or more spoken-content rules were not found in the aligned transcript', { missingRuleIds })
    }
    const retainedSourceRanges = buildRetainedSourceRanges(context.sourceDurationSeconds, exclusions)
    assertDomain(retainedSourceRanges.length > 0, 'INVALID_COMMAND', 'Editorial command would remove the entire source')
    const createdAt = dependencies.clock().toISOString()
    const commandId = dependencies.createId('edit-command')
    const versionId = dependencies.createId('project-version')
    const snapshotId = dependencies.createId('project-snapshot')
    const editPlan = compileEditPlan({
      id: `edit-plan-${versionId}`,
      projectVersionId: versionId,
      transcriptId: context.transcriptId,
      transcript: context.transcript,
      sourceArtifactId: context.sourceArtifactId,
      sourceDurationSeconds: context.sourceDurationSeconds,
      fps: context.sourceFps,
      exclusions,
      retainedSourceRanges,
      createdAt,
    })
    const editPlanJson = stableSerialize(editPlan)
    const editPlanHash = calculateVersionHash(editPlan)
    const command = createEditCommand<RemoveSpokenContentPayload>({
      id: commandId,
      workspaceId,
      projectId,
      baseVersionId,
      baseHash: request.baseHash,
      author: request.actor,
      type: 'remove-spoken-content',
      scope: { project: true },
      payload: Object.freeze({
        sourceTranscriptId: context.transcriptId,
        sourceArtifactId: context.sourceArtifactId,
        rules: Object.freeze(normalizedRules.map((rule) => Object.freeze(rule))),
        exclusions,
      }),
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      idempotencyKey,
      createdAt,
    })
    const snapshot = createProjectSnapshot({
      id: snapshotId,
      workspaceId,
      projectId,
      kind: 'edit-plan',
      contentSchemaVersion: 2,
      contentJson: editPlanJson,
      contentHash: editPlanHash,
      createdAt,
    })
    const version = createProjectVersion({
      id: versionId,
      workspaceId,
      projectId,
      sequence: context.currentVersion.sequence + 1,
      parentVersionId: context.currentVersion.id,
      snapshotRefs: {
        brief: context.currentVersion.snapshotRefs.brief,
        editPlan: snapshotId,
        policies: context.currentVersion.snapshotRefs.policies,
      },
      baseHash: calculateVersionHash({
        projectId,
        sequence: context.currentVersion.sequence + 1,
        parentVersionId: context.currentVersion.id,
        previousBaseHash: context.currentVersion.baseHash,
        commandId,
        editPlanHash,
      }),
      createdBy: request.actor.id,
      commandId,
      createdAt,
    })
    const event = createPublicEvent({
      id: dependencies.createEventId(),
      type: 'project.version.created',
      version: '1.0.0',
      workspaceId,
      occurredAt: createdAt,
      sequence: version.sequence,
      actor: request.actor.type === 'api-client'
        ? { clientId: request.actor.id, ...(request.actor.delegatedUserId ? { userId: request.actor.delegatedUserId } : {}) }
        : { userId: request.actor.id },
      resource: { type: 'project-version', id: version.id },
      data: {
        projectId,
        sequence: version.sequence,
        parentVersionId: version.parentVersionId,
        baseHash: version.baseHash,
        commandId,
        commandType: command.type,
        snapshotRefs: version.snapshotRefs,
        createdAt,
      },
    })
    return dependencies.repository.commitOrReplay({
      command,
      requestFingerprint,
      snapshot,
      version,
      event,
      sourceEvidence: {
        transcriptId: context.transcriptId,
        transcriptHash: context.transcript.transcriptHash,
        sourceArtifactId: context.sourceArtifactId,
      },
    })
  }
}
