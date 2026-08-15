import { createHash } from 'crypto'
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
export type SubtitleMode = 'auto' | 'workspace-default' | 'manual' | 'none'
export interface SubtitleConfig { mode: SubtitleMode; presetId?: SubtitlePresetId; origin: 'director' | 'workspace' | 'project' | 'disabled'; variantId: string; transcriptHash: string }
export function resolveSubtitleConfig(input:{mode:SubtitleMode;workspacePreset:SubtitlePresetId;manualPreset?:SubtitlePresetId;variantId:string;transcript:unknown}) : Readonly<SubtitleConfig> { const transcriptHash=createHash('sha256').update(JSON.stringify(input.transcript)).digest('hex'); if(input.mode==='none')return Object.freeze({mode:'none',origin:'disabled',variantId:input.variantId,transcriptHash}); if(input.mode==='manual'&&!input.manualPreset)throw new DomainError('INVALID_ARGUMENT','Manual subtitle mode requires a preset');return Object.freeze({mode:input.mode,presetId:input.mode==='workspace-default'?input.workspacePreset:input.mode==='manual'?input.manualPreset:input.workspacePreset,origin:input.mode==='workspace-default'?'workspace':input.mode==='manual'?'project':'director',variantId:input.variantId,transcriptHash}) }
export interface OccupiedRegion { id:string;kind:'face'|'ocr'|'cta'|'logo'|'insert';box:readonly[number,number,number,number] }
export type SubtitleAnchor='top'|'upper-third'|'center'|'lower-third'|'bottom'
const anchorBoxes:Record<SubtitleAnchor,readonly[number,number,number,number]>={top:[.1,.06,.8,.16],'upper-third':[.1,.22,.8,.16],center:[.1,.42,.8,.16],'lower-third':[.1,.64,.8,.16],bottom:[.1,.8,.8,.14]}
const overlaps=(a:readonly number[],b:readonly number[])=>a[0]<b[0]+b[2]&&a[0]+a[2]>b[0]&&a[1]<b[1]+b[3]&&a[1]+a[3]>b[1]
export function chooseSubtitleAnchor(input:{occupied:readonly OccupiedRegion[];previous?:SubtitleAnchor;safeArea:{top:number;bottom:number}}){const candidates=(Object.keys(anchorBoxes) as SubtitleAnchor[]).filter((anchor)=>{const box=anchorBoxes[anchor];return box[1]>=input.safeArea.top&&box[1]+box[3]<=1-input.safeArea.bottom&&!input.occupied.some((region)=>overlaps(box,region.box))});if(input.previous&&candidates.includes(input.previous))return Object.freeze({anchor:input.previous,stable:true,issue:null});const anchor=candidates[0]??null;return Object.freeze({anchor,stable:false,issue:anchor?null:'NO_SAFE_SUBTITLE_REGION'})}
export interface SubtitleSegmentOverride { id:string;segmentId:string;variantId:string;rangeMs:readonly[number,number];position?:SubtitleAnchor;styleId?:SubtitlePresetId;text?:string;visibility?:'visible'|'hidden';protected:boolean }
export function applySubtitleOverride(input:{base:Readonly<Record<string,unknown>>;override:SubtitleSegmentOverride;variantId:string;rangeMs:readonly[number,number]}){if(input.override.variantId!==input.variantId)return Object.freeze({value:input.base,invalidatedRanges:Object.freeze([]),applied:false});const overlap=input.rangeMs[0]<input.override.rangeMs[1]&&input.rangeMs[1]>input.override.rangeMs[0];if(!overlap)return Object.freeze({value:input.base,invalidatedRanges:Object.freeze([]),applied:false});return Object.freeze({value:Object.freeze({...input.base,...input.override}),invalidatedRanges:Object.freeze([input.override.rangeMs]),applied:true,protected:input.override.protected})}
export function resetSubtitleOverride(override:SubtitleSegmentOverride, inherited:Readonly<Record<string,unknown>>){return Object.freeze({value:inherited,removedOverrideId:override.id,invalidatedRanges:Object.freeze([override.rangeMs])})}
export interface RenderedCue {startMs:number;endMs:number;text:string}
const stamp=(ms:number,srt:boolean)=>{const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),x=ms%1000;return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}${srt?',':'.'}${String(x).padStart(3,'0')}`}
export function exportSubtitleSidecar(cues:readonly RenderedCue[],format:'srt'|'vtt'){for(let i=0;i<cues.length;i++){if(cues[i].endMs<=cues[i].startMs||(i&&cues[i].startMs<cues[i-1].endMs))throw new DomainError('INVALID_ARGUMENT','Subtitle cues must be positive, monotonic and non-overlapping')}const normalized=cues.map((cue)=>({...cue,text:cue.text.normalize('NFC').replace(/\r?\n/g,'\n').trim()}));const body=normalized.map((cue,index)=>`${format==='srt'?`${index+1}\n`:''}${stamp(cue.startMs,format==='srt')} --> ${stamp(cue.endMs,format==='srt')}\n${cue.text}`).join('\n\n');return `﻿${format==='vtt'?'WEBVTT\n\n':''}${body}\n`}
export const SUBTITLE_VISUAL_GOLDENS=Object.freeze((Object.keys(SUBTITLE_PRESETS) as SubtitlePresetId[]).flatMap((presetId)=>['9:16','16:9'].flatMap((format)=>['light','dark'].map((background)=>quickSubtitlePreview(presetId,{text:'Ação com clareza',format:format as SubtitleMvpFormat,background:background as 'light'|'dark'})))))
export const SUBTITLE_ANCHOR_FIXTURES=Object.freeze({lowerFace:[{id:'face',kind:'face',box:[.25,.65,.5,.3]}],fullScreen:[{id:'insert',kind:'insert',box:[0,0,1,1]}],multiple:[{id:'logo',kind:'logo',box:[.05,.05,.2,.1]},{id:'cta',kind:'cta',box:[.1,.75,.8,.2]}]} satisfies Record<string,readonly OccupiedRegion[]>)
