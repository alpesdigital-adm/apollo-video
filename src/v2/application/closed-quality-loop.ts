import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain } from '../domain/errors.ts'
import {
  PROXY_OUTPUT_SPECS,
  type ProxyOutputFormat,
} from './render-workflow.ts'

const ISSUE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,79}$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const MAX_ISSUES = 500

export type QualityIssueCategory =
  | 'technical'
  | 'policy'
  | 'integrity'
  | 'asset'
  | 'editorial'

export type QualityIssue = Readonly<{
  code: string
  severity: 'hard' | 'warning'
  category: QualityIssueCategory
  message?: string
  rangeMs?: readonly [number, number]
  targetId?: string
  correctable: boolean
}>

export interface QualityInput {
  technical: readonly QualityIssue[]
  policy: readonly QualityIssue[]
  integrity: readonly QualityIssue[]
  assets: readonly QualityIssue[]
  proxy: readonly QualityIssue[]
}

export interface ProxyRangeMetric {
  startMs: number
  endMs: number
  density: number
}

function finiteScore(value: number, field: string): number {
  assertDomain(
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between 0 and 1`,
  )
  return value
}

function normalizedRange(
  value: readonly [number, number],
  field: string,
): readonly [number, number] {
  assertDomain(
    Array.isArray(value) &&
      value.length === 2 &&
      value.every((item) => Number.isSafeInteger(item) && item >= 0) &&
      value[1] > value[0],
    'INVALID_ARGUMENT',
    `${field} must contain an increasing millisecond range`,
  )
  return Object.freeze([value[0], value[1]])
}

function normalizeIssue(value: QualityIssue, field: string): Readonly<QualityIssue> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be an object`,
  )
  assertDomain(
    typeof value.code === 'string' && ISSUE_CODE_PATTERN.test(value.code),
    'INVALID_ARGUMENT',
    `${field}.code is invalid`,
  )
  assertDomain(
    value.severity === 'hard' || value.severity === 'warning',
    'INVALID_ARGUMENT',
    `${field}.severity is invalid`,
  )
  assertDomain(
    ['technical', 'policy', 'integrity', 'asset', 'editorial'].includes(value.category),
    'INVALID_ARGUMENT',
    `${field}.category is invalid`,
  )
  assertDomain(
    typeof value.correctable === 'boolean',
    'INVALID_ARGUMENT',
    `${field}.correctable must be boolean`,
  )
  const message = value.message?.trim()
  assertDomain(
    message === undefined || (message.length >= 1 && message.length <= 500),
    'INVALID_ARGUMENT',
    `${field}.message is invalid`,
  )
  const targetId = value.targetId?.trim()
  assertDomain(
    targetId === undefined || ID_PATTERN.test(targetId),
    'INVALID_ARGUMENT',
    `${field}.targetId is invalid`,
  )
  return Object.freeze({
    code: value.code,
    severity: value.severity,
    category: value.category,
    ...(message ? { message } : {}),
    ...(value.rangeMs ? { rangeMs: normalizedRange(value.rangeMs, `${field}.rangeMs`) } : {}),
    ...(targetId ? { targetId } : {}),
    correctable: value.correctable,
  })
}

function issueIdentity(issue: Readonly<QualityIssue>): string {
  return calculateCanonicalHash(issue)
}

function uniqueIssues(values: readonly QualityIssue[], field: string): readonly Readonly<QualityIssue>[] {
  assertDomain(Array.isArray(values), 'INVALID_ARGUMENT', `${field} must be an array`)
  assertDomain(values.length <= MAX_ISSUES, 'INVALID_ARGUMENT', `${field} exceeds ${MAX_ISSUES} issues`)
  const seen = new Set<string>()
  const normalized: Readonly<QualityIssue>[] = []
  values.forEach((value, index) => {
    const issue = normalizeIssue(value, `${field}[${index}]`)
    const identity = issueIdentity(issue)
    if (!seen.has(identity)) {
      seen.add(identity)
      normalized.push(issue)
    }
  })
  return Object.freeze(normalized)
}

export function validateQuality(input: QualityInput) {
  assertDomain(
    typeof input === 'object' && input !== null && !Array.isArray(input),
    'INVALID_ARGUMENT',
    'Quality input must be an object',
  )
  const grouped = {
    technical: uniqueIssues(input.technical, 'technical'),
    policy: uniqueIssues(input.policy, 'policy'),
    integrity: uniqueIssues(input.integrity, 'integrity'),
    assets: uniqueIssues(input.assets, 'assets'),
    proxy: uniqueIssues(input.proxy, 'proxy'),
  }
  const issues = uniqueIssues(
    [
      ...grouped.technical,
      ...grouped.policy,
      ...grouped.integrity,
      ...grouped.assets,
      ...grouped.proxy,
    ],
    'issues',
  )
  const hardIssues = Object.freeze(issues.filter((issue) => issue.severity === 'hard'))
  const warningIssues = Object.freeze(issues.filter((issue) => issue.severity === 'warning'))
  const hardByCategory = Object.freeze({
    technical: hardIssues.filter((issue) => issue.category === 'technical').length,
    policy: hardIssues.filter((issue) => issue.category === 'policy').length,
    integrity: hardIssues.filter((issue) => issue.category === 'integrity').length,
    asset: hardIssues.filter((issue) => issue.category === 'asset').length,
    editorial: hardIssues.filter((issue) => issue.category === 'editorial').length,
  })
  return Object.freeze({
    valid: hardIssues.length === 0,
    finalBlocked: hardIssues.length > 0,
    issues,
    hardIssues,
    warningIssues,
    hardByCategory,
  })
}

export function critiqueAsset(input: {
  relevance: number
  continuity: number
  quality: number
  rightsApproved: boolean
  novelty: number
  rangeMs: readonly [number, number]
  assetId: string
}): readonly QualityIssue[] {
  const relevance = finiteScore(input.relevance, 'asset.relevance')
  const continuity = finiteScore(input.continuity, 'asset.continuity')
  const quality = finiteScore(input.quality, 'asset.quality')
  const novelty = finiteScore(input.novelty, 'asset.novelty')
  assertDomain(typeof input.rightsApproved === 'boolean', 'INVALID_ARGUMENT', 'asset.rightsApproved must be boolean')
  assertDomain(typeof input.assetId === 'string' && ID_PATTERN.test(input.assetId), 'INVALID_ARGUMENT', 'asset.assetId is invalid')
  const rangeMs = normalizedRange(input.rangeMs, 'asset.rangeMs')
  return Object.freeze([
    ...(relevance < 0.6
      ? [{
          code: 'ASSET_IRRELEVANT',
          severity: 'hard',
          category: 'asset',
          message: 'Selected asset does not support the intended semantic beat.',
          rangeMs,
          targetId: input.assetId,
          correctable: true,
        } as const]
      : []),
    ...(continuity < 0.6
      ? [{
          code: 'ASSET_CONTINUITY',
          severity: 'warning',
          category: 'asset',
          message: 'Selected asset conflicts with adjacent visual continuity.',
          rangeMs,
          targetId: input.assetId,
          correctable: true,
        } as const]
      : []),
    ...(quality < 0.6
      ? [{
          code: 'ASSET_QUALITY',
          severity: 'hard',
          category: 'technical',
          message: 'Selected asset quality is below the insertion threshold.',
          rangeMs,
          targetId: input.assetId,
          correctable: true,
        } as const]
      : []),
    ...(!input.rightsApproved
      ? [{
          code: 'ASSET_RIGHTS',
          severity: 'hard',
          category: 'policy',
          message: 'Selected asset has no current server-verified rendering rights.',
          rangeMs,
          targetId: input.assetId,
          correctable: false,
        } as const]
      : []),
    ...(novelty > 0.8
      ? [{
          code: 'ASSET_EXCESS_NOVELTY',
          severity: 'warning',
          category: 'editorial',
          message: 'Selected asset introduces more novelty than the treatment allows.',
          rangeMs,
          targetId: input.assetId,
          correctable: true,
        } as const]
      : []),
  ])
}

export function critiqueProxy(input: {
  format: ProxyOutputFormat
  spec?: Readonly<{ width: number; height: number }>
  rubric: Readonly<Record<string, number>>
  ranges: readonly ProxyRangeMetric[]
}): readonly QualityIssue[] {
  assertDomain(
    Object.hasOwn(PROXY_OUTPUT_SPECS, input.format),
    'INVALID_ARGUMENT',
    'Proxy format is invalid',
  )
  assertDomain(
    typeof input.rubric === 'object' &&
      input.rubric !== null &&
      !Array.isArray(input.rubric) &&
      Object.keys(input.rubric).length >= 1 &&
      Object.keys(input.rubric).length <= 20,
    'INVALID_ARGUMENT',
    'Proxy rubric must contain 1 to 20 scores',
  )
  const rubricEntries = Object.entries(input.rubric)
    .map(([name, score]) => {
      const normalizedName = name.trim().toLowerCase()
      assertDomain(
        /^[a-z][a-z0-9-]{1,63}$/.test(normalizedName),
        'INVALID_ARGUMENT',
        'Proxy rubric criterion is invalid',
      )
      return [normalizedName, finiteScore(score, `rubric.${normalizedName}`)] as const
    })
    .sort(([left], [right]) => left.localeCompare(right))
  assertDomain(
    new Set(rubricEntries.map(([name]) => name)).size === rubricEntries.length,
    'INVALID_ARGUMENT',
    'Proxy rubric criteria must be unique',
  )
  assertDomain(Array.isArray(input.ranges) && input.ranges.length <= 200, 'INVALID_ARGUMENT', 'Proxy ranges are invalid')
  const ranges = input.ranges
    .map((range, index) => {
      assertDomain(
        typeof range === 'object' && range !== null && !Array.isArray(range),
        'INVALID_ARGUMENT',
        `ranges[${index}] must be an object`,
      )
      const rangeMs = normalizedRange([range.startMs, range.endMs], `ranges[${index}]`)
      return Object.freeze({
        rangeMs,
        density: finiteScore(range.density, `ranges[${index}].density`),
      })
    })
    .sort((left, right) => left.rangeMs[0] - right.rangeMs[0] || left.rangeMs[1] - right.rangeMs[1])
  const expected = PROXY_OUTPUT_SPECS[input.format]
  const formatMismatch = input.spec !== undefined &&
    (input.spec.width !== expected.width || input.spec.height !== expected.height)
  return Object.freeze([
    ...(formatMismatch
      ? [{
          code: 'PROXY_FORMAT_MISMATCH',
          severity: 'hard',
          category: 'technical',
          message: `Proxy dimensions do not match ${input.format}.`,
          targetId: 'proxy-output',
          correctable: true,
        } as const]
      : []),
    ...rubricEntries
      .filter(([, score]) => score < 0.65)
      .map(([name]) => Object.freeze({
        code: `RUBRIC_${name.toUpperCase().replaceAll('-', '_')}`,
        severity: 'warning' as const,
        category: 'editorial' as const,
        message: `Proxy score for ${name} is below the rubric threshold.`,
        targetId: `rubric:${name}`,
        correctable: true,
      })),
    ...ranges
      .filter((range) => range.density > 0.9)
      .map((range) => Object.freeze({
        code: 'PATTERN_DENSITY',
        severity: 'warning' as const,
        category: 'editorial' as const,
        message: 'Pattern-break density is above the allowed range.',
        rangeMs: range.rangeMs,
        targetId: 'variant',
        correctable: true,
      })),
  ])
}

function mergeRanges(
  ranges: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  const ordered = ranges
    .map((range, index) => normalizedRange(range, `rerenderRanges[${index}]`))
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: [number, number][] = []
  for (const range of ordered) {
    const previous = merged.at(-1)
    if (!previous || range[0] > previous[1]) {
      merged.push([range[0], range[1]])
    } else {
      previous[1] = Math.max(previous[1], range[1])
    }
  }
  return Object.freeze(merged.map((range) => Object.freeze(range)))
}

export function compileQualityPatches(issues: readonly QualityIssue[]) {
  const normalized = uniqueIssues(issues, 'issues')
  const eligible = normalized.filter((issue) => issue.correctable)
  const ranged = eligible.filter(
    (issue): issue is Readonly<QualityIssue> & { rangeMs: readonly [number, number] } =>
      issue.rangeMs !== undefined,
  )
  const minimalRerenderRangesMs = mergeRanges(ranged.map((issue) => issue.rangeMs))
  const fullRerenderRequired = eligible.some((issue) => issue.rangeMs === undefined)
  const minimalRerenderRangeMs = minimalRerenderRangesMs.length === 0
    ? null
    : Object.freeze([
        minimalRerenderRangesMs[0]![0],
        minimalRerenderRangesMs.at(-1)![1],
      ] as const)
  return Object.freeze({
    patches: Object.freeze(eligible.map((issue) => Object.freeze({
      type: issue.category === 'asset' ? 'replace_asset' as const : 'adjust' as const,
      targetId: issue.targetId ?? 'variant',
      issueCode: issue.code,
      ...(issue.rangeMs ? { rangeMs: issue.rangeMs } : {}),
    }))),
    minimalRerenderRangesMs,
    minimalRerenderRangeMs,
    fullRerenderRequired,
    ineligible: Object.freeze(normalized.filter((issue) => !issue.correctable)),
  })
}

export type QualityTerminalReason =
  | 'approval'
  | 'convergence'
  | 'budget'
  | 'uncorrectable'
  | 'human_review'

export function decideQualityIteration(input: {
  approved: boolean
  scoreDelta: number
  remainingBudget: number
  issues: readonly QualityIssue[]
  iteration: number
}) {
  assertDomain(typeof input.approved === 'boolean', 'INVALID_ARGUMENT', 'approved must be boolean')
  assertDomain(Number.isFinite(input.scoreDelta), 'INVALID_ARGUMENT', 'scoreDelta must be finite')
  assertDomain(
    Number.isSafeInteger(input.remainingBudget) && input.remainingBudget >= 0,
    'INVALID_ARGUMENT',
    'remainingBudget must be a non-negative integer',
  )
  assertDomain(
    Number.isSafeInteger(input.iteration) && input.iteration >= 1,
    'INVALID_ARGUMENT',
    'iteration must be a positive integer',
  )
  const issues = uniqueIssues(input.issues, 'issues')
  let terminalReason: QualityTerminalReason | null = null
  if (input.approved) terminalReason = 'approval'
  else if (issues.some((issue) => !issue.correctable && issue.severity === 'hard')) {
    terminalReason = 'uncorrectable'
  } else if (input.remainingBudget <= 0) terminalReason = 'budget'
  else if (input.iteration >= 2 && Math.abs(input.scoreDelta) < 0.01) {
    terminalReason = 'convergence'
  } else if (input.iteration >= 5) terminalReason = 'human_review'
  return Object.freeze({
    continue: terminalReason === null,
    terminalReason,
  })
}

export function createQualityReport(input: {
  versionId: string
  datasetId: string
  score: number
  baselineScore: number
  issues: readonly QualityIssue[]
}) {
  assertDomain(
    typeof input.versionId === 'string' && ID_PATTERN.test(input.versionId),
    'INVALID_ARGUMENT',
    'Quality report versionId is invalid',
  )
  assertDomain(
    typeof input.datasetId === 'string' && ID_PATTERN.test(input.datasetId),
    'INVALID_ARGUMENT',
    'Quality report datasetId is invalid',
  )
  assertDomain(
    Number.isFinite(input.score) && input.score >= 0 && input.score <= 100,
    'INVALID_ARGUMENT',
    'Quality report score is invalid',
  )
  assertDomain(
    Number.isFinite(input.baselineScore) &&
      input.baselineScore >= 0 &&
      input.baselineScore <= 100,
    'INVALID_ARGUMENT',
    'Quality report baselineScore is invalid',
  )
  const issues = uniqueIssues(input.issues, 'issues')
  const regression = Number((input.score - input.baselineScore).toFixed(4))
  const content = Object.freeze({
    schemaVersion: 'quality-report/v1' as const,
    versionId: input.versionId,
    datasetId: input.datasetId,
    score: input.score,
    baselineScore: input.baselineScore,
    regression,
    regressed: regression < 0,
    issues,
  })
  const fingerprint = calculateCanonicalHash(content)
  return Object.freeze({
    ...content,
    id: `quality-report-${fingerprint.slice(0, 32)}`,
    fingerprint,
  })
}
