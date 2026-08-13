import { DomainError } from '../domain/errors.ts'
import {
  EDITORIAL_GRAMMAR_POLICY,
  type BrollRequest,
  type CameraMotion,
  type ContinuityDimension,
  type ContinuityFrame,
  type EditorialAct,
  type EditorialGrammarEvaluationInput,
  type EditorialObjective,
  type PatternBreak,
  type SemanticWindow,
} from '../domain/editorial-grammar.ts'

function record(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  const parsed = value as Record<string, unknown>
  if (Object.keys(parsed).some((key) => !keys.includes(key))) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains an unsupported field`)
  }
  return parsed
}

function array(value: unknown, field: string, minimum: number, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a bounded array`)
  }
  return value
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 256) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be bounded text`)
  }
  return value.trim()
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be an integer`)
  return value as number
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new DomainError('INVALID_ARGUMENT', `${field} must be finite`)
  return value
}

function member<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is unsupported`)
  }
  return value as T
}

function semanticWindow(value: unknown, index: number): SemanticWindow {
  const field = `semanticWindows[${index}]`
  const item = record(value, field, ['id', 'startMs', 'endMs', 'conclusionMs', 'obstructedRanges'])
  return {
    id: text(item.id, `${field}.id`),
    startMs: integer(item.startMs, `${field}.startMs`),
    endMs: integer(item.endMs, `${field}.endMs`),
    conclusionMs: integer(item.conclusionMs, `${field}.conclusionMs`),
    obstructedRanges: array(item.obstructedRanges, `${field}.obstructedRanges`, 0, 32).map((raw, rangeIndex) => {
      if (!Array.isArray(raw) || raw.length !== 2) throw new DomainError('INVALID_ARGUMENT', `${field}.obstructedRanges[${rangeIndex}] is invalid`)
      return [integer(raw[0], `${field}.obstructedRanges[${rangeIndex}][0]`), integer(raw[1], `${field}.obstructedRanges[${rangeIndex}][1]`)] as const
    }),
  }
}

function brollRequest(value: unknown, index: number): BrollRequest {
  const field = `brollRequests[${index}]`
  const item = record(value, field, ['id', 'windowId', 'entryCue', 'desiredDurationMs'])
  const cue = record(item.entryCue, `${field}.entryCue`, ['kind', 'atMs', 'evidenceRef'])
  return {
    id: text(item.id, `${field}.id`), windowId: text(item.windowId, `${field}.windowId`),
    entryCue: {
      kind: member(cue.kind, `${field}.entryCue.kind`, ['semantic-boundary', 'post-setup-pause', 'gaze-change', 'keyword', 'technical-cover']),
      atMs: integer(cue.atMs, `${field}.entryCue.atMs`),
      evidenceRef: text(cue.evidenceRef, `${field}.entryCue.evidenceRef`),
    },
    desiredDurationMs: integer(item.desiredDurationMs, `${field}.desiredDurationMs`),
  }
}

function motion(value: unknown, index: number): CameraMotion {
  const field = `motions[${index}]`
  const item = record(value, field, ['id', 'kind', 'reason', 'evidenceRef', 'startMs', 'endMs', 'amplitude', 'velocity', 'cooldownMs'])
  return {
    id: text(item.id, `${field}.id`), kind: member(item.kind, `${field}.kind`, ['zoom', 'pan', 'tilt']),
    reason: text(item.reason, `${field}.reason`), evidenceRef: text(item.evidenceRef, `${field}.evidenceRef`),
    startMs: integer(item.startMs, `${field}.startMs`), endMs: integer(item.endMs, `${field}.endMs`),
    amplitude: number(item.amplitude, `${field}.amplitude`), velocity: number(item.velocity, `${field}.velocity`),
    cooldownMs: integer(item.cooldownMs, `${field}.cooldownMs`),
  }
}

function act(value: unknown, index: number): EditorialAct {
  const field = `acts[${index}]`
  const item = record(value, field, ['id', 'role', 'startMs', 'endMs'])
  return {
    id: text(item.id, `${field}.id`), role: member(item.role, `${field}.role`, ['hook', 'body', 'proof', 'cta']),
    startMs: integer(item.startMs, `${field}.startMs`), endMs: integer(item.endMs, `${field}.endMs`),
  }
}

function patternBreak(value: unknown, index: number): PatternBreak {
  const field = `patternBreaks[${index}]`
  const item = record(value, field, ['id', 'atMs', 'type', 'semanticGroup', 'reason'])
  return {
    id: text(item.id, `${field}.id`), atMs: integer(item.atMs, `${field}.atMs`),
    type: member(item.type, `${field}.type`, ['zoom', 'insert', 'cutaway', 'layout-change']),
    semanticGroup: text(item.semanticGroup, `${field}.semanticGroup`), reason: text(item.reason, `${field}.reason`),
  }
}

function continuityFrame(value: unknown, index: number): ContinuityFrame {
  const field = `continuityFrames[${index}]`
  const item = record(value, field, ['id', 'atMs', 'eyeLine', 'movement', 'position', 'color', 'audio', 'argument', 'justifiedChanges', 'evidenceRefs'])
  return {
    id: text(item.id, `${field}.id`), atMs: integer(item.atMs, `${field}.atMs`),
    eyeLine: text(item.eyeLine, `${field}.eyeLine`), movement: text(item.movement, `${field}.movement`),
    position: text(item.position, `${field}.position`), color: text(item.color, `${field}.color`),
    audio: text(item.audio, `${field}.audio`), argument: text(item.argument, `${field}.argument`),
    justifiedChanges: array(item.justifiedChanges, `${field}.justifiedChanges`, 0, 6).map((dimension, dimensionIndex) => member(dimension, `${field}.justifiedChanges[${dimensionIndex}]`, ['eye-line', 'movement', 'position', 'color', 'audio', 'argument'])) as readonly ContinuityDimension[],
    evidenceRefs: array(item.evidenceRefs, `${field}.evidenceRefs`, 0, 32).map((ref, refIndex) => text(ref, `${field}.evidenceRefs[${refIndex}]`)),
  }
}

export function parseEditorialGrammarEvaluationBody(value: unknown): EditorialGrammarEvaluationInput {
  const body = record(value, 'body', ['policyVersion', 'objective', 'durationMs', 'semanticWindows', 'brollRequests', 'motions', 'acts', 'patternBreaks', 'continuityFrames'])
  return {
    policyVersion: member(body.policyVersion, 'body.policyVersion', [EDITORIAL_GRAMMAR_POLICY.version]),
    objective: member(body.objective, 'body.objective', ['awareness', 'conversion']) as EditorialObjective,
    durationMs: integer(body.durationMs, 'body.durationMs'),
    semanticWindows: array(body.semanticWindows, 'body.semanticWindows', 1, 128).map(semanticWindow),
    brollRequests: array(body.brollRequests, 'body.brollRequests', 0, 128).map(brollRequest),
    motions: array(body.motions, 'body.motions', 0, 128).map(motion),
    acts: array(body.acts, 'body.acts', 1, 32).map(act),
    patternBreaks: array(body.patternBreaks, 'body.patternBreaks', 0, 512).map(patternBreak),
    continuityFrames: array(body.continuityFrames, 'body.continuityFrames', 1, 512).map(continuityFrame),
  }
}
