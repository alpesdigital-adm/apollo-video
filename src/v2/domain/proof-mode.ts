import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  OUTPUT_ASPECT_RATIOS,
  OUTPUT_PRESETS,
  type OutputAspectRatio,
} from './output-spec.ts'
import type {
  ProofIntegrityEvaluation,
  ProofIntegrityRun,
} from './proof-integrity.ts'
import type {
  ProofNeedItem,
  ProofNeedRun,
} from './proof-need.ts'

export const PROOF_MODE_RUN_SCHEMA_VERSION =
  'proof-mode-run/v1' as const
export const PROOF_MODE_POLICY_VERSION =
  'proof-mode-policy/v1' as const
export const PROOF_MODE_LAYOUT_SCHEMA_VERSION =
  'proof-mode-layout/v1' as const

export const PROOF_MODES = [
  'cutaway',
  'split-screen',
  'proof-card',
] as const
export const PROOF_MEDIA_TYPES = [
  'video',
  'image',
  'audio',
  'document',
] as const
export const PROOF_RHYTHMS = ['fast', 'measured'] as const

export type ProofMode = typeof PROOF_MODES[number]
export type ProofMediaType = typeof PROOF_MEDIA_TYPES[number]
export type ProofRhythm = typeof PROOF_RHYTHMS[number]

export interface ProofModeOverride {
  proofNeedItemId: string
  format: OutputAspectRatio
  mode: ProofMode
  expectedEvaluationHash: string
}

export interface ProofModeSource {
  evaluation: Readonly<ProofIntegrityEvaluation>
  proofNeedItem: Readonly<ProofNeedItem>
  sourceArtifactId: string
  sourceMediaType: ProofMediaType
  contextRequired: boolean
}

export interface ProofModeRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ProofModeLayout {
  schemaVersion: typeof PROOF_MODE_LAYOUT_SCHEMA_VERSION
  format: OutputAspectRatio
  canvas: Readonly<{ width: number; height: number }>
  safeRegion: Readonly<ProofModeRect>
  evidenceRegion: Readonly<ProofModeRect>
  presenterRegion?: Readonly<ProofModeRect>
  creditRegion: Readonly<ProofModeRect>
  qualifierRegion: Readonly<ProofModeRect>
  backgroundTreatment: 'source' | 'dimmed-source' | 'solid'
  layoutHash: string
}

export interface ProofModeTiming {
  timelineEntryFrame: number
  timelineEntryMs: number
  sourceContextRangeMs: readonly [number, number]
  minimumDurationFrames: number
  targetDurationFrames: number
  maximumDurationFrames: number
  entryTransition: Readonly<{
    kind: 'cut' | 'crossfade'
    durationFrames: number
  }>
  exitTransition: Readonly<{
    kind: 'cut' | 'crossfade'
    durationFrames: number
  }>
  timingHash: string
}

export interface ProofModePlan {
  id: string
  sequence: number
  proofIntegrityEvaluationId: string
  proofIntegrityEvaluationHash: string
  proofNeedItemId: string
  proofNeedItemHash: string
  claimText: string
  sourceEvidenceId: string
  sourceEvidenceHash: string
  sourceArtifactId: string
  sourceMediaType: ProofMediaType
  format: OutputAspectRatio
  rhythm: ProofRhythm
  mode: ProofMode
  selection: 'automatic' | 'manual-override'
  reasonCodes: readonly (
    | 'CONTEXT_PRESERVED'
    | 'FAST_VISUAL_CUTAWAY'
    | 'MEASURED_VISUAL_CUTAWAY'
    | 'MEASURED_WIDE_SPLIT'
    | 'MEASURED_IMAGE_CARD'
    | 'NONVISUAL_PROOF_CARD'
    | 'MANUAL_OVERRIDE'
  )[]
  contextRequired: boolean
  identificationRequired: true
  presentation: NonNullable<ProofIntegrityEvaluation['presentation']>
  timing: Readonly<ProofModeTiming>
  layout: Readonly<ProofModeLayout>
  legibility: Readonly<{
    minimumContrast: 4.5
    minimumFontPixels: number
    maximumAttributionCharacters: 96
    maximumQualifierCharacters: 160
    safeAreaRequired: true
  }>
  rendererContract: Readonly<{
    kind: 'proof-presentation'
    version: 1
    materializesNewMedia: false
  }>
  planHash: string
}

export interface ProofModeRun {
  schemaVersion: typeof PROOF_MODE_RUN_SCHEMA_VERSION
  policyVersion: typeof PROOF_MODE_POLICY_VERSION
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  proofIntegrityRunId: string
  proofIntegrityRunHash: string
  proofNeedRunId: string
  proofNeedRunHash: string
  formats: readonly OutputAspectRatio[]
  rhythm: ProofRhythm
  plans: readonly Readonly<ProofModePlan>[]
  summary: Readonly<{
    approvedEvidenceCount: number
    formatCount: number
    planCount: number
    automaticCount: number
    manualOverrideCount: number
    cutawayCount: number
    splitScreenCount: number
    proofCardCount: number
    allIntegrityBindingsPreserved: true
    readyForCompilation: boolean
  }>
  createdByClientId: string
  createdAt: string
  runHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical UTC instant`,
  )
  return value
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded - 1
}

function rect(
  x: number,
  y: number,
  width: number,
  height: number,
): Readonly<ProofModeRect> {
  return Object.freeze({
    x: Math.round(x),
    y: Math.round(y),
    width: even(width),
    height: even(height),
  })
}

function contains(
  outer: Readonly<ProofModeRect>,
  inner: Readonly<ProofModeRect>,
): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  )
}

function intersects(
  left: Readonly<ProofModeRect>,
  right: Readonly<ProofModeRect>,
): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  )
}

function layoutBody(
  format: OutputAspectRatio,
  mode: ProofMode,
) {
  const preset = OUTPUT_PRESETS[format]
  const { width, height, safeArea } = preset
  const safe = rect(
    width * safeArea.left,
    height * safeArea.top,
    width * (1 - safeArea.left - safeArea.right),
    height * (1 - safeArea.top - safeArea.bottom),
  )
  const gap = even(Math.max(12, Math.min(width, height) * .018))
  const creditHeight = even(Math.max(64, safe.height * .1))
  const qualifierHeight = even(Math.max(54, safe.height * .075))
  let evidenceRegion: Readonly<ProofModeRect>
  let presenterRegion: Readonly<ProofModeRect> | undefined
  let creditRegion: Readonly<ProofModeRect>
  let qualifierRegion: Readonly<ProofModeRect>
  let backgroundTreatment: ProofModeLayout['backgroundTreatment']

  if (mode === 'cutaway') {
    evidenceRegion = rect(0, 0, width, height)
    creditRegion = rect(
      safe.x,
      safe.y + safe.height - creditHeight,
      safe.width,
      creditHeight,
    )
    qualifierRegion = rect(
      safe.x,
      creditRegion.y - qualifierHeight - gap,
      safe.width,
      qualifierHeight,
    )
    backgroundTreatment = 'source'
  } else if (mode === 'split-screen') {
    const reservedBottom = creditHeight + qualifierHeight + gap * 2
    const contentHeight = safe.height - reservedBottom
    if (height > width) {
      const presenterHeight = even((contentHeight - gap) * .44)
      presenterRegion = rect(
        safe.x,
        safe.y,
        safe.width,
        presenterHeight,
      )
      evidenceRegion = rect(
        safe.x,
        presenterRegion.y + presenterRegion.height + gap,
        safe.width,
        contentHeight - presenterHeight - gap,
      )
    } else {
      const presenterWidth = even((safe.width - gap) * .42)
      presenterRegion = rect(
        safe.x,
        safe.y,
        presenterWidth,
        contentHeight,
      )
      evidenceRegion = rect(
        presenterRegion.x + presenterRegion.width + gap,
        safe.y,
        safe.width - presenterWidth - gap,
        contentHeight,
      )
    }
    qualifierRegion = rect(
      safe.x,
      safe.y + safe.height - creditHeight - qualifierHeight - gap,
      safe.width,
      qualifierHeight,
    )
    creditRegion = rect(
      safe.x,
      safe.y + safe.height - creditHeight,
      safe.width,
      creditHeight,
    )
    backgroundTreatment = 'dimmed-source'
  } else {
    const cardWidth = even(safe.width * .84)
    const cardHeight = even(safe.height * .62)
    const cardX = safe.x + (safe.width - cardWidth) / 2
    const cardY = safe.y + (safe.height - cardHeight) / 2
    creditRegion = rect(
      cardX + gap,
      cardY + cardHeight - creditHeight - gap,
      cardWidth - gap * 2,
      creditHeight,
    )
    qualifierRegion = rect(
      cardX + gap,
      creditRegion.y - qualifierHeight - gap,
      cardWidth - gap * 2,
      qualifierHeight,
    )
    evidenceRegion = rect(
      cardX + gap,
      cardY + gap,
      cardWidth - gap * 2,
      qualifierRegion.y - cardY - gap * 2,
    )
    backgroundTreatment = 'solid'
  }

  assertDomain(
    contains(mode === 'cutaway' ? rect(0, 0, width, height) : safe,
      evidenceRegion),
    'INVALID_OUTPUT_SPEC',
    'Proof evidence region exceeds its allowed canvas',
  )
  assertDomain(
    contains(safe, creditRegion) &&
      contains(safe, qualifierRegion) &&
      !intersects(creditRegion, qualifierRegion),
    'INVALID_OUTPUT_SPEC',
    'Proof identification regions are outside safe area or overlap',
  )
  if (presenterRegion) {
    assertDomain(
      contains(safe, presenterRegion) &&
        !intersects(presenterRegion, evidenceRegion),
      'INVALID_OUTPUT_SPEC',
      'Split-screen regions overlap or exceed safe area',
    )
  }
  if (mode === 'proof-card') {
    assertDomain(
      !intersects(evidenceRegion, qualifierRegion) &&
        !intersects(evidenceRegion, creditRegion),
      'INVALID_OUTPUT_SPEC',
      'Proof card content overlaps identification regions',
    )
  }
  return {
    schemaVersion: PROOF_MODE_LAYOUT_SCHEMA_VERSION,
    format,
    canvas: Object.freeze({ width, height }),
    safeRegion: safe,
    evidenceRegion,
    ...(presenterRegion ? { presenterRegion } : {}),
    creditRegion,
    qualifierRegion,
    backgroundTreatment,
  }
}

export function createProofModeLayout(
  format: OutputAspectRatio,
  mode: ProofMode,
): Readonly<ProofModeLayout> {
  assertDomain(
    OUTPUT_ASPECT_RATIOS.includes(format),
    'INVALID_OUTPUT_SPEC',
    'Proof format is unsupported',
  )
  assertDomain(
    PROOF_MODES.includes(mode),
    'INVALID_ARGUMENT',
    'Proof mode is unsupported',
  )
  const body = layoutBody(format, mode)
  return Object.freeze({
    ...body,
    layoutHash: calculateCanonicalHash(body),
  })
}

function automaticMode(input: {
  mediaType: ProofMediaType
  format: OutputAspectRatio
  rhythm: ProofRhythm
  contextRequired: boolean
}): Readonly<{
  mode: ProofMode
  reasonCodes: ProofModePlan['reasonCodes']
}> {
  const visual = input.mediaType === 'video' ||
    input.mediaType === 'image'
  if (!visual) {
    return Object.freeze({
      mode: 'proof-card',
      reasonCodes: Object.freeze(['NONVISUAL_PROOF_CARD'] as const),
    })
  }
  if (input.contextRequired) {
    return Object.freeze({
      mode: 'split-screen',
      reasonCodes: Object.freeze(['CONTEXT_PRESERVED'] as const),
    })
  }
  if (input.rhythm === 'fast') {
    return Object.freeze({
      mode: 'cutaway',
      reasonCodes: Object.freeze(['FAST_VISUAL_CUTAWAY'] as const),
    })
  }
  if (
    input.mediaType === 'video' &&
    (input.format === '16:9' || input.format === '21:9')
  ) {
    return Object.freeze({
      mode: 'split-screen',
      reasonCodes: Object.freeze(['MEASURED_WIDE_SPLIT'] as const),
    })
  }
  if (input.mediaType === 'image') {
    return Object.freeze({
      mode: 'proof-card',
      reasonCodes: Object.freeze(['MEASURED_IMAGE_CARD'] as const),
    })
  }
  return Object.freeze({
    mode: 'cutaway',
    reasonCodes: Object.freeze(
      ['MEASURED_VISUAL_CUTAWAY'] as const,
    ),
  })
}

function assertModeCompatible(
  mode: ProofMode,
  source: Readonly<ProofModeSource>,
) {
  const visual = source.sourceMediaType === 'video' ||
    source.sourceMediaType === 'image'
  assertDomain(
    mode === 'proof-card' || visual,
    'PRECONDITION_REQUIRED',
    `${mode} requires video or image evidence`,
  )
  assertDomain(
    !(source.contextRequired && mode === 'proof-card'),
    'PRECONDITION_REQUIRED',
    'Context-required evidence cannot be reduced to a proof card',
  )
}

function timing(input: {
  item: Readonly<ProofNeedItem>
  evaluation: Readonly<ProofIntegrityEvaluation>
  mode: ProofMode
  rhythm: ProofRhythm
  fps: number
}): Readonly<ProofModeTiming> {
  const presentation = input.evaluation.presentation!
  const [sourceStartMs, sourceEndMs] =
    presentation.requiredContextRangeMs
  const sourceDurationMs = sourceEndMs - sourceStartMs
  const base = input.mode === 'cutaway'
    ? { min: 1_500, target: 2_500, max: 8_000 }
    : input.mode === 'split-screen'
      ? { min: 3_000, target: 4_500, max: 12_000 }
      : { min: 2_500, target: 4_000, max: 8_000 }
  const minimumMs = Math.max(base.min, sourceDurationMs)
  const targetMs = Math.max(base.target, sourceDurationMs)
  const maximumMs = Math.max(base.max, sourceDurationMs)
  const frames = (milliseconds: number) =>
    Math.ceil(milliseconds * input.fps / 1_000)
  const transitionFrames = input.rhythm === 'fast' ? 0 :
    Math.max(4, Math.round(input.fps * .2))
  const body = {
    timelineEntryFrame: input.item.moment.timelineFrame,
    timelineEntryMs: input.item.moment.timelineMs,
    sourceContextRangeMs:
      Object.freeze([sourceStartMs, sourceEndMs]) as
        readonly [number, number],
    minimumDurationFrames: frames(minimumMs),
    targetDurationFrames: frames(targetMs),
    maximumDurationFrames: frames(maximumMs),
    entryTransition: Object.freeze({
      kind: transitionFrames === 0
        ? 'cut' as const
        : 'crossfade' as const,
      durationFrames: transitionFrames,
    }),
    exitTransition: Object.freeze({
      kind: 'cut' as const,
      durationFrames: 0,
    }),
  }
  return Object.freeze({
    ...body,
    timingHash: calculateCanonicalHash(body),
  })
}

function plan(input: {
  runId: string
  sequence: number
  source: Readonly<ProofModeSource>
  format: OutputAspectRatio
  rhythm: ProofRhythm
  override?: Readonly<ProofModeOverride>
}): Readonly<ProofModePlan> {
  const { source } = input
  const evaluation = source.evaluation
  assertDomain(
    evaluation.outcome === 'approved' &&
      evaluation.allowedForAssembly &&
      Boolean(evaluation.presentation) &&
      Boolean(evaluation.selectedEvidenceId) &&
      Boolean(evaluation.selectedEvidenceHash),
    'PRECONDITION_REQUIRED',
    'Only an approved ProofIntegrity evaluation can receive a proof mode',
  )
  assertDomain(
    source.proofNeedItem.id === evaluation.proofNeedItemId &&
      source.proofNeedItem.itemHash === evaluation.proofNeedItemHash &&
      source.proofNeedItem.selectedEvidence?.id ===
        evaluation.selectedEvidenceId &&
      source.proofNeedItem.selectedEvidence?.evidenceHash ===
        evaluation.selectedEvidenceHash,
    'VERSION_CONFLICT',
    'ProofNeed item no longer matches its ProofIntegrity evaluation',
  )
  if (input.override) {
    assertDomain(
      input.override.expectedEvaluationHash ===
        evaluation.evaluationHash,
      'VERSION_CONFLICT',
      'Manual proof mode override targets a stale evaluation',
    )
  }
  const selected = input.override
    ? Object.freeze({
        mode: input.override.mode,
        reasonCodes: Object.freeze(
          ['MANUAL_OVERRIDE'] as const,
        ),
      })
    : automaticMode({
        mediaType: source.sourceMediaType,
        format: input.format,
        rhythm: input.rhythm,
        contextRequired: source.contextRequired,
      })
  assertModeCompatible(selected.mode, source)
  const output = OUTPUT_PRESETS[input.format]
  const proofTiming = timing({
    item: source.proofNeedItem,
    evaluation,
    mode: selected.mode,
    rhythm: input.rhythm,
    fps: output.fps,
  })
  const proofLayout = createProofModeLayout(
    input.format,
    selected.mode,
  )
  const minimumFontPixels = Math.max(
    20,
    Math.round(Math.min(output.width, output.height) * .026),
  )
  const id = `proof-mode-plan-${calculateCanonicalHash({
    runId: input.runId,
    proofNeedItemId: evaluation.proofNeedItemId,
    format: input.format,
  }).slice(0, 40)}`
  const body = {
    id,
    sequence: input.sequence,
    proofIntegrityEvaluationId: evaluation.id,
    proofIntegrityEvaluationHash: evaluation.evaluationHash,
    proofNeedItemId: evaluation.proofNeedItemId,
    proofNeedItemHash: evaluation.proofNeedItemHash,
    claimText: source.proofNeedItem.claimText,
    sourceEvidenceId: evaluation.selectedEvidenceId!,
    sourceEvidenceHash: evaluation.selectedEvidenceHash!,
    sourceArtifactId: source.sourceArtifactId,
    sourceMediaType: source.sourceMediaType,
    format: input.format,
    rhythm: input.rhythm,
    mode: selected.mode,
    selection: input.override
      ? 'manual-override' as const
      : 'automatic' as const,
    reasonCodes: selected.reasonCodes,
    contextRequired: source.contextRequired,
    identificationRequired: true as const,
    presentation: evaluation.presentation!,
    timing: proofTiming,
    layout: proofLayout,
    legibility: Object.freeze({
      minimumContrast: 4.5 as const,
      minimumFontPixels,
      maximumAttributionCharacters: 96 as const,
      maximumQualifierCharacters: 160 as const,
      safeAreaRequired: true as const,
    }),
    rendererContract: Object.freeze({
      kind: 'proof-presentation' as const,
      version: 1 as const,
      materializesNewMedia: false as const,
    }),
  }
  return Object.freeze({
    ...body,
    planHash: calculateCanonicalHash(body),
  })
}

function runBody(value: ProofModeRun) {
  return {
    schemaVersion: value.schemaVersion,
    policyVersion: value.policyVersion,
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    batchId: value.batchId,
    proofIntegrityRunId: value.proofIntegrityRunId,
    proofIntegrityRunHash: value.proofIntegrityRunHash,
    proofNeedRunId: value.proofNeedRunId,
    proofNeedRunHash: value.proofNeedRunHash,
    formats: value.formats,
    rhythm: value.rhythm,
    plans: value.plans,
    summary: value.summary,
    createdByClientId: value.createdByClientId,
    createdAt: value.createdAt,
  }
}

export function createProofModeRun(input: {
  id: string
  workspaceId: string
  projectId: string
  proofIntegrityRun: Readonly<ProofIntegrityRun>
  proofNeedRun: Readonly<ProofNeedRun>
  sources: readonly Readonly<ProofModeSource>[]
  formats: readonly OutputAspectRatio[]
  rhythm: ProofRhythm
  overrides?: readonly Readonly<ProofModeOverride>[]
  createdByClientId: string
  createdAt: string
}): Readonly<ProofModeRun> {
  const id = identity(input.id, 'id')
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  const createdByClientId = identity(
    input.createdByClientId,
    'createdByClientId',
  )
  const createdAt = instant(input.createdAt, 'createdAt')
  assertDomain(
    input.proofIntegrityRun.workspaceId === workspaceId &&
      input.proofIntegrityRun.projectId === projectId &&
      input.proofIntegrityRun.summary.readyForAssembly,
    'PRECONDITION_REQUIRED',
    'ProofIntegrity run must be current, scoped and ready for assembly',
  )
  assertDomain(
    input.proofNeedRun.id ===
      input.proofIntegrityRun.proofNeedRunId &&
      input.proofNeedRun.runHash ===
        input.proofIntegrityRun.proofNeedRunHash,
    'VERSION_CONFLICT',
    'ProofNeed run no longer matches the ProofIntegrity run',
  )
  assertDomain(
    PROOF_RHYTHMS.includes(input.rhythm),
    'INVALID_ARGUMENT',
    'rhythm is unsupported',
  )
  assertDomain(
    Array.isArray(input.formats) &&
      input.formats.length >= 1 &&
      input.formats.length <= OUTPUT_ASPECT_RATIOS.length &&
      input.formats.every((format) =>
        OUTPUT_ASPECT_RATIOS.includes(format)),
    'INVALID_OUTPUT_SPEC',
    'formats must contain one to five supported formats',
  )
  assertDomain(
    new Set(input.formats).size === input.formats.length,
    'INVALID_OUTPUT_SPEC',
    'formats contains duplicates',
  )
  const formats = Object.freeze([...input.formats].toSorted())
  const approved = input.proofIntegrityRun.evaluations.filter(
    (evaluation) => evaluation.outcome === 'approved',
  )
  assertDomain(
    approved.length >= 1 && approved.length <= 16,
    'PRECONDITION_REQUIRED',
    'Proof mode planning requires at least one approved evidence',
  )
  assertDomain(
    input.sources.length === approved.length &&
      new Set(input.sources.map((source) => source.evaluation.id))
        .size === approved.length &&
      approved.every((evaluation) => input.sources.some((source) =>
        source.evaluation.id === evaluation.id &&
        source.evaluation.evaluationHash === evaluation.evaluationHash)),
    'PRECONDITION_REQUIRED',
    'sources must cover every approved ProofIntegrity evaluation exactly',
  )
  const overrides = input.overrides ?? []
  assertDomain(
    Array.isArray(overrides) &&
      overrides.length <= approved.length * formats.length,
    'INVALID_ARGUMENT',
    'overrides exceeds the bounded proof plan matrix',
  )
  const overrideKeys = overrides.map((override, index) => {
    identity(
      override.proofNeedItemId,
      `overrides[${index}].proofNeedItemId`,
    )
    hash(
      override.expectedEvaluationHash,
      `overrides[${index}].expectedEvaluationHash`,
    )
    assertDomain(
      OUTPUT_ASPECT_RATIOS.includes(override.format) &&
        formats.includes(override.format),
      'INVALID_OUTPUT_SPEC',
      `overrides[${index}].format is outside the requested matrix`,
    )
    assertDomain(
      PROOF_MODES.includes(override.mode),
      'INVALID_ARGUMENT',
      `overrides[${index}].mode is unsupported`,
    )
    return `${override.proofNeedItemId}:${override.format}`
  })
  assertDomain(
    new Set(overrideKeys).size === overrideKeys.length,
    'INVALID_ARGUMENT',
    'overrides contains duplicate segment/format targets',
  )
  assertDomain(
    overrides.every((override) => approved.some((evaluation) =>
      evaluation.proofNeedItemId === override.proofNeedItemId)),
    'INVALID_ARGUMENT',
    'override targets an item without approved evidence',
  )
  const overrideByTarget = new Map(overrides.map((override) => [
    `${override.proofNeedItemId}:${override.format}`,
    override,
  ]))
  let sequence = 0
  const plans = Object.freeze(input.sources
    .toSorted((left, right) =>
      left.evaluation.sequence - right.evaluation.sequence)
    .flatMap((source) => formats.map((format) => {
      sequence += 1
      return plan({
        runId: id,
        sequence,
        source,
        format,
        rhythm: input.rhythm,
        override: overrideByTarget.get(
          `${source.evaluation.proofNeedItemId}:${format}`,
        ),
      })
    })))
  const manualOverrideCount = plans.filter(
    (entry) => entry.selection === 'manual-override',
  ).length
  const summary = Object.freeze({
    approvedEvidenceCount: approved.length,
    formatCount: formats.length,
    planCount: plans.length,
    automaticCount: plans.length - manualOverrideCount,
    manualOverrideCount,
    cutawayCount: plans.filter((entry) =>
      entry.mode === 'cutaway').length,
    splitScreenCount: plans.filter((entry) =>
      entry.mode === 'split-screen').length,
    proofCardCount: plans.filter((entry) =>
      entry.mode === 'proof-card').length,
    allIntegrityBindingsPreserved: true as const,
    readyForCompilation: plans.length > 0,
  })
  const body = {
    schemaVersion: PROOF_MODE_RUN_SCHEMA_VERSION,
    policyVersion: PROOF_MODE_POLICY_VERSION,
    id,
    workspaceId,
    projectId,
    batchId: input.proofIntegrityRun.batchId,
    proofIntegrityRunId: input.proofIntegrityRun.id,
    proofIntegrityRunHash: input.proofIntegrityRun.runHash,
    proofNeedRunId: input.proofNeedRun.id,
    proofNeedRunHash: input.proofNeedRun.runHash,
    formats,
    rhythm: input.rhythm,
    plans,
    summary,
    createdByClientId,
    createdAt,
  }
  return Object.freeze({
    ...body,
    runHash: calculateCanonicalHash(body),
  })
}

export function assertProofModePlan(
  entry: Readonly<ProofModePlan>,
  field = 'proofModePlan',
): void {
  assertDomain(
    Number.isSafeInteger(entry.sequence) &&
      entry.sequence >= 1 &&
      entry.sequence <= 80 &&
      PROOF_MODES.includes(entry.mode) &&
      PROOF_MEDIA_TYPES.includes(entry.sourceMediaType) &&
      OUTPUT_ASPECT_RATIOS.includes(entry.format) &&
      entry.layout.format === entry.format &&
      entry.identificationRequired === true &&
      entry.rendererContract.kind === 'proof-presentation' &&
      entry.rendererContract.version === 1 &&
      entry.rendererContract.materializesNewMedia === false &&
      entry.presentation.visual.attribution ===
        entry.presentation.verbal.attribution &&
      typeof entry.claimText === 'string' &&
      entry.claimText.trim() === entry.claimText &&
      entry.claimText.length >= 2 &&
      entry.claimText.length <= 500 &&
      stableSerialize(entry.presentation.visual.qualifiers) ===
        stableSerialize(entry.presentation.verbal.qualifiers) &&
      entry.timing.timingHash === calculateCanonicalHash({
        timelineEntryFrame: entry.timing.timelineEntryFrame,
        timelineEntryMs: entry.timing.timelineEntryMs,
        sourceContextRangeMs: entry.timing.sourceContextRangeMs,
        minimumDurationFrames: entry.timing.minimumDurationFrames,
        targetDurationFrames: entry.timing.targetDurationFrames,
        maximumDurationFrames: entry.timing.maximumDurationFrames,
        entryTransition: entry.timing.entryTransition,
        exitTransition: entry.timing.exitTransition,
      }) &&
      entry.layout.layoutHash === calculateCanonicalHash({
        schemaVersion: entry.layout.schemaVersion,
        format: entry.layout.format,
        canvas: entry.layout.canvas,
        safeRegion: entry.layout.safeRegion,
        evidenceRegion: entry.layout.evidenceRegion,
        ...(entry.layout.presenterRegion
          ? { presenterRegion: entry.layout.presenterRegion }
          : {}),
        creditRegion: entry.layout.creditRegion,
        qualifierRegion: entry.layout.qualifierRegion,
        backgroundTreatment: entry.layout.backgroundTreatment,
      }),
    'PERSISTENCE_CONFLICT',
    `${field} is invalid`,
  )
  const { planHash, ...planWithoutHash } = entry
  assertDomain(
    hash(planHash, `${field}.planHash`) ===
      calculateCanonicalHash(planWithoutHash),
    'PERSISTENCE_CONFLICT',
    `${field} hash is invalid`,
  )
}

export function hydrateProofModeRun(
  value: unknown,
): Readonly<ProofModeRun> {
  assertDomain(
    typeof value === 'object' && value !== null,
    'INVALID_ARGUMENT',
    'ProofMode run must be an object',
  )
  const run = value as ProofModeRun
  assertDomain(
    run.schemaVersion === PROOF_MODE_RUN_SCHEMA_VERSION &&
      run.policyVersion === PROOF_MODE_POLICY_VERSION,
    'INVALID_ARGUMENT',
    'ProofMode run version is unsupported',
  )
  identity(run.id, 'run.id')
  identity(run.workspaceId, 'run.workspaceId')
  identity(run.projectId, 'run.projectId')
  identity(run.batchId, 'run.batchId')
  identity(run.proofIntegrityRunId, 'run.proofIntegrityRunId')
  hash(run.proofIntegrityRunHash, 'run.proofIntegrityRunHash')
  identity(run.proofNeedRunId, 'run.proofNeedRunId')
  hash(run.proofNeedRunHash, 'run.proofNeedRunHash')
  identity(run.createdByClientId, 'run.createdByClientId')
  instant(run.createdAt, 'run.createdAt')
  assertDomain(
    Array.isArray(run.plans) && run.plans.length >= 1 &&
      run.plans.length <= 80 &&
      Array.isArray(run.formats) &&
      run.formats.length >= 1 &&
      run.formats.length <= 5 &&
      PROOF_RHYTHMS.includes(run.rhythm),
    'INVALID_ARGUMENT',
    'ProofMode run matrix is invalid',
  )
  for (const [index, entry] of run.plans.entries()) {
    assertDomain(
      entry.sequence === index + 1,
      'PERSISTENCE_CONFLICT',
      `Stored ProofMode plan ${index + 1} is invalid`,
    )
    assertProofModePlan(entry, `Stored ProofMode plan ${index + 1}`)
  }
  const approvedEvidenceCount = new Set(run.plans.map(
    (entry) => entry.proofIntegrityEvaluationId,
  )).size
  const manualOverrideCount = run.plans.filter(
    (entry) => entry.selection === 'manual-override',
  ).length
  const expectedSummary = {
    approvedEvidenceCount,
    formatCount: run.formats.length,
    planCount: run.plans.length,
    automaticCount: run.plans.length - manualOverrideCount,
    manualOverrideCount,
    cutawayCount: run.plans.filter((entry) =>
      entry.mode === 'cutaway').length,
    splitScreenCount: run.plans.filter((entry) =>
      entry.mode === 'split-screen').length,
    proofCardCount: run.plans.filter((entry) =>
      entry.mode === 'proof-card').length,
    allIntegrityBindingsPreserved: true,
    readyForCompilation: true,
  }
  assertDomain(
    stableSerialize(run.summary) === stableSerialize(expectedSummary) &&
      run.runHash === calculateCanonicalHash(runBody(run)),
    'PERSISTENCE_CONFLICT',
    'Stored ProofMode summary or run hash is invalid',
  )
  return Object.freeze(run)
}

export const PROOF_MODE_VISUAL_GOLDENS = Object.freeze(
  OUTPUT_ASPECT_RATIOS.flatMap((format) =>
    PROOF_MODES.map((mode) => Object.freeze({
      id: `proof-mode-${format.replace(':', 'x')}-${mode}`,
      format,
      mode,
      layout: createProofModeLayout(format, mode),
    }))),
)
