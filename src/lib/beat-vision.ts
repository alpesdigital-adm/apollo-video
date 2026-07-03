/**
 * CAMADA 2 da coordenação de legenda — âncora POR BATIDA calculada a partir do
 * CONTEÚDO REAL do frame (onde está o rosto/ação), via Claude vision sobre os
 * thumbnails que o pipeline já extrai (public/thumbs/<projectId>/beat_<i>.jpg).
 *
 * Fluxo: garante thumbs -> manda os thumbnails em LOTES ao Claude (modelo de
 * visão barato: haiku, com fallback ao sonnet) -> para cada frame o modelo diz
 * em que terço vertical está o rosto/elemento dominante -> derivamos a âncora
 * ('top' quando o rosto está no terço de BAIXO, então a legenda desvia pro topo;
 * 'bottom' no resto) -> regravamos as legendas com o campo `anchor`.
 *
 * Nunca lança: qualquer falha (sem API key, lote ilegível, JSON quebrado) cai
 * para 'bottom' na batida afetada. Server-only (usa fs + prisma + ffmpeg).
 */

import Anthropic from '@anthropic-ai/sdk'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { prisma } from './db'
import { acquireStepLock, releaseStepLock } from './pipeline-lock'
import { beatThumbFileName, beatThumbsDir, generateBeatThumbs } from './beat-thumbs'
import type { SubtitleEntry } from './types/project'

export type BeatAnchor = 'top' | 'bottom'
export type FaceZone = 'top' | 'middle' | 'bottom' | 'none'

// Modelo de visão barato primeiro; fallback determinístico ao sonnet quando o id
// do haiku não estiver disponível na conta. (Mesmo padrão do claude.ts, local.)
const VISION_MODEL_CANDIDATES = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-3-5-sonnet-20241022'
]

// ~16 imagens de 180px por chamada: 42 thumbs ≈ 3 chamadas haiku ≈ centavos.
const BATCH_SIZE = 16

function readEnvFileValue(filePath: string, key: string): string | null {
  if (!existsSync(filePath)) return null
  const content = readFileSync(filePath, 'utf8')
  const line = content.split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}=`))
  if (!line) return null
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

  // maxRetries 1: custo/robustez — não insistir num lote caro que já falhou.
  return new Anthropic({ apiKey, maxRetries: 1 })
}

/** Local model fallback (haiku -> sonnet) for a single vision call. */
async function createVisionMessage(client: Anthropic, params: any) {
  let lastError: unknown
  for (const model of VISION_MODEL_CANDIDATES) {
    try {
      return await client.messages.create({ ...params, model })
    } catch (error) {
      lastError = error
      const status = (error as any)?.status
      const message = error instanceof Error ? error.message : String(error)
      const canTryNext =
        status === 404 ||
        message.includes('not_found_error') ||
        message.toLowerCase().includes('model')
      if (!canTryNext) throw error
    }
  }
  throw lastError
}

/** Strip a ```json fence if present, then parse. */
function parseJsonFromClaude(text: string): any {
  const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, text]
  const jsonString = jsonMatch[1] || text
  return JSON.parse(jsonString)
}

function normalizeFaceZone(value: unknown): FaceZone {
  return value === 'top' || value === 'middle' || value === 'bottom' || value === 'none'
    ? value
    : 'none'
}

/**
 * Regra de derivação (exatamente a do briefing):
 *  - rosto/elemento no terço de BAIXO  -> 'top'  (legenda sobe pra não cobrir)
 *  - rosto no meio/topo (selfie normal) -> 'bottom'
 *  - none / ilegível / desconhecido     -> 'bottom'
 */
function deriveAnchor(zone: FaceZone): BeatAnchor {
  return zone === 'bottom' ? 'top' : 'bottom'
}

const SYSTEM_PROMPT = `Você recebe uma sequência de FRAMES (quadros) de um vídeo vertical de pessoa falando (talking head / selfie). Para CADA frame, identifique em qual TERÇO VERTICAL está o ROSTO ou o elemento dominante da cena:
- "top" = rosto/elemento no terço SUPERIOR
- "middle" = rosto/elemento no terço do MEIO
- "bottom" = rosto/elemento no terço INFERIOR
- "none" = nenhum rosto ou elemento claro / frame vazio ou ilegível
Também diga se a metade de BAIXO do frame está "crowded" (muita informação visual embaixo: texto, mãos, várias pessoas, objetos).
Responda SOMENTE com JSON válido, sem markdown, no formato:
{"results":[{"beat":<int>,"faceZone":"top|middle|bottom|none","crowded":<bool>}]}
Inclua um objeto para CADA frame, usando o índice "beat" informado no rótulo de cada imagem.`

/**
 * Envia os thumbnails por batida ao Claude em lotes e devolve a âncora por
 * legenda. Sempre retorna um array do tamanho de `subtitles` (default 'bottom').
 * `zonesOut`, se passado, é preenchido com o faceZone bruto por batida (diagnóstico).
 */
export async function computeSubtitleAnchors(
  projectId: string,
  subtitles: SubtitleEntry[],
  thumbsDir: string,
  zonesOut?: (FaceZone | null)[]
): Promise<BeatAnchor[]> {
  const n = subtitles.length
  const anchors: BeatAnchor[] = new Array(n).fill('bottom')
  if (zonesOut) {
    zonesOut.length = n
    zonesOut.fill(null)
  }
  if (n === 0) return anchors

  // Quais batidas têm thumbnail em disco.
  const items: Array<{ index: number; file: string }> = []
  for (let i = 0; i < n; i += 1) {
    const file = path.join(thumbsDir, beatThumbFileName(i))
    if (existsSync(file)) items.push({ index: i, file })
  }
  if (items.length === 0) {
    console.warn(`[beat-vision] project ${projectId}: no thumbnails found in ${thumbsDir}`)
    return anchors
  }

  let client: Anthropic
  try {
    client = createAnthropicClient()
  } catch (error) {
    console.warn(`[beat-vision] project ${projectId}: ${error instanceof Error ? error.message : String(error)} — all beats default to 'bottom'`)
    return anchors
  }

  for (let b = 0; b < items.length; b += BATCH_SIZE) {
    const batch = items.slice(b, b + BATCH_SIZE)
    try {
      const content: any[] = []
      for (const item of batch) {
        const base64 = readFileSync(item.file).toString('base64')
        content.push({ type: 'text', text: `beat=${item.index}:` })
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: base64 }
        })
      }
      content.push({
        type: 'text',
        text: `Analise os ${batch.length} frames acima (índices beat=${batch.map((x) => x.index).join(', ')}). Devolva só o JSON com "results".`
      })

      const message = await createVisionMessage(client, {
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }]
      })

      const textPart = (message.content as any[]).find((c) => c.type === 'text')
      if (!textPart) continue
      const parsed = parseJsonFromClaude(textPart.text)
      const rows: any[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.results)
        ? parsed.results
        : []

      for (const row of rows) {
        const idx = Number(row?.beat)
        if (!Number.isInteger(idx) || idx < 0 || idx >= n) continue
        const zone = normalizeFaceZone(row?.faceZone)
        anchors[idx] = deriveAnchor(zone)
        if (zonesOut) zonesOut[idx] = zone
      }
    } catch (error) {
      // Lote ilegível / rede / JSON quebrado: mantém 'bottom' nessas batidas.
      console.warn(`[beat-vision] project ${projectId}: batch ${b}-${b + batch.length - 1} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const topCount = anchors.filter((a) => a === 'top').length
  console.log(`[beat-vision] project ${projectId}: ${topCount} top / ${n - topCount} bottom (${n} beats, ${items.length} thumbs analyzed)`)
  return anchors
}

export interface AnchorRunResult {
  ran: boolean
  reason?: string
  total?: number
  distribution?: { top: number; bottom: number }
  examples?: Array<{ beat: number; faceZone: FaceZone | null; anchor: BeatAnchor }>
}

/**
 * Orquestra a Camada 2 para um projeto: garante thumbs, roda a visão, RELÊ o
 * projeto (para não clobber alterações concorrentes) e regrava subtitlesJson com
 * o campo `anchor` por legenda. Serializa via lock 'anchors'. Nunca lança —
 * devolve um resultado com a distribuição para o chamador logar/responder.
 */
export async function runSubtitleAnchors(projectId: string): Promise<AnchorRunResult> {
  if (!acquireStepLock('anchors', projectId)) {
    return { ran: false, reason: 'Anchor computation already running for this project' }
  }

  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) return { ran: false, reason: 'Project not found' }
    if (!project.subtitlesJson) return { ran: false, reason: 'Project has no subtitles yet' }

    const subtitles: SubtitleEntry[] = JSON.parse(project.subtitlesJson)
    if (subtitles.length === 0) return { ran: false, reason: 'Project has no subtitles' }

    // Mesma resolução de vídeo do route de beats: proxy leve se existir.
    const uploadDir = path.join(process.cwd(), 'public', 'uploads')
    const proxyPath = path.join(uploadDir, `${projectId}-proxy.mp4`)
    const videoPath = existsSync(proxyPath) ? proxyPath : project.normalizedPath

    if (videoPath) {
      await generateBeatThumbs(projectId, videoPath, subtitles, project.updatedAt.getTime())
    }

    const zones: (FaceZone | null)[] = []
    const anchors = await computeSubtitleAnchors(
      projectId,
      subtitles,
      beatThumbsDir(projectId),
      zones
    )

    // RELÊ antes de regravar: se as legendas mudaram (retranscrição concorrente),
    // aborta em vez de sobrescrever uma timeline diferente.
    const fresh = await prisma.project.findUnique({ where: { id: projectId } })
    if (!fresh?.subtitlesJson) return { ran: false, reason: 'Project subtitles disappeared' }
    const freshSubs: SubtitleEntry[] = JSON.parse(fresh.subtitlesJson)
    if (freshSubs.length !== anchors.length) {
      return { ran: false, reason: 'Subtitles changed during analysis; anchors discarded' }
    }

    const merged = freshSubs.map((sub, i) => ({ ...sub, anchor: anchors[i] }))
    await prisma.project.update({
      where: { id: projectId },
      data: { subtitlesJson: JSON.stringify(merged) }
    })

    const top = anchors.filter((a) => a === 'top').length
    const examples: AnchorRunResult['examples'] = []
    for (let i = 0; i < anchors.length && examples.length < 3; i += 1) {
      if (anchors[i] === 'top') examples.push({ beat: i, faceZone: zones[i], anchor: 'top' })
    }
    if (examples.length === 0) {
      for (let i = 0; i < anchors.length && examples.length < 3; i += 1) {
        examples.push({ beat: i, faceZone: zones[i], anchor: anchors[i] })
      }
    }

    return {
      ran: true,
      total: anchors.length,
      distribution: { top, bottom: anchors.length - top },
      examples
    }
  } catch (error) {
    console.warn(`[beat-vision] runSubtitleAnchors failed for ${projectId}: ${error instanceof Error ? error.message : String(error)}`)
    return { ran: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    releaseStepLock('anchors', projectId)
  }
}
