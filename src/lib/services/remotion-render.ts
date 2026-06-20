import { spawn } from 'child_process'
import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'
import type { EditPlan } from '@/lib/types/edl'
import type { Scene } from '@/lib/types/scene'
import type { SubtitleEntry, Transcription } from '@/lib/types/project'
import { FPS } from '@/lib/types/timing'

interface InputProps {
  scenes: Array<{
    type: string
    from: number
    to: number
    fromFrame: number
    toFrame: number
    props: Record<string, any>
  }>
  subtitles: SubtitleEntry[]
  transcription: Transcription
  palette: any
  videoSrc: string
  format: '9:16' | '16:9'
  stylePreset?: string
}

interface StartProjectRenderOptions {
  clearExistingRender?: boolean
  statusOnStart?: 'rendering'
}

type RemotionSceneInput = InputProps['scenes'][number]

function normalizeImageInsertLayout(value: unknown): 'full' | 'split-bottom' | 'top-image-compact' {
  return value === 'split-bottom' || value === 'top-image-compact' ? value : 'full'
}

function getAppBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3333').replace(/\/$/, '')
}

function toPublicUrl(value: string | undefined): string {
  if (!value) {
    return ''
  }

  if (/^https?:\/\//i.test(value)) {
    return value
  }

  if (value.startsWith('/')) {
    return `${getAppBaseUrl()}${value}`
  }

  return value
}

function normalizeRemotionScenes(scenes: RemotionSceneInput[], fps: number): RemotionSceneInput[] {
  const gapFrames = Math.max(6, Math.round(fps * 0.35))
  const minDurationFrames = Math.max(1, Math.round(fps * 2.8))
  let cursorFrame = 0

  return [...scenes]
    .sort((a, b) => a.fromFrame - b.fromFrame)
    .map((scene) => {
      const durationFrames = Math.max(scene.toFrame - scene.fromFrame, minDurationFrames)
      const fromFrame = Math.max(scene.fromFrame, cursorFrame)
      const toFrame = fromFrame + durationFrames
      cursorFrame = toFrame + gapFrames

      return {
        ...scene,
        from: fromFrame / fps,
        to: toFrame / fps,
        fromFrame,
        toFrame
      }
    })
}

function getRenderManifestPath(outputPath: string): string {
  return outputPath.replace(/\.mp4$/i, '.manifest.json')
}

function toRemotionScene(scene: Scene, fps: number): RemotionSceneInput | null {
  const startFrame = scene.startFrame || 0
  const endFrame = scene.endFrame || startFrame + Math.round(fps * 2.8)
  const {
    id: _id,
    type,
    startLeg: _startLeg,
    durationInSubtitles: _durationInSubtitles,
    startFrame: _startFrame,
    endFrame: _endFrame,
    ...props
  } = scene as any

  const typeMap: Record<string, string> = {
    FullScreen: 'fullscreen',
    LowerThird: 'lower-third',
    Split: 'split',
    SplitVertical: 'split-vertical',
    Card: 'card',
    Message: 'message',
    Number: 'number',
    Flow: 'flow',
    CTA: 'cta',
    StickFigures: 'stick-figures',
    ImageInsert: 'image-insert'
  }

  const adaptedProps = { ...props }
  if (type === 'FullScreen' && !adaptedProps.title) {
    adaptedProps.title = adaptedProps.text || 'Highlight'
  }
  if (type === 'Split') {
    adaptedProps.title = adaptedProps.title || adaptedProps.topText || 'Context'
    adaptedProps.content = adaptedProps.content || adaptedProps.bottomText || ''
  }
  if (type === 'SplitVertical') {
    adaptedProps.leftContent = adaptedProps.leftContent || adaptedProps.leftText || ''
    adaptedProps.rightContent = adaptedProps.rightContent || adaptedProps.rightText || ''
    adaptedProps.leftLabel = adaptedProps.leftLabel || 'Antes'
    adaptedProps.rightLabel = adaptedProps.rightLabel || 'Depois'
  }
  if (type === 'Message') {
    adaptedProps.senderName = adaptedProps.senderName || adaptedProps.sender || 'Mensagem'
    adaptedProps.messageText = adaptedProps.messageText || adaptedProps.message || ''
  }
  if (type === 'Flow' && Array.isArray(adaptedProps.steps)) {
    adaptedProps.steps = adaptedProps.steps.map((step: any, index: number) =>
      typeof step === 'string' ? { number: index + 1, text: step } : step
    )
  }
  if (type === 'CTA') {
    adaptedProps.highlightWord = adaptedProps.highlightWord || adaptedProps.highlight
  }
  if (type === 'StickFigures') {
    adaptedProps.leftCaption = adaptedProps.leftCaption || adaptedProps.situation || ''
    adaptedProps.rightCaption = adaptedProps.rightCaption || adaptedProps.caption || ''
  }
  if (type === 'ImageInsert') {
    adaptedProps.imageSrc = toPublicUrl(adaptedProps.imageSrc || adaptedProps.imagePath)
    if (!adaptedProps.imageSrc) {
      return null
    }
    adaptedProps.layout = normalizeImageInsertLayout(adaptedProps.layout)
  }

  return {
    type: typeMap[type] || 'fullscreen',
    from: startFrame / fps,
    to: Math.max(endFrame, startFrame + fps) / fps,
    fromFrame: startFrame,
    toFrame: Math.max(endFrame, startFrame + fps),
    props: adaptedProps
  }
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

  const renderSubtitles = subtitles.map((subtitle) => {
    const words = subtitle.words
      ?.map((word: any) => {
        if (typeof word === 'string') {
          return word
        }

        return {
          word: String(word.word || '').trim(),
          start: Number(word.start),
          end: Number(word.end)
        }
      })
      .filter((word: any) => (
        typeof word === 'string'
          ? Boolean(word)
          : Boolean(word.word) && Number.isFinite(word.start) && Number.isFinite(word.end)
      ))

    return {
      ...subtitle,
      words: words && words.length > 0 ? words : subtitle.text.split(/\s+/).filter(Boolean)
    }
  }) as any
  const fps = project.videoFps || FPS

  const inputProps: InputProps = {
    scenes: normalizeRemotionScenes(
      scenes
        .map((scene) => toRemotionScene(scene, fps))
        .filter((scene): scene is RemotionSceneInput => Boolean(scene)),
      fps
    ),
    subtitles: renderSubtitles,
    transcription,
    palette,
    videoSrc: `${getAppBaseUrl()}/api/video/${project.id}?source=primary`,
    format: project.format as '9:16' | '16:9',
    stylePreset: project.stylePreset || 'creator-clean'
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

  remotionProcess.stdout?.on('data', async (data) => {
    console.log(`Render output: ${data}`)
    try {
      await prisma.renderJob.update({
        where: { id: renderJob.id },
        data: { status: 'rendering', progress: 50 }
      })
    } catch (error) {
      console.error('Failed to update render progress:', error)
    }
  })

  let stderr = ''
  remotionProcess.stderr?.on('data', (data) => {
    stderr += String(data)
    console.error(`Render output: ${data}`)
  })

  remotionProcess.on('close', async (code) => {
    try {
      if (code === 0) {
        await prisma.renderJob.update({
          where: { id: renderJob.id },
          data: { status: 'completed', progress: 100, outputPath }
        })

        await prisma.project.update({
          where: { id: projectId },
          data: { status: 'complete', renderedVideoPath: outputPath, error: null }
        })
      } else {
        const message = `Render process exited with code ${code}${stderr ? `: ${stderr.slice(-1000)}` : ''}`
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
