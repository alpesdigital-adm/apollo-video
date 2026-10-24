// Pure helpers of the owner journey driver (scripts/validation/w70-owner-journey.mjs): argument parsing, the shape of every
// human decision file, request templates and evidence sanitising. Nothing here talks to a server or a disk, so
// tests/v2/w70-owner-journey.test.mjs can prove it without either.
//
// Rule (ADR-160, "nada e fixo"): no editorial value lives in this module. Every video content (briefing, phrases, objective,
// corrections) comes from the files and variables the operator names; this code only checks the SHAPE of what it is given.
import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'

/** The closed set of aspect ratios of the public contract (`create-project-output-variant-request/v1`). */
export const ASPECT_RATIOS = Object.freeze(['9:16', '16:9', '4:5', '1:1', '21:9'])

export const EXIT = Object.freeze({ ok: 0, failure: 1, usage: 2, decisionTimeout: 3, ownerRejected: 4 })

export class JourneyError extends Error {
  /**
   * @param {string} code    stable machine code (USAGE, DECISION_TIMEOUT, UNEXPECTED_RESPONSE, ...)
   * @param {string} message what happened, in words an operator can act on
   * @param {object} [details]
   * @param {number} [exitCode]
   */
  constructor(code, message, details = {}, exitCode = EXIT.failure) {
    super(message)
    this.name = 'JourneyError'
    this.code = code
    this.details = details
    this.exitCode = exitCode
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0
export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex')

// --------------------------------------------------------------------------------------------------------------------
// Arguments
// --------------------------------------------------------------------------------------------------------------------

const OPTIONS = Object.freeze({
  briefing: { type: 'path', required: true, help: 'file with the exact briefing text' },
  objective: { type: 'string', help: 'strategic objective id of the catalog (optional)' },
  'desired-action': { type: 'path', help: 'JSON file with the desiredAction of the project (optional)' },
  outputs: { type: 'string', required: true, help: 'comma list of aspect ratios, for example two of 9:16,16:9,4:5,1:1,21:9' },
  'output-spec': { type: 'path', help: 'JSON file with per-ratio overrides of the output spec (width, height, fps, safeArea, locale, subtitles)' },
  setup: { type: 'path', help: 'JSON file with requests to apply after ingest and before the first Director run (optional)' },
  'project-name': { type: 'string', help: 'project name (default: w70-<run id>)' },
  locale: { type: 'string', help: 'declared language (BCP-47). Omit it and the Apollo detects the language from the speech' },
  master: { type: 'path', required: true, help: 'absolute path of the master file' },
  'master-sha256': { type: 'sha256', required: true, help: 'expected SHA-256 of the master' },
  'master-size': { type: 'int', required: true, help: 'expected size of the master in bytes' },
  'master-mime': { type: 'string', help: 'override of the detected MIME type of the master' },
  'master-file-name': { type: 'string', help: 'override of the file name sent with the upload' },
  'rights-confirmed': { type: 'bool', required: true, help: 'the owner states the rights to the master (required)' },
  evidence: { type: 'path', required: true, help: 'absolute evidence directory, outside the repository' },
  decisions: { type: 'path', required: true, help: 'absolute directory where the human decision files arrive' },
  resume: { type: 'bool', help: 'continue a journey from its journey-log.jsonl (completed phases are skipped)' },
  'run-id': { type: 'string', help: 'run id (default: generated, then read back from the log on --resume)' },
  'poll-ms': { type: 'int', min: 100, default: 5000, help: 'decision file poll interval' },
  'operation-poll-ms': { type: 'int', min: 100, default: 2000, help: 'operation poll interval' },
  'decision-timeout-ms': { type: 'int', min: 1, default: 3_600_000, help: 'how long one decision is awaited before the run stops (exit 3)' },
  'request-timeout-ms': { type: 'int', min: 1000, default: 300_000, help: 'how long one API request is awaited (a Command can take minutes on a loaded host)' },
  'operation-timeout-ms': { type: 'int', min: 1, default: 1_800_000, help: 'how long one operation is awaited' },
  'max-revisions': { type: 'int', min: 0, default: 3, help: 'revise-editorial-request rounds allowed across the journey' },
  'max-review-rounds': { type: 'int', min: 1, default: 3, help: 'proxy review rounds allowed' },
  'grant-ttl-seconds': { type: 'int', min: 1, help: 'download grant lifetime (default: the server default)' },
  ffmpeg: { type: 'string', help: 'ffmpeg executable (default: FFMPEG_PATH or ffmpeg)' },
  ffprobe: { type: 'string', help: 'ffprobe executable (default: FFPROBE_PATH or ffprobe)' },
  help: { type: 'bool', help: 'print this help' },
})

export function usage() {
  const lines = ['Usage: node scripts/validation/w70-owner-journey.mjs [options]', '',
    'Environment: APOLLO_API_BASE_URL (server URL), APOLLO_API_TOKEN (API client credential; never printed or stored).', '', 'Options:']
  for (const [name, option] of Object.entries(OPTIONS)) {
    const flag = option.type === 'bool' ? `--${name}` : `--${name} <${option.type}>`
    lines.push(`  ${flag.padEnd(34)}${option.required ? '(required) ' : ''}${option.help}${option.default !== undefined ? ` [default ${option.default}]` : ''}`)
  }
  return lines.join('\n')
}

/**
 * @param {readonly string[]} argv
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {{ repositoryRoot: string }} context
 */
export function parseArguments(argv, env, context) {
  const raw = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw new JourneyError('USAGE', `unexpected argument "${token}"`, {}, EXIT.usage)
    const name = token.slice(2)
    const option = OPTIONS[name]
    if (!option) throw new JourneyError('USAGE', `unknown option --${name}`, {}, EXIT.usage)
    if (raw.has(name)) throw new JourneyError('USAGE', `--${name} was given twice`, {}, EXIT.usage)
    if (option.type === 'bool') { raw.set(name, true); continue }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new JourneyError('USAGE', `--${name} needs a value`, {}, EXIT.usage)
    raw.set(name, value)
    index += 1
  }
  if (raw.get('help')) return { help: true }
  const values = {}
  for (const [name, option] of Object.entries(OPTIONS)) {
    if (!raw.has(name)) {
      if (option.required) throw new JourneyError('USAGE', `--${name} is required`, {}, EXIT.usage)
      if (option.default !== undefined) values[name] = option.default
      continue
    }
    const value = raw.get(name)
    if (option.type === 'bool') values[name] = true
    else if (option.type === 'int') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < (option.min ?? 0)) {
        throw new JourneyError('USAGE', `--${name} must be an integer of at least ${option.min ?? 0}`, {}, EXIT.usage)
      }
      values[name] = Number(value)
    } else if (option.type === 'sha256') {
      if (!/^[a-f0-9]{64}$/.test(value)) throw new JourneyError('USAGE', `--${name} must be 64 lowercase hex characters`, {}, EXIT.usage)
      values[name] = value
    } else if (option.type === 'path') {
      if (!isAbsolute(value)) throw new JourneyError('USAGE', `--${name} must be an absolute path`, {}, EXIT.usage)
      values[name] = resolve(value)
    } else {
      if (!nonEmptyString(value)) throw new JourneyError('USAGE', `--${name} must not be empty`, {}, EXIT.usage)
      values[name] = value
    }
  }
  const baseUrl = env.APOLLO_API_BASE_URL?.trim()
  const token = env.APOLLO_API_TOKEN?.trim()
  if (!baseUrl) throw new JourneyError('USAGE', 'APOLLO_API_BASE_URL is required', {}, EXIT.usage)
  if (!token) throw new JourneyError('USAGE', 'APOLLO_API_TOKEN is required', {}, EXIT.usage)
  let parsedUrl
  try { parsedUrl = new URL(baseUrl) } catch { throw new JourneyError('USAGE', 'APOLLO_API_BASE_URL is not a URL', {}, EXIT.usage) }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new JourneyError('USAGE', 'APOLLO_API_BASE_URL must be http or https', {}, EXIT.usage)
  if (values['rights-confirmed'] !== true) throw new JourneyError('USAGE', '--rights-confirmed is required: the owner must state the rights to the master', {}, EXIT.usage)

  // Evidence is written outside the repository (it holds the video's own content), and nothing in it may be inside the checkout.
  for (const name of ['evidence', 'decisions']) {
    const inside = !relative(context.repositoryRoot, values[name]).startsWith('..') && !isAbsolute(relative(context.repositoryRoot, values[name]))
    if (inside) throw new JourneyError('USAGE', `--${name} must be outside the repository (${context.repositoryRoot})`, {}, EXIT.usage)
  }
  if (values.evidence === values.decisions) throw new JourneyError('USAGE', '--evidence and --decisions must be different directories', {}, EXIT.usage)

  return Object.freeze({
    ...values,
    help: false,
    resume: values.resume === true,
    apiBaseUrl: parsedUrl.origin + parsedUrl.pathname.replace(/\/+$/, ''),
    apiToken: token,
    outputKeys: parseOutputs(values.outputs),
    ffmpeg: values.ffmpeg ?? env.FFMPEG_PATH?.trim() ?? 'ffmpeg',
    ffprobe: values.ffprobe ?? env.FFPROBE_PATH?.trim() ?? 'ffprobe',
  })
}

/** `--outputs 9:16,16:9`: one output per aspect ratio (two outputs of one ratio are ambiguous for the product), in the order given. */
export function parseOutputs(text) {
  const keys = String(text).split(',').map((item) => item.trim())
  if (keys.length === 0 || keys.some((key) => key === '')) throw new JourneyError('USAGE', '--outputs must be a comma list of aspect ratios', {}, EXIT.usage)
  for (const key of keys) {
    if (!ASPECT_RATIOS.includes(key)) throw new JourneyError('USAGE', `--outputs: "${key}" is not an aspect ratio of the contract (${ASPECT_RATIOS.join(', ')})`, {}, EXIT.usage)
  }
  if (new Set(keys).size !== keys.length) throw new JourneyError('USAGE', '--outputs: an aspect ratio may appear only once', {}, EXIT.usage)
  return Object.freeze(keys)
}

// --------------------------------------------------------------------------------------------------------------------
// Output specs
// --------------------------------------------------------------------------------------------------------------------

const SAFE_AREA_SIDES = ['top', 'right', 'bottom', 'left']
const evenAtLeastTwo = (value) => Math.max(2, 2 * Math.round(value / 2))

/**
 * The create-output-variant body of one output. `preset` is the product's own format preset for the ratio (width, height, fps, safe
 * area); `override` is the operator's per-ratio entry of `--output-spec`. The delivery profile's encoder fields are constants of the
 * published contract (`materialized-delivery-profile/v1`); the proxy is half the final canvas. Subtitles are `none` unless the
 * operator's spec says otherwise: a caption nobody asked for is not drawn (ADR-160, minimal-intervention).
 */
export function buildVariantBody({ ratio, preset, override = {}, locale, baseVersionId, baseHash, reason }) {
  const allowed = ['width', 'height', 'fps', 'safeArea', 'locale', 'subtitles']
  const unknown = Object.keys(override).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new JourneyError('USAGE', `--output-spec["${ratio}"] has unknown fields: ${unknown.join(', ')}`, {}, EXIT.usage)
  const pick = (name) => override[name] ?? preset?.[name]
  const width = pick('width')
  const height = pick('height')
  const fps = pick('fps')
  const safeArea = pick('safeArea')
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2) {
    throw new JourneyError('USAGE', `output ${ratio}: width and height must be integers of at least 2`, {}, EXIT.usage)
  }
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new JourneyError('USAGE', `output ${ratio}: fps must be an integer from 1 to 120`, {}, EXIT.usage)
  if (!isRecord(safeArea) || SAFE_AREA_SIDES.some((side) => typeof safeArea[side] !== 'number' || safeArea[side] < 0 || safeArea[side] >= 0.5)) {
    throw new JourneyError('USAGE', `output ${ratio}: safeArea needs top, right, bottom, left, each from 0 up to (not including) 0.5`, {}, EXIT.usage)
  }
  const outputLocale = override.locale ?? locale ?? 'und'
  const subtitles = override.subtitles === undefined ? { mode: 'none', configuration: null, fontAssets: [] } : override.subtitles
  if (!isRecord(subtitles) || !['none', 'burn-in', 'sidecar'].includes(subtitles.mode)) {
    throw new JourneyError('USAGE', `output ${ratio}: subtitles.mode must be none, burn-in or sidecar`, {}, EXIT.usage)
  }
  const proxyWidth = evenAtLeastTwo(width / 2)
  const proxyHeight = evenAtLeastTwo(height / 2)
  const profileId = `profile-${ratio.replace(':', 'x')}-${width}x${height}`
  const audio = (bitrateKbps) => ({ codec: 'aac', bitrateKbps, sampleRateHz: 48000, channels: 1 })
  return {
    baseVersionId,
    baseHash,
    ...(reason ? { reason } : {}),
    output: { locale: outputLocale, aspectRatio: ratio, width, height, fps, safeArea, deliveryProfileId: profileId },
    profile: {
      schemaVersion: 'materialized-delivery-profile/v1', id: profileId, version: 1, rendererContractVersion: 'ffmpeg-editorial-output/v1',
      final: { codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', container: 'mp4', faststart: true, width, height, fps, quality: { mode: 'crf', value: 18, preset: 'medium' }, audio: audio(192) },
      proxy: { codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', container: 'mp4', faststart: true, width: proxyWidth, height: proxyHeight, fps, quality: { mode: 'crf', value: 23, preset: 'veryfast' }, audio: audio(160) },
      proxyToFinal: { schemaVersion: 'output-canvas-transform/v1', scaleX: width / proxyWidth, scaleY: height / proxyHeight },
      subtitles: { mode: subtitles.mode, configuration: subtitles.configuration ?? null, fontAssets: subtitles.fontAssets ?? [] },
    },
    preset: null,
  }
}

/** The per-ratio overrides file: an object keyed by aspect ratio, each an object. Keys that are not requested outputs are refused. */
export function parseOutputSpecFile(raw, outputKeys) {
  if (!isRecord(raw)) throw new JourneyError('USAGE', '--output-spec must be a JSON object keyed by aspect ratio', {}, EXIT.usage)
  for (const [key, value] of Object.entries(raw)) {
    if (!outputKeys.includes(key)) throw new JourneyError('USAGE', `--output-spec: "${key}" is not one of the requested outputs (${outputKeys.join(', ')})`, {}, EXIT.usage)
    if (!isRecord(value)) throw new JourneyError('USAGE', `--output-spec["${key}"] must be an object`, {}, EXIT.usage)
  }
  return raw
}

// --------------------------------------------------------------------------------------------------------------------
// Master container
// --------------------------------------------------------------------------------------------------------------------

/** The MIME type and extension an ISO-BMFF file declares in its `ftyp` box (a ".mp4" can really be QuickTime). `null` when it is not ISO-BMFF. */
export function detectContainer(head) {
  if (head.length < 12 || head.subarray(4, 8).toString('ascii') !== 'ftyp') return null
  const brand = head.subarray(8, 12).toString('ascii')
  return brand === 'qt  ' ? { brand, mimeType: 'video/quicktime', extension: 'mov' } : { brand, mimeType: 'video/mp4', extension: 'mp4' }
}

// --------------------------------------------------------------------------------------------------------------------
// Decision files
// --------------------------------------------------------------------------------------------------------------------

function rejectUnknown(name, record, allowed) {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) throw new JourneyError('INVALID_DECISION', `decision "${name}" has unknown fields: ${unknown.join(', ')}`)
}

function requireReason(name, record) {
  if (!nonEmptyString(record.reason)) throw new JourneyError('INVALID_DECISION', `decision "${name}" needs a non-empty "reason"`)
  return record.reason.trim()
}

const REQUEST_METHODS = ['POST', 'PUT']
const REQUEST_KEYS = ['method', 'path', 'body', 'ifMatch', 'expect', 'note']

/**
 * A list of API requests a human decision asks the driver to make, exactly as written. Strings that are a whole `{{...}}` token are
 * substituted at the time of the request (see `substitute`); the path must stay inside `/v1/` and the host is always the driver's.
 */
export function parseRequests(name, value) {
  if (!Array.isArray(value) || value.length === 0) throw new JourneyError('INVALID_DECISION', `decision "${name}": "requests" must be a non-empty list`)
  return value.map((entry, index) => {
    const where = `decision "${name}" requests[${index}]`
    if (!isRecord(entry)) throw new JourneyError('INVALID_DECISION', `${where} must be an object`)
    rejectUnknown(where, entry, REQUEST_KEYS)
    if (!REQUEST_METHODS.includes(entry.method)) throw new JourneyError('INVALID_DECISION', `${where}: method must be ${REQUEST_METHODS.join(' or ')}`)
    if (typeof entry.path !== 'string' || !entry.path.startsWith('/v1/') || entry.path.includes('..') || entry.path.includes('//') || /\s/.test(entry.path)) {
      throw new JourneyError('INVALID_DECISION', `${where}: path must be a relative /v1/ path`)
    }
    if (entry.body !== undefined && !isRecord(entry.body)) throw new JourneyError('INVALID_DECISION', `${where}: body must be an object`)
    if (entry.ifMatch !== undefined && !nonEmptyString(entry.ifMatch)) throw new JourneyError('INVALID_DECISION', `${where}: ifMatch must be a string`)
    if (entry.expect !== undefined && (!Array.isArray(entry.expect) || entry.expect.length === 0 || !entry.expect.every((status) => Number.isInteger(status) && status >= 200 && status < 300))) {
      throw new JourneyError('INVALID_DECISION', `${where}: expect must be a list of 2xx statuses`)
    }
    return Object.freeze({ method: entry.method, path: entry.path, ...(entry.body ? { body: entry.body } : {}), ...(entry.ifMatch ? { ifMatch: entry.ifMatch } : {}), ...(entry.expect ? { expect: entry.expect } : {}) })
  })
}

const REVISION_FIELDS = ['briefing', 'directives', 'variantOverrides', 'desiredAction', 'answers', 'objective']

export const DECISION_PARSERS = Object.freeze({
  /** revise-editorial-request: each present field replaces that part of the request, exactly as the Command defines it. */
  'revise-editorial-request': (record, name) => {
    rejectUnknown(name, record, ['reason', ...REVISION_FIELDS])
    const reason = requireReason(name, record)
    const body = Object.fromEntries(REVISION_FIELDS.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]))
    if (Object.keys(body).length === 0) throw new JourneyError('INVALID_DECISION', `decision "${name}" must change at least one of: ${REVISION_FIELDS.join(', ')}`)
    if (body.briefing !== undefined && body.briefing !== null && !nonEmptyString(body.briefing)) throw new JourneyError('INVALID_DECISION', `decision "${name}": briefing must be text or null`)
    return Object.freeze({ reason, body: Object.freeze(body) })
  },
  /** remove-spoken-content: `{ skip: true, reason }` or the rules (phrases and alternatives), requested through the named output. */
  'remove-spoken-content': (record, name, context) => {
    if (record.skip !== undefined) {
      rejectUnknown(name, record, ['skip', 'reason'])
      if (record.skip !== true) throw new JourneyError('INVALID_DECISION', `decision "${name}": skip, when present, must be true`)
      return Object.freeze({ skip: true, reason: requireReason(name, record) })
    }
    rejectUnknown(name, record, ['variant', 'rules', 'exclusionOverrides', 'reason'])
    // The cut is one Command on the project's single EditPlan (every output re-materialises from it); `variant` names the output it is requested through.
    if (typeof record.variant !== 'string' || !context.outputKeys.includes(record.variant)) {
      throw new JourneyError('INVALID_DECISION', `decision "${name}": "variant" must name one output of the journey (${context.outputKeys.join(', ')})`)
    }
    if (!Array.isArray(record.rules) || record.rules.length === 0) throw new JourneyError('INVALID_DECISION', `decision "${name}": "rules" must be a non-empty list`)
    for (const [index, rule] of record.rules.entries()) {
      if (!isRecord(rule) || !nonEmptyString(rule.id) || !nonEmptyString(rule.label) || !Array.isArray(rule.alternatives) || rule.alternatives.length === 0 || !rule.alternatives.every(nonEmptyString)) {
        throw new JourneyError('INVALID_DECISION', `decision "${name}": rules[${index}] needs id, label and a non-empty list of alternatives`)
      }
      rejectUnknown(`${name} rules[${index}]`, rule, ['id', 'label', 'alternatives'])
    }
    if (record.exclusionOverrides !== undefined && !Array.isArray(record.exclusionOverrides)) throw new JourneyError('INVALID_DECISION', `decision "${name}": exclusionOverrides must be a list`)
    return Object.freeze({
      variant: record.variant, rules: record.rules,
      ...(record.exclusionOverrides ? { exclusionOverrides: record.exclusionOverrides } : {}),
      ...(nonEmptyString(record.reason) ? { reason: record.reason.trim() } : {}),
    })
  },
  /** source-rights: the body of PUT /v1/artifacts/{id}/rights, as the owner states it. */
  'source-rights': (record, name) => {
    rejectUnknown(name, record, ['body', 'reason'])
    if (!isRecord(record.body) || !nonEmptyString(record.body.status)) throw new JourneyError('INVALID_DECISION', `decision "${name}": "body" must be the rights document (it needs a status)`)
    return Object.freeze({ body: record.body, reason: requireReason(name, record) })
  },
  /** speech-removal-confirm: the owner confirms the cuts the Apollo proposed for the subjects of the request (apollo.projects.speech-removals.confirm). */
  'speech-removal-confirm': (record, name, context) => {
    rejectUnknown(name, record, ['confirmations'])
    if (!Array.isArray(record.confirmations) || record.confirmations.length === 0) throw new JourneyError('INVALID_DECISION', `decision "${name}": "confirmations" must be a non-empty list`)
    const subjects = new Set()
    const confirmations = record.confirmations.map((entry, index) => {
      const where = `${name} confirmations[${index}]`
      if (!isRecord(entry)) throw new JourneyError('INVALID_DECISION', `decision "${where}" must be an object`)
      rejectUnknown(where, entry, ['subject', 'variant', 'proposalHash', 'adjustments', 'discardedPassageIds', 'reason'])
      if (!nonEmptyString(entry.subject) || entry.subject.length > 200) throw new JourneyError('INVALID_DECISION', `decision "${where}": "subject" must be the subject exactly as the request states it (up to 200 characters)`)
      // The cut is one Command on the project's single EditPlan; `variant` names the output it is requested through.
      if (typeof entry.variant !== 'string' || !context.outputKeys.includes(entry.variant)) throw new JourneyError('INVALID_DECISION', `decision "${where}": "variant" must name one output of the journey (${context.outputKeys.join(', ')})`)
      // The hash of the proposal the person read: a proposal that changed since is refused by the Apollo (VERSION_CONFLICT), never confirmed by accident.
      if (typeof entry.proposalHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.proposalHash)) throw new JourneyError('INVALID_DECISION', `decision "${where}": "proposalHash" must be the proposalHash of the proposal that was read (64 lowercase hex characters)`)
      let adjustments
      if (entry.adjustments !== undefined) {
        if (!Array.isArray(entry.adjustments) || entry.adjustments.length === 0 || entry.adjustments.length > 64) throw new JourneyError('INVALID_DECISION', `decision "${where}": "adjustments" must be a list of 1 to 64 passages`)
        adjustments = entry.adjustments.map((item, at) => {
          if (!isRecord(item) || !nonEmptyString(item.passageId) || typeof item.startSeconds !== 'number' || typeof item.endSeconds !== 'number' || !(item.startSeconds >= 0) || !(item.endSeconds > item.startSeconds)) {
            throw new JourneyError('INVALID_DECISION', `decision "${where}": adjustments[${at}] must be { passageId, startSeconds, endSeconds } with 0 <= start < end`)
          }
          rejectUnknown(`${where} adjustments[${at}]`, item, ['passageId', 'startSeconds', 'endSeconds'])
          return Object.freeze({ passageId: item.passageId, startSeconds: item.startSeconds, endSeconds: item.endSeconds })
        })
        if (new Set(adjustments.map((item) => item.passageId)).size !== adjustments.length) throw new JourneyError('INVALID_DECISION', `decision "${where}": a passage may be adjusted once`)
      }
      let discarded
      if (entry.discardedPassageIds !== undefined) {
        if (!Array.isArray(entry.discardedPassageIds) || entry.discardedPassageIds.length === 0 || entry.discardedPassageIds.length > 64 || !entry.discardedPassageIds.every(nonEmptyString) || new Set(entry.discardedPassageIds).size !== entry.discardedPassageIds.length) {
          throw new JourneyError('INVALID_DECISION', `decision "${where}": "discardedPassageIds" must be a list of 1 to 64 distinct passage ids`)
        }
        discarded = Object.freeze([...entry.discardedPassageIds])
        if (adjustments?.some((item) => discarded.includes(item.passageId))) throw new JourneyError('INVALID_DECISION', `decision "${where}": a passage cannot be adjusted and discarded`)
      }
      if (subjects.has(entry.subject)) throw new JourneyError('INVALID_DECISION', `decision "${name}": a subject may be confirmed once`)
      subjects.add(entry.subject)
      return Object.freeze({
        subject: entry.subject, variant: entry.variant, proposalHash: entry.proposalHash, ...(adjustments ? { adjustments: Object.freeze(adjustments) } : {}),
        ...(discarded ? { discardedPassageIds: discarded } : {}), ...(nonEmptyString(entry.reason) ? { reason: entry.reason.trim() } : {}),
      })
    })
    return Object.freeze({ confirmations: Object.freeze(confirmations) })
  },
  /** derived-rights: the same rights document, stated by the owner for the project's own derived media (proxies and finals) that carry none. */
  'derived-rights': (record, name) => DECISION_PARSERS['source-rights'](record, name),
  /** proxy-review: for every output, approve (with the warnings acknowledged when the review asks) or correct with requests. */
  'proxy-review': (record, name, context) => {
    rejectUnknown(name, record, ['outputs', 'reason'])
    if (!isRecord(record.outputs)) throw new JourneyError('INVALID_DECISION', `decision "${name}": "outputs" must be an object keyed by output`)
    const keys = Object.keys(record.outputs)
    if (keys.length !== context.outputKeys.length || !context.outputKeys.every((key) => keys.includes(key))) {
      throw new JourneyError('INVALID_DECISION', `decision "${name}": "outputs" must name exactly ${context.outputKeys.join(', ')}`)
    }
    const outputs = {}
    for (const key of context.outputKeys) {
      const entry = record.outputs[key]
      const where = `${name} outputs["${key}"]`
      if (!isRecord(entry)) throw new JourneyError('INVALID_DECISION', `decision "${where}" must be an object`)
      if (entry.decision === 'approve') {
        rejectUnknown(where, entry, ['decision', 'acknowledgeWarnings', 'note'])
        if (entry.acknowledgeWarnings !== undefined && typeof entry.acknowledgeWarnings !== 'boolean') throw new JourneyError('INVALID_DECISION', `decision "${where}": acknowledgeWarnings must be true or false`)
        if (entry.note !== undefined && !nonEmptyString(entry.note)) throw new JourneyError('INVALID_DECISION', `decision "${where}": note must be text`)
        outputs[key] = Object.freeze({ decision: 'approve', acknowledgeWarnings: entry.acknowledgeWarnings === true, ...(entry.note ? { note: entry.note.trim() } : {}) })
      } else if (entry.decision === 'correct') {
        rejectUnknown(where, entry, ['decision', 'requests', 'reason'])
        outputs[key] = Object.freeze({ decision: 'correct', requests: parseRequests(where, entry.requests), reason: requireReason(where, entry) })
      } else {
        throw new JourneyError('INVALID_DECISION', `decision "${where}": decision must be "approve" or "correct"`)
      }
    }
    return Object.freeze({ outputs: Object.freeze(outputs), ...(nonEmptyString(record.reason) ? { reason: record.reason.trim() } : {}) })
  },
  /** owner-correction: what the owner asked to change, the outputs it concerns, and their final approval. */
  'owner-correction': (record, name, context) => {
    rejectUnknown(name, record, ['reason', 'requests', 'runDirector', 'outputs'])
    const reason = requireReason(name, record)
    if (!isRecord(record.outputs) || Object.keys(record.outputs).length === 0 || !Object.keys(record.outputs).every((key) => context.outputKeys.includes(key))) {
      throw new JourneyError('INVALID_DECISION', `decision "${name}": "outputs" must name the affected outputs among ${context.outputKeys.join(', ')}`)
    }
    const outputs = {}
    for (const [key, entry] of Object.entries(record.outputs)) {
      const where = `${name} outputs["${key}"]`
      if (!isRecord(entry) || entry.approve !== true) throw new JourneyError('INVALID_DECISION', `decision "${where}" must be { "approve": true } with optional acknowledgeWarnings and note`)
      rejectUnknown(where, entry, ['approve', 'acknowledgeWarnings', 'note'])
      outputs[key] = Object.freeze({ acknowledgeWarnings: entry.acknowledgeWarnings === true, ...(nonEmptyString(entry.note) ? { note: entry.note.trim() } : {}) })
    }
    if (record.runDirector !== undefined && typeof record.runDirector !== 'boolean') throw new JourneyError('INVALID_DECISION', `decision "${name}": runDirector must be true or false`)
    const requests = record.requests === undefined ? [] : parseRequests(name, record.requests)
    if (requests.length === 0 && record.runDirector !== true) throw new JourneyError('INVALID_DECISION', `decision "${name}" must carry requests, runDirector: true, or both`)
    return Object.freeze({ reason, requests, runDirector: record.runDirector === true, outputs: Object.freeze(outputs) })
  },
  'owner-acceptance': (record, name) => {
    rejectUnknown(name, record, ['accepted', 'by', 'note', 'recordedAt'])
    if (typeof record.accepted !== 'boolean') throw new JourneyError('INVALID_DECISION', `decision "${name}": "accepted" must be true or false`)
    if (!nonEmptyString(record.by)) throw new JourneyError('INVALID_DECISION', `decision "${name}": "by" must say who decided`)
    if (record.recordedAt !== undefined && (typeof record.recordedAt !== 'string' || Number.isNaN(Date.parse(record.recordedAt)))) throw new JourneyError('INVALID_DECISION', `decision "${name}": recordedAt must be an ISO date`)
    return Object.freeze({ accepted: record.accepted, by: record.by.trim(), ...(nonEmptyString(record.note) ? { note: record.note.trim() } : {}), ...(record.recordedAt ? { recordedAt: record.recordedAt } : {}) })
  },
})

/** Decision file names: `<kind>.json`, and for a kind asked again `<kind>-<n>.json` (n from 2). */
export function decisionFileName(kind, attempt = 1) {
  if (!Object.hasOwn(DECISION_PARSERS, kind)) throw new JourneyError('INVALID_DECISION', `unknown decision kind "${kind}"`)
  if (!Number.isInteger(attempt) || attempt < 1) throw new JourneyError('INVALID_DECISION', 'attempt must be a positive integer')
  return attempt === 1 ? `${kind}.json` : `${kind}-${attempt}.json`
}

/** Parses the JSON text of a decision file of `kind`. Fails closed on anything it does not recognise. */
export function parseDecision(kind, text, context) {
  let record
  try { record = JSON.parse(text) } catch { throw new JourneyError('INVALID_DECISION', `decision "${kind}" is not valid JSON`) }
  if (!isRecord(record)) throw new JourneyError('INVALID_DECISION', `decision "${kind}" must be a JSON object`)
  const parser = DECISION_PARSERS[kind]
  if (!parser) throw new JourneyError('INVALID_DECISION', `unknown decision kind "${kind}"`)
  return parser(record, kind, context)
}

// --------------------------------------------------------------------------------------------------------------------
// Request templates
// --------------------------------------------------------------------------------------------------------------------

const TOKEN = /^\{\{([^{}]+)\}\}$/

function walk(root, path, token) {
  let value = root
  for (const segment of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) throw new JourneyError('UNKNOWN_PLACEHOLDER', `{{${token}}} does not resolve (missing "${segment}")`)
    value = value[segment]
  }
  return value
}

/**
 * Replaces every string that is exactly `{{name}}` in `value` (deeply). `resolver(name)` answers the journey's own names
 * (`projectId`, `head.versionId`, `variant:9:16`, ...); `r<N>.<path>` reads the Nth earlier response of the same request list.
 * Anything else, and a name nobody resolves, is an error: a request is never sent with a guessed value.
 */
export function substitute(value, { resolver, responses = [] }) {
  if (typeof value === 'string') {
    const match = TOKEN.exec(value)
    if (!match) return value
    const token = match[1].trim()
    const response = /^r(\d+)\.(.+)$/.exec(token)
    if (response) {
      const index = Number(response[1])
      if (!responses[index]) throw new JourneyError('UNKNOWN_PLACEHOLDER', `{{${token}}} refers to a response that does not exist yet`)
      return walk(responses[index], response[2].split('.'), token)
    }
    const resolved = resolver(token)
    if (resolved === undefined) throw new JourneyError('UNKNOWN_PLACEHOLDER', `{{${token}}} is not a name the journey knows`)
    return resolved
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, { resolver, responses }))
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, { resolver, responses })]))
  return value
}

/**
 * A request path with `{{name}}` anywhere in it (a path segment, not only a whole string). The value must be a string or a number and
 * is URL-encoded as one path segment.
 */
export function substitutePath(path, { resolver, responses = [] }) {
  return path.replace(/\{\{([^{}]+)\}\}/g, (whole) => {
    const value = substitute(whole, { resolver, responses })
    if (typeof value !== 'string' && typeof value !== 'number') throw new JourneyError('UNKNOWN_PLACEHOLDER', `${whole} in a path must resolve to text`)
    return encodeURIComponent(String(value))
  })
}

/** Whether a value mentions a `{{head.*}}` placeholder (so the driver refreshes the head Version before the request). */
export function mentionsHead(value) {
  if (typeof value === 'string') return /\{\{\s*head\./.test(value)
  if (Array.isArray(value)) return value.some(mentionsHead)
  if (isRecord(value)) return Object.values(value).some(mentionsHead)
  return false
}

// --------------------------------------------------------------------------------------------------------------------
// Evidence sanitising
// --------------------------------------------------------------------------------------------------------------------

const SECRET_KEY = /token|secret|authorization|password|credential|api[-_]?key|signature/i
const LONG_STRING = 20_000

/**
 * A copy of `value` that is safe to write to the evidence directory: secret-named keys are redacted, a download URL loses its token,
 * the credential itself (and anything in `secrets`) is replaced wherever it appears, and very long strings (screenshots) keep a hash.
 */
export function sanitize(value, secrets = []) {
  const known = secrets.filter((secret) => typeof secret === 'string' && secret.length >= 8)
  const scrubString = (text) => {
    let result = text
    for (const secret of known) result = result.split(secret).join('[REDACTED]')
    result = result.replace(/([?&](?:token|signature|sig|access_token)=)[^&\s"']+/gi, '$1[REDACTED]')
    if (result.length > LONG_STRING) return `[${result.length} characters, sha256 ${sha256Hex(result)}]`
    return result
  }
  const visit = (item, key) => {
    if (typeof item === 'string') return key !== undefined && SECRET_KEY.test(key) ? '[REDACTED]' : scrubString(item)
    if (Array.isArray(item)) return item.map((entry) => visit(entry, key))
    if (isRecord(item)) return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, visit(entry, name)]))
    return item
  }
  return visit(value)
}
