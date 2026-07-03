import { spawn, type ChildProcess } from 'child_process'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'
import type { EditPlan } from '@/lib/types/edl'
import type { SubtitleEntry, Transcription } from '@/lib/types/project'
import type { Scene } from '@/lib/types/scene'
import { FPS } from '@/lib/types/timing'
import {
  toRemotionScene,
  prepareRemotionScenes,
  normalizeSubtitleWords,
  resolveCreatorForProps,
  resolveLayoutSegments,
  type RemotionInputProps,
  type RemotionSceneInput
} from '@/lib/remotion/input-props'
import { readCreatorProfile } from '@/lib/creator-profile'
import { readStylePrefs } from '@/lib/style-prefs'

interface StartProjectRenderOptions {
  clearExistingRender?: boolean
  statusOnStart?: 'rendering'
}

interface ActiveRenderEntry {
  child: ChildProcess
  jobId: string
  startedAt: number
  lastProgressWrite: number
}

const activeRenders = new Map<string, ActiveRenderEntry>()

const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS) || 30 * 60000

export function isRenderActive(projectId: string): boolean {
  return activeRenders.has(projectId)
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function parseRenderProgress(chunk: string): number | null {
  const frameMatch = chunk.match(/(\d+)\s*\/\s*(\d+)/)
  if (frameMatch) {
    const current = Number(frameMatch[1])
    const total = Number(frameMatch[2])
    if (total > 0 && Number.isFinite(current)) {
      return clamp(Math.round((current / total) * 100), 1, 99)
    }
  }
  const percentMatch = chunk.match(/(\d+)\s*%/)
  if (percentMatch) {
    const pct = Number(percentMatch[1])
    if (Number.isFinite(pct)) {
      return clamp(Math.round(pct), 1, 99)
    }
  }
  return null
}

function getAppBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3333').replace(/\/$/, '')
}

function getRenderManifestPath(outputPath: string): string {
  return outputPath.replace(/\.mp4$/i, '.manifest.json')
}

export async function startProjectRender(
  projectId: string,
  options: StartProjectRenderOptions = {}
) {
  const project = await prisma.project.findUnique({
    where: { id: projectId }
  })

  if (!project) {
    throw new Error('Project not found')
  }

  if (
    !project.scenesJson ||
    !project.transcriptionJson ||
    !project.subtitlesJson ||
    !project.normalizedPath
  ) {
    throw new Error('Project not ready for rendering')
  }

  const scenes: Scene[] = JSON.parse(project.scenesJson)
  const transcription: Transcription = JSON.parse(project.transcriptionJson)
  const subtitles: SubtitleEntry[] = JSON.parse(project.subtitlesJson)
  const editPlan: EditPlan | null = project.editPlanJson ? JSON.parse(project.editPlanJson) : null
  const palette = project.paletteJson
    ? JSON.parse(project.paletteJson)
    : {
        primary: '#FFB800',
        secondary: '#20202A',
        accent: '#FF6B35',
        background: '#050508',
        text: '#FFFFFF'
      }

  const renderJob = await prisma.renderJob.create({
    data: {
      projectId,
      status: 'queued',
      progress: 0
    }
  })

  if (options.statusOnStart) {
    await prisma.project.update({
      where: { id: projectId },
      data: {
        status: options.statusOnStart,
        renderedVideoPath: options.clearExistingRender ? null : project.renderedVideoPath,
        error: null
      }
    })
  }

  const fps = project.videoFps || FPS

  const subtitleStyle = readStylePrefs().subtitleStyle
  const hookTitle =
    editPlan && typeof (editPlan as any).hookTitle === 'string' && (editPlan as any).hookTitle.trim()
      ? (editPlan as any).hookTitle
      : undefined

  const inputProps: RemotionInputProps = {
    scenes: prepareRemotionScenes(
      scenes
        .map((scene) => toRemotionScene(scene, fps, { baseUrl: getAppBaseUrl() }))
        .filter((scene): scene is RemotionSceneInput => Boolean(scene)),
      fps
    ),
    subtitles: normalizeSubtitleWords(subtitles),
    transcription,
    palette,
    videoSrc: `${getAppBaseUrl()}/api/video/${project.id}?source=primary`,
    format: project.format as '9:16' | '16:9',
    stylePreset: project.stylePreset || 'creator-clean',
    subtitleStyle,
    ...(hookTitle ? { hookTitle } : {}),
    creator: resolveCreatorForProps(readCreatorProfile(), getAppBaseUrl()),
    layoutSegments: resolveLayoutSegments(editPlan, { baseUrl: getAppBaseUrl() })
  }

  const outputDir = path.join(process.cwd(), 'public', 'renders')
  await mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${projectId}-render-${Date.now()}.mp4`)
  const manifestPath = getRenderManifestPath(outputPath)
  const propsDir = path.join(process.cwd(), 'tmp', 'remotion-props')
  await mkdir(propsDir, { recursive: true })
  const propsPath = path.join(propsDir, `${projectId}-${renderJob.id}.json`)
  await writeFile(propsPath, JSON.stringify(inputProps), 'utf8')

  const compositionId = project.format === '16:9' ? 'horizontal' : 'vertical'
  const durationFrames = Math.max(
    1,
    editPlan?.durationFrames || Math.ceil((project.videoDuration || 1) * fps)
  )
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: 1,
        project: {
          id: project.id,
          name: project.name,
          format: project.format,
          stylePreset: project.stylePreset,
          engineKind: project.engineKind
        },
        source: {
          rawVideoPath: project.rawVideoPath,
          normalizedPath: project.normalizedPath,
          duration: project.videoDuration,
          width: project.videoWidth,
          height: project.videoHeight,
          fps
        },
        render: {
          jobId: renderJob.id,
          outputPath,
          compositionId,
          propsPath,
          durationFrames,
          createdAt: new Date().toISOString()
        },
        analysis: {
          narrativeFormat: project.narrativeFormat,
          sceneCount: scenes.length,
          subtitleCount: subtitles.length,
          silenceCutCount: editPlan?.cuts.length || 0,
          overlayCount: editPlan?.overlays.length || scenes.length
        },
        lineage: editPlan?.lineage || null,
        scenes: scenes.map((scene) => ({
          id: scene.id,
          type: scene.type,
          startLeg: scene.startLeg,
          durationInSubtitles: scene.durationInSubtitles,
          startFrame: scene.startFrame,
          endFrame: scene.endFrame,
          narrativeRole: (scene as any).narrativeRole,
          visualRole: (scene as any).visualRole,
          layout: (scene as any).layout,
          imagePath: (scene as any).imagePath,
          sourceText: (scene as any).sourceText
        }))
      },
      null,
      2
    ),
    'utf8'
  )
  const remotionCwd = path.join(process.cwd(), 'remotion')
  const remotionCliPath = path.join(
    remotionCwd,
    'node_modules',
    '@remotion',
    'cli',
    'remotion-cli.js'
  )

  const remotionProcess = spawn(
    process.execPath,
    [
      remotionCliPath,
      'render',
      'src/index.ts',
      compositionId,
      outputPath,
      `--props=${propsPath}`,
      '--frames',
      `0-${durationFrames - 1}`,
      '--quality',
      '80',
      '--codec',
      'h264',
      '--crf',
      '23'
    ],
    { cwd: remotionCwd, windowsHide: true }
  )

  const renderEntry: ActiveRenderEntry = {
    child: remotionProcess,
    jobId: renderJob.id,
    startedAt: Date.now(),
    lastProgressWrite: 0
  }
  activeRenders.set(projectId, renderEntry)

  let timedOut = false
  let lastProgressValue = 0

  const timeoutHandle = setTimeout(() => {
    timedOut = true
    console.error(`Render timeout for project ${projectId} after ${RENDER_TIMEOUT_MS}ms, killing process tree`)
    killProcessTree(remotionProcess)
  }, RENDER_TIMEOUT_MS)

  remotionProcess.stdout?.on('data', (data) => {
    const chunk = String(data)
    const pct = parseRenderProgress(chunk)
    if (pct === null) return

    const now = Date.now()
    if (pct <= lastProgressValue || now - renderEntry.lastProgressWrite < 1000) {
      return
    }

    lastProgressValue = pct
    renderEntry.lastProgressWrite = now
    console.log(`Render progress for project ${projectId}: ${pct}%`)

    prisma.renderJob
      .update({
        where: { id: renderJob.id },
        data: { status: 'rendering', progress: pct }
      })
      .catch((error) => {
        console.error('Failed to update render progress:', error)
      })
  })

  let stderr = ''
  remotionProcess.stderr?.on('data', (data) => {
    stderr += String(data)
    console.error(`Render output: ${data}`)
  })

  remotionProcess.on('error', async (error) => {
    clearTimeout(timeoutHandle)
    activeRenders.delete(projectId)
    const message = `Render process failed to start: ${error instanceof Error ? error.message : String(error)}`
    try {
      await prisma.renderJob.update({
        where: { id: renderJob.id },
        data: { status: 'failed', error: message }
      })
      await prisma.project.update({
        where: { id: projectId },
        data: { status: 'error', error: message }
      })
    } catch (dbError) {
      console.error('Failed to update render job status after spawn error:', dbError)
    }
  })

  remotionProcess.on('close', async (code) => {
    clearTimeout(timeoutHandle)
    activeRenders.delete(projectId)
    try {
      if (code === 0 && !timedOut) {
        await prisma.renderJob.update({
          where: { id: renderJob.id },
          data: { status: 'completed', progress: 100, outputPath }
        })

        await prisma.project.update({
          where: { id: projectId },
          data: { status: 'complete', renderedVideoPath: outputPath, error: null }
        })
      } else {
        const message = timedOut
          ? `Render timeout after ${RENDER_TIMEOUT_MS}ms`
          : `Render process exited with code ${code}${stderr ? `: ${stderr.slice(-1000)}` : ''}`
        await prisma.renderJob.update({
          where: { id: renderJob.id },
          data: {
            status: 'failed',
            error: message
          }
        })

        await prisma.project.update({
          where: { id: projectId },
          data: { status: 'error', error: message }
        })
      }
    } catch (error) {
      console.error('Failed to update render job status:', error)
    }
  })

  return {
    jobId: renderJob.id,
    outputPath,
    manifestPath,
    durationFrames
  }
}
