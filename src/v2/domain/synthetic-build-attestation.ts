import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const SYNTHETIC_BUILD_ATTESTATION_SCHEMA_VERSION =
  'synthetic-build-attestation/v1' as const

export const SYNTHETIC_BUILD_CHECKS = Object.freeze([
  Object.freeze({
    code: 'architecture',
    command: 'node scripts/lint-architecture.mjs',
  }),
  Object.freeze({
    code: 'domain-language',
    command: 'node scripts/lint-domain-language.mjs',
  }),
  Object.freeze({
    code: 'provider-swap',
    command: 'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/v2/synthetic-provider-swap.test.mjs',
  }),
  Object.freeze({
    code: 'compiler-render-contracts',
    command: 'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --test tests/v2/synthetic-production.test.mjs',
  }),
] as const)

export type SyntheticBuildCheckCode =
  (typeof SYNTHETIC_BUILD_CHECKS)[number]['code']

export interface SyntheticBuildCheckResult {
  code: SyntheticBuildCheckCode
  command: string
  exitCode: number
  logHash: string
  startedAt: string
  completedAt: string
}

export interface SyntheticBuildIdentity {
  commitSha: string
  treeHash: string
  contractGraphHash: string
  toolchainHash: string
  renderBundleHash: string
}

export function calculateSyntheticBuildIdentityHash(
  identity: Readonly<SyntheticBuildIdentity>,
): string {
  return calculateCanonicalHash(identity)
}

export interface SyntheticBuildAttestation {
  schemaVersion: typeof SYNTHETIC_BUILD_ATTESTATION_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  productionRunId: string
  publicOperationId: string
  planSnapshotId: string
  planSnapshotHash: string
  renderManifestId: string
  renderManifestHash: string
  identity: Readonly<SyntheticBuildIdentity>
  checks: readonly Readonly<SyntheticBuildCheckResult>[]
  startedAt: string
  completedAt: string
  attestationHash: string
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40,64}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID_PATTERN.test(value),
    'INVALID_ARGUMENT',
    `${field} must be an opaque identifier`,
  )
  return value
}

function sha256(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && SHA_256_PATTERN.test(value),
    'INVALID_ARGUMENT',
    `${field} must be SHA-256`,
  )
  return value
}

function timestamp(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO timestamp`,
  )
  return value
}

export function calculateSyntheticBuildAttestationHash(
  value: Omit<SyntheticBuildAttestation, 'attestationHash'>,
): string {
  return calculateCanonicalHash(value)
}

export function assertSyntheticBuildAttestation(
  input: Readonly<SyntheticBuildAttestation>,
): Readonly<SyntheticBuildAttestation> {
  assertDomain(
    input.schemaVersion === SYNTHETIC_BUILD_ATTESTATION_SCHEMA_VERSION,
    'INVALID_ARGUMENT',
    'Synthetic build attestation schema version is unsupported',
  )
  identity(input.id, 'Synthetic build attestation id')
  identity(input.workspaceId, 'Synthetic build attestation workspaceId')
  identity(input.projectId, 'Synthetic build attestation projectId')
  identity(input.projectVersionId, 'Synthetic build attestation projectVersionId')
  sha256(input.projectVersionHash, 'Synthetic build attestation projectVersionHash')
  identity(input.productionRunId, 'Synthetic build attestation productionRunId')
  identity(input.publicOperationId, 'Synthetic build attestation publicOperationId')
  identity(input.planSnapshotId, 'Synthetic build attestation planSnapshotId')
  sha256(input.planSnapshotHash, 'Synthetic build attestation planSnapshotHash')
  identity(input.renderManifestId, 'Synthetic build attestation renderManifestId')
  sha256(input.renderManifestHash, 'Synthetic build attestation renderManifestHash')
  assertDomain(
    GIT_OBJECT_PATTERN.test(input.identity.commitSha),
    'INVALID_ARGUMENT',
    'Synthetic build attestation commitSha must be a Git object id',
  )
  sha256(input.identity.treeHash, 'Synthetic build attestation treeHash')
  sha256(input.identity.contractGraphHash, 'Synthetic build attestation contractGraphHash')
  sha256(input.identity.toolchainHash, 'Synthetic build attestation toolchainHash')
  sha256(input.identity.renderBundleHash, 'Synthetic build attestation renderBundleHash')
  const startedAt = timestamp(input.startedAt, 'Synthetic build attestation startedAt')
  const completedAt = timestamp(input.completedAt, 'Synthetic build attestation completedAt')
  assertDomain(
    Date.parse(completedAt) >= Date.parse(startedAt),
    'INVALID_ARGUMENT',
    'Synthetic build attestation completedAt precedes startedAt',
  )
  assertDomain(
    Array.isArray(input.checks) && input.checks.length === SYNTHETIC_BUILD_CHECKS.length,
    'INVALID_ARGUMENT',
    'Synthetic build attestation must contain the fixed check set',
  )
  input.checks.forEach((result, index) => {
    const expected = SYNTHETIC_BUILD_CHECKS[index]!
    assertDomain(
      result.code === expected.code && result.command === expected.command,
      'INVALID_ARGUMENT',
      'Synthetic build attestation check set or order changed',
    )
    assertDomain(
      result.exitCode === 0,
      'INVALID_ARGUMENT',
      `Synthetic build attestation check ${result.code} did not pass`,
    )
    sha256(result.logHash, `Synthetic build attestation ${result.code} logHash`)
    const checkStartedAt = timestamp(result.startedAt, `${result.code}.startedAt`)
    const checkCompletedAt = timestamp(result.completedAt, `${result.code}.completedAt`)
    assertDomain(
      Date.parse(checkStartedAt) >= Date.parse(startedAt) &&
        Date.parse(checkCompletedAt) >= Date.parse(checkStartedAt) &&
        Date.parse(checkCompletedAt) <= Date.parse(completedAt),
      'INVALID_ARGUMENT',
      `Synthetic build attestation check ${result.code} timestamps are inconsistent`,
    )
  })
  sha256(input.attestationHash, 'Synthetic build attestation attestationHash')
  const { attestationHash, ...content } = input
  assertDomain(
    calculateSyntheticBuildAttestationHash(content) === attestationHash,
    'INVALID_ARGUMENT',
    'Synthetic build attestation hash is inconsistent',
  )
  return input
}
