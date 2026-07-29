import type {
  PersistedProofModeRun,
  ProofModeRunPage,
} from '../application/ports/proof-mode-repository.ts'
import { DomainError } from '../domain/errors.ts'
import {
  PROOF_MODES,
  PROOF_RHYTHMS,
  type ProofModeOverride,
} from '../domain/proof-mode.ts'
import {
  OUTPUT_ASPECT_RATIOS,
  type OutputAspectRatio,
} from '../domain/output-spec.ts'

function record(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an object`,
    )
  }
  return value as Record<string, unknown>
}

function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
) {
  const unknown = Object.keys(value)
    .filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} contains unknown fields`,
      { fields: unknown },
    )
  }
}

function string(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < minimum ||
    value.trim().length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain ${minimum} to ${maximum} characters`,
    )
  }
  return value.trim()
}

function sha256(value: unknown, field: string): string {
  const normalized = string(value, field, 64, 64)
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be a lowercase SHA-256`,
    )
  }
  return normalized
}

function override(
  value: unknown,
  index: number,
): Readonly<ProofModeOverride> {
  const field = `overrides[${index}]`
  const input = record(value, field)
  exactFields(
    input,
    [
      'proofNeedItemId',
      'format',
      'mode',
      'expectedEvaluationHash',
    ],
    field,
  )
  const format = string(input.format, `${field}.format`, 3, 5)
  const mode = string(input.mode, `${field}.mode`, 3, 32)
  if (!OUTPUT_ASPECT_RATIOS.includes(format as OutputAspectRatio)) {
    throw new DomainError(
      'INVALID_OUTPUT_SPEC',
      `${field}.format is unsupported`,
    )
  }
  if (!PROOF_MODES.includes(mode as typeof PROOF_MODES[number])) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field}.mode is unsupported`,
    )
  }
  return Object.freeze({
    proofNeedItemId: string(
      input.proofNeedItemId,
      `${field}.proofNeedItemId`,
      3,
      128,
    ),
    format: format as OutputAspectRatio,
    mode: mode as typeof PROOF_MODES[number],
    expectedEvaluationHash: sha256(
      input.expectedEvaluationHash,
      `${field}.expectedEvaluationHash`,
    ),
  })
}

export function parseCreateProofModeBody(raw: unknown) {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'proofIntegrityRunId',
      'expectedProofIntegrityRunHash',
      'policyVersion',
      'formats',
      'rhythm',
      'overrides',
    ],
    'body',
  )
  if (
    !Array.isArray(body.formats) ||
    body.formats.length < 1 ||
    body.formats.length > OUTPUT_ASPECT_RATIOS.length
  ) {
    throw new DomainError(
      'INVALID_OUTPUT_SPEC',
      'formats must contain one to five entries',
    )
  }
  const formats = body.formats.map((value, index) => {
    const format = string(value, `formats[${index}]`, 3, 5)
    if (!OUTPUT_ASPECT_RATIOS.includes(format as OutputAspectRatio)) {
      throw new DomainError(
        'INVALID_OUTPUT_SPEC',
        `formats[${index}] is unsupported`,
      )
    }
    return format as OutputAspectRatio
  })
  if (
    !Array.isArray(body.overrides) ||
    body.overrides.length > 80
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'overrides must contain at most eighty entries',
    )
  }
  const rhythm = string(body.rhythm, 'rhythm', 3, 16)
  if (!PROOF_RHYTHMS.includes(rhythm as typeof PROOF_RHYTHMS[number])) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'rhythm is unsupported',
    )
  }
  return Object.freeze({
    proofIntegrityRunId: string(
      body.proofIntegrityRunId,
      'proofIntegrityRunId',
      3,
      128,
    ),
    expectedProofIntegrityRunHash: sha256(
      body.expectedProofIntegrityRunHash,
      'expectedProofIntegrityRunHash',
    ),
    policyVersion: string(
      body.policyVersion,
      'policyVersion',
      3,
      64,
    ),
    formats: Object.freeze(formats),
    rhythm: rhythm as typeof PROOF_RHYTHMS[number],
    overrides: Object.freeze(body.overrides.map(override)),
  })
}

export function presentProofModeRun(
  value: Readonly<PersistedProofModeRun>,
) {
  const {
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    ...run
  } = value
  return Object.freeze(run)
}

export function presentProofModeRunPage(
  page: Readonly<ProofModeRunPage>,
) {
  return Object.freeze({
    runs: Object.freeze(page.runs.map(presentProofModeRun)),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  })
}
