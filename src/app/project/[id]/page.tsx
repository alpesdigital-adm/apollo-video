'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { RemotionProjectPlayer } from '@/components/RemotionProjectPlayer'
import type { Scene } from '@/lib/types/scene'
import type { SubtitleEntry } from '@/lib/types/project'
import type { ProjectStatus } from '@/lib/types/project'

interface ProjectData {
  id: string
  name: string
  status: ProjectStatus
  error?: string | null
  format: '9:16' | '16:9'
  engineKind?: 'narrative' | 'visual'
  stylePreset?: string
  editPlan?: {
    durationFrames: number
    cuts: unknown[]
    overlays: unknown[]
    layoutSegments?: unknown[]
    audio?: unknown[]
    lineage?: {
      units: Array<{
        id: string
        kind: string
        role?: string
        visualRole?: string
      }>
    }
    ports?: {
      acceptsNarration: boolean
      acceptsVisualMontage: boolean
      canUseBroll: boolean
      canUseMusicDrivenCuts: boolean
    }
  } | null
  videoDuration: number
  videoFps?: number
  musicPick?: { src: string; volume: number } | null
  renderedVideoPath?: string | null
  hasRefineSnapshot?: boolean
  scenes: Scene[]
  subtitles: SubtitleEntry[]
  silences: Array<{ startTime: number; endTime: number; duration: number }>
  palette: any
  transcription: any
  renderJob?: { id: string; status: string; progress: number; error?: string } | null
}

interface BeatItem {
  index: number
  text: string
  startTime: number
  endTime: number
  startFrame: number
  endFrame: number
  sceneId: string | null
  sceneType: string | null
  sceneSpan: { from: number; to: number } | null
  isSpanStart: boolean
  thumbUrl: string | null
}

// Scene models the beat panel can assign (order = dropdown order).
const BEAT_SCENE_TYPES = [
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
]

const PIPELINE_STEPS = [
  { name: 'Uploaded', status: 'created' },
  { name: 'Normalize', status: 'normalizing' },
  { name: 'Transcribe', status: 'transcribing' },
  { name: 'Analyze', status: 'analyzing' },
  { name: 'Ready', status: 'ready' },
  { name: 'Render', status: 'rendering' },
  { name: 'Complete', status: 'complete' }
]

export default function EditorPage() {
  const router = useRouter()
  const params = useParams()
  const projectId = params.id as string

  const [project, setProject] = useState<ProjectData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedScene, setSelectedScene] = useState<Scene | null>(null)
  const [refineInput, setRefineInput] = useState('')
  const [isRefining, setIsRefining] = useState(false)
  const [isRendering, setIsRendering] = useState(false)
  const [isUndoing, setIsUndoing] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [refineError, setRefineError] = useState<string | null>(null)
  const [redoMenuOpen, setRedoMenuOpen] = useState(false)
  const [redoBusy, setRedoBusy] = useState<'reopen' | 'analyze' | 'transcribe' | null>(null)
  const [redoError, setRedoError] = useState<string | null>(null)
  const [directorResult, setDirectorResult] = useState<{
    summary: string
    applied: string[]
    skipped: string[]
  } | null>(null)
  const pipelineInFlight = useRef<ProjectStatus | null>(null)

  // --- Beat panel state ---
  const [beats, setBeats] = useState<BeatItem[]>([])
  const [beatsError, setBeatsError] = useState<string | null>(null)
  const [beatBusy, setBeatBusy] = useState<number | null>(null)
  const [openMenu, setOpenMenu] = useState<number | null>(null)
  const [activeBeat, setActiveBeat] = useState<number | null>(null)
  const seekRef = useRef<{ seekTo: (frame: number) => void } | null>(null)

  // Load project
  useEffect(() => {
    loadProject()
    const interval = setInterval(loadProject, 2000)
    return () => clearInterval(interval)
  }, [])

  // Auto-trigger the complete v0.1 processing pipeline.
  useEffect(() => {
    if (!project || pipelineInFlight.current === project.status) return

    if (project.status === 'created') {
      pipelineInFlight.current = project.status
      triggerNormalization().finally(() => {
        pipelineInFlight.current = null
      })
    } else if (project.status === 'transcribing') {
      pipelineInFlight.current = project.status
      triggerTranscription().finally(() => {
        pipelineInFlight.current = null
      })
    } else if (project.status === 'analyzing') {
      pipelineInFlight.current = project.status
      triggerAnalysis().finally(() => {
        pipelineInFlight.current = null
      })
    }
  }, [project?.status])

  async function loadProject() {
    try {
      const response = await fetch(`/api/process/status/${projectId}`)
      if (!response.ok) {
        throw new Error('Failed to load project')
      }
      const data = await response.json()
      setProject(data)
      setError(null)
    } catch (err) {
      console.error('Load error:', err)
      setError(err instanceof Error ? err.message : 'Failed to load project')
    } finally {
      setLoading(false)
    }
  }

  async function triggerNormalization() {
    try {
      const response = await fetch('/api/process/normalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId })
      })
      if (!response.ok) {
        throw new Error('Failed to normalize')
      }
      await new Promise((r) => setTimeout(r, 1000))
      await loadProject()
    } catch (err) {
      console.error('Normalize error:', err)
    }
  }

  async function triggerTranscription() {
    try {
      const response = await fetch('/api/process/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId })
      })
      if (!response.ok) {
        throw new Error('Failed to transcribe')
      }
      await new Promise((r) => setTimeout(r, 1000))
      await loadProject()
    } catch (err) {
      console.error('Transcribe error:', err)
    }
  }

  async function triggerAnalysis() {
    try {
      const response = await fetch('/api/process/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId })
      })
      if (!response.ok) {
        throw new Error('Failed to analyze')
      }
      await new Promise((r) => setTimeout(r, 1000))
      await loadProject()
    } catch (err) {
      console.error('Analyze error:', err)
    }
  }

  async function handleRender() {
    try {
      setIsRendering(true)
      const response = await fetch('/api/process/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId })
      })
      if (!response.ok) {
        throw new Error('Failed to start render')
      }
      await new Promise((r) => setTimeout(r, 1000))
      await loadProject()
    } catch (err) {
      console.error('Render error:', err)
    } finally {
      setIsRendering(false)
    }
  }

  async function handleDirectProject() {
    if (!refineInput.trim()) return

    setRefineError(null)
    try {
      setIsRefining(true)
      const response = await fetch('/api/projects/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          instruction: refineInput,
          sceneId: selectedScene?.id
        })
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Falha ao aplicar a instrução')
      }
      setDirectorResult({
        summary: data.summary || 'Instrução processada.',
        applied: Array.isArray(data.applied) ? data.applied : [],
        skipped: Array.isArray(data.skipped) ? data.skipped : []
      })
      setRefineInput('')
      setSelectedScene(null)
      await loadProject()
    } catch (err) {
      setDirectorResult(null)
      setRefineError(err instanceof Error ? err.message : 'Falha ao aplicar a instrução')
    } finally {
      setIsRefining(false)
    }
  }

  async function handleUndoRefine() {
    setRefineError(null)
    try {
      setIsUndoing(true)
      const response = await fetch('/api/projects/refine/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId })
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Falha ao desfazer')
      }
      setDirectorResult(null)
      setSelectedScene(null)
      await loadProject()
    } catch (err) {
      setRefineError(err instanceof Error ? err.message : 'Falha ao desfazer')
    } finally {
      setIsUndoing(false)
    }
  }

  // Load beats once the pipeline reaches an editable state (and after edits).
  useEffect(() => {
    if (project && (project.status === 'ready' || project.status === 'complete')) {
      fetchBeats()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.status])

  async function fetchBeats() {
    try {
      const response = await fetch(`/api/projects/${projectId}/beats`)
      if (!response.ok) return
      const data = await response.json()
      if (Array.isArray(data.beats)) {
        setBeats(data.beats)
      }
    } catch (err) {
      console.error('Fetch beats error:', err)
    }
  }

  function handleBeatClick(beat: BeatItem) {
    setActiveBeat(beat.index)
    seekRef.current?.seekTo(beat.startFrame)
  }

  async function handleBeatAction(
    action: 'set' | 'remove' | 'extend' | 'shrink',
    beatIndex: number,
    sceneType?: string
  ) {
    setBeatsError(null)
    setOpenMenu(null)
    setBeatBusy(beatIndex)
    try {
      const response = await fetch(`/api/projects/${projectId}/beats/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, beatIndex, sceneType })
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Falha ao ajustar a batida')
      }
      if (Array.isArray(data.beats)) {
        setBeats(data.beats)
      }
      await loadProject()
      await fetchBeats()
    } catch (err) {
      setBeatsError(err instanceof Error ? err.message : 'Falha ao ajustar a batida')
    } finally {
      setBeatBusy(null)
    }
  }

  async function handleReopenForReview() {
    setRedoError(null)
    const confirmed = window.confirm(
      'Voltar para a etapa de revisão? O MP4 renderizado continua disponível até você renderizar de novo.'
    )
    if (!confirmed) return

    setRedoBusy('reopen')
    try {
      const response = await fetch(`/api/projects/${projectId}/reopen`, { method: 'POST' })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Falha ao voltar para revisão')
      }
      await loadProject()
    } catch (err) {
      setRedoError(err instanceof Error ? err.message : 'Falha ao voltar para revisão')
    } finally {
      setRedoBusy(null)
      setRedoMenuOpen(false)
    }
  }

  async function handleRedoAnalysis() {
    setRedoError(null)
    const confirmed = window.confirm(
      '⚠ A IA vai gerar um NOVO rascunho de cenas — suas edições manuais de batidas/cenas atuais serão PERDIDAS. Continuar?'
    )
    if (!confirmed) return

    setRedoBusy('analyze')
    try {
      const response = await fetch('/api/process/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId })
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Falha ao refazer a análise')
      }
      await loadProject()
    } catch (err) {
      setRedoError(err instanceof Error ? err.message : 'Falha ao refazer a análise')
    } finally {
      setRedoBusy(null)
      setRedoMenuOpen(false)
    }
  }

  async function handleRedoTranscription() {
    setRedoError(null)
    const confirmed = window.confirm(
      '⚠ Refaz legendas E análise do zero (usa Whisper de novo, ~2-5 min). Edições manuais serão perdidas. Continuar?'
    )
    if (!confirmed) return

    setRedoBusy('transcribe')
    try {
      const response = await fetch('/api/process/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, force: true })
      })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Falha ao refazer a transcrição')
      }
      await loadProject()
    } catch (err) {
      setRedoError(err instanceof Error ? err.message : 'Falha ao refazer a transcrição')
    } finally {
      setRedoBusy(null)
      setRedoMenuOpen(false)
    }
  }

  async function handleDeleteProject() {
    if (!project) return

    const confirmed = window.confirm(
      `Excluir o projeto "${project.name}"? Todos os arquivos de vídeo e mídia associados serão apagados permanentemente. Esta ação não pode ser desfeita.`
    )
    if (!confirmed) return

    setDeleteError(null)
    try {
      setIsDeleting(true)
      const response = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' })
      const data = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(data?.error || 'Falha ao excluir o projeto')
      }
      router.push('/')
    } catch (err) {
      console.error('Delete project failed:', err)
      setDeleteError(err instanceof Error ? err.message : 'Falha ao excluir o projeto')
    } finally {
      setIsDeleting(false)
    }
  }

  function getPipelineProgress() {
    const statusIndex = PIPELINE_STEPS.findIndex((s) => s.status === project?.status)
    if (project?.status === 'complete') return PIPELINE_STEPS.length
    return statusIndex >= 0 ? statusIndex + 1 : 0
  }

  function getSceneTypeIcon(type: string) {
    const icons: Record<string, string> = {
      FullScreen: '🎬',
      LowerThird: '📝',
      Split: '✂️',
      SplitVertical: '⬌',
      Card: '🃏',
      Message: '💬',
      Number: '🔢',
      Flow: '➡️',
      CTA: '🎯',
      StickFigures: '👥',
      ImageInsert: 'IMG'
    }
    return icons[type] || '📹'
  }

  function formatRoleLabel(value: unknown): string {
    if (typeof value !== 'string' || !value) {
      return ''
    }

    return value
      .split('-')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-[#050508] to-zinc-900 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-amber-400 mb-4"></div>
          <p className="text-zinc-400">Loading project...</p>
        </div>
      </div>
    )
  }

  if (error || !project) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-[#050508] to-zinc-900">
        <div className="max-w-4xl mx-auto px-6 py-12">
          <button
            onClick={() => router.push('/')}
            className="mb-8 px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-colors"
          >
            Back to Dashboard
          </button>
          <div className="p-8 rounded-xl bg-red-500/10 border border-red-500/50 text-center">
            <p className="text-red-400 font-semibold">{error || 'Project not found'}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#050508] to-zinc-900">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-black/40 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push('/')}
              className="p-2 rounded-lg hover:bg-zinc-800 transition-colors"
            >
              <svg
                className="w-6 h-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
            <h1 className="text-2xl font-bold">{project.name}</h1>
            <span className="text-sm text-zinc-500 px-3 py-1 rounded-full bg-zinc-800">
              {project.format}
            </span>
            {project.engineKind && (
              <span className="text-sm text-amber-300 px-3 py-1 rounded-full bg-amber-400/10 border border-amber-400/30">
                {project.engineKind === 'narrative' ? 'Narrative Engine' : 'Visual Engine'}
              </span>
            )}
            {project.stylePreset && (
              <span className="text-sm text-zinc-300 px-3 py-1 rounded-full bg-zinc-800 border border-zinc-700">
                {project.stylePreset}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            {(project.status === 'ready' ||
              project.status === 'complete' ||
              project.status === 'error') && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setRedoMenuOpen((open) => !open)}
                  disabled={redoBusy !== null}
                  className="text-xs text-zinc-500 hover:text-amber-400 transition-colors disabled:opacity-50"
                >
                  {redoBusy ? 'Processando...' : '↩ Refazer etapa'}
                </button>

                {redoMenuOpen && (
                  <div className="absolute right-0 top-7 z-20 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl py-1">
                    <button
                      type="button"
                      onClick={handleReopenForReview}
                      disabled={
                        redoBusy !== null ||
                        (project.status !== 'complete' && project.status !== 'error')
                      }
                      className="w-full text-left px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <span className="block font-medium">Voltar para revisão</span>
                      <span className="block text-[10px] text-zinc-500 mt-0.5">
                        Volta para a etapa de edição, mantendo o último MP4 renderizado
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRedoAnalysis}
                      disabled={redoBusy !== null}
                      className="w-full text-left px-3 py-2 text-xs text-amber-300 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <span className="block font-medium">Refazer análise (IA recria as cenas)</span>
                      <span className="block text-[10px] text-zinc-500 mt-0.5">
                        Gera um novo rascunho de cenas — perde edições manuais de batidas
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={handleRedoTranscription}
                      disabled={redoBusy !== null}
                      className="w-full text-left px-3 py-2 text-xs text-red-300 hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <span className="block font-medium">Refazer transcrição (legendas do zero)</span>
                      <span className="block text-[10px] text-zinc-500 mt-0.5">
                        Refaz legendas e análise do zero (~2-5 min) — perde edições manuais
                      </span>
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={handleDeleteProject}
              disabled={isDeleting}
              className="text-xs text-zinc-500 hover:text-red-400 transition-colors disabled:opacity-50"
            >
              {isDeleting ? 'Excluindo...' : '🗑 Excluir projeto'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {redoError && (
          <div className="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/50 text-sm text-red-400">
            {redoError}
          </div>
        )}

        {deleteError && (
          <div className="mb-6 p-4 rounded-lg bg-red-500/10 border border-red-500/50 text-sm text-red-400">
            {deleteError}
          </div>
        )}

        {/* Pipeline Progress */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-zinc-400">Processing Pipeline</h2>
            <span className="text-xs text-zinc-500">
              Step {getPipelineProgress()} of {PIPELINE_STEPS.length}
            </span>
          </div>

          <div className="flex gap-2">
            {PIPELINE_STEPS.map((step, index) => {
              const isComplete =
                project.status === 'complete' ||
                PIPELINE_STEPS.findIndex((s) => s.status === project.status) >= index
              const isCurrent = project.status === step.status

              return (
                <div key={step.status} className="flex-1">
                  <button
                    onClick={() => {
                      if (project.status === 'created' && step.status === 'normalizing') {
                        triggerNormalization()
                      } else if (project.status === 'normalizing' && step.status === 'transcribing') {
                        triggerTranscription()
                      } else if (project.status === 'transcribing' && step.status === 'analyzing') {
                        triggerAnalysis()
                      }
                    }}
                    disabled={!isComplete && !isCurrent}
                    className={`w-full py-3 px-2 rounded-lg text-sm font-medium transition-all ${
                      isComplete
                        ? 'bg-amber-400/20 text-amber-400 border border-amber-400/50'
                        : isCurrent
                          ? 'bg-blue-500/20 text-blue-400 border border-blue-500/50 animate-pulse'
                          : 'bg-zinc-800/50 text-zinc-600 border border-zinc-700'
                    }`}
                  >
                    {isCurrent && <span className="inline-block mr-1">⏳</span>}
                    {isComplete && !isCurrent && <span className="inline-block mr-1">✓</span>}
                    {step.name}
                  </button>
                  {index < PIPELINE_STEPS.length - 1 && (
                    <div className="text-xs text-zinc-700 text-center mt-1">→</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {project.status === 'error' && (
          <div className="mb-8 rounded-xl border border-red-500/40 bg-red-500/10 p-6">
            <h2 className="font-bold text-red-300 mb-2">Processing stopped</h2>
            <p className="text-sm text-red-200/80 mb-4">
              {project.error || 'The pipeline failed, but no detailed error was recorded.'}
            </p>
            <button
              onClick={() => {
                if (project.transcription) {
                  triggerAnalysis()
                } else {
                  triggerTranscription()
                }
              }}
              className="px-4 py-2 rounded-lg bg-red-500 hover:bg-red-600 text-white font-semibold transition-colors"
            >
              Retry from failed step
            </button>
          </div>
        )}

        {/* Main Editor Layout */}
        {project.status === 'ready' || project.status === 'rendering' || project.status === 'complete' ? (
          <div className="grid grid-cols-12 gap-6">
            {/* Left: Processed video preview */}
            <div className="col-span-5">
              {project.status === 'complete' && project.renderedVideoPath ? (
                <div className="rounded-xl bg-black/50 border border-zinc-800 overflow-hidden">
                  <video
                    src={`/api/video/${project.id}`}
                    controls
                    className={`w-full bg-black ${project.format === '9:16' ? 'aspect-[9/16]' : 'aspect-video'}`}
                  />
                </div>
              ) : (
                <div className="rounded-xl bg-black/50 border border-zinc-800 overflow-hidden">
                  <RemotionProjectPlayer
                    projectId={project.id}
                    format={project.format}
                    fps={project.videoFps || 30}
                    durationFrames={
                      project.editPlan?.durationFrames ||
                      Math.ceil((project.videoDuration || 1) * (project.videoFps || 30))
                    }
                    scenes={project.scenes || []}
                    subtitles={project.subtitles || []}
                    transcription={project.transcription}
                    stylePreset={project.stylePreset || 'creator-clean'}
                    palette={
                      project.palette || {
                        primary: '#FFB800',
                        secondary: '#20202A',
                        accent: '#FF6B35',
                        background: '#050508',
                        text: '#FFFFFF'
                      }
                    }
                    editPlan={project.editPlan}
                    musicPick={project.musicPick}
                    seekRef={seekRef}
                  />
                </div>
              )}

              <div className="mt-4 grid grid-cols-3 gap-3">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                  <p className="text-xs text-zinc-500">Duration</p>
                  <p className="font-semibold">{Math.round(project.videoDuration || 0)}s</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                  <p className="text-xs text-zinc-500">Auto cuts</p>
                  <p className="font-semibold">{project.silences?.length || 0}</p>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                  <p className="text-xs text-zinc-500">Subtitles</p>
                  <p className="font-semibold">{project.subtitles?.length || 0}</p>
                </div>
              </div>
              {project.editPlan && (
                <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                  <p className="text-xs text-zinc-500">Timeline</p>
                  <p className="font-semibold">
                    {project.editPlan.durationFrames} frames - {project.editPlan.overlays.length} overlays
                  </p>
                  {project.editPlan.lineage?.units?.length ? (
                    <p className="mt-1 text-xs text-zinc-500">
                      {project.editPlan.lineage.units.length} lineage units
                    </p>
                  ) : null}
                </div>
              )}
            </div>

            {/* Right: Painel de Batidas */}
            <div className="col-span-7">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-bold text-lg">Batidas</h3>
                  <span className="text-xs text-zinc-500">{beats.length} batidas</span>
                </div>

                {beatsError && (
                  <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/50 text-sm text-red-400">
                    {beatsError}
                  </div>
                )}

                <div className="max-h-[32rem] overflow-y-auto space-y-2 pr-2">
                  {beats.length > 0 ? (
                    beats.map((beat) => {
                      const isContinuation = Boolean(beat.sceneId) && !beat.isSpanStart
                      const busy = beatBusy === beat.index
                      const spanSize = beat.sceneSpan
                        ? beat.sceneSpan.to - beat.sceneSpan.from + 1
                        : 0

                      return (
                        <div
                          key={beat.index}
                          className={`relative rounded-lg border transition-all ${
                            activeBeat === beat.index
                              ? 'border-amber-400 bg-amber-400/10'
                              : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'
                          } ${isContinuation ? 'border-l-2 border-l-amber-500/60 ml-3' : ''}`}
                        >
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => handleBeatClick(beat)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                handleBeatClick(beat)
                              }
                            }}
                            className="flex items-start gap-3 p-2.5 cursor-pointer"
                          >
                            {/* Thumbnail */}
                            <div className="shrink-0 w-[72px] h-[40px] rounded bg-black/60 overflow-hidden border border-zinc-800 flex items-center justify-center">
                              {beat.thumbUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={beat.thumbUrl}
                                  alt={`batida ${beat.index + 1}`}
                                  className="w-full h-full object-cover"
                                />
                              ) : (
                                <span className="text-[10px] text-zinc-600">sem thumb</span>
                              )}
                            </div>

                            {/* Content */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-[11px] font-mono text-zinc-500">
                                  #{beat.index + 1}
                                </span>
                                {isContinuation ? (
                                  <span className="text-[10px] text-amber-400/80">↳ continuação</span>
                                ) : beat.sceneType ? (
                                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                                    <span>{getSceneTypeIcon(beat.sceneType)}</span>
                                    <span>{beat.sceneType}</span>
                                    {spanSize > 1 && (
                                      <span className="text-amber-400/70">×{spanSize}</span>
                                    )}
                                  </span>
                                ) : (
                                  <span className="text-[11px] text-zinc-600">∅ sem cena</span>
                                )}
                              </div>
                              <p className="text-xs text-zinc-300 line-clamp-2">{beat.text}</p>
                            </div>

                            {/* Menu button */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation()
                                setOpenMenu(openMenu === beat.index ? null : beat.index)
                              }}
                              disabled={busy}
                              className="shrink-0 p-1.5 rounded hover:bg-zinc-700/60 text-zinc-400 disabled:opacity-40"
                            >
                              {busy ? (
                                <span className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-amber-400" />
                              ) : (
                                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                                  <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
                                </svg>
                              )}
                            </button>
                          </div>

                          {/* Extend / shrink controls (only on the span start) */}
                          {beat.isSpanStart && beat.sceneId && (
                            <div className="flex items-center gap-2 px-2.5 pb-2.5">
                              <button
                                type="button"
                                onClick={() => handleBeatAction('shrink', beat.index)}
                                disabled={busy || spanSize <= 1}
                                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] disabled:opacity-40"
                              >
                                −1 batida
                              </button>
                              <button
                                type="button"
                                onClick={() => handleBeatAction('extend', beat.index)}
                                disabled={busy || spanSize >= 8}
                                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-[11px] disabled:opacity-40"
                              >
                                +1 batida
                              </button>
                              <span className="text-[10px] text-zinc-600">
                                {spanSize} batida{spanSize > 1 ? 's' : ''}
                              </span>
                            </div>
                          )}

                          {/* Dropdown de modelo */}
                          {openMenu === beat.index && (
                            <div className="absolute right-2 top-11 z-20 w-48 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl py-1">
                              {beat.sceneId && (
                                <button
                                  type="button"
                                  onClick={() => handleBeatAction('remove', beat.index)}
                                  className="w-full text-left px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
                                >
                                  ∅ Remover cena
                                </button>
                              )}
                              {BEAT_SCENE_TYPES.map((type) => (
                                <button
                                  key={type}
                                  type="button"
                                  onClick={() => handleBeatAction('set', beat.index, type)}
                                  className="w-full flex items-center gap-2 text-left px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                                >
                                  <span>{getSceneTypeIcon(type)}</span>
                                  <span>{type}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })
                  ) : (
                    <div className="text-center py-8 text-zinc-500">
                      <p>Carregando batidas...</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Director com IA — escopo de projeto (vídeo todo, cena, trecho ou paleta) */}
        {(project.status === 'ready' || project.status === 'complete') && (
          <div className="mt-8 p-6 rounded-xl bg-zinc-900/50 border border-amber-400/20">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold text-amber-400">Editar com IA</h3>
              {selectedScene ? (
                <span className="text-xs text-amber-300/90 px-3 py-1 rounded-full bg-amber-400/10 border border-amber-400/30">
                  Escopo sugerido: cena {project.scenes.findIndex((s) => s.id === selectedScene.id) + 1}
                  <button
                    type="button"
                    onClick={() => setSelectedScene(null)}
                    className="ml-2 text-amber-300/70 hover:text-amber-200"
                  >
                    limpar
                  </button>
                </span>
              ) : (
                <span className="text-xs text-zinc-500">Escopo: vídeo todo</span>
              )}
            </div>
            <p className="text-xs text-zinc-500 mb-4">
              Descreva a mudança em pt-BR. Pode mirar o vídeo todo, uma cena, um trecho da fala ou as cores
              (ex.: &quot;alterar a cor de laranja para dourado nos inserts, no vídeo todo&quot;).
            </p>
            <div className="flex gap-3">
              <input
                type="text"
                value={refineInput}
                onChange={(e) => setRefineInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isRefining && refineInput.trim()) {
                    handleDirectProject()
                  }
                }}
                placeholder="Descreva a mudança que você quer..."
                disabled={isRefining}
                className="flex-1 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700 focus:border-amber-400 outline-none transition-colors disabled:opacity-50"
              />
              <button
                onClick={handleDirectProject}
                disabled={isRefining || !refineInput.trim()}
                className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium flex items-center gap-2"
              >
                {isRefining && (
                  <span className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-black" />
                )}
                {isRefining ? 'Aplicando...' : 'Aplicar'}
              </button>
            </div>

            {refineError && (
              <div className="mt-4 p-4 rounded-lg bg-red-500/10 border border-red-500/50">
                <p className="text-sm font-semibold text-red-400">Erro ao aplicar</p>
                <p className="text-sm text-red-300/90 mt-1">{refineError}</p>
              </div>
            )}

            {directorResult && !refineError && (
              <div className="mt-4 p-4 rounded-lg bg-emerald-500/5 border border-emerald-500/30">
                <p className="text-sm text-zinc-200">{directorResult.summary}</p>
                {directorResult.applied.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {directorResult.applied.map((item, i) => (
                      <li key={`ap-${i}`} className="text-xs text-emerald-300 flex gap-2">
                        <span>✓</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {directorResult.applied.length === 0 && (
                  <p className="mt-2 text-xs text-amber-300/90">Nenhuma alteração foi aplicada.</p>
                )}
                {directorResult.skipped.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {directorResult.skipped.map((item, i) => (
                      <li key={`sk-${i}`} className="text-xs text-zinc-500 flex gap-2">
                        <span>—</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {project.hasRefineSnapshot && (
              <div className="mt-4">
                <button
                  onClick={handleUndoRefine}
                  disabled={isUndoing || isRefining}
                  className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isUndoing ? 'Desfazendo...' : 'Desfazer última edição'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Render Button */}
        {project.status === 'ready' && (
          <div className="mt-8 flex justify-center">
            <button
              onClick={handleRender}
              disabled={isRendering}
              className="px-8 py-4 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 hover:from-amber-500 hover:to-orange-600 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold text-lg transition-all"
            >
              {isRendering ? 'Starting Render...' : 'Renderizar'}
            </button>
          </div>
        )}

        {project.status === 'rendering' && (
          <div className="mt-8 p-6 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-center">
            <p className="text-emerald-300 font-semibold">Rendering...</p>
            <p className="text-sm text-emerald-300/70 mt-2">
              Progress: {Math.round(project.renderJob?.progress || 0)}%
            </p>
          </div>
        )}

        {/* Complete State */}
        {project.status === 'complete' && (
          <div className="mt-8 p-8 rounded-xl bg-emerald-500/10 border border-emerald-500/50 text-center">
            <h2 className="text-2xl font-bold text-emerald-400 mb-2">Render Complete!</h2>
            <p className="text-emerald-400/80 mb-4">Your video is ready to download</p>
            <a
              href={`/api/video/${project.id}`}
              download={`${project.name}.mp4`}
              className="inline-block px-6 py-3 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white font-bold transition-colors"
            >
              Download Video
            </a>
          </div>
        )}
      </main>
    </div>
  )
}
