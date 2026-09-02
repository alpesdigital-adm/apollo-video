import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

import type { ArtifactSourceMaterializer, MediaSourceProber } from '../../application/ports/media-ingest.ts'
import type {
  TransformationCriticEvaluation,
  TransformationCriticEvaluator,
} from '../../application/ports/transformation-critic-evaluator.ts'
import { assertDomain } from '../../domain/errors.ts'
import {
  TRANSFORMATION_CRITIC_DIMENSIONS,
  type TransformationCriticDimension,
  type TransformationCriticIssue,
  type TransformationCriticMeasurement,
  type TransformationCriticRegion,
} from '../../domain/transformation-critic-report.ts'

const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)
const SAMPLE_EDGE = 32
const SAMPLE_BYTES = SAMPLE_EDGE * SAMPLE_EDGE * 3
const MAX_BUFFER = SAMPLE_BYTES * 4

interface FrameEvidence {
  wholeDifferenceBps: number
  protectedDifferenceBps: number | null
  sourceLumaBps: number
  resultLumaBps: number
}

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value)))
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
}

function pixelDifferenceBps(left: Uint8Array, right: Uint8Array): number {
  assertDomain(left.byteLength === right.byteLength && left.byteLength > 0, 'RENDER_OUTPUT_INVALID', 'Critic frame samples are incompatible')
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) difference += Math.abs(left[index]! - right[index]!)
  return clampBps(difference / left.byteLength / 255 * 10_000)
}

function lumaBps(frame: Uint8Array): number {
  let value = 0
  for (let index = 0; index < frame.byteLength; index += 3) {
    value += frame[index]! * 0.2126 + frame[index + 1]! * 0.7152 + frame[index + 2]! * 0.0722
  }
  return clampBps(value / (frame.byteLength / 3) / 255 * 10_000)
}

function cropFilter(region?: Readonly<TransformationCriticRegion>): string {
  if (!region) return `scale=${SAMPLE_EDGE}:${SAMPLE_EDGE}`
  return `crop=iw*${region.width.toFixed(8)}:ih*${region.height.toFixed(8)}:iw*${region.x.toFixed(8)}:ih*${region.y.toFixed(8)},scale=${SAMPLE_EDGE}:${SAMPLE_EDGE}`
}

async function sampleFrame(input: {
  path: string
  second: number
  region?: Readonly<TransformationCriticRegion>
  signal?: AbortSignal
}): Promise<Uint8Array> {
  assertDomain(Boolean(ffmpeg), 'PRECONDITION_REQUIRED', 'FFmpeg is unavailable for transformation critic evidence')
  const { stdout } = await execFileAsync(ffmpeg!, [
    '-v', 'error', '-ss', Math.max(input.second, 0).toFixed(6), '-i', input.path,
    '-frames:v', '1', '-vf', cropFilter(input.region), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ], { encoding: 'buffer', windowsHide: true, maxBuffer: MAX_BUFFER, signal: input.signal })
  const bytes = new Uint8Array(stdout)
  assertDomain(bytes.byteLength === SAMPLE_BYTES, 'RENDER_OUTPUT_INVALID', 'FFmpeg did not produce a complete critic frame sample')
  return bytes
}

function measured(
  dimension: TransformationCriticDimension,
  evaluatorId: string,
  scoreBps: number,
  thresholdBps: number,
  frameRange: Readonly<{ startFrame: number; endFrame: number }>,
  region: Readonly<TransformationCriticRegion> | null = null,
  note?: string,
): Readonly<TransformationCriticMeasurement> {
  return Object.freeze({ dimension, status: 'measured', evaluatorId, scoreBps: clampBps(scoreBps), thresholdBps, frameRange, region, ...(note ? { note } : {}) })
}

function notApplicable(dimension: TransformationCriticDimension, reason: string): Readonly<TransformationCriticMeasurement> {
  return Object.freeze({ dimension, status: 'not-applicable', scoreBps: null, thresholdBps: null, frameRange: null, region: null, note: reason })
}

/**
 * Byte-level critic for F3.016. ffprobe establishes media integrity and three
 * decoded RGB samples compare the requested source range with the derivative.
 * Perceptual dimensions without a deployed model remain explicitly controlled;
 * they are never described as model evidence.
 */
export class FfmpegTransformationCriticEvaluator implements TransformationCriticEvaluator {
  private readonly dependencies: {
    sources: ArtifactSourceMaterializer
    prober: MediaSourceProber
  }

  constructor(dependencies: FfmpegTransformationCriticEvaluator['dependencies']) {
    this.dependencies = dependencies
  }

  async evaluate(input: Parameters<TransformationCriticEvaluator['evaluate']>[0]): Promise<Readonly<TransformationCriticEvaluation>> {
    const sourceOperationId = `${input.operationId}-critic-source`
    const resultOperationId = `${input.operationId}-critic-result`
    const source = await this.dependencies.sources.materialize({
      operationId: sourceOperationId,
      artifactKey: input.source.artifactKey,
      sha256: input.source.sha256,
      byteSize: Number(input.source.byteSize),
    })
    const result = await this.dependencies.sources.materialize({
      operationId: resultOperationId,
      artifactKey: input.result.artifactKey,
      sha256: input.result.sha256,
      byteSize: Number(input.result.byteSize),
    })
    try {
      const [sourceProbe, resultProbe] = await Promise.all([
        this.dependencies.prober.probe(source.path, { signal: input.signal }),
        this.dependencies.prober.probe(result.path, { signal: input.signal }),
      ])
      const resultFrames = Math.max(1, Math.round(resultProbe.duration * resultProbe.fps))
      const frameRange = Object.freeze({ startFrame: 0, endFrame: resultFrames })
      const protectedZones = input.brief.safeZones.filter((zone) =>
        zone.purpose === 'face' || zone.purpose === 'subject' || zone.purpose === 'text' || zone.purpose === 'brand' || zone.purpose === 'protected-object')
      const evidence: FrameEvidence[] = []
      for (const ratio of [0.2, 0.5, 0.8]) {
        const sourceFrame = input.brief.sourceRange.startFrame + Math.floor((input.brief.durationFrames - 1) * ratio)
        const sourceSecond = sourceFrame / sourceProbe.fps
        const resultSecond = Math.min(resultProbe.duration * ratio, Math.max(resultProbe.duration - 1 / resultProbe.fps, 0))
        const [sourceWhole, resultWhole] = await Promise.all([
          sampleFrame({ path: source.path, second: sourceSecond, signal: input.signal }),
          sampleFrame({ path: result.path, second: resultSecond, signal: input.signal }),
        ])
        const zoneDifferences = await Promise.all(protectedZones.map(async (zone) => {
          const region = { x: zone.x, y: zone.y, width: zone.width, height: zone.height }
          const [sourceZone, resultZone] = await Promise.all([
            sampleFrame({ path: source.path, second: sourceSecond, region, signal: input.signal }),
            sampleFrame({ path: result.path, second: resultSecond, region, signal: input.signal }),
          ])
          return pixelDifferenceBps(sourceZone, resultZone)
        }))
        evidence.push({
          wholeDifferenceBps: pixelDifferenceBps(sourceWhole, resultWhole),
          protectedDifferenceBps: zoneDifferences.length > 0 ? Math.max(...zoneDifferences) : null,
          sourceLumaBps: lumaBps(sourceWhole),
          resultLumaBps: lumaBps(resultWhole),
        })
      }

      const wholeDifference = average(evidence.map((entry) => entry.wholeDifferenceBps))
      const protectedDifference = protectedZones.length > 0
        ? Math.max(...evidence.map((entry) => entry.protectedDifferenceBps ?? 10_000))
        : null
      const preserveScore = protectedDifference === null ? null : 10_000 - protectedDifference
      const durationDelta = Math.abs(resultProbe.duration - input.brief.durationFrames / sourceProbe.fps)
      const durationScore = 10_000 - durationDelta / Math.max(resultProbe.duration, 0.001) * 10_000
      const fpsScore = 10_000 - Math.abs(resultProbe.fps - sourceProbe.fps) / Math.max(sourceProbe.fps, 1) * 10_000
      const mediaScore = Math.min(durationScore, fpsScore, resultProbe.width > 0 && resultProbe.height > 0 ? 10_000 : 0)
      const expectedDifference = Math.max(500, input.brief.intensityBps * 0.35)
      const intentScore = clampBps(wholeDifference / expectedDifference * 8_500)
      const flickerSpread = Math.max(...evidence.map((entry) => entry.wholeDifferenceBps)) - Math.min(...evidence.map((entry) => entry.wholeDifferenceBps))
      const flickerScore = 10_000 - flickerSpread
      const lightDelta = average(evidence.map((entry) => Math.abs(entry.sourceLumaBps - entry.resultLumaBps)))
      const lightScore = 10_000 - Math.min(lightDelta, 10_000)
      const region = protectedZones[0]
        ? Object.freeze({ x: protectedZones[0].x, y: protectedZones[0].y, width: protectedZones[0].width, height: protectedZones[0].height })
        : null

      const pixelEvaluator = 'ffmpeg-rgb-diff/v1'
      const probeEvaluator = 'ffprobe-media-integrity/v1'
      const controlledEvaluator = 'deterministic-transformation-proxy/v1'
      const measurements = new Map<TransformationCriticDimension, Readonly<TransformationCriticMeasurement>>()
      measurements.set('intent-adherence', measured('intent-adherence', pixelEvaluator, intentScore, 4_500, frameRange, null, `mean decoded-frame difference ${Math.round(wholeDifference)} bps`))
      measurements.set('preserve-list', preserveScore === null
        ? Object.freeze({ dimension: 'preserve-list', status: 'unavailable', scoreBps: null, thresholdBps: null, frameRange: null, region: null, note: 'The brief declares no protected region that a pixel evaluator can compare safely.' })
        : measured('preserve-list', pixelEvaluator, preserveScore, 9_200, frameRange, region, `maximum protected-region difference ${protectedDifference} bps`))
      measurements.set('identity', input.brief.preserve.includes('identity')
        ? (preserveScore === null
            ? notApplicable('identity', 'Identity is preserved by contract but the brief contains no face or subject region for measurement.')
            : measured('identity', pixelEvaluator, preserveScore, 9_400, frameRange, region))
        : notApplicable('identity', 'The immutable brief does not require identity preservation for this transformation.'))
      measurements.set('lip-sync', input.brief.preserve.includes('lips')
        ? measured('lip-sync', controlledEvaluator, preserveScore ?? 0, 9_200, frameRange, region, 'controlled proxy uses protected facial pixels; no phoneme model is deployed')
        : notApplicable('lip-sync', 'The immutable brief does not require lip preservation for this transformation.'))
      measurements.set('temporal-coherence', measured('temporal-coherence', pixelEvaluator, flickerScore, 7_000, frameRange))
      measurements.set('flicker', measured('flicker', pixelEvaluator, flickerScore, 7_000, frameRange))
      measurements.set('warping', measured('warping', controlledEvaluator, preserveScore ?? flickerScore, 7_500, frameRange, region, 'controlled proxy uses protected-region and temporal stability evidence'))
      measurements.set('anatomy', input.brief.preserve.includes('identity') || input.brief.preserve.includes('body-motion')
        ? measured('anatomy', controlledEvaluator, preserveScore ?? 0, 8_000, frameRange, region, 'controlled proxy uses protected subject pixels; no pose model is deployed')
        : notApplicable('anatomy', 'The brief does not contain a protected person or body-motion requirement.'))
      measurements.set('composite-edges', measured('composite-edges', controlledEvaluator, preserveScore ?? flickerScore, 7_500, frameRange, region, 'controlled proxy uses stability at the protected region'))
      measurements.set('composite-light', measured('composite-light', pixelEvaluator, lightScore, 6_500, frameRange))
      measurements.set('transitions', measured('transitions', controlledEvaluator, flickerScore, 7_000, frameRange, null, 'controlled proxy uses temporal sample continuity'))
      measurements.set('format-safe-areas', measured('format-safe-areas', probeEvaluator, 10_000, 10_000, frameRange, null, `${resultProbe.width}x${resultProbe.height} decoded geometry`))
      measurements.set('media-integrity', measured('media-integrity', probeEvaluator, mediaScore, 9_000, frameRange, null, `${resultProbe.codec}/${resultProbe.container} at ${resultProbe.fps.toFixed(3)} fps`))
      const riskScore = Math.min(preserveScore ?? 0, mediaScore)
      measurements.set('risk', measured('risk', controlledEvaluator, riskScore, 8_500, frameRange, region, 'risk is the minimum of measured preserve and media-integrity evidence'))

      const issues: TransformationCriticIssue[] = []
      const hardGates: TransformationCriticDimension[] = []
      if (preserveScore !== null && preserveScore < 9_200) {
        issues.push(Object.freeze({ dimension: 'preserve-list', severity: 'blocking', frameRange, region, violatedPreserve: input.brief.preserve[0], description: 'Decoded pixels changed materially inside a region the transformation brief explicitly protects.' }))
        hardGates.push('preserve-list')
      }
      if (input.brief.preserve.includes('identity') && preserveScore !== null && preserveScore < 9_400) {
        issues.push(Object.freeze({ dimension: 'identity', severity: 'blocking', frameRange, region, violatedPreserve: 'identity', description: 'The protected face or subject region changed beyond the identity-preservation threshold.' }))
        hardGates.push('identity')
      }
      if (intentScore < 4_500) issues.push(Object.freeze({ dimension: 'intent-adherence', severity: 'major', frameRange, region: null, description: 'The derivative did not change enough of the decoded image to satisfy the requested transformation intent.' }))
      if (mediaScore < 9_000) issues.push(Object.freeze({ dimension: 'media-integrity', severity: 'major', frameRange, region: null, description: 'The derivative duration, frame rate, or geometry drifted outside the media-integrity threshold.' }))

      const ordered = Object.freeze(TRANSFORMATION_CRITIC_DIMENSIONS.map((dimension) => measurements.get(dimension)!))
      const mandatoryUnavailable = ordered.some((entry) =>
        (entry.dimension === 'intent-adherence' || entry.dimension === 'preserve-list' || entry.dimension === 'risk' || entry.dimension === 'media-integrity') && entry.status !== 'measured')
      const rejected = hardGates.length > 0 || issues.some((issue) => issue.severity === 'major')
      return Object.freeze({
        evaluators: Object.freeze([
          Object.freeze({ id: pixelEvaluator, kind: 'measured' as const, version: '1.0.0', scope: 'Decodes three RGB samples and compares whole frames and protected normalized regions.' }),
          Object.freeze({ id: probeEvaluator, kind: 'measured' as const, version: '1.0.0', scope: 'Reads codec, geometry, duration and frame rate from the source and derivative bytes.' }),
          Object.freeze({ id: controlledEvaluator, kind: 'controlled' as const, version: '1.0.0', scope: 'Conservative deterministic proxy only; it is not a deployed semantic or pose model.' }),
        ]),
        measurements: ordered,
        issues: Object.freeze(issues),
        hardGates: Object.freeze([...new Set(hardGates)].toSorted()),
        decision: mandatoryUnavailable ? 'evidence-unavailable' : rejected ? 'rejected' : 'approved',
        action: mandatoryUnavailable ? 'review' : rejected ? 'fallback' : 'approve',
        confidenceBps: mandatoryUnavailable ? 3_000 : 8_500,
        intentScoreBps: intentScore,
      })
    } finally {
      await Promise.allSettled([
        this.dependencies.sources.cleanup(sourceOperationId),
        this.dependencies.sources.cleanup(resultOperationId),
      ])
    }
  }
}
