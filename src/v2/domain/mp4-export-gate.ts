import { assertDomain } from './errors.ts'
import type { Mp4QualityReportV1 } from './mp4-pixel-quality.ts'

/**
 * W67. The fail-closed rule of the FINAL export for the independent MP4 critic.
 *
 * The critic itself never throws on a missing oracle: a batch the OpenVINO bridge could not run leaves its frames `unknown`, and an
 * unknown is only a warning in the report (it is not a pass, but it is not a block either). That is right for a review, and wrong for a
 * deliverable: a crashed bridge, an unwired critic or a stretch of caption/CTA ink over frames the oracle could not read must not end in
 * a delivered final that nobody looked at. Here every such case is a BLOCKER. A blocker is lifted only by an explicit acknowledgement that
 * records who accepted it, when and why, and only the two blockers that are a statement about the deployment or about the footage can be
 * acknowledged (no critic configured; no face anywhere in a frame that carries ink). A crashed oracle never can.
 */
export type Mp4ExportBlockerCode =
  | 'MP4_CRITIC_NOT_CONFIGURED'
  | 'MP4_ORACLE_MODEL_MISSING'
  | 'MP4_ORACLE_FAILED'
  | 'MP4_FACE_ORACLE_UNREADABLE_UNDER_INK'
  | 'MP4_FACE_EVIDENCE_ABSENT_UNDER_INK'

export type Mp4ExportAcknowledgement = Readonly<{ actor: string; recordedAt: string; reason: string }>

export type Mp4ExportBlocker = Readonly<{ code: Mp4ExportBlockerCode; detail: string; waivable: boolean; waived: boolean }>

export type Mp4ExportGate = Readonly<{
  allowed: boolean
  blockers: readonly Mp4ExportBlocker[]
  acknowledgement: Mp4ExportAcknowledgement | null
  message: string
}>

const WAIVABLE: ReadonlySet<Mp4ExportBlockerCode> = new Set(['MP4_CRITIC_NOT_CONFIGURED', 'MP4_FACE_EVIDENCE_ABSENT_UNDER_INK'])

/** An acknowledgement is an actor, a canonical UTC instant and a reason of at least a sentence's worth; anything else is not one. */
export function parseMp4ExportAcknowledgement(value: unknown): Mp4ExportAcknowledgement {
  const candidate = value as Partial<Record<keyof Mp4ExportAcknowledgement, unknown>> | null
  assertDomain(candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate), 'INVALID_ARGUMENT', 'The MP4 critic acknowledgement must be an object')
  assertDomain(Object.keys(candidate).toSorted().join(',') === 'actor,reason,recordedAt', 'INVALID_ARGUMENT', 'The MP4 critic acknowledgement carries exactly actor, recordedAt and reason')
  const { actor, recordedAt, reason } = candidate
  assertDomain(typeof actor === 'string' && /^[^\p{Cc}]{1,120}$/u.test(actor.trim()) && actor.trim().length > 0, 'INVALID_ARGUMENT', 'The MP4 critic acknowledgement needs an actor')
  assertDomain(typeof recordedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(recordedAt) && Number.isFinite(Date.parse(recordedAt)) && new Date(recordedAt).toISOString() === recordedAt, 'INVALID_ARGUMENT', 'The MP4 critic acknowledgement needs a canonical UTC instant')
  assertDomain(typeof reason === 'string' && /^[^\p{Cc}]{10,300}$/u.test(reason.trim()), 'INVALID_ARGUMENT', 'The MP4 critic acknowledgement needs a reason of at least 10 characters')
  return Object.freeze({ actor: actor.trim(), recordedAt, reason: reason.trim() })
}

/**
 * `report` is the verified report of the delivered file, or null when no critic ran for it (not wired). The result lists every blocker;
 * `allowed` is true only when every blocker is waivable and an acknowledgement is present.
 */
export function mp4ExportGate(input: Readonly<{ report: Readonly<Mp4QualityReportV1> | null; acknowledgement?: Mp4ExportAcknowledgement | null }>): Mp4ExportGate {
  const acknowledgement = input.acknowledgement ? parseMp4ExportAcknowledgement(input.acknowledgement) : null
  const found: Array<{ code: Mp4ExportBlockerCode; detail: string }> = []
  const { report } = input
  if (report === null) {
    found.push({ code: 'MP4_CRITIC_NOT_CONFIGURED', detail: 'no MP4 pixel critic is wired for this final' })
  } else {
    if (report.oracle.models.length === 0) found.push({ code: 'MP4_ORACLE_MODEL_MISSING', detail: 'the report pins no face-detection model' })
    for (const failure of report.oracle.failures ?? []) found.push({ code: 'MP4_ORACLE_FAILED', detail: `the face oracle could not run (${failure})` })
    const unreadable = new Set<number>()
    const absent = new Set<number>()
    for (const sample of report.samples) {
      for (const id of ['captionFaceOverlap', 'ctaFaceOverlap'] as const) {
        const result = sample.verdict.checks[id]
        if (result.verdict !== 'unknown') continue
        if (result.reason === 'FACE_ORACLE_UNREADABLE') unreadable.add(sample.frameIndex)
        else absent.add(sample.frameIndex)
      }
    }
    if (unreadable.size > 0) found.push({ code: 'MP4_FACE_ORACLE_UNREADABLE_UNDER_INK', detail: `${unreadable.size} sampled frame(s) carry caption or CTA ink and the face oracle could not read them` })
    if (absent.size > 0) found.push({ code: 'MP4_FACE_EVIDENCE_ABSENT_UNDER_INK', detail: `${absent.size} sampled frame(s) carry caption or CTA ink and no face evidence exists for them` })
  }
  const blockers = Object.freeze(found.map((blocker) => {
    const waivable = WAIVABLE.has(blocker.code)
    return Object.freeze({ ...blocker, waivable, waived: waivable && acknowledgement !== null })
  }))
  const allowed = blockers.every((blocker) => blocker.waived)
  const names = blockers.map((blocker) => `${blocker.code} (${blocker.detail})`).join('; ')
  const message = blockers.length === 0
    ? 'The MP4 critic had the evidence it needs for this variant.'
    : allowed
      ? `${names}; acknowledged by ${acknowledgement!.actor} at ${acknowledgement!.recordedAt}: ${acknowledgement!.reason}`
      : `${names}; ${blockers.every((blocker) => blocker.waivable) ? 'a final is not delivered unverified without an explicit acknowledgement (actor, time, reason)' : 'a final is not delivered unverified'}`
  return Object.freeze({ allowed, blockers, acknowledgement, message: message.slice(0, 500) })
}

export const MP4_CRITIC_ACK_VARIABLES = Object.freeze(['APOLLO_V2_MP4_CRITIC_ACK_ACTOR', 'APOLLO_V2_MP4_CRITIC_ACK_AT', 'APOLLO_V2_MP4_CRITIC_ACK_REASON'] as const)

/** The acknowledgement a deployment records in three variables, all or none; a malformed or partial one throws instead of acknowledging. */
export function mp4ExportAcknowledgementFromEnvironment(environment: Readonly<Record<string, string | undefined>>): Mp4ExportAcknowledgement | null {
  const values = MP4_CRITIC_ACK_VARIABLES.map((name) => environment[name]?.trim())
  if (values.every((value) => !value)) return null
  assertDomain(values.every((value) => Boolean(value)), 'PERSISTENCE_NOT_CONFIGURED', `The MP4 critic acknowledgement needs all of ${MP4_CRITIC_ACK_VARIABLES.join(', ')} or none`)
  return parseMp4ExportAcknowledgement({ actor: values[0], recordedAt: values[1], reason: values[2] })
}
