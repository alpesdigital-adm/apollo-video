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
  resolvePunchIns,
  resolveColdOpen,
  offsetScenesForColdOpen,
  offsetLayoutSegmentsForColdOpen,
  offsetPunchInsForColdOpen,
  buildColdOpenSubtitles,
  type RemotionInputProps,
  type RemotionSceneInput,
  type AudioInputProps
} from '@/lib/remotion/input-props'
import { readCreatorProfile } from '@/lib/creator-profile'
import { readStylePrefs } from '@/lib/style-prefs'
import { pickMusicForProject } from '@/lib/audio-assets'

interface StartProjectRenderOptions {
  clearExistingRender?: boolean
  statusOnStart?: 'rendering'
  // Modo diagnóstico: monta e grava APENAS o JSON de inputProps do estado
  // atual — sem RenderJob, sem manifest, sem spawn, sem tocar no status.
  // (O padrão antigo de "disparar render e matar" marcava o projeto com erro.)
  propsOnly?: boolean
}

interface ActiveRenderEntry {
  child: ChildProcess
  jobId: string
  startedAt: number
  lastProgressWrite: number
}

// In dev, each Next route compiles its own bundle, so module-level state is NOT
// shared across route bundles (the status route saw an empty Map while a render
// was live and falsely reconciled it as orphaned). Anchor the registry on
// globalThis so every bundle in the same process shares one Map.
const g = globalThis as any
const activeRenders: Map<string, ActiveRenderEntry> = (g.__apolloActiveRenders ??= new Map())

// Teto ABSOLUTO de segurança (backstop raro). O corte de verdade é o watchdog
// de INATIVIDADE: um render lento-mas-vivo nunca morre por relógio (caso real:
// vídeo de 3m15s morto a 76% aos 30min porque outro render dividia a CPU).
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS) || 3 * 60 * 60000
const RENDER_STALL_TIMEOUT_MS = Number(process.env.RENDER_STALL_TIMEOUT_MS) || 10 * 60000

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

  // UM render por vez no processo inteiro: dois renders simultâneos dividem a
  // CPU e os dois rastejam (caso real: segundo render entrou junto e o primeiro
  // morreu a 76% no teto de tempo). propsOnly não spawna nada, então passa.
  if (!options.propsOnly && activeRenders.size > 0) {
    const busy = [...activeRenders.keys()][0]
    throw new Error(
      busy === projectId
        ? 'Este projeto já está renderizando.'
        : `Já tem um render em andamento (projeto ${busy.slice(0, 8)}…). Espere ele terminar e clique de novo.`
    )
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

  const renderJob = options.propsOnly
    ? null
    : await prisma.renderJob.create({
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

  const stylePrefs = readStylePrefs()
  const subtitleStyle = stylePrefs.subtitleStyle
  const gradePreset = stylePrefs.gradePreset
  const hookTitle =
    editPlan && typeof (editPlan as any).hookTitle === 'string' && (editPlan as any).hookTitle.trim()
      ? (editPlan as any).hookTitle
      : undefined

  const appBaseUrl = getAppBaseUrl()
  // SFX removidos por decisão de produto (2026-07-03) — só trilha de fundo.
  const musicPick = pickMusicForProject(projectId)
  const audio: AudioInputProps | undefined = musicPick
    ? { events: [], music: { src: `${appBaseUrl}${musicPick.src}`, volume: musicPick.volume } }
    : undefined

  // COLD OPEN (Fase 3): janela FONTE (3-8s) clampada contra a duração do plano.
  const baseDurationFrames = Math.max(
    1,
    editPlan?.durationFrames || Math.ceil((project.videoDuration || 1) * fps)
  )
  const coldOpen = resolveColdOpen(editPlan, fps, baseDurationFrames)

  let scenesProps = prepareRemotionScenes(
    scenes
      .map((scene) => toRemotionScene(scene, fps, { baseUrl: appBaseUrl }))
      .filter((scene): scene is RemotionSceneInput => Boolean(scene)),
    fps
  )
  let subtitlesProps = subtitles
  let layoutSegmentsProps = resolveLayoutSegments(editPlan, { baseUrl: appBaseUrl })
  let punchInsProps = resolvePunchIns(editPlan)

  if (coldOpen) {
    scenesProps = offsetScenesForColdOpen(scenesProps, coldOpen.len, fps)
    subtitlesProps = buildColdOpenSubtitles(subtitles, coldOpen, fps)
    layoutSegmentsProps = offsetLayoutSegmentsForColdOpen(layoutSegmentsProps, coldOpen.len)
    punchInsProps = offsetPunchInsForColdOpen(punchInsProps, coldOpen.len)
  }

  const inputProps: RemotionInputProps = {
    scenes: scenesProps,
    subtitles: normalizeSubtitleWords(subtitlesProps),
    transcription,
    palette,
    videoSrc: `${appBaseUrl}/api/video/${project.id}?source=primary`,
    format: project.format as '9:16' | '16:9',
    stylePreset: project.stylePreset || 'creator-clean',
    subtitleStyle,
    gradePreset,
    ...(hookTitle ? { hookTitle } : {}),
    creator: resolveCreatorForProps(readCreatorProfile(), appBaseUrl),
    layoutSegments: layoutSegmentsProps,
    punchIns: punchInsProps,
    ...(audio ? { audio } : {}),
    ...(coldOpen ? { coldOpen } : {})
  }

  const outputDir = path.join(process.cwd(), 'public', 'renders')
  await mkdir(outputDir, { recursive: true })
  const outputPath = path.join(outputDir, `${projectId}-render-${Date.now()}.mp4`)
  const manifestPath = getRenderManifestPath(outputPath)
  const propsDir = path.join(process.cwd(), 'tmp', 'remotion-props')
  await mkdir(propsDir, { recursive: true })
  const propsPath = path.join(
    propsDir,
    `${projectId}-${renderJob ? renderJob.id : 'diagnostic'}.json`
  )
  await writeFile(propsPath, JSON.stringify(inputProps), 'utf8')

  const compositionId = project.format === '16:9' ? 'horizontal' : 'vertical'
  // Cold open lengthens the timeline by `len` frames (prepended teaser).
  const durationFrames = baseDurationFrames + (coldOpen ? coldOpen.len : 0)

  if (!renderJob) {
    // propsOnly: nada foi criado além do arquivo de props.
    return { jobId: null, outputPath: null, durationFrames, propsPath }
  }
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
  let timeoutReason = ''
  let lastProgressValue = 0
  let lastActivityAt = Date.now()

  const watchdog = setInterval(() => {
    const now = Date.now()
    if (now - renderEntry.startedAt >= RENDER_TIMEOUT_MS) {
      timeoutReason = `Render passou do teto absoluto de ${Math.round(RENDER_TIMEOUT_MS / 60000)}min`
    } else if (now - lastActivityAt >= RENDER_STALL_TIMEOUT_MS) {
      timeoutReason = `Render travado: ${Math.round(RENDER_STALL_TIMEOUT_MS / 60000)}min sem sinal de vida (parou em ${lastProgressValue}%)`
    } else {
      return
    }
    timedOut = true
    clearInterval(watchdog)
    console.error(`${timeoutReason} — matando a árvore de processos (projeto ${projectId})`)
    killProcessTree(remotionProcess)
  }, 30000)

  remotionProcess.stdout?.on('data', (data) => {
    const chunk = String(data)
    const now = Date.now()
    lastActivityAt = now
    const pct = parseRenderProgress(chunk)

    // Progress update: only when it advances by ≥1 point (throttled to 1s).
    if (pct !== null && pct > lastProgressValue && now - renderEntry.lastProgressWrite >= 1000) {
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
      return
    }

    // Heartbeat: during the final encode/concat phase there are no frame lines,
    // so progress stops advancing and RenderJob.updatedAt goes stale (>3min),
    // tripping orphan reconciliation on a perfectly healthy render. On ANY chunk,
    // if ≥5s since the last write, touch the job (rewrite the current progress)
    // purely to renew updatedAt.
    if (now - renderEntry.lastProgressWrite >= 5000) {
      renderEntry.lastProgressWrite = now
      prisma.renderJob
        .update({
          where: { id: renderJob.id },
          data: { progress: lastProgressValue }
        })
        .catch((error) => {
          console.error('Failed to heartbeat render job:', error)
        })
    }
  })

  let stderr = ''
  remotionProcess.stderr?.on('data', (data) => {
    lastActivityAt = Date.now()
    stderr += String(data)
    console.error(`Render output: ${data}`)
  })

  remotionProcess.on('error', async (error) => {
    clearInterval(watchdog)
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
    clearInterval(watchdog)
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
          ? timeoutReason
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
