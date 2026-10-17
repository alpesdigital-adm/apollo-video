import { createHash } from 'node:crypto'
import { assertDomain } from './errors.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION } from './output-canonical-policy.ts'
import { freezeOutputJson, requireOutputHash, requireOutputId, type OutputJson } from './output-spec-revision.ts'
import { assCentisecondTimestamp, createMaterializedAssClockLookup,
  type MaterializedSubtitleClock, type SubtitleClockAuthority } from './materialized-subtitle-clock.ts'

export const MATERIALIZED_ASS_EVENTS_VERSION = 'materialized-ass-events/v1' as const
export interface WrappedAssCue {
  cueId: string
  kind: 'subtitle' | 'cta'
  localStartFrame: number
  localEndFrame: number
  originalText: string
  sourceTextSha256: string
  /** Final wrapping is materialized; this serializer never calls a font/default registry. */
  wrappedLines: readonly string[]
  wrapPolicyHash: string
  suppressed: boolean
  anchorDecisionHash: string
  point: Readonly<{ x: number; y: number }> | null
}
export interface MaterializedAssCueEvent {
  cueId: string
  kind: 'subtitle' | 'cta'
  localStartFrame: number
  localEndFrame: number
  globalStartFrame: number
  globalEndFrame: number
  sourceTextSha256: string
  wrapPolicyHash: string
  anchorDecisionHash: string
  displayText: string
  assEventLine: string
}
export interface MaterializedAssEvents {
  schemaVersion: typeof MATERIALIZED_ASS_EVENTS_VERSION
  canonicalPolicyVersion: typeof OUTPUT_CANONICAL_POLICY_VERSION
  clockHash: string
  emissionParametersHash: string
  preambleSha256: string
  assSha256: string
  assByteSize: number
  assText: string
  emitted: readonly Readonly<MaterializedAssCueEvent>[]
  suppressedCueIds: readonly string[]
  inputSeal: string
}
const check = (value: unknown, message: string) => assertDomain(Boolean(value), 'INVALID_RENDER_INPUT', message)
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const STYLE_FIELDS = 'Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding'
const EVENT_FIELDS = 'Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'
function preambleStyles(preamble: string, clock: Readonly<MaterializedSubtitleClock>): Set<string> {
  check(typeof preamble === 'string' && Buffer.byteLength(preamble, 'utf8') <= 65536 &&
    !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(preamble) && preamble.endsWith('\n'),
  'ASS preamble must be explicit UTF-8 configuration')
  const sections = ['[Script Info]', '[V4+ Styles]', '[Events]'], styles = new Set<string>()
  const info = new Map<string, string>(), formats = new Set<number>()
  let section = -1
  for (const raw of preamble.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      check(section < 2 && line === sections[section + 1], 'ASS preamble sections are duplicated, reordered or unsupported')
      section += 1; continue
    }
    check(section >= 0, 'ASS preamble fields precede their section')
    const match = /^([^:]+):\s*(.*)$/.exec(line)
    check(match !== null, 'ASS preamble field is malformed')
    const key = match![1]!.trim(), normalized = key.toLowerCase(), value = match![2]!
    if (section === 0) {
      check(['title', 'scripttype', 'wrapstyle', 'playresx', 'playresy', 'scaledborderandshadow', 'collisions', 'timer', 'ycbcr matrix'].includes(normalized) &&
        !info.has(normalized), 'ASS Script Info contains an unsupported or duplicate field')
      info.set(normalized, value)
    } else if (normalized === 'format') {
      check(!formats.has(section) && value.split(',').map((field) => field.trim()).join(',') ===
        (section === 1 ? STYLE_FIELDS : EVENT_FIELDS), 'ASS Format differs from serializer field order')
      formats.add(section)
    } else {
      check(section === 1 && normalized === 'style' && formats.has(1), 'ASS preamble contains unsupported fields or preexisting events')
      const fields = value.split(',')
      check(fields.length === 23 && ['Default', 'CTA'].includes(fields[0]!) && !styles.has(fields[0]!) &&
        clock.authority.fonts.some((font) => font.family === fields[1]), 'ASS style uses unknown/implicit glyph configuration')
      styles.add(fields[0]!)
    }
  }
  check(section === 2 && formats.size === 2 && info.get('scripttype') === 'v4.00+' && info.get('wrapstyle') === '2',
    'ASS preamble requires exact sections, ScriptType, WrapStyle and Formats')
  check(info.get('playresx') === String(clock.renderInput.output.width) &&
    info.get('playresy') === String(clock.renderInput.output.height), 'ASS canvas differs from materialized output')
  return styles
}
function textGate(text: string): void {
  check(typeof text === 'string' && text.length > 0, 'ASS source text is empty')
  for (const char of text) {
    const code = char.codePointAt(0)!
    check((code >= 32 || code === 10) && code !== 127, 'ASS source text contains a forbidden control')
  }
}

export function materializedAssParametersHash(input: { preamble: string; fonts: SubtitleClockAuthority['fonts'];
  libassConfigurationHash: string; width: number; height: number }): string {
  return calculateOutputCanonicalHash({ schemaVersion: 'materialized-ass-emission-parameters/v1',
    canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, encoding: 'utf8-lf',
    preambleSha256: sha(input.preamble), fonts: input.fonts, libassConfigurationHash: input.libassConfigurationHash,
    width: input.width, height: input.height })
}

/** Isolated serializer for post-wrap cues, using actual materialized PTS boundaries.
 * The input seal has no future MP4/receipt hash; it is not a renderer activation.
 * Structural event lineage confers no facial/editorial approval. */
export function serializeMaterializedAssEvents(input: {
  clock: Readonly<MaterializedSubtitleClock>
  preamble: string
  emissionParametersHash: string
  cues: readonly Readonly<WrappedAssCue>[]
}): Readonly<MaterializedAssEvents> {
  freezeOutputJson(input.cues as unknown as OutputJson)
  const lookup = createMaterializedAssClockLookup(input.clock), clock = lookup.clock
  requireOutputHash(input.emissionParametersHash, 'ASS effective emission parameters')
  check(input.emissionParametersHash === clock.prefix.emissionParametersHash, 'ASS parameters differ from pinned graph preparation')
  check(materializedAssParametersHash({ preamble: input.preamble, fonts: clock.authority.fonts,
    libassConfigurationHash: clock.authority.libass.configurationHash,
    width: clock.renderInput.output.width, height: clock.renderInput.output.height }) === input.emissionParametersHash,
  'ASS preamble/glyph parameters differ from prepared materialization')
  const styles = preambleStyles(input.preamble, clock)
  check(input.cues.length <= 100000, 'ASS cue count exceeds its document bound')
  const ids = new Set<string>(), lines = new Set<string>(), emitted: MaterializedAssCueEvent[] = [], suppressed: string[] = []
  for (const cue of input.cues) {
    requireOutputId(cue.cueId, 'cue id')
    check(!ids.has(cue.cueId), 'Duplicate ASS cue identity'); ids.add(cue.cueId)
    check(cue.kind === 'subtitle' || cue.kind === 'cta', 'Unknown ASS event layer')
    check(Number.isSafeInteger(cue.localStartFrame) && Number.isSafeInteger(cue.localEndFrame) &&
      cue.localStartFrame >= 0 && cue.localEndFrame > cue.localStartFrame &&
      cue.localEndFrame <= clock.frames.length, 'ASS cue range differs from materialized fragment')
    textGate(cue.originalText)
    requireOutputHash(cue.sourceTextSha256, 'original cue bytes')
    check(sha(cue.originalText) === cue.sourceTextSha256, 'Original cue text hash differs')
    requireOutputHash(cue.wrapPolicyHash, 'post-wrap policy')
    requireOutputHash(cue.anchorDecisionHash, 'draw/suppress decision')
    check(typeof cue.suppressed === 'boolean', 'ASS suppression must be explicit')
    if (cue.suppressed) {
      check(cue.wrappedLines.length === 0 && cue.point === null, 'Suppressed cue cannot carry a drawn event')
      suppressed.push(cue.cueId)
      continue
    }
    check(clock.specRevision.document.profile.subtitles.mode === 'burn-in', 'ASS events require the exact burn-in profile')
    check(styles.has(cue.kind === 'subtitle' ? 'Default' : 'CTA'), 'ASS event references an absent materialized style')
    check(Array.isArray(cue.wrappedLines) && cue.wrappedLines.length >= 1 && cue.wrappedLines.length <= 2 &&
      cue.wrappedLines.every((line) => typeof line === 'string' && line.length > 0 && line === line.normalize('NFC') &&
        line.trim() === line && !/[{}\\\u0000-\u001f\u007f]/.test(line)), 'Invalid literal post-wrap ASS lines')
    check(cue.wrappedLines.join(' ') === cue.originalText.normalize('NFC').split(/\s+/).filter(Boolean).join(' '),
      'Post-wrap text changed or lost source words')
    const point = cue.point
    check(point !== null && Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y) &&
      point.x >= 0 && point.y >= 0 && point.x < clock.renderInput.output.width && point.y < clock.renderInput.output.height,
    'ASS event anchor must be explicit and inside the materialized canvas')
    const { startCs, endCs } = lookup.interval(cue.localStartFrame, cue.localEndFrame)
    const payload = cue.wrappedLines.join('\\N')
    const line = 'Dialogue: ' + (cue.kind === 'subtitle' ? '0' : '1') + ',' +
      assCentisecondTimestamp(startCs) + ',' + assCentisecondTimestamp(endCs) + ',' +
      (cue.kind === 'subtitle' ? 'Default' : 'CTA') + ',,0,0,0,,{\\an' +
      (cue.kind === 'subtitle' ? '5' : '8') + '\\pos(' + point!.x + ',' + point!.y + ')}' + payload
    check(!lines.has(line), 'ASS events are not bijective with cue identities'); lines.add(line)
    emitted.push({ cueId: cue.cueId, kind: cue.kind, localStartFrame: cue.localStartFrame, localEndFrame: cue.localEndFrame,
      globalStartFrame: clock.fragment.globalStartFrame + cue.localStartFrame,
      globalEndFrame: clock.fragment.globalStartFrame + cue.localEndFrame,
      sourceTextSha256: cue.sourceTextSha256, wrapPolicyHash: cue.wrapPolicyHash, anchorDecisionHash: cue.anchorDecisionHash,
      displayText: cue.wrappedLines.join('\n'), assEventLine: line })
  }
  const assText = input.preamble + emitted.map((cue) => cue.assEventLine).join('\n') + (emitted.length ? '\n' : '')
  const body = { schemaVersion: MATERIALIZED_ASS_EVENTS_VERSION, canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    clockHash: clock.clockHash, emissionParametersHash: input.emissionParametersHash, preambleSha256: sha(input.preamble),
    assSha256: sha(assText), assByteSize: Buffer.byteLength(assText, 'utf8'), assText,
    emitted, suppressedCueIds: suppressed }
  check(body.assByteSize <= 16 * 1024 * 1024, 'ASS bytes exceed document bound')
  return freezeOutputJson({ ...body, inputSeal: calculateOutputCanonicalHash(body) } as unknown as OutputJson) as unknown as Readonly<MaterializedAssEvents>
}
