/**
 * Claude analysis service for video content structure and design
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { getInsertStylePresetMeta } from '../style-presets'
import type { Transcription, SubtitleEntry, VideoFormat } from '../types/project'
import type { Scene, AnalysisResult, NarrativeRole, SceneType, ColorPalette } from '../types/scene'
import type { BrandColorGroup } from '../brand-colors'
import type { AssetCatalogItem } from '../asset-library'

export interface AnalyzeContentBrandColors {
  groups: BrandColorGroup[]
  forced?: BrandColorGroup
}

function readEnvFileValue(filePath: string, key: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null
  }

  const content = fs.readFileSync(filePath, 'utf8')
  const line = content
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`))

  if (!line) {
    return null
  }

  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '')
}

function createAnthropicClient(): Anthropic {
  const apiKey =
    readEnvFileValue(path.join(process.cwd(), '.env.local'), 'ANTHROPIC_API_KEY') ||
    readEnvFileValue(path.join(process.cwd(), '.env.local'), 'CLAUDE_API_KEY') ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is missing')
  }

  return new Anthropic({ apiKey })
}

function getAnthropicModelCandidates(): string[] {
  const configuredModel =
    readEnvFileValue(path.join(process.cwd(), '.env.local'), 'ANTHROPIC_MODEL') ||
    process.env.ANTHROPIC_MODEL

  return [
    configuredModel,
    'claude-sonnet-4-6',
    'claude-sonnet-4-5-20250929',
    'claude-3-5-sonnet-20241022',
    'claude-3-haiku-20240307'
  ].filter(Boolean) as string[]
}

async function createMessageWithModelFallback(params: any) {
  const client = createAnthropicClient()
  let lastError: unknown

  for (const model of getAnthropicModelCandidates()) {
    try {
      return await client.messages.create({
        ...params,
        model
      })
    } catch (error) {
      lastError = error
      const status = (error as any)?.status
      const message = error instanceof Error ? error.message : String(error)
      const canTryNext =
        status === 404 ||
        message.includes('not_found_error') ||
        message.toLowerCase().includes('model')

      if (!canTryNext) {
        throw error
      }
    }
  }

  throw lastError
}

// Valid scene types for validation
export const VALID_SCENE_TYPES: SceneType[] = [
  'FullScreen',
  'LowerThird',
  'Split',
  'SplitVertical',
  'Card',
  'Message',
  'Number',
  'Flow',
  'CTA',
  'StickFigures',
  'ImageInsert',
  'AssetCard'
]

export const VALID_ASSET_CARD_STYLES = ['credibility', 'meme', 'news'] as const

export const VALID_VISUAL_ROLES = ['evidence', 'contrast', 'process', 'context', 'decision']
export const VALID_NARRATIVE_ROLES: NarrativeRole[] = [
  'hook',
  'context',
  'proof',
  'process',
  'objection',
  'decision',
  'cta'
]

function inferNarrativeRole(startLeg: number, subtitleCount: number): NarrativeRole {
  if (subtitleCount <= 0) {
    return 'context'
  }

  const progress = startLeg / Math.max(1, subtitleCount - 1)
  if (progress <= 0.16) {
    return 'hook'
  }
  if (progress >= 0.86) {
    return 'cta'
  }

  return 'context'
}

export function normalizeNarrativeRole(value: unknown, startLeg: number, subtitleCount: number): NarrativeRole {
  return VALID_NARRATIVE_ROLES.includes(value as NarrativeRole)
    ? (value as NarrativeRole)
    : inferNarrativeRole(startLeg, subtitleCount)
}

export const SEGMENT_LAYOUTS = ['split-50', 'blur-bg', 'tweet-card']

/**
 * Normaliza os campos de segmento (segmentLayout / segmentEffects) de uma cena.
 * Aceita apenas valores da whitelist; `null`/`''`/inválido remove o campo — assim
 * o diretor pode tirar uma cena de split/blur/tweet passando segmentLayout=null,
 * e o analyze descarta silenciosamente qualquer valor que a IA invente.
 * Fonte única compartilhada entre o pipeline de analyze e o project-director.
 */
export function normalizeSegmentFields(sceneData: any): void {
  if (SEGMENT_LAYOUTS.includes(sceneData.segmentLayout)) {
    // mantém
  } else {
    delete sceneData.segmentLayout
  }

  const eff = sceneData.segmentEffects
  if (eff && typeof eff === 'object') {
    const out: { zoom?: 'in' | 'out'; bw?: boolean } = {}
    if (eff.zoom === 'in' || eff.zoom === 'out') out.zoom = eff.zoom
    if (eff.bw === true) out.bw = true
    if (out.zoom || out.bw) {
      sceneData.segmentEffects = out
    } else {
      delete sceneData.segmentEffects
    }
  } else {
    delete sceneData.segmentEffects
  }
}

/**
 * Restrições específicas do analyze para o LAYOUT de segmento (não os efeitos):
 * `split-50` e `blur-bg` usam a imagem, então só sobrevivem em cenas ImageInsert;
 * `tweet-card` renderiza o texto da cena como post, então só sobrevive quando a
 * cena tem um campo `text` de no máximo 20 palavras. Fora dessas condições o
 * segmentLayout é removido silenciosamente — a cena e os segmentEffects ficam.
 * Deve rodar DEPOIS de sanitizeSceneCopy (quando `text` já está no formato final).
 */
export function enforceAnalyzeSegmentConstraints(sceneData: any): void {
  const layout = sceneData.segmentLayout
  if (!layout) return

  if ((layout === 'split-50' || layout === 'blur-bg') && sceneData.type !== 'ImageInsert') {
    delete sceneData.segmentLayout
    return
  }

  if (layout === 'tweet-card') {
    const text = typeof sceneData.text === 'string' ? sceneData.text.trim() : ''
    const wordCount = text ? text.split(/\s+/).filter(Boolean).length : 0
    if (!text || wordCount > 20) {
      delete sceneData.segmentLayout
    }
  }
}

/**
 * Pacote 5 — whitelist the two per-scene edit tactics that apply across the
 * pipeline and the director:
 *  - transitionIn: BANIDO (o flash branco lia como "piscada" — decisão do
 *    dono, 2026-07-03); nenhum valor sobrevive;
 *  - variant: só 'torn-paper' | 'crt-glitch' e SOMENTE em FullScreen (title-card).
 * (o stutter do ImageInsert é tratado em normalizeImageInsertMedia). Valores
 * inválidos são removidos silenciosamente. Mutação in-place.
 */
export function normalizeSceneTactics(sceneData: any): void {
  delete sceneData.transitionIn

  if (sceneData.type === 'FullScreen') {
    if (sceneData.variant !== 'torn-paper' && sceneData.variant !== 'crt-glitch') {
      delete sceneData.variant
    }
  } else {
    delete sceneData.variant
  }
}

/**
 * Em/en-dash read as AI-generated copy (regra do dono, inegociavel). Any dash
 * used as sentence punctuation becomes a comma; runs of resulting double
 * commas/spacing collapse back to something clean. Applied to every copy
 * field (and hookTitle) so no visible text ever carries a travessao.
 */
function stripAiDashes(text: string): string {
  return text
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/,\s*,+/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Shared cleanup for every copy field: strips decorative emoji, collapses
 * whitespace, and normalizes em/en-dashes to commas. Both limitCopy (char-cap)
 * and enforceWordBudget (word-cap, complete-or-discard) build on this so the
 * dash rule and emoji stripping apply everywhere copy flows through either.
 */
export function cleanCopyText(value: unknown): string {
  return stripAiDashes(
    String(value || '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?/gu, '')
      .replace(/[\uFE0F\u200D]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function limitCopy(value: unknown, maxChars: number): string {
  const text = cleanCopyText(value)

  if (text.length <= maxChars) {
    return text
  }

  const slice = text.slice(0, maxChars - 1)
  const lastSpace = slice.lastIndexOf(' ')
  return `${slice.slice(0, lastSpace > 20 ? lastSpace : maxChars - 1).trim()}...`
}

/**
 * Complete-or-discard word budget for copy plotted directly over the video
 * (FullScreen, CTA, Split, StickFigures captions, etc). Copy is NEVER
 * truncated mechanically: a string of at most `hardMax` words (default
 * target+3, a small tolerance so a finished thought can land) passes through
 * INTACT, even above `target`. Anything longer returns null so the caller
 * drops the field (optional copy) or discards the whole scene/operation
 * (main copy), never chopping a sentence mid-thought.
 */
function enforceWordBudget(value: unknown, target: number, hardMax: number = target + 3): string | null {
  const text = cleanCopyText(value)
  if (!text) return null
  const words = text.split(' ').filter(Boolean)
  if (words.length > hardMax) return null
  return text
}

/**
 * Content tokens of a string, accent-folded and lowercased, stopwords/short
 * words dropped. Used to detect a hookTitle that merely restates a scene.
 */
function contentTokens(value: unknown): Set<string> {
  return new Set(
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  )
}

const HOOK_SCENE_TEXT_KEYS = [
  'text',
  'title',
  'subtitle',
  'highlight',
  'sourceText',
  'imageAlt',
  'message',
  'headline'
]

/**
 * True when `hookTitle` is essentially the same promise as some scene's copy:
 * >70% of the headline's content tokens already appear in that scene's text.
 * A persistent manchete that duplicates the opening title-card is noise, so the
 * caller discards it. Empty/degenerate headlines never match.
 */
function hookTitleDuplicatesScene(hookTitle: string, scenes: any[]): boolean {
  const hookTokens = contentTokens(hookTitle)
  if (hookTokens.size === 0) return false
  return (scenes || []).some((scene) => {
    const sceneText = HOOK_SCENE_TEXT_KEYS.map((k) => scene?.[k])
      .filter((v) => typeof v === 'string')
      .join(' ')
    const sceneTokens = contentTokens(sceneText)
    if (sceneTokens.size === 0) return false
    let shared = 0
    for (const t of hookTokens) {
      if (sceneTokens.has(t)) shared += 1
    }
    return shared / hookTokens.size > 0.7
  })
}

export function sanitizeSceneCopy(sceneData: any, options?: { stripStutter?: boolean }): any {
  switch (sceneData.type) {
    case 'FullScreen':
      // text/subtitle already went through enforceWordBudget in
      // normalizeTypographicScene (complete-or-discard) — no re-truncation
      // here, that would defeat the guarantee.
      sceneData.highlight = sceneData.highlight ? limitCopy(sceneData.highlight, 40) : undefined
      delete sceneData.fontSize
      delete sceneData.color
      delete sceneData.bgColor
      break
    case 'LowerThird':
      sceneData.title = limitCopy(sceneData.title, 42)
      // subtitle already word-budgeted upstream; no re-cap here.
      break
    case 'Split':
      // topText/bottomText already went through enforceWordBudget in
      // normalizeTypographicScene (complete-or-discard) — no re-truncation.
      break
    case 'SplitVertical':
      sceneData.leftLabel = limitCopy(sceneData.leftLabel, 24)
      sceneData.rightLabel = limitCopy(sceneData.rightLabel, 24)
      sceneData.leftText = limitCopy(sceneData.leftText, 54)
      sceneData.rightText = limitCopy(sceneData.rightText, 54)
      break
    case 'Card':
      sceneData.title = limitCopy(sceneData.title, 48)
      sceneData.description = limitCopy(sceneData.description, 80)
      break
    case 'Message':
      sceneData.sender = limitCopy(sceneData.sender, 24)
      sceneData.message = limitCopy(sceneData.message, 80)
      break
    case 'Number':
      sceneData.value = limitCopy(sceneData.value, 22)
      sceneData.label = limitCopy(sceneData.label, 58)
      break
    case 'Flow':
      sceneData.steps = Array.isArray(sceneData.steps)
        ? sceneData.steps.slice(0, 4).map((step: unknown) => limitCopy(step, 42))
        : []
      break
    case 'CTA':
      // text/highlight already went through enforceWordBudget in
      // normalizeTypographicScene (complete-or-discard) — no re-truncation.
      // Optional yellow action box label: word-budgeted (5/8), dropped when it
      // overshoots rather than chopped.
      if (sceneData.boxText) {
        const box = enforceWordBudget(sceneData.boxText, 5, 8)
        if (box) {
          sceneData.boxText = box
        } else {
          console.warn(`CTA scene: dropping boxText exceeding word budget: "${sceneData.boxText}"`)
          delete sceneData.boxText
        }
      } else {
        delete sceneData.boxText
      }
      break
    case 'StickFigures':
      // situation/caption already went through enforceWordBudget in
      // normalizeTypographicScene (complete-or-discard) — no re-truncation.
      break
    case 'ImageInsert':
      sceneData.layout = ['split-bottom', 'top-image-compact'].includes(sceneData.layout)
        ? sceneData.layout
        : 'full'
      sceneData.visualRole = VALID_VISUAL_ROLES.includes(sceneData.visualRole)
        ? sceneData.visualRole
        : 'context'
      sceneData.narrativeRole = VALID_NARRATIVE_ROLES.includes(sceneData.narrativeRole)
        ? sceneData.narrativeRole
        : 'context'
      sceneData.imagePrompt = limitCopy(sceneData.imagePrompt || sceneData.prompt || sceneData.description, 700)
      sceneData.imageAlt = limitCopy(sceneData.imageAlt || sceneData.imagePrompt, 120)
      sceneData.sourceText = limitCopy(sceneData.sourceText || sceneData.spokenText || sceneData.imageAlt, 220)
      normalizeImageInsertMedia(sceneData, options)
      delete sceneData.text
      delete sceneData.title
      delete sceneData.subtitle
      delete sceneData.description
      delete sceneData.message
      delete sceneData.value
      delete sceneData.label
      delete sceneData.topText
      delete sceneData.bottomText
      delete sceneData.leftText
      delete sceneData.rightText
      delete sceneData.situation
      delete sceneData.caption
      delete sceneData.steps
      break
  }

  return sceneData
}

/**
 * Whitelist the Pacote 3 media fields on an ImageInsert scene (mutates in place):
 *  - motion: boolean flag (only true/false survives)
 *  - source: 'generate' | 'stock' (default 'generate')
 *  - stockQuery: short English query, ≤ 6 words, only kept for source === 'stock'
 *
 * `stripStutter` removes any stutter flag unconditionally — stutter é tática
 * manual (diretor); a IA não a usa sozinha, pulos secos reprovados em produção.
 * Passado true pelo caminho do analyzeContent; refineScene e o diretor mantêm
 * o comportamento antigo (aceitam stutter:true vindo do modelo/instrução).
 */
function normalizeImageInsertMedia(sceneData: any, options?: { stripStutter?: boolean }): void {
  sceneData.motion = sceneData.motion === true

  // Pacote 5: stutter cluster flag — keep only when explicitly true, unless
  // the caller (analyze) forces it off.
  if (sceneData.stutter === true && !options?.stripStutter) {
    sceneData.stutter = true
  } else {
    delete sceneData.stutter
  }

  sceneData.source = sceneData.source === 'stock' ? 'stock' : 'generate'

  if (sceneData.source === 'stock' && typeof sceneData.stockQuery === 'string') {
    const words = sceneData.stockQuery.trim().split(/\s+/).filter(Boolean).slice(0, 6)
    if (words.length > 0) {
      sceneData.stockQuery = words.join(' ')
    } else {
      delete sceneData.stockQuery
      sceneData.source = 'generate'
    }
  } else {
    delete sceneData.stockQuery
  }
}

/**
 * Validate/normalize an AssetCard scene (Pacote 4). Requires a valid assetId
 * present in the passed catalog id-set (invalid → null, so the caller DROPS it —
 * an AssetCard with no real asset can't render). Whitelists style, caps the
 * optional name/caption, and strips foreign fields. Mutates in place.
 */
export function sanitizeAssetCardScene(sceneData: any, validAssetIds?: Set<string>): any | null {
  const assetId = typeof sceneData.assetId === 'string' ? sceneData.assetId.trim() : ''
  if (!assetId) return null
  if (validAssetIds && !validAssetIds.has(assetId)) return null

  sceneData.assetId = assetId
  sceneData.style = (VALID_ASSET_CARD_STYLES as readonly string[]).includes(sceneData.style)
    ? sceneData.style
    : 'credibility'

  if (sceneData.name) {
    const name = enforceWordBudget(sceneData.name, 6, 9)
    if (name) {
      sceneData.name = name
    } else {
      console.warn(`AssetCard scene: dropping name exceeding word budget: "${sceneData.name}"`)
      delete sceneData.name
    }
  } else {
    delete sceneData.name
  }

  if (sceneData.caption) {
    const caption = enforceWordBudget(sceneData.caption, 8, 11)
    if (caption) {
      sceneData.caption = caption
    } else {
      console.warn(`AssetCard scene: dropping caption exceeding word budget: "${sceneData.caption}"`)
      delete sceneData.caption
    }
  } else {
    delete sceneData.caption
  }

  // Strip any typographic field the model may have leaked onto the card.
  for (const field of [
    'text', 'title', 'subtitle', 'description', 'message', 'value', 'label',
    'topText', 'bottomText', 'leftText', 'rightText', 'leftLabel', 'rightLabel',
    'situation', 'steps', 'highlight', 'imagePrompt', 'imageAlt', 'sourceText', 'layout'
  ]) {
    delete sceneData[field]
  }
  return sceneData
}

/**
 * Compact "BIBLIOTECA DE ASSETS" prompt section (shared by analyze + director).
 * Returns '' when the catalog is empty so the prompt is unchanged with no assets.
 */
function buildAssetCatalogSection(catalog?: AssetCatalogItem[]): string {
  if (!catalog || catalog.length === 0) return ''

  const list = catalog
    .slice(0, 50)
    .map(
      (a) =>
        `- id=${a.id} [${a.kind}] "${a.label}"${a.tags.length ? ` — tags: ${a.tags.join(', ')}` : ''}`
    )
    .join('\n')

  return `

BIBLIOTECA DE ASSETS (mídias PRÓPRIAS do usuário — use SOMENTE os ids abaixo, NUNCA invente um id):
${list}

Você pode usar esses assets de duas formas:
- Cena AssetCard: { "type": "AssetCard", "startLeg": <int>, "durationInSubtitles": 1, "assetId": "<id da lista>", "style": "<credibility|meme|news>", ... }. Dura ~1-1.5s (feita para rajada). Estilos:
  - "credibility": foto de PESSOA (rosto) num card + o NOME abaixo (campo "name"). Use em RAJADA de prova social: 2 a 4 AssetCard credibility SEGUIDOS (~1s cada, startLeg consecutivos) quando houver fotos de pessoas taggeadas (cliente, aluno, autoridade, depoimento).
  - "meme": imagem de cultura pop / analogia (meme de filme ou série) com "caption" curta (≤8 palavras). NO MÁXIMO 1 por vídeo, para uma analogia cultural pontual.
  - "news": print de notícia como HOOK alternativo. SEM texto extra (não preencha name/caption).
- ImageInsert com "assetId": quando um asset da biblioteca ilustrar o momento MELHOR do que gerar uma imagem, adicione "assetId": "<id da lista>" ao ImageInsert (em vez de depender só do imagePrompt).
REGRA DURA: só use assetId que EXISTA na lista acima. Combine o asset pelas tags/label com o momento da fala.`
}

function coerceString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }
  return ''
}

/**
 * Normalize and validate a typographic (non-ImageInsert) scene's required props.
 * Attempts simple coercion (e.g. text -> title). Returns null when the scene is
 * missing content that cannot be recovered, so the caller can DISCARD it.
 * ImageInsert scenes are handled separately in the analyze/refine flows.
 */
export function normalizeTypographicScene(sceneData: any): any | null {
  switch (sceneData.type) {
    case 'FullScreen': {
      const highlight = coerceString(sceneData.highlight, sceneData.highlightWord)
      const text = coerceString(sceneData.text, sceneData.title, sceneData.subtitle)
      if (!text) {
        return null
      }
      // Main copy plotted over the video: complete-or-discard, 6-word target,
      // 9-word hard ceiling. Never truncated mechanically.
      const budgeted = enforceWordBudget(text, 6, 9)
      if (!budgeted) {
        console.warn(`Discarding FullScreen scene: text exceeds word budget: "${text}"`)
        return null
      }
      sceneData.text = budgeted
      // Optional secondary subtitle: drop (don't chop) when it overshoots.
      const subtitleRaw = coerceString(sceneData.subtitle)
      if (subtitleRaw) {
        const subtitleBudgeted = enforceWordBudget(subtitleRaw, 5, 8)
        if (subtitleBudgeted) {
          sceneData.subtitle = subtitleBudgeted
        } else {
          console.warn(`FullScreen scene: dropping subtitle exceeding word budget: "${subtitleRaw}"`)
          sceneData.subtitle = undefined
        }
      } else {
        sceneData.subtitle = undefined
      }
      // Optional highlight: keep only when it is a word contained in the budgeted text.
      sceneData.highlight =
        highlight && budgeted.toLowerCase().includes(highlight.toLowerCase())
          ? highlight
          : undefined
      return sceneData
    }
    case 'LowerThird': {
      const title = coerceString(sceneData.title, sceneData.text)
      const subtitleRaw = coerceString(sceneData.subtitle, sceneData.description, sceneData.label)
      if (!title && !subtitleRaw) {
        return null
      }
      sceneData.title = title || subtitleRaw
      // Secondary caption over video: word-budgeted (5/8), optional, dropped
      // (not chopped) when it overshoots.
      if (subtitleRaw) {
        const subtitleBudgeted = enforceWordBudget(subtitleRaw, 5, 8)
        if (subtitleBudgeted) {
          sceneData.subtitle = subtitleBudgeted
        } else {
          console.warn(`LowerThird scene: dropping subtitle exceeding word budget: "${subtitleRaw}"`)
          sceneData.subtitle = ''
        }
      } else {
        sceneData.subtitle = ''
      }
      return sceneData
    }
    case 'Split': {
      const topTextRaw = coerceString(sceneData.topText, sceneData.title)
      const bottomTextRaw = coerceString(sceneData.bottomText, sceneData.content, sceneData.description)
      if (!topTextRaw && !bottomTextRaw) {
        return null
      }
      // bottomText = main line plotted over the video (fala): complete-or-discard,
      // 6-word target, 9-word hard ceiling.
      let bottomBudgeted = ''
      if (bottomTextRaw) {
        const budgeted = enforceWordBudget(bottomTextRaw, 6, 9)
        if (!budgeted) {
          console.warn(`Discarding Split scene: bottomText exceeds word budget: "${bottomTextRaw}"`)
          return null
        }
        bottomBudgeted = budgeted
      }
      // topText = secondary context, optional, dropped (not chopped) when it overshoots.
      let topBudgeted = ''
      if (topTextRaw) {
        const budgeted = enforceWordBudget(topTextRaw, 5, 8)
        if (budgeted) {
          topBudgeted = budgeted
        } else {
          console.warn(`Split scene: dropping topText exceeding word budget: "${topTextRaw}"`)
        }
      }
      sceneData.topText = topBudgeted
      sceneData.bottomText = bottomBudgeted
      return sceneData
    }
    case 'SplitVertical': {
      const leftText = coerceString(sceneData.leftText, sceneData.leftContent, sceneData.leftLabel)
      const rightText = coerceString(sceneData.rightText, sceneData.rightContent, sceneData.rightLabel)
      if (!leftText || !rightText) {
        return null
      }
      sceneData.leftText = leftText
      sceneData.rightText = rightText
      sceneData.leftLabel = coerceString(sceneData.leftLabel) || 'Antes'
      sceneData.rightLabel = coerceString(sceneData.rightLabel) || 'Depois'
      // Congruência cognitiva (regra do dono): NEGATIVO à esquerda com tom
      // brando, POSITIVO à direita com destaque (o componente acende a direita).
      // Se os rótulos vierem invertidos, troca os lados inteiros.
      const NEG = /^(sem|antes|errado|fraco|velho|nunca|não)\b/i
      const POS = /^(com|depois|certo|forte|novo|sempre)\b/i
      const leftPositive =
        (POS.test(sceneData.leftLabel) && !POS.test(sceneData.rightLabel)) ||
        (NEG.test(sceneData.rightLabel) && !NEG.test(sceneData.leftLabel))
      if (leftPositive) {
        ;[sceneData.leftLabel, sceneData.rightLabel] = [sceneData.rightLabel, sceneData.leftLabel]
        ;[sceneData.leftText, sceneData.rightText] = [sceneData.rightText, sceneData.leftText]
        console.warn('[copy] SplitVertical com polaridade invertida — lados trocados (positivo vai à direita)')
      }
      return sceneData
    }
    case 'Card': {
      const title = coerceString(sceneData.title, sceneData.text)
      const description = coerceString(sceneData.description, sceneData.subtitle)
      if (!title) {
        return null
      }
      const parsedNumber = Number(sceneData.number)
      sceneData.number = Number.isFinite(parsedNumber) && parsedNumber > 0 ? Math.floor(parsedNumber) : 1
      sceneData.title = title
      sceneData.description = description
      return sceneData
    }
    case 'Message': {
      const message = coerceString(sceneData.message, sceneData.text, sceneData.messageText)
      if (!message) {
        return null
      }
      sceneData.sender = coerceString(sceneData.sender, sceneData.senderName) || 'Mensagem'
      sceneData.message = message
      return sceneData
    }
    case 'Number': {
      const value = coerceString(sceneData.value, sceneData.number)
      const label = coerceString(sceneData.label, sceneData.description, sceneData.title)
      if (!value || !label) {
        return null
      }
      sceneData.value = value
      sceneData.label = label
      return sceneData
    }
    case 'Flow': {
      const steps = Array.isArray(sceneData.steps)
        ? sceneData.steps
            .map((step: unknown) =>
              typeof step === 'object' && step !== null
                ? coerceString((step as any).text, (step as any).label)
                : coerceString(step)
            )
            .filter((step: string) => step.length > 0)
        : []
      if (steps.length < 2) {
        return null
      }
      sceneData.steps = steps
      return sceneData
    }
    case 'CTA': {
      const text = coerceString(sceneData.text, sceneData.title)
      if (!text) {
        return null
      }
      // Main CTA line plotted over the video: complete-or-discard, 6-word
      // target, 9-word hard ceiling. Never truncated mechanically.
      const budgeted = enforceWordBudget(text, 6, 9)
      if (!budgeted) {
        console.warn(`Discarding CTA scene: text exceeds word budget: "${text}"`)
        return null
      }
      sceneData.text = budgeted
      // highlight must be a substring of the budgeted text; fall back to the last word.
      const highlight = coerceString(sceneData.highlight, sceneData.highlightWord)
      sceneData.highlight =
        highlight && budgeted.toLowerCase().includes(highlight.toLowerCase())
          ? highlight
          : budgeted.trim().split(/\s+/).slice(-1)[0] || budgeted
      return sceneData
    }
    case 'StickFigures': {
      const situationRaw = coerceString(sceneData.situation, sceneData.leftCaption, sceneData.text)
      const captionRaw = coerceString(sceneData.caption, sceneData.rightCaption, sceneData.description)
      if (!situationRaw && !captionRaw) {
        return null
      }
      // situation = main copy plotted over video: complete-or-discard, 6-word
      // target, 9-word hard ceiling.
      const mainRaw = situationRaw || captionRaw
      const situationBudgeted = enforceWordBudget(mainRaw, 6, 9)
      if (!situationBudgeted) {
        console.warn(`Discarding StickFigures scene: situation exceeds word budget: "${mainRaw}"`)
        return null
      }
      sceneData.situation = situationBudgeted
      // caption = secondary, optional, dropped (not chopped) when it overshoots.
      const secondaryRaw = captionRaw || situationRaw
      const captionBudgeted = secondaryRaw ? enforceWordBudget(secondaryRaw, 5, 8) : null
      if (secondaryRaw && !captionBudgeted) {
        console.warn(`StickFigures scene: dropping caption exceeding word budget: "${secondaryRaw}"`)
      }
      sceneData.caption = captionBudgeted || ''
      return sceneData
    }
    default:
      return null
  }
}

/**
 * Build the prompt fragment that instructs Claude how to handle the color
 * palette when the user has configured brand color groups in /settings.
 * Returns '' when no brand colors are configured (palette stays AI-invented,
 * preserving the previous behavior).
 */
function buildBrandColorPromptSection(brandColors?: AnalyzeContentBrandColors): string {
  if (!brandColors) return ''

  if (brandColors.forced) {
    const g = brandColors.forced
    return `

GRUPO DE CORES DA MARCA (OBRIGATÓRIO — o usuário já definiu, NÃO invente uma paleta diferente):
Use exatamente o grupo "${g.name}": accent=${g.accent}${g.primary ? `, primary=${g.primary}` : ''}${g.background ? `, background=${g.background}` : ''}${g.text ? `, text=${g.text}` : ''}.
No JSON de resposta, o campo "accent" da paleta DEVE ser exatamente ${g.accent}.
${g.primary ? `O campo "primary" DEVE ser exatamente ${g.primary}.` : 'Escolha "primary" em harmonia com o accent acima.'}
${g.background ? `O campo "background" DEVE ser exatamente ${g.background}.` : 'Escolha "background" com bom contraste para o accent e para o texto.'}
${g.text ? `O campo "text" DEVE ser exatamente ${g.text}.` : 'Escolha "text" com alto contraste sobre o background.'}`
  }

  if (brandColors.groups.length > 0) {
    const list = brandColors.groups
      .map((g) => {
        const parts = [`accent=${g.accent}`]
        if (g.primary) parts.push(`primary=${g.primary}`)
        if (g.background) parts.push(`background=${g.background}`)
        if (g.text) parts.push(`text=${g.text}`)
        return `- "${g.name}": ${parts.join(', ')}`
      })
      .join('\n')
    return `

GRUPOS DE CORES DA MARCA (o usuário já cadastrou estes grupos — ESCOLHA OBRIGATORIAMENTE UM deles, NÃO invente uma paleta nova):
${list}
Escolha o grupo que combina melhor com o tom/conteúdo deste vídeo específico. No JSON de resposta, inclua um campo adicional "chosenColorGroup" com o NOME EXATO do grupo escolhido (ex.: "chosenColorGroup": "${brandColors.groups[0].name}").
O campo "accent" da paleta retornada DEVE ser exatamente o accent do grupo escolhido. Para primary/background/text: quando o grupo define o valor, use-o exatamente; quando não define, complete com harmonia e bom contraste.`
  }

  return ''
}

/**
 * Resolve the final palette, applying a forced or AI-chosen brand color group
 * on top of whatever Claude returned. Guarantees the accent (and any other
 * fixed fields) of a configured group is never overridden by model drift.
 */
function resolvePaletteWithBrandColors(
  analysisData: any,
  brandColors?: AnalyzeContentBrandColors
): { palette: ColorPalette; colorGroup?: string } {
  const rawPalette = analysisData?.palette
  const basePalette: ColorPalette = {
    primary: typeof rawPalette?.primary === 'string' ? rawPalette.primary : '#0066FF',
    secondary: typeof rawPalette?.secondary === 'string' ? rawPalette.secondary : '#0052CC',
    accent: typeof rawPalette?.accent === 'string' ? rawPalette.accent : '#FF6B35',
    background: typeof rawPalette?.background === 'string' ? rawPalette.background : '#FFFFFF',
    text: typeof rawPalette?.text === 'string' ? rawPalette.text : '#000000'
  }

  if (!brandColors) {
    return { palette: basePalette }
  }

  const applyGroup = (group: BrandColorGroup): { palette: ColorPalette; colorGroup?: string } => ({
    palette: {
      ...basePalette,
      accent: group.accent,
      primary: group.primary || basePalette.primary,
      background: group.background || basePalette.background,
      text: group.text || basePalette.text
    },
    colorGroup: group.name
  })

  if (brandColors.forced) {
    return applyGroup(brandColors.forced)
  }

  if (brandColors.groups.length > 0) {
    const chosenValue = typeof analysisData?.chosenColorGroup === 'string' ? analysisData.chosenColorGroup.trim() : ''
    const chosenLower = chosenValue.toLowerCase()
    const matched =
      brandColors.groups.find((g) => g.name.trim().toLowerCase() === chosenLower) ||
      brandColors.groups.find((g) => g.id === chosenValue) ||
      brandColors.groups.find(
        (g) => g.accent.toLowerCase() === String(rawPalette?.accent || '').toLowerCase()
      )

    // If Claude failed to identify a valid group, default to the first one —
    // never fall back to an AI-invented palette when groups are configured.
    return applyGroup(matched || brandColors.groups[0])
  }

  return { palette: basePalette }
}

// ---------------------------------------------------------------------------
// DIREÇÃO EM DUAS PASSADAS — a passada 1 mapeia a narração em BLOCOS; a passada 2
// (a chamada principal) monta as cenas com COTAS por bloco; o código então mede
// déficits, faz REPAROS cirúrgicos e, por fim, PROMOÇÃO DETERMINÍSTICA onde
// seguro. Objetivo: matar o "série D" (muito texto, zero imagem/layout/efeito).
// ---------------------------------------------------------------------------

export type BlockRole = 'gancho' | 'contexto' | 'prova' | 'historia' | 'virada' | 'cta'

export interface NarrativeBlock {
  papel: BlockRole
  startLeg: number
  endLeg: number
  resumo: string
  momentoChave: string | null
  citacaoForte: string | null
  dorOuProblema: boolean
}

const VALID_BLOCK_ROLES: BlockRole[] = ['gancho', 'contexto', 'prova', 'historia', 'virada', 'cta']

/** Shared JSON extractor: strips a markdown ```json fence if present, then parses. */
function parseJsonFromClaude(text: string): any {
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, text]
  const jsonString = jsonMatch[1] || text
  return JSON.parse(jsonString)
}

function nullableString(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars).trim() : trimmed
}

/**
 * PASSADA 1 — ROTEIRO. Chamada Claude enxuta: recebe transcrição + legendas
 * numeradas e devolve BLOCOS narrativos cobrindo a timeline inteira (5-10).
 * Cada bloco carrega papel, intervalo de legendas, resumo, momento visual mais
 * forte, uma citação digna de tweet (ou null) e se trata de dor/problema.
 * Nunca lança: numa falha devolve [] (a passada 2 roda sem cotas de bloco).
 */
async function runScriptPass(
  transcriptionText: string,
  subtitles: SubtitleEntry[]
): Promise<NarrativeBlock[]> {
  if (subtitles.length === 0) return []

  const numberedSubtitles = subtitles
    .map((subtitle, index) => `${index}: [${subtitle.startTime.toFixed(2)}s] ${subtitle.text}`)
    .join('\n')

  const systemPrompt = `Você é um roteirista que lê a NARRAÇÃO de um vídeo e a divide em BLOCOS narrativos (entre 5 e 10), cobrindo a timeline INTEIRA sem buracos nem sobreposição. Cada bloco é um trecho contíguo de legendas com um papel narrativo.

PAPÉIS: "gancho" (abertura/tensão), "contexto" (situação/pano de fundo), "prova" (evidência, número, exemplo concreto), "historia" (caso/relato vivido), "virada" (o insight/mudança), "cta" (chamada final).

Para CADA bloco identifique:
- papel: um dos acima.
- startLeg / endLeg: índices inteiros 0-based da primeira e última legenda do bloco (contíguos; o startLeg do próximo bloco = endLeg anterior + 1; o 1º bloco começa em 0; o último termina na última legenda).
- resumo: 1 frase curta do que acontece.
- momentoChave: a imagem/objeto/cena física mais forte para ilustrar o bloco (ou null).
- citacaoForte: uma frase FALADA no bloco, curta e punchy, digna de virar um post/tweet (ou null se não houver nenhuma marcante).
- dorOuProblema: true se o bloco fala de uma DOR, medo, erro ou problema; senão false.

Responda SOMENTE com JSON válido, sem markdown:
{ "blocks": [ { "papel": "gancho", "startLeg": 0, "endLeg": 3, "resumo": "...", "momentoChave": "...", "citacaoForte": "...", "dorOuProblema": false } ] }`

  const userPrompt = `Transcrição completa:
${transcriptionText}

Timeline de legendas numeradas (índice: [tempo] texto):
${numberedSubtitles}

Divida em 5-10 blocos cobrindo TODA a timeline. Devolva só o JSON com "blocks".`

  try {
    const message = await createMessageWithModelFallback({
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
    const content = message.content[0]
    if (content.type !== 'text') return []
    const parsed = parseJsonFromClaude(content.text)
    const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.blocks) ? parsed.blocks : []
    const maxLeg = Math.max(0, subtitles.length - 1)
    const blocks: NarrativeBlock[] = raw
      .map((b: any): NarrativeBlock | null => {
        if (!b || typeof b !== 'object') return null
        const papel = VALID_BLOCK_ROLES.includes(b.papel) ? (b.papel as BlockRole) : 'contexto'
        let startLeg = Math.max(0, Math.min(Math.floor(Number(b.startLeg) || 0), maxLeg))
        let endLeg = Math.max(0, Math.min(Math.floor(Number(b.endLeg) || startLeg), maxLeg))
        if (endLeg < startLeg) endLeg = startLeg
        return {
          papel,
          startLeg,
          endLeg,
          resumo: nullableString(b.resumo, 200) || '',
          momentoChave: nullableString(b.momentoChave, 200),
          citacaoForte: nullableString(b.citacaoForte, 160),
          dorOuProblema: b.dorOuProblema === true
        }
      })
      .filter((b: NarrativeBlock | null): b is NarrativeBlock => b !== null)
      .slice(0, 10)
    return blocks
  } catch (error) {
    console.warn(`[analyze] passada 1 (roteiro) falhou, seguindo sem blocos: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/**
 * Build the per-block quota section fed to PASSADA 2. Every block gets explicit
 * COTAS mapped to the code floors (title-card+flash+motion no gancho, split-50
 * na prova/história, tweet-card na citação, bw na dor, ImageInsert específico em
 * bloco longo). '' quando não há blocos (passada 2 roda no modo antigo).
 */
function buildBlocksDirectiveSection(blocks: NarrativeBlock[]): string {
  if (!blocks.length) return ''
  // Só o PRIMEIRO bloco com citação forte recebe a cota de tweet-card: o playbook
  // manda no MÁXIMO 1 tweet-card por vídeo (o código também corta os excedentes).
  const tweetBlockIdx = blocks.findIndex((b) => b.citacaoForte)
  const lines = blocks.map((b, i) => {
    const cotas: string[] = []
    if (b.papel === 'gancho') {
      cotas.push('abra com um title-card FullScreen (variant torn-paper OU crt-glitch), e inclua um ImageInsert com motion:true')
    }
    if (b.papel === 'prova' || b.papel === 'historia') {
      cotas.push('inclua um ImageInsert com segmentLayout:"split-50" e imagePrompt ESPECÍFICO do que é dito aqui (PROIBIDO b-roll genérico de escritório/pessoas/estrada)')
    }
    if (b.citacaoForte && i === tweetBlockIdx) {
      cotas.push(`transforme a citação "${b.citacaoForte}" num tweet-card (FullScreen com text curto = a citação + segmentLayout:"tweet-card"). É o ÚNICO tweet-card do vídeo`)
    }
    if (b.dorOuProblema) {
      cotas.push('marque UMA cena deste bloco com segmentEffects:{"bw":true} (é dor/problema, pede preto e branco)')
    }
    if (b.endLeg - b.startLeg >= 3) {
      cotas.push('bloco longo: pelo menos 1 ImageInsert com imagePrompt concreto citando a fala deste bloco')
    }
    return `- Bloco ${i} [${b.papel}] legendas ${b.startLeg}-${b.endLeg}: ${b.resumo}${b.momentoChave ? ` | momento visual: ${b.momentoChave}` : ''}${cotas.length ? `\n    COTAS OBRIGATÓRIAS: ${cotas.join('; ')}` : ''}`
  })
  return `\n\nBLOCOS NARRATIVOS DA PASSADA DE ROTEIRO (cubra TODOS na ordem cronológica; CUMPRA as COTAS de cada bloco — são verificadas por código depois e o que faltar será consertado):\n${lines.join('\n')}\n`
}

/**
 * Validate + normalize ONE raw scene object into a Scene (or null to discard).
 * Extracted so both the main analyze map and the repair pass share the exact
 * same per-scene rules (type whitelist, startLeg clamp, copy budgets, media).
 */
function validateSceneData(
  sceneData: any,
  subtitles: SubtitleEntry[],
  validAssetIds: Set<string>,
  transcriptionText: string
): Scene | null {
  if (!VALID_SCENE_TYPES.includes(sceneData.type)) {
    console.warn(`Discarding scene with unsupported type: ${sceneData.type}`)
    return null
  }
  if (
    typeof sceneData.startLeg !== 'number' ||
    !Number.isFinite(sceneData.startLeg) ||
    sceneData.startLeg < 0 ||
    sceneData.startLeg >= subtitles.length
  ) {
    console.warn(`Invalid startLeg ${sceneData.startLeg}, clamping to valid range`)
  }
  sceneData.startLeg = Math.max(
    0,
    Math.min(Math.floor(Number(sceneData.startLeg) || 0), Math.max(0, subtitles.length - 1))
  )
  if (typeof sceneData.durationInSubtitles !== 'number' || sceneData.durationInSubtitles < 1) {
    sceneData.durationInSubtitles = 2
  }
  sceneData.durationInSubtitles = Math.max(1, Math.min(Math.floor(sceneData.durationInSubtitles), 3))
  delete sceneData.startFrame
  delete sceneData.endFrame

  if (sceneData.type === 'AssetCard') {
    const card = sanitizeAssetCardScene(sceneData, validAssetIds)
    if (!card) {
      console.warn('Discarding AssetCard scene with invalid/unknown assetId')
      return null
    }
    return card as Scene
  }

  if (sceneData.type === 'ImageInsert') {
    if (sceneData.assetId !== undefined) {
      const id = typeof sceneData.assetId === 'string' ? sceneData.assetId.trim() : ''
      if (id && validAssetIds.has(id)) {
        sceneData.assetId = id
      } else {
        console.warn(`Removing unknown assetId from ImageInsert: ${sceneData.assetId}`)
        delete sceneData.assetId
      }
    }
    sceneData.narrativeRole = normalizeNarrativeRole(sceneData.narrativeRole, sceneData.startLeg, subtitles.length)
    if (!sceneData.imagePrompt) {
      const subtitle = subtitles[sceneData.startLeg]
      sceneData.imagePrompt = `Premium contextual visual inspired by this spoken moment: "${subtitle?.text || transcriptionText.slice(0, 160)}". No text, no letters, no logos.`
    }
    if (!sceneData.sourceText) {
      sceneData.sourceText = subtitles[sceneData.startLeg]?.text || ''
    }
    // analyzeContent: stutter é tática manual do diretor, nunca da IA.
    return sanitizeSceneCopy(sceneData, { stripStutter: true }) as Scene
  }

  const normalized = normalizeTypographicScene(sceneData)
  if (!normalized) {
    console.warn(`Discarding ${sceneData.type} scene missing required content`)
    return null
  }
  return sanitizeSceneCopy(normalized, { stripStutter: true }) as Scene
}

/** Run the three shared segment/tactic normalizers over one scene, in place. */
function normalizeSceneSegments(scene: any): void {
  normalizeSegmentFields(scene)
  enforceAnalyzeSegmentConstraints(scene)
  normalizeSceneTactics(scene)
}

/**
 * Deterministic VARIETY cap so the fix for "zero layout" never overshoots into
 * spam: at most 1 tweet-card in the whole video (playbook rule) and at most 4
 * segment layouts total; extras revert to fullscreen (segmentLayout removed).
 * Keeps the first of each (split-50s survive over excess tweet-cards). Returns a
 * list of the cuts made, for logging. Mutates scenes in place.
 */
function capSegmentLayouts(scenes: Scene[]): string[] {
  const notes: string[] = []
  let tweetSeen = false
  for (const s of scenes as any[]) {
    if (s.segmentLayout === 'tweet-card') {
      if (tweetSeen) {
        delete s.segmentLayout
        notes.push(`tweet-card extra→fullscreen (${s.id})`)
      } else {
        tweetSeen = true
      }
    }
  }
  let count = 0
  for (const s of scenes as any[]) {
    if (!s.segmentLayout) continue
    if (count >= 4) {
      delete s.segmentLayout
      notes.push(`layout extra→fullscreen (${s.id})`)
      continue
    }
    count++
  }
  return notes
}

const DEFICIT_LABELS: Record<string, string> = {
  imginsert:
    'B-ROLL INSUFICIENTE: menos de 40% das cenas são ImageInsert. Adicione cenas ImageInsert nos blocos mais longos, cada uma com imagePrompt ESPECÍFICO da fala (nada de escritório/pessoas genéricas).',
  split50:
    'NENHUM segmentLayout "split-50". Escolha o melhor ImageInsert ilustrativo (bloco de prova/história) e devolva um update_scene com segmentLayout:"split-50".',
  tweet:
    'NENHUM tweet-card apesar de haver citação forte nos blocos. Crie 1 cena FullScreen com o text = a citação forte (≤ 20 palavras) e segmentLayout:"tweet-card".',
  bw:
    'NENHUMA cena em preto e branco apesar de haver bloco de DOR/PROBLEMA. Aplique segmentEffects:{"bw":true} numa cena do trecho de dor (update_scene).',
  motion:
    'MENOS de 2 ImageInserts com motion:true. Marque motion:true (update_scene) nos 2 inserts de maior impacto (priorize o gancho).'
}

/**
 * Measure the code floors on the current scene set. Returns the KEYS of every
 * violated floor (empty = clean). Floors gated on duration/blocks exactly as the
 * mission specifies: ImageInsert%≥40 (>45s), ≥1 split-50 (>60s), tweet-card iff
 * a block has citacaoForte, bw iff a block is dorOuProblema, ≥2 motion, ≥1 flash.
 */
function computeAnalysisDeficits(scenes: Scene[], blocks: NarrativeBlock[], spokenDuration: number): string[] {
  const deficits: string[] = []
  const n = scenes.length
  if (n === 0) return deficits
  const imageInserts = scenes.filter((s) => s.type === 'ImageInsert')
  const pct = Math.round((imageInserts.length / n) * 100)
  if (spokenDuration > 45 && pct < 40) deficits.push('imginsert')
  const splitCount = scenes.filter((s) => (s as any).segmentLayout === 'split-50').length
  if (spokenDuration > 60 && splitCount === 0) deficits.push('split50')
  const tweetCount = scenes.filter((s) => (s as any).segmentLayout === 'tweet-card').length
  if (blocks.some((b) => b.citacaoForte) && tweetCount === 0) deficits.push('tweet')
  const bwCount = scenes.filter((s) => (s as any).segmentEffects?.bw === true).length
  if (blocks.some((b) => b.dorOuProblema) && bwCount === 0) deficits.push('bw')
  const motionCount = scenes.filter((s) => (s as any).motion === true).length
  if (motionCount < 2 && imageInserts.length > 0) deficits.push('motion')
  return deficits
}

/**
 * REPARO CIRÚRGICO — uma chamada Claude curta que recebe os déficits, os blocos e
 * as cenas atuais e devolve APENAS operações mínimas (add_scene/update_scene) para
 * suprir o que faltou. Nunca lança (falha → []).
 */
async function runRepairPass(
  deficits: string[],
  scenes: Scene[],
  blocks: NarrativeBlock[],
  subtitles: SubtitleEntry[]
): Promise<any[]> {
  const numberedScenes = scenes
    .map((s, i) => `#${i} id=${s.id} type=${s.type} startLeg=${s.startLeg} dur=${s.durationInSubtitles} :: ${summarizeSceneForPrompt(s)}`)
    .join('\n')
  const blockList = blocks
    .map((b, i) => `Bloco ${i} [${b.papel}] leg ${b.startLeg}-${b.endLeg}${b.citacaoForte ? ` | citação: "${b.citacaoForte}"` : ''}${b.dorOuProblema ? ' | DOR' : ''}: ${b.resumo}`)
    .join('\n')
  const problems = deficits.map((d) => `- ${DEFICIT_LABELS[d] || d}`).join('\n')

  const systemPrompt = `Você é o diretor de cena consertando LACUNAS pontuais numa análise de vídeo já pronta. NÃO refaça o resto: devolva só as operações mínimas para suprir os itens faltantes. Máximo UMA operação por lacuna.
Regras: use SOMENTE ids de cena que existem na lista; imagePrompt SEM texto/letras/logos e ESPECÍFICO da fala do bloco; respeite os tetos de copy (texto sobre vídeo ≤ 6 palavras); PROIBIDO travessão. split-50/blur-bg só em ImageInsert; tweet-card com text ≤ 20 palavras.
Responda SOMENTE com JSON, sem markdown:
{ "operations": [ {"op":"add_scene","scene":{"type":"...","startLeg":<int>,"durationInSubtitles":<1-3>, ...props}}, {"op":"update_scene","sceneId":"<id existente>","changes":{ ...props ou segmentLayout/segmentEffects/motion/variant }} ] }`

  const userPrompt = `LACUNAS a suprir:
${problems}

BLOCOS:
${blockList || '(sem blocos)'}

CENAS ATUAIS:
${numberedScenes || '(nenhuma)'}

Devolva só o JSON com "operations" (mínimas, uma por lacuna).`

  try {
    const message = await createMessageWithModelFallback({
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
    const content = message.content[0]
    if (content.type !== 'text') return []
    const parsed = parseJsonFromClaude(content.text)
    return Array.isArray(parsed?.operations) ? parsed.operations.slice(0, 8) : []
  } catch (error) {
    console.warn(`[analyze] reparo falhou: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/** Apply repair operations (add/update) with the SAME validators as the main flow. */
function applyRepairOperations(
  ops: any[],
  scenes: Scene[],
  subtitles: SubtitleEntry[],
  validAssetIds: Set<string>,
  transcriptionText: string
): { scenes: Scene[]; applied: number } {
  let applied = 0
  let idCounter = scenes.length
  const out: Scene[] = [...scenes]
  for (const op of ops) {
    if (op?.op === 'add_scene' && op.scene && typeof op.scene === 'object') {
      const raw = { ...op.scene, id: typeof op.scene.id === 'string' && op.scene.id ? op.scene.id : `r${++idCounter}` }
      const v = validateSceneData(raw, subtitles, validAssetIds, transcriptionText)
      if (v) {
        normalizeSceneSegments(v)
        out.push(v)
        applied++
      }
    } else if (op?.op === 'update_scene' && typeof op.sceneId === 'string' && op.changes && typeof op.changes === 'object') {
      const idx = out.findIndex((s) => s.id === op.sceneId)
      if (idx >= 0) {
        const original = out[idx] as any
        // Keep id/type from the original scene; segment/tactic tweaks never change type.
        const merged = { ...original, ...op.changes, id: original.id, type: original.type }
        const v = validateSceneData(merged, subtitles, validAssetIds, transcriptionText)
        if (v) {
          normalizeSceneSegments(v)
          out[idx] = v
          applied++
        }
      }
    }
  }
  return { scenes: out, applied }
}

/**
 * PROMOÇÃO DETERMINÍSTICA — último recurso por código quando um déficit sobrevive
 * ao reparo, aplicada só onde é SEGURO (split-50 no ImageInsert mais longo; bw na
 * cena do bloco de dor; motion nos 2 primeiros inserts; flash na 1ª cena
 * tipográfica do gancho). imginsert/tweet não têm fallback seguro (ficam no
 * reparo). Loga cada promoção. Retorna as cenas e a lista de promoções.
 */
function applyDeterministicPromotions(
  scenes: Scene[],
  blocks: NarrativeBlock[],
  spokenDuration: number
): { scenes: Scene[]; promotions: string[] } {
  const promotions: string[] = []
  const out = [...scenes] as any[]
  const deficits = computeAnalysisDeficits(out as Scene[], blocks, spokenDuration)
  const inDorBlock = (s: any) => blocks.some((b) => b.dorOuProblema && s.startLeg >= b.startLeg && s.startLeg <= b.endLeg)
  const inHookBlock = (s: any) => blocks.some((b) => b.papel === 'gancho' && s.startLeg >= b.startLeg && s.startLeg <= b.endLeg)

  if (deficits.includes('split50')) {
    const inserts = out.filter((s) => s.type === 'ImageInsert')
    if (inserts.length) {
      const longest = inserts.reduce((a, b) => (b.durationInSubtitles > a.durationInSubtitles ? b : a))
      longest.segmentLayout = 'split-50'
      normalizeSceneSegments(longest)
      if (longest.segmentLayout === 'split-50') promotions.push(`split-50→${longest.id}`)
    }
  }
  if (deficits.includes('bw')) {
    const target = out.find(inDorBlock) || out[Math.floor(out.length / 2)]
    if (target) {
      target.segmentEffects = { ...(target.segmentEffects || {}), bw: true }
      normalizeSceneSegments(target)
      if (target.segmentEffects?.bw === true) promotions.push(`bw→${target.id}`)
    }
  }
  if (deficits.includes('motion')) {
    const already = out.filter((s) => s.type === 'ImageInsert' && s.motion === true).length
    let need = 2 - already
    for (const ins of out.filter((s) => s.type === 'ImageInsert' && s.motion !== true)) {
      if (need <= 0) break
      ins.motion = true
      promotions.push(`motion→${ins.id}`)
      need--
    }
  }
  return { scenes: out as Scene[], promotions }
}

/**
 * Analyze transcription to generate video scene structure
 * Uses Claude to determine narrative format, color palette, and scene breakdown
 * @param transcriptionText The transcribed text content
 * @param format Video format ('9:16' for vertical, '16:9' for horizontal)
 * @param brandColors Optional brand color groups from /settings. When provided
 *   with `forced`, that group's colors are used as-is (round-robin mode). When
 *   provided with only `groups`, Claude picks one (ai-pick mode). When omitted,
 *   the palette is fully AI-invented (previous behavior).
 * @param minimal When true, skips ALL scene AI calls (both passes) and returns
 *   scenes:[] with the group's default palette and no hookTitle — the video is
 *   just cut + subtitles, edited by hand via the beats panel. Cheap, no AI.
 * @returns AnalysisResult with narrative format, palette, and scenes
 */
export async function analyzeContent(
  transcriptionText: string,
  format: VideoFormat,
  subtitles: SubtitleEntry[],
  stylePreset: string = 'creator-clean',
  brandColors?: AnalyzeContentBrandColors,
  assetCatalog?: AssetCatalogItem[],
  minimal: boolean = false
): Promise<AnalysisResult> {
  try {
    // For simplicity in the initial analysis, we'll work with the text
    // and generate a basic scene structure
    // In a full implementation, this would parse segments more carefully

    const styleMeta = getInsertStylePresetMeta(stylePreset)
    const validAssetIds = new Set((assetCatalog || []).map((a) => a.id))

    // MODO MÍNIMO — sem NENHUMA chamada de cena: só corte + legendas. O dono edita
    // pelas batidas. Barato e sem IA: retorna scenes:[] com a paleta default do grupo.
    if (minimal) {
      const { palette, colorGroup } = resolvePaletteWithBrandColors({}, brandColors)
      return {
        narrativeFormat: 'Corte e legendas (modo mínimo, sem cenas de IA)',
        palette,
        scenes: [],
        ...(colorGroup ? { colorGroup } : {})
      }
    }

    // PASSADA 1 — ROTEIRO: mapeia a narração em BLOCOS narrativos que guiam a
    // passada 2 (cotas por bloco) e os pisos verificados por código.
    const blocks = await runScriptPass(transcriptionText, subtitles)
    const blocksDirective = buildBlocksDirectiveSection(blocks)

    const systemPrompt = `Você é um editor de vídeo sênior especializado em vídeos narrados premium para redes sociais (Reels/Shorts/TikTok/YouTube).
Seu trabalho é montar uma sequência de cenas visuais que pontuam os momentos-chave da narração. Você combina inserts de imagem (B-roll) com cenas tipográficas animadas para tornar a fala mais concreta, crível e fácil de entender.

TIPOS DE CENA DISPONÍVEIS (11 tipos — use o mais adequado ao SIGNIFICADO da fala):
- ImageInsert: ilustração documental de objeto, lugar, situação ou pessoa em contexto real (B-roll). Use quando a fala descreve uma cena física concreta.
- Number: um número, métrica ou percentual FALADO (ex.: "3x", "R$15k", "80%"). value = o número curto; label = o que ele significa.
- Flow: uma lista de passos ou etapas sequenciais (3 a 5 passos). steps = array de strings curtas.
- Card: um item de lista / conceito com título + descrição curta.
- SplitVertical: comparação, antes-e-depois, ou dois lados contrastantes. leftText/rightText + leftLabel/rightLabel. REGRA DE CONGRUÊNCIA (vale para QUALQUER estrutura de comparação, incl. StickFigures): o lado NEGATIVO/antes/errado vai à ESQUERDA (tom neutro) e o POSITIVO/depois/certo à DIREITA (é o lado que recebe a cor de destaque). Nunca inverta.
- FullScreen: uma frase de impacto, quote ou afirmação forte plotada direto no vídeo. text = a frase; highlight (opcional) = UMA palavra contida em text para destacar na cor de acento.
- Message: uma pergunta retórica ou mensagem estilo conversa (WhatsApp). sender + message.
- CTA: a chamada final para ação. text + highlight (highlight DEVE ser uma palavra contida em text). NO MÁXIMO 1 por vídeo, perto do fim.
- LowerThird: rótulo de contexto sobreposto quando um rosto está visível na fala (nome/cargo). title + subtitle.
- Split: painel de contexto acima + fala abaixo. topText + bottomText.
- StickFigures: situação social/humana simples ilustrada com figuras de palito. situation + caption.

REGRAS DE SELEÇÃO SEMÂNTICA:
- Escolha o tipo pelo CONTEÚDO da fala, não por decoração. número falado → Number; lista/passos → Flow ou Card; comparação/antes-depois → SplitVertical; frase de impacto/quote → FullScreen; pergunta retórica/mensagem → Message; chamada final → CTA; rótulo com rosto visível → LowerThird; objeto/lugar/situação física real → ImageInsert.
- MIX ALVO: 40-60% das cenas devem ser ImageInsert; o restante tipográfico. VARIE — nunca duas cenas do MESMO tipo em sequência (consecutivas).
- DENSIDADE: aproximadamente 1 cena a cada 8-15 segundos de fala. As cenas PONTUAM momentos-chave; não são papel de parede contínuo.
- Para vídeos de ~60-90s, gere 5-8 cenas. Para ~15-30s, gere 3-4 cenas. Nunca ultrapasse ~10 cenas a menos que existam muitos capítulos distintos.
- Sempre use startLeg como índice inteiro 0-based da timeline de legendas numeradas.
- durationInSubtitles entre 1 e 3.

ESTRUTURA EM 3 ATOS (use os ÍNDICES das legendas numeradas + timestamps para posicionar as cenas):
- HOOK (primeiros ~15s de fala): densidade ALTA de estímulo visual — algo NOVO na tela nos checkpoints ~2s, ~7s e ~15s (inserts curtos, trocas rápidas). Cenas do hook mais curtas (durationInSubtitles 1-2). A PRIMEIRA cena deve reforçar a promessa/tensão CENTRAL do vídeo, não um aquecimento genérico.
- CORPO (miolo): ritmo mais sereno, foco em retenção — inserts espaçados (aprox. 1 a cada ~10-15s), com ImageInsert (b-roll) predominante e pontuações tipográficas apenas nos momentos-chave.
- FINAL + CTA (últimos ~15-20s de fala): OBRIGATÓRIO terminar com uma cena CTA de texto grande, ALINHADA ao que o narrador realmente pede no áudio — extraia o pedido REAL da transcrição (seguir / comentar / clicar no link) e transforme nisso o CTA, com convite para seguir. NÃO invente handle/@; deixe o CTA genérico (ex.: "Segue pra parte 2"). Use os índices de legenda finais para posicionar essa cena.

REGRA DURA DE TEXTO SOBRE VÍDEO (teto de palavras — inviolável):
- Cenas cujo texto é plotado DIRETO sobre o vídeo (FullScreen, CTA, Split, e as captions de StickFigures) têm TETO no texto principal: NO MÁXIMO 6 palavras. Texto longo vira fonte minúscula ilegível — proibido.
- Texto secundário (subtitle / caption / topText de contexto): NO MÁXIMO 5 palavras E é OPCIONAL — prefira OMITIR. Só inclua se agregar de verdade.
- Se a ideia precisa de mais palavras que isso, NÃO despeje texto longo sobre o vídeo: escolha OUTRO formato — Card ou Flow (quebram em linhas curtas, poucas palavras por linha) ou ImageInsert (deixa a fala/legenda carregar o texto). Nunca force uma frase longa numa cena tipográfica de tela.
- Se o texto não couber no limite, REESCREVA mais curto e completo: texto acima do limite é DESCARTADO INTEIRO pelo código, nunca cortado. Frase interrompida no meio é o pior erro possível.

REGRAS DE COPY (pt-br, texto punchy — fragmentos, NUNCA frases longas):
- FullScreen: text com no máximo 6 palavras; sem subtítulo longo (se usar subtitle, no máximo 5 palavras, opcional).
- Card: title com no máximo 5 palavras; description com no máximo 12 palavras (Card comporta mais texto porque quebra em linhas curtas).
- Number: value curto (ex.: "3x", "R$15k", "80%"); label com no máximo 6 palavras.
- CTA: text com no máximo 6 palavras E highlight presente dentro de text (uma palavra do próprio text). OPCIONAL boxText (no máximo 5 palavras): rótulo curto de uma caixa amarela de ação que aparece no fim, ALINHADO à ação REAL pedida no áudio (ex.: "Toque em Saiba Mais", "Comenta EU QUERO"). Só inclua boxText quando o áudio pede uma ação concreta clicável/tocável.
- Flow: 3-5 passos, cada passo com no máximo 5 palavras.
- SplitVertical: leftLabel/rightLabel curtos (1-3 palavras); leftText/rightText no máximo 6 palavras cada.
- Message: sender curto; message curta.
- LowerThird: title = nome/rótulo; subtitle = contexto no máximo 5 palavras.
- Split: topText = contexto no máximo 5 palavras (opcional); bottomText = fala no máximo 6 palavras.
- StickFigures: situation no máximo 6 palavras; caption no máximo 5 palavras (opcional).
- SEM emoji em qualquer campo (exceção: Message pode usar emoji, opcional).

ImageInsert (quando usado):
- imagePrompt: descrição documental/editorial concreta e plausivelmente real (ambiente, sujeito, ação, distância de câmera, luz). SEM texto, SEM letras, SEM logos, SEM UI legível dentro da imagem.
- Prefira layout "split-bottom" para a maioria dos inserts (o apresentador continua presente). Use "top-image-compact" quando o vídeo original for um close-up selfie. Use "full" só para uma virada de capítulo com visual não-humano.
- narrativeRole: "hook", "context", "proof", "process", "objection", "decision" ou "cta" (metadado editorial). visualRole: "evidence", "contrast", "process", "context" ou "decision".
- Evite visuais genéricos de stock/IA (estradas vazias, barras de busca brilhando, nós de rede abstratos, mãos perfeitas digitando, interfaces falsas, diagramas isométricos, metáforas surreais, sorrisos plásticos).
- motion (opcional, boolean): marque motion:true APENAS nos 1-3 inserts de MAIOR impacto do vídeo (prioridade ao hook). Movimento é ÊNFASE, não padrão — a grande maioria dos inserts fica sem motion (still). Nunca marque mais que 3.
- source (opcional): "generate" (padrão) para visuais específicos/estilizados que você descreve no imagePrompt; "stock" para conceitos GENÉRICOS e concretos (dinheiro, cidade, escritório, pessoas caminhando, trânsito). Quando source:"stock", inclua stockQuery: termo curto de busca em INGLÊS (no máximo 6 palavras, ex: "person walking city street").

LAYOUTS DE SEGMENTO E EFEITOS (opcionais — você atribui por conta própria; são PONTUAÇÃO, não papel de parede):
Por padrão TODA cena é fullscreen (vídeo base cheio + a cena por cima). Um "layout de segmento" reposiciona o vídeo base durante a janela daquela cena; um "efeito" mexe no próprio vídeo base. São campos OPCIONAIS por cena — omita quando não agregam.
- segmentLayout (SÓ em cena ImageInsert, exceto tweet-card):
  - "split-50": trechos ILUSTRATIVOS mais longos em que a narração descreve algo visual — a imagem do insert vira a metade de cima e a legenda vira 2 palavras gigantes no meio. Preferido para b-roll mais longo. USE SÓ em ImageInsert.
  - "blur-bg": ênfase DRAMÁTICA sobre uma imagem (variação do split-50, imagem desfocada de fundo). USE SÓ em ImageInsert e COM MODERAÇÃO.
  - "tweet-card": momento de CITAÇÃO / afirmação punchy — aparece como um post com o perfil do criador. USE numa cena com campo "text" curto (≤ 20 palavras). NÃO precisa ser ImageInsert. NO MÁXIMO 1 por vídeo.
- segmentEffects (compõem com qualquer layout OU sozinhos numa cena só de efeito):
  - zoom "in": punch-in de ênfase num momento forte da fala. zoom "out": alívio/abertura. Uma cena pode ser SÓ efeito (sem layout e sem texto novo) — ex.: um FullScreen curto ou um punch-in pontual.
  - bw true: preto e branco, contraste dramático/negativo (problema, dor).
- DIREÇÃO POR ATO (movimento alto no topo, calmo no fim):
  - HOOK: 1 troca de layout OU 1-2 punch-ins (zoom in). Movimento alto.
  - CORPO: 1-2 segmentos de layout ESPAÇADOS (split-50 preferido para b-roll longo) + punch-ins pontuais.
  - FINAL: SEM layout novo — o CTA já domina a tela.
- VARIEDADE (regras duras): no MÁXIMO 3-4 segmentos de layout no vídeo inteiro; NUNCA o mesmo layout duas vezes seguidas; entre dois segmentos volte ao fullscreen (o padrão); tweet-card no máximo 1 por vídeo. Layout é PONTUAÇÃO — a maioria das cenas fica fullscreen.
- COMO RETORNAR: adicione "segmentLayout" e/ou "segmentEffects" na própria cena. Ex. de insert com layout: { ..., "type": "ImageInsert", "segmentLayout": "split-50" }. Ex. de cena só de efeito: { ..., "type": "FullScreen", "text": "Isso muda tudo", "highlight": "tudo", "segmentEffects": { "zoom": "in" } }. Ex. de citação: { ..., "type": "FullScreen", "text": "Ninguém te contou isso antes", "segmentLayout": "tweet-card" }. Valores fora dessas listas são ignorados.

TÁTICAS DE EDIÇÃO PONTUAIS (opcionais — ÊNFASE rara, nunca padrão; valores inválidos são ignorados):
- variant (SÓ em FullScreen, title-card de ABERTURA/hook): "variant": "torn-paper" (faixa vermelha rasgada, urgência/notícia) ou "variant": "crt-glitch" (glitch RGB + scanlines, tech/erro). Use no title-card de abertura quando o tom pedir impacto; sem variant = kinético padrão. NO MÁXIMO 1 por vídeo.

TÍTULO-HOOK PERSISTENTE (hookTitle — OPCIONAL, no nível raiz do JSON, não é uma cena):
- Uma manchete-promessa que fica FIXA no topo do vídeo, escrita com QUALIDADE DE COPYWRITER SÊNIOR: pensamento COMPLETO e fechado (sujeito + tensão/resultado), específica e numérica quando o áudio sustenta (ex.: "Como vendi 185 ingressos em 3h53min", "O erro que custou R$40 mil"). Alvo: 5-9 palavras; NUNCA uma frase interrompida no meio ("...o problema é como você" é INACEITÁVEL — parece rascunho). PROIBIDO terminar em palavra pendurada (como, você, que, de, para, com, sem, mais, é). Se não couber completa e forte em até 12 palavras, OMITA o campo.
- Extraia a promessa REAL da transcrição; NÃO invente números que o áudio não sustenta. Se o vídeo não tem uma promessa-manchete clara, OMITA o campo (não force).
- A manchete NÃO pode repetir nem parafrasear o texto de NENHUMA cena — em especial a cena de ABERTURA (title-card do hook). Ela é uma promessa COMPLEMENTAR, um ângulo diferente do que as cenas já dizem; nunca o mesmo enunciado. Se a única manchete que você consegue é ~igual ao texto de alguma cena, retorne hookTitle null (OMITA) — melhor sem manchete do que duplicada.

IDIOMA DE TODA COPY (manchete, cenas, CTA — regra do dono, inegociável): português BRASILEIRO FALADO, "tupiniquim", que uma criança de 10 anos entende de primeira. Teste: você leria isso em voz alta num anúncio sem soar estranho? PROIBIDO anglicismo e tradução literal do inglês — construções como "por como", "de como", "o quanto", "focado em performar" são INACEITÁVEIS. Também são proibidas expressões que ninguém fala no Brasil mesmo parecendo português (ex. reprovado real: "Falou fraco?") — se um brasileiro não diria isso numa mesa de bar, não escreva. Prefira frases curtas, verbos diretos, palavras do dia a dia ("pra" em vez de "para" quando soar mais natural). PROIBIDO travessão (—) em qualquer campo de copy (texto de cena, manchete, highlight etc.): travessão denuncia texto de IA. Use vírgula (preferência) ou dois-pontos quando precisar separar ideias.

Estilo visual selecionado: ${styleMeta.name}. Siga este tom: ${styleMeta.analysisTone}.${buildBrandColorPromptSection(brandColors)}${buildAssetCatalogSection(assetCatalog)}

REGRAS DE RITMO — OBRIGATÓRIAS, VERIFICADAS POR CÓDIGO (estas prevalecem sobre qualquer flexibilidade acima):
- B-ROLL É O ESQUELETO VISUAL: vídeos com mais de ~45s de fala DEVEM ter NO MÍNIMO 40% das cenas do tipo ImageInsert. Sem b-roll suficiente o vídeo vira uma parede de tipografia — reprovado.
- vídeos com mais de ~60s de fala DEVEM conter PELO MENOS 1 cena com segmentLayout (split-50 preferido para b-roll longo, ou blur-bg/tweet-card). Um vídeo longo sem nenhuma troca de layout é reprovado.
- "motion": true nos 2 inserts de MAIOR impacto do vídeo (sempre priorize o hook). Movimento é ênfase — exatamente nos 2 mais fortes, não em todos.
Estas três regras são conferidas por código após sua resposta; cumpra-as ao montar as cenas.

COTAS POR BLOCO (no pedido do usuário abaixo vêm os BLOCOS da passada de roteiro com COTAS OBRIGATÓRIAS): trate cada COTA como uma exigência dura — o gancho ganha title-card+flash+b-roll com motion; prova/história ganham split-50 com b-roll ESPECÍFICO; citação forte vira tweet-card; bloco de dor ganha preto e branco; bloco longo ganha ImageInsert concreto. O que faltar será consertado por código, então é melhor você já entregar. PROIBIDO b-roll genérico (escritório/pessoas caminhando/estrada vazia): todo imagePrompt deve citar o contexto CONCRETO da fala do bloco.`

    const numberedSubtitles = subtitles
      .map((subtitle, index) => `${index}: [${subtitle.startTime.toFixed(2)}s] ${subtitle.text}`)
      .join('\n')

    const userPrompt = `Analyze this video transcription and create a detailed scene breakdown:

FORMAT: ${format}
VISUAL STYLE: ${styleMeta.name}

Full transcription text:
${transcriptionText}

Numbered subtitle timeline:
${numberedSubtitles}
${blocksDirective}
Responda com um objeto JSON contendo narrativeFormat, palette e scenes${brandColors && brandColors.groups.length > 0 && !brandColors.forced ? ' (e chosenColorGroup — obrigatório neste caso, ver instruções de grupos de cores da marca acima)' : ''}.
Cada cena carrega SEMPRE: id, type, startLeg (índice inteiro 0-based da legenda), durationInSubtitles (1-3) e as props do seu tipo.

Formato:
{
  "narrativeFormat": "Descrição em 1-2 frases da abordagem narrativa geral",
  "hookTitle": "Manchete-promessa ≤10 palavras (OPCIONAL — omita se não houver)",
  "palette": {
    "primary": "#HEX cor principal da marca",
    "secondary": "#HEX cor secundária",
    "accent": "#HEX cor de destaques e CTA",
    "background": "#HEX cor de fundo",
    "text": "#HEX cor de texto"
  },
  "scenes": [
    { "id": "s1", "type": "FullScreen", "startLeg": 0, "durationInSubtitles": 2, "text": "Frase de impacto curta", "highlight": "impacto" },
    { "id": "s2", "type": "Number", "startLeg": 4, "durationInSubtitles": 2, "value": "3x", "label": "mais vendas" },
    { "id": "s3", "type": "ImageInsert", "startLeg": 8, "durationInSubtitles": 2, "layout": "split-bottom", "narrativeRole": "proof", "visualRole": "evidence", "imagePrompt": "Documentary B-roll still, no text, no letters, no logos", "imageAlt": "descrição interna curta", "sourceText": "trecho exato da fala que este insert apoia" },
    { "id": "s4", "type": "Flow", "startLeg": 12, "durationInSubtitles": 3, "steps": ["Passo um", "Passo dois", "Passo três"] },
    { "id": "s5", "type": "SplitVertical", "startLeg": 16, "durationInSubtitles": 2, "leftLabel": "Antes", "rightLabel": "Depois", "leftText": "situação ruim", "rightText": "situação boa" },
    { "id": "s6", "type": "Card", "startLeg": 20, "durationInSubtitles": 2, "number": 1, "title": "Título curto", "description": "Descrição breve do ponto" },
    { "id": "s7", "type": "Message", "startLeg": 24, "durationInSubtitles": 2, "sender": "Cliente", "message": "Pergunta ou fala curta" },
    { "id": "s8", "type": "CTA", "startLeg": 28, "durationInSubtitles": 2, "text": "Comece agora mesmo", "highlight": "agora", "boxText": "Toque em Saiba Mais" }
  ]
}

Props obrigatórias por tipo:
- ImageInsert: layout ("full" | "split-bottom" | "top-image-compact"), imagePrompt (SEM texto/letras/logos), narrativeRole, visualRole, imageAlt, sourceText.
- FullScreen: text (+ highlight opcional = palavra contida em text). LowerThird: title, subtitle. Split: topText, bottomText.
- SplitVertical: leftText, rightText, leftLabel, rightLabel. Card: number, title, description.
- Message: sender, message. Number: value, label. Flow: steps (array de strings).
- CTA: text, highlight (highlight = palavra contida em text). StickFigures: situation, caption.

Diretrizes de composição:
- Escolha o TIPO pelo significado da fala. Misture inserts de imagem com cenas tipográficas (mix alvo 40-60% ImageInsert). VARIE — nunca dois tipos iguais consecutivos.
- Pontue momentos-chave (~1 cena a cada 8-15s); as legendas seguem como camada de leitura contínua.
- Para ImageInsert, imagePrompt de 1-3 frases, concreto para geração de imagem, e deve dizer explicitamente "no text, no letters, no logos". Escreva stills de B-roll críveis, não pôsteres de metáfora.

Garanta que o JSON seja válido e completo.`

    // Call Claude API (PASSADA 2 — DIREÇÃO por bloco)
    const message = await createMessageWithModelFallback({
      max_tokens: 6000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt
        }
      ]
    })

    // Extract the text content from the response
    const content = message.content[0]
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude')
    }

    // Parse JSON from the response
    let analysisData: any
    try {
      // Extract JSON from the response (it might be wrapped in markdown code blocks)
      const jsonMatch = content.text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, content.text]
      const jsonString = jsonMatch[1] || content.text
      analysisData = JSON.parse(jsonString)
    } catch (parseError) {
      throw new Error(`Failed to parse Claude's JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
    }

    // Validate and sanitize the scenes
    if (!Array.isArray(analysisData.scenes)) {
      throw new Error('Invalid scenes array in response')
    }

    const validatedScenes: Scene[] = analysisData.scenes
      .map((sceneData: any): Scene | null =>
        validateSceneData(sceneData, subtitles, validAssetIds, transcriptionText)
      )
      .filter((scene: Scene | null): scene is Scene => scene !== null)

    // Fase 1b — layouts de segmento e efeitos atribuídos pela própria IA.
    // Normaliza (whitelist) os campos segmentLayout/segmentEffects de TODAS as
    // cenas e aplica as restrições de layout (split-50/blur-bg só em ImageInsert;
    // tweet-card só com text ≤ 20 palavras). Roda após sanitizeSceneCopy, com o
    // `text` já no formato final. Mutação in-place; os campos são opcionais e
    // sobrevivem a curateSceneDensity/resolveSceneTiming (spreads preservam).
    for (const scene of validatedScenes) {
      normalizeSceneSegments(scene)
    }

    // PISOS VERIFICADOS + REPARO + PROMOÇÃO. Usa o fim da última legenda como
    // proxy da duração falada. Mede déficits, tenta até 3 rodadas de reparo
    // cirúrgico (add/update) e, no que sobrar, aplica promoção determinística.
    const spokenDuration = subtitles.length > 0 ? subtitles[subtitles.length - 1].endTime : 0
    let workingScenes: Scene[] = validatedScenes
    let deficits = computeAnalysisDeficits(workingScenes, blocks, spokenDuration)
    console.log(
      `[analyze] cenas=${workingScenes.length} vídeo=${Math.round(spokenDuration)}s déficits iniciais: ${deficits.length ? deficits.join(', ') : 'nenhum'}`
    )
    for (let round = 0; round < 3 && deficits.length > 0; round++) {
      const ops = await runRepairPass(deficits, workingScenes, blocks, subtitles)
      if (ops.length === 0) break
      const result = applyRepairOperations(ops, workingScenes, subtitles, validAssetIds, transcriptionText)
      workingScenes = result.scenes
      const next = computeAnalysisDeficits(workingScenes, blocks, spokenDuration)
      console.log(
        `[analyze] reparo rodada ${round + 1}: ${result.applied} op(s) aplicada(s); déficits restantes: ${next.length ? next.join(', ') : 'nenhum'}`
      )
      if (result.applied === 0) break
      deficits = next
    }
    if (deficits.length > 0) {
      const promoted = applyDeterministicPromotions(workingScenes, blocks, spokenDuration)
      workingScenes = promoted.scenes
      if (promoted.promotions.length) {
        console.log(`[analyze] promoções determinísticas: ${promoted.promotions.join(', ')}`)
      }
      const finalDeficits = computeAnalysisDeficits(workingScenes, blocks, spokenDuration)
      if (finalDeficits.length) {
        console.warn(`[analyze] déficits que persistiram (sem fallback seguro): ${finalDeficits.join(', ')}`)
      }
    }

    // Cap de variedade: no máximo 1 tweet-card e 4 layouts no vídeo (anti-spam).
    const layoutCapNotes = capSegmentLayouts(workingScenes)
    if (layoutCapNotes.length) {
      console.log(`[analyze] cap de layouts: ${layoutCapNotes.join(', ')}`)
    }

    const { palette, colorGroup } = resolvePaletteWithBrandColors(analysisData, brandColors)

    // Optional persistent hook headline (≤10 words). Omitted when the model
    // returns nothing usable — old behavior (no headline) is preserved. A
    // headline that merely restates a scene (esp. the opening title-card) is
    // discarded: the manchete must be a COMPLEMENTARY promise, not a duplicate.
    // Manchete NUNCA é truncada mecanicamente (copy amputado parece rascunho):
    // ou vem completa dentro do limite, ou é descartada.
    let hookTitle =
      typeof analysisData.hookTitle === 'string' && analysisData.hookTitle.trim()
        ? cleanCopyText(analysisData.hookTitle)
        : undefined
    if (hookTitle && hookTitle.split(/\s+/).length > 12) {
      console.warn(`[analyze] hookTitle descartado por exceder 12 palavras: "${hookTitle}"`)
      hookTitle = undefined
    }
    const DANGLING_ENDINGS = new Set([
      'como', 'você', 'voce', 'que', 'de', 'para', 'pra', 'com', 'sem', 'por',
      'o', 'a', 'os', 'as', 'e', 'ou', 'mas', 'se', 'seu', 'sua', 'um', 'uma',
      'na', 'no', 'em', 'do', 'da', 'ao', 'à', 'é', 'mais', 'muito', 'quando'
    ])
    if (hookTitle) {
      const lastWord = hookTitle
        .split(/\s+/)
        .pop()!
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]/gu, '')
      if (DANGLING_ENDINGS.has(lastWord)) {
        console.warn(`[analyze] hookTitle descartado por terminar pendurado: "${hookTitle}"`)
        hookTitle = undefined
      }
    }
    if (hookTitle && hookTitleDuplicatesScene(hookTitle, workingScenes)) {
      console.warn(
        `[analyze] hookTitle descartado por duplicar o texto de uma cena: "${hookTitle}"`
      )
      hookTitle = undefined
    }

    return {
      narrativeFormat: analysisData.narrativeFormat || 'Professional video content',
      palette,
      scenes: workingScenes,
      ...(colorGroup ? { colorGroup } : {}),
      ...(hookTitle ? { hookTitle } : {})
    }
  } catch (error) {
    throw new Error(`Content analysis failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Refine a single scene based on user feedback
 * @param scene The scene to refine
 * @param instruction The user's instruction for how to modify the scene
 * @returns The modified scene
 */
export async function refineScene(
  scene: Scene,
  instruction: string
): Promise<Scene> {
  try {
    const systemPrompt = `You are an expert video editor refining individual scenes in a video.
You must return a valid JSON object representing the refined scene.
Keep durationInSubtitles between 2 and 4 for readability.
For ImageInsert scenes, preserve or improve narrativeRole, visualRole, imagePrompt, imageAlt, and sourceText.`

    const userPrompt = `Refine this scene based on the user's instruction:

CURRENT SCENE:
${JSON.stringify(scene, null, 2)}

USER INSTRUCTION:
${instruction}

Return the modified scene as a complete, valid JSON object with all required fields for its type.`

    const message = await createMessageWithModelFallback({
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: userPrompt
        }
      ]
    })

    const content = message.content[0]
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude')
    }

    // Parse the JSON response
    let refinedScene: any
    try {
      const jsonMatch = content.text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, content.text]
      const jsonString = jsonMatch[1] || content.text
      refinedScene = JSON.parse(jsonString)
    } catch (parseError) {
      throw new Error(`Failed to parse refined scene JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`)
    }

    // Validate startLeg (ensure it's a non-negative integer)
    if (
      typeof refinedScene.startLeg !== 'number' ||
      !Number.isFinite(refinedScene.startLeg) ||
      refinedScene.startLeg < 0
    ) {
      refinedScene.startLeg = scene.startLeg
    }
    refinedScene.startLeg = Math.max(0, Math.floor(refinedScene.startLeg))

    // Validate durationInSubtitles (1-3 per contract)
    if (typeof refinedScene.durationInSubtitles !== 'number' || refinedScene.durationInSubtitles < 1) {
      refinedScene.durationInSubtitles = 2
    }
    refinedScene.durationInSubtitles = Math.max(1, Math.min(Math.floor(refinedScene.durationInSubtitles), 3))

    // Validate scene type: keep any of the 11 supported types; fall back to the
    // original scene's type when the model returns an unknown one.
    if (!VALID_SCENE_TYPES.includes(refinedScene.type)) {
      refinedScene.type = scene.type
    }

    if (refinedScene.type === 'ImageInsert') {
      refinedScene.narrativeRole = VALID_NARRATIVE_ROLES.includes(refinedScene.narrativeRole)
        ? refinedScene.narrativeRole
        : (scene as any).narrativeRole || 'context'
      refinedScene.visualRole = VALID_VISUAL_ROLES.includes(refinedScene.visualRole)
        ? refinedScene.visualRole
        : (scene as any).visualRole || 'context'
      refinedScene.sourceText = refinedScene.sourceText || (scene as any).sourceText || ''
      return sanitizeSceneCopy(refinedScene) as Scene
    }

    // Typographic scene: validate/coerce required props. If the refined result is
    // unusable, fall back to the original scene rather than dropping it entirely.
    const normalized = normalizeTypographicScene(refinedScene)
    if (!normalized) {
      console.warn(`Refined ${refinedScene.type} scene missing required content; keeping original scene`)
      return scene
    }
    return sanitizeSceneCopy(normalized) as Scene
  } catch (error) {
    throw new Error(`Scene refinement failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------------------------------------------------------------------------
// PROMPT DIRETOR — interpreta uma instrução livre do usuário (que pode mirar o
// vídeo todo, uma cena, um trecho ou a paleta) e devolve OPERAÇÕES estruturadas.
// O código (project-director.ts) é quem VALIDA e APLICA. Aqui só interpretamos.
// ---------------------------------------------------------------------------

export type DirectorOperation =
  | { op: 'update_scene'; sceneId: string; changes: Record<string, unknown> }
  | { op: 'delete_scene'; sceneId: string }
  | { op: 'add_scene'; scene: Record<string, unknown> }
  | { op: 'update_palette'; changes: Record<string, string> }
  | { op: 'update_subtitle_style'; style: string }
  | { op: 'update_hook_title'; text: string | null }
  | { op: 'update_cold_open'; startLeg: number | null }

export interface DirectorResult {
  summary: string
  operations: DirectorOperation[]
}

function summarizeSceneForPrompt(scene: Scene): string {
  const data = scene as any
  const fields = [
    'text', 'highlight', 'title', 'subtitle', 'topText', 'bottomText',
    'leftLabel', 'rightLabel', 'leftText', 'rightText', 'number', 'description',
    'sender', 'message', 'value', 'label', 'steps', 'situation', 'caption',
    'layout', 'imagePrompt', 'imageAlt', 'sourceText', 'narrativeRole', 'visualRole',
    'motion', 'source', 'stockQuery', 'stutter',
    'assetId', 'style', 'name', 'caption',
    'segmentLayout', 'variant'
  ]
  const parts: string[] = []
  for (const field of fields) {
    const value = data[field]
    if (value === undefined || value === null || value === '') {
      continue
    }
    const text = Array.isArray(value) ? value.join(' | ') : String(value)
    parts.push(`${field}="${text.length > 64 ? `${text.slice(0, 64)}…` : text}"`)
  }
  return parts.join(', ')
}

/**
 * Interpreta a instrução do usuário como um DIRETOR de edição e devolve
 * operações estruturadas. Não persiste nem valida profundamente — o chamador
 * (project-director.ts) valida cada operação com os mesmos validadores do
 * pipeline (normalizeTypographicScene / sanitizeSceneCopy) e as aplica.
 */
export async function directProject(
  instruction: string,
  scenes: Scene[],
  subtitles: SubtitleEntry[],
  palette: ColorPalette | null,
  selectedSceneId?: string,
  assetCatalog?: AssetCatalogItem[]
): Promise<DirectorResult> {
  try {
    const numberedScenes = scenes
      .map(
        (scene, index) =>
          `#${index} id=${scene.id} type=${scene.type} startLeg=${scene.startLeg} :: ${summarizeSceneForPrompt(scene)}`
      )
      .join('\n')

    const numberedSubtitles = subtitles
      .map((subtitle, index) => `${index}: [${subtitle.startTime.toFixed(2)}s] ${subtitle.text}`)
      .join('\n')

    const paletteText = palette
      ? Object.entries(palette)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')
      : '(sem paleta definida)'

    const scopeHint = selectedSceneId
      ? `A cena atualmente selecionada é id=${selectedSceneId}. Trate isso APENAS como uma DICA de escopo — se a instrução claramente fala do vídeo todo, da paleta, ou de outro trecho, IGNORE a seleção.`
      : 'Nenhuma cena está selecionada; assuma escopo do vídeo todo salvo instrução em contrário.'

    const systemPrompt = `Você é o DIRETOR de edição de um editor de vídeo IA. Recebe UMA instrução em linguagem natural do usuário e o estado atual do projeto (cenas, legendas, paleta). Você NÃO edita diretamente: você devolve uma lista de OPERAÇÕES que o código vai validar e aplicar.

A instrução pode mirar: o VÍDEO TODO, UMA cena específica, UM trecho (referenciado pelas legendas), ou a PALETA de cores. Interprete o ESCOPO a partir do texto.

VOCABULÁRIO DE BATIDAS: o usuário trabalha num painel de "batidas" — batida N = legenda de índice N na timeline numerada abaixo (0-based). "põe um tweet-card nas batidas 12-14" = cena com startLeg:12 e durationInSubtitles:3; "remove a cena da batida 7" = delete_scene da cena cujo intervalo [startLeg, startLeg+durationInSubtitles-1] cobre o índice 7; "estende a cena da batida 4 até a 6" = update_scene ajustando durationInSubtitles. Sempre traduza batidas para startLeg/durationInSubtitles exatos.

TIPOS DE CENA VÁLIDOS: FullScreen, LowerThird, Split, SplitVertical, Card, Message, Number, Flow, CTA, StickFigures, ImageInsert${assetCatalog && assetCatalog.length > 0 ? ', AssetCard' : ''}.

OPERAÇÕES DISPONÍVEIS (retorne no máximo ~10 no total):
- {"op":"update_scene","sceneId":"<id existente>","changes":{<apenas props válidas do tipo da cena>}} — altera texto/props de uma cena existente. TAMBÉM aceita LAYOUT DE SEGMENTO: "segmentLayout" ("split-50" | "blur-bg" | "tweet-card" | null para voltar a tela cheia) reposiciona o vídeo base durante a janela da cena; "segmentEffects" ({"zoom":"in"|"out","bw":true}) aplica efeito no vídeo base (combinável com qualquer layout, ou sozinho para efeito em tela cheia). E TÁTICAS DE EDIÇÃO PONTUAIS (ênfase rara): "stutter":true (SÓ ImageInsert — 5 micro-saltos no 1º ~1,6s, máx 1/vídeo no hook), "variant":"torn-paper"|"crt-glitch" (SÓ FullScreen — title-card estilizado de abertura). Passe o valor null/ausente para remover uma tática.
- {"op":"delete_scene","sceneId":"<id existente>"} — remove uma cena.
- {"op":"add_scene","scene":{"type":"<tipo>","startLeg":<int>,"durationInSubtitles":<1-3>, <props do tipo>}} — cria cena nova. startLeg e durationInSubtitles são OBRIGATÓRIOS.
- {"op":"update_palette","changes":{"accent":"#RRGGBB", ...}} — muda cores GLOBAIS. Chaves válidas: primary, secondary, accent, background, text. Valores HEX (#RGB ou #RRGGBB).
- {"op":"update_subtitle_style","style":"<estilo>"} — muda o ESTILO GLOBAL das legendas (preferência salva para todos os vídeos). Valores válidos: "kinetic" (padrão, sem caixa), "karaoke-box" (caixa preta, destaque amarelo), "karaoke-pill" (pill escuro, progressão), "caps-stroke" (maiúsculas com contorno), "clean-color" (minúsculas, destaque na cor de acento). Use quando o usuário pedir para mudar o visual/formato das legendas.
- {"op":"update_hook_title","text":"<manchete>"|null} — define ou remove o TÍTULO-HOOK persistente no topo do vídeo (manchete-promessa ≤10 palavras). text:null remove o título. Use quando o usuário pedir uma manchete/chamada fixa no topo, ou pedir para removê-la.
- {"op":"update_cold_open","startLeg":<int>|null} — define ou remove a ABERTURA (cold open): replica um trecho de fala impactante do MEIO do vídeo NO INÍCIO, como gancho. startLeg = índice da batida/legenda cuja fala vira a abertura (a janela = span da cena que cobre a batida, senão a própria batida, sempre clampada para 3-8s). startLeg:null REMOVE a abertura. Use quando o usuário pedir para "usar a fala X como gancho/abertura no começo", "colocar um cold open", ou "tirar a abertura".

REGRAS DE INTERPRETAÇÃO:
- ESCOPO GLOBAL: quando o usuário disser "vídeo todo", "em todo lugar", "sempre", ou não especificar uma cena, aplique globalmente.
- COR: mudanças de COR (ex.: "trocar laranja por dourado", "deixar o destaque azul") são QUASE SEMPRE update_palette — NÃO tente mudar cor cena a cena. A cor de acento/destaque dos inserts e textos vem da paleta (campo accent). Se o usuário fala em "laranja"/"dourado" nos inserts e no vídeo todo, isso é update_palette em accent (e talvez primary/secondary conforme o tom pedido).
- Só use update_scene/add_scene/delete_scene quando a instrução for realmente sobre conteúdo/estrutura de cena(s).
- Respeite os TETOS de copy: textos plotados sobre o vídeo (FullScreen, CTA, Split, StickFigures) no máximo 6 palavras; textos secundários no máximo 5. Prefira fragmentos curtos. Se o texto não couber, REESCREVA mais curto e completo: texto acima do limite é DESCARTADO INTEIRO pelo código (a operação inteira é rejeitada), nunca cortado. Frase interrompida no meio é o pior erro possível.
- PROIBIDO travessão (—) em qualquer campo de copy (texto de cena, manchete/hookTitle, highlight etc.): travessão denuncia texto de IA. Use vírgula (preferência) ou dois-pontos.
- Em ImageInsert, imagePrompt não pode conter texto/letras/logos. Para regenerar a imagem de um insert, mude imagePrompt no update_scene.
- LAYOUT DE SEGMENTO: "coloca a cena 3 em split-50" → update_scene com segmentLayout:"split-50" na cena. "deixa o trecho 0:30-0:45 preto e branco com zoom in" → mapeie o trecho para a(s) cena(s) por tempo (via legendas) e aplique segmentEffects:{"bw":true,"zoom":"in"} em cada uma. "volta a cena X pra tela cheia" → segmentLayout:null. split-50/blur-bg funcionam melhor em cenas ImageInsert (usam a imagem); tweet-card usa o texto da cena.
- NUNCA invente ids de cena — use apenas os ids listados. Para add_scene, NÃO forneça id (o código gera).
- Se a instrução for impossível ou não fizer sentido, devolva operations vazio e explique no summary.

FORMATO DE SAÍDA — responda SOMENTE com JSON válido, sem markdown:
{
  "summary": "resumo em pt-BR do que você fez (1-2 frases)",
  "operations": [ ... ]
}${buildAssetCatalogSection(assetCatalog)}`

    const userPrompt = `INSTRUÇÃO DO USUÁRIO:
${instruction}

${scopeHint}

PALETA ATUAL: ${paletteText}

CENAS ATUAIS (numeradas):
${numberedScenes || '(nenhuma cena)'}

LEGENDAS (índice: [tempo] texto) — para referência de trecho:
${numberedSubtitles || '(sem legendas)'}

Devolva o JSON com summary e operations.`

    const message = await createMessageWithModelFallback({
      max_tokens: 3072,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })

    const content = message.content[0]
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude')
    }

    let parsed: any
    try {
      const jsonMatch = content.text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, content.text]
      const jsonString = jsonMatch[1] || content.text
      parsed = JSON.parse(jsonString)
    } catch (parseError) {
      throw new Error(
        `Failed to parse director JSON response: ${parseError instanceof Error ? parseError.message : String(parseError)}`
      )
    }

    const operations: DirectorOperation[] = Array.isArray(parsed?.operations)
      ? parsed.operations.slice(0, 10)
      : []

    return {
      summary: typeof parsed?.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : 'Instrução interpretada.',
      operations
    }
  } catch (error) {
    throw new Error(`Project direction failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
