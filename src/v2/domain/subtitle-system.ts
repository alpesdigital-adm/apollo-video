import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'
import {
  OFL_LICENSE_URL,
  SUBTITLE_FORMAT_BY_ASPECT_RATIO,
  subtitleFontStackCss,
  type SubtitleMvpFormat,
  type SubtitlePresetId,
  type SubtitleStylePreset,
} from './subtitle-style-tokens.ts'

export {
  OFL_LICENSE_URL,
  resolveSubtitleMvpFormat,
  resolveSubtitleRenderMetrics,
  SUBTITLE_FORMAT_BY_ASPECT_RATIO,
  SUBTITLE_PRESET_IDS,
  subtitleFontStack,
  subtitleFontStackCss,
} from './subtitle-style-tokens.ts'
export type {
  SubtitleFormatLimits,
  SubtitleMvpFormat,
  SubtitlePresetId,
  SubtitleRenderMetrics,
  SubtitleStylePreset,
} from './subtitle-style-tokens.ts'

type PresetOverrides = Partial<Omit<SubtitleStylePreset, 'schemaVersion' | 'id' | 'version' | 'presetHash'>>

function createSubtitlePreset(id: SubtitlePresetId, values: PresetOverrides): Readonly<SubtitleStylePreset> {
  const body = {
    schemaVersion: 'subtitle-style-preset/v1' as const,
    id,
    version: 1 as const,
    typography: Object.freeze({
      fontFamily: 'Inter', fallback: Object.freeze(['Noto Sans', 'Arial', 'sans-serif']),
      licensed: true as const, licenseSpdx: 'OFL-1.1' as const, licenseUrl: OFL_LICENSE_URL,
      glyphCoverage: 'latin-ext' as const,
      weight: 800, uppercase: false, ...values.typography,
    }),
    lineBreaking: Object.freeze({ maxLines: 2, maxCharacters: 34, chunkWords: 3, ...values.lineBreaking }),
    highlight: Object.freeze({ mode: 'word' as const, color: '#F7C948', inactiveColor: '#FFFFFF', ...values.highlight }),
    background: Object.freeze({ shape: 'none' as const, color: '#000000', opacity: 0, radius: 0, paddingXEm: 0, paddingYEm: 0, ...values.background }),
    stroke: Object.freeze({ widthEm: .1, color: '#000000', ...values.stroke }),
    animation: Object.freeze({ kind: 'fade' as const, version: 1 as const, durationMs: 160, reducedMotion: 'fade' as const, ...values.animation }),
    margins: Object.freeze({ horizontal: .08, vertical: .1, ...values.margins }),
    responsive: Object.freeze({
      minFontPx: 28,
      maxFontPx: 72,
      ...values.responsive,
      formats: Object.freeze({
        '9:16': Object.freeze({ referenceHeight: 1920, fontPx: 58, maxWidth: .84, bottom: .1, ...values.responsive?.formats?.['9:16'] }),
        '16:9': Object.freeze({ referenceHeight: 1080, fontPx: 44, maxWidth: .82, bottom: .08, ...values.responsive?.formats?.['16:9'] }),
      }),
    }),
  }
  return Object.freeze({ ...body, presetHash: calculateCanonicalHash(body) })
}

export const SUBTITLE_PRESETS = Object.freeze({
  kinetic: createSubtitlePreset('kinetic', {
    lineBreaking: { maxLines: 2, maxCharacters: 30, chunkWords: 2 },
    animation: { kind: 'scale', version: 1, durationMs: 140, reducedMotion: 'fade' },
    responsive: { minFontPx: 30, maxFontPx: 78, formats: {
      '9:16': { referenceHeight: 1920, fontPx: 62, maxWidth: .86, bottom: .12 },
      '16:9': { referenceHeight: 1080, fontPx: 46, maxWidth: .80, bottom: .09 },
    } },
  }),
  'karaoke-box': createSubtitlePreset('karaoke-box', {
    background: { shape: 'box', color: '#000000', opacity: .84, radius: 10, paddingXEm: .38, paddingYEm: .18 },
    stroke: { widthEm: 0, color: '#000000' },
    animation: { kind: 'karaoke', version: 1, durationMs: 120, reducedMotion: 'none' },
    responsive: { minFontPx: 28, maxFontPx: 70, formats: {
      '9:16': { referenceHeight: 1920, fontPx: 54, maxWidth: .82, bottom: .11 },
      '16:9': { referenceHeight: 1080, fontPx: 40, maxWidth: .76, bottom: .085 },
    } },
  }),
  'karaoke-pill': createSubtitlePreset('karaoke-pill', {
    background: { shape: 'pill', color: '#18181B', opacity: .92, radius: 999, paddingXEm: .62, paddingYEm: .26 },
    stroke: { widthEm: 0, color: '#000000' },
    lineBreaking: { maxLines: 1, maxCharacters: 26, chunkWords: 5 },
    animation: { kind: 'karaoke', version: 1, durationMs: 120, reducedMotion: 'none' },
    responsive: { minFontPx: 26, maxFontPx: 66, formats: {
      '9:16': { referenceHeight: 1920, fontPx: 50, maxWidth: .78, bottom: .13 },
      '16:9': { referenceHeight: 1080, fontPx: 38, maxWidth: .70, bottom: .10 },
    } },
  }),
  'caps-stroke': createSubtitlePreset('caps-stroke', {
    typography: {
      fontFamily: 'Archivo Black', fallback: Object.freeze(['Inter', 'Noto Sans', 'Arial Black', 'sans-serif']),
      licensed: true, licenseSpdx: 'OFL-1.1', licenseUrl: OFL_LICENSE_URL, glyphCoverage: 'latin-ext', weight: 900, uppercase: true,
    },
    highlight: { mode: 'none', color: '#FFFFFF', inactiveColor: '#FFFFFF' },
    stroke: { widthEm: .12, color: '#000000' },
    animation: { kind: 'scale', version: 1, durationMs: 120, reducedMotion: 'fade' },
    responsive: { minFontPx: 32, maxFontPx: 88, formats: {
      '9:16': { referenceHeight: 1920, fontPx: 66, maxWidth: .88, bottom: .14 },
      '16:9': { referenceHeight: 1080, fontPx: 48, maxWidth: .84, bottom: .11 },
    } },
  }),
  'clean-color': createSubtitlePreset('clean-color', {
    lineBreaking: { maxLines: 2, maxCharacters: 38, chunkWords: 4 },
    highlight: { mode: 'phrase', color: '#67E8F9', inactiveColor: '#FFFFFF' },
    animation: { kind: 'fade', version: 1, durationMs: 180, reducedMotion: 'fade' },
    responsive: { minFontPx: 28, maxFontPx: 74, formats: {
      '9:16': { referenceHeight: 1920, fontPx: 56, maxWidth: .84, bottom: .10 },
      '16:9': { referenceHeight: 1080, fontPx: 42, maxWidth: .78, bottom: .075 },
    } },
  }),
} satisfies Record<SubtitlePresetId, Readonly<SubtitleStylePreset>>)

const SUBTITLE_REGISTRY_BODY = Object.freeze({
  schemaVersion: 'subtitle-style-registry/v1' as const,
  registryVersion: 1 as const,
  presets: SUBTITLE_PRESETS,
  formatByAspectRatio: SUBTITLE_FORMAT_BY_ASPECT_RATIO,
})

export const SUBTITLE_STYLE_REGISTRY = Object.freeze({
  ...SUBTITLE_REGISTRY_BODY,
  registryHash: calculateCanonicalHash(SUBTITLE_REGISTRY_BODY),
})

const HEX = /^#[0-9A-F]{6}$/
const luminance = (hex: string) => {
  const values = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
  return .2126 * values[0] + .7152 * values[1] + .0722 * values[2]
}

export function validateSubtitlePreset(value: SubtitleStylePreset): Readonly<SubtitleStylePreset> {
  if (value.schemaVersion !== 'subtitle-style-preset/v1' || value.version !== 1 || !value.typography.licensed || value.typography.licenseSpdx !== 'OFL-1.1' || value.typography.licenseUrl !== OFL_LICENSE_URL || value.typography.glyphCoverage !== 'latin-ext' || value.typography.fallback.length < 1) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle font must be OFL-1.1 licensed with fallback and latin-ext coverage')
  }
  if (value.animation.version !== 1) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle animation must declare its immutable version')
  }
  if (value.lineBreaking.maxLines < 1 || value.lineBreaking.maxLines > 3 || value.lineBreaking.maxCharacters < 8 || value.lineBreaking.maxCharacters > 48 || value.lineBreaking.chunkWords < 1 || value.lineBreaking.chunkWords > 8) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle line limits are invalid')
  }
  if (value.responsive.minFontPx < 20 || value.responsive.maxFontPx > 120 || value.responsive.minFontPx > value.responsive.maxFontPx || Object.values(value.responsive.formats).some((format) => format.fontPx < value.responsive.minFontPx || format.fontPx > value.responsive.maxFontPx || format.maxWidth <= 0 || format.maxWidth > 1 || format.bottom < 0 || format.bottom > .5 || !Number.isInteger(format.referenceHeight) || format.referenceHeight < 240 || format.referenceHeight > 4320)) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle responsive limits are invalid')
  }
  // Fail closed: 16:9 must carry its own authored limits. Identical portrait/landscape tokens would
  // mean the landscape MVP format silently inherits a style designed for 9:16.
  const portrait = value.responsive.formats['9:16']
  const landscape = value.responsive.formats['16:9']
  if (!portrait || !landscape || portrait.referenceHeight === landscape.referenceHeight ||
      (portrait.fontPx === landscape.fontPx && portrait.maxWidth === landscape.maxWidth && portrait.bottom === landscape.bottom)) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle preset must author distinct 9:16 and 16:9 limits')
  }
  if (!HEX.test(value.highlight.color) || !HEX.test(value.highlight.inactiveColor) || !HEX.test(value.background.color) || value.background.opacity < 0 || value.background.opacity > 1) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle colors are invalid')
  }
  if (value.background.opacity >= .5 && Math.abs(luminance(value.highlight.color) - luminance(value.background.color)) < .25) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle contrast is insufficient')
  }
  // A preset is only legible over an unknown frame if it either sits on an opaque container or
  // carries an outline that contrasts with its own glyph fill. Anything else would depend on the
  // footage happening to be dark, so it fails closed here instead of shipping unreadable text.
  const opaqueContainer = value.background.shape !== 'none' && value.background.opacity >= .5
  if (!HEX.test(value.stroke.color) || value.stroke.widthEm < 0 || value.stroke.widthEm > .3) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle stroke is invalid')
  }
  if (!opaqueContainer && (value.stroke.widthEm <= 0 ||
      Math.abs(luminance(value.stroke.color) - luminance(value.highlight.inactiveColor)) < .25 ||
      Math.abs(luminance(value.stroke.color) - luminance(value.highlight.color)) < .25)) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle preset without an opaque container needs a contrasting stroke')
  }
  if (value.background.shape === 'none' && value.background.opacity > 0) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle background shape and opacity disagree')
  }
  const { presetHash, ...body } = value
  if (presetHash !== calculateCanonicalHash(body)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Subtitle preset hash is invalid')
  }
  return Object.freeze(value)
}

export function readSubtitlePreset(presetId: SubtitlePresetId): Readonly<SubtitleStylePreset> {
  const presetValue = SUBTITLE_STYLE_REGISTRY.presets[presetId]
  if (!presetValue) throw new DomainError('INVALID_ARGUMENT', 'Subtitle preset is not registered')
  return validateSubtitlePreset(presetValue)
}

function rgba(hex: string, opacity: number): string {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16))
  return `rgba(${channels[0]},${channels[1]},${channels[2]},${opacity})`
}

export function quickSubtitlePreview(presetId: SubtitlePresetId, input: { text: string; format: SubtitleMvpFormat; background: 'light' | 'dark' }) {
  const style = readSubtitlePreset(presetId)
  const text = input.text.normalize('NFC').replace(/\s+/g, ' ').trim()
  if (!text || text.length > 280 || (input.format !== '9:16' && input.format !== '16:9') || (input.background !== 'light' && input.background !== 'dark')) {
    throw new DomainError('INVALID_ARGUMENT', 'Subtitle preview input is invalid')
  }
  const format = style.responsive.formats[input.format]
  const selector = `[data-apollo-subtitle-preview="${presetId}"]`
  const fontFamilies = subtitleFontStackCss(style)
  const stroke = style.stroke.widthEm > 0
    ? `-webkit-text-stroke:${style.stroke.widthEm}em ${style.stroke.color};paint-order:stroke fill;`
    : ''
  const css = `${selector}{box-sizing:border-box;display:inline-flex;align-items:baseline;justify-content:center;max-width:${format.maxWidth * 100}%;padding:${style.background.paddingYEm}em ${style.background.paddingXEm}em;border-radius:${style.background.radius}px;background:${rgba(style.background.color, style.background.opacity)};color:${style.highlight.inactiveColor};font-family:${fontFamilies};font-size:clamp(${style.responsive.minFontPx}px,${format.fontPx}px,${style.responsive.maxFontPx}px);font-weight:${style.typography.weight};line-height:1.1;text-align:center;text-transform:${style.typography.uppercase ? 'uppercase' : 'none'};overflow:hidden;${stroke}animation:apollo-subtitle-${presetId} ${style.animation.durationMs}ms ease-out both}@keyframes apollo-subtitle-${presetId}{from{opacity:0;transform:${style.animation.kind === 'scale' ? 'scale(.88)' : 'translateY(4px)'}}to{opacity:1;transform:none}}@media(prefers-reduced-motion:reduce){${selector}{animation:${style.animation.reducedMotion === 'none' ? 'none' : `apollo-subtitle-${presetId} ${style.animation.durationMs}ms linear both`}}}`
  const body = Object.freeze({
    schemaVersion: 'subtitle-css-preview/v1' as const,
    renderKind: 'instant-css-preview' as const,
    presetId,
    presetHash: style.presetHash,
    registryHash: SUBTITLE_STYLE_REGISTRY.registryHash,
    text,
    format: input.format,
    background: input.background,
    css,
  })
  return Object.freeze({ ...body, previewHash: calculateCanonicalHash(body) })
}
// F1.034 subtitle modes below resolve against the F1.033 content-addressed registry above.
// The provisional preset table and the placeholder presetHash that phase C carried alongside
// these modes were dropped: SUBTITLE_PRESETS / validateSubtitlePreset / readSubtitlePreset are
// now the single source of preset identity, so a persisted resolution validates against the
// registry's real hashes instead of a locally recomputed convention.
export const SUBTITLE_MODES = ['auto', 'workspace-default', 'manual', 'none'] as const
export type SubtitleMode = (typeof SUBTITLE_MODES)[number]
export const SUBTITLE_ORIGINS = ['director', 'workspace', 'project', 'disabled'] as const
export type SubtitleOrigin = (typeof SUBTITLE_ORIGINS)[number]
export type SubtitleModeRequest =
  | Readonly<{ mode: 'auto' }>
  | Readonly<{ mode: 'workspace-default' }>
  | Readonly<{ mode: 'manual'; presetId: SubtitlePresetId; presetVersion: 1 }>
  | Readonly<{ mode: 'none' }>
export type SubtitlePresetReference = Readonly<{ presetId: SubtitlePresetId; presetVersion: 1; presetHash: string }>
export interface SubtitleConfig {
  schemaVersion: 'subtitle-config/v1'
  requested: SubtitleModeRequest
  resolved: Readonly<{ enabled: false }> | (Readonly<{ enabled: true }> & SubtitlePresetReference)
  origin: SubtitleOrigin
  variantId: string
  transcriptHash: string
  workspaceDefaultRevision?: number
  configHash: string
}

/**
 * Versioned identity of a preset. A configuration stores this reference — never a
 * copy of the mutable style tokens — so a later edit to `SUBTITLE_PRESETS` can
 * never silently reinterpret an already persisted resolution: the stored hash
 * stops matching and the persistence guard rejects it.
 */
export function subtitlePresetHash(presetId: SubtitlePresetId): string {
  const preset = SUBTITLE_PRESETS[presetId]
  if (!preset) throw new DomainError('INVALID_ARGUMENT', 'presetId is not a registered subtitle preset')
  // The identity is the registry's own content address, not a hash recomputed here: the F1.033
  // registry already stores presetHash = canonical hash of the preset body, and
  // validateSubtitlePreset fails closed when that stored hash drifts from the body.
  return validateSubtitlePreset(preset).presetHash
}
export function subtitlePresetReference(presetId: SubtitlePresetId): SubtitlePresetReference {
  return Object.freeze({ presetId: presetIdentity(presetId, 'presetId'), presetVersion: 1 as const, presetHash: subtitlePresetHash(presetId) })
}
const presetIdentity = (value: unknown, field: string): SubtitlePresetId => {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(SUBTITLE_PRESETS, value)) throw new DomainError('INVALID_ARGUMENT', `${field} is not a registered subtitle preset`)
  readSubtitlePreset(value as SubtitlePresetId)
  return value as SubtitlePresetId
}
export function resolveSubtitleConfig(input: {
  requested?: SubtitleModeRequest
  mode?: SubtitleMode
  workspacePreset?: SubtitlePresetId
  workspaceDefaultRevision?: number
  directorPreset?: SubtitlePresetId
  manualPreset?: SubtitlePresetId
  variantId: string
  transcript: unknown
}): Readonly<SubtitleConfig> {
  if (typeof input.variantId !== 'string' || input.variantId.trim().length < 1 || input.variantId.length > 128) throw new DomainError('INVALID_ARGUMENT', 'variantId is invalid')
  const requested: SubtitleModeRequest = input.requested ?? (input.mode === 'manual'
    ? { mode: 'manual', presetId: input.manualPreset as SubtitlePresetId, presetVersion: 1 }
    : { mode: input.mode as Exclude<SubtitleMode, 'manual'> })
  if (!requested || !SUBTITLE_MODES.includes(requested.mode)) throw new DomainError('INVALID_ARGUMENT', 'Subtitle mode is unsupported')
  const transcriptHash = calculateCanonicalHash(input.transcript)
  let resolved: SubtitleConfig['resolved']; let origin: SubtitleConfig['origin']; let workspaceDefaultRevision: number | undefined
  if (requested.mode === 'none') { resolved = Object.freeze({ enabled: false }); origin = 'disabled' }
  else if (requested.mode === 'manual') {
    if (requested.presetVersion !== 1) throw new DomainError('INVALID_ARGUMENT', 'Manual subtitle preset version is unsupported')
    resolved = Object.freeze({ enabled: true as const, ...subtitlePresetReference(presetIdentity(requested.presetId, 'requested.presetId')) }); origin = 'project'
  } else if (requested.mode === 'workspace-default') {
    const presetId = presetIdentity(input.workspacePreset, 'workspacePreset')
    if (!Number.isSafeInteger(input.workspaceDefaultRevision) || input.workspaceDefaultRevision! < 0) throw new DomainError('INVALID_ARGUMENT', 'Workspace subtitle default revision is required')
    resolved = Object.freeze({ enabled: true as const, ...subtitlePresetReference(presetId) }); origin = 'workspace'; workspaceDefaultRevision = input.workspaceDefaultRevision
  } else {
    resolved = Object.freeze({ enabled: true as const, ...subtitlePresetReference(presetIdentity(input.directorPreset ?? input.workspacePreset, 'directorPreset')) }); origin = 'director'
  }
  const body = Object.freeze({ schemaVersion: 'subtitle-config/v1' as const, requested: Object.freeze({ ...requested }), resolved, origin, variantId: input.variantId.trim(), transcriptHash, ...(workspaceDefaultRevision !== undefined ? { workspaceDefaultRevision } : {}) })
  return Object.freeze({ ...body, configHash: calculateCanonicalHash(body) })
}
export function validateSubtitleConfig(config: Readonly<SubtitleConfig>, transcript: unknown): void {
  const { configHash, ...body } = config
  if (configHash !== calculateCanonicalHash(body) || config.transcriptHash !== calculateCanonicalHash(transcript)) throw new DomainError('INVALID_ARGUMENT', 'Subtitle config identity or transcript binding changed')
  if (config.requested.mode === 'none' !== !config.resolved.enabled) throw new DomainError('INVALID_ARGUMENT', 'Subtitle disabled state is inconsistent')
  if (config.resolved.enabled) {
    presetIdentity(config.resolved.presetId, 'resolved.presetId')
    if (config.resolved.presetVersion !== 1 || config.resolved.presetHash !== subtitlePresetHash(config.resolved.presetId)) throw new DomainError('INVALID_ARGUMENT', 'Subtitle preset reference no longer matches the registered preset version')
  }
}
export function materializeSubtitleRenderPolicy<T>(config: Readonly<SubtitleConfig>, cues: readonly T[]): Readonly<{ cues: readonly T[]; presetId: SubtitlePresetId | null; presetHash: string | null; transcriptHash: string }> {
  if (!config.resolved.enabled) return Object.freeze({ cues: Object.freeze([]), presetId: null, presetHash: null, transcriptHash: config.transcriptHash })
  return Object.freeze({ cues: Object.freeze([...cues]), presetId: config.resolved.presetId, presetHash: config.resolved.presetHash, transcriptHash: config.transcriptHash })
}
/**
 * The five bands a cue may occupy. The *decision* lives in `subtitle-anchor-plan.ts`, which reads
 * the content-addressed perception timeline and the solved cta/logo placements. There is no
 * hardcoded anchor rectangle here any more: the previous `chooseSubtitleAnchor`/`OccupiedRegion`
 * pair accepted caller-authored boxes and was never reachable from the renderer, so it was removed
 * rather than kept as a second answer.
 */
export type SubtitleAnchor='top'|'upper-third'|'center'|'lower-third'|'bottom'
export interface SubtitleSegmentOverride { id:string;segmentId:string;variantId:string;rangeMs:readonly[number,number];position?:SubtitleAnchor;styleId?:SubtitlePresetId;text?:string;visibility?:'visible'|'hidden';protected:boolean }
export function applySubtitleOverride(input:{base:Readonly<Record<string,unknown>>;override:SubtitleSegmentOverride;variantId:string;rangeMs:readonly[number,number]}){if(input.override.variantId!==input.variantId)return Object.freeze({value:input.base,invalidatedRanges:Object.freeze([]),applied:false});const overlap=input.rangeMs[0]<input.override.rangeMs[1]&&input.rangeMs[1]>input.override.rangeMs[0];if(!overlap)return Object.freeze({value:input.base,invalidatedRanges:Object.freeze([]),applied:false});return Object.freeze({value:Object.freeze({...input.base,...input.override}),invalidatedRanges:Object.freeze([input.override.rangeMs]),applied:true,protected:input.override.protected})}
export function resetSubtitleOverride(override:SubtitleSegmentOverride, inherited:Readonly<Record<string,unknown>>){return Object.freeze({value:inherited,removedOverrideId:override.id,invalidatedRanges:Object.freeze([override.rangeMs])})}
export interface RenderedCue {startMs:number;endMs:number;text:string}
const stamp=(ms:number,srt:boolean)=>{const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),x=ms%1000;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${srt?',':'.'}${String(x).padStart(3,'0')}`}
export function exportSubtitleSidecar(cues:readonly RenderedCue[],format:'srt'|'vtt'){for(let i=0;i<cues.length;i++){if(cues[i].endMs<=cues[i].startMs||(i&&cues[i].startMs<cues[i-1].endMs))throw new DomainError('INVALID_ARGUMENT','Subtitle cues must be positive, monotonic and non-overlapping')}const normalized=cues.map((cue)=>({...cue,text:cue.text.normalize('NFC').replace(/\r?\n/g,'\n').trim()}));const body=normalized.map((cue,index)=>`${format==='srt'?`${index+1}\n`:''}${stamp(cue.startMs,format==='srt')} --> ${stamp(cue.endMs,format==='srt')}\n${cue.text}`).join('\n\n');return `﻿${format==='vtt'?'WEBVTT\n\n':''}${body}\n`}
export const SUBTITLE_VISUAL_GOLDENS=Object.freeze((Object.keys(SUBTITLE_PRESETS) as SubtitlePresetId[]).flatMap((presetId)=>['9:16','16:9'].flatMap((format)=>['light','dark'].map((background)=>quickSubtitlePreview(presetId,{text:'Ação com clareza',format:format as SubtitleMvpFormat,background:background as 'light'|'dark'})))))
