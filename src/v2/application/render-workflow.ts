import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { RenderElementMap } from '../domain/review-system.ts'
import { OUTPUT_ASPECT_RATIOS } from '../domain/output-spec.ts'
import { OUTPUT_FORMAT_REGISTRY } from '../domain/output-format-registry.ts'
import { critiqueOutputFormat, type FormatSubjectEvidenceV1 } from '../domain/format-quality-critic.ts'

export interface RenderApproval {
  projectVersionId: string
  variantIds: readonly string[]
  approved: boolean
  stale: boolean
  warningsAcknowledged: boolean
}

export interface RenderAttempt {
  id: string
  status: 'failed' | 'promoted'
  artifactKey?: string
  error?: string
}

export const PROXY_OUTPUT_SPECS = Object.freeze(Object.fromEntries(
  OUTPUT_ASPECT_RATIOS.map((ratio) => {
    const spec = OUTPUT_FORMAT_REGISTRY.presets[ratio].exportDefaults.proxy
    return [ratio, Object.freeze({ width: spec.width, height: spec.height, codec: spec.codec, container: spec.container, quality: 'review' as const })]
  }),
) as Record<typeof OUTPUT_ASPECT_RATIOS[number], Readonly<{ width: number; height: number; codec: 'h264'; container: 'mp4'; quality: 'review' }>>)

export type ProxyOutputFormat = keyof typeof PROXY_OUTPUT_SPECS
export type ProxyReviewStatus = 'blocked' | 'warning-ack-required' | 'ready-for-final'

export interface ProxyQualityIssue {
  code: string
  severity: 'hard' | 'warning'
  category: 'technical' | 'policy' | 'integrity' | 'editorial'
  message: string
  rangeMs?: readonly [number, number]
  targetId?: string
  outputSpecId?: string
  outputPresetHash?: string
  /** Half-open frame interval `[startFrame, endFrame)` where the evidence lives. */
  evidenceRange?: Readonly<{ startFrame: number; endFrame: number }>
  elementIds?: readonly string[]
  evidenceIds?: readonly string[]
  correctable: boolean
}

/** Per-output verdict of the format critic, explaining why this exact variant passed or failed. */
export interface ProxyFormatQualityVerdict {
  outputPresetHash: string
  status: 'passed' | 'warning' | 'blocked'
  exportAllowed: boolean
  explanation: string
  reportHash: string
}

export interface ProxyReview {
  schemaVersion: 'proxy-review/v1'
  projectVersionId: string
  proxyArtifactId: string
  proxyManifestId: string
  inputHash: string
  outputSpecId: string
  rangeCacheKey: string
  spec: Readonly<{
    width: number
    height: number
    codec: 'h264'
    container: 'mp4'
    quality: 'review'
    reusableRanges: true
  }>
  status: ProxyReviewStatus
  technicalIssues: readonly Readonly<ProxyQualityIssue>[]
  criticIssues: readonly Readonly<ProxyQualityIssue>[]
  formatQuality?: Readonly<ProxyFormatQualityVerdict>
  warningsAcknowledged: boolean
  finalAllowed: boolean
  uploadReceivedAt: string
  renderCompletedAt: string
  timeToFirstProxyMs: number
  reviewHash: string
}

function isValidDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value))
}

function normalizedBounds(
  bounds: readonly [number, number, number, number],
  canvas: Readonly<{ width: number; height: number }>,
) {
  const [x, y, width, height] = bounds
  return Object.freeze({
    x: x * canvas.width,
    y: y * canvas.height,
    width: width * canvas.width,
    height: height * canvas.height,
  })
}

function overlaps(
  left: Readonly<{ x: number; y: number; width: number; height: number }>,
  right: Readonly<{ x: number; y: number; width: number; height: number }>,
): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x &&
    left.y < right.y + right.height && left.y + left.height > right.y
}

function contains(
  outer: Readonly<{ x: number; y: number; width: number; height: number }>,
  inner: Readonly<{ x: number; y: number; width: number; height: number }>,
): boolean {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
}

function groupedSubtitleIssues(input: {
  map: Readonly<RenderElementMap>
  faceSafeRegion?: readonly [number, number, number, number]
  subtitleSafeRegion?: readonly [number, number, number, number]
}): readonly Readonly<ProxyQualityIssue>[] {
  if (!input.faceSafeRegion && !input.subtitleSafeRegion) return Object.freeze([])
  const face = input.faceSafeRegion ? normalizedBounds(input.faceSafeRegion, input.map.canvas) : undefined
  const safe = input.subtitleSafeRegion ? normalizedBounds(input.subtitleSafeRegion, input.map.canvas) : undefined
  const subtitles = new Map<string, typeof input.map.elements>()
  for (const element of input.map.elements) {
    if (element.type !== 'subtitle') continue
    subtitles.set(element.elementId, Object.freeze([...(subtitles.get(element.elementId) ?? []), element]))
  }
  const issues: ProxyQualityIssue[] = []
  for (const [elementId, elements] of subtitles) {
    const ordered = [...elements].toSorted((left, right) => left.frame - right.frame)
    const first = ordered[0]
    const last = ordered.at(-1)
    if (!first || !last) continue
    const rangeMs = Object.freeze([
      Math.round(first.frame / input.map.fps * 1_000),
      Math.round((last.frame + 1) / input.map.fps * 1_000),
    ] as const)
    if (face && overlaps(first.bounds, face)) {
      issues.push(Object.freeze({
        code: 'SUBTITLE_FACE_OVERLAP',
        severity: 'hard',
        category: 'editorial',
        message: 'Subtitle overlaps the protected face region in the rendered proxy.',
        rangeMs,
        targetId: elementId,
        correctable: true,
      }))
    }
    if (safe && !contains(safe, first.bounds)) {
      issues.push(Object.freeze({
        code: 'SUBTITLE_OUTSIDE_SAFE_REGION',
        severity: 'warning',
        category: 'editorial',
        message: 'Subtitle leaves the configured safe region in the rendered proxy.',
        rangeMs,
        targetId: elementId,
        correctable: true,
      }))
    }
  }
  return Object.freeze(issues)
}

export function calculateProxyReviewHash(
  review: Omit<ProxyReview, 'reviewHash'>,
): string {
  return calculateCanonicalHash(review)
}

export function evaluateRenderedProxy(input: {
  projectVersionId: string
  proxyArtifactId: string
  proxyManifestId: string
  proxySha256: string
  inputHash: string
  format: string
  sourceSha256: string
  editPlanHash: string
  expectedDurationMs: number
  uploadReceivedAt: string
  renderCompletedAt: string
  probe: Readonly<{ width: number; height: number; duration: number; fps: number; codec: string; container: string }>
  map: Readonly<RenderElementMap>
  faceSafeRegion?: readonly [number, number, number, number]
  subtitleSafeRegion?: readonly [number, number, number, number]
  criticIssues?: readonly Readonly<ProxyQualityIssue>[]
  warningsAcknowledged?: boolean
  formatCritic?: Readonly<{ outputSpecId: string; subjects?: readonly Readonly<FormatSubjectEvidenceV1>[]; densityLimit?: number }>
}): Readonly<ProxyReview> {
  const spec = PROXY_OUTPUT_SPECS[input.format as ProxyOutputFormat]
  assertDomain(Boolean(spec), 'INVALID_OUTPUT_SPEC', 'Proxy format is not supported')
  assertDomain(
    /^[a-f0-9]{64}$/.test(input.inputHash) &&
    /^[a-f0-9]{64}$/.test(input.proxySha256) &&
    /^[a-f0-9]{64}$/.test(input.sourceSha256) &&
    /^[a-f0-9]{64}$/.test(input.editPlanHash) &&
    input.projectVersionId.trim().length >= 3 &&
    input.proxyArtifactId.trim().length >= 3 &&
    input.proxyManifestId.trim().length >= 3 &&
    Number.isFinite(input.expectedDurationMs) && input.expectedDurationMs > 0 &&
    isValidDate(input.uploadReceivedAt) && isValidDate(input.renderCompletedAt),
    'INVALID_RENDER_INPUT',
    'Rendered proxy review input is invalid',
  )
  const uploadReceivedAt = new Date(input.uploadReceivedAt)
  const renderCompletedAt = new Date(input.renderCompletedAt)
  assertDomain(renderCompletedAt >= uploadReceivedAt, 'INVALID_RENDER_INPUT', 'Proxy completion predates its upload')
  const typedSpec = Object.freeze({ ...spec, reusableRanges: true as const })
  const technicalIssues: ProxyQualityIssue[] = []
  const addTechnical = (issue: ProxyQualityIssue) => technicalIssues.push(Object.freeze(issue))
  if (input.probe.codec.toLowerCase() !== typedSpec.codec) {
    addTechnical({
      code: 'PROXY_CODEC_MISMATCH', severity: 'hard', category: 'technical',
      message: `Expected ${typedSpec.codec} proxy codec.`, correctable: true,
    })
  }
  if (input.probe.width !== typedSpec.width || input.probe.height !== typedSpec.height) {
    addTechnical({
      code: 'PROXY_RESOLUTION_MISMATCH', severity: 'hard', category: 'technical',
      message: `Expected ${typedSpec.width}x${typedSpec.height} proxy resolution.`, correctable: true,
    })
  }
  if (!input.probe.container.toLowerCase().includes(typedSpec.container)) {
    addTechnical({
      code: 'PROXY_CONTAINER_MISMATCH', severity: 'hard', category: 'technical',
      message: `Expected ${typedSpec.container} proxy container.`, correctable: true,
    })
  }
  const renderedDurationMs = Math.round(input.probe.duration * 1_000)
  const toleranceMs = Math.max(100, Math.ceil(3 / Math.max(1, input.probe.fps) * 1_000))
  if (Math.abs(renderedDurationMs - input.expectedDurationMs) > toleranceMs) {
    addTechnical({
      code: 'PROXY_DURATION_MISMATCH', severity: 'hard', category: 'technical',
      message: 'Rendered proxy duration differs from the compiled timeline.',
      rangeMs: Object.freeze([0, Math.max(renderedDurationMs, input.expectedDurationMs)]),
      correctable: true,
    })
  }
  if (input.map.proxyHash !== input.proxySha256) {
    addTechnical({
      code: 'PROXY_MAP_INVALID', severity: 'hard', category: 'integrity',
      message: 'Rendered element map does not carry a valid proxy identity.', correctable: false,
    })
  }
  if (
    input.map.canvas.width !== input.probe.width ||
    input.map.canvas.height !== input.probe.height ||
    input.map.durationFrames !== Math.round(input.expectedDurationMs / 1_000 * input.map.fps)
  ) {
    addTechnical({
      code: 'PROXY_MAP_MISMATCH', severity: 'hard', category: 'integrity',
      message: 'Rendered element map does not match proxy dimensions or duration.', correctable: false,
    })
  }
  const formatReport = input.formatCritic ? critiqueOutputFormat({
    outputSpecId: input.formatCritic.outputSpecId,
    format: input.format as ProxyOutputFormat,
    proxyHash: input.proxySha256,
    map: input.map,
    subjects: input.formatCritic.subjects,
    densityLimit: input.formatCritic.densityLimit,
  }) : undefined
  const criticIssues = Object.freeze([
    ...(input.criticIssues ?? []),
    ...(formatReport?.issues.map((issue) => ({ ...issue, targetId: issue.elementIds[0] })) ?? []),
    ...groupedSubtitleIssues({
      map: input.map,
      ...(input.faceSafeRegion ? { faceSafeRegion: input.faceSafeRegion } : {}),
      ...(input.subtitleSafeRegion ? { subtitleSafeRegion: input.subtitleSafeRegion } : {}),
    }),
  ].map((issue) => Object.freeze({ ...issue, ...(issue.rangeMs ? { rangeMs: Object.freeze([...issue.rangeMs] as [number, number]) } : {}) })))
  const warningsAcknowledged = input.warningsAcknowledged ?? false
  const issues = [...technicalIssues, ...criticIssues]
  const hard = issues.filter((issue) => issue.severity === 'hard')
  const warnings = issues.filter((issue) => issue.severity === 'warning')
  const status: ProxyReviewStatus = hard.length > 0
    ? 'blocked'
    : warnings.length > 0 && !warningsAcknowledged
      ? 'warning-ack-required'
      : 'ready-for-final'
  const reviewWithoutHash: Omit<ProxyReview, 'reviewHash'> = Object.freeze({
    schemaVersion: 'proxy-review/v1',
    projectVersionId: input.projectVersionId,
    proxyArtifactId: input.proxyArtifactId,
    proxyManifestId: input.proxyManifestId,
    inputHash: input.inputHash,
    outputSpecId: input.formatCritic?.outputSpecId ?? OUTPUT_FORMAT_REGISTRY.presets[input.format as ProxyOutputFormat].spec.id,
    rangeCacheKey: calculateCanonicalHash({
      kind: 'proxy-range-cache/v1',
      projectVersionId: input.projectVersionId,
      sourceSha256: input.sourceSha256,
      editPlanHash: input.editPlanHash,
      format: input.format,
      spec: typedSpec,
    }),
    spec: typedSpec,
    status,
    technicalIssues: Object.freeze(technicalIssues),
    criticIssues,
    ...(formatReport
      ? {
          formatQuality: Object.freeze({
            outputPresetHash: formatReport.outputPresetHash,
            status: formatReport.status,
            exportAllowed: formatReport.exportAllowed,
            explanation: formatReport.explanation,
            reportHash: formatReport.reportHash,
          }),
        }
      : {}),
    warningsAcknowledged,
    finalAllowed: status === 'ready-for-final',
    uploadReceivedAt: uploadReceivedAt.toISOString(),
    renderCompletedAt: renderCompletedAt.toISOString(),
    timeToFirstProxyMs: renderCompletedAt.getTime() - uploadReceivedAt.getTime(),
  })
  return Object.freeze({
    ...reviewWithoutHash,
    reviewHash: calculateProxyReviewHash(reviewWithoutHash),
  })
}

export function materializeProxyFirst(input: {
  uploadReceivedAt: string
  projectVersionId: string
  variantId: string
  durationMs: number
}) {
  const spec = PROXY_OUTPUT_SPECS[input.variantId as ProxyOutputFormat]
  assertDomain(Boolean(spec), 'INVALID_OUTPUT_SPEC', 'Proxy format is not supported')
  return Object.freeze({
    kind: 'proxy' as const,
    status: 'reviewable' as const,
    spec: Object.freeze({ ...spec, reusableRanges: true as const }),
    authorization: Object.freeze({ finalAllowed: false, reason: 'PROXY_REVIEW_REQUIRED' }),
    timeToFirstProxyMs: Date.now() - Date.parse(input.uploadReceivedAt),
    rangeCacheKey: calculateCanonicalHash({
      projectVersionId: input.projectVersionId,
      variantId: input.variantId,
      durationMs: input.durationMs,
      spec,
    }),
  })
}

export function validateProxy(input: {
  technicalIssues: readonly { severity: 'hard' | 'warning'; code: string }[]
  criticIssues: readonly { severity: 'hard' | 'warning'; rangeMs: readonly [number, number]; code: string }[]
  warningsAcknowledged: boolean
}) {
  const issues = [...input.technicalIssues, ...input.criticIssues]
  const hard = issues.filter((issue) => issue.severity === 'hard')
  const warnings = issues.filter((issue) => issue.severity === 'warning')
  return Object.freeze({
    valid: hard.length === 0 && (warnings.length === 0 || input.warningsAcknowledged),
    hard: Object.freeze(hard),
    warnings: Object.freeze(warnings),
    finalBlocked: hard.length > 0 || (warnings.length > 0 && !input.warningsAcknowledged),
  })
}

export function createFinalRenderJob(input: {
  approval: RenderApproval
  output: { codec: string; quality: string }
  idempotencyKey: string
  existing?: Readonly<{ id: string; fingerprint: string }>
}) {
  if (!input.approval.approved || input.approval.stale || !input.approval.variantIds.length) {
    throw new DomainError('PRECONDITION_REQUIRED', 'Final render requires approved non-stale variants')
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ approval: input.approval, output: input.output })).digest('hex')
  if (input.existing) {
    if (input.existing.fingerprint !== fingerprint) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Final render key was reused with different payload')
    }
    return Object.freeze({ ...input.existing, replayed: true })
  }
  return Object.freeze({
    id: `final_${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16)}`,
    fingerprint,
    replayed: false,
    status: 'queued' as const,
    codec: input.output.codec,
    quality: input.output.quality,
  })
}

export function finalizeRender(input: {
  jobId: string
  bytes: Uint8Array
  validators: readonly { code: string; passed: boolean }[]
  attempts: readonly RenderAttempt[]
}) {
  const failed = input.validators.filter((item) => !item.passed)
  if (failed.length) {
    return Object.freeze({
      status: 'failed-validation' as const,
      artifact: null,
      attempts: Object.freeze([...input.attempts, {
        id: `${input.jobId}:attempt:${input.attempts.length + 1}`,
        status: 'failed' as const,
        error: failed.map((item) => item.code).join(','),
      }]),
    })
  }
  const checksum = createHash('sha256').update(input.bytes).digest('hex')
  const artifact = Object.freeze({
    id: `artifact_${checksum.slice(0, 16)}`,
    checksum,
    manifest: Object.freeze({
      schemaVersion: 1,
      jobId: input.jobId,
      checksum,
      byteSize: input.bytes.byteLength,
      reconstructable: true,
    }),
    downloadGrantEligible: true,
    promotion: 'atomic' as const,
  })
  return Object.freeze({
    status: 'promoted' as const,
    artifact,
    attempts: Object.freeze([...input.attempts, {
      id: `${input.jobId}:attempt:${input.attempts.length + 1}`,
      status: 'promoted' as const,
      artifactKey: artifact.id,
    }]),
  })
}

export function reconstructFinal(
  manifest: { checksum: string; byteSize: number; reconstructable: boolean },
  bytes: Uint8Array,
) {
  return manifest.reconstructable &&
    manifest.byteSize === bytes.byteLength &&
    manifest.checksum === createHash('sha256').update(bytes).digest('hex')
}
