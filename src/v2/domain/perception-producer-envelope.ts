import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA = /^[a-f0-9]{64}$/
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/

export type PerceptionProducerEnvelopeInput = Readonly<{
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  operationId: string
  operationAttempt: number
  operationFenceHash: string
  sourceArtifactId: string
  sourceSha256: string
  editPlanSnapshotId: string
  editPlanSnapshotHash: string
  timelineDurationFrames: number
  timeMap: readonly Readonly<{
    clipId: string
    sourceInFrame: number
    sourceOutFrame: number
    timelineInFrame: number
    timelineOutFrame: number
    rate: number
  }>[]
  sourceTimebase: Readonly<{ num: number; den: number }>
  sourceFps: Readonly<{ num: number; den: number }>
  timelineFps: Readonly<{ num: number; den: number }>
  sourcePtsStart: number
  sourcePtsRounding: 'nearest'
  sourceClock: 'constant-frame-rate'
  modality: 'ocr'
  producer: Readonly<{
    name: 'tesseract'
    ffmpegSha256: string
    ffprobeSha256: string
    executableSha256: string
    executableVersion: string
    traineddata: readonly Readonly<{ language: string; sha256: string; licenseSha256: string }>[]
  }>
  samplePolicy: Readonly<{ strategy: 'fixed-interval'; intervalFrames: number; maxSamples: number }>
  samples: readonly Readonly<{
    sourcePts: number
    sourcePtsEvidenceHash: string
    sourceFrame: number
    timelineFrame: number
    imageSha256: string
    ocr: readonly Readonly<{
      text: string
      language: string
      box: readonly [number, number, number, number]
      confidence: number
    }>[]
  }>[]
  gaps: readonly Readonly<{ startTimelineFrame: number; endTimelineFrame: number; reasonCode: string }>[]
  createdAt: string
}>

export type PerceptionProducerEnvelope = Readonly<PerceptionProducerEnvelopeInput & {
  schemaVersion: 'perception-producer-envelope/v1'
  authority: 'server-produced'
  faceSafety: 'unknown'
  timeMapHash: string
  envelopeHash: string
}>

function validFrame(value: number) { return Number.isSafeInteger(value) && value >= 0 }
function invalid(message: string): never { throw new DomainError('INVALID_ARGUMENT', message) }
function exactKeys(value: object, keys: readonly string[], label: string) {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) invalid(`${label} has unsupported or missing fields`)
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/** This OCR slice supports one source that covers the entire timeline; other layouts fail closed. */
export function createPerceptionProducerEnvelope(input: PerceptionProducerEnvelopeInput): PerceptionProducerEnvelope {
  exactKeys(input, [
    'id', 'workspaceId', 'projectId', 'projectVersionId', 'operationId', 'operationAttempt',
    'operationFenceHash', 'sourceArtifactId', 'sourceSha256', 'editPlanSnapshotId',
    'editPlanSnapshotHash', 'timelineDurationFrames', 'timeMap', 'sourceTimebase',
    'sourceFps', 'timelineFps', 'sourcePtsStart', 'sourcePtsRounding', 'sourceClock', 'modality', 'producer',
    'samplePolicy', 'samples', 'gaps', 'createdAt',
  ], 'Envelope')
  for (const [name, value] of Object.entries({
    id: input.id, workspaceId: input.workspaceId, projectId: input.projectId,
    projectVersionId: input.projectVersionId, operationId: input.operationId,
    sourceArtifactId: input.sourceArtifactId, editPlanSnapshotId: input.editPlanSnapshotId,
  })) if (!ID.test(value)) invalid(`${name} is invalid`)
  for (const [name, value] of Object.entries({
    operationFenceHash: input.operationFenceHash, sourceSha256: input.sourceSha256,
    editPlanSnapshotHash: input.editPlanSnapshotHash, executableSha256: input.producer.executableSha256,
    ffmpegSha256: input.producer.ffmpegSha256, ffprobeSha256: input.producer.ffprobeSha256,
  })) if (!SHA.test(value)) invalid(`${name} must be SHA-256`)
  if (!Number.isSafeInteger(input.operationAttempt) || input.operationAttempt < 1 ||
      !validFrame(input.sourceTimebase.num) || input.sourceTimebase.num === 0 ||
      !validFrame(input.sourceTimebase.den) || input.sourceTimebase.den === 0 ||
      !validFrame(input.sourceFps.num) || input.sourceFps.num === 0 ||
      !validFrame(input.sourceFps.den) || input.sourceFps.den === 0 ||
      !validFrame(input.timelineFps.num) || input.timelineFps.num === 0 ||
      !validFrame(input.timelineFps.den) || input.timelineFps.den === 0 ||
      !validFrame(input.sourcePtsStart) || !validFrame(input.timelineDurationFrames) ||
      input.timelineDurationFrames === 0 || input.sourceClock !== 'constant-frame-rate' ||
      input.sourcePtsRounding !== 'nearest' ||
      input.modality !== 'ocr' || input.producer.name !== 'tesseract' ||
      !input.producer.executableVersion.trim() || !Number.isFinite(Date.parse(input.createdAt))) {
    invalid('Perception producer context is invalid')
  }
  exactKeys(input.sourceTimebase, ['num', 'den'], 'Source timebase')
  exactKeys(input.sourceFps, ['num', 'den'], 'Source fps')
  exactKeys(input.timelineFps, ['num', 'den'], 'Timeline fps')
  exactKeys(input.producer, ['name', 'ffmpegSha256', 'ffprobeSha256', 'executableSha256', 'executableVersion', 'traineddata'], 'Producer')
  exactKeys(input.samplePolicy, ['strategy', 'intervalFrames', 'maxSamples'], 'Sample policy')
  const sameFps = input.sourceFps.num * input.timelineFps.den === input.timelineFps.num * input.sourceFps.den
  const ticksPerFrame = input.sourceFps.den * input.sourceTimebase.den /
    (input.sourceFps.num * input.sourceTimebase.num)
  if (!Number.isSafeInteger(input.sourceFps.num * input.timelineFps.den) ||
      !Number.isSafeInteger(input.timelineFps.num * input.sourceFps.den) ||
      !sameFps || !Number.isFinite(ticksPerFrame) || ticksPerFrame < 1) {
    invalid('Only equal-fps CFR source and timeline with frame-resolvable PTS ticks are supported')
  }
  if (!input.producer.traineddata.length || input.producer.traineddata.some((item) =>
    (exactKeys(item, ['language', 'sha256', 'licenseSha256'], 'Traineddata'),
    !ID.test(item.language) || !SHA.test(item.sha256) || !SHA.test(item.licenseSha256))) ||
    new Set(input.producer.traineddata.map((item) => item.language)).size !== input.producer.traineddata.length) {
    invalid('OCR traineddata provenance is incomplete')
  }
  if (input.samplePolicy.strategy !== 'fixed-interval' || !validFrame(input.samplePolicy.intervalFrames) ||
      input.samplePolicy.intervalFrames === 0 || !validFrame(input.samplePolicy.maxSamples) ||
      input.samplePolicy.maxSamples === 0 || input.samples.length > input.samplePolicy.maxSamples) {
    invalid('Sample policy is invalid')
  }
  if (input.timeMap.length === 0 || input.timeMap.length > 10000 || input.timeMap.some((range) =>
    (exactKeys(range, ['clipId', 'sourceInFrame', 'sourceOutFrame', 'timelineInFrame', 'timelineOutFrame', 'rate'], 'Time map range'),
    !ID.test(range.clipId) || !validFrame(range.sourceInFrame) || !validFrame(range.sourceOutFrame) ||
    !validFrame(range.timelineInFrame) || !validFrame(range.timelineOutFrame) ||
    range.sourceOutFrame <= range.sourceInFrame || range.timelineOutFrame <= range.timelineInFrame ||
    !Number.isFinite(range.rate) || range.rate <= 0 ||
    Math.round((range.sourceOutFrame - range.sourceInFrame) / range.rate) !==
      range.timelineOutFrame - range.timelineInFrame))) invalid('Source-to-timeline map is invalid')
  const sortedMap = [...input.timeMap].sort((left, right) => left.timelineInFrame - right.timelineInFrame)
  if (sortedMap.some((range, index) => range !== input.timeMap[index]) ||
      sortedMap[0]!.timelineInFrame !== 0 || sortedMap.at(-1)!.timelineOutFrame !== input.timelineDurationFrames ||
      sortedMap.some((range, index) => index > 0 && range.timelineInFrame !== sortedMap[index - 1]!.timelineOutFrame)) {
    invalid('Source-to-timeline map must cover the complete timeline without overlap')
  }
  if (input.samples.length > input.samplePolicy.maxSamples || input.samples.some((sample) =>
    (exactKeys(sample, ['sourcePts', 'sourcePtsEvidenceHash', 'sourceFrame', 'timelineFrame', 'imageSha256', 'ocr'], 'Sample'),
    !validFrame(sample.sourcePts) || !validFrame(sample.sourceFrame) || !validFrame(sample.timelineFrame) ||
    sample.timelineFrame >= input.timelineDurationFrames ||
    sample.sourceFrame % input.samplePolicy.intervalFrames !== 0 ||
    !SHA.test(sample.sourcePtsEvidenceHash) ||
    Math.abs(sample.sourcePts - (input.sourcePtsStart + sample.sourceFrame * ticksPerFrame)) > 1 ||
    !SHA.test(sample.imageSha256) || sample.ocr.length > 1000 || sample.ocr.some((region) =>
      (exactKeys(region, ['text', 'language', 'box', 'confidence'], 'OCR region'),
      !region.text.trim() || region.text.length > 500 || !ID.test(region.language) ||
      region.box.length !== 4 || region.box.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
      region.box[2] <= 0 || region.box[3] <= 0 ||
      region.box[0] + region.box[2] > 1 || region.box[1] + region.box[3] > 1 ||
      !Number.isFinite(region.confidence) || region.confidence < 0 || region.confidence > 1))))) {
    invalid('Sample or OCR coordinates are invalid')
  }
  if (input.samples.some((sample) => !input.timeMap.some((range) =>
    sample.sourceFrame >= range.sourceInFrame && sample.sourceFrame < range.sourceOutFrame &&
    sample.timelineFrame >= range.timelineInFrame && sample.timelineFrame < range.timelineOutFrame &&
    sample.timelineFrame === range.timelineInFrame + Math.round((sample.sourceFrame - range.sourceInFrame) / range.rate)))) {
    invalid('Sample does not match the sealed source-to-timeline map')
  }
  if (new Set(input.samples.map((sample) => sample.timelineFrame)).size !== input.samples.length ||
      input.samples.some((sample, index) => index > 0 && sample.timelineFrame <= input.samples[index - 1]!.timelineFrame) ||
      input.gaps.length > input.samples.length + 1 ||
      input.gaps.some((gap) => (exactKeys(gap, ['startTimelineFrame', 'endTimelineFrame', 'reasonCode'], 'Coverage gap'),
        !validFrame(gap.startTimelineFrame) || !validFrame(gap.endTimelineFrame) ||
        gap.endTimelineFrame <= gap.startTimelineFrame || !CODE.test(gap.reasonCode))) ||
      input.samples.some((sample) => input.gaps.some((gap) =>
        sample.timelineFrame >= gap.startTimelineFrame && sample.timelineFrame < gap.endTimelineFrame))) {
    invalid('Sample frames or coverage gaps are invalid')
  }
  const covered = [...input.samples.map((sample) => [sample.timelineFrame, sample.timelineFrame + 1] as const),
    ...input.gaps.map((gap) => [gap.startTimelineFrame, gap.endTimelineFrame] as const)]
    .sort((left, right) => left[0] - right[0])
  if (covered[0]?.[0] !== 0 || covered.at(-1)?.[1] !== input.timelineDurationFrames ||
      covered.some((range, index) => index > 0 && range[0] !== covered[index - 1]![1])) {
    invalid('Coverage gaps must complement every unsampled timeline frame')
  }
  const timeMapHash = calculateCanonicalHash(input.timeMap)
  const content = deepFreeze({
    ...JSON.parse(stableSerialize(input)) as PerceptionProducerEnvelopeInput,
    schemaVersion: 'perception-producer-envelope/v1' as const,
    authority: 'server-produced' as const,
    faceSafety: 'unknown' as const,
    timeMapHash,
  })
  return deepFreeze({ ...content, envelopeHash: calculateCanonicalHash(content) })
}
