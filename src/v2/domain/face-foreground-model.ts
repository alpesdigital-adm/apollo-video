import { calculateCanonicalHash } from './canonical-hash.ts'
import type { FaceBoxV2 } from './face-producer-envelope-v2.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256 } from './face-evidence-policy.ts'
import type { FaceEvidenceStream } from './face-evidence-stream.ts'

/**
 * Foreground relevance and speaker candidate, derived from trusted face evidence with the pinned policy.
 *
 * It is a pure, reproducible function of (evidence stream, policy): nothing is stored as authority and nothing here
 * identifies a person or hears a voice. "Speaker candidate" means the largest persistent foreground face, a visual
 * proxy the owner accepted for choosing what a caption must not cover; it does not claim who is talking.
 *
 * Tracks link consecutive detections of the same face by overlap in time order; they never carry identity across a
 * gap longer than the policy allows. A track is present in a window when it was detected in enough of the window's
 * analysed samples (enter share), and stays present until that share falls under the exit share (hysteresis).
 */
export type FaceTrackDetection = Readonly<{ timelineFrame: number; box: FaceBoxV2['boxXYXY']; confidence: number }>
export type FaceTrack = Readonly<{
  trackId: string
  firstFrame: number; lastFrame: number
  detections: number
}>
export type FaceTrackWindowState = Readonly<{
  trackId: string
  detectedSamples: number
  persistence: number
  present: boolean
  foreground: boolean
  medianHeight: number
  medianArea: number
}>
export type FaceModelPosition = Readonly<{
  timelineFrame: number
  analysedSamples: number
  unknownSamples: number
  /** Fewer analysed samples than the policy minimum: no track is called present and no speaker is chosen. */
  insufficient: boolean
  tracks: readonly FaceTrackWindowState[]
  speakerTrackId: string | null
}>
export type FaceSpeakerSegment = Readonly<{ trackId: string; startFrame: number; endFrame: number }>
export type FaceForegroundModel = Readonly<{
  schemaVersion: 'face-foreground-model/v1'
  policyId: string; policySha256: string
  streamHash: string
  basis: 'largest-persistent-foreground-face'
  tracks: readonly FaceTrack[]
  positions: readonly FaceModelPosition[]
  speakerSegments: readonly FaceSpeakerSegment[]
  modelHash: string
}>

const area = (box: FaceBoxV2['boxXYXY']) => (box[2] - box[0]) * (box[3] - box[1])
const height = (box: FaceBoxV2['boxXYXY']) => box[3] - box[1]
function iou(a: FaceBoxV2['boxXYXY'], b: FaceBoxV2['boxXYXY']): number {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0])
  const tall = Math.min(a[3], b[3]) - Math.max(a[1], b[1])
  if (width <= 0 || tall <= 0) return 0
  const intersection = width * tall
  return intersection / (area(a) + area(b) - intersection)
}
function median(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}
const frameMs = (frames: number, fps: Readonly<{ num: number; den: number }>) => frames * 1000 * fps.den / fps.num

export function deriveFaceForegroundModel(stream: FaceEvidenceStream): FaceForegroundModel {
  const policy = FACE_EVIDENCE_POLICY.evidence
  const fps = stream.timelineFps
  const samples = stream.samples
  // 1. Tracks over the whole stream, in time order, from the evidence subset only.
  type Active = { id: string; lastFrame: number; lastBox: FaceBoxV2['boxXYXY']; detections: FaceTrackDetection[] }
  const active: Active[] = []
  const finished: Active[] = []
  const detectionsBySample = new Map<number, Map<string, FaceTrackDetection>>()
  let nextTrack = 1
  for (const sample of samples) {
    if (sample.status !== 'observed') continue
    const evidence = sample.detections.filter((detection) => detection.confidence >= policy.scoreMin)
      .sort((a, b) => b.confidence - a.confidence || area(b.boxXYXY) - area(a.boxXYXY) || a.boxXYXY[0] - b.boxXYXY[0] || a.boxXYXY[1] - b.boxXYXY[1])
    const taken = new Set<string>()
    const assigned = new Map<string, FaceTrackDetection>()
    for (const detection of evidence) {
      let best: Active | null = null
      let bestIou = 0
      for (const track of active) {
        if (taken.has(track.id) || frameMs(sample.timelineFrame - track.lastFrame, fps) > policy.track.maxGapMs) continue
        const overlap = iou(track.lastBox, detection.boxXYXY)
        if (overlap >= policy.track.associationMinIou && (overlap > bestIou || (overlap === bestIou && best !== null && track.id < best.id))) {
          best = track; bestIou = overlap
        }
      }
      const entry: FaceTrackDetection = Object.freeze({ timelineFrame: sample.timelineFrame, box: detection.boxXYXY, confidence: detection.confidence })
      if (!best) {
        best = { id: `track-${nextTrack}`, lastFrame: sample.timelineFrame, lastBox: detection.boxXYXY, detections: [] }
        nextTrack += 1
        active.push(best)
      }
      best.lastFrame = sample.timelineFrame; best.lastBox = detection.boxXYXY; best.detections.push(entry)
      taken.add(best.id); assigned.set(best.id, entry)
    }
    detectionsBySample.set(sample.timelineFrame, assigned)
    // A track that can no longer be continued leaves the active set.
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (frameMs(sample.timelineFrame - active[index]!.lastFrame, fps) > policy.track.maxGapMs) finished.push(...active.splice(index, 1))
    }
  }
  const all = [...finished, ...active].sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)))

  // 2. Window statistics at every sample position, with persistence hysteresis and a sticky speaker.
  const halfWindowFrames = Math.floor((policy.aggregationWindowMs / 2) * fps.num / (1000 * fps.den))
  const presentBefore = new Set<string>()
  let speaker = null as string | null
  let challenger = null as { id: string; sinceFrame: number } | null
  const positions: FaceModelPosition[] = []
  for (const sample of samples) {
    const window = samples.filter((other) => Math.abs(other.timelineFrame - sample.timelineFrame) <= halfWindowFrames)
    const analysed = window.filter((other) => other.status === 'observed')
    const unknown = window.length - analysed.length
    const insufficient = analysed.length < policy.minAnalysedSamplesInWindow
    const states: FaceTrackWindowState[] = []
    const presentNow = new Set<string>()
    if (!insufficient) {
      for (const track of all) {
        const inWindow = analysed.map((other) => detectionsBySample.get(other.timelineFrame)?.get(track.id)).filter((value): value is FaceTrackDetection => value !== undefined)
        if (inWindow.length === 0) continue
        const persistence = inWindow.length / analysed.length
        const present = persistence >= policy.persistence.enter || (presentBefore.has(track.id) && persistence >= policy.persistence.exit)
        const medianHeight = median(inWindow.map((detection) => height(detection.box)))
        if (present) presentNow.add(track.id)
        states.push(Object.freeze({ trackId: track.id, detectedSamples: inWindow.length, persistence, present,
          foreground: medianHeight >= policy.foregroundMinHeightFraction, medianHeight,
          medianArea: median(inWindow.map((detection) => area(detection.box))) }))
      }
    }
    presentBefore.clear(); for (const id of presentNow) presentBefore.add(id)
    const eligible = states.filter((state) => state.present && state.foreground)
    const best = [...eligible].sort((a, b) => b.medianArea - a.medianArea || b.persistence - a.persistence ||
      Number(a.trackId.slice(6)) - Number(b.trackId.slice(6)))[0] ?? null
    const incumbent = speaker === null ? null : eligible.find((state) => state.trackId === speaker) ?? null
    if (!best) { speaker = null; challenger = null }
    else if (!incumbent) { speaker = best.trackId; challenger = null }
    else if (best.trackId !== incumbent.trackId && best.medianArea >= incumbent.medianArea * policy.speaker.switchAreaRatio) {
      if (challenger?.id !== best.trackId) challenger = { id: best.trackId, sinceFrame: sample.timelineFrame }
      if (frameMs(sample.timelineFrame - challenger.sinceFrame, fps) >= policy.speaker.switchHoldMs) { speaker = best.trackId; challenger = null }
    } else challenger = null
    positions.push(Object.freeze({ timelineFrame: sample.timelineFrame, analysedSamples: analysed.length, unknownSamples: unknown,
      insufficient, tracks: Object.freeze(states), speakerTrackId: speaker }))
  }
  // 3. Contiguous speaker segments: a position owns the frames up to the next position.
  const segments: FaceSpeakerSegment[] = []
  positions.forEach((position, index) => {
    if (position.speakerTrackId === null) return
    const endFrame = positions[index + 1]?.timelineFrame ?? position.timelineFrame + 1
    const last = segments.at(-1)
    if (last && last.trackId === position.speakerTrackId && last.endFrame === position.timelineFrame) {
      segments[segments.length - 1] = Object.freeze({ ...last, endFrame })
    } else segments.push(Object.freeze({ trackId: position.speakerTrackId, startFrame: position.timelineFrame, endFrame }))
  })
  const body = {
    schemaVersion: 'face-foreground-model/v1' as const,
    policyId: FACE_EVIDENCE_POLICY.id, policySha256: FACE_EVIDENCE_POLICY_SHA256,
    streamHash: stream.streamHash,
    basis: policy.speaker.basis,
    tracks: Object.freeze(all.map((track) => Object.freeze({ trackId: track.id, firstFrame: track.detections[0]!.timelineFrame,
      lastFrame: track.detections.at(-1)!.timelineFrame, detections: track.detections.length }))),
    positions: Object.freeze(positions),
    speakerSegments: Object.freeze(segments),
  }
  return Object.freeze({ ...body, modelHash: calculateCanonicalHash(body) })
}
