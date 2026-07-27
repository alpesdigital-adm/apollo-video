import type {
  CreateScriptAlignmentRequest,
} from '../application/script-alignments.ts'
import { DomainError } from '../domain/errors.ts'
import {
  SCRIPT_BLOCK_ROLES,
  type ScriptAlignmentReviewDecision,
  type ScriptAlignmentRun,
  type ScriptBlockRole,
} from '../domain/script-alignment.ts'

function record(value: unknown, field: string): Record<string, unknown> {
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
  const unknown = Object.keys(value).filter((key) =>
    !allowed.includes(key))
  if (unknown.length) {
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
) {
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

function array(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
) {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain ${minimum} to ${maximum} entries`,
    )
  }
  return value
}

function role(value: unknown, field: string): ScriptBlockRole {
  const result = string(value, field, 3, 32) as ScriptBlockRole
  if (!SCRIPT_BLOCK_ROLES.includes(result)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is not a supported script role`,
    )
  }
  return result
}

export function parseCreateScriptAlignmentBody(
  raw: unknown,
): Omit<
  CreateScriptAlignmentRequest,
  'workspaceId' | 'batchId' | 'actor' | 'idempotencyKey'
> {
  const body = record(raw, 'body')
  exactFields(body, ['title', 'locale', 'rawText', 'sources'], 'body')
  const sources = array(body.sources, 'sources', 1, 50)
    .map((entry, index) => {
      const source = record(entry, `sources[${index}]`)
      exactFields(
        source,
        ['transcriptId', 'expectedTranscriptHash', 'roleHint'],
        `sources[${index}]`,
      )
      return Object.freeze({
        transcriptId: string(
          source.transcriptId,
          `sources[${index}].transcriptId`,
          3,
          128,
        ),
        expectedTranscriptHash: string(
          source.expectedTranscriptHash,
          `sources[${index}].expectedTranscriptHash`,
          64,
          64,
        ),
        ...(source.roleHint !== undefined
          ? {
              roleHint: role(
                source.roleHint,
                `sources[${index}].roleHint`,
              ),
            }
          : {}),
      })
    })
  return Object.freeze({
    title: string(body.title, 'title', 2, 200),
    locale: string(body.locale, 'locale', 2, 35),
    rawText: string(body.rawText, 'rawText', 3, 500_000),
    sources: Object.freeze(sources),
  })
}

export function parseScriptAlignmentReviewBody(raw: unknown): Readonly<{
  expectedRevision: number
  decisions: readonly Readonly<ScriptAlignmentReviewDecision>[]
}> {
  const body = record(raw, 'body')
  exactFields(body, ['expectedRevision', 'decisions'], 'body')
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 1 ||
    Number(body.expectedRevision) > 1_000_000
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'expectedRevision must be an integer between 1 and 1,000,000',
    )
  }
  const decisions = array(body.decisions, 'decisions', 1, 500)
    .map((entry, index) => {
      const decision = record(entry, `decisions[${index}]`)
      const targetKind = string(
        decision.targetKind,
        `decisions[${index}].targetKind`,
        3,
        32,
      )
      if (targetKind === 'block') {
        exactFields(
          decision,
          [
            'targetKind',
            'blockId',
            'resolution',
            'candidateId',
            'note',
          ],
          `decisions[${index}]`,
        )
        const resolution = string(
          decision.resolution,
          `decisions[${index}].resolution`,
          3,
          32,
        )
        if (
          !['accept', 'mark-missing', 'select-alternative']
            .includes(resolution)
        ) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            `decisions[${index}].resolution is invalid`,
          )
        }
        return Object.freeze({
          targetKind: 'block' as const,
          blockId: string(
            decision.blockId,
            `decisions[${index}].blockId`,
            3,
            128,
          ),
          resolution: resolution as
            'accept' | 'mark-missing' | 'select-alternative',
          ...(decision.candidateId !== undefined
            ? {
                candidateId: string(
                  decision.candidateId,
                  `decisions[${index}].candidateId`,
                  3,
                  128,
                ),
              }
            : {}),
          ...(decision.note !== undefined
            ? {
                note: string(
                  decision.note,
                  `decisions[${index}].note`,
                  1,
                  1_000,
                ),
              }
            : {}),
        })
      }
      if (targetKind === 'extra-take') {
        exactFields(
          decision,
          ['targetKind', 'extraTakeId', 'resolution', 'note'],
          `decisions[${index}]`,
        )
        const resolution = string(
          decision.resolution,
          `decisions[${index}].resolution`,
          3,
          32,
        )
        if (!['accept-extra', 'reject-extra'].includes(resolution)) {
          throw new DomainError(
            'INVALID_ARGUMENT',
            `decisions[${index}].resolution is invalid`,
          )
        }
        return Object.freeze({
          targetKind: 'extra-take' as const,
          extraTakeId: string(
            decision.extraTakeId,
            `decisions[${index}].extraTakeId`,
            3,
            128,
          ),
          resolution: resolution as 'accept-extra' | 'reject-extra',
          ...(decision.note !== undefined
            ? {
                note: string(
                  decision.note,
                  `decisions[${index}].note`,
                  1,
                  1_000,
                ),
              }
            : {}),
        })
      }
      throw new DomainError(
        'INVALID_ARGUMENT',
        `decisions[${index}].targetKind is invalid`,
      )
    })
  return Object.freeze({
    expectedRevision: Number(body.expectedRevision),
    decisions: Object.freeze(decisions),
  })
}

export function presentScriptAlignmentRun(
  run: Readonly<ScriptAlignmentRun>,
) {
  return run
}

export function presentScriptAlignmentPage(input: {
  runs: readonly Readonly<ScriptAlignmentRun>[]
  nextCursor?: string
}) {
  return Object.freeze({
    alignments: Object.freeze(
      input.runs.map(presentScriptAlignmentRun),
    ),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  })
}
