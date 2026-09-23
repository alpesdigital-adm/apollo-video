import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  calculateSyntheticBuildIdentityHash,
  type SyntheticBuildIdentity,
} from './synthetic-build-attestation.ts'

export const SYNTHETIC_PRODUCTION_RENDER_CONTEXT_VERSION =
  'synthetic-production-render-context/v1' as const
export const SYNTHETIC_PRODUCTION_RENDER_QUALITY_VERSION =
  'synthetic-production-render-quality/v1' as const

export type SyntheticProductionRenderKind = 'proxy' | 'final'
export type SyntheticProductionRenderAspectRatio =
  | '9:16'
  | '16:9'
  | '4:5'
  | '1:1'
  | '21:9'

export interface SyntheticProductionRenderContext {
  schemaVersion: typeof SYNTHETIC_PRODUCTION_RENDER_CONTEXT_VERSION
  operationId: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  productionRunId: string
  editPlanSnapshotId: string
  editPlanSnapshotHash: string
  planHash: string
  outputKind: SyntheticProductionRenderKind
  aspectRatio: SyntheticProductionRenderAspectRatio
  renderInputRef: string
  renderInputHash: string
  propsHash: string
  outputArtifactId: string
  outputManifestId: string
  contextHash: string
}

export interface SyntheticProductionRenderCheckpoint {
  operationId: string
  outputArtifactId: string
  attempt: number
  outputKind: SyntheticProductionRenderKind
  renderInputHash: string
  outputKey: string
  outputSha256: string
  byteSize: number
  width: number
  height: number
  fps: number
  durationInFrames: number
  codec: 'h264'
  audioCodec: 'aac'
  container: 'mp4'
  runtimeIdentity: Readonly<SyntheticBuildIdentity>
  runtimeIdentityHash: string
  committedAt: string
  recordedAt: string
}

export interface SyntheticProductionRenderQualityIssue {
  code: string
  severity: 'error' | 'warning'
  message: string
}

export interface SyntheticProductionRenderQualityReport {
  schemaVersion: typeof SYNTHETIC_PRODUCTION_RENDER_QUALITY_VERSION
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  productionRunId: string
  publicOperationId: string
  editPlanSnapshotId: string
  planHash: string
  renderInputHash: string
  propsHash: string
  outputKind: SyntheticProductionRenderKind
  outputArtifactId: string
  outputManifestId: string
  outputSha256: string
  byteSize: number
  expected: Readonly<{
    width: number
    height: number
    fps: number
    durationInFrames: number
    codec: 'h264'
    audioCodec: 'aac'
    container: 'mp4'
  }>
  measured: Readonly<{
    width: number
    height: number
    fps: number
    durationInFrames: number
    codec: string
    audioCodec: string
    container: string
    decodable: boolean
  }>
  runtimeIdentityHash: string
  issues: readonly Readonly<SyntheticProductionRenderQualityIssue>[]
  passed: boolean
  evaluatedAt: string
  reportHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/
const SHA256 = /^[a-f0-9]{64}$/

function validId(value: string, field: string): void {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
}

function validHash(value: string, field: string): void {
  assertDomain(SHA256.test(value), 'INVALID_ARGUMENT', `${field} must be SHA-256`)
}

function validTimestamp(value: string, field: string): void {
  assertDomain(
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO timestamp`,
  )
}

export function calculateSyntheticProductionRenderContextHash(
  input: Omit<SyntheticProductionRenderContext, 'contextHash'>,
): string {
  return calculateCanonicalHash(input)
}

export function assertSyntheticProductionRenderContext(
  input: Readonly<SyntheticProductionRenderContext>,
): Readonly<SyntheticProductionRenderContext> {
  assertDomain(
    input.schemaVersion === SYNTHETIC_PRODUCTION_RENDER_CONTEXT_VERSION,
    'INVALID_ARGUMENT',
    'Synthetic production render context version is unsupported',
  )
  for (const [field, value] of Object.entries({
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    projectVersionId: input.projectVersionId,
    productionRunId: input.productionRunId,
    editPlanSnapshotId: input.editPlanSnapshotId,
    outputArtifactId: input.outputArtifactId,
    outputManifestId: input.outputManifestId,
    renderInputRef: input.renderInputRef,
  })) validId(value, field)
  for (const [field, value] of Object.entries({
    projectVersionHash: input.projectVersionHash,
    editPlanSnapshotHash: input.editPlanSnapshotHash,
    planHash: input.planHash,
    renderInputHash: input.renderInputHash,
    propsHash: input.propsHash,
  })) validHash(value, field)
  assertDomain(input.outputKind === 'proxy' || input.outputKind === 'final', 'INVALID_ARGUMENT', 'outputKind is unsupported')
  assertDomain(['9:16', '16:9', '4:5', '1:1', '21:9'].includes(input.aspectRatio), 'INVALID_ARGUMENT', 'aspectRatio is unsupported')
  validHash(input.contextHash, 'contextHash')
  const { contextHash, ...body } = input
  assertDomain(calculateSyntheticProductionRenderContextHash(body) === contextHash, 'INVALID_ARGUMENT', 'Synthetic production render context hash is invalid')
  return input
}

export function calculateSyntheticProductionRenderQualityHash(
  input: Omit<SyntheticProductionRenderQualityReport, 'reportHash'>,
): string {
  return calculateCanonicalHash(input)
}

export function syntheticProductionRenderOutputKey(input: Readonly<{
  operationId: string
  outputArtifactId: string
  attempt: number
  outputKind: SyntheticProductionRenderKind
}>): string {
  validId(input.operationId, 'outputKey.operationId')
  validId(input.outputArtifactId, 'outputKey.outputArtifactId')
  assertDomain(Number.isSafeInteger(input.attempt) && input.attempt > 0, 'INVALID_ARGUMENT', 'outputKey.attempt is invalid')
  assertDomain(input.outputKind === 'proxy' || input.outputKind === 'final', 'INVALID_ARGUMENT', 'outputKey.outputKind is unsupported')
  const bindingHash = calculateCanonicalHash({
    schemaVersion: 'synthetic-production-render-output-key/v1',
    operationId: input.operationId,
    outputArtifactId: input.outputArtifactId,
  })
  return `synthetic-production-renders/${bindingHash}/attempt-${input.attempt}-${input.outputKind}.mp4`
}

export function assertSyntheticProductionRenderCheckpoint(
  input: Readonly<SyntheticProductionRenderCheckpoint>,
): Readonly<SyntheticProductionRenderCheckpoint> {
  validId(input.operationId, 'checkpoint.operationId')
  validId(input.outputArtifactId, 'checkpoint.outputArtifactId')
  assertDomain(Number.isSafeInteger(input.attempt) && input.attempt > 0, 'INVALID_ARGUMENT', 'checkpoint.attempt is invalid')
  assertDomain(input.outputKind === 'proxy' || input.outputKind === 'final', 'INVALID_ARGUMENT', 'checkpoint.outputKind is unsupported')
  validHash(input.renderInputHash, 'checkpoint.renderInputHash')
  assertDomain(
    input.outputKey === syntheticProductionRenderOutputKey(input) &&
      !input.outputKey.includes('..') &&
      !input.outputKey.includes('\\') &&
      !input.outputKey.startsWith('/'),
    'INVALID_ARGUMENT',
    'checkpoint.outputKey is not the server-owned output key',
  )
  validHash(input.outputSha256, 'checkpoint.outputSha256')
  assertDomain(
    Number.isSafeInteger(input.byteSize) && input.byteSize > 0 &&
      Number.isSafeInteger(input.width) && input.width > 0 &&
      Number.isSafeInteger(input.height) && input.height > 0 &&
      Number.isFinite(input.fps) && input.fps > 0 &&
      Number.isSafeInteger(input.durationInFrames) && input.durationInFrames > 0 &&
      input.codec === 'h264' && input.audioCodec === 'aac' && input.container === 'mp4',
    'INVALID_ARGUMENT',
    'Synthetic render checkpoint output is invalid',
  )
  assertDomain(/^[a-f0-9]{40,64}$/.test(input.runtimeIdentity.commitSha), 'INVALID_ARGUMENT', 'checkpoint runtime commit is invalid')
  for (const [field, value] of Object.entries({
    treeHash: input.runtimeIdentity.treeHash,
    contractGraphHash: input.runtimeIdentity.contractGraphHash,
    toolchainHash: input.runtimeIdentity.toolchainHash,
    renderBundleHash: input.runtimeIdentity.renderBundleHash,
  })) validHash(value, `checkpoint.runtimeIdentity.${field}`)
  validHash(input.runtimeIdentityHash, 'checkpoint.runtimeIdentityHash')
  assertDomain(calculateSyntheticBuildIdentityHash(input.runtimeIdentity) === input.runtimeIdentityHash, 'INVALID_ARGUMENT', 'checkpoint runtime identity hash is invalid')
  validTimestamp(input.committedAt, 'checkpoint.committedAt')
  validTimestamp(input.recordedAt, 'checkpoint.recordedAt')
  assertDomain(Date.parse(input.recordedAt) >= Date.parse(input.committedAt), 'INVALID_ARGUMENT', 'checkpoint recordedAt precedes committedAt')
  return input
}

export function assertSyntheticProductionRenderQualityReport(
  input: Readonly<SyntheticProductionRenderQualityReport>,
): Readonly<SyntheticProductionRenderQualityReport> {
  assertDomain(input.schemaVersion === SYNTHETIC_PRODUCTION_RENDER_QUALITY_VERSION, 'INVALID_ARGUMENT', 'Synthetic render quality version is unsupported')
  for (const [field, value] of Object.entries({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    projectVersionId: input.projectVersionId,
    productionRunId: input.productionRunId,
    publicOperationId: input.publicOperationId,
    editPlanSnapshotId: input.editPlanSnapshotId,
    outputArtifactId: input.outputArtifactId,
    outputManifestId: input.outputManifestId,
  })) validId(value, field)
  for (const [field, value] of Object.entries({
    planHash: input.planHash,
    renderInputHash: input.renderInputHash,
    propsHash: input.propsHash,
    outputSha256: input.outputSha256,
    runtimeIdentityHash: input.runtimeIdentityHash,
    reportHash: input.reportHash,
  })) validHash(value, field)
  assertDomain(Number.isSafeInteger(input.byteSize) && input.byteSize > 0, 'INVALID_ARGUMENT', 'Synthetic render quality byteSize is invalid')
  assertDomain(input.outputKind === 'proxy' || input.outputKind === 'final', 'INVALID_ARGUMENT', 'Synthetic render quality outputKind is unsupported')
  const dimensions = [input.expected.width, input.expected.height, input.expected.durationInFrames, input.measured.width, input.measured.height, input.measured.durationInFrames]
  assertDomain(dimensions.every((value) => Number.isSafeInteger(value) && value > 0), 'INVALID_ARGUMENT', 'Synthetic render quality dimensions are invalid')
  assertDomain(Number.isFinite(input.expected.fps) && input.expected.fps > 0 && Number.isFinite(input.measured.fps) && input.measured.fps > 0, 'INVALID_ARGUMENT', 'Synthetic render quality fps is invalid')
  assertDomain(
    input.expected.codec === 'h264' && input.expected.audioCodec === 'aac' && input.expected.container === 'mp4',
    'INVALID_ARGUMENT',
    'Synthetic render quality expected codecs are invalid',
  )
  assertDomain(typeof input.measured.decodable === 'boolean', 'INVALID_ARGUMENT', 'Synthetic render quality decodable flag is invalid')
  assertDomain(Array.isArray(input.issues) && input.issues.every((issue) =>
    ID.test(issue.code) &&
    (issue.severity === 'error' || issue.severity === 'warning') &&
    typeof issue.message === 'string' && issue.message.trim().length >= 1 && issue.message.length <= 500),
  'INVALID_ARGUMENT', 'Synthetic render quality issues are invalid')
  const exact = input.measured.decodable &&
    input.measured.width === input.expected.width && input.measured.height === input.expected.height &&
    input.measured.fps === input.expected.fps && input.measured.durationInFrames === input.expected.durationInFrames &&
    input.measured.codec === input.expected.codec && input.measured.audioCodec === input.expected.audioCodec &&
    input.measured.container === input.expected.container
  assertDomain(input.passed === (exact && input.issues.every((issue) => issue.severity !== 'error')), 'INVALID_ARGUMENT', 'Synthetic render quality verdict is inconsistent')
  validTimestamp(input.evaluatedAt, 'evaluatedAt')
  const { reportHash, ...body } = input
  assertDomain(calculateSyntheticProductionRenderQualityHash(body) === reportHash, 'INVALID_ARGUMENT', 'Synthetic render quality report hash is invalid')
  return input
}
