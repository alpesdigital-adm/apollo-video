import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  validateStoryPlan,
  type StoryPlan,
} from './story-plan.ts'

export const CONTIGUOUS_EXTRACTION_POLICY_VERSION =
  'contiguous-extraction/v1' as const

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const DIMENSIONS = [
  'selfContained',
  'density',
  'integrity',
  'audio',
  'visual',
] as const

export type ContiguousQualityDimension =
  (typeof DIMENSIONS)[number]

export interface ContiguousQualityObservation {
  value: number
  evidenceRefs: readonly string[]
}

export interface ContiguousSourceMoment {
  id: string
  momentHash: string
  evaluationId: string
  evaluationHash: string
  indexRunId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  chapterId: string
  topic: string
  objectiveTags: readonly string[]
  recommendedRangeMs: readonly [number, number]
  semanticRangeMs: readonly [number, number]
  sourceDurationMs: number
  rightsSnapshotId: string
  rightsStatus: 'approved' | 'blocked'
  consentStatus: 'approved' | 'not-required' | 'blocked'
  scores: Readonly<
    Record<
      ContiguousQualityDimension,
      Readonly<ContiguousQualityObservation>
    >
  >
}

export interface ContiguousExtractionCandidate {
  sourceIndexRunId: string
  sourceMomentId: string
  sourceMomentHash: string
  sourceEvaluationId: string
  sourceEvaluationHash: string
  sourceRangeMs: readonly [number, number]
  durationMs: number
  durationDeltaMs: number
  score: number
  scoreBreakdown: Readonly<{
    selfContained: number
    density: number
    integrity: number
    audio: number
    visual: number
    duration: number
  }>
  evidenceRefs: readonly string[]
  candidateHash: string
}

export interface ContiguousExtractionEditPlan {
  schemaVersion: 2
  state: 'compiled'
  mode: 'contiguous'
  id: string
  storyPlanId: string
  fps: number
  durationFrames: number
  sources: readonly Readonly<{
    id: string
    artifactId: string
    artifactSha256: string
    manifestId: string
    manifestHash: string
    kind: 'video'
  }>[]
  videoTracks: readonly Readonly<{
    id: string
    kind: 'base-video'
    clips: readonly Readonly<{
      id: string
      sourceArtifactId: string
      sourceInFrame: number
      sourceOutFrame: number
      timelineInFrame: 0
      timelineOutFrame: number
      rate: 1
    }>[]
  }>[]
  synthesizedRanges: false
  lineageRefs: readonly string[]
  movementPolicy: Readonly<{
    automaticZoom: false
    reason: 'contiguous-source-preservation'
  }>
  selectionHash: string
}

export interface ContiguousExtractionResult {
  schemaVersion: 'contiguous-extraction-result/v1'
  policyVersion: typeof CONTIGUOUS_EXTRACTION_POLICY_VERSION
  id: string
  workspaceId: string
  projectId: string
  objective: string
  topic: string
  targetDurationMs: number
  toleranceMs: number
  candidates: readonly Readonly<ContiguousExtractionCandidate>[]
  selectedCandidateHash: string
  storyPlan: Readonly<StoryPlan> & Readonly<{
    id: string
    mode: 'contiguous'
    sourceRangeId: string
  }>
  editPlan: Readonly<ContiguousExtractionEditPlan>
  resultHash: string
}

export function calculateContiguousMomentEvaluationHash(input: {
  momentId: string
  momentHash: string
  indexRunId: string
  objectiveTags: readonly string[]
  semanticRangeMs: readonly [number, number]
  scores: ContiguousSourceMoment['scores']
}): string {
  return calculateCanonicalHash({
    policyVersion: CONTIGUOUS_EXTRACTION_POLICY_VERSION,
    momentId: input.momentId,
    momentHash: input.momentHash,
    indexRunId: input.indexRunId,
    objectiveTags: input.objectiveTags,
    semanticRangeMs: input.semanticRangeMs,
    scores: input.scores,
  })
}

function identity(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    ID_PATTERN.test(normalized),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function hash(value: string, field: string): string {
  const normalized = value.trim().toLowerCase()
  assertDomain(
    SHA256_PATTERN.test(normalized),
    'INVALID_ARGUMENT',
    `${field} must be SHA-256`,
  )
  return normalized
}

function text(value: string, field: string, maximum: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  assertDomain(
    normalized.length > 0 && normalized.length <= maximum,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function integer(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  assertDomain(
    Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function range(
  value: readonly [number, number],
  field: string,
  durationMs: number,
): readonly [number, number] {
  assertDomain(
    Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      Number.isSafeInteger(value[1]) &&
      value[0] >= 0 &&
      value[1] > value[0] &&
      value[1] <= durationMs,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return Object.freeze([value[0], value[1]])
}

function normalizeTag(value: string): string {
  return text(value, 'objectiveTags[]', 120).toLocaleLowerCase('pt-BR')
}

function normalizedMoment(
  value: Readonly<ContiguousSourceMoment>,
  index: number,
): Readonly<ContiguousSourceMoment> {
  const sourceDurationMs = integer(
    value.sourceDurationMs,
    `moments[${index}].sourceDurationMs`,
    1,
    12 * 60 * 60 * 1_000,
  )
  const recommendedRangeMs = range(
    value.recommendedRangeMs,
    `moments[${index}].recommendedRangeMs`,
    sourceDurationMs,
  )
  const semanticRangeMs = range(
    value.semanticRangeMs,
    `moments[${index}].semanticRangeMs`,
    sourceDurationMs,
  )
  assertDomain(
    semanticRangeMs[0] <= recommendedRangeMs[0] &&
      semanticRangeMs[1] >= recommendedRangeMs[1],
    'INVALID_ARGUMENT',
    `moments[${index}] semantic range must contain its recommended range`,
  )
  const scores = Object.fromEntries(
    DIMENSIONS.map((dimension) => {
      const observation = value.scores[dimension]
      assertDomain(
        Number.isFinite(observation?.value) &&
          observation.value >= 0 &&
          observation.value <= 1,
        'INVALID_ARGUMENT',
        `moments[${index}].scores.${dimension} is invalid`,
      )
      const evidenceRefs = observation.evidenceRefs.map((reference) =>
        identity(
          reference,
          `moments[${index}].scores.${dimension}.evidenceRefs[]`,
        ),
      )
      assertDomain(
        evidenceRefs.length > 0 &&
          evidenceRefs.length <= 32 &&
          new Set(evidenceRefs).size === evidenceRefs.length,
        'INVALID_ARGUMENT',
        `moments[${index}].scores.${dimension} needs unique evidence`,
      )
      return [
        dimension,
        Object.freeze({
          value: observation.value,
          evidenceRefs: Object.freeze(evidenceRefs),
        }),
      ]
    }),
  ) as unknown as ContiguousSourceMoment['scores']
  const objectiveTags = value.objectiveTags.map(normalizeTag)
  assertDomain(
    objectiveTags.length > 0 &&
      objectiveTags.length <= 32 &&
      new Set(objectiveTags).size === objectiveTags.length,
    'INVALID_ARGUMENT',
    `moments[${index}].objectiveTags is invalid`,
  )
  const normalized = Object.freeze({
    ...value,
    id: identity(value.id, `moments[${index}].id`),
    momentHash: hash(
      value.momentHash,
      `moments[${index}].momentHash`,
    ),
    evaluationId: identity(
      value.evaluationId,
      `moments[${index}].evaluationId`,
    ),
    evaluationHash: hash(
      value.evaluationHash,
      `moments[${index}].evaluationHash`,
    ),
    indexRunId: identity(
      value.indexRunId,
      `moments[${index}].indexRunId`,
    ),
    sourceArtifactId: identity(
      value.sourceArtifactId,
      `moments[${index}].sourceArtifactId`,
    ),
    sourceArtifactSha256: hash(
      value.sourceArtifactSha256,
      `moments[${index}].sourceArtifactSha256`,
    ),
    sourceManifestId: identity(
      value.sourceManifestId,
      `moments[${index}].sourceManifestId`,
    ),
    sourceManifestHash: hash(
      value.sourceManifestHash,
      `moments[${index}].sourceManifestHash`,
    ),
    chapterId: identity(
      value.chapterId,
      `moments[${index}].chapterId`,
    ),
    topic: text(value.topic, `moments[${index}].topic`, 500),
    objectiveTags: Object.freeze(objectiveTags),
    recommendedRangeMs,
    semanticRangeMs,
    sourceDurationMs,
    rightsSnapshotId: identity(
      value.rightsSnapshotId,
      `moments[${index}].rightsSnapshotId`,
    ),
    scores: Object.freeze(scores),
  })
  assertDomain(
    calculateContiguousMomentEvaluationHash({
      momentId: normalized.id,
      momentHash: normalized.momentHash,
      indexRunId: normalized.indexRunId,
      objectiveTags: normalized.objectiveTags,
      semanticRangeMs: normalized.semanticRangeMs,
      scores: normalized.scores,
    }) === normalized.evaluationHash,
    'INVALID_ARGUMENT',
    `moments[${index}] evaluation hash is invalid`,
  )
  return normalized
}

function candidate(
  moment: Readonly<ContiguousSourceMoment>,
  targetDurationMs: number,
  toleranceMs: number,
): Readonly<ContiguousExtractionCandidate> {
  const durationMs =
    moment.semanticRangeMs[1] - moment.semanticRangeMs[0]
  const durationDeltaMs = Math.abs(durationMs - targetDurationMs)
  const durationScore = Math.max(
    0,
    1 - durationDeltaMs / Math.max(targetDurationMs, toleranceMs),
  )
  const breakdown = Object.freeze({
    selfContained: moment.scores.selfContained.value,
    density: moment.scores.density.value,
    integrity: moment.scores.integrity.value,
    audio: moment.scores.audio.value,
    visual: moment.scores.visual.value,
    duration: durationScore,
  })
  const quality =
    DIMENSIONS.reduce(
      (total, dimension) => total + breakdown[dimension],
      0,
    ) / DIMENSIONS.length
  const score = Number((quality * 0.8 + durationScore * 0.2).toFixed(6))
  const evidenceRefs = Object.freeze(
    [...new Set(
      DIMENSIONS.flatMap(
        (dimension) => moment.scores[dimension].evidenceRefs,
      ),
    )].sort(),
  )
  const body = {
    sourceIndexRunId: moment.indexRunId,
    sourceMomentId: moment.id,
    sourceMomentHash: moment.momentHash,
    sourceEvaluationId: moment.evaluationId,
    sourceEvaluationHash: moment.evaluationHash,
    sourceRangeMs: moment.semanticRangeMs,
    durationMs,
    durationDeltaMs,
    score,
    scoreBreakdown: breakdown,
    evidenceRefs,
  }
  return Object.freeze({
    ...body,
    candidateHash: calculateCanonicalHash(body),
  })
}

export function extractContiguous(input: {
  id: string
  workspaceId: string
  projectId: string
  objective: string
  topic: string
  targetDurationMs: number
  toleranceMs: number
  fps: number
  moments: readonly Readonly<ContiguousSourceMoment>[]
}): Readonly<ContiguousExtractionResult> {
  const id = identity(input.id, 'id')
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  const objective = text(input.objective, 'objective', 240)
  const topic = text(input.topic, 'topic', 500)
  const objectiveKey = objective.toLocaleLowerCase('pt-BR')
  const topicKey = topic.toLocaleLowerCase('pt-BR')
  const targetDurationMs = integer(
    input.targetDurationMs,
    'targetDurationMs',
    1_000,
    60 * 60 * 1_000,
  )
  const toleranceMs = integer(
    input.toleranceMs,
    'toleranceMs',
    0,
    targetDurationMs,
  )
  assertDomain(
    Number.isInteger(input.fps) && input.fps >= 1 && input.fps <= 120,
    'INVALID_ARGUMENT',
    'fps is invalid',
  )
  assertDomain(
    input.moments.length > 0 && input.moments.length <= 10_000,
    'INVALID_ARGUMENT',
    'moments must be bounded',
  )
  const moments = input.moments.map(normalizedMoment)
  assertDomain(
    new Set(moments.map((moment) => moment.id)).size === moments.length,
    'INVALID_ARGUMENT',
    'moment identities must be unique',
  )
  const eligible = moments.filter((moment) =>
    moment.rightsStatus === 'approved' &&
    ['approved', 'not-required'].includes(moment.consentStatus) &&
    moment.topic.toLocaleLowerCase('pt-BR') === topicKey &&
    moment.objectiveTags.includes(objectiveKey),
  )
  const candidates = eligible
    .map((moment) =>
      candidate(moment, targetDurationMs, toleranceMs),
    )
    .filter((value) => value.durationDeltaMs <= toleranceMs)
    .sort((left, right) =>
      right.score - left.score ||
      left.durationDeltaMs - right.durationDeltaMs ||
      left.sourceRangeMs[0] - right.sourceRangeMs[0] ||
      left.sourceMomentId.localeCompare(right.sourceMomentId),
    )
  assertDomain(
    candidates.length > 0,
    'PRECONDITION_REQUIRED',
    'No authorized contiguous window satisfies the request',
  )
  const selected = candidates[0]!
  const selectedMoment = moments.find(
    (moment) => moment.id === selected.sourceMomentId,
  )!
  const sourceRangeId = `${id}:source-range`
  const storyPlanId = `${id}:story-plan`
  const selectedDurationMs = selected.durationMs
  const storyPlan = Object.freeze({
    schemaVersion: 1 as const,
    id: storyPlanId,
    mode: 'contiguous' as const,
    sourceRangeId,
    objective,
    targetDurationMs: Object.freeze({
      min: selectedDurationMs,
      max: selectedDurationMs,
    }),
    acts: Object.freeze([Object.freeze({
      id: `${id}:development`,
      role: 'development' as const,
      blockIds: Object.freeze([`${id}:source-block`]),
    })]),
    blocks: Object.freeze([Object.freeze({
      id: `${id}:source-block`,
      actId: `${id}:development`,
      role: 'argument' as const,
      intent: objective,
      dependencies: Object.freeze([] as string[]),
      sourceCandidateIds: Object.freeze([selected.sourceMomentId]),
      durationTargetMs: Object.freeze({
        min: selectedDurationMs,
        ideal: selectedDurationMs,
        max: selectedDurationMs,
      }),
      content: Object.freeze({
        claimIds: Object.freeze([] as string[]),
        qualifierIds: Object.freeze([] as string[]),
        proofIds: Object.freeze([] as string[]),
      }),
      presentation: 'source-video' as const,
      sourceRangeId,
    })]),
  })
  validateStoryPlan(storyPlan)
  const sourceInFrame = Math.round(
    selected.sourceRangeMs[0] / 1_000 * input.fps,
  )
  const sourceOutFrame = Math.round(
    selected.sourceRangeMs[1] / 1_000 * input.fps,
  )
  const durationFrames = sourceOutFrame - sourceInFrame
  assertDomain(
    durationFrames > 0,
    'INVALID_ARGUMENT',
    'selected range is shorter than one output frame',
  )
  const editPlanBody = {
    schemaVersion: 2 as const,
    state: 'compiled' as const,
    mode: 'contiguous' as const,
    id: `${id}:edit-plan`,
    storyPlanId,
    fps: input.fps,
    durationFrames,
    sources: Object.freeze([Object.freeze({
      id: `${id}:source`,
      artifactId: selectedMoment.sourceArtifactId,
      artifactSha256: selectedMoment.sourceArtifactSha256,
      manifestId: selectedMoment.sourceManifestId,
      manifestHash: selectedMoment.sourceManifestHash,
      kind: 'video' as const,
    })]),
    videoTracks: Object.freeze([Object.freeze({
      id: `${id}:base-video`,
      kind: 'base-video' as const,
      clips: Object.freeze([Object.freeze({
        id: `${id}:clip`,
        sourceArtifactId: selectedMoment.sourceArtifactId,
        sourceInFrame,
        sourceOutFrame,
        timelineInFrame: 0 as const,
        timelineOutFrame: durationFrames,
        rate: 1 as const,
      })]),
    })]),
    synthesizedRanges: false as const,
    lineageRefs: Object.freeze([
      selectedMoment.indexRunId,
      selectedMoment.chapterId,
      selectedMoment.id,
      selectedMoment.momentHash,
      selectedMoment.evaluationId,
      selectedMoment.evaluationHash,
      selectedMoment.rightsSnapshotId,
      ...selected.evidenceRefs,
    ]),
    movementPolicy: Object.freeze({
      automaticZoom: false as const,
      reason: 'contiguous-source-preservation' as const,
    }),
    selectionHash: selected.candidateHash,
  }
  const editPlan = Object.freeze(editPlanBody)
  const resultBody = {
    schemaVersion: 'contiguous-extraction-result/v1' as const,
    policyVersion: CONTIGUOUS_EXTRACTION_POLICY_VERSION,
    id,
    workspaceId,
    projectId,
    objective,
    topic,
    targetDurationMs,
    toleranceMs,
    candidates: Object.freeze(candidates),
    selectedCandidateHash: selected.candidateHash,
    storyPlan,
    editPlan,
  }
  return Object.freeze({
    ...resultBody,
    resultHash: calculateCanonicalHash(resultBody),
  })
}
