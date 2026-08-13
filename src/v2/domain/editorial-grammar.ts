import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

export const EDITORIAL_GRAMMAR_POLICY = Object.freeze({
  schemaVersion: 'editorial-grammar-policy/v1' as const,
  version: 'editorial-grammar-2026-08-v1',
  broll: Object.freeze({ minDurationMs: 900, maxDurationMs: 6_000 }),
  motion: Object.freeze({
    zoom: Object.freeze({ maxAmplitude: 0.18, maxVelocity: 0.18, minDurationMs: 500, cooldownMs: 2_000 }),
    pan: Object.freeze({ maxAmplitude: 0.15, maxVelocity: 0.15, minDurationMs: 650, cooldownMs: 2_500 }),
    tilt: Object.freeze({ maxAmplitude: 0.12, maxVelocity: 0.12, minDurationMs: 650, cooldownMs: 2_500 }),
  }),
  patternBreaks: Object.freeze({
    windowMs: 30_000,
    awareness: Object.freeze({ minPerWindow: 2, maxPerWindow: 4, maxSameType: 2, maxSameGroup: 2 }),
    conversion: Object.freeze({ minPerWindow: 3, maxPerWindow: 5, maxSameType: 2, maxSameGroup: 2 }),
  }),
})

export type EditorialObjective = 'awareness' | 'conversion'
export type EditorialActRole = 'hook' | 'body' | 'proof' | 'cta'
export type CameraMotionKind = 'zoom' | 'pan' | 'tilt'
export type PatternBreakType = 'zoom' | 'insert' | 'cutaway' | 'layout-change'
export type ContinuityDimension = 'eye-line' | 'movement' | 'position' | 'color' | 'audio' | 'argument'

export interface SemanticWindow {
  id: string
  startMs: number
  endMs: number
  conclusionMs: number
  obstructedRanges: readonly (readonly [number, number])[]
}

export interface BrollRequest {
  id: string
  windowId: string
  entryCue: Readonly<{
    kind: 'semantic-boundary' | 'post-setup-pause' | 'gaze-change' | 'keyword' | 'technical-cover'
    atMs: number
    evidenceRef: string
  }>
  desiredDurationMs: number
}

export interface CameraMotion {
  id: string
  kind: CameraMotionKind
  reason: string
  evidenceRef: string
  startMs: number
  endMs: number
  amplitude: number
  velocity: number
  cooldownMs: number
}

export interface EditorialAct {
  id: string
  role: EditorialActRole
  startMs: number
  endMs: number
}

export interface PatternBreak {
  id: string
  atMs: number
  type: PatternBreakType
  semanticGroup: string
  reason: string
}

export interface ContinuityFrame {
  id: string
  atMs: number
  eyeLine: string
  movement: string
  position: string
  color: string
  audio: string
  argument: string
  justifiedChanges: readonly ContinuityDimension[]
  evidenceRefs: readonly string[]
}

export interface EditorialGrammarEvaluationInput {
  policyVersion: typeof EDITORIAL_GRAMMAR_POLICY.version
  objective: EditorialObjective
  durationMs: number
  semanticWindows: readonly SemanticWindow[]
  brollRequests: readonly BrollRequest[]
  motions: readonly CameraMotion[]
  acts: readonly EditorialAct[]
  patternBreaks: readonly PatternBreak[]
  continuityFrames: readonly ContinuityFrame[]
}

export interface EditorialGrammarIssue {
  code: string
  dimension: 'b-roll' | 'motion' | 'energy' | 'pattern-break' | 'continuity'
  severity: 'block' | 'review'
  subjectIds: readonly string[]
  fromMs: number
  toMs: number
  detail: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/
const TOKEN = /^[^\u0000-\u001F\u007F]{3,256}$/u
const MOTION_REASON = /^(emphasis|reveal|reframe|proof-focus|continuity-repair):[^\u0000-\u001F\u007F]{3,160}$/u
const CONTINUITY_FIELDS: Readonly<Record<ContinuityDimension, keyof ContinuityFrame>> = Object.freeze({
  'eye-line': 'eyeLine', movement: 'movement', position: 'position', color: 'color', audio: 'audio', argument: 'argument',
})

function runtimeArray(value: unknown): boolean {
  return Array.isArray(value)
}

function integer(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is outside editorial grammar bounds`)
  }
  return value
}

function validId(value: string, field: string): string {
  const normalized = value?.trim()
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function validToken(value: string, field: string): string {
  const normalized = value?.trim()
  if (!TOKEN.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function validRef(value: string, field: string): string {
  const normalized = value?.trim()
  if (!REF.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function issue(input: EditorialGrammarIssue): Readonly<EditorialGrammarIssue> {
  return Object.freeze({ ...input, subjectIds: Object.freeze([...input.subjectIds]) })
}

function canonicalSemanticWindows(values: readonly SemanticWindow[], durationMs: number) {
  if (!runtimeArray(values) || values.length < 1 || values.length > 128) {
    throw new DomainError('INVALID_ARGUMENT', 'Editorial grammar requires bounded semantic windows')
  }
  const ids = new Set<string>()
  const sorted = values.map((window) => {
    const id = validId(window.id, 'semanticWindow.id')
    if (ids.has(id)) throw new DomainError('INVALID_ARGUMENT', 'Semantic window IDs must be unique')
    ids.add(id)
    const startMs = integer(window.startMs, 0, durationMs - 1, 'semanticWindow.startMs')
    const endMs = integer(window.endMs, startMs + 1, durationMs, 'semanticWindow.endMs')
    const conclusionMs = integer(window.conclusionMs, startMs + 1, endMs, 'semanticWindow.conclusionMs')
    if (!runtimeArray(window.obstructedRanges) || window.obstructedRanges.length > 32) {
      throw new DomainError('INVALID_ARGUMENT', 'Semantic obstruction ranges are invalid')
    }
    const obstructedRanges = window.obstructedRanges.map((range) => {
      if (!runtimeArray(range) || range.length !== 2) throw new DomainError('INVALID_ARGUMENT', 'Semantic obstruction range is invalid')
      const fromMs = integer(range[0], startMs, endMs - 1, 'obstructedRange.fromMs')
      const toMs = integer(range[1], fromMs + 1, endMs, 'obstructedRange.toMs')
      return Object.freeze([fromMs, toMs] as const)
    }).toSorted((left, right) => left[0] - right[0] || left[1] - right[1])
    for (let index = 1; index < obstructedRanges.length; index += 1) {
      if (obstructedRanges[index][0] < obstructedRanges[index - 1][1]) {
        throw new DomainError('INVALID_ARGUMENT', 'Semantic obstruction ranges must not overlap')
      }
    }
    return Object.freeze({ id, startMs, endMs, conclusionMs, obstructedRanges: Object.freeze(obstructedRanges) })
  }).toSorted((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].startMs < sorted[index - 1].endMs) {
      throw new DomainError('INVALID_ARGUMENT', 'Semantic windows must be ordered and non-overlapping')
    }
  }
  return Object.freeze(sorted)
}

function inspectBrollPlacement(window: Readonly<SemanticWindow>, request: Readonly<BrollRequest>) {
  const startMs = request.entryCue.atMs
  const durationValid = Number.isSafeInteger(request.desiredDurationMs) &&
    request.desiredDurationMs >= EDITORIAL_GRAMMAR_POLICY.broll.minDurationMs &&
    request.desiredDurationMs <= EDITORIAL_GRAMMAR_POLICY.broll.maxDurationMs
  if (!durationValid) return Object.freeze({ accepted: false as const, code: 'BROLL_DURATION_OUT_OF_BOUNDS', fromMs: startMs, toMs: startMs })
  if (startMs < window.startMs || startMs >= window.conclusionMs) {
    return Object.freeze({ accepted: false as const, code: 'BROLL_ENTRY_OUTSIDE_SEMANTIC_WINDOW', fromMs: startMs, toMs: startMs })
  }
  const desiredEndMs = startMs + request.desiredDurationMs
  const endMs = Math.min(desiredEndMs, window.conclusionMs, window.endMs)
  if (endMs - startMs < EDITORIAL_GRAMMAR_POLICY.broll.minDurationMs) {
    return Object.freeze({ accepted: false as const, code: 'BROLL_SEMANTIC_WINDOW_TOO_SHORT', fromMs: startMs, toMs: endMs })
  }
  if (window.obstructedRanges.some(([fromMs, toMs]) => startMs < toMs && endMs > fromMs)) {
    return Object.freeze({ accepted: false as const, code: 'BROLL_PROTECTED_RANGE_OBSTRUCTION', fromMs: startMs, toMs: endMs })
  }
  return Object.freeze({
    accepted: true as const,
    id: request.id,
    windowId: window.id,
    startMs,
    endMs,
    entryReason: request.entryCue.kind,
    entryEvidenceRef: request.entryCue.evidenceRef,
    exitReason: endMs === window.conclusionMs ? 'semantic-conclusion' as const : 'duration-bound' as const,
  })
}

export function placeBroll(window: SemanticWindow, request: BrollRequest) {
  const result = inspectBrollPlacement(window, request)
  if (!result.accepted) throw new DomainError('INVALID_ARGUMENT', result.code)
  return result
}

function inspectCameraMotions(motions: readonly CameraMotion[], durationMs: number) {
  if (!runtimeArray(motions) || motions.length > 128) throw new DomainError('INVALID_ARGUMENT', 'Camera motions are not bounded')
  const ids = new Set<string>()
  const normalized = motions.map((motion) => {
    const id = validId(motion.id, 'motion.id')
    if (ids.has(id)) throw new DomainError('INVALID_ARGUMENT', 'Camera motion IDs must be unique')
    ids.add(id)
    if (!['zoom', 'pan', 'tilt'].includes(motion.kind)) throw new DomainError('INVALID_ARGUMENT', 'Camera motion kind is invalid')
    return Object.freeze({ ...motion, id, reason: motion.reason?.trim(), evidenceRef: motion.evidenceRef?.trim() })
  }).toSorted((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
  const issues: EditorialGrammarIssue[] = []
  for (let index = 0; index < normalized.length; index += 1) {
    const motion = normalized[index]
    const bounds = EDITORIAL_GRAMMAR_POLICY.motion[motion.kind]
    const intervalValid = Number.isSafeInteger(motion.startMs) && Number.isSafeInteger(motion.endMs) &&
      motion.startMs >= 0 && motion.endMs <= durationMs && motion.endMs > motion.startMs
    const fromMs = intervalValid ? motion.startMs : Math.max(0, Number.isFinite(motion.startMs) ? motion.startMs : 0)
    const toMs = intervalValid ? motion.endMs : fromMs
    if (!MOTION_REASON.test(motion.reason) || !REF.test(motion.evidenceRef)) {
      issues.push(issue({ code: 'MOTION_REASON_EVIDENCE_REQUIRED', dimension: 'motion', severity: 'block', subjectIds: [motion.id], fromMs, toMs, detail: 'Motion needs a canonical editorial reason and evidence reference.' }))
    }
    if (!intervalValid || motion.endMs - motion.startMs < bounds.minDurationMs) {
      issues.push(issue({ code: 'MOTION_INSTANTANEOUS', dimension: 'motion', severity: 'block', subjectIds: [motion.id], fromMs, toMs, detail: 'Motion duration is missing or shorter than the kind-specific minimum.' }))
    }
    if (!Number.isFinite(motion.amplitude) || motion.amplitude <= 0 || motion.amplitude > bounds.maxAmplitude) {
      issues.push(issue({ code: 'MOTION_AMPLITUDE_EXCESS', dimension: 'motion', severity: 'block', subjectIds: [motion.id], fromMs, toMs, detail: 'Motion amplitude exceeds the kind-specific treatment policy.' }))
    }
    const computedVelocity = intervalValid ? motion.amplitude / ((motion.endMs - motion.startMs) / 1_000) : Number.NaN
    if (!Number.isFinite(motion.velocity) || motion.velocity <= 0 || motion.velocity > bounds.maxVelocity ||
      !Number.isFinite(computedVelocity) || Math.abs(motion.velocity - computedVelocity) > 0.000_001) {
      issues.push(issue({ code: 'MOTION_VELOCITY_INVALID', dimension: 'motion', severity: 'block', subjectIds: [motion.id], fromMs, toMs, detail: 'Declared velocity must equal amplitude over duration and remain bounded.' }))
    }
    if (!Number.isSafeInteger(motion.cooldownMs) || motion.cooldownMs < bounds.cooldownMs || motion.cooldownMs > 30_000) {
      issues.push(issue({ code: 'MOTION_COOLDOWN_INVALID', dimension: 'motion', severity: 'block', subjectIds: [motion.id], fromMs, toMs, detail: 'Motion cooldown is below the kind-specific policy or unbounded.' }))
    }
    const previous = normalized[index - 1]
    if (previous && intervalValid && motion.startMs < previous.endMs + previous.cooldownMs) {
      issues.push(issue({ code: 'MOTION_COOLDOWN_VIOLATION', dimension: 'motion', severity: 'block', subjectIds: [previous.id, motion.id], fromMs: previous.endMs, toMs: motion.startMs, detail: 'Adjacent motions do not preserve the declared cooldown.' }))
    }
  }
  return Object.freeze({ motions: Object.freeze(normalized), issues: Object.freeze(issues) })
}

export function validateCameraMotions(motions: readonly CameraMotion[], durationMs = 3_600_000): readonly Readonly<CameraMotion>[] {
  const report = inspectCameraMotions(motions, durationMs)
  if (report.issues.length) throw new DomainError('INVALID_ARGUMENT', report.issues[0].code)
  return report.motions
}

const ENERGY: Readonly<Record<EditorialObjective, Readonly<Record<EditorialActRole, Readonly<{ energy: number; targetBreakDensityPer30s: number }>>>>> = Object.freeze({
  awareness: Object.freeze({ hook: Object.freeze({ energy: 0.82, targetBreakDensityPer30s: 3 }), body: Object.freeze({ energy: 0.52, targetBreakDensityPer30s: 2 }), proof: Object.freeze({ energy: 0.60, targetBreakDensityPer30s: 2 }), cta: Object.freeze({ energy: 0.58, targetBreakDensityPer30s: 2 }) }),
  conversion: Object.freeze({ hook: Object.freeze({ energy: 0.90, targetBreakDensityPer30s: 5 }), body: Object.freeze({ energy: 0.64, targetBreakDensityPer30s: 3 }), proof: Object.freeze({ energy: 0.76, targetBreakDensityPer30s: 4 }), cta: Object.freeze({ energy: 0.84, targetBreakDensityPer30s: 5 }) }),
})

export function energyCurve(input: { acts: readonly EditorialAct[]; objective: EditorialObjective; durationMs?: number }) {
  if (!ENERGY[input.objective] || !runtimeArray(input.acts) || input.acts.length < 1 || input.acts.length > 32) {
    throw new DomainError('INVALID_ARGUMENT', 'Editorial energy curve input is invalid')
  }
  const ids = new Set<string>()
  const sorted = input.acts.map((act) => {
    const id = validId(act.id, 'act.id')
    if (ids.has(id)) throw new DomainError('INVALID_ARGUMENT', 'Editorial act IDs must be unique')
    ids.add(id)
    if (!ENERGY[input.objective][act.role]) throw new DomainError('INVALID_ARGUMENT', 'Editorial act role is invalid')
    return Object.freeze({ ...act, id })
  }).toSorted((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id))
  const durationMs = input.durationMs ?? sorted.at(-1)?.endMs ?? 0
  for (let index = 0; index < sorted.length; index += 1) {
    const act = sorted[index]
    integer(act.startMs, 0, Math.max(0, durationMs - 1), 'act.startMs')
    integer(act.endMs, act.startMs + 1, durationMs, 'act.endMs')
    if ((index === 0 && act.startMs !== 0) || (index > 0 && act.startMs !== sorted[index - 1].endMs)) {
      throw new DomainError('INVALID_ARGUMENT', 'Editorial acts must cover the timeline without gaps or overlaps')
    }
  }
  if (sorted.at(-1)?.endMs !== durationMs) throw new DomainError('INVALID_ARGUMENT', 'Editorial acts must end at the treatment duration')
  return Object.freeze(sorted.map((act) => Object.freeze({ ...act, ...ENERGY[input.objective][act.role] })))
}

export function validatePatternBreakBudget(
  items: readonly PatternBreak[],
  input: { objective: EditorialObjective; durationMs: number },
) {
  const budget = EDITORIAL_GRAMMAR_POLICY.patternBreaks[input.objective]
  if (!budget) throw new DomainError('INVALID_ARGUMENT', 'Pattern-break objective is invalid')
  const durationMs = integer(input.durationMs, 1, 3_600_000, 'durationMs')
  if (!runtimeArray(items) || items.length > 512) throw new DomainError('INVALID_ARGUMENT', 'Pattern breaks are not bounded')
  const ids = new Set<string>()
  const sorted = items.map((item) => {
    const id = validId(item.id, 'patternBreak.id')
    if (ids.has(id)) throw new DomainError('INVALID_ARGUMENT', 'Pattern-break IDs must be unique')
    ids.add(id)
    if (!['zoom', 'insert', 'cutaway', 'layout-change'].includes(item.type)) throw new DomainError('INVALID_ARGUMENT', 'Pattern-break type is invalid')
    return Object.freeze({ ...item, id, atMs: integer(item.atMs, 0, durationMs - 1, 'patternBreak.atMs'), semanticGroup: validToken(item.semanticGroup, 'patternBreak.semanticGroup'), reason: validToken(item.reason, 'patternBreak.reason') })
  }).toSorted((left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id))
  const issues: EditorialGrammarIssue[] = []
  const windowMs = EDITORIAL_GRAMMAR_POLICY.patternBreaks.windowMs
  for (let fromMs = 0; fromMs < durationMs; fromMs += windowMs) {
    const toMs = Math.min(durationMs, fromMs + windowMs)
    const inWindow = sorted.filter((item) => item.atMs >= fromMs && item.atMs < toMs)
    const scale = (toMs - fromMs) / windowMs
    const minimum = Math.max(1, Math.ceil(budget.minPerWindow * scale))
    const maximum = Math.max(1, Math.ceil(budget.maxPerWindow * scale))
    if (inWindow.length < minimum) issues.push(issue({ code: 'PATTERN_WINDOW_SCARCITY', dimension: 'pattern-break', severity: 'review', subjectIds: inWindow.map((item) => item.id), fromMs, toMs, detail: `Window has ${inWindow.length} pattern breaks; minimum is ${minimum}.` }))
    if (inWindow.length > maximum) issues.push(issue({ code: 'PATTERN_WINDOW_EXCESS', dimension: 'pattern-break', severity: 'block', subjectIds: inWindow.map((item) => item.id), fromMs, toMs, detail: `Window has ${inWindow.length} pattern breaks; maximum is ${maximum}.` }))
    for (const type of [...new Set(inWindow.map((item) => item.type))].toSorted()) {
      const sameType = inWindow.filter((item) => item.type === type)
      if (sameType.length > budget.maxSameType) issues.push(issue({ code: 'PATTERN_TYPE_EXCESS', dimension: 'pattern-break', severity: 'block', subjectIds: sameType.map((item) => item.id), fromMs, toMs, detail: `Pattern-break type ${type} repeats beyond policy.` }))
    }
    for (const group of [...new Set(inWindow.map((item) => item.semanticGroup))].toSorted()) {
      const sameGroup = inWindow.filter((item) => item.semanticGroup === group)
      if (sameGroup.length > budget.maxSameGroup) issues.push(issue({ code: 'PATTERN_GROUP_EXCESS', dimension: 'pattern-break', severity: 'block', subjectIds: sameGroup.map((item) => item.id), fromMs, toMs, detail: `Semantic group ${group} repeats beyond policy.` }))
    }
  }
  const excessive = issues.some((value) => value.code.endsWith('_EXCESS'))
  const scarce = issues.some((value) => value.code === 'PATTERN_WINDOW_SCARCITY')
  return Object.freeze({
    valid: issues.length === 0,
    distribution: excessive ? 'excessive' as const : scarce ? 'scarce' as const : 'adequate' as const,
    policy: Object.freeze({ windowMs, ...budget }),
    items: Object.freeze(sorted),
    issues: Object.freeze(issues),
  })
}

export function validateContinuity(frames: readonly ContinuityFrame[], durationMs = 3_600_000) {
  if (!runtimeArray(frames) || frames.length < 1 || frames.length > 512) throw new DomainError('INVALID_ARGUMENT', 'Continuity frames are not bounded')
  const ids = new Set<string>()
  const sorted = frames.map((frame) => {
    const id = validId(frame.id, 'continuityFrame.id')
    if (ids.has(id)) throw new DomainError('INVALID_ARGUMENT', 'Continuity frame IDs must be unique')
    ids.add(id)
    const justifiedChanges = Object.freeze([...frame.justifiedChanges])
    if (new Set(justifiedChanges).size !== justifiedChanges.length || justifiedChanges.some((value) => !(value in CONTINUITY_FIELDS))) {
      throw new DomainError('INVALID_ARGUMENT', 'Continuity justifications are invalid')
    }
    const evidenceRefs = Object.freeze(frame.evidenceRefs.map((value) => validRef(value, 'continuityFrame.evidenceRef')))
    if (justifiedChanges.length > 0 && evidenceRefs.length < 1) throw new DomainError('INVALID_ARGUMENT', 'Justified continuity changes require evidence')
    return Object.freeze({
      ...frame,
      id,
      atMs: integer(frame.atMs, 0, durationMs, 'continuityFrame.atMs'),
      eyeLine: validToken(frame.eyeLine, 'continuityFrame.eyeLine'),
      movement: validToken(frame.movement, 'continuityFrame.movement'),
      position: validToken(frame.position, 'continuityFrame.position'),
      color: validToken(frame.color, 'continuityFrame.color'),
      audio: validToken(frame.audio, 'continuityFrame.audio'),
      argument: validToken(frame.argument, 'continuityFrame.argument'),
      justifiedChanges,
      evidenceRefs,
    })
  }).toSorted((left, right) => left.atMs - right.atMs || left.id.localeCompare(right.id))
  const issues = sorted.slice(1).flatMap((frame, index) => {
    const previous = sorted[index]
    return (Object.keys(CONTINUITY_FIELDS) as ContinuityDimension[]).flatMap((dimension) => {
      const field = CONTINUITY_FIELDS[dimension]
      if (frame[field] === previous[field] || frame.justifiedChanges.includes(dimension)) return []
      return [issue({ code: `CONTINUITY_${dimension.toUpperCase().replace('-', '_')}`, dimension: 'continuity', severity: 'review', subjectIds: [previous.id, frame.id], fromMs: previous.atMs, toMs: frame.atMs, detail: `${dimension} changes without an evidence-bound continuity justification.` })]
    })
  })
  return Object.freeze({ frames: Object.freeze(sorted), issues: Object.freeze(issues) })
}

export function evaluateEditorialGrammar(input: EditorialGrammarEvaluationInput) {
  if (input.policyVersion !== EDITORIAL_GRAMMAR_POLICY.version || !ENERGY[input.objective]) {
    throw new DomainError('INVALID_ARGUMENT', 'Editorial grammar policy or objective is unsupported')
  }
  const durationMs = integer(input.durationMs, 1_000, 3_600_000, 'durationMs')
  const windows = canonicalSemanticWindows(input.semanticWindows, durationMs)
  if (!runtimeArray(input.brollRequests) || input.brollRequests.length > 128) throw new DomainError('INVALID_ARGUMENT', 'B-roll requests are not bounded')
  const requestIds = new Set<string>()
  const broll = input.brollRequests.map((raw) => {
    const request = Object.freeze({
      ...raw,
      id: validId(raw.id, 'brollRequest.id'),
      windowId: validId(raw.windowId, 'brollRequest.windowId'),
      entryCue: Object.freeze({ ...raw.entryCue, evidenceRef: validRef(raw.entryCue.evidenceRef, 'brollRequest.entryCue.evidenceRef') }),
    })
    if (requestIds.has(request.id)) throw new DomainError('INVALID_ARGUMENT', 'B-roll request IDs must be unique')
    requestIds.add(request.id)
    if (!['semantic-boundary', 'post-setup-pause', 'gaze-change', 'keyword', 'technical-cover'].includes(request.entryCue.kind)) throw new DomainError('INVALID_ARGUMENT', 'B-roll entry cue is invalid')
    const window = windows.find((candidate) => candidate.id === request.windowId)
    if (!window) throw new DomainError('INVALID_ARGUMENT', 'B-roll request references an unknown semantic window')
    const placement = inspectBrollPlacement(window, request)
    return placement.accepted
      ? Object.freeze({ requestId: request.id, status: 'placed' as const, placement })
      : Object.freeze({ requestId: request.id, status: 'rejected' as const, issue: issue({ code: placement.code, dimension: 'b-roll', severity: 'block', subjectIds: [request.id, window.id], fromMs: placement.fromMs, toMs: placement.toMs, detail: 'B-roll placement violates semantic, obstruction or duration policy.' }) })
  }).toSorted((left, right) => left.requestId.localeCompare(right.requestId))
  const motion = inspectCameraMotions(input.motions, durationMs)
  const energy = energyCurve({ acts: input.acts, objective: input.objective, durationMs })
  const pattern = validatePatternBreakBudget(input.patternBreaks, { objective: input.objective, durationMs })
  const continuity = validateContinuity(input.continuityFrames, durationMs)
  const issues = Object.freeze([
    ...broll.flatMap((item) => item.status === 'rejected' ? [item.issue] : []),
    ...motion.issues,
    ...pattern.issues,
    ...continuity.issues,
  ].toSorted((left, right) => left.fromMs - right.fromMs || left.code.localeCompare(right.code)))
  const body = Object.freeze({
    schemaVersion: 'editorial-grammar-evaluation/v1' as const,
    policyVersion: EDITORIAL_GRAMMAR_POLICY.version,
    objective: input.objective,
    durationMs,
    valid: issues.length === 0,
    distribution: pattern.distribution,
    broll: Object.freeze(broll),
    motions: motion.motions,
    energyCurve: energy,
    patternBreakBudget: Object.freeze({ policy: pattern.policy, items: pattern.items }),
    continuityFrames: continuity.frames,
    issues,
  })
  return Object.freeze({ ...body, evaluationHash: calculateCanonicalHash(body) })
}

const baseGolden = Object.freeze({
  policyVersion: EDITORIAL_GRAMMAR_POLICY.version,
  objective: 'awareness' as const,
  durationMs: 30_000,
  semanticWindows: Object.freeze([{ id: 'window-main', startMs: 0, endMs: 30_000, conclusionMs: 18_000, obstructedRanges: Object.freeze([Object.freeze([8_000, 9_000] as const)]) }]),
  brollRequests: Object.freeze([{ id: 'broll-proof', windowId: 'window-main', entryCue: Object.freeze({ kind: 'keyword' as const, atMs: 12_000, evidenceRef: 'word-proof-12' }), desiredDurationMs: 6_000 }]),
  motions: Object.freeze([] as CameraMotion[]),
  acts: Object.freeze([{ id: 'act-hook', role: 'hook' as const, startMs: 0, endMs: 5_000 }, { id: 'act-body', role: 'body' as const, startMs: 5_000, endMs: 20_000 }, { id: 'act-proof', role: 'proof' as const, startMs: 20_000, endMs: 27_000 }, { id: 'act-cta', role: 'cta' as const, startMs: 27_000, endMs: 30_000 }]),
  continuityFrames: Object.freeze([{ id: 'frame-a', atMs: 0, eyeLine: 'camera-left', movement: 'still-frame', position: 'center-frame', color: 'neutral-5600k', audio: 'room-tone-a', argument: 'argument-main', justifiedChanges: Object.freeze([]), evidenceRefs: Object.freeze([]) }, { id: 'frame-b', atMs: 15_000, eyeLine: 'camera-left', movement: 'still-frame', position: 'center-frame', color: 'neutral-5600k', audio: 'room-tone-a', argument: 'argument-main', justifiedChanges: Object.freeze([]), evidenceRefs: Object.freeze([]) }]),
})

export const EDITORIAL_TIMELINE_GOLDENS = Object.freeze({
  excessive: Object.freeze({ ...baseGolden, patternBreaks: Object.freeze([
    { id: 'break-01', atMs: 1_000, type: 'zoom' as const, semanticGroup: 'hook-group', reason: 'Emphasize opening claim' },
    { id: 'break-02', atMs: 3_000, type: 'zoom' as const, semanticGroup: 'hook-group', reason: 'Repeat opening emphasis' },
    { id: 'break-03', atMs: 5_000, type: 'zoom' as const, semanticGroup: 'hook-group', reason: 'Third opening emphasis' },
    { id: 'break-04', atMs: 7_000, type: 'insert' as const, semanticGroup: 'body-group', reason: 'Show contextual insert' },
    { id: 'break-05', atMs: 9_000, type: 'cutaway' as const, semanticGroup: 'proof-group', reason: 'Show evidence cutaway' },
  ]) }),
  scarce: Object.freeze({ ...baseGolden, patternBreaks: Object.freeze([
    { id: 'break-01', atMs: 12_000, type: 'insert' as const, semanticGroup: 'body-group', reason: 'Show one contextual insert' },
  ]) }),
  adequate: Object.freeze({ ...baseGolden, patternBreaks: Object.freeze([
    { id: 'break-01', atMs: 2_000, type: 'insert' as const, semanticGroup: 'hook-group', reason: 'Show opening context' },
    { id: 'break-02', atMs: 13_000, type: 'zoom' as const, semanticGroup: 'body-group', reason: 'Emphasize body conclusion' },
    { id: 'break-03', atMs: 24_000, type: 'cutaway' as const, semanticGroup: 'proof-group', reason: 'Show proof evidence' },
  ]) }),
} satisfies Record<'excessive' | 'scarce' | 'adequate', EditorialGrammarEvaluationInput>)
