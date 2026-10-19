import { presentVariantReframePlan } from '../application/plan-project-reframe.ts'
import { createVariantReframeOverrideCommandImpact } from '../domain/command-impact.ts'
import { FACE_EVIDENCE_POLICY_SHA256 } from '../domain/face-evidence-policy.ts'
import type { FaceSourceEvidenceSample, FaceSourceEvidenceStream } from '../domain/face-source-evidence-stream.ts'
import { readOutputFormatPreset } from '../domain/output-format-registry.ts'
import { maximumReframeCrop } from '../domain/reframe-plan.ts'
import { createVariantReframeOverride } from '../domain/variant-reframe-overrides.ts'
import { buildVariantReframePlanRecord } from '../domain/variant-reframe-plan.ts'

/**
 * Examples of the W66r reframe contract. They come out of the real factories, not out of hand-written JSON: the published plan is a record
 * `parseVariantReframePlanRecord` accepts, the override is a document `parseVariantReframeOverride` accepts, and the impact is pinned to one
 * variant and one range by the same constructor that writes it.
 */
const workspaceId = 'workspace-example-1'
const projectId = 'project-example-1'
const variantId = 'variant-example-vertical'
const createdAt = '2026-10-19T12:00:00.000Z'
const sha = (digit: string) => digit.repeat(64)
const preset = readOutputFormatPreset('9:16')

const source = Object.freeze({ artifactId: 'artifact-example-1', manifestId: 'manifest-reframe-example', sha256: sha('a'), width: 1920, height: 1080 })
const clip = Object.freeze({
  clipId: 'clip-reframe-example-1', sourceArtifactId: source.artifactId, sourceSha256: source.sha256, sourceWidth: source.width, sourceHeight: source.height,
  sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150, rate: 1, fps: 30, hasStaticCrop: false,
})
const envelopeHash = sha('e')
const samples: FaceSourceEvidenceSample[] = []
for (let frame = 0; frame < 150; frame += 5) {
  const x = 0.42 + 0.05 * (frame / 150)
  samples.push(Object.freeze({
    sourceFrame: frame, status: 'observed' as const,
    detections: [{ boxXYXY: [x, 0.2, x + 0.1, 0.5] as [number, number, number, number], confidence: 0.96, clipped: false, classification: 'unverified-face-candidate' as const }],
    frameWidth: source.width, frameHeight: source.height, envelopeHash, imageSha256: sha('1'), rawOutputSha256: sha('2'),
  }))
}
const stream: FaceSourceEvidenceStream = Object.freeze({
  schemaVersion: 'face-source-evidence-stream/v1' as const, policySha256: FACE_EVIDENCE_POLICY_SHA256, sourceArtifactId: source.artifactId, sourceSha256: source.sha256,
  sourceFps: Object.freeze({ num: 30, den: 1 }), sourceDurationFrames: 150, samples: Object.freeze(samples),
  trustedWindows: Object.freeze([Object.freeze({ envelopeHash, startSourceFrame: 0, endSourceFrame: 150 })]), untrusted: Object.freeze([]), streamHash: sha('9'),
})
const spec = Object.freeze({
  outputSpecRevisionId: 'output-spec-revision-example-vertical', specHash: sha('c'), aspectRatio: '9:16' as const, safeArea: preset.spec.safeArea,
  width: preset.spec.width, height: preset.spec.height, fps: preset.spec.fps,
})
const facts = { workspaceId, projectId, variantId, spec, timeline: Object.freeze({ fps: 30, durationFrames: 150 }), source, clips: Object.freeze([clip]), stream }

const baseRecord = buildVariantReframePlanRecord({ ...facts, overrideHeads: [] })
const manual = createVariantReframeOverride({
  id: 'variant-reframe-override-example-1', workspaceId, projectId, baseVersionId: 'project-version-example-reframe-1', resultVersionId: 'project-version-example-reframe-2',
  commandId: 'variant-reframe-command-example-1', variantId, aspectRatio: '9:16', clip, startFrame: 60, endFrame: 120, action: 'set',
  crop: { ...maximumReframeCrop('9:16', source.width, source.height), x: 0.45 }, previous: null, createdAt,
})
const manualRecord = buildVariantReframePlanRecord({ ...facts, overrideHeads: [manual] })
const reset = createVariantReframeOverride({
  id: 'variant-reframe-override-example-2', workspaceId, projectId, baseVersionId: 'project-version-example-reframe-2', resultVersionId: 'project-version-example-reframe-3',
  commandId: 'variant-reframe-command-example-2', variantId, aspectRatio: '9:16', clip, startFrame: 60, endFrame: 120, action: 'reset', crop: null, previous: manual, createdAt,
})
const impactOf = (value: typeof manual) => createVariantReframeOverrideCommandImpact({
  commandId: value.commandId, baseVersionId: value.baseVersionId, resultVersionId: value.resultVersionId, variantId, clipId: value.clipId, action: value.action,
  range: { startFrame: value.startFrame, endFrame: value.endFrame }, durationFrames: 150,
  outputReferences: [{ artifactId: 'artifact-reframe-proxy-example-1', kind: 'proxy', sourceVersionId: value.baseVersionId, variantId }],
})
const stored = (record: typeof baseRecord, projectVersionId: string, id: string) => Object.freeze({ id, sequence: 1, projectVersionId, record, createdAt })
const resultOf = (value: typeof manual, record: typeof baseRecord, sequence: number, baseHash: string) => ({
  command: { id: value.commandId, type: 'apply-variant-reframe-override', baseVersionId: value.baseVersionId, author: { type: 'api-client', id: 'client-example-1' }, createdAt },
  version: { id: value.resultVersionId, sequence, parentVersionId: value.baseVersionId, baseHash, current: true, previewAvailable: false, createdAt },
  reframeOverride: value,
  plan: presentVariantReframePlan(stored(record, value.resultVersionId, `variant-reframe-plan-example-${sequence}`)),
  impact: impactOf(value),
  replayed: false,
})

const planPresentation = presentVariantReframePlan(stored(baseRecord, 'project-version-example-reframe-1', 'variant-reframe-plan-example-1'))
const meta = { apiVersion: 'v1' }

export const REFRAME_SCHEMA_EXAMPLES: Readonly<Record<string, readonly unknown[]>> = Object.freeze({
  'apollo://schemas/reframe-plan-request/v3': [{ baseVersionId: 'project-version-example-reframe-1', variantId }],
  'apollo://schemas/reframe-plan-request-result/v3': [
    { data: { schemaVersion: 'reframe-plan-request-result/v3', status: 'ready', plan: planPresentation, reasonCode: null, baseVersionId: 'project-version-example-reframe-1', variantId, format: '9:16', requiredFaceWindows: [], replayed: false }, meta },
    { data: {
      schemaVersion: 'reframe-plan-request-result/v3', status: 'review-required', plan: null, reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', baseVersionId: 'project-version-example-reframe-1', variantId, format: '9:16',
      requiredFaceWindows: [{ sourceArtifactId: source.artifactId, windows: [{ startSourceFrame: 0, endSourceFrame: 150 }] }], replayed: false,
    }, meta },
  ],
  'apollo://schemas/reframe-plan-read-response/v1': [
    { data: { variantId, projectVersionId: 'project-version-example-reframe-1', plan: planPresentation }, meta },
    { data: { variantId, projectVersionId: 'project-version-example-reframe-1', plan: null }, meta },
  ],
  'apollo://schemas/variant-reframe-override-apply-request/v1': [
    { baseVersionId: 'project-version-example-reframe-1', baseHash: 'e'.repeat(64), variantId, clipId: clip.clipId, startFrame: 60, endFrame: 120, action: 'set',
      crop: manual.crop, reason: 'Enquadrar o rosto mais à direita no trecho do gancho.' },
    { baseVersionId: 'project-version-example-reframe-2', baseHash: 'f'.repeat(64), variantId, clipId: clip.clipId, startFrame: 60, endFrame: 120, action: 'reset' },
  ],
  'apollo://schemas/variant-reframe-override-impact/v1': [impactOf(manual), impactOf(reset)],
  'apollo://schemas/variant-reframe-override-applied/v1': [
    { data: resultOf(manual, manualRecord, 2, 'f'.repeat(64)), meta },
    { data: resultOf(reset, baseRecord, 3, '9'.repeat(64)), meta },
  ],
  'apollo://schemas/variant-reframe-override-response/v1': [
    { data: { variantId, overrides: [manual] }, meta },
    { data: { variantId, overrides: [] }, meta },
  ],
})
