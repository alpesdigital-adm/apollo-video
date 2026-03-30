'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import type { Scene } from '@/lib/types/scene'
import type { SubtitleEntry } from '@/lib/types/project'
import type { ProjectStatus } from '@/lib/types/project'

interface ProjectData {
  id: string
  name: string
  status: ProjectStatus
  format: '9:16' | '16:9'
  videoDuration: number
  scenes: Scene[]
  subtitles: SubtitleEntry[]
  palette: any
  transcriptionJson: any
}

const PIPELINE_STEPS = [
  { name: 'Uploaded', status: 'created' },
  { name: 'Normalize', status: 'normalizing' },
  { name: 'Transcribe', status: 'transcribing' },
  { name: 'Analyze', status: 'analyzing' },
  { name: 'Ready', status: 'ready' },
  { name: 'Render', status: 'rendering' }
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

  // Load project
  useEffect(() => {
    loadProject()
    const interval = setInterval(loadProject, 2000)
    return () => clearInterval(interval)
  }, [])

  // Auto-trigger normalization when project created
  useEffect(() => {
    if (project && project.status === 'created') {
      triggerNormalization()
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

  async function handleRefineScene() {
    if (!selectedScene || !refineInput.trim()) return

    try {
      setIsRefining(true)
      const response = await fetch('/api/scenes/refine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          sceneId: selectedScene.id,
          instruction: refineInput
        })
      })
      if (!response.ok) {
        throw new Error('Failed to refine scene')
      }
      const data = await response.json()
      setSelectedScene(data.scene)
      setRefineInput('')
      await loadProject()
    } catch (err) {
      console.error('Refine error:', err)
    } finally {
      setIsRefining(false)
    }
  }

  function getPipelineProgress() {
    const statusIndex = PIPELINE_STEPS.findIndex((s) => s.status === project?.status)
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
      StickFigures: '👥'
    }
    return icons[type] || '📹'
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
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
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

        {/* Main Editor Layout */}
        {project.status === 'ready' || project.status === 'rendering' || project.status === 'complete' ? (
          <div className="grid grid-cols-12 gap-6">
            {/* Left: Preview (placeholder) */}
            <div className="col-span-5">
              <div className="rounded-xl bg-black/50 border border-zinc-800 aspect-video flex items-center justify-center overflow-hidden">
                <div className="text-center">
                  <p className="text-zinc-500 mb-2">Preview</p>
                  <p className="text-xs text-zinc-600">Remotion Player would load here</p>
                </div>
              </div>
            </div>

            {/* Right: Scene Editor */}
            <div className="col-span-7">
              <div className="space-y-4">
                <h3 className="font-bold text-lg">Scenes</h3>

                <div className="max-h-96 overflow-y-auto space-y-3 pr-4">
                  {project.scenes && project.scenes.length > 0 ? (
                    project.scenes.map((scene) => (
                      <button
                        key={scene.id}
                        onClick={() => setSelectedScene(scene)}
                        className={`w-full text-left p-4 rounded-lg border transition-all ${
                          selectedScene?.id === scene.id
                            ? 'bg-amber-400/10 border-amber-400'
                            : 'bg-zinc-900/50 border-zinc-800 hover:border-zinc-700'
                        }`}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              <span className="text-lg">{getSceneTypeIcon(scene.type)}</span>
                              <span className="font-semibold text-sm">{scene.type}</span>
                            </div>
                            <p className="text-xs text-zinc-400 line-clamp-2">
                              {(scene as any).text ||
                                (scene as any).title ||
                                (scene as any).message ||
                                'Scene content'}
                            </p>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              const newScenes = project.scenes.filter(
                                (s) => s.id !== scene.id
                              )
                              setProject({ ...project, scenes: newScenes })
                            }}
                            className="p-1 rounded hover:bg-red-500/20 text-red-400"
                          >
                            <svg
                              className="w-4 h-4"
                              fill="currentColor"
                              viewBox="0 0 20 20"
                            >
                              <path
                                fillRule="evenodd"
                                d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                                clipRule="evenodd"
                              />
                            </svg>
                          </button>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="text-center py-8 text-zinc-500">
                      <p>No scenes yet</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Refine UI (shown when scene selected) */}
        {selectedScene && (project.status === 'ready' || project.status === 'complete') && (
          <div className="mt-8 p-6 rounded-xl bg-zinc-900/50 border border-amber-400/20">
            <h3 className="font-bold mb-4 text-amber-400">Refine with AI</h3>
            <div className="flex gap-3">
              <input
                type="text"
                value={refineInput}
                onChange={(e) => setRefineInput(e.target.value)}
                placeholder="Describe changes you want to make..."
                className="flex-1 px-4 py-2 rounded-lg bg-zinc-800 border border-zinc-700 focus:border-amber-400 outline-none transition-colors"
              />
              <button
                onClick={handleRefineScene}
                disabled={isRefining || !refineInput.trim()}
                className="px-4 py-2 rounded-lg bg-amber-500 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-medium"
              >
                {isRefining ? 'Refining...' : 'Refine'}
              </button>
            </div>
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
