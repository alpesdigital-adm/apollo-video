import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { analyzeContent } from '@/lib/services/claude'
import { generateImageInsertAssets } from '@/lib/services/image-generation'
import { generateMotionForScenes } from '@/lib/services/video-generation'
import { applyStockVideos } from '@/lib/services/stock-video'
import { narrativeEngine } from '@/lib/engines/narrative-engine'
import { acquireStepLock, releaseStepLock } from '@/lib/pipeline-lock'
import { curateSceneDensity, resolveSceneTiming } from '@/lib/utils/timing'
import { pickBrandGroup, readBrandColors } from '@/lib/brand-colors'
import { getAssetCatalog, resolveAssetsInScenes } from '@/lib/asset-library'
import type { AnalyzeContentBrandColors } from '@/lib/services/claude'
import type { Silence, SubtitleEntry, Transcription } from '@/lib/types/project'
import type { Scene } from '@/lib/types/scene'

function readOwnerBrief(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as { ownerInput?: { text?: unknown; trust?: unknown } }
    if (parsed.ownerInput?.trust !== 'owner-authorized' || typeof parsed.ownerInput.text !== 'string') {
      return undefined
    }
    return parsed.ownerInput.text.trim().slice(0, 10_000) || undefined
  } catch {
    return undefined
  }
}

function shouldUseCloseUpCompactLayout(project: {
  videoWidth: number | null
  videoHeight: number | null
}, format: '9:16' | '16:9'): boolean {
  const width = project.videoWidth || 0
  const height = project.videoHeight || 0
  const isPortrait = height > width && height / Math.max(1, width) >= 1.55

  return format === '9:16' && isPortrait
}

function applyCloseUpCompactLayoutRule(scenes: Scene[], useCompactLayout: boolean): Scene[] {
  if (!useCompactLayout) {
    return scenes
  }

  return scenes.map((scene) => {
    if (scene.type !== 'ImageInsert' || scene.layout !== 'split-bottom') {
      return scene
    }

    return {
      ...scene,
      layout: 'top-image-compact'
    }
  })
}

export async function POST(request: NextRequest) {
  let projectId: string | null = null
  let lockAcquired = false

  try {
    const body = await request.json()
    projectId = body.projectId

    if (!projectId) {
      return NextResponse.json({ error: 'projectId required' }, { status: 400 })
    }

    // Get project from database
    const project = await prisma.project.findUnique({
      where: { id: projectId }
    })

    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    if (!project.transcriptionJson) {
      return NextResponse.json({ error: 'Transcription not found' }, { status: 400 })
    }

    if (!project.normalizedPath) {
      return NextResponse.json({ error: 'Processed video not found' }, { status: 400 })
    }

    if (!acquireStepLock('analyze', projectId)) {
      return NextResponse.json(
        { error: 'Analysis already running for this project' },
        { status: 409 }
      )
    }
    lockAcquired = true

    // Parse transcription and subtitles
    const transcription: Transcription = JSON.parse(project.transcriptionJson)
    const subtitles: SubtitleEntry[] = project.subtitlesJson ? JSON.parse(project.subtitlesJson) : []
    const silences: Silence[] = project.silencesJson ? JSON.parse(project.silencesJson) : []
    const existingScenes: Scene[] = project.scenesJson ? JSON.parse(project.scenesJson) : []

    const format = (project.format || '16:9') as '9:16' | '16:9'
    const fps = project.videoFps || 30
    const stylePreset = project.stylePreset || 'creator-clean'
    const useCloseUpCompactLayout =
      typeof body.closeUpTalkingHead === 'boolean'
        ? body.closeUpTalkingHead
        : shouldUseCloseUpCompactLayout(project, format)

    // Resolve brand color groups configured in /settings. Round-robin mode
    // picks the group in code (advancing the rotation); ai-pick mode hands
    // the groups to Claude and lets it choose one. No groups configured ->
    // behavior is unchanged (Claude invents the palette).
    const brandColorsConfig = readBrandColors()
    let brandColors: AnalyzeContentBrandColors | undefined
    if (brandColorsConfig.groups.length > 0) {
      if (brandColorsConfig.mode === 'round-robin') {
        const forced = pickBrandGroup(brandColorsConfig, true)
        brandColors = forced ? { groups: brandColorsConfig.groups, forced } : undefined
      } else {
        brandColors = { groups: brandColorsConfig.groups }
      }
    }

    // Asset library (Pacote 4): pass the compact catalog to Claude only when the
    // user has assets — otherwise the prompt is unchanged.
    const assetCatalog = getAssetCatalog()

    // Modo mínimo: sem chamadas de cena (só corte + legendas). body.minimal=true.
    const minimal = body.minimal === true

    // Call Claude API to analyze content and generate scenes
    const analysisResult = await analyzeContent(
      transcription.text,
      format,
      subtitles,
      stylePreset,
      brandColors,
      assetCatalog.length > 0 ? assetCatalog : undefined,
      minimal,
      readOwnerBrief(project.briefingJson)
    )

    // Resolve scene timing - convert startLeg to actual frame numbers
    const curatedScenes = curateSceneDensity(analysisResult.scenes, 0.6)
    const layoutAdjustedScenes = applyCloseUpCompactLayoutRule(
      curatedScenes,
      useCloseUpCompactLayout
    )
    // Resolve any assetId → media paths BEFORE the engine / image generation.
    const resolvedAssetScenes = resolveAssetsInScenes(layoutAdjustedScenes)
    const scenesWithTiming = resolveSceneTiming(resolvedAssetScenes, subtitles, fps)
    const scenesWithAssets = await generateImageInsertAssets({
      projectId,
      scenes: scenesWithTiming,
      format,
      stylePreset,
      transcriptionText: transcription.text,
      existingScenes
    })
    // Pacote 3 — b-roll de vídeo: stock (Pexels) primeiro, depois anima os stills
    // marcados com motion (WaveSpeed i2v). Ambos são opcionais e degradam para o
    // still sem nunca quebrar o analyze.
    const scenesWithStock = await applyStockVideos({ scenes: scenesWithAssets })
    const scenesWithMotion = await generateMotionForScenes({
      projectId,
      scenes: scenesWithStock,
      format
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
      transcription,
      subtitles,
      silences,
      scenes: scenesWithMotion,
      hookTitle: analysisResult.hookTitle
    })

    // Update project with analysis results
    await prisma.project.update({
      where: { id: projectId },
      data: {
        scenesJson: JSON.stringify(scenesWithMotion),
        paletteJson: JSON.stringify(analysisResult.palette),
        narrativeFormat: analysisResult.narrativeFormat,
        engineKind: narrativeEngine.kind,
        editPlanJson: JSON.stringify(editPlan),
        renderedVideoPath: null,
        status: 'ready',
        error: null
      }
    })

    return NextResponse.json({
      success: true,
      scenes: scenesWithMotion,
      palette: analysisResult.palette,
      narrativeFormat: analysisResult.narrativeFormat,
      engine: editPlan.engine,
      editPlan,
      ...(analysisResult.colorGroup ? { colorGroup: analysisResult.colorGroup } : {})
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Analysis failed'

    // Update status to error if projectId is available
    if (projectId) {
      try {
        await prisma.project.update({
          where: { id: projectId },
          data: {
            status: 'error',
            error: message
          }
        })
      } catch (dbError) {
        console.error('Failed to update error status:', dbError)
      }
    }

    console.error('Analyze error:', error)
    return NextResponse.json(
      {
        error: message
      },
      { status: 500 }
    )
  } finally {
    if (lockAcquired && projectId) {
      releaseStepLock('analyze', projectId)
    }
  }
}
