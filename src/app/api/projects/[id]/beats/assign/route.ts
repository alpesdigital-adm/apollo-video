import { NextRequest, NextResponse } from 'next/server'
import { existsSync } from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { applyDirectorOperations, saveSnapshot } from '@/lib/project-director'
import type { DirectorOperation } from '@/lib/services/claude'
import { generateImageInsertAssets } from '@/lib/services/image-generation'
import { getAssetCatalog, resolveAssetsInScenes } from '@/lib/asset-library'
import { narrativeEngine } from '@/lib/engines/narrative-engine'
import { acquireStepLock, releaseStepLock } from '@/lib/pipeline-lock'
import { resolveSceneTiming } from '@/lib/utils/timing'
import { buildBeats } from '@/lib/beats'
import { beatThumbFileName, beatThumbsDir } from '@/lib/beat-thumbs'
import type { Silence, SubtitleEntry, Transcription } from '@/lib/types/project'
import type { Scene, ColorPalette } from '@/lib/types/scene'

type BeatAction = 'set' | 'remove' | 'extend' | 'shrink'

const DURATION_MIN = 1
const DURATION_MAX = 8

// Types the beat panel can assign (dropdown). AssetCard requires a library asset.
const ASSIGNABLE_TYPES = new Set([
  'FullScreen',
  'Card',
  'Number',
  'Message',
  'Flow',
  'CTA',
  'SplitVertical',
  'StickFigures',
  'ImageInsert',
  'AssetCard'
])

function words(text: string): string[] {
  return (text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

function truncWords(text: string, n: number): string {
  return words(text).slice(0, n).join(' ')
}

/**
 * Sensible per-type prop defaults derived mechanically from the beat's phrase.
 * These only need to satisfy normalizeTypographicScene / validateSceneData so
 * the scene survives the shared apply path — the user refines copy afterwards.
 */
function buildSceneDraft(type: string, text: string, firstAssetId?: string): Record<string, unknown> | null {
  const w = words(text)
  switch (type) {
    case 'FullScreen':
      return { text: truncWords(text, 6) || 'Título' }
    case 'CTA':
      return { text: truncWords(text, 6) || 'Comece agora' }
    case 'Card':
      return { title: truncWords(text, 5) || 'Ponto', number: 1, description: truncWords(text, 12) }
    case 'Number': {
      const match = text.match(/\d[\d.,]*/)
      return { value: match ? match[0] : '1', label: truncWords(text, 4) || 'Dado' }
    }
    case 'Message':
      return { sender: 'Mensagem', message: truncWords(text, 8) || 'Mensagem' }
    case 'SplitVertical': {
      const mid = Math.ceil(w.length / 2)
      return {
        leftText: truncWords(w.slice(0, mid).join(' '), 4) || 'Antes',
        rightText: truncWords(w.slice(mid).join(' '), 4) || 'Depois',
        leftLabel: 'Antes',
        rightLabel: 'Depois'
      }
    }
    case 'Flow': {
      const mid = Math.ceil(w.length / 2)
      const a = truncWords(w.slice(0, mid).join(' '), 4) || 'Passo 1'
      const b = truncWords(w.slice(mid).join(' '), 4) || 'Passo 2'
      return { steps: [a, b] }
    }
    case 'StickFigures':
      return { situation: truncWords(text, 6) || 'Situação', caption: truncWords(text, 5) || 'Legenda' }
    case 'ImageInsert':
      return {
        layout: 'full',
        imagePrompt: `Documentary b-roll: ${text}`.trim(),
        sourceText: text
      }
    case 'AssetCard':
      if (!firstAssetId) return null
      return { assetId: firstAssetId, style: 'credibility', caption: truncWords(text, 8) }
    default:
      return null
  }
}

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const projectId = params.id
  let lockAcquired = false

  try {
    const body = await request.json().catch(() => null)
    const action: BeatAction = body?.action
    const beatIndex: number = body?.beatIndex
    const sceneType: string | undefined = body?.sceneType

    if (!action || !['set', 'remove', 'extend', 'shrink'].includes(action)) {
      return NextResponse.json({ error: 'action inválida' }, { status: 400 })
    }
    if (typeof beatIndex !== 'number' || beatIndex < 0) {
      return NextResponse.json({ error: 'beatIndex inválido' }, { status: 400 })
    }

    // Acquire the lock BEFORE reading project state (shared 'refine' lock key
    // with /api/projects/refine — see the comment there). Fetching the row
    // first and locking after leaves a window where this request's snapshot
    // (incl. editPlanJson/hookTitle) can predate a concurrent refine/beats-
    // assign call that already committed, so this request would later persist
    // a regenerated editPlan built from stale data and clobber that update.
    if (!acquireStepLock('refine', projectId)) {
      return NextResponse.json(
        { error: 'Já existe uma edição em curso para este projeto' },
        { status: 409 }
      )
    }
    lockAcquired = true

    const project = await prisma.project.findUnique({ where: { id: projectId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    if (!project.subtitlesJson) {
      return NextResponse.json({ error: 'Projeto sem legendas' }, { status: 400 })
    }
    if (!project.normalizedPath) {
      return NextResponse.json({ error: 'Vídeo processado não encontrado' }, { status: 400 })
    }

    const subtitles: SubtitleEntry[] = JSON.parse(project.subtitlesJson)
    const scenes: Scene[] = project.scenesJson ? JSON.parse(project.scenesJson) : []
    const silences: Silence[] = project.silencesJson ? JSON.parse(project.silencesJson) : []
    const palette: ColorPalette | null = project.paletteJson ? JSON.parse(project.paletteJson) : null
    const transcription: Transcription | null = project.transcriptionJson
      ? JSON.parse(project.transcriptionJson)
      : null

    if (beatIndex > subtitles.length - 1) {
      return NextResponse.json({ error: 'beatIndex fora do intervalo' }, { status: 400 })
    }

    const format = (project.format || '16:9') as '9:16' | '16:9'
    const fps = project.videoFps || 30
    const stylePreset = project.stylePreset || 'creator-clean'

    const assetCatalog = getAssetCatalog()
    const validAssetIds = new Set(assetCatalog.map((a) => a.id))
    const firstAssetId = assetCatalog[0]?.id

    // Resolve the covering scene for this beat (span-start wins), same rule as GET.
    const beats = buildBeats(subtitles, scenes)
    const beat = beats[beatIndex]
    const coveringScene = beat.sceneId ? scenes.find((s) => s.id === beat.sceneId) || null : null

    // --- Translate the beat action into DirectorOperations --------------------
    const operations: DirectorOperation[] = []

    if (action === 'set') {
      if (!sceneType || !ASSIGNABLE_TYPES.has(sceneType)) {
        return NextResponse.json({ error: 'sceneType inválido para set' }, { status: 400 })
      }
      if (sceneType === 'AssetCard' && !firstAssetId) {
        return NextResponse.json(
          { error: 'Nenhum asset na biblioteca. Adicione uma mídia antes de usar AssetCard.' },
          { status: 400 }
        )
      }
      const draft = buildSceneDraft(sceneType, beat.text, firstAssetId)
      if (!draft) {
        return NextResponse.json({ error: `Não foi possível montar a cena ${sceneType}` }, { status: 400 })
      }

      if (coveringScene && beat.isSpanStart) {
        // Scene starts on this beat → swap its type in place.
        operations.push({
          op: 'update_scene',
          sceneId: coveringScene.id,
          changes: { type: sceneType, ...draft }
        })
      } else {
        // No scene starts here → create a new 1-beat scene at this beat.
        operations.push({
          op: 'add_scene',
          scene: { type: sceneType, startLeg: beatIndex, durationInSubtitles: 1, ...draft }
        })
      }
    } else if (action === 'remove') {
      if (!coveringScene) {
        return NextResponse.json({ error: 'Nenhuma cena cobre esta batida' }, { status: 400 })
      }
      operations.push({ op: 'delete_scene', sceneId: coveringScene.id })
    } else {
      // extend / shrink → adjust the covering scene's duration by ±1.
      if (!coveringScene) {
        return NextResponse.json({ error: 'Nenhuma cena cobre esta batida' }, { status: 400 })
      }
      const current = Math.max(1, coveringScene.durationInSubtitles || 1)
      const next = action === 'extend' ? current + 1 : current - 1
      if (next < DURATION_MIN) {
        return NextResponse.json({ error: 'A cena já tem a duração mínima (1 batida)' }, { status: 400 })
      }
      if (next > DURATION_MAX) {
        return NextResponse.json({ error: `A cena já tem a duração máxima (${DURATION_MAX} batidas)` }, { status: 400 })
      }
      operations.push({
        op: 'update_scene',
        sceneId: coveringScene.id,
        changes: { durationInSubtitles: next }
      })
    }

    // --- Apply through the SAME path as refine (lock already held above) ------
    const applyResult = applyDirectorOperations(operations, scenes, palette, subtitles, validAssetIds)
    const { scenes: updatedScenes, palette: updatedPalette, applied, skipped } = applyResult

    if (applied.length === 0) {
      return NextResponse.json(
        { error: skipped[0] || 'Não foi possível aplicar a alteração', skipped },
        { status: 400 }
      )
    }

    // Preserve the existing hook title (editPlan).
    const existingPlan = project.editPlanJson ? JSON.parse(project.editPlanJson) : null
    const hookTitle: string | undefined =
      existingPlan && typeof existingPlan.hookTitle === 'string' && existingPlan.hookTitle.trim()
        ? existingPlan.hookTitle
        : undefined
    // Cold open (Fase 3): preserva a janela através da regeneração do plano.
    const coldOpen =
      existingPlan && existingPlan.coldOpen && typeof existingPlan.coldOpen === 'object'
        ? existingPlan.coldOpen
        : undefined

    // Snapshot BEFORE persisting (single-level undo, shared with refine).
    await saveSnapshot(projectId, {
      scenesJson: project.scenesJson,
      paletteJson: project.paletteJson,
      editPlanJson: project.editPlanJson
    })

    const resolvedAssetScenes = resolveAssetsInScenes(updatedScenes)
    const scenesWithTiming = resolveSceneTiming(resolvedAssetScenes, subtitles, fps)

    const scenesWithAssets = await generateImageInsertAssets({
      projectId,
      scenes: scenesWithTiming,
      format,
      stylePreset,
      transcriptionText: transcription?.text || '',
      existingScenes: scenes
    })

    const editPlan = narrativeEngine.createPlan({
      projectId,
      format,
      stylePreset,
      fps,
      source: {
        rawPath: project.rawVideoPath,
        renderPath: project.normalizedPath,
        duration: project.videoDuration || 0,
        width: project.videoWidth,
        height: project.videoHeight
      },
      transcription: transcription || ({ text: '', words: [], segments: [] } as unknown as Transcription),
      subtitles,
      silences,
      scenes: scenesWithAssets,
      hookTitle,
      ...(coldOpen ? { coldOpen } : {})
    })

    await prisma.project.update({
      where: { id: projectId },
      data: {
        scenesJson: JSON.stringify(scenesWithAssets),
        paletteJson: JSON.stringify(updatedPalette),
        engineKind: narrativeEngine.kind,
        editPlanJson: JSON.stringify(editPlan),
        renderedVideoPath: null,
        status: 'ready',
        error: null
      }
    })

    // Rebuild beats (subtitles unchanged) with thumbUrls, same as GET.
    const dir = beatThumbsDir(projectId)
    const rebuiltBeats = buildBeats(subtitles, scenesWithAssets).map((b) => {
      const thumbFile = beatThumbFileName(b.index)
      const thumbUrl = existsSync(path.join(dir, thumbFile))
        ? `/thumbs/${projectId}/${thumbFile}`
        : null
      return { ...b, thumbUrl }
    })

    return NextResponse.json({
      success: true,
      summary: applied.join('; '),
      applied,
      skipped,
      beats: rebuiltBeats,
      scenes: scenesWithAssets,
      palette: updatedPalette
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao ajustar a batida'
    console.error('Beat assign error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    if (lockAcquired) {
      releaseStepLock('refine', projectId)
    }
  }
}
