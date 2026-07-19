'use client'

import { sha256 } from '@noble/hashes/sha256'
import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import LogoutButton from '@/components/LogoutButton'

interface ApiEnvelope<T> { data?: T; error?: { message?: string } }
interface MediaRecord {
  id: string; role: 'source-master' | 'editing-proxy' | 'editorial-proxy' | 'final-output'; originalFileName: string; artifactId: string;
  manifestId: string; mediaType: string; container: string; byteSize: string; sha256: string; status: string;
  rightsStatus?: string; probe?: { width: number; height: number; duration: number; fps: number }; createdAt: string
}
interface TranscriptSummary {
  id: string; sourceArtifactId: string; language: string; provider: string; model: string; transcriptHash: string;
  text: string; wordCount: number; segmentCount: number; createdAt: string
}
interface PublicOperation {
  id: string; type: 'artifact-render' | 'media-ingest' | 'project-proxy-render' | 'project-final-export'; status: string; phase: string;
  progress?: { completed: number; total?: number; unit?: string }; error?: { message?: string }; updatedAt: string
}
interface DirectorRunSummary {
  id: string; status: 'planned' | 'rendering' | 'succeeded' | 'failed'; plannerVersion: string; criticVersion: string;
  baseVersionId: string; resultVersionId: string; treatmentSnapshotId: string; storySnapshotId: string; qualitySnapshotId: string;
  qualityStatus: 'approved' | 'approved-with-warnings' | 'blocked'; qualityScore: number; decisionCount: number; assumptionCount: number;
  subtitleCueCount: number; transitionCount: number; automaticZoom: boolean; createdAt: string
}
interface WorkspaceData {
  project: { id: string; name: string; status: string; objective?: string; format?: string; locale?: string; createdAt: string }
  version?: { id: string; sequence: number; baseHash: string; createdAt: string }
  brief?: Record<string, unknown>
  editPlan?: { id: string; state: string; fps: number; durationFrames: number; clipCount: number; cutCount: number; automaticZoom: boolean; subtitleFaceProtection: boolean }
  commands: { id: string; type: string; baseVersionId: string; resultVersionId?: string; reason?: string; createdAt: string }[]
  directorRuns: DirectorRunSummary[]
  media: MediaRecord[]
  transcripts: TranscriptSummary[]
  operationIds: string[]
  operations: PublicOperation[]
}
interface ReviewSessionData {
  currentProjectVersionId: string; projectVersionId: string; proxyArtifactId: string; proxyUrl: string; proxyHash: string; fps: number;
  resolution: { width: number; height: number }; durationFrames: number; stale: boolean
}
type ReviewApplicationScopeKind = 'frame' | 'region' | 'clip' | 'scene' | 'range' | 'project' | 'formats' | 'locales' | 'recipes'
interface ReviewVersionData { id: string; sequence: number; createdAt: string; current: boolean; previewAvailable: boolean }
interface ReviewScopeContextData {
  formatId: string; localeId: string; recipeIds: string[];
  options: { kind: ReviewApplicationScopeKind; affectedCount: number; enabled: boolean }[]
}
interface ReviewSceneData { id: string; label: string; startFrame: number; endFrame: number }
interface ReviewAnnotationData {
  id: string; projectVersionId: string; proxyArtifactId: string; proxyHash: string; frame: number;
  timeRangeMs: [number, number]; screenshotRef: string; scope: 'point' | 'region' | 'scene';
  region?: { x: number; y: number; width: number; height: number }; targetIds: string[]; text: string;
  applicationScope: { kind: ReviewApplicationScopeKind; targetIds: string[]; formatIds: string[]; localeIds: string[]; recipeIds: string[]; global: boolean };
  affectedCount: number;
  author: { id: string; name: string; type: 'user' | 'api-client' }; status: 'open' | 'applied' | 'dismissed'; createdAt: string
}
interface ProjectReviewData { session: ReviewSessionData; versions: ReviewVersionData[]; scopeContext: ReviewScopeContextData; scenes: ReviewSceneData[]; annotations: ReviewAnnotationData[] }
type ReviewMode = 'idle' | 'marking' | 'composing'
interface UploadSession {
  mode: 'single' | 'multipart'; expiresAt: string; maxParts: number;
  requiredHeaders: Record<string, string>; uploadUrl?: string; partSize?: string; partUrlTemplate?: string
}
interface PendingUpload { uploadId: string; file: File; checksum: string }
type UploadPhase = 'idle' | 'hashing' | 'uploading' | 'paused' | 'verifying' | 'processing' | 'done' | 'failed'

const PHASE_LABELS: Record<string, string> = {
  queued: 'Na fila', assembling: 'Consolidando master', probing: 'Lendo mídia', normalizing: 'Criando proxy',
  transcribing: 'Transcrevendo', verifying: 'Validando derivados', persisting: 'Vinculando ao projeto',
  rendering: 'Materializando plano editorial',
  completed: 'Ingestão concluída', retrying: 'Nova tentativa', failed: 'Falha na ingestão', canceled: 'Cancelada',
}

const REVIEW_SCOPE_LABELS: Readonly<Record<ReviewApplicationScopeKind, string>> = Object.freeze({
  frame: 'Somente este frame',
  region: 'Área marcada',
  clip: 'Clipe atual',
  scene: 'Cena atual',
  range: 'Trecho selecionado',
  project: 'Projeto inteiro',
  formats: 'Formatos de saída',
  locales: 'Idiomas',
  recipes: 'Receitas de variação',
})

function readableBytes(value: number | string): string {
  const bytes = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(bytes)) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let amount = bytes
  let index = 0
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1 }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

function apiError<T>(payload: ApiEnvelope<T>, fallback: string): string {
  return payload.error?.message?.trim() || fallback
}

function localSignedUrl(value: string): string {
  const url = new URL(value, window.location.origin)
  if (['localhost', '127.0.0.1'].includes(url.hostname) && ['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    url.protocol = window.location.protocol
    url.host = window.location.host
  }
  return url.toString()
}

function clamp01(value: number): number { return Math.min(1, Math.max(0, value)) }

function frameTimecode(frame: number, fps: number): string {
  if (!Number.isFinite(frame) || !Number.isFinite(fps) || fps <= 0) return '00:00:00:00'
  const roundedFrame = Math.max(0, Math.round(frame))
  const totalSeconds = Math.floor(roundedFrame / fps)
  const frames = roundedFrame % Math.round(fps)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds % 3600 / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds, frames].map((value) => String(value).padStart(2, '0')).join(':')
}

async function hashFile(file: File, signal: AbortSignal, onProgress: (progress: number) => void): Promise<string> {
  const digest = sha256.create()
  const chunkSize = 8 * 1024 * 1024
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    if (signal.aborted) throw new DOMException('Hashing aborted', 'AbortError')
    const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + chunkSize)).arrayBuffer())
    digest.update(bytes)
    onProgress(Math.min(1, (offset + bytes.byteLength) / file.size))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  return Array.from(digest.digest(), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function StepIcon({ state }: { state: 'done' | 'active' | 'waiting' | 'failed' }) {
  if (state === 'done') return <span className="grid h-5 w-5 place-items-center rounded-full bg-[#63ba84]/15 text-[11px] text-[#73cf95]">✓</span>
  if (state === 'failed') return <span className="grid h-5 w-5 place-items-center rounded-full bg-[#d46868]/15 text-[11px] text-[#e27e7e]">!</span>
  return <span className={`h-2.5 w-2.5 rounded-full ${state === 'active' ? 'bg-[#e1af38] shadow-[0_0_12px_rgba(225,175,56,.65)]' : 'bg-[#373630]'}`} />
}

export default function ProjectWorkspacePage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const projectId = params.id
  const fileInput = useRef<HTMLInputElement>(null)
  const previewVideo = useRef<HTMLVideoElement>(null)
  const activeRequest = useRef<AbortController | null>(null)
  const pendingUpload = useRef<PendingUpload | null>(null)
  const reviewPointerStart = useRef<{ x: number; y: number } | null>(null)
  const previewLoadStartedAt = useRef(0)
  const previewSeekStartedAt = useRef(0)
  const previewSeekSamples = useRef<number[]>([])
  const preservedPreviewTimeMs = useRef<number | null>(null)
  const selectedReviewVersionId = useRef<string | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceData | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadLabel, setUploadLabel] = useState('')
  const [directorRunning, setDirectorRunning] = useState(false)
  const [exportRunning, setExportRunning] = useState(false)
  const [previewState, setPreviewState] = useState<'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error'>('idle')
  const [review, setReview] = useState<ProjectReviewData | null>(null)
  const [reviewMode, setReviewMode] = useState<ReviewMode>('idle')
  const [reviewScope, setReviewScope] = useState<'point' | 'region' | 'scene'>('point')
  const [reviewApplicationScope, setReviewApplicationScope] = useState<ReviewApplicationScopeKind>('scene')
  const [reviewGlobal, setReviewGlobal] = useState(false)
  const [reviewGlobalConfirmed, setReviewGlobalConfirmed] = useState(false)
  const [reviewRangeDurationSeconds, setReviewRangeDurationSeconds] = useState(5)
  const [reviewVersionLoading, setReviewVersionLoading] = useState(false)
  const [reviewRegion, setReviewRegion] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [reviewText, setReviewText] = useState('')
  const [reviewSaving, setReviewSaving] = useState(false)
  const [previewFrame, setPreviewFrame] = useState(0)
  const [previewPerformance, setPreviewPerformance] = useState({ firstFrameMs: 0, seekP95Ms: 0, droppedFrameRate: 0 })

  const loadWorkspace = useCallback(async (quiet = false) => {
    try {
      const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/workspace`, { headers: { accept: 'application/json' }, cache: 'no-store' })
      if (response.status === 401) { router.replace('/login'); return }
      const payload = await response.json() as ApiEnvelope<WorkspaceData>
      if (!response.ok || !payload.data) throw new Error(apiError(payload, 'Não foi possível carregar o workspace.'))
      setWorkspace(payload.data)
      const latest = payload.data.operations[0]
      if (latest?.type === 'media-ingest' && latest.status === 'succeeded') {
        const pending = pendingUpload.current
        if (pending) window.localStorage.removeItem(`apollo:v2:upload:${projectId}:${pending.checksum}`)
        pendingUpload.current = null
        setUploadPhase('done'); setUploadProgress(100)
      }
      else if (latest?.type === 'media-ingest' && latest.status === 'failed' && !['hashing', 'uploading', 'verifying'].includes(uploadPhase)) {
        const pending = pendingUpload.current
        if (pending) window.localStorage.removeItem(`apollo:v2:upload:${projectId}:${pending.checksum}`)
        pendingUpload.current = null
        setUploadPhase('failed')
        setUploadLabel('A ingestão falhou. O master pode ser enviado novamente após o ajuste.')
      }
      else if (latest?.type === 'media-ingest' && ['queued', 'running', 'waiting', 'retrying'].includes(latest.status) && !['uploading', 'hashing', 'paused', 'verifying'].includes(uploadPhase)) {
        setUploadPhase('processing')
        const completed = latest.progress?.completed ?? 0
        const total = latest.progress?.total ?? 6
        setUploadProgress(80 + Math.round((completed / total) * 20))
      }
    } catch (error) {
      if (!quiet) setNotice(error instanceof Error ? error.message : 'Não foi possível carregar o workspace.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [projectId, router, uploadPhase])

  useEffect(() => { void loadWorkspace() }, [loadWorkspace])

  const loadReview = useCallback(async (quiet = false, projectVersionId?: string) => {
    try {
      const query = new URLSearchParams({ limit: '50' })
      if (projectVersionId) query.set('projectVersionId', projectVersionId)
      const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/annotations?${query.toString()}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (response.status === 401) { router.replace('/login'); return }
      const payload = await response.json() as ApiEnvelope<ProjectReviewData>
      if (!response.ok || !payload.data) throw new Error(apiError(payload, 'Não foi possível abrir a revisão deste projeto.'))
      selectedReviewVersionId.current = payload.data.session.projectVersionId
      setReview(payload.data)
      return true
    } catch (error) {
      if (!quiet && workspace?.media.length) setNotice(error instanceof Error ? error.message : 'Não foi possível abrir a revisão deste projeto.')
      return false
    }
  }, [projectId, router, workspace?.media.length])

  useEffect(() => {
    if (!workspace?.version || workspace.media.length === 0) return
    void loadReview()
  }, [loadReview, workspace?.media.length, workspace?.version])

  const activeOperation = workspace?.operations[0]
  useEffect(() => {
    if (!activeOperation || !['queued', 'running', 'waiting', 'retrying'].includes(activeOperation.status)) return
    const timer = window.setInterval(() => {
      void loadWorkspace(true)
      void loadReview(true, selectedReviewVersionId.current ?? undefined)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [activeOperation, loadReview, loadWorkspace])

  const finalOutput = useMemo(() => [...(workspace?.media ?? [])].reverse().find((item) => item.role === 'final-output'), [workspace])
  const editingProxy = useMemo(() => {
    const media = workspace?.media ?? []
    return media.find((item) => item.artifactId === review?.session.proxyArtifactId)
      ?? finalOutput
      ?? [...media].reverse().find((item) => item.role === 'editorial-proxy')
      ?? [...media].reverse().find((item) => item.role === 'editing-proxy')
  }, [finalOutput, review?.session.proxyArtifactId, workspace])
  const sourceMasters = useMemo(() => (workspace?.media ?? []).filter((item) => item.role === 'source-master'), [workspace])
  const transcript = workspace?.transcripts[0]
  const latestDirectorRun = workspace?.directorRuns[0]
  const currentReviewScene = useMemo(
    () => review?.scenes.find((scene) => previewFrame >= scene.startFrame && previewFrame < scene.endFrame),
    [previewFrame, review?.scenes],
  )
  const selectedApplicationScopeOption = useMemo(
    () => review?.scopeContext.options.find((option) => option.kind === reviewApplicationScope),
    [review?.scopeContext.options, reviewApplicationScope],
  )

  useEffect(() => {
    setPreviewState('idle')
    const preservedMs = preservedPreviewTimeMs.current
    const fps = review?.session.fps ?? editingProxy?.probe?.fps ?? 30
    setPreviewFrame(preservedMs === null ? 0 : Math.max(0, Math.round(preservedMs / 1000 * fps)))
    setReviewMode('idle')
    setReviewRegion(null)
    previewLoadStartedAt.current = performance.now()
    previewSeekSamples.current = []
    setPreviewPerformance({ firstFrameMs: 0, seekP95Ms: 0, droppedFrameRate: 0 })
  }, [editingProxy?.artifactId, review?.session.fps])

  function togglePreview(): void {
    const video = previewVideo.current
    if (!video) return
    if (!video.paused) {
      video.pause()
      return
    }
    setPreviewState('loading')
    if (video.networkState === 0) video.load()
    void video.play().catch(() => setPreviewState('error'))
  }

  async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(url, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } })
    if (response.status === 401) { router.replace('/login'); throw new Error('Sessão expirada.') }
    const payload = await response.json() as ApiEnvelope<T>
    if (!response.ok || !payload.data) throw new Error(apiError(payload, 'A API recusou a operação.'))
    return payload.data
  }

  function readPreviewPosition(): void {
    const video = previewVideo.current
    const fps = review?.session.fps ?? editingProxy?.probe?.fps ?? 30
    if (!video) return
    setPreviewFrame(Math.max(0, Math.round(video.currentTime * fps)))
    const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null
    if (quality) {
      setPreviewPerformance((current) => ({
        ...current,
        droppedFrameRate: quality.totalVideoFrames ? quality.droppedVideoFrames / quality.totalVideoFrames : 0,
      }))
    }
  }

  function finishPreviewSeek(): void {
    if (previewSeekStartedAt.current > 0) {
      previewSeekSamples.current.push(performance.now() - previewSeekStartedAt.current)
      previewSeekStartedAt.current = 0
      const sorted = [...previewSeekSamples.current].toSorted((left, right) => left - right)
      const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)
      setPreviewPerformance((current) => ({ ...current, seekP95Ms: Math.round(sorted[index] ?? 0) }))
    }
    readPreviewPosition()
  }

  function seekPreviewToFrame(frame: number): void {
    const video = previewVideo.current
    const fps = review?.session.fps ?? editingProxy?.probe?.fps ?? 30
    if (!video || !Number.isFinite(frame) || fps <= 0) return
    video.pause()
    previewSeekStartedAt.current = performance.now()
    video.currentTime = Math.max(0, frame / fps)
    readPreviewPosition()
  }

  function initializePreviewPosition(): void {
    const video = previewVideo.current
    if (!video) return
    const preservedMs = preservedPreviewTimeMs.current
    if (preservedMs === null) {
      readPreviewPosition()
      return
    }
    const maximumSeconds = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.001) : preservedMs / 1000
    const nextSeconds = Math.min(preservedMs / 1000, maximumSeconds)
    preservedPreviewTimeMs.current = null
    previewSeekStartedAt.current = performance.now()
    video.currentTime = nextSeconds
    readPreviewPosition()
  }

  async function switchReviewVersion(version: ReviewVersionData): Promise<void> {
    if (!version.previewAvailable || version.id === review?.session.projectVersionId || reviewVersionLoading) return
    const video = previewVideo.current
    if (video) {
      video.pause()
      preservedPreviewTimeMs.current = Math.round(video.currentTime * 1000)
    }
    setReviewVersionLoading(true)
    setNotice(null)
    const loaded = await loadReview(false, version.id)
    if (!loaded) preservedPreviewTimeMs.current = null
    setReviewVersionLoading(false)
  }

  function normalizedReviewPoint(event: ReactPointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: clamp01((event.clientX - bounds.left) / bounds.width),
      y: clamp01((event.clientY - bounds.top) / bounds.height),
    }
  }

  function beginReviewMark(event: ReactPointerEvent<HTMLDivElement>): void {
    if (reviewMode !== 'marking' || review?.session.stale) return
    previewVideo.current?.pause()
    const point = normalizedReviewPoint(event)
    reviewPointerStart.current = point
    event.currentTarget.setPointerCapture(event.pointerId)
    setReviewRegion({ x: point.x, y: point.y, width: 0, height: 0 })
  }

  function moveReviewMark(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = reviewPointerStart.current
    if (!start || reviewMode !== 'marking') return
    const point = normalizedReviewPoint(event)
    setReviewRegion({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    })
  }

  function finishReviewMark(event: ReactPointerEvent<HTMLDivElement>): void {
    const start = reviewPointerStart.current
    if (!start || reviewMode !== 'marking') return
    const point = normalizedReviewPoint(event)
    const region = {
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    }
    reviewPointerStart.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (region.width >= 0.015 && region.height >= 0.015) {
      setReviewRegion(region)
      setReviewScope('region')
    } else {
      setReviewRegion(null)
      setReviewScope('point')
    }
    setReviewApplicationScope(currentReviewScene ? 'scene' : region.width >= 0.015 && region.height >= 0.015 ? 'region' : 'frame')
    setReviewGlobal(false)
    setReviewGlobalConfirmed(false)
    setReviewMode('composing')
  }

  function startReview(): void {
    const video = previewVideo.current
    if (!video || !review || review.session.stale) return
    video.pause()
    readPreviewPosition()
    setReviewText('')
    setReviewRegion(null)
    setReviewScope('point')
    setReviewApplicationScope(currentReviewScene ? 'scene' : 'frame')
    setReviewGlobal(false)
    setReviewGlobalConfirmed(false)
    setReviewRangeDurationSeconds(5)
    setReviewMode('marking')
  }

  function cancelReview(): void {
    reviewPointerStart.current = null
    setReviewMode('idle')
    setReviewRegion(null)
    setReviewText('')
    setReviewScope('point')
    setReviewApplicationScope('scene')
    setReviewGlobal(false)
    setReviewGlobalConfirmed(false)
    setReviewRangeDurationSeconds(5)
  }

  function captureReviewScreenshot(): string {
    const video = previewVideo.current
    if (!video?.videoWidth || !video.videoHeight) throw new Error('O frame ainda não está disponível para captura.')
    const width = Math.min(480, video.videoWidth)
    const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('O navegador não conseguiu capturar o frame da revisão.')
    context.drawImage(video, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.76)
  }

  async function saveReviewAnnotation(): Promise<void> {
    const video = previewVideo.current
    if (!review || !video || !reviewText.trim() || review.session.stale) return
    const fps = review.session.fps
    const frame = Math.max(0, Math.min(review.session.durationFrames - 1, Math.round(video.currentTime * fps)))
    const pointTimeMs = Math.round(frame / fps * 1000)
    const scene = review.scenes.find((candidate) => frame >= candidate.startFrame && frame < candidate.endFrame)
    if (reviewScope === 'scene' && !scene) {
      setNotice('Este frame não está associado a uma cena da versão atual.')
      return
    }
    if (!selectedApplicationScopeOption?.enabled) {
      setNotice('Este escopo ainda não possui alvos disponíveis nesta versão.')
      return
    }
    if ((reviewApplicationScope === 'scene' || reviewApplicationScope === 'clip') && !scene) {
      setNotice('O frame atual não pertence a uma cena ou clipe identificável.')
      return
    }
    if (reviewApplicationScope === 'region' && !reviewRegion) {
      setNotice('Marque uma área antes de escolher o escopo regional.')
      return
    }
    if (reviewGlobal && !reviewGlobalConfirmed) {
      setNotice(`Confirme o alcance global de ${selectedApplicationScopeOption.affectedCount} alvos antes de registrar.`)
      return
    }
    setReviewSaving(true)
    setNotice(null)
    try {
      const timeRangeMs: [number, number] = reviewScope === 'scene'
        ? [Math.round(scene!.startFrame / fps * 1000), Math.round(scene!.endFrame / fps * 1000)]
        : reviewApplicationScope === 'range'
          ? [pointTimeMs, Math.min(Math.ceil(review.session.durationFrames / fps * 1000), pointTimeMs + Math.round(reviewRangeDurationSeconds * 1000))]
          : [pointTimeMs, pointTimeMs]
      const result = await requestJson<{ annotation: ReviewAnnotationData; replayed: boolean }>(
        `/v1/projects/${encodeURIComponent(projectId)}/annotations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({
            projectVersionId: review.session.projectVersionId,
            proxyArtifactId: review.session.proxyArtifactId,
            proxyHash: review.session.proxyHash,
            frame,
            timeRangeMs,
            scope: reviewScope,
            ...(reviewScope === 'region' && reviewRegion ? { region: reviewRegion } : {}),
            targetIds: reviewScope === 'scene' ? [scene!.id] : [],
            applicationScope: { kind: reviewApplicationScope, global: reviewGlobal },
            ...(reviewGlobal ? { confirmedGlobal: reviewGlobalConfirmed } : {}),
            screenshotRef: captureReviewScreenshot(),
            text: reviewText.trim(),
          }),
        },
      )
      setReview((current) => current ? { ...current, annotations: [result.annotation, ...current.annotations.filter((item) => item.id !== result.annotation.id)] } : current)
      setNotice(`Ajuste registrado no frame ${frameTimecode(frame, fps)} para ${result.annotation.affectedCount} alvo${result.annotation.affectedCount === 1 ? '' : 's'}. A versão do vídeo não foi alterada.`)
      cancelReview()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível registrar o ajuste.')
    } finally {
      setReviewSaving(false)
    }
  }

  async function beginOrResume(file: File, checksum: string): Promise<string> {
    const storageKey = `apollo:v2:upload:${projectId}:${checksum}`
    const savedId = window.localStorage.getItem(storageKey)
    if (savedId) {
      try {
        const current = await requestJson<{ upload: { id: string; status: string; size: string; checksum: string } }>(`/v1/media/uploads/${savedId}`)
        if (['pending-session', 'uploading'].includes(current.upload.status) && current.upload.size === String(file.size) && current.upload.checksum === checksum) return savedId
        if (current.upload.status === 'verified') window.localStorage.removeItem(storageKey)
      } catch { window.localStorage.removeItem(storageKey) }
    }
    const result = await requestJson<{ upload: { id: string } }>('/v1/media/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ projectId, fileName: file.name, rightsConfirmed: true, kind: 'video', size: String(file.size), mimeType: file.type || 'video/mp4', checksum }),
    })
    window.localStorage.setItem(storageKey, result.upload.id)
    return result.upload.id
  }

  async function transfer(pending: PendingUpload) {
    const controller = new AbortController()
    activeRequest.current = controller
    setUploadPhase('uploading')
    setUploadLabel('Preparando canal seguro…')
    const sessionData = await requestJson<{ uploadId: string; session: UploadSession }>(`/v1/media/uploads/${pending.uploadId}/session`, { method: 'POST', signal: controller.signal })
    const session = sessionData.session
    const headers = { 'content-type': pending.file.type || 'video/mp4', 'x-apollo-content-sha256': pending.checksum }
    if (session.mode === 'single') {
      setUploadLabel(`Enviando ${pending.file.name}`)
      const response = await fetch(localSignedUrl(session.uploadUrl!), { method: 'PUT', headers, body: pending.file, signal: controller.signal })
      if (!response.ok) throw new Error('O envio do arquivo não foi confirmado pelo armazenamento.')
      setUploadProgress(80)
    } else {
      const partSize = Number(session.partSize)
      const inspection = await requestJson<{ missingPartNumbers: number[] }>(`/v1/media/uploads/${pending.uploadId}`, { signal: controller.signal })
      const missing = inspection.missingPartNumbers
      const completedBefore = session.maxParts - missing.length
      setUploadProgress(20 + Math.round((completedBefore / session.maxParts) * 60))
      for (const partNumber of missing) {
        const start = (partNumber - 1) * partSize
        const body = pending.file.slice(start, Math.min(pending.file.size, start + partSize))
        setUploadLabel(`Enviando parte ${partNumber} de ${session.maxParts}`)
        const url = localSignedUrl(session.partUrlTemplate!.replace('{partNumber}', String(partNumber)))
        const response = await fetch(url, { method: 'PUT', headers, body, signal: controller.signal })
        if (!response.ok) throw new Error(`A parte ${partNumber} não foi confirmada. Use Retomar para continuar.`)
        setUploadProgress(20 + Math.round(((completedBefore + missing.indexOf(partNumber) + 1) / session.maxParts) * 60))
      }
    }
    setUploadPhase('verifying')
    setUploadLabel('Validando checksum e criando operação…')
    await requestJson<{ operation: PublicOperation }>(`/v1/media/uploads/${pending.uploadId}/complete`, { method: 'POST', signal: controller.signal })
    setUploadPhase('processing')
    setUploadProgress(82)
    setUploadLabel('Direcionando ingestão para o worker…')
    await loadWorkspace(true)
  }

  async function selectFile(file: File) {
    if (!rightsConfirmed) { setNotice('Confirme os direitos de uso antes de enviar o material.'); return }
    if (!file.type.startsWith('video/')) { setNotice('Selecione um arquivo de vídeo válido.'); return }
    setNotice(null)
    setUploadPhase('hashing')
    setUploadLabel(`Verificando integridade de ${file.name}`)
    setUploadProgress(0)
    const controller = new AbortController()
    activeRequest.current = controller
    try {
      const checksum = await hashFile(file, controller.signal, (progress) => setUploadProgress(Math.round(progress * 20)))
      const uploadId = await beginOrResume(file, checksum)
      const pending = { uploadId, file, checksum }
      pendingUpload.current = pending
      await transfer(pending)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') { setUploadPhase('paused'); setUploadLabel('Envio pausado com segurança.'); return }
      setUploadPhase('failed')
      setNotice(error instanceof Error ? error.message : 'Não foi possível enviar o vídeo.')
    } finally {
      activeRequest.current = null
    }
  }

  async function resumeUpload() {
    if (!pendingUpload.current) { fileInput.current?.click(); return }
    setNotice(null)
    try { await transfer(pendingUpload.current) }
    catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') { setUploadPhase('paused'); return }
      setUploadPhase('failed'); setNotice(error instanceof Error ? error.message : 'Não foi possível retomar o envio.')
    }
  }

  async function cancelUpload() {
    activeRequest.current?.abort()
    const pending = pendingUpload.current
    if (!pending) { setUploadPhase('idle'); return }
    try { await requestJson(`/v1/media/uploads/${pending.uploadId}/abort`, { method: 'POST' }) }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Não foi possível cancelar o envio.'); return }
    window.localStorage.removeItem(`apollo:v2:upload:${projectId}:${pending.checksum}`)
    pendingUpload.current = null
    setUploadProgress(0)
    setUploadPhase('idle')
    setUploadLabel('')
  }

  async function runDirector() {
    if (!workspace?.version || workspace.editPlan?.state !== 'compiled' || !transcript) {
      setNotice('O Diretor V2 precisa do corte editorial compilado e da transcrição alinhada.')
      return
    }
    setDirectorRunning(true)
    setNotice(null)
    try {
      await requestJson(`/v1/projects/${encodeURIComponent(projectId)}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          type: 'run-director', baseVersionId: workspace.version.id, baseHash: workspace.version.baseHash,
          reason: 'Planejar, criticar e materializar a primeira direção editorial V2 completa.',
        }),
      })
      setNotice('Direção V2 persistida. O novo proxy com legendas e transições entrou na fila de render.')
      await loadWorkspace(true)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'O Diretor V2 não conseguiu concluir o plano.')
    } finally {
      setDirectorRunning(false)
    }
  }

  async function exportFinal() {
    if (!workspace?.version || !workspace.project.format || !latestDirectorRun || latestDirectorRun.resultVersionId !== workspace.version.id || latestDirectorRun.status !== 'succeeded' || latestDirectorRun.qualityStatus === 'blocked') {
      setNotice('A exportação final exige a versão atual aprovada pelo DirectorRun e pelo critic.')
      return
    }
    setExportRunning(true)
    setNotice(null)
    try {
      await requestJson(`/v1/projects/${encodeURIComponent(projectId)}/exports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
        body: JSON.stringify({
          projectVersionId: workspace.version.id,
          projectVersionHash: workspace.version.baseHash,
          format: workspace.project.format,
          approval: { approved: true, note: 'Versão revisada no workspace e aprovada para exportação final.' },
        }),
      })
      setNotice('Aprovação registrada. O MP4 final em alta resolução entrou na fila de render.')
      await loadWorkspace(true)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível iniciar a exportação final.')
    } finally {
      setExportRunning(false)
    }
  }

  const finalExportOperation = activeOperation?.type === 'project-final-export'
  const directorOperation = activeOperation?.type === 'project-proxy-render' || finalExportOperation
  const pipelineSteps: readonly (readonly [string, string, string])[] = finalExportOperation
    ? [
        ['rendering', 'Render final 1080p', 'H.264/AAC, legendas e composição aprovada'],
        ['verifying', 'Validação de entrega', 'Canvas, FPS, duração e direitos'],
        ['persisting', 'Publicação do final', 'Artifact, manifest, checksum e lineage'],
      ]
    : directorOperation
    ? [
        ['rendering', 'Composição editorial', 'Cortes, enquadramento e legendas'],
        ['verifying', 'Crítica técnica', 'Duração, canvas e integridade'],
        ['persisting', 'Proxy editorial', 'Lineage, versão e disponibilidade'],
      ]
    : [
        ['assembling', 'Master imutável', 'Checksum e armazenamento'], ['probing', 'Leitura técnica', 'Duração, canvas e FPS'],
        ['normalizing', 'Proxy de edição', 'H.264 + áudio normalizado'], ['transcribing', 'Transcrição temporal', 'Palavras e segmentos'],
        ['verifying', 'Controle de qualidade', 'Alinhamento de duração'], ['persisting', 'Lineage e direitos', 'Vínculo ao projeto'],
      ]
  const currentStep = activeOperation ? pipelineSteps.findIndex(([phase]) => phase === activeOperation.phase) : -1
  const productionBrief = workspace?.brief?.productionBrief
  const ownerInput = typeof productionBrief === 'object' && productionBrief !== null && !Array.isArray(productionBrief)
    ? (productionBrief as Record<string, unknown>).ownerInput
    : undefined
  const briefText = typeof ownerInput === 'object' && ownerInput !== null && !Array.isArray(ownerInput) && typeof (ownerInput as Record<string, unknown>).text === 'string'
    ? (ownerInput as Record<string, unknown>).text as string
    : ''

  if (loading) return <main className="grid min-h-screen place-items-center bg-[#070707] text-[#8d887f]"><span className="animate-pulse text-sm">Abrindo sala de produção…</span></main>
  if (!workspace) return <main className="grid min-h-screen place-items-center bg-[#070707] px-6 text-center text-[#c8c2b8]"><div><p>{notice ?? 'Projeto não encontrado.'}</p><button className="mt-4 text-sm text-[#d9ad44]" onClick={() => router.push('/')} type="button">Voltar aos projetos</button></div></main>

  return (
    <main className="min-h-screen bg-[#070707] text-[#f3efe7] selection:bg-[#e1af38]/25">
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/[0.07] bg-[#080808]/95 px-4 backdrop-blur-xl sm:px-7">
        <div className="flex min-w-0 items-center gap-4">
          <button aria-label="Voltar aos projetos" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-white/[0.08] text-[#8f8a82] transition hover:border-white/[0.18] hover:text-white" onClick={() => router.push('/')} type="button">←</button>
          <div className="min-w-0"><p className="truncate text-sm font-semibold text-[#f3efe7]">{workspace.project.name}</p><p className="mt-0.5 text-[9px] uppercase tracking-[0.18em] text-[#68645d]">Workspace de direção · versão {workspace.version?.sequence ?? 1}</p></div>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden rounded-lg border border-[#d8a936]/20 bg-[#d8a936]/[0.07] px-2.5 py-1.5 text-[10px] font-semibold text-[#d5ad4d] sm:block">{workspace.project.format ?? '—'}</span>
          <span className="hidden items-center gap-2 rounded-lg border border-white/[0.07] px-2.5 py-1.5 text-[10px] text-[#77736b] md:flex"><i className="h-1.5 w-1.5 rounded-full bg-[#5fbd7e]" /> API V2</span>
          <LogoutButton />
        </div>
      </header>

      {notice ? <div className="mx-4 mt-4 flex items-start justify-between rounded-xl border border-[#d9a43a]/25 bg-[#d9a43a]/[0.07] px-4 py-3 text-sm text-[#dbc88f] sm:mx-7"><span>{notice}</span><button onClick={() => setNotice(null)} type="button">×</button></div> : null}

      <div className="grid min-h-[calc(100vh-64px)] xl:grid-cols-[270px_minmax(0,1fr)_330px]">
        <aside className="border-b border-white/[0.07] bg-[#0a0a0a] p-5 xl:border-b-0 xl:border-r xl:p-6">
          <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-[#b58d31]">Direção registrada</p>
          <h2 className="mt-3 text-xl font-semibold tracking-[-0.03em]">A intenção vem antes do corte.</h2>
          <dl className="mt-7 space-y-5">
            <div><dt className="text-[9px] uppercase tracking-[0.16em] text-[#625f58]">Objetivo</dt><dd className="mt-1.5 text-sm text-[#d1cbc1]">{workspace.project.objective ?? 'Não informado'}</dd></div>
            <div><dt className="text-[9px] uppercase tracking-[0.16em] text-[#625f58]">Formato mestre</dt><dd className="mt-1.5 flex items-center gap-2 text-sm text-[#d1cbc1]"><span className="grid h-7 w-7 place-items-center rounded-md border border-[#d9a937]/25 text-[9px] text-[#d9ad48]">{workspace.project.format}</span> Canvas e áreas seguras</dd></div>
            <div><dt className="text-[9px] uppercase tracking-[0.16em] text-[#625f58]">Idioma</dt><dd className="mt-1.5 text-sm text-[#d1cbc1]">{workspace.project.locale ?? 'pt-BR'}</dd></div>
          </dl>
          <div className="mt-7 rounded-xl border border-white/[0.07] bg-white/[0.025] p-4">
            <p className="text-[9px] uppercase tracking-[0.16em] text-[#6c685f]">Briefing do diretor</p>
            <p className="mt-3 whitespace-pre-wrap text-xs leading-5 text-[#969188]">{briefText || 'Nenhuma instrução adicional. O diretor deverá declarar as premissas antes do plano editorial.'}</p>
          </div>
          <div className="mt-5 rounded-xl border border-[#6962de]/15 bg-[#6962de]/[0.045] p-4">
            <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#8c85e8]">Gate atual</p>
            <p className="mt-2 text-xs leading-5 text-[#8f8aa4]">{latestDirectorRun ? `DirectorRun ${latestDirectorRun.qualityStatus === 'approved' ? 'aprovado' : 'aprovado com ressalvas'} pelo critic, com ${latestDirectorRun.decisionCount} decisões editoriais persistidas.` : workspace.editPlan?.state === 'compiled' ? `Corte editorial V2 aplicado em ${workspace.editPlan.clipCount} trechos, com ${workspace.editPlan.cutCount} decisões persistidas.` : 'Ingestão verificável: master, proxy de edição, transcript e lineage.'}</p>
            {workspace.editPlan?.state === 'compiled' ? <div className="mt-3 flex flex-wrap gap-2"><span className="rounded-md border border-white/[0.07] px-2 py-1 text-[9px] text-[#aaa4bd]">Zoom automático {workspace.editPlan.automaticZoom ? 'ativo' : 'desativado'}</span><span className="rounded-md border border-white/[0.07] px-2 py-1 text-[9px] text-[#aaa4bd]">Proteção facial {workspace.editPlan.subtitleFaceProtection ? 'ativa' : 'pendente'}</span></div> : null}
            {latestDirectorRun ? <div className="mt-3 grid grid-cols-2 gap-2 text-center"><div className="rounded-lg border border-white/[0.07] bg-black/10 px-2 py-2"><span className="block text-sm font-semibold text-[#d9b45b]">{latestDirectorRun.subtitleCueCount}</span><span className="text-[8px] uppercase tracking-[0.12em] text-[#6f6a78]">blocos de legenda</span></div><div className="rounded-lg border border-white/[0.07] bg-black/10 px-2 py-2"><span className="block text-sm font-semibold text-[#d9b45b]">{latestDirectorRun.transitionCount}</span><span className="text-[8px] uppercase tracking-[0.12em] text-[#6f6a78]">transições</span></div></div> : null}
            {workspace.editPlan?.state === 'compiled' && transcript ? <button className="mt-4 w-full rounded-lg bg-[#dbae3f] px-3 py-2.5 text-xs font-semibold text-[#171207] transition hover:bg-[#e5bb50] disabled:cursor-not-allowed disabled:opacity-45" disabled={directorRunning || exportRunning || Boolean(activeOperation && ['queued', 'running', 'waiting', 'retrying'].includes(activeOperation.status))} onClick={() => void runDirector()} type="button">{directorRunning ? 'Diretor planejando…' : latestDirectorRun ? 'Executar nova direção V2' : 'Executar Diretor V2'}</button> : null}
            {latestDirectorRun?.status === 'succeeded' && latestDirectorRun.resultVersionId === workspace.version?.id && latestDirectorRun.qualityStatus !== 'blocked' ? <button className="mt-2 w-full rounded-lg border border-[#62b47d]/25 bg-[#62b47d]/10 px-3 py-2.5 text-xs font-semibold text-[#8bd0a2] transition hover:bg-[#62b47d]/15 disabled:cursor-not-allowed disabled:opacity-45" disabled={exportRunning || Boolean(activeOperation && ['queued', 'running', 'waiting', 'retrying'].includes(activeOperation.status))} onClick={() => void exportFinal()} type="button">{exportRunning ? 'Registrando aprovação…' : finalOutput ? 'Exportar novamente em alta resolução' : 'Aprovar e exportar MP4 final'}</button> : null}
            {finalOutput ? <a className="mt-2 block w-full rounded-lg border border-white/[0.08] px-3 py-2.5 text-center text-xs text-[#aaa49a] transition hover:border-white/[0.16] hover:text-white" download={finalOutput.originalFileName} href={`/v1/artifacts/${encodeURIComponent(finalOutput.artifactId)}/content`}>Baixar MP4 final</a> : null}
          </div>
        </aside>

        <section className="min-w-0 bg-[#070707] p-4 sm:p-7">
          <div className="flex items-end justify-between gap-4">
            <div><p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#68645c]">Monitor de origem</p><h1 className="mt-1 text-2xl font-semibold tracking-[-0.035em]">Material bruto</h1></div>
            {editingProxy ? <span className="rounded-full border border-[#5eb77d]/20 bg-[#5eb77d]/[0.07] px-3 py-1 text-[10px] text-[#76c792]">{finalOutput ? 'Final 1080p verificado' : 'Proxy verificado'}</span> : null}
          </div>

          <div className="mt-5 flex min-h-[500px] items-center justify-center overflow-hidden rounded-2xl border border-white/[0.08] bg-[#030303] p-4 shadow-[0_30px_80px_rgba(0,0,0,.25)]">
            {editingProxy ? (
              <div className="relative flex max-h-[560px] max-w-full items-center justify-center overflow-hidden rounded-xl border border-white/[0.1] bg-black" style={{ aspectRatio: (workspace.project.format ?? '16:9').replace(':', ' / ') }}>
                <video
                  className="max-h-[560px] max-w-full object-contain"
                  controls
                  data-testid="project-preview"
                  key={editingProxy.artifactId}
                  onCanPlay={() => setPreviewState((current) => current === 'playing' ? current : 'ready')}
                  onError={() => setPreviewState('error')}
                  onLoadedData={() => setPreviewPerformance((current) => ({ ...current, firstFrameMs: Math.max(0, Math.round(performance.now() - previewLoadStartedAt.current)) }))}
                  onLoadedMetadata={initializePreviewPosition}
                  onPause={() => setPreviewState((current) => current === 'idle' ? current : 'paused')}
                  onPlay={() => setPreviewState('playing')}
                  onSeeked={finishPreviewSeek}
                  onSeeking={() => { previewSeekStartedAt.current = performance.now() }}
                  onTimeUpdate={readPreviewPosition}
                  playsInline
                  preload="auto"
                  ref={previewVideo}
                  src={review?.session.proxyUrl ?? `/v1/artifacts/${encodeURIComponent(editingProxy.artifactId)}/content`}
                />
                <div aria-hidden="true" className="pointer-events-none absolute inset-[5%] rounded border border-white/[0.12]" />
                <div
                  aria-label={reviewMode === 'marking' ? 'Arraste sobre o frame para marcar a área do ajuste' : 'Marcações da revisão neste frame'}
                  className={`absolute inset-0 touch-none ${reviewMode === 'marking' ? 'cursor-crosshair pointer-events-auto bg-[#dcae3f]/[0.025]' : 'pointer-events-none'}`}
                  data-testid="review-overlay"
                  onPointerDown={beginReviewMark}
                  onPointerMove={moveReviewMark}
                  onPointerUp={finishReviewMark}
                >
                  {review?.annotations.filter((annotation) => annotation.frame === previewFrame && annotation.region).map((annotation) => (
                    <span
                      aria-hidden="true"
                      className="absolute border border-[#d9aa3d]/55 bg-[#d9aa3d]/[0.07]"
                      key={annotation.id}
                      style={{
                        left: `${annotation.region!.x * 100}%`, top: `${annotation.region!.y * 100}%`,
                        width: `${annotation.region!.width * 100}%`, height: `${annotation.region!.height * 100}%`,
                      }}
                    />
                  ))}
                  {reviewRegion ? (
                    <span
                      aria-hidden="true"
                      className="absolute border border-[#efbd45] bg-[#efbd45]/10 shadow-[0_0_0_1px_rgba(0,0,0,.55)]"
                      style={{ left: `${reviewRegion.x * 100}%`, top: `${reviewRegion.y * 100}%`, width: `${reviewRegion.width * 100}%`, height: `${reviewRegion.height * 100}%` }}
                    >
                      <i className="absolute -left-1 -top-1 h-2 w-2 border-l border-t border-[#ffe29a]" />
                      <i className="absolute -right-1 -top-1 h-2 w-2 border-r border-t border-[#ffe29a]" />
                      <i className="absolute -bottom-1 -left-1 h-2 w-2 border-b border-l border-[#ffe29a]" />
                      <i className="absolute -bottom-1 -right-1 h-2 w-2 border-b border-r border-[#ffe29a]" />
                    </span>
                  ) : null}
                  {reviewMode === 'marking' ? <span className="absolute left-3 top-3 border-l-2 border-[#e7b33d] bg-black/70 px-3 py-2 font-mono text-[9px] uppercase tracking-[0.12em] text-[#f0ca72]">Arraste uma área ou clique num ponto</span> : null}
                </div>
              </div>
            ) : (
              <div className="w-full max-w-2xl px-3 py-8 text-center">
                <input accept="video/mp4,video/quicktime,video/webm" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void selectFile(file); event.target.value = '' }} ref={fileInput} type="file" />
                <button className={`group w-full rounded-2xl border border-dashed px-6 py-12 transition ${dragging ? 'border-[#d9ab42]/70 bg-[#d9ab42]/[0.06]' : 'border-white/[0.13] bg-[#0a0a0a] hover:border-[#d9ab42]/40'}`} disabled={!rightsConfirmed || !['idle', 'failed'].includes(uploadPhase)} onClick={() => fileInput.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setDragging(false); const file = event.dataTransfer.files[0]; if (file) void selectFile(file) }} type="button">
                  <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[#d9aa3d]/20 bg-[#d9aa3d]/[0.06] text-2xl font-light text-[#dcb34e] transition group-hover:-translate-y-0.5">↑</span>
                  <span className="mt-5 block text-lg font-semibold text-[#e9e4db]">Envie o vídeo bruto</span>
                  <span className="mx-auto mt-2 block max-w-md text-xs leading-5 text-[#77736b]">MP4, MOV ou WebM. Arquivos grandes são divididos, verificáveis e retomáveis sem reiniciar as partes concluídas.</span>
                </button>
                <label className="mx-auto mt-5 flex max-w-xl cursor-pointer items-start gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 text-left">
                  <input checked={rightsConfirmed} className="mt-0.5 h-4 w-4 accent-[#d9aa3d]" onChange={(event) => setRightsConfirmed(event.target.checked)} type="checkbox" />
                  <span><span className="block text-xs font-medium text-[#c9c3b9]">Confirmo que o workspace possui autorização para usar este material.</span><span className="mt-1 block text-[10px] leading-4 text-[#6e6a63]">A confirmação acompanha o master e todos os derivados em uma trilha auditável.</span></span>
                </label>
              </div>
            )}
          </div>

          {editingProxy ? (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <button className="rounded-lg border border-white/[0.1] bg-white/[0.035] px-4 py-2 text-xs font-medium text-[#d6d0c7] transition hover:border-[#d9aa3d]/35 hover:text-white" onClick={togglePreview} type="button">{previewState === 'loading' ? 'Carregando preview…' : previewState === 'playing' ? 'Pausar preview' : 'Reproduzir preview'}</button>
              <button className="rounded-lg border border-[#d9aa3d]/25 bg-[#d9aa3d]/[0.06] px-4 py-2 text-xs font-semibold text-[#ddb858] transition hover:border-[#d9aa3d]/50 disabled:cursor-not-allowed disabled:opacity-35" disabled={!review || review.session.stale || previewState === 'error'} onClick={reviewMode === 'idle' ? startReview : cancelReview} type="button">{reviewMode === 'idle' ? 'Marcar ajuste' : 'Cancelar marcação'}</button>
              <span className="border-l border-white/[0.08] pl-3 font-mono text-[10px] tabular-nums text-[#8e887e]">{frameTimecode(previewFrame, review?.session.fps ?? editingProxy.probe?.fps ?? 30)}</span>
              {previewState === 'error' ? <span className="text-[10px] text-[#d17a7a]">O preview não carregou. Use o download final para validar o arquivo.</span> : null}
            </div>
          ) : null}

          {review ? (
            <section className="mt-5 border-y border-white/[0.08] bg-[#090909] py-5" aria-label="Mesa de revisão editorial">
              <div className="flex flex-wrap items-start justify-between gap-4 px-1">
                <div>
                  <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-[#b58d31]">Mesa de revisão</p>
                  <p className="mt-1 text-sm text-[#c9c3b9]">Pause, marque o frame e descreva o ajuste.</p>
                </div>
                <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 font-mono text-[8px] uppercase tracking-[0.1em] text-[#625f58]">
                  <span>{review.session.resolution.width}×{review.session.resolution.height}</span>
                  <span>{review.session.fps.toFixed(2)} fps</span>
                  <span title={review.session.proxyHash}>hash {review.session.proxyHash.slice(0, 8)}</span>
                  <span>1º frame {previewPerformance.firstFrameMs || '—'} ms</span>
                  <span>seek p95 {previewPerformance.seekP95Ms || '—'} ms</span>
                  <span>drop {(previewPerformance.droppedFrameRate * 100).toFixed(2)}%</span>
                </div>
              </div>

              <div className="mt-4 border-y border-white/[0.06] bg-[#060606] px-3 py-3" aria-label="Versões disponíveis para revisão" data-testid="review-version-rail">
                <div className="flex items-center gap-2 overflow-x-auto pb-1">
                  <span className="mr-1 shrink-0 font-mono text-[8px] uppercase tracking-[0.16em] text-[#5e5a53]">Cortes</span>
                  {review.versions.map((version) => {
                    const selected = version.id === review.session.projectVersionId
                    return (
                      <button
                        aria-current={selected ? 'true' : undefined}
                        className={`group flex min-w-[78px] shrink-0 items-center justify-between gap-3 border px-3 py-2 text-left transition ${selected ? 'border-[#d9aa3d]/55 bg-[#d9aa3d]/10 text-[#e1ba5d]' : version.previewAvailable ? 'border-white/[0.08] bg-white/[0.02] text-[#8b867d] hover:border-white/[0.18] hover:text-[#d8d2c8]' : 'cursor-not-allowed border-white/[0.04] text-[#47443f]'}`}
                        data-testid={`review-version-${version.sequence}`}
                        disabled={!version.previewAvailable || reviewVersionLoading}
                        key={version.id}
                        onClick={() => void switchReviewVersion(version)}
                        title={version.previewAvailable ? `Abrir versão ${version.sequence} sem perder o timecode` : `A versão ${version.sequence} ainda não possui preview`}
                        type="button"
                      >
                        <span><span className="block font-mono text-[10px]">V{version.sequence}</span><span className="mt-0.5 block text-[7px] uppercase tracking-[0.11em]">{version.current ? 'atual' : version.previewAvailable ? 'histórico' : 'sem proxy'}</span></span>
                        <i className={`h-1.5 w-1.5 rounded-full ${selected ? 'bg-[#e0b44c]' : version.previewAvailable ? 'bg-[#6c8d76]' : 'bg-[#33312e]'}`} />
                      </button>
                    )
                  })}
                </div>
              </div>

              {review.session.stale ? <div className="mt-4 border-l-2 border-[#d46f63] bg-[#d46f63]/[0.06] px-4 py-3 text-xs leading-5 text-[#d99288]" data-testid="review-stale-banner">Você está vendo uma versão histórica em modo somente leitura. Volte ao corte atual para registrar novos ajustes.</div> : null}
              {reviewMode === 'marking' ? <div className="mt-4 border-l-2 border-[#d9aa3d] bg-[#d9aa3d]/[0.045] px-4 py-3 text-xs text-[#c9ad6c]">O vídeo está pausado. Arraste sobre o frame para marcar uma área; um clique simples cria uma anotação pontual.</div> : null}

              {reviewMode === 'composing' ? (
                <div className="mt-4 grid gap-4 border-t border-white/[0.07] pt-4 lg:grid-cols-[minmax(0,1fr)_220px]">
                  <div>
                    <label className="text-[9px] uppercase tracking-[0.16em] text-[#747067]" htmlFor="review-instruction">O que precisa mudar?</label>
                    <textarea autoFocus className="mt-2 min-h-24 w-full resize-y border border-white/[0.1] bg-[#050505] px-3 py-3 text-sm leading-6 text-[#e3ddd3] outline-none transition placeholder:text-[#4e4b45] focus:border-[#d9aa3d]/55" id="review-instruction" maxLength={4000} onChange={(event) => setReviewText(event.target.value)} placeholder="Ex.: mover a legenda para não cobrir o rosto, somente neste trecho." value={reviewText} />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className={`border px-3 py-2 text-[10px] transition ${reviewScope === 'point' ? 'border-[#d9aa3d]/60 bg-[#d9aa3d]/10 text-[#e4bd62]' : 'border-white/[0.08] text-[#77736b] hover:text-white'}`} onClick={() => { setReviewScope('point'); setReviewRegion(null) }} type="button">Neste ponto</button>
                      <button className={`border px-3 py-2 text-[10px] transition ${reviewScope === 'region' ? 'border-[#d9aa3d]/60 bg-[#d9aa3d]/10 text-[#e4bd62]' : 'border-white/[0.08] text-[#77736b] hover:text-white'} disabled:opacity-30`} disabled={!reviewRegion} onClick={() => setReviewScope('region')} type="button">Área marcada</button>
                      <button className={`border px-3 py-2 text-[10px] transition ${reviewScope === 'scene' ? 'border-[#d9aa3d]/60 bg-[#d9aa3d]/10 text-[#e4bd62]' : 'border-white/[0.08] text-[#77736b] hover:text-white'} disabled:opacity-30`} disabled={!currentReviewScene} onClick={() => setReviewScope('scene')} type="button">{currentReviewScene ? `${currentReviewScene.label} inteira` : 'Cena indisponível'}</button>
                    </div>
                    <div className="mt-5 grid gap-3 border-t border-white/[0.06] pt-4 sm:grid-cols-[minmax(0,1fr)_160px]">
                      <label className="block">
                        <span className="text-[9px] uppercase tracking-[0.16em] text-[#747067]">Onde a correção deve valer?</span>
                        <select
                          className="mt-2 w-full border border-white/[0.1] bg-[#050505] px-3 py-2.5 text-xs text-[#d4cec4] outline-none focus:border-[#d9aa3d]/55"
                          data-testid="review-application-scope"
                          onChange={(event) => { setReviewApplicationScope(event.target.value as ReviewApplicationScopeKind); setReviewGlobal(false); setReviewGlobalConfirmed(false) }}
                          value={reviewApplicationScope}
                        >
                          {review.scopeContext.options.map((option) => {
                            const unavailable = !option.enabled || (option.kind === 'region' && !reviewRegion) || (['clip', 'scene'].includes(option.kind) && !currentReviewScene)
                            return <option disabled={unavailable} key={option.kind} value={option.kind}>{REVIEW_SCOPE_LABELS[option.kind]}{unavailable ? ' — indisponível' : ''}</option>
                          })}
                        </select>
                      </label>
                      {reviewApplicationScope === 'range' ? (
                        <label className="block">
                          <span className="text-[9px] uppercase tracking-[0.16em] text-[#747067]">Duração do trecho</span>
                          <span className="mt-2 flex items-center border border-white/[0.1] bg-[#050505] px-3">
                            <input className="w-full bg-transparent py-2.5 text-xs text-[#d4cec4] outline-none" data-testid="review-range-duration" max={Math.max(0.1, review.session.durationFrames / review.session.fps)} min="0.1" onChange={(event) => setReviewRangeDurationSeconds(Math.max(0.1, Number(event.target.value) || 0.1))} step="0.1" type="number" value={reviewRangeDurationSeconds} />
                            <i className="text-[9px] not-italic text-[#656159]">s</i>
                          </span>
                        </label>
                      ) : <div className="hidden sm:block" />}
                    </div>
                    <label className="mt-3 flex cursor-pointer items-start gap-3 border border-white/[0.07] bg-white/[0.015] px-3 py-3">
                      <input checked={reviewGlobal} className="mt-0.5 h-4 w-4 accent-[#d9aa3d]" data-testid="review-global-toggle" onChange={(event) => { setReviewGlobal(event.target.checked); setReviewGlobalConfirmed(false) }} type="checkbox" />
                      <span><span className="block text-[10px] font-medium text-[#aaa49a]">Expandir para todos os alvos deste escopo</span><span className="mt-1 block text-[9px] leading-4 text-[#625f58]">Sem esta opção, o ajuste fica restrito a {review.scopeContext.formatId}, {review.scopeContext.localeId} e ao alvo atual.</span></span>
                    </label>
                    {reviewGlobal ? (
                      <label className="mt-2 flex cursor-pointer items-start gap-3 border-l-2 border-[#d46f63] bg-[#d46f63]/[0.05] px-3 py-3" data-testid="review-global-confirmation">
                        <input checked={reviewGlobalConfirmed} className="mt-0.5 h-4 w-4 accent-[#d46f63]" onChange={(event) => setReviewGlobalConfirmed(event.target.checked)} type="checkbox" />
                        <span className="text-[10px] leading-4 text-[#d28b82]">Confirmo o alcance global em {selectedApplicationScopeOption?.affectedCount ?? 0} alvo{selectedApplicationScopeOption?.affectedCount === 1 ? '' : 's'}.</span>
                      </label>
                    ) : null}
                  </div>
                  <div className="flex flex-col justify-between border-l border-white/[0.07] pl-4">
                    <div><p className="font-mono text-[10px] text-[#d8ad49]">{frameTimecode(previewFrame, review.session.fps)}</p><p className="mt-2 text-[10px] leading-4 text-[#6f6b63]">Versão {review.versions.find((version) => version.id === review.session.projectVersionId)?.sequence ?? '—'} · {reviewGlobal ? `${selectedApplicationScopeOption?.affectedCount ?? 0} alvos declarados` : '1 alvo no formato e idioma atuais'}.</p></div>
                    <div className="mt-5 flex gap-2"><button className="flex-1 border border-white/[0.09] px-3 py-2 text-[10px] text-[#8b867d] hover:text-white" onClick={cancelReview} type="button">Cancelar</button><button className="flex-1 bg-[#dbae3f] px-3 py-2 text-[10px] font-bold text-[#171207] disabled:opacity-35" data-testid="review-save" disabled={reviewSaving || !reviewText.trim() || !selectedApplicationScopeOption?.enabled || (reviewGlobal && !reviewGlobalConfirmed)} onClick={() => void saveReviewAnnotation()} type="button">{reviewSaving ? 'Salvando…' : 'Registrar'}</button></div>
                  </div>
                </div>
              ) : null}

              <div className="mt-5 border-t border-white/[0.07] pt-4">
                <div className="flex items-center justify-between"><p className="text-[9px] uppercase tracking-[0.17em] text-[#706c64]">Ajustes desta versão</p><span className="text-[9px] text-[#55524c]">{review.annotations.length} aberto{review.annotations.length === 1 ? '' : 's'}</span></div>
                {review.annotations.length ? <div className="mt-3 grid gap-px bg-white/[0.06] sm:grid-cols-2">{review.annotations.slice(0, 6).map((annotation) => <button className="bg-[#090909] px-3 py-3 text-left transition hover:bg-[#0d0c0a]" data-testid={`review-annotation-${annotation.id}`} key={annotation.id} onClick={() => seekPreviewToFrame(annotation.frame)} type="button"><span className="font-mono text-[9px] text-[#b8943e]">{frameTimecode(annotation.frame, review.session.fps)}</span><span className="ml-2 text-[8px] uppercase tracking-[0.1em] text-[#5f5b54]">{annotation.scope === 'region' ? 'área' : annotation.scope === 'scene' ? 'cena' : 'ponto'} · {REVIEW_SCOPE_LABELS[annotation.applicationScope.kind]} · {annotation.affectedCount} alvo{annotation.affectedCount === 1 ? '' : 's'}</span><p className="mt-1.5 line-clamp-2 text-xs leading-5 text-[#aaa49a]">{annotation.text}</p></button>)}</div> : <p className="mt-3 text-xs text-[#5f5b54]">Nenhum ajuste registrado nesta versão.</p>}
              </div>
            </section>
          ) : null}

          {uploadPhase !== 'idle' && !editingProxy ? (
            <div className="mt-4 rounded-xl border border-white/[0.08] bg-[#0b0b0b] p-4">
              <div className="flex items-center justify-between gap-4"><p className="truncate text-xs text-[#aaa49a]">{uploadLabel || PHASE_LABELS[activeOperation?.phase ?? 'queued']}</p><span className="text-xs tabular-nums text-[#d8ad49]">{uploadProgress}%</span></div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/[0.06]"><div className="h-full rounded-full bg-[linear-gradient(90deg,#9b7526,#e0af3d)] transition-[width] duration-300" style={{ width: `${uploadProgress}%` }} /></div>
              <div className="mt-3 flex justify-end gap-2">
                {uploadPhase === 'uploading' || uploadPhase === 'hashing' ? <button className="rounded-lg border border-white/[0.09] px-3 py-1.5 text-[11px] text-[#aaa49a] hover:text-white" onClick={() => activeRequest.current?.abort()} type="button">Pausar</button> : null}
                {uploadPhase === 'paused' || uploadPhase === 'failed' ? <button className="rounded-lg bg-[#dbae3f] px-3 py-1.5 text-[11px] font-semibold text-[#171207]" onClick={() => void resumeUpload()} type="button">{pendingUpload.current ? 'Retomar' : 'Enviar novamente'}</button> : null}
                {['hashing', 'uploading', 'paused', 'failed'].includes(uploadPhase) ? <button className="rounded-lg border border-[#c96666]/20 px-3 py-1.5 text-[11px] text-[#c97b7b]" onClick={() => void cancelUpload()} type="button">Cancelar</button> : null}
              </div>
            </div>
          ) : null}

          {transcript ? <div className="mt-5 rounded-2xl border border-white/[0.07] bg-[#0a0a0a] p-5"><div className="flex items-center justify-between"><p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-[#79746c]">Transcrição do master</p><span className="text-[10px] text-[#5e9f74]">{transcript.wordCount} palavras · {transcript.language}</span></div><p className="mt-2 text-[10px] text-[#666159]">Fonte indexada; o preview acima já aplica os cortes da versão {workspace.version?.sequence ?? 1}.</p><p className="mt-3 line-clamp-4 text-sm leading-6 text-[#aaa59c]">{transcript.text}</p></div> : null}
        </section>

        <aside className="border-t border-white/[0.07] bg-[#0a0a0a] p-5 xl:border-l xl:border-t-0 xl:p-6">
          <div className="flex items-center justify-between"><div><p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#b58d31]">Pipeline V2</p><h2 className="mt-2 text-lg font-semibold">{finalExportOperation ? 'Exportação final' : directorOperation ? 'Direção materializada' : 'Ingestão verificável'}</h2></div><span className="font-mono text-[9px] text-[#5f5c55]">{activeOperation?.id.slice(-8) ?? 'AGUARDANDO'}</span></div>
          <div className="mt-7 space-y-1">
            {pipelineSteps.map(([phase, title, description], index) => {
              const failed = activeOperation?.status === 'failed' && currentStep === index
              const state = failed ? 'failed' : activeOperation?.status === 'succeeded' || currentStep > index ? 'done' : currentStep === index ? 'active' : 'waiting'
              return <div className="grid grid-cols-[24px_1fr] gap-3 py-3" key={phase}><div className="flex flex-col items-center"><StepIcon state={state} />{index < pipelineSteps.length - 1 ? <span className="mt-2 h-8 w-px bg-white/[0.07]" /> : null}</div><div><p className={`text-xs font-medium ${state === 'active' ? 'text-[#e2b64e]' : state === 'done' ? 'text-[#b9c8bd]' : state === 'failed' ? 'text-[#de8585]' : 'text-[#77736b]'}`}>{title}</p><p className="mt-1 text-[10px] text-[#5f5c56]">{description}</p></div></div>
            })}
          </div>
          <div className="mt-5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div className="flex items-center justify-between"><span className="text-[9px] uppercase tracking-[0.15em] text-[#68645e]">Estado</span><span className="text-[10px] text-[#b9b3aa]">{activeOperation ? finalExportOperation && activeOperation.phase === 'completed' ? 'MP4 final disponível' : directorOperation && activeOperation.phase === 'completed' ? 'Render editorial concluído' : PHASE_LABELS[activeOperation.phase] ?? activeOperation.status : 'Aguardando mídia'}</span></div>
            {activeOperation?.error?.message ? <p className="mt-3 text-[10px] leading-4 text-[#c87b7b]">{activeOperation.error.message}</p> : null}
          </div>
        </aside>
      </div>

      <section className="border-t border-white/[0.07] bg-[#080808] px-4 py-5 sm:px-7">
        <div className="flex items-end justify-between"><div><p className="text-[9px] uppercase tracking-[0.18em] text-[#67635c]">Fontes do projeto</p><h2 className="mt-1 text-base font-semibold">Mídia catalogada</h2></div><span className="text-[10px] text-[#615e57]">{sourceMasters.length} master{sourceMasters.length === 1 ? '' : 's'} · {workspace.transcripts.length} transcript{workspace.transcripts.length === 1 ? '' : 's'}</span></div>
        <div className="mt-4 flex gap-3 overflow-x-auto pb-2">
          {workspace.media.length ? workspace.media.map((media) => <article className="min-w-64 rounded-xl border border-white/[0.07] bg-[#0b0b0b] p-4" key={media.id}><div className="flex items-start justify-between gap-3"><div className="grid h-9 w-9 place-items-center rounded-lg bg-[#d7a638]/[0.07] text-xs text-[#d5ab47]">{media.role === 'source-master' ? 'M' : media.role === 'final-output' ? 'F' : media.role === 'editorial-proxy' ? 'E' : 'P'}</div><span className="rounded-full border border-[#61ad7a]/15 px-2 py-1 text-[9px] text-[#6fba87]">{media.rightsStatus ?? 'catalogado'}</span></div><p className="mt-3 truncate text-xs font-medium text-[#c8c2b9]">{media.originalFileName}</p><p className="mt-1 text-[10px] text-[#68645e]">{media.role === 'source-master' ? 'Master original' : media.role === 'final-output' ? 'MP4 final aprovado' : media.role === 'editorial-proxy' ? 'Proxy editorial materializado' : 'Proxy de ingestão'} · {readableBytes(media.byteSize)}{media.probe ? ` · ${media.probe.width}×${media.probe.height} · ${Math.round(media.probe.duration)}s` : ''}</p></article>) : <div className="w-full rounded-xl border border-dashed border-white/[0.08] px-4 py-8 text-center text-xs text-[#656159]">O primeiro master aparecerá aqui após a verificação.</div>}
        </div>
      </section>
    </main>
  )
}
