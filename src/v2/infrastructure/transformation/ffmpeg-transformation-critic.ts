import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { ArtifactSourceMaterializer, MediaSourceProber } from '../../application/ports/media-ingest.ts'
import type {
  TransformationCriticEvaluation,
  TransformationCriticEvaluator,
} from '../../application/ports/transformation-critic-evaluator.ts'
import type { TransformationAudioPreservationEvaluator } from '../../application/ports/transformation-critic-evaluator.ts'
import { assertDomain } from '../../domain/errors.ts'
import {
  TRANSFORMATION_CRITIC_DIMENSIONS,
  type TransformationCriticDimension,
  type TransformationCriticIssue,
  type TransformationCriticMeasurement,
  type TransformationCriticRegion,
} from '../../domain/transformation-critic-report.ts'
import { resolveFfmpegBinary } from '../media/ffmpeg-binary.ts'

const execFileAsync = promisify(execFile)
const SAMPLE_EDGE = 32
const SAMPLE_BYTES = SAMPLE_EDGE * SAMPLE_EDGE * 3
const MAX_BUFFER = SAMPLE_BYTES * 4

interface FrameEvidence {
  wholeDifferenceBps: number
  changeDifferenceBps: number | null
  protectedDifferenceBps: number | null
  zoneDifferences: readonly Readonly<{ purpose: string; differenceBps: number }>[]
  sourceLumaBps: number
  resultLumaBps: number
}

async function waitForAll<T extends readonly unknown[]>(promises: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const settled = await Promise.allSettled(promises)
  const failed = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
  if (failed) throw failed.reason
  return settled.map((entry) => (entry as PromiseFulfilledResult<unknown>).value) as unknown as T
}

function purposesForPreserve(item: string): readonly string[] {
  if (item === 'identity' || item === 'lips' || item === 'expression') return ['face', 'subject']
  if (item === 'body-motion' || item === 'wardrobe' || item === 'foreground') return ['subject']
  if (item === 'objects') return ['protected-object']
  if (item === 'text') return ['text']
  if (item === 'brand') return ['brand']
  return []
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
  const { stdout } = await execFileAsync(resolveFfmpegBinary(), [
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

export function combineTransformationPreservationScores(input: Readonly<{
  audioRequired: boolean
  visualPreservationRequired: boolean
  visualScore: number | null
  audioPassed: boolean | null
}>): number | null {
  if (input.audioRequired && input.audioPassed === null) return null
  if (input.visualPreservationRequired && input.visualScore === null) return null
  const audioScore = input.audioRequired ? (input.audioPassed ? 10_000 : 0) : 10_000
  return input.visualScore === null ? audioScore : Math.min(input.visualScore, audioScore)
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
    audioComparison?: TransformationAudioPreservationEvaluator
  }

  constructor(dependencies: FfmpegTransformationCriticEvaluator['dependencies']) {
    this.dependencies = dependencies
  }

  async evaluate(input: Parameters<TransformationCriticEvaluator['evaluate']>[0]): Promise<Readonly<TransformationCriticEvaluation>> {
    const sourceOperationId = `${input.operationId}-critic-source`
    const resultOperationId = `${input.operationId}-critic-result`
    let operationFailed = false
    try {
      const [source, result] = await waitForAll([
        this.dependencies.sources.materialize({ operationId: sourceOperationId, artifactKey: input.source.artifactKey, sha256: input.source.sha256, byteSize: Number(input.source.byteSize), signal: input.signal }),
        this.dependencies.sources.materialize({ operationId: resultOperationId, artifactKey: input.result.artifactKey, sha256: input.result.sha256, byteSize: Number(input.result.byteSize), signal: input.signal }),
      ] as const)
      const [sourceProbe, resultProbe] = await waitForAll([
        this.dependencies.prober.probe(source.path, { signal: input.signal }),
        this.dependencies.prober.probe(result.path, { signal: input.signal }),
      ] as const)
      const audioRequired = input.brief.preserve.includes('audio') || input.brief.preserve.includes('speech')
      const audioComparison = audioRequired && this.dependencies.audioComparison
        ? await this.dependencies.audioComparison.compare({
            sourcePath: source.path,
            resultPath: result.path,
            sourceStartMs: Math.round(input.brief.sourceRange.startFrame / sourceProbe.fps * 1_000),
            sourceDurationMs: Math.round(input.brief.durationFrames / sourceProbe.fps * 1_000),
            signal: input.signal,
          })
        : null
      const resultFrames = Math.max(1, Math.round(resultProbe.duration * resultProbe.fps))
      const frameRange = Object.freeze({ startFrame: 0, endFrame: resultFrames })
      const protectedZones = input.brief.safeZones.filter((zone) =>
        zone.purpose === 'face' || zone.purpose === 'subject' || zone.purpose === 'text' || zone.purpose === 'brand' || zone.purpose === 'protected-object')
      const evidence: FrameEvidence[] = []
      for (const ratio of [0.2, 0.5, 0.8]) {
        const sourceFrame = input.brief.sourceRange.startFrame + Math.floor((input.brief.durationFrames - 1) * ratio)
        const sourceSecond = sourceFrame / sourceProbe.fps
        const resultSecond = Math.min(resultProbe.duration * ratio, Math.max(resultProbe.duration - 1 / resultProbe.fps, 0))
        const [sourceWhole, resultWhole] = await waitForAll([
          sampleFrame({ path: source.path, second: sourceSecond, signal: input.signal }),
          sampleFrame({ path: result.path, second: resultSecond, signal: input.signal }),
        ] as const)
        const changeDifference = input.changeRegion
          ? await waitForAll([
              sampleFrame({ path: source.path, second: sourceSecond, region: input.changeRegion, signal: input.signal }),
              sampleFrame({ path: result.path, second: resultSecond, region: input.changeRegion, signal: input.signal }),
            ] as const).then(([sourceChange, resultChange]) => pixelDifferenceBps(sourceChange, resultChange))
          : null
        const zoneDifferences = await waitForAll(protectedZones.map(async (zone) => {
          const region = { x: zone.x, y: zone.y, width: zone.width, height: zone.height }
          const [sourceZone, resultZone] = await waitForAll([
            sampleFrame({ path: source.path, second: sourceSecond, region, signal: input.signal }),
            sampleFrame({ path: result.path, second: resultSecond, region, signal: input.signal }),
          ] as const)
          return Object.freeze({ purpose: zone.purpose, differenceBps: pixelDifferenceBps(sourceZone, resultZone) })
        }))
        evidence.push({
          wholeDifferenceBps: pixelDifferenceBps(sourceWhole, resultWhole),
          changeDifferenceBps: changeDifference,
          protectedDifferenceBps: zoneDifferences.length > 0 ? Math.max(...zoneDifferences.map((entry) => entry.differenceBps)) : null,
          zoneDifferences,
          sourceLumaBps: lumaBps(sourceWhole),
          resultLumaBps: lumaBps(resultWhole),
        })
      }

      const wholeDifference = average(evidence.map((entry) => entry.wholeDifferenceBps))
      const intentDifference = input.changeRegion
        ? average(evidence.map((entry) => entry.changeDifferenceBps ?? 0))
        : wholeDifference
      const protectedDifference = protectedZones.length > 0
        ? Math.max(...evidence.map((entry) => entry.protectedDifferenceBps ?? 10_000))
        : null
      const visualPreserves = input.brief.preserve.filter((preserve) => !['audio', 'speech', 'timing'].includes(preserve))
      const visualScores = visualPreserves.map((preserve) => {
        const purposes = purposesForPreserve(preserve)
        if (purposes.length === 0 || !protectedZones.some((zone) => purposes.includes(zone.purpose))) return null
        const differences = evidence.flatMap((entry) => entry.zoneDifferences.filter((zone) => purposes.includes(zone.purpose)).map((zone) => zone.differenceBps))
        return differences.length > 0 ? 10_000 - Math.max(...differences) : null
      })
      const preserveScore = visualScores.length === 0 ? null : visualScores.every((score) => score !== null) ? Math.min(...visualScores as number[]) : null
      const visualPreservationRequired = visualPreserves.length > 0
      const combinedPreserveScore = combineTransformationPreservationScores({
        audioRequired,
        visualPreservationRequired,
        visualScore: preserveScore,
        audioPassed: audioComparison?.passed ?? null,
      })
      const durationDelta = Math.abs(resultProbe.duration - input.brief.durationFrames / sourceProbe.fps)
      const durationScore = 10_000 - durationDelta / Math.max(resultProbe.duration, 0.001) * 10_000
      const fpsScore = 10_000 - Math.abs(resultProbe.fps - sourceProbe.fps) / Math.max(sourceProbe.fps, 1) * 10_000
      const mediaScore = Math.min(durationScore, fpsScore, resultProbe.width > 0 && resultProbe.height > 0 ? 10_000 : 0)
      const expectedDifference = Math.max(500, input.brief.intensityBps * 0.35)
      const intentScore = clampBps(intentDifference / expectedDifference * 8_500)
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
      measurements.set('intent-adherence', measured(
        'intent-adherence',
        pixelEvaluator,
        intentScore,
        input.intentThresholdBps,
        frameRange,
        input.changeRegion ?? null,
        `mean decoded ${input.changeRegion ? 'reviewed-change-region' : 'whole-frame'} difference ${Math.round(intentDifference)} bps`,
      ))
      measurements.set('preserve-list', combinedPreserveScore === null
        ? Object.freeze({ dimension: 'preserve-list', status: 'unavailable', scoreBps: null, thresholdBps: null, frameRange: null, region: null, note: audioRequired && !audioComparison ? 'No decoded output-audio comparison evaluator is configured.' : 'The brief requires visual preservation but declares no protected region that a pixel evaluator can compare safely.' })
        : measured('preserve-list', audioRequired ? 'ffmpeg-pcm-preservation/v1' : pixelEvaluator, combinedPreserveScore, 9_200, frameRange, region, audioComparison ? `decoded PCM correlation ${audioComparison.correlationBps} bps; worst window ${audioComparison.worstWindowCorrelationBps} bps; failed windows ${audioComparison.failedWindowCount}/${audioComparison.comparedWindowCount}` : `maximum protected-region difference ${protectedDifference} bps`))
      const identityPurposes = purposesForPreserve('identity')
      const identityDifferences = evidence.flatMap((entry) => entry.zoneDifferences.filter((zone) => identityPurposes.includes(zone.purpose)).map((zone) => zone.differenceBps))
      const identityScore = identityDifferences.length > 0 ? 10_000 - Math.max(...identityDifferences) : null
      measurements.set('identity', input.brief.preserve.includes('identity')
        ? (identityScore === null
            ? Object.freeze({ dimension: 'identity', status: 'unavailable' as const, scoreBps: null, thresholdBps: null, frameRange: null, region: null, note: 'Identity is required but the brief contains no face or subject region that can be measured.' })
            : measured('identity', pixelEvaluator, identityScore, 9_400, frameRange, region))
        : notApplicable('identity', 'The immutable brief does not require identity preservation for this transformation.'))
      measurements.set('lip-sync', input.brief.preserve.includes('lips')
        ? (identityScore === null
            ? Object.freeze({ dimension: 'lip-sync', status: 'unavailable' as const, scoreBps: null, thresholdBps: null, frameRange: null, region: null, note: 'Lip preservation requires a face or subject region; no input alignment is treated as output evidence.' })
            : measured('lip-sync', controlledEvaluator, identityScore, 9_200, frameRange, region, 'controlled proxy uses protected facial pixels; no phoneme model is deployed'))
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
      const riskScore = Math.min(combinedPreserveScore ?? 0, mediaScore)
      measurements.set('risk', measured('risk', controlledEvaluator, riskScore, 8_500, frameRange, region, 'risk is the minimum of measured preserve and media-integrity evidence'))

      const issues: TransformationCriticIssue[] = []
      const hardGates: TransformationCriticDimension[] = []
      if (preserveScore !== null && preserveScore < 9_200) {
        issues.push(Object.freeze({ dimension: 'preserve-list', severity: 'blocking', frameRange, region, violatedPreserve: input.brief.preserve[0], description: 'Decoded pixels changed materially inside a region the transformation brief explicitly protects.' }))
        hardGates.push('preserve-list')
      }
      if (audioRequired && audioComparison && !audioComparison.passed) {
        issues.push(Object.freeze({ dimension: 'preserve-list', severity: 'blocking', frameRange, region: null, violatedPreserve: input.brief.preserve.includes('speech') ? 'speech' : 'audio', description: 'Decoded output PCM does not preserve the complete authorized source range.' }))
        hardGates.push('preserve-list')
      }
      if (input.brief.preserve.includes('identity') && identityScore !== null && identityScore < 9_400) {
        issues.push(Object.freeze({ dimension: 'identity', severity: 'blocking', frameRange, region, violatedPreserve: 'identity', description: 'The protected face or subject region changed beyond the identity-preservation threshold.' }))
        hardGates.push('identity')
      }
      if (intentScore < input.intentThresholdBps) issues.push(Object.freeze({ dimension: 'intent-adherence', severity: 'major', frameRange, region: input.changeRegion ?? null, description: 'The derivative did not change enough of the authorized decoded region to satisfy the current fallback rung.' }))
      if (mediaScore < 9_000) issues.push(Object.freeze({ dimension: 'media-integrity', severity: 'major', frameRange, region: null, description: 'The derivative duration, frame rate, or geometry drifted outside the media-integrity threshold.' }))

      const ordered = Object.freeze(TRANSFORMATION_CRITIC_DIMENSIONS.map((dimension) => measurements.get(dimension)!))
      const mandatoryUnavailable = ordered.some((entry) =>
        (entry.dimension === 'intent-adherence' || entry.dimension === 'preserve-list' || entry.dimension === 'risk' || entry.dimension === 'media-integrity') && entry.status !== 'measured')
      const rejected = hardGates.length > 0 || issues.some((issue) => issue.severity === 'major')
      return Object.freeze({
        evaluators: Object.freeze([
          Object.freeze({ id: pixelEvaluator, kind: 'measured' as const, version: '1.1.0', scope: 'Decodes three RGB samples and compares the reviewed change region, whole frame and protected normalized regions.' }),
          Object.freeze({ id: probeEvaluator, kind: 'measured' as const, version: '1.0.0', scope: 'Reads codec, geometry, duration and frame rate from the source and derivative bytes.' }),
          ...(audioComparison ? [Object.freeze({ id: 'ffmpeg-pcm-preservation/v1', kind: 'measured' as const, version: audioComparison.policyVersion, scope: 'Decodes the complete source range and output audio to mono PCM and compares global and short-window signal preservation.' })] : []),
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
    } catch (error) {
      operationFailed = true
      throw error
    } finally {
      const cleanup = await Promise.allSettled([
        this.dependencies.sources.cleanup(sourceOperationId),
        this.dependencies.sources.cleanup(resultOperationId),
      ])
      if (!operationFailed) {
        const failedCleanup = cleanup.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
        if (failedCleanup) throw failedCleanup.reason
      }
    }
  }
}
