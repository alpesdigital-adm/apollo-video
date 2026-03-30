'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { VideoFormat, ProjectStatus } from '@/lib/types/project'

interface Project {
  id: string
  name: string
  format: VideoFormat
  status: ProjectStatus
  createdAt: string
  updatedAt: string
}

export default function Dashboard() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  // Load recent projects
  useEffect(() => {
    loadProjects()
  }, [])

  async function loadProjects() {
    try {
      setLoading(true)
      const response = await fetch('/api/projects')
      if (response.ok) {
        const data = await response.json()
        setProjects(data.projects || [])
      }
    } catch (error) {
      console.error('Failed to load projects:', error)
    } finally {
      setLoading(false)
    }
  }

  async function handleUpload(file: File) {
    if (!file.type.startsWith('video/')) {
      alert('Please upload a video file')
      return
    }

    try {
      setUploading(true)
      const formData = new FormData()
      formData.append('file', file)

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error)
      }

      const data = await response.json()
      router.push(`/project/${data.projectId}`)
    } catch (error) {
      console.error('Upload failed:', error)
      alert(`Upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setUploading(false)
    }
  }

  function handleDrag(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleUpload(e.dataTransfer.files[0])
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files[0]) {
      handleUpload(e.target.files[0])
    }
  }

  function getStatusBadge(status: ProjectStatus) {
    const statusMap: Record<ProjectStatus, { bg: string; text: string; label: string }> = {
      created: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Created' },
      uploading: { bg: 'bg-blue-500/10', text: 'text-blue-400', label: 'Uploading' },
      normalizing: { bg: 'bg-yellow-500/10', text: 'text-yellow-400', label: 'Normalizing' },
      transcribing: { bg: 'bg-purple-500/10', text: 'text-purple-400', label: 'Transcribing' },
      analyzing: { bg: 'bg-cyan-500/10', text: 'text-cyan-400', label: 'Analyzing' },
      ready: { bg: 'bg-orange-500/10', text: 'text-orange-400', label: 'Ready' },
      rendering: { bg: 'bg-green-500/10', text: 'text-green-400', label: 'Rendering' },
      complete: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', label: 'Complete' },
      error: { bg: 'bg-red-500/10', text: 'text-red-400', label: 'Error' }
    }

    const status = statusMap[status]
    return (
      <span className={`px-2 py-1 rounded text-xs font-medium ${status.bg} ${status.text}`}>
        {status.label}
      </span>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#050508] to-zinc-900">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-black/40 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 py-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center">
              <svg
                className="w-6 h-6 text-white"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path d="M2 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6zM4 9h12m-6 4v2m-4-2v2m8-2v2" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold">
              Video Editor <span className="text-amber-400">IA</span>
            </h1>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-6 py-12">
        {/* Upload Zone */}
        <div className="mb-12">
          <label
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            className={`block p-12 rounded-2xl border-2 border-dashed transition-all cursor-pointer ${
              dragActive
                ? 'border-amber-400 bg-amber-400/5'
                : 'border-zinc-700 hover:border-amber-400/50 bg-zinc-900/30 hover:bg-zinc-900/50'
            }`}
          >
            <input
              type="file"
              accept="video/*"
              onChange={handleFileInput}
              disabled={uploading}
              className="hidden"
            />
            <div className="text-center">
              <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-amber-400/20 to-orange-500/20 mb-4">
                <svg
                  className="w-8 h-8 text-amber-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                  />
                </svg>
              </div>
              <h2 className="text-2xl font-bold mb-2">Upload your video</h2>
              <p className="text-zinc-400 mb-2">
                Drag and drop your video here or click to select
              </p>
              <p className="text-sm text-zinc-500">
                Supports MP4, MOV, AVI and other common video formats
              </p>
              {uploading && <p className="text-amber-400 mt-4">Uploading...</p>}
            </div>
          </label>
        </div>

        {/* Projects List */}
        <div>
          <h2 className="text-2xl font-bold mb-6">Recent Projects</h2>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[...Array(6)].map((_, i) => (
                <div
                  key={i}
                  className="h-32 rounded-xl bg-zinc-800/50 animate-pulse"
                />
              ))}
            </div>
          ) : projects.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => router.push(`/project/${project.id}`)}
                  className="group text-left p-6 rounded-xl bg-zinc-900/50 border border-zinc-800 hover:border-amber-400/50 transition-all hover:bg-zinc-900/80"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex-1">
                      <h3 className="font-bold text-lg truncate group-hover:text-amber-400 transition-colors">
                        {project.name}
                      </h3>
                      <p className="text-sm text-zinc-500 mt-1">
                        {new Date(project.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <span className="ml-2 text-xs font-mono px-2 py-1 rounded bg-zinc-800">
                      {project.format}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    {getStatusBadge(project.status)}
                    <svg
                      className="w-5 h-5 text-amber-400 opacity-0 group-hover:opacity-100 transition-opacity"
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path
                        fillRule="evenodd"
                        d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <p className="text-zinc-400 mb-4">No projects yet</p>
              <p className="text-sm text-zinc-500">Upload a video to get started</p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
