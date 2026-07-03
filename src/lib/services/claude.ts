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
  'ImageInsert'
]

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

function limitCopy(value: unknown, maxChars: number): string {
  const text = String(value || '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?/gu, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (text.length <= maxChars) {
    return text
  }

  const slice = text.slice(0, maxChars - 1)
  const lastSpace = slice.lastIndexOf(' ')
  return `${slice.slice(0, lastSpace > 20 ? lastSpace : maxChars - 1).trim()}...`
}

/**
 * Hard word cap for text plotted directly over the video (FullScreen, CTA,
 * Split, StickFigures captions). Truncates at a word boundary so a headline can
 * never become an illegible wall of text — this GUARANTEES the 6/5-word ceiling
 * even if the model ignores the prompt. Never lets a main field exceed its cap.
 */
function limitWords(value: unknown, maxWords: number): string {
  const words = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  return words.slice(0, Math.max(1, maxWords)).join(' ')
}

export function sanitizeSceneCopy(sceneData: any): any {
  switch (sceneData.type) {
    case 'FullScreen':
      sceneData.text = limitWords(limitCopy(sceneData.text || sceneData.title, 70), 6)
      sceneData.subtitle = sceneData.subtitle ? limitCopy(limitWords(sceneData.subtitle, 5), 70) : undefined
      sceneData.highlight = sceneData.highlight ? limitCopy(sceneData.highlight, 40) : undefined
      delete sceneData.fontSize
      delete sceneData.color
      delete sceneData.bgColor
      break
    case 'LowerThird':
      sceneData.title = limitCopy(sceneData.title, 42)
      sceneData.subtitle = limitCopy(sceneData.subtitle, 70)
      break
    case 'Split':
      sceneData.topText = limitCopy(sceneData.topText || sceneData.title, 54)
      sceneData.bottomText = limitCopy(sceneData.bottomText || sceneData.content, 54)
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
      sceneData.text = limitCopy(sceneData.text, 72)
      sceneData.highlight = limitCopy(sceneData.highlight, 54)
      break
    case 'StickFigures':
      sceneData.situation = limitCopy(sceneData.situation, 64)
      sceneData.caption = limitCopy(sceneData.caption, 84)
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
      // Hard 6-word ceiling for text plotted over the video.
      const capped = limitWords(text, 6)
      sceneData.text = capped
      // Optional highlight: keep only when it is a word contained in the capped text.
      sceneData.highlight =
        highlight && capped.toLowerCase().includes(highlight.toLowerCase())
          ? highlight
          : undefined
      return sceneData
    }
    case 'LowerThird': {
      const title = coerceString(sceneData.title, sceneData.text)
      const subtitle = coerceString(sceneData.subtitle, sceneData.description, sceneData.label)
      if (!title && !subtitle) {
        return null
      }
      sceneData.title = title || subtitle
      // Secondary caption over video: max 5 words, optional.
      sceneData.subtitle = limitWords(subtitle, 5)
      return sceneData
    }
    case 'Split': {
      const topText = coerceString(sceneData.topText, sceneData.title)
      const bottomText = coerceString(sceneData.bottomText, sceneData.content, sceneData.description)
      if (!topText && !bottomText) {
        return null
      }
      // topText = secondary context (max 5); bottomText = main line (max 6).
      sceneData.topText = limitWords(topText, 5)
      sceneData.bottomText = limitWords(bottomText, 6)
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
      // Hard 6-word ceiling for the CTA line plotted over the video.
      const capped = limitWords(text, 6)
      sceneData.text = capped
      // highlight must be a substring of the capped text; fall back to the last word.
      const highlight = coerceString(sceneData.highlight, sceneData.highlightWord)
      sceneData.highlight =
        highlight && capped.toLowerCase().includes(highlight.toLowerCase())
          ? highlight
          : capped.trim().split(/\s+/).slice(-1)[0] || capped
      return sceneData
    }
    case 'StickFigures': {
      const situation = coerceString(sceneData.situation, sceneData.leftCaption, sceneData.text)
      const caption = coerceString(sceneData.caption, sceneData.rightCaption, sceneData.description)
      if (!situation && !caption) {
        return null
      }
      // Captions plotted over video: situation main (max 6), caption secondary (max 5).
      sceneData.situation = limitWords(situation || caption, 6)
      sceneData.caption = limitWords(caption || situation, 5)
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

/**
 * Analyze transcription to generate video scene structure
 * Uses Claude to determine narrative format, color palette, and scene breakdown
 * @param transcriptionText The transcribed text content
 * @param format Video format ('9:16' for vertical, '16:9' for horizontal)
 * @param brandColors Optional brand color groups from /settings. When provided
 *   with `forced`, that group's colors are used as-is (round-robin mode). When
 *   provided with only `groups`, Claude picks one (ai-pick mode). When omitted,
 *   the palette is fully AI-invented (previous behavior).
 * @returns AnalysisResult with narrative format, palette, and scenes
 */
export async function analyzeContent(
  transcriptionText: string,
  format: VideoFormat,
  subtitles: SubtitleEntry[],
  stylePreset: string = 'creator-clean',
  brandColors?: AnalyzeContentBrandColors
): Promise<AnalysisResult> {
  try {
    // For simplicity in the initial analysis, we'll work with the text
    // and generate a basic scene structure
    // In a full implementation, this would parse segments more carefully

    const styleMeta = getInsertStylePresetMeta(stylePreset)

    const systemPrompt = `Você é um editor de vídeo sênior especializado em vídeos narrados premium para redes sociais (Reels/Shorts/TikTok/YouTube).
Seu trabalho é montar uma sequência de cenas visuais que pontuam os momentos-chave da narração. Você combina inserts de imagem (B-roll) com cenas tipográficas animadas para tornar a fala mais concreta, crível e fácil de entender.

TIPOS DE CENA DISPONÍVEIS (11 tipos — use o mais adequado ao SIGNIFICADO da fala):
- ImageInsert: ilustração documental de objeto, lugar, situação ou pessoa em contexto real (B-roll). Use quando a fala descreve uma cena física concreta.
- Number: um número, métrica ou percentual FALADO (ex.: "3x", "R$15k", "80%"). value = o número curto; label = o que ele significa.
- Flow: uma lista de passos ou etapas sequenciais (3 a 5 passos). steps = array de strings curtas.
- Card: um item de lista / conceito com título + descrição curta.
- SplitVertical: comparação, antes-e-depois, ou dois lados contrastantes. leftText/rightText + leftLabel/rightLabel.
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

REGRAS DE COPY (pt-br, texto punchy — fragmentos, NUNCA frases longas):
- FullScreen: text com no máximo 6 palavras; sem subtítulo longo (se usar subtitle, no máximo 5 palavras, opcional).
- Card: title com no máximo 5 palavras; description com no máximo 12 palavras (Card comporta mais texto porque quebra em linhas curtas).
- Number: value curto (ex.: "3x", "R$15k", "80%"); label com no máximo 6 palavras.
- CTA: text com no máximo 6 palavras E highlight presente dentro de text (uma palavra do próprio text).
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

Estilo visual selecionado: ${styleMeta.name}. Siga este tom: ${styleMeta.analysisTone}.${buildBrandColorPromptSection(brandColors)}`

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

Responda com um objeto JSON contendo narrativeFormat, palette e scenes${brandColors && brandColors.groups.length > 0 && !brandColors.forced ? ' (e chosenColorGroup — obrigatório neste caso, ver instruções de grupos de cores da marca acima)' : ''}.
Cada cena carrega SEMPRE: id, type, startLeg (índice inteiro 0-based da legenda), durationInSubtitles (1-3) e as props do seu tipo.

Formato:
{
  "narrativeFormat": "Descrição em 1-2 frases da abordagem narrativa geral",
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
    { "id": "s8", "type": "CTA", "startLeg": 28, "durationInSubtitles": 2, "text": "Comece agora mesmo", "highlight": "agora" }
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

    // Call Claude API
    const message = await createMessageWithModelFallback({
      max_tokens: 4096,
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
      .map((sceneData: any): Scene | null => {
        // Validate scene type: keep any of the 11 supported types. Unknown types
        // are discarded rather than force-converted to ImageInsert.
        if (!VALID_SCENE_TYPES.includes(sceneData.type)) {
          console.warn(`Discarding scene with unsupported type: ${sceneData.type}`)
          return null
        }

        // Validate and clamp startLeg (shared across all types)
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

        // Ensure durationInSubtitles is valid (1-3 per contract)
        if (typeof sceneData.durationInSubtitles !== 'number' || sceneData.durationInSubtitles < 1) {
          sceneData.durationInSubtitles = 2
        }
        sceneData.durationInSubtitles = Math.max(1, Math.min(Math.floor(sceneData.durationInSubtitles), 3))

        // Ensure startFrame and endFrame are not set (will be computed later)
        delete sceneData.startFrame
        delete sceneData.endFrame

        if (sceneData.type === 'ImageInsert') {
          sceneData.narrativeRole = normalizeNarrativeRole(
            sceneData.narrativeRole,
            sceneData.startLeg,
            subtitles.length
          )
          if (!sceneData.imagePrompt) {
            const subtitle = subtitles[sceneData.startLeg]
            sceneData.imagePrompt = `Premium contextual visual inspired by this spoken moment: "${subtitle?.text || transcriptionText.slice(0, 160)}". No text, no letters, no logos.`
          }
          if (!sceneData.sourceText) {
            sceneData.sourceText = subtitles[sceneData.startLeg]?.text || ''
          }
          return sanitizeSceneCopy(sceneData) as Scene
        }

        // Typographic scene: validate/coerce required props, discard if impossible.
        const normalized = normalizeTypographicScene(sceneData)
        if (!normalized) {
          console.warn(`Discarding ${sceneData.type} scene missing required content`)
          return null
        }
        return sanitizeSceneCopy(normalized) as Scene
      })
      .filter((scene: Scene | null): scene is Scene => scene !== null)

    // Fase 1b — layouts de segmento e efeitos atribuídos pela própria IA.
    // Normaliza (whitelist) os campos segmentLayout/segmentEffects de TODAS as
    // cenas e aplica as restrições de layout (split-50/blur-bg só em ImageInsert;
    // tweet-card só com text ≤ 20 palavras). Roda após sanitizeSceneCopy, com o
    // `text` já no formato final. Mutação in-place; os campos são opcionais e
    // sobrevivem a curateSceneDensity/resolveSceneTiming (spreads preservam).
    for (const scene of validatedScenes) {
      normalizeSegmentFields(scene)
      enforceAnalyzeSegmentConstraints(scene)
    }

    const { palette, colorGroup } = resolvePaletteWithBrandColors(analysisData, brandColors)

    return {
      narrativeFormat: analysisData.narrativeFormat || 'Professional video content',
      palette,
      scenes: validatedScenes,
      ...(colorGroup ? { colorGroup } : {})
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
    'segmentLayout'
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
  selectedSceneId?: string
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

TIPOS DE CENA VÁLIDOS: FullScreen, LowerThird, Split, SplitVertical, Card, Message, Number, Flow, CTA, StickFigures, ImageInsert.

OPERAÇÕES DISPONÍVEIS (retorne no máximo ~10 no total):
- {"op":"update_scene","sceneId":"<id existente>","changes":{<apenas props válidas do tipo da cena>}} — altera texto/props de uma cena existente. TAMBÉM aceita LAYOUT DE SEGMENTO: "segmentLayout" ("split-50" | "blur-bg" | "tweet-card" | null para voltar a tela cheia) reposiciona o vídeo base durante a janela da cena; "segmentEffects" ({"zoom":"in"|"out","bw":true}) aplica efeito no vídeo base (combinável com qualquer layout, ou sozinho para efeito em tela cheia).
- {"op":"delete_scene","sceneId":"<id existente>"} — remove uma cena.
- {"op":"add_scene","scene":{"type":"<tipo>","startLeg":<int>,"durationInSubtitles":<1-3>, <props do tipo>}} — cria cena nova. startLeg e durationInSubtitles são OBRIGATÓRIOS.
- {"op":"update_palette","changes":{"accent":"#RRGGBB", ...}} — muda cores GLOBAIS. Chaves válidas: primary, secondary, accent, background, text. Valores HEX (#RGB ou #RRGGBB).

REGRAS DE INTERPRETAÇÃO:
- ESCOPO GLOBAL: quando o usuário disser "vídeo todo", "em todo lugar", "sempre", ou não especificar uma cena, aplique globalmente.
- COR: mudanças de COR (ex.: "trocar laranja por dourado", "deixar o destaque azul") são QUASE SEMPRE update_palette — NÃO tente mudar cor cena a cena. A cor de acento/destaque dos inserts e textos vem da paleta (campo accent). Se o usuário fala em "laranja"/"dourado" nos inserts e no vídeo todo, isso é update_palette em accent (e talvez primary/secondary conforme o tom pedido).
- Só use update_scene/add_scene/delete_scene quando a instrução for realmente sobre conteúdo/estrutura de cena(s).
- Respeite os TETOS de copy: textos plotados sobre o vídeo (FullScreen, CTA, Split, StickFigures) no máximo 6 palavras; textos secundários no máximo 5. Prefira fragmentos curtos.
- Em ImageInsert, imagePrompt não pode conter texto/letras/logos. Para regenerar a imagem de um insert, mude imagePrompt no update_scene.
- LAYOUT DE SEGMENTO: "coloca a cena 3 em split-50" → update_scene com segmentLayout:"split-50" na cena. "deixa o trecho 0:30-0:45 preto e branco com zoom in" → mapeie o trecho para a(s) cena(s) por tempo (via legendas) e aplique segmentEffects:{"bw":true,"zoom":"in"} em cada uma. "volta a cena X pra tela cheia" → segmentLayout:null. split-50/blur-bg funcionam melhor em cenas ImageInsert (usam a imagem); tweet-card usa o texto da cena.
- NUNCA invente ids de cena — use apenas os ids listados. Para add_scene, NÃO forneça id (o código gera).
- Se a instrução for impossível ou não fizer sentido, devolva operations vazio e explique no summary.

FORMATO DE SAÍDA — responda SOMENTE com JSON válido, sem markdown:
{
  "summary": "resumo em pt-BR do que você fez (1-2 frases)",
  "operations": [ ... ]
}`

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
