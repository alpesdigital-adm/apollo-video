import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'
import type { OutputAspectRatio } from './output-spec.ts'

export type SubtitlePresetId = 'kinetic' | 'karaoke-box' | 'karaoke-pill' | 'caps-stroke' | 'clean-color'
export interface SubtitleStylePreset { id: SubtitlePresetId; version: 1; typography: { fontFamily: string; fallback: readonly string[]; licensed: boolean; glyphCoverage: 'latin-ext' }; lineBreaking: { maxLines: number; maxCharacters: number }; highlight: { mode: 'word' | 'phrase' | 'none'; color: string }; background: { color: string; opacity: number; radius: number }; animation: { kind: 'scale' | 'karaoke' | 'fade'; durationMs: number; reducedMotion: 'fade' | 'none' }; margins: { horizontal: number; vertical: number }; responsive: { minFontPx: number; maxFontPx: number } }
const preset = (id: SubtitlePresetId, values: Partial<SubtitleStylePreset>): SubtitleStylePreset => ({ id, version: 1, typography: { fontFamily: 'Inter', fallback: ['Arial', 'sans-serif'], licensed: true, glyphCoverage: 'latin-ext' }, lineBreaking: { maxLines: 2, maxCharacters: 34 }, highlight: { mode: 'word', color: '#F7C948' }, background: { color: '#000000', opacity: 0, radius: 0 }, animation: { kind: 'fade', durationMs: 160, reducedMotion: 'fade' }, margins: { horizontal: .08, vertical: .1 }, responsive: { minFontPx: 28, maxFontPx: 72 }, ...values })
export const SUBTITLE_PRESETS = Object.freeze({ kinetic: preset('kinetic', { animation: { kind: 'scale', durationMs: 140, reducedMotion: 'fade' } }), 'karaoke-box': preset('karaoke-box', { background: { color: '#000000', opacity: .82, radius: 8 }, animation: { kind: 'karaoke', durationMs: 120, reducedMotion: 'none' } }), 'karaoke-pill': preset('karaoke-pill', { background: { color: '#18181B', opacity: .9, radius: 999 }, lineBreaking: { maxLines: 1, maxCharacters: 26 }, animation: { kind: 'karaoke', durationMs: 120, reducedMotion: 'none' } }), 'caps-stroke': preset('caps-stroke', { typography: { fontFamily: 'Archivo Black', fallback: ['Arial Black', 'sans-serif'], licensed: true, glyphCoverage: 'latin-ext' }, highlight: { mode: 'none', color: '#FFFFFF' }, animation: { kind: 'scale', durationMs: 120, reducedMotion: 'fade' } }), 'clean-color': preset('clean-color', { highlight: { mode: 'phrase', color: '#67E8F9' }, animation: { kind: 'fade', durationMs: 180, reducedMotion: 'fade' } }) } satisfies Record<SubtitlePresetId, SubtitleStylePreset>)
const luminance = (hex: string) => { const values = [1,3,5].map((index) => parseInt(hex.slice(index,index+2),16)/255).map((value) => value <= .03928 ? value/12.92 : ((value+.055)/1.055)**2.4); return .2126*values[0]+.7152*values[1]+.0722*values[2] }
export function validateSubtitlePreset(value: SubtitleStylePreset) { if (value.version !== 1 || !value.typography.licensed || value.typography.glyphCoverage !== 'latin-ext') throw new DomainError('INVALID_ARGUMENT','Subtitle font must be licensed with latin-ext coverage'); if (value.lineBreaking.maxLines < 1 || value.lineBreaking.maxLines > 3 || value.lineBreaking.maxCharacters < 8 || value.lineBreaking.maxCharacters > 48) throw new DomainError('INVALID_ARGUMENT','Subtitle line limits are invalid'); if (value.responsive.minFontPx < 20 || value.responsive.maxFontPx > 120 || value.responsive.minFontPx > value.responsive.maxFontPx) throw new DomainError('INVALID_ARGUMENT','Subtitle responsive font limits are invalid'); if (value.background.opacity >= .5 && Math.abs(luminance(value.highlight.color)-luminance(value.background.color)) < .25) throw new DomainError('INVALID_ARGUMENT','Subtitle contrast is insufficient'); return Object.freeze(value) }
export function quickSubtitlePreview(presetId: SubtitlePresetId, input: { text: string; format: OutputAspectRatio; background: 'light' | 'dark' }) { const style=validateSubtitlePreset(SUBTITLE_PRESETS[presetId]);return Object.freeze({presetId,version:style.version,text:input.text,format:input.format,background:input.background,tokens:style,renderKind:'instant-css-preview' as const}) }
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
  return calculateCanonicalHash(validateSubtitlePreset(preset))
}
export function subtitlePresetReference(presetId: SubtitlePresetId): SubtitlePresetReference {
  return Object.freeze({ presetId: presetIdentity(presetId, 'presetId'), presetVersion: 1 as const, presetHash: subtitlePresetHash(presetId) })
}
const presetIdentity = (value: unknown, field: string): SubtitlePresetId => {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(SUBTITLE_PRESETS, value)) throw new DomainError('INVALID_ARGUMENT', `${field} is not a registered subtitle preset`)
  validateSubtitlePreset(SUBTITLE_PRESETS[value as SubtitlePresetId])
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
export const SUBTITLE_VISUAL_GOLDENS=Object.freeze((Object.keys(SUBTITLE_PRESETS) as SubtitlePresetId[]).flatMap((presetId)=>['9:16','16:9'].flatMap((format)=>['light','dark'].map((background)=>quickSubtitlePreview(presetId,{text:'Ação com clareza',format:format as OutputAspectRatio,background:background as 'light'|'dark'})))))
export const SUBTITLE_ANCHOR_FIXTURES=Object.freeze({lowerFace:[{id:'face',kind:'face',box:[.25,.65,.5,.3]}],fullScreen:[{id:'insert',kind:'insert',box:[0,0,1,1]}],multiple:[{id:'logo',kind:'logo',box:[.05,.05,.2,.1]},{id:'cta',kind:'cta',box:[.1,.75,.8,.2]}]} satisfies Record<string,readonly OccupiedRegion[]>)
