/**
 * Claude analysis service for video content structure and design
 */

import Anthropic from '@anthropic-ai/sdk'
import fs from 'fs'
import path from 'path'
import { getInsertStylePresetMeta } from '../style-presets'
import type { Transcription, SubtitleEntry, VideoFormat } from '../types/project'
import type { Scene, AnalysisResult, NarrativeRole, SceneType } from '../types/scene'

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
const VALID_SCENE_TYPES: SceneType[] = [
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

const VALID_VISUAL_ROLES = ['evidence', 'contrast', 'process', 'context', 'decision']
const VALID_NARRATIVE_ROLES: NarrativeRole[] = [
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

function normalizeNarrativeRole(value: unknown, startLeg: number, subtitleCount: number): NarrativeRole {
  return VALID_NARRATIVE_ROLES.includes(value as NarrativeRole)
    ? (value as NarrativeRole)
    : inferNarrativeRole(startLeg, subtitleCount)
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

function sanitizeSceneCopy(sceneData: any): any {
  switch (sceneData.type) {
    case 'FullScreen':
      sceneData.text = limitCopy(sceneData.text || sceneData.title, 70)
      sceneData.subtitle = sceneData.subtitle ? limitCopy(sceneData.subtitle, 70) : undefined
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
function normalizeTypographicScene(sceneData: any): any | null {
  switch (sceneData.type) {
    case 'FullScreen': {
      const text = coerceString(sceneData.text, sceneData.title, sceneData.subtitle)
      if (!text) {
        return null
      }
      sceneData.text = text
      return sceneData
    }
    case 'LowerThird': {
      const title = coerceString(sceneData.title, sceneData.text)
      const subtitle = coerceString(sceneData.subtitle, sceneData.description, sceneData.label)
      if (!title && !subtitle) {
        return null
      }
      sceneData.title = title || subtitle
      sceneData.subtitle = subtitle
      return sceneData
    }
    case 'Split': {
      const topText = coerceString(sceneData.topText, sceneData.title)
      const bottomText = coerceString(sceneData.bottomText, sceneData.content, sceneData.description)
      if (!topText && !bottomText) {
        return null
      }
      sceneData.topText = topText
      sceneData.bottomText = bottomText
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
      sceneData.text = text
      // highlight must be a substring of text; fall back to the last word.
      const highlight = coerceString(sceneData.highlight, sceneData.highlightWord)
      sceneData.highlight =
        highlight && text.toLowerCase().includes(highlight.toLowerCase())
          ? highlight
          : text.trim().split(/\s+/).slice(-1)[0] || text
      return sceneData
    }
    case 'StickFigures': {
      const situation = coerceString(sceneData.situation, sceneData.leftCaption, sceneData.text)
      const caption = coerceString(sceneData.caption, sceneData.rightCaption, sceneData.description)
      if (!situation && !caption) {
        return null
      }
      sceneData.situation = situation || caption
      sceneData.caption = caption || situation
      return sceneData
    }
    default:
      return null
  }
}

/**
 * Analyze transcription to generate video scene structure
 * Uses Claude to determine narrative format, color palette, and scene breakdown
 * @param transcriptionText The transcribed text content
 * @param format Video format ('9:16' for vertical, '16:9' for horizontal)
 * @returns AnalysisResult with narrative format, palette, and scenes
 */
export async function analyzeContent(
  transcriptionText: string,
  format: VideoFormat,
  subtitles: SubtitleEntry[],
  stylePreset: string = 'creator-clean'
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
- FullScreen: uma frase de impacto, quote ou afirmação forte em tela cheia. text = a frase.
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

REGRAS DE COPY (pt-br, texto punchy — fragmentos, NUNCA frases longas):
- FullScreen: text com no máximo 7 palavras.
- Card: title com no máximo 5 palavras; description com no máximo 12 palavras.
- Number: value curto (ex.: "3x", "R$15k", "80%"); label com no máximo 6 palavras.
- CTA: text com no máximo 6 palavras E highlight presente dentro de text (uma palavra do próprio text).
- Flow: 3-5 passos, cada passo com no máximo 5 palavras.
- SplitVertical: leftLabel/rightLabel curtos (1-3 palavras); leftText/rightText curtos.
- Message: sender curto; message curta.
- LowerThird: title = nome/rótulo; subtitle = contexto curto.
- Split: topText = contexto curto; bottomText = fala curta.
- StickFigures: situation + caption curtos.
- SEM emoji em qualquer campo (exceção: Message pode usar emoji, opcional).

ImageInsert (quando usado):
- imagePrompt: descrição documental/editorial concreta e plausivelmente real (ambiente, sujeito, ação, distância de câmera, luz). SEM texto, SEM letras, SEM logos, SEM UI legível dentro da imagem.
- Prefira layout "split-bottom" para a maioria dos inserts (o apresentador continua presente). Use "top-image-compact" quando o vídeo original for um close-up selfie. Use "full" só para uma virada de capítulo com visual não-humano.
- narrativeRole: "hook", "context", "proof", "process", "objection", "decision" ou "cta" (metadado editorial). visualRole: "evidence", "contrast", "process", "context" ou "decision".
- Evite visuais genéricos de stock/IA (estradas vazias, barras de busca brilhando, nós de rede abstratos, mãos perfeitas digitando, interfaces falsas, diagramas isométricos, metáforas surreais, sorrisos plásticos).

Estilo visual selecionado: ${styleMeta.name}. Siga este tom: ${styleMeta.analysisTone}.`

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

Responda com um objeto JSON contendo narrativeFormat, palette e scenes.
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
    { "id": "s1", "type": "FullScreen", "startLeg": 0, "durationInSubtitles": 2, "text": "Frase de impacto curta" },
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
- FullScreen: text. LowerThird: title, subtitle. Split: topText, bottomText.
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

    return {
      narrativeFormat: analysisData.narrativeFormat || 'Professional video content',
      palette: analysisData.palette || {
        primary: '#0066FF',
        secondary: '#0052CC',
        accent: '#FF6B35',
        background: '#FFFFFF',
        text: '#000000'
      },
      scenes: validatedScenes
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
