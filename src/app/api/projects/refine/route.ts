import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { directProject } from '@/lib/services/claude'
import { applyDirectorOperations, saveSnapshot } from '@/lib/project-director'
import { generateImageInsertAssets } from '@/lib/services/image-generation'
import { getAssetCatalog, resolveAssetsInScenes } from '@/lib/asset-library'
import { narrativeEngine } from '@/lib/engines/narrative-engine'
import { acquireStepLock, releaseStepLock } from '@/lib/pipeline-lock'
import { resolveSceneTiming } from '@/lib/utils/timing'
import { computeColdOpenWindow, type ColdOpenWindow } from '@/lib/cold-open'
import type { Silence, SubtitleEntry, Transcription } from '@/lib/types/project'
import type { Scene, ColorPalette } from '@/lib/types/scene'

export async function POST(request: NextRequest) {
  let projectId: string | null = null
  let lockAcquired = false

  try {
    const body = await request.json()
    projectId = body.projectId
    const instruction: string = body.instruction
    const sceneId: string | undefined = body.sceneId || undefined

    if (!projectId || !instruction || !instruction.trim()) {
      return NextResponse.json(
        { error: 'projectId e instruction são obrigatórios' },
        { status: 400 }
      )
    }

    // Acquire the lock BEFORE reading project state. Fetching the row first and
    // acquiring the lock after means a request that starts while another
    // refine/beats-assign call is still in flight (both share the 'refine' lock
    // key) captures a stale snapshot — and since acquiring the lock does NOT
    // re-fetch, this request later persists its regenerated editPlan built from
    // that stale snapshot, clobbering whatever the concurrent call just saved
    // (e.g. reverting a hookTitle the user had just set to an older value).
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
    if (!project.scenesJson) {
      return NextResponse.json({ error: 'Nenhuma cena para editar' }, { status: 400 })
    }
    if (!project.normalizedPath) {
      return NextResponse.json({ error: 'Vídeo processado não encontrado' }, { status: 400 })
    }

    const scenes: Scene[] = JSON.parse(project.scenesJson)
    const subtitles: SubtitleEntry[] = project.subtitlesJson ? JSON.parse(project.subtitlesJson) : []
    const silences: Silence[] = project.silencesJson ? JSON.parse(project.silencesJson) : []
    const palette: ColorPalette | null = project.paletteJson ? JSON.parse(project.paletteJson) : null
    const transcription: Transcription | null = project.transcriptionJson
      ? JSON.parse(project.transcriptionJson)
      : null

    const format = (project.format || '16:9') as '9:16' | '16:9'
    const fps = project.videoFps || 30
    const stylePreset = project.stylePreset || 'creator-clean'

    // Asset library (Pacote 4): catálogo compacto p/ o prompt + set de ids p/ validar.
    const assetCatalog = getAssetCatalog()
    const validAssetIds = new Set(assetCatalog.map((a) => a.id))

    // 1. Interpretar a instrução como operações (IA).
    const direction = await directProject(
      instruction,
      scenes,
      subtitles,
      palette,
      sceneId,
      assetCatalog.length > 0 ? assetCatalog : undefined
    )

    // 2. Validar e aplicar as operações (código).
    const applyResult = applyDirectorOperations(
      direction.operations,
      scenes,
      palette,
      subtitles,
      validAssetIds
    )
    const { scenes: updatedScenes, palette: updatedPalette, applied, skipped } = applyResult

    // Título-hook: preserva o existente (editPlan) salvo se o diretor mudou.
    const existingPlan = project.editPlanJson ? JSON.parse(project.editPlanJson) : null
    let hookTitle: string | undefined =
      existingPlan && typeof existingPlan.hookTitle === 'string' && existingPlan.hookTitle.trim()
        ? existingPlan.hookTitle
        : undefined
    if (Object.prototype.hasOwnProperty.call(applyResult, 'hookTitle')) {
      hookTitle = applyResult.hookTitle === null ? undefined : applyResult.hookTitle ?? undefined
    }

    // Cold open (Fase 3): preserva a janela existente salvo se o diretor mudou.
    // Um update_cold_open traz um startLeg (batida) que resolvemos para a janela
    // de frames aqui (com fps + durationFrames); null remove.
    let coldOpen: ColdOpenWindow | undefined =
      existingPlan && existingPlan.coldOpen && typeof existingPlan.coldOpen === 'object'
        ? existingPlan.coldOpen
        : undefined
    let coldOpenLegPending: number | null | undefined
    if (Object.prototype.hasOwnProperty.call(applyResult, 'coldOpenStartLeg')) {
      coldOpenLegPending = applyResult.coldOpenStartLeg
      if (coldOpenLegPending === null) coldOpen = undefined
    }

    // Nada aplicável: responde sem persistir nem criar snapshot.
    if (applied.length === 0) {
      return NextResponse.json({
        summary: direction.summary,
        applied,
        skipped,
        scenes,
        palette
      })
    }

    // 3. Snapshot ANTES de aplicar (nível único de undo).
    await saveSnapshot(projectId, {
      scenesJson: project.scenesJson,
      paletteJson: project.paletteJson,
      editPlanJson: project.editPlanJson
    })

    // 4. Resolver assetId → paths de mídia, depois re-resolver timing (startLeg → frame).
    const resolvedAssetScenes = resolveAssetsInScenes(updatedScenes)
    const scenesWithTiming = resolveSceneTiming(resolvedAssetScenes, subtitles, fps)

    // 5. Gerar imagens para ImageInsert novos/sem imagem (reusa as antigas como pool).
    const scenesWithAssets = await generateImageInsertAssets({
      projectId,
      scenes: scenesWithTiming,
      format,
      stylePreset,
      transcriptionText: transcription?.text || '',
      existingScenes: scenes
    })

    // Resolve um update_cold_open (batida → janela de frames) contra as cenas já
    // atualizadas, para que o span acompanhe a nova estrutura.
    if (typeof coldOpenLegPending === 'number') {
      const durationFrames = Math.max(
        1,
        (existingPlan && typeof existingPlan.durationFrames === 'number'
          ? existingPlan.durationFrames
          : 0) || Math.ceil((project.videoDuration || 0) * fps)
      )
      const window = computeColdOpenWindow(
        coldOpenLegPending,
        subtitles,
        scenesWithAssets,
        fps,
        durationFrames
      )
      if (window) coldOpen = window
    }

    // 6. Regenerar o editPlan (mesmo fluxo do analyze).
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

    // 7. Persistir e invalidar o vídeo renderizado.
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

    return NextResponse.json({
      summary: direction.summary,
      applied,
      skipped,
      scenes: scenesWithAssets,
      palette: updatedPalette
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao editar o projeto'
    console.error('Project refine error:', error)
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    if (lockAcquired && projectId) {
      releaseStepLock('refine', projectId)
    }
  }
}
