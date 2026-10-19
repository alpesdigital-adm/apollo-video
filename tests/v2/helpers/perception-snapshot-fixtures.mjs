import { createHash } from 'node:crypto'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { createPerceptionProducerEnvelope } = await import('../../../src/v2/domain/perception-producer-envelope.ts')
const { createTemporalProducerEnvelope } = await import('../../../src/v2/domain/temporal-producer-envelope.ts')
const { calculateCanonicalHash } = await import('../../../src/v2/domain/canonical-hash.ts')

/**
 * W63a fixtures: sealed OCR and temporal envelopes built through the product's own constructors, for a 30 fps timeline.
 * They are about a stand-in source only in what they LOOK at: every envelope is sealed, hashed and re-derivable exactly as
 * the real producers' are (the constructors verify it), so a tampered copy is detected by the same rules.
 */
export const digest = (value) => createHash('sha256').update(String(value)).digest('hex')
export const sha = (digit) => digit.repeat(64)

export const FPS = Object.freeze({ num: 30, den: 1 })
export const TIMEBASE = Object.freeze({ num: 1, den: 15360 })
export const TICKS_PER_FRAME = 512

/** The clips of one source played whole: a single unit-rate clip. */
export const wholeClips = (sourceArtifactId = 'source-1', frames = 150) => [{
  id: 'clip-1', sourceArtifactId, sourceInFrame: 0, sourceOutFrame: frames, timelineInFrame: 0, timelineOutFrame: frames, rate: 1,
}]
/** The same source cut: source frames [30,60) then [90,150) play back to back on a 90-frame timeline. */
export const cutClips = (sourceArtifactId = 'source-1') => [
  { id: 'clip-a', sourceArtifactId, sourceInFrame: 30, sourceOutFrame: 60, timelineInFrame: 0, timelineOutFrame: 30, rate: 1 },
  { id: 'clip-b', sourceArtifactId, sourceInFrame: 90, sourceOutFrame: 150, timelineInFrame: 30, timelineOutFrame: 90, rate: 1 },
]

export const durationOf = (clips) => Math.max(...clips.map((clip) => clip.timelineOutFrame))

/** The base of every assembly: ids, EditPlan clock and clips, and the bytes hash the database holds for the source. */
export function assemblyBase({ clips = wholeClips(), sourceSha256 = sha('b'), snapshotHash = sha('c'), fps = 30, extra = {} } = {}) {
  const sourceIds = [...new Set(clips.map((clip) => clip.sourceArtifactId))]
  return {
    workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    editPlan: { snapshotId: 'snapshot-edit-1', snapshotHash, fps, durationFrames: durationOf(clips), clips },
    sources: sourceIds.map((artifactId) => ({ artifactId, sha256: sourceSha256 })),
    ...extra,
  }
}

const timeMapOf = (clips, sourceArtifactId) => clips.filter((clip) => clip.sourceArtifactId === sourceArtifactId)
  .toSorted((a, b) => a.timelineInFrame - b.timelineInFrame)
  .map((clip) => ({ clipId: clip.id, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
    timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate }))

/** A sealed OCR envelope sampling the given TIMELINE frames of a single-source timeline (interval 1, so any frame is on grid). */
export function ocrEnvelope({ clips = wholeClips(), frames = [0, 30], text = (frame) => `Texto ${frame}`, empty = false, id = 'ocr-envelope-1',
  sourceSha256 = sha('b'), confidence = 0.76, overrides = {} } = {}) {
  const sourceArtifactId = clips[0].sourceArtifactId
  const durationFrames = durationOf(clips)
  const samples = frames.toSorted((a, b) => a - b).map((timelineFrame) => {
    const clip = clips.find((candidate) => timelineFrame >= candidate.timelineInFrame && timelineFrame < candidate.timelineOutFrame)
    const sourceFrame = clip.sourceInFrame + (timelineFrame - clip.timelineInFrame)
    return { sourcePts: sourceFrame * TICKS_PER_FRAME, sourcePtsEvidenceHash: sha('9'), sourceFrame, timelineFrame,
      imageSha256: digest(`image-${timelineFrame}`),
      ocr: empty ? [] : [{ text: text(timelineFrame), language: 'por', box: [0.1, 0.75, 0.3, 0.1], confidence }] }
  })
  const gaps = []
  let cursor = 0
  for (const sample of samples) {
    if (sample.timelineFrame > cursor) gaps.push({ startTimelineFrame: cursor, endTimelineFrame: sample.timelineFrame, reasonCode: 'NOT_SAMPLED' })
    cursor = sample.timelineFrame + 1
  }
  if (cursor < durationFrames) gaps.push({ startTimelineFrame: cursor, endTimelineFrame: durationFrames, reasonCode: 'NOT_SAMPLED' })
  return createPerceptionProducerEnvelope({
    id, workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    operationId: `ocr-operation-${id}`, operationAttempt: 1, operationFenceHash: sha('1'),
    sourceArtifactId, sourceSha256, editPlanSnapshotId: 'snapshot-edit-1', editPlanSnapshotHash: sha('c'),
    timelineDurationFrames: durationFrames, timeMap: timeMapOf(clips, sourceArtifactId),
    sourceTimebase: { ...TIMEBASE }, sourceFps: { ...FPS }, timelineFps: { ...FPS }, sourcePtsStart: 0,
    sourcePtsRounding: 'nearest', sourceClock: 'constant-frame-rate', modality: 'ocr',
    producer: { name: 'tesseract', ffmpegSha256: sha('4'), ffprobeSha256: sha('5'), executableSha256: sha('6'),
      executableVersion: 'controlled-unit-fixture',
      traineddata: [{ language: 'por', sha256: sha('7'), licenseSha256: sha('8') }] },
    samplePolicy: { strategy: 'fixed-interval', intervalFrames: 1, maxSamples: Math.max(1, samples.length) },
    samples, gaps, createdAt: '2026-10-19T00:00:00.000Z', ...overrides,
  })
}

/** The raw analysis of `frames` observed source frames; `unreliableAt` are the adjacent pairs whose change score is above the gate. */
export function temporalAnalysis({ frames = 150, sourceSha256 = sha('b'), unreliableAt = [], fps = FPS, timebase = TIMEBASE } = {}) {
  const ticks = fps.den * timebase.den / (fps.num * timebase.num)
  const pairs = Array.from({ length: frames - 1 }, (_unused, index) => ({
    startSourcePts: Math.round(index * ticks), endSourcePts: Math.round((index + 1) * ticks), previousFrame: index, currentFrame: index + 1,
    previousGridSha256: digest(`grid-${index}`), currentGridSha256: digest(`grid-${index + 1}`),
    changeScore: unreliableAt.includes(index) ? 0.6 : 0.02 + (index % 7) / 100,
  }))
  const motion = pairs.filter((pair) => pair.changeScore <= 0.35).map((pair) => ({
    startSourcePts: pair.startSourcePts, endSourcePts: pair.endSourcePts, previousFrame: pair.previousFrame, currentFrame: pair.currentFrame,
    vectorPxPerSecond: { x: 1.5, y: -0.5 }, residualMeanAbsoluteLuma: 0.01, ambiguity: 0.1,
  }))
  const merged = []
  for (const item of motion) {
    const last = merged.at(-1)
    if (last?.endSourcePts === item.startSourcePts) last.endSourcePts = item.endSourcePts
    else merged.push({ startSourcePts: item.startSourcePts, endSourcePts: item.endSourcePts })
  }
  return {
    algorithmVersion: 'visual-temporal-grid/v1', sourceSha256, sourceFps: { ...fps }, sourceTimebase: { ...timebase },
    sourceClock: 'constant-frame-rate', sourceWidth: 320, sourceHeight: 180, observedFrameCount: frames,
    assessedDomain: { startSourcePts: 0, endSourcePts: pairs.at(-1).endSourcePts },
    analysisGrid: { width: 160, height: 90 }, runtime: { ffmpegSha256: sha('d'), ffprobeSha256: sha('e') },
    shot: { observations: pairs, coverage: [{ startSourcePts: 0, endSourcePts: pairs.at(-1).endSourcePts }], gaps: [] },
    motion: {
      observations: motion, coverage: merged,
      gaps: pairs.filter((pair) => pair.changeScore > 0.35).map((pair) => ({
        startSourcePts: pair.startSourcePts, endSourcePts: pair.endSourcePts, reasonCode: 'UNRELIABLE_FRAME_DIFFERENCE' })),
    },
  }
}

/** A sealed temporal envelope for a single-source timeline of at most 300 frames (the producer's own bound). */
export function temporalEnvelope({ clips = wholeClips('source-1', 150), unreliableAt = [], id = 'temporal-envelope-1', sourceSha256 = sha('b'),
  overrides = {}, analysis } = {}) {
  const sourceArtifactId = clips[0].sourceArtifactId
  const observed = Math.max(...clips.map((clip) => clip.sourceOutFrame))
  return createTemporalProducerEnvelope({
    id, workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    operationId: `temporal-operation-${id}`, operationAttempt: 1, operationFenceHash: sha('2'),
    sourceArtifactId, sourceSha256, editPlanSnapshotId: 'snapshot-edit-1', editPlanSnapshotHash: sha('c'),
    timelineDurationFrames: durationOf(clips), timelineFps: { ...FPS }, timeMap: timeMapOf(clips, sourceArtifactId),
    analysis: analysis ?? temporalAnalysis({ frames: observed, sourceSha256, unreliableAt }), createdAt: '2026-10-19T00:00:00.000Z', ...overrides,
  })
}

/** The retimed transcript of a clip set: one word per `every` timeline frames, each `span` frames long. */
export function transcriptWords({ clips = wholeClips(), every = 30, span = 12 } = {}) {
  const duration = durationOf(clips)
  const words = []
  for (let frame = 0; frame + span <= duration; frame += every) {
    const clip = clips.find((candidate) => frame >= candidate.timelineInFrame && frame < candidate.timelineOutFrame)
    const sourceFrame = clip.sourceInFrame + (frame - clip.timelineInFrame)
    words.push({ text: `palavra${words.length + 1}`, sourceStartSeconds: sourceFrame / 30, sourceEndSeconds: (sourceFrame + span) / 30,
      timelineStartFrame: frame, timelineEndFrame: frame + span })
  }
  return words
}
export const transcriptRef = (overrides = {}) => ({ id: 'transcript-1', provider: 'groq', model: 'whisper-large-v3',
  transcriptHash: sha('f'), sourceArtifactId: 'source-1', ...overrides })

export { calculateCanonicalHash }
