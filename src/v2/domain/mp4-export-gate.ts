import { stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { Mp4QualityReportV1 } from './mp4-pixel-quality.ts'
import { PIXEL_ORACLE_MODEL_IDS } from './pixel-face-oracle.ts'

/**
 * W67. The fail-closed rule of the FINAL export for the independent MP4 critic.
 *
 * The critic itself never throws on a missing oracle: a batch the OpenVINO bridge could not run leaves its frames `unknown`, and an
 * unknown is only a warning in the report. That is right for a review and wrong for a deliverable: a crashed bridge, an unwired critic, or
 * caption/CTA ink over a frame the oracle could not establish must not end in a delivered final that nobody looked at.
 *
 * The classification is made from the FACTS of every sample that carries ink (per-model read status on the source and the output frame,
 * the registration status, the number of source faces and how many were mapped onto the output, the protected regions), never from the
 * reason string of a check. A frame counts as READ only when BOTH pinned models read it.
 *
 * - Every blocker below except `MP4_CRITIC_NOT_CONFIGURED` is NOT waivable: no acknowledgement lifts it.
 * - `MP4_CRITIC_NOT_CONFIGURED` is lifted only by an explicit acknowledgement (who, when, why), which a deployment may supply outside
 *   production only (see `mp4ExportAcknowledgementFromEnvironment`); the final worker stores it as a structured record.
 * - One case is a recorded PASS, not a blocker: both models read the source and the output frame, the registration is usable and neither
 *   frame has a face (`NO_FACE_DETECTED_UNDER_INK`, informational). That is not a claim of face safety: the owner accepted V9 on 2026-10-17 for
 *   "rostos do primeiro plano, em especial o orador" (docs/quality/w62-v9-owner-acceptance.md); a background face both detectors miss is
 *   outside that scope.
 */
export type Mp4ExportBlockerCode =
  | 'MP4_CRITIC_NOT_CONFIGURED'
  | 'MP4_ORACLE_MODEL_MISSING'
  | 'MP4_ORACLE_FAILED'
  | 'MP4_GATE_FACTS_MISSING_UNDER_INK'
  | 'MP4_SOURCE_FRAME_ABSENT_UNDER_INK'
  | 'MP4_SOURCE_FRAME_UNREADABLE_UNDER_INK'
  | 'MP4_OUTPUT_FRAME_UNREADABLE_UNDER_INK'
  | 'MP4_REGISTRATION_FAILED_UNDER_INK'
  | 'MP4_SOURCE_FACE_UNMAPPED_UNDER_INK'
  | 'MP4_FACE_INTERSECTS_INK'

export type Mp4ExportAcknowledgement = Readonly<{ actor: string; recordedAt: string; reason: string }>

export type Mp4ExportBlocker = Readonly<{ code: Mp4ExportBlockerCode; detail: string; waivable: boolean; waived: boolean }>
export type Mp4ExportInformation = Readonly<{ code: 'NO_FACE_DETECTED_UNDER_INK'; detail: string; sampledFrames: number; models: readonly string[] }>

export type Mp4ExportGate = Readonly<{
  allowed: boolean
  blockers: readonly Mp4ExportBlocker[]
  /** What was recorded without blocking. */
  informational: readonly Mp4ExportInformation[]
  acknowledgement: Mp4ExportAcknowledgement | null
  /** Short and free of the acknowledgement's free text; the full record is the structured one. */
  message: string
}>

const WAIVABLE: ReadonlySet<Mp4ExportBlockerCode> = new Set(['MP4_CRITIC_NOT_CONFIGURED'])

/** An acknowledgement is an actor, a canonical UTC instant and a reason of at least ten characters; anything else is not one. */
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

type Reads = Readonly<Record<string, 'observed' | 'unknown'>> | null | undefined
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0
const readByEveryModel = (reads: Reads): boolean => Boolean(reads) && PIXEL_ORACLE_MODEL_IDS.every((id) => reads![id] === 'observed')

/**
 * `report` is the verified report of the delivered file, or null when no critic ran for it (not wired). The result lists every blocker;
 * `allowed` is true only when there is none, or the only one is `MP4_CRITIC_NOT_CONFIGURED` and an acknowledgement is present.
 */
export function mp4ExportGate(input: Readonly<{ report: Readonly<Mp4QualityReportV1> | null; acknowledgement?: Mp4ExportAcknowledgement | null }>): Mp4ExportGate {
  const acknowledgement = input.acknowledgement ? parseMp4ExportAcknowledgement(input.acknowledgement) : null
  const found = new Map<Mp4ExportBlockerCode, string>()
  const informational: Mp4ExportInformation[] = []
  const { report } = input
  if (report === null) {
    found.set('MP4_CRITIC_NOT_CONFIGURED', 'no MP4 pixel critic is wired for this final')
  } else {
    // Both pinned detectors (exact ids) must be pinned by the report: the frame facts claim "both models read it", which a report pinning one cannot back.
    const unpinned = PIXEL_ORACLE_MODEL_IDS.filter((id) => !report.oracle.models.some((model) => model.id === id))
    if (unpinned.length > 0) found.set('MP4_ORACLE_MODEL_MISSING', report.oracle.models.length === 0 ? 'the report pins no face-detection model' : `the report does not pin the face-detection model(s) ${unpinned.join(', ')}`)
    const failures = report.oracle.failures ?? []
    if (failures.length > 0) found.set('MP4_ORACLE_FAILED', `the face oracle could not run (${failures.join(', ')})`)
    const frames = new Map<Mp4ExportBlockerCode, number>()
    const bump = (code: Mp4ExportBlockerCode) => frames.set(code, (frames.get(code) ?? 0) + 1)
    let noFaceFrames = 0
    for (const sample of report.samples) {
      const { facts } = sample
      if (facts.caption.pixels === 0 && facts.cta.pixels === 0) continue
      const oracle = facts.oracle
      if (oracle.outputReads === undefined || oracle.sourceReads === undefined || oracle.registrationStatus === undefined || !isCount(oracle.sourceFaceCount) || !isCount(oracle.outputFaceCount) || !isCount(oracle.mappedSourceFaces)) { bump('MP4_GATE_FACTS_MISSING_UNDER_INK'); continue }
      let blocked = false
      const block = (code: Mp4ExportBlockerCode) => { bump(code); blocked = true }
      if (!readByEveryModel(oracle.outputReads)) block('MP4_OUTPUT_FRAME_UNREADABLE_UNDER_INK')
      if (oracle.sourceReads === null) block('MP4_SOURCE_FRAME_ABSENT_UNDER_INK')
      else if (!readByEveryModel(oracle.sourceReads)) block('MP4_SOURCE_FRAME_UNREADABLE_UNDER_INK')
      else if (oracle.registrationStatus !== 'ok') block('MP4_REGISTRATION_FAILED_UNDER_INK')
      else if (oracle.mappedSourceFaces < oracle.sourceFaceCount) block('MP4_SOURCE_FACE_UNMAPPED_UNDER_INK')
      if (facts.protectedRegions.some((region) => region.captionInkPixels > 0 || region.ctaInkPixels > 0)) block('MP4_FACE_INTERSECTS_INK')
      if (!blocked && oracle.sourceFaceCount === 0 && oracle.outputFaceCount === 0) noFaceFrames += 1
    }
    const wording: Readonly<Partial<Record<Mp4ExportBlockerCode, string>>> = {
      MP4_GATE_FACTS_MISSING_UNDER_INK: 'the sample carries no read status of the models, no registration status or no valid face counts (source, output, mapped)',
      MP4_SOURCE_FRAME_ABSENT_UNDER_INK: 'no source frame maps to the frame',
      MP4_SOURCE_FRAME_UNREADABLE_UNDER_INK: 'a detector could not read the source frame',
      MP4_OUTPUT_FRAME_UNREADABLE_UNDER_INK: 'a detector could not read the output frame',
      MP4_REGISTRATION_FAILED_UNDER_INK: 'the registration of source to output was not usable',
      MP4_SOURCE_FACE_UNMAPPED_UNDER_INK: 'a face detected on the source is not mapped onto the output',
      MP4_FACE_INTERSECTS_INK: 'a detected face intersects the ink',
    }
    for (const [code, count] of frames) found.set(code, `${count} sampled frame(s) carry caption or CTA ink and ${wording[code]}`)
    if (noFaceFrames > 0) {
      informational.push(Object.freeze({
        code: 'NO_FACE_DETECTED_UNDER_INK' as const, sampledFrames: noFaceFrames, models: Object.freeze([...PIXEL_ORACLE_MODEL_IDS]),
        detail: `${noFaceFrames} sampled frame(s) carry caption or CTA ink; both models read the source and the output frame, the registration is usable and neither frame has a face (not a claim of face safety)`,
      }))
    }
  }
  const blockers = Object.freeze([...found].map(([code, detail]) => {
    const waivable = WAIVABLE.has(code)
    return Object.freeze({ code, detail, waivable, waived: waivable && acknowledgement !== null })
  }))
  const allowed = blockers.every((blocker) => blocker.waived)
  const names = blockers.map((blocker) => `${blocker.code} (${blocker.detail})`).join('; ')
  const message = blockers.length === 0
    ? informational.length > 0 ? `${informational[0]!.code} (${informational[0]!.sampledFrames} sampled frame(s), models ${informational[0]!.models.join(' + ')})` : 'The MP4 critic had the evidence it needs for this variant.'
    : allowed
      ? `${names}; acknowledged by ${acknowledgement!.actor.slice(0, 40)} at ${acknowledgement!.recordedAt}`
      : `${names}; a final is not delivered unverified${blockers.every((blocker) => blocker.waivable) ? ' without an explicit acknowledgement (actor, time, reason)' : ''}`
  return Object.freeze({ allowed, blockers, informational: Object.freeze(informational), acknowledgement, message: message.slice(0, 420) })
}

export const MP4_CRITIC_ACK_VARIABLES = Object.freeze(['APOLLO_V2_MP4_CRITIC_ACK_ACTOR', 'APOLLO_V2_MP4_CRITIC_ACK_AT', 'APOLLO_V2_MP4_CRITIC_ACK_REASON'] as const)

/** Mirrors `resolveApiEnvironment()` of the public API (it reads process.env; a factory may be handed another environment). */
export function apiEnvironmentOf(environment: Readonly<Record<string, string | undefined>>): 'sandbox' | 'production' {
  const configured = environment.APOLLO_API_ENVIRONMENT
  if (!configured) return environment.NODE_ENV === 'production' ? 'production' : 'sandbox'
  assertDomain(configured === 'sandbox' || configured === 'production', 'INVALID_ARGUMENT', 'APOLLO_API_ENVIRONMENT is invalid')
  return configured
}

/**
 * The acknowledgement a deployment records in three variables, all or none. It lifts only `MP4_CRITIC_NOT_CONFIGURED`, and only OUTSIDE
 * production: in production an acknowledgement in the environment throws, because a deployment-wide bypass is not an acknowledgement of
 * anything in particular. A malformed or partial one throws instead of acknowledging.
 */
export function mp4ExportAcknowledgementFromEnvironment(environment: Readonly<Record<string, string | undefined>>): Mp4ExportAcknowledgement | null {
  const values = MP4_CRITIC_ACK_VARIABLES.map((name) => environment[name]?.trim())
  if (values.every((value) => !value)) return null
  assertDomain(apiEnvironmentOf(environment) !== 'production', 'PERSISTENCE_NOT_CONFIGURED', `${MP4_CRITIC_ACK_VARIABLES.join(', ')} cannot be set in production: configure the MP4 critic instead`)
  assertDomain(values.every((value) => Boolean(value)), 'PERSISTENCE_NOT_CONFIGURED', `The MP4 critic acknowledgement needs all of ${MP4_CRITIC_ACK_VARIABLES.join(', ')} or none`)
  return parseMp4ExportAcknowledgement({ actor: values[0], recordedAt: values[1], reason: values[2] })
}

export type Mp4ExportAcknowledgementRecordV1 = Readonly<{
  schemaVersion: 'mp4-export-acknowledgement/v1'
  actor: string
  recordedAt: string
  reason: string
  workspaceId: string
  projectId: string
  variantId: string
  outputSpecId: string
  operationId: string
  /** The sealed MP4 critic report the acknowledgement was given over, or null when no critic ran. */
  reportHash: string | null
  liftedBlockers: readonly Mp4ExportBlockerCode[]
}>

/** The structured record of an acknowledgement that was USED to deliver a final (none is written when nothing was lifted). */
export function mp4ExportAcknowledgementRecord(input: Readonly<{
  gate: Mp4ExportGate
  workspaceId: string
  projectId: string
  variantId: string
  outputSpecId: string
  operationId: string
  reportHash: string | null
}>): Readonly<{ record: Mp4ExportAcknowledgementRecordV1; text: string }> | null {
  const lifted = input.gate.blockers.filter((blocker) => blocker.waived).map((blocker) => blocker.code)
  if (!input.gate.allowed || input.gate.acknowledgement === null || lifted.length === 0) return null
  const record: Mp4ExportAcknowledgementRecordV1 = Object.freeze({
    schemaVersion: 'mp4-export-acknowledgement/v1', actor: input.gate.acknowledgement.actor, recordedAt: input.gate.acknowledgement.recordedAt, reason: input.gate.acknowledgement.reason,
    workspaceId: input.workspaceId, projectId: input.projectId, variantId: input.variantId, outputSpecId: input.outputSpecId, operationId: input.operationId,
    reportHash: input.reportHash, liftedBlockers: Object.freeze(lifted),
  })
  return Object.freeze({ record, text: stableSerialize(record) })
}
