/**
 * Project Director — validação e aplicação (CÓDIGO, não IA) das operações que o
 * prompt diretor (directProject em services/claude.ts) devolve.
 *
 * Reusa os mesmos validadores do pipeline de análise:
 *  - normalizeTypographicScene / sanitizeSceneCopy / normalizeNarrativeRole
 *  - VALID_SCENE_TYPES
 * Assim uma cena criada/alterada pelo diretor passa exatamente pelas mesmas
 * regras (tetos de copy, props obrigatórias por tipo) que uma cena do analyze.
 *
 * Também cuida do snapshot/undo (nível único) em data/snapshots/<projectId>.json.
 */

import fs from 'fs'
import { mkdir, readFile, writeFile, unlink } from 'fs/promises'
import path from 'path'
import {
  VALID_SCENE_TYPES,
  normalizeNarrativeRole,
  normalizeSegmentFields,
  normalizeTypographicScene,
  sanitizeAssetCardScene,
  sanitizeSceneCopy
} from './services/claude'
import type { DirectorOperation } from './services/claude'
import type { Scene, ColorPalette } from './types/scene'
import type { SubtitleEntry } from './types/project'
import { isValidSubtitleStyle, readStylePrefs, writeStylePrefs } from './style-prefs'

const PALETTE_KEYS: (keyof ColorPalette)[] = ['primary', 'secondary', 'accent', 'background', 'text']
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

const DEFAULT_PALETTE: ColorPalette = {
  primary: '#FFB800',
  secondary: '#20202A',
  accent: '#FF6B35',
  background: '#050508',
  text: '#FFFFFF'
}

function isValidHex(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value.trim())
}

/**
 * Valida e normaliza os dados de UMA cena (nova ou atualizada) exatamente como
 * o fluxo de analyze faz. Retorna null quando a cena é inviável (deve ser
 * ignorada e reportada pelo chamador).
 */
function validateSceneData(
  sceneData: any,
  subtitles: SubtitleEntry[],
  validAssetIds?: Set<string>
): Scene | null {
  if (!sceneData || typeof sceneData !== 'object') {
    return null
  }

  if (!VALID_SCENE_TYPES.includes(sceneData.type)) {
    return null
  }

  // startLeg: inteiro no range válido de legendas.
  sceneData.startLeg = Math.max(
    0,
    Math.min(Math.floor(Number(sceneData.startLeg) || 0), Math.max(0, subtitles.length - 1))
  )

  // durationInSubtitles: 1-3 (mesmo contrato do analyze).
  if (typeof sceneData.durationInSubtitles !== 'number' || sceneData.durationInSubtitles < 1) {
    sceneData.durationInSubtitles = 2
  }
  sceneData.durationInSubtitles = Math.max(1, Math.min(Math.floor(sceneData.durationInSubtitles), 3))

  // Frames são recomputados por resolveSceneTiming.
  delete sceneData.startFrame
  delete sceneData.endFrame

  // Layout de segmento (opcional): whitelist + valores válidos. null/'' remove.
  normalizeSegmentFields(sceneData)

  if (sceneData.type === 'AssetCard') {
    // Requires a real asset id; sem catálogo válido a cena é inviável.
    return sanitizeAssetCardScene(sceneData, validAssetIds) as Scene | null
  }

  if (sceneData.type === 'ImageInsert') {
    // Optional library asset reference: keep only when it is a real id.
    if (sceneData.assetId !== undefined) {
      const id = typeof sceneData.assetId === 'string' ? sceneData.assetId.trim() : ''
      if (id && (!validAssetIds || validAssetIds.has(id))) {
        sceneData.assetId = id
      } else {
        delete sceneData.assetId
      }
    }
    sceneData.narrativeRole = normalizeNarrativeRole(
      sceneData.narrativeRole,
      sceneData.startLeg,
      subtitles.length
    )
    if (!sceneData.imagePrompt) {
      const subtitle = subtitles[sceneData.startLeg]
      sceneData.imagePrompt = `Premium contextual visual inspired by this spoken moment: "${
        subtitle?.text || ''
      }". No text, no letters, no logos.`
    }
    if (!sceneData.sourceText) {
      sceneData.sourceText = subtitles[sceneData.startLeg]?.text || ''
    }
    return sanitizeSceneCopy(sceneData) as Scene
  }

  const normalized = normalizeTypographicScene(sceneData)
  if (!normalized) {
    return null
  }
  return sanitizeSceneCopy(normalized) as Scene
}

function generateSceneId(existing: Set<string>): string {
  let n = existing.size + 1
  let base = `s${n}`
  while (existing.has(base)) {
    n += 1
    base = `s${n}`
  }
  return `${base}-${Date.now().toString(36)}`
}

export interface ApplyOperationsResult {
  scenes: Scene[]
  palette: ColorPalette
  applied: string[]
  skipped: string[]
  // Present only when an update_hook_title op ran. A string sets the headline;
  // null explicitly removes it. Undefined = no change (caller keeps existing).
  hookTitle?: string | null
}

/**
 * Aplica a lista de operações do diretor sobre as cenas + paleta atuais.
 * Cada operação é validada individualmente; operações inválidas são IGNORADAS
 * e reportadas em `skipped` (nunca derrubam o lote).
 */
export function applyDirectorOperations(
  operations: DirectorOperation[],
  scenes: Scene[],
  palette: ColorPalette | null,
  subtitles: SubtitleEntry[],
  validAssetIds?: Set<string>
): ApplyOperationsResult {
  const workingScenes: Scene[] = scenes.map((scene) => ({ ...scene }))
  const workingPalette: ColorPalette = { ...(palette || DEFAULT_PALETTE) }
  const applied: string[] = []
  const skipped: string[] = []
  let hookTitleChange: { value: string | null } | undefined

  const ops = Array.isArray(operations) ? operations.slice(0, 10) : []

  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof (op as any).op !== 'string') {
      skipped.push('Operação inválida ignorada')
      continue
    }

    switch (op.op) {
      case 'update_scene': {
        const { sceneId, changes } = op
        const idx = workingScenes.findIndex((scene) => scene.id === sceneId)
        if (idx === -1) {
          skipped.push(`Cena não encontrada: ${sceneId}`)
          break
        }
        const original = workingScenes[idx] as any
        const merged: any = { ...original, ...(changes || {}) }
        merged.id = original.id
        // Se o prompt de imagem mudou num ImageInsert, força regeneração.
        if (
          merged.type === 'ImageInsert' &&
          changes &&
          Object.prototype.hasOwnProperty.call(changes, 'imagePrompt') &&
          changes.imagePrompt !== original.imagePrompt
        ) {
          delete merged.imagePath
          delete merged.reusedImagePath
          delete merged.imageGenerationError
        }
        const validated = validateSceneData(merged, subtitles, validAssetIds)
        if (!validated) {
          skipped.push(`Alteração inválida para a cena ${sceneId}`)
          break
        }
        validated.id = original.id
        workingScenes[idx] = validated
        applied.push(`Cena ${sceneId} (${validated.type}) atualizada`)
        break
      }

      case 'delete_scene': {
        const idx = workingScenes.findIndex((scene) => scene.id === op.sceneId)
        if (idx === -1) {
          skipped.push(`Cena não encontrada: ${op.sceneId}`)
          break
        }
        workingScenes.splice(idx, 1)
        applied.push(`Cena ${op.sceneId} removida`)
        break
      }

      case 'add_scene': {
        const raw: any = { ...(op.scene || {}) }
        if (
          typeof raw.startLeg !== 'number' ||
          typeof raw.durationInSubtitles !== 'number'
        ) {
          skipped.push('Nova cena sem startLeg/durationInSubtitles — ignorada')
          break
        }
        const existingIds = new Set(workingScenes.map((scene) => scene.id))
        raw.id = typeof raw.id === 'string' && raw.id && !existingIds.has(raw.id)
          ? raw.id
          : generateSceneId(existingIds)
        const validated = validateSceneData(raw, subtitles, validAssetIds)
        if (!validated) {
          skipped.push(`Nova cena inválida (${raw.type || 'tipo desconhecido'}) — ignorada`)
          break
        }
        workingScenes.push(validated)
        applied.push(`Cena ${validated.type} adicionada`)
        break
      }

      case 'update_palette': {
        const changes = op.changes || {}
        const changedKeys: string[] = []
        for (const key of Object.keys(changes)) {
          if (!PALETTE_KEYS.includes(key as keyof ColorPalette)) {
            skipped.push(`Paleta: chave desconhecida "${key}"`)
            continue
          }
          const value = (changes as any)[key]
          if (!isValidHex(value)) {
            skipped.push(`Paleta: valor inválido para "${key}"`)
            continue
          }
          workingPalette[key as keyof ColorPalette] = value.trim()
          changedKeys.push(key)
        }
        if (changedKeys.length > 0) {
          applied.push(`Paleta atualizada: ${changedKeys.join(', ')}`)
        }
        break
      }

      case 'update_subtitle_style': {
        const style = (op as any).style
        if (!isValidSubtitleStyle(style)) {
          skipped.push(`Estilo de legenda inválido: ${String(style)}`)
          break
        }
        // Global preference (data/style-prefs.json), same file-backed pattern as
        // brand colors. Applies to every video's render and the live player.
        const current = readStylePrefs()
        if (current.subtitleStyle !== style) {
          writeStylePrefs({ ...current, subtitleStyle: style })
        }
        applied.push(`Estilo de legenda alterado para "${style}"`)
        break
      }

      case 'update_hook_title': {
        const raw = (op as any).text
        if (raw === null) {
          hookTitleChange = { value: null }
          applied.push('Título-hook removido')
          break
        }
        if (typeof raw !== 'string' || !raw.trim()) {
          skipped.push('Título-hook inválido — ignorado')
          break
        }
        // Cap at 10 words to match the analyze contract.
        const capped = raw.replace(/\s+/g, ' ').trim().split(' ').slice(0, 10).join(' ')
        hookTitleChange = { value: capped }
        applied.push('Título-hook atualizado')
        break
      }

      default:
        skipped.push(`Operação desconhecida: ${(op as any).op}`)
    }
  }

  return {
    scenes: workingScenes,
    palette: workingPalette,
    applied,
    skipped,
    ...(hookTitleChange ? { hookTitle: hookTitleChange.value } : {})
  }
}

// ---------------------------------------------------------------------------
// Snapshot / Undo (nível único, sem mudar schema) — data/snapshots/<id>.json
// ---------------------------------------------------------------------------

export interface ProjectSnapshot {
  scenesJson: string | null
  paletteJson: string | null
  editPlanJson: string | null
  savedAt: string
}

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'snapshots')

function snapshotPath(projectId: string): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9._-]/g, '-')
  return path.join(SNAPSHOT_DIR, `${safeId}.json`)
}

export async function saveSnapshot(
  projectId: string,
  data: { scenesJson: string | null; paletteJson: string | null; editPlanJson: string | null }
): Promise<void> {
  await mkdir(SNAPSHOT_DIR, { recursive: true })
  const snapshot: ProjectSnapshot = {
    scenesJson: data.scenesJson,
    paletteJson: data.paletteJson,
    editPlanJson: data.editPlanJson,
    savedAt: new Date().toISOString()
  }
  await writeFile(snapshotPath(projectId), JSON.stringify(snapshot), 'utf8')
}

export function hasSnapshot(projectId: string): boolean {
  return fs.existsSync(snapshotPath(projectId))
}

/** Lê e CONSOME (apaga) o snapshot. Retorna null se não houver. */
export async function consumeSnapshot(projectId: string): Promise<ProjectSnapshot | null> {
  const filePath = snapshotPath(projectId)
  if (!fs.existsSync(filePath)) {
    return null
  }
  try {
    const raw = await readFile(filePath, 'utf8')
    const snapshot = JSON.parse(raw) as ProjectSnapshot
    await unlink(filePath).catch(() => {})
    return snapshot
  } catch {
    await unlink(filePath).catch(() => {})
    return null
  }
}
