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
type SourceDeconstructionRole = 'opening' | 'hook' | 'context' | 'body' | 'cta' | 'tail'
interface SourceDeconstructionReportData {
  id: string
  sourceArtifactId: string
  desiredRole: 'hook' | 'body' | 'cta' | 'complete'
  validationScope: 'copy' | 'take' | 'opening-edit' | 'full'
  segments: {
    id: string
    exactText: string
    rangeMs: [number, number]
    role: SourceDeconstructionRole
    included: boolean
    includedForContext: boolean
  }[]
  cleanCandidateRanges: {
    id: string
    rangeMs: [number, number]
    speechRangeMs: [number, number]
    exactText: string
    confidence: number
    contextPreserved: boolean
  }[]
  semanticContaminants: {
    id: string
    kind: 'prior-opening' | 'non-target-body' | 'prior-cta' | 'removable-tail'
    rangeMs: [number, number]
    exactText: string
    confidence: number
    removableWithoutContextLoss: boolean
  }[]
  comparison: {
    sourceRangeMs: [number, number]
    cleanRangesMs: [number, number][]
    removedRangesMs: [number, number][]
    sourceDurationMs: number
    cleanDurationMs: number
    removedDurationMs: number
    retainedRatio: number
    sourceTranscript: string
    cleanTranscript: string
  }
  confidence: number
  editabilityScore: number
  decision: 'automatic' | 'human-review' | 'reject'
  contextPreserved: boolean
  createdAt: string
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
type PatchOperationKind = 'trim' | 'replace-asset' | 'update-text' | 'update-layout' | 'update-subtitle' | 'move'
interface ReviewPatchProposalData {
  id: string; annotationId: string; baseVersionId: string; status: 'ready' | 'ambiguous' | 'prohibited' | 'budget-blocked' | 'applied'; interpretationVersion: string;
  choices: { choiceId?: string; op: PatchOperationKind; targetId: string; value: Record<string, unknown>; rangeMs?: [number, number] }[];
  patch: null | { id: string; operations: { op: PatchOperationKind; targetId: string; value: Record<string, unknown>; rangeMs?: [number, number] }[]; estimatedCost: number; invalidatedRanges: [number, number][] };
  impact: null | { operationCount: number; cost: number; invalidatedRanges: [number, number][]; changedTargets: string[]; expectedScoreDelta: number; invalidatedArtifacts: string[] };
  gates: { gate: 'ambiguity' | 'protected-elements' | 'policy' | 'budget'; passed: boolean; code?: string; message: string; targetIds: string[] }[];
  resultVersionId?: string; renderOperationId?: string; comparison?: { beforeVersionId: string; afterVersionId: string; beforeEditPlanHash: string; afterEditPlanHash: string; changedTargets: string[]; invalidatedRanges: [number, number][] };
  render?: { operationId: string; status: string; phase: string; error?: { code: string; message: string } };
  createdAt: string; updatedAt: string;
}
interface ReviewPatchBatchData {
  id: string; baseVersionId: string; mode: 'all-or-nothing' | 'partial-retry'; status: 'ready' | 'conflict' | 'partial' | 'applied';
  patch: ReviewPatchProposalData['patch']; impact: ReviewPatchProposalData['impact']; conflicts: string[];
  items: {
    id: string; annotationId: string; proposalId: string; status: 'included' | 'rolled-back' | 'retryable' | 'applied';
    operation: { op: PatchOperationKind; targetId: string; value: Record<string, unknown>; rangeMs?: [number, number] } | null;
    conflictIds: string[]; reasonCode?: 'ATOMIC_CONFLICT' | 'TARGET_CONFLICT'; createdAt: string; updatedAt: string;
  }[];
  resultVersionId?: string; renderOperationId?: string; comparison?: ReviewPatchProposalData['comparison']; render?: ReviewPatchProposalData['render'];
  createdAt: string; updatedAt: string;
}
interface ManualTimelineClipData {
  id: string; sourceId: string; startMs: number; endMs: number; track: number; selected: boolean;
  inspector: { layout?: string; text?: string; subtitle?: string; color?: string; motion?: string; audioGain?: number }
}
interface ManualTimelineData {
  timeline: { versionId: string; revision: number; clips: ManualTimelineClipData[]; snapPointsMs: number[] };
  baseHash: string; editPlanHash: string;
  history: {
    id: string; sequence: number; parentVersionId?: string; commandId?: string; commandType?: string;
    action?: 'apply' | 'undo' | 'redo' | 'restore'; restoresVersionId?: string; createdAt: string;
  }[];
}
type ManualOperation =
  | { kind: 'trim'; clipId: string; edge: 'start' | 'end'; atMs: number }
  | { kind: 'split'; clipId: string; atMs: number }
  | { kind: 'move'; clipId: string; startMs: number; track: number }
  | { kind: 'replace'; clipId: string; sourceId: string }
  | { kind: 'inspect'; clipId: string; patch: ManualTimelineClipData['inspector'] }
interface ManualEditAppliedData {
  timeline: ManualTimelineData['timeline'];
  version: { id: string; sequence: number; baseHash: string };
  operation: PublicOperation;
  comparison: {
    beforeVersionId: string; afterVersionId: string; beforeEditPlanHash: string; afterEditPlanHash: string;
    action: 'apply' | 'undo' | 'redo'; targetId: string;
  };
}
type VersionCompareMode = 'toggle' | 'split' | 'overlay'
interface VersionComparisonData {
  current: { versionId: string; baseHash: string; revision: number };
  versions: {
    before: { id: string; sequence: number; editPlanHash: string };
    after: { id: string; sequence: number; editPlanHash: string };
  };
  comparison: {
    before: { id: string; durationMs: number; mappingId?: string; score: number; issues: string[] };
    after: { id: string; durationMs: number; mappingId?: string; score: number; issues: string[] };
    mode: VersionCompareMode; synchronized: boolean; playheadMapping: 'shared' | 'independent';
    durationDeltaMs: number; scoreDelta: number; issuesAdded: string[]; issuesResolved: string[];
    semanticChanges: { category: string; target: string; summary: string }[];
    actions: ['accept', 'reopen', 'restore']; versionsPreserved: true;
  };
}
interface ProxyReviewIssueData {
  code: string
  severity: 'hard' | 'warning'
  category: 'technical' | 'policy' | 'integrity' | 'editorial'
  message: string
  rangeMs?: [number, number]
  targetId?: string
  correctable: boolean
}
interface ProxyReviewData {
  id: string
  projectId: string
  projectVersionId: string
  operationId: string
  proxyArtifactId: string
  proxyManifestId: string
  inputHash: string
  rangeCacheKey: string
  spec: { width: number; height: number; codec: 'h264'; container: 'mp4'; quality: 'review'; reusableRanges: true }
  status: 'blocked' | 'warning-ack-required' | 'ready-for-final'
  technicalIssues: ProxyReviewIssueData[]
  criticIssues: ProxyReviewIssueData[]
  warningsAcknowledged: boolean
  finalAllowed: boolean
  uploadReceivedAt: string
  renderCompletedAt: string
  timeToFirstProxyMs: number
  reviewHash: string
  revision: number
  acknowledgedBy?: { type: 'api-client'; id: string; at: string }
  createdAt: string
  updatedAt: string
}
type RenderElementType = 'background' | 'presenter' | 'subtitle' | 'b-roll' | 'cta' | 'transformation'
interface RenderElementData {
  elementId: string; type: RenderElementType; clipId: string; sceneId: string; sourceId: string; frame: number;
  bounds: { x: number; y: number; width: number; height: number }; zIndex: number; opacity: number; priority: number
}
interface RenderElementHitTestData {
  map: { schemaVersion: 'render-element-map/v1'; mapHash: string; proxyHash: string; fps: number; durationFrames: number; canvas: { width: number; height: number }; frame: number };
  selected: RenderElementData | null; chooserRequired: boolean; candidates: RenderElementData[]
}
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

const RENDER_ELEMENT_LABELS: Readonly<Record<RenderElementType, string>> = Object.freeze({
  background: 'Fundo', presenter: 'Apresentador', subtitle: 'Legenda', 'b-roll': 'B-roll', cta: 'CTA', transformation: 'Transformação',
})

const PATCH_OPERATION_LABELS: Readonly<Record<PatchOperationKind, string>> = Object.freeze({
  trim: 'Cortar trecho', 'replace-asset': 'Trocar mídia', 'update-text': 'Atualizar texto', 'update-layout': 'Reposicionar', 'update-subtitle': 'Ajustar legenda', move: 'Reordenar cena',
})

const PATCH_GATE_LABELS = Object.freeze({
  ambiguity: 'Intenção', 'protected-elements': 'Proteções', policy: 'Política', budget: 'Budget',
} satisfies Record<ReviewPatchProposalData['gates'][number]['gate'], string>)

const SOURCE_ROLE_LABELS = Object.freeze({
  opening: 'Abertura',
  hook: 'Hook',
  context: 'Contexto',
  body: 'Corpo',
  cta: 'CTA',
  tail: 'Cauda',
} satisfies Record<SourceDeconstructionRole, string>)

const SOURCE_CONTAMINANT_LABELS = Object.freeze({
  'prior-opening': 'Abertura anterior',
  'non-target-body': 'Corpo fora do alvo',
  'prior-cta': 'CTA anterior',
  'removable-tail': 'Cauda removível',
} satisfies Record<SourceDeconstructionReportData['semanticContaminants'][number]['kind'], string>)

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

function readableDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  if (value < 1_000) return `${Math.round(value)} ms`
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`
}

function rangePosition(
  rangeMs: readonly [number, number],
  durationMs: number,
) {
  const duration = Math.max(1, durationMs)
  const left = clamp01(rangeMs[0] / duration) * 100
  const right = clamp01(rangeMs[1] / duration) * 100
  return {
    left: `${left}%`,
    width: `${Math.max(0.35, right - left)}%`,
  }
}

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
  const reviewElementLookup = useRef<AbortController | null>(null)
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
  const [reviewElementResolution, setReviewElementResolution] = useState<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle')
  const [reviewElementMap, setReviewElementMap] = useState<RenderElementHitTestData['map'] | null>(null)
  const [reviewElementCandidates, setReviewElementCandidates] = useState<RenderElementData[]>([])
  const [selectedReviewElement, setSelectedReviewElement] = useState<RenderElementData | null>(null)
  const [reviewElementConfirmed, setReviewElementConfirmed] = useState(false)
  const [previewFrame, setPreviewFrame] = useState(0)
  const [previewPerformance, setPreviewPerformance] = useState({ firstFrameMs: 0, seekP95Ms: 0, droppedFrameRate: 0 })
  const [reviewPatch, setReviewPatch] = useState<ReviewPatchProposalData | null>(null)
  const [reviewPatchLoading, setReviewPatchLoading] = useState<string | null>(null)
  const [reviewPatchApplying, setReviewPatchApplying] = useState(false)
  const reviewPatchApplyKeyRef = useRef<{ proposalId: string; key: string } | null>(null)
  const [reviewBatchSelection, setReviewBatchSelection] = useState<string[]>([])
  const [reviewPatchBatch, setReviewPatchBatch] = useState<ReviewPatchBatchData | null>(null)
  const [reviewPatchBatchLoading, setReviewPatchBatchLoading] = useState(false)
  const [reviewPatchBatchApplying, setReviewPatchBatchApplying] = useState(false)
  const reviewPatchBatchApplyKeyRef = useRef<{ batchId: string; key: string } | null>(null)
  const manualDragStart = useRef<{ clipId: string; clientX: number; boundsLeft: number; boundsWidth: number } | null>(null)
  const [manualTimeline, setManualTimeline] = useState<ManualTimelineData | null>(null)
  const [manualSelectedClipId, setManualSelectedClipId] = useState<string | null>(null)
  const [manualBusy, setManualBusy] = useState(false)
  const [manualInspector, setManualInspector] = useState<ManualTimelineClipData['inspector']>({})
  const compareBeforeVideo = useRef<HTMLVideoElement>(null)
  const compareAfterVideo = useRef<HTMLVideoElement>(null)
  const [compareBeforeVersionId, setCompareBeforeVersionId] = useState<string | null>(null)
  const [compareAfterVersionId, setCompareAfterVersionId] = useState<string | null>(null)
  const [compareMode, setCompareMode] = useState<VersionCompareMode>('split')
  const [versionComparison, setVersionComparison] = useState<VersionComparisonData | null>(null)
  const [comparePreviews, setComparePreviews] = useState<{ before?: string; after?: string }>({})
  const [compareToggleSide, setCompareToggleSide] = useState<'before' | 'after'>('after')
  const [compareOverlayOpacity, setCompareOverlayOpacity] = useState(0.5)
  const [compareBusy, setCompareBusy] = useState(false)
  const [proxyReview, setProxyReview] = useState<ProxyReviewData | null>(null)
  const [proxyReviewBusy, setProxyReviewBusy] = useState(false)
  const [sourceDeconstructions, setSourceDeconstructions] = useState<SourceDeconstructionReportData[]>([])
  const [selectedSourceDeconstructionId, setSelectedSourceDeconstructionId] = useState<string | null>(null)
  const [sourceDeconstructionLoading, setSourceDeconstructionLoading] = useState(true)

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

  const loadManualTimeline = useCallback(async (quiet = false) => {
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId)}/timeline`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      if (response.status === 401) { router.replace('/login'); return }
      const payload = await response.json() as ApiEnvelope<ManualTimelineData>
      if (!response.ok || !payload.data) {
        if (response.status === 428 || response.status === 409) {
          setManualTimeline(null)
          return
        }
        throw new Error(apiError(payload, 'Não foi possível carregar a timeline manual.'))
      }
      setManualTimeline(payload.data)
      setManualSelectedClipId((current) =>
        payload.data!.timeline.clips.some((clip) => clip.id === current)
          ? current
          : payload.data!.timeline.clips[0]?.id ?? null)
    } catch (error) {
      if (!quiet) {
        setNotice(error instanceof Error ? error.message : 'Não foi possível carregar a timeline manual.')
      }
    }
  }, [projectId, router])

  useEffect(() => { void loadWorkspace() }, [loadWorkspace])
  const loadSourceDeconstructions = useCallback(async (quiet = false) => {
    if (!quiet) setSourceDeconstructionLoading(true)
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId)}/source-deconstructions?limit=20`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      const payload = await response.json() as ApiEnvelope<{
        reports: SourceDeconstructionReportData[]
      }>
      if (!response.ok || !payload.data) {
        throw new Error(apiError(
          payload,
          'Não foi possível carregar a leitura do material publicado.',
        ))
      }
      setSourceDeconstructions(payload.data.reports)
      setSelectedSourceDeconstructionId((current) =>
        current && payload.data!.reports.some((report) =>
          report.id === current)
          ? current
          : payload.data!.reports[0]?.id ?? null)
    } catch (error) {
      if (!quiet) {
        setNotice(error instanceof Error
          ? error.message
          : 'Não foi possível carregar a leitura do material publicado.')
      }
    } finally {
      if (!quiet) setSourceDeconstructionLoading(false)
    }
  }, [projectId, router])

  useEffect(() => {
    void loadSourceDeconstructions()
  }, [loadSourceDeconstructions])
  useEffect(() => () => reviewElementLookup.current?.abort(), [])
  useEffect(() => {
    if (workspace?.editPlan?.state !== 'compiled' || !workspace.version) {
      setManualTimeline(null)
      return
    }
    void loadManualTimeline(true)
  }, [loadManualTimeline, workspace?.editPlan?.state, workspace?.version])

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

  const loadProxyReview = useCallback(async (quiet = false, projectVersionId?: string) => {
    try {
      const query = new URLSearchParams()
      if (projectVersionId) query.set('projectVersionId', projectVersionId)
      const suffix = query.size ? `?${query.toString()}` : ''
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId)}/proxy-reviews${suffix}`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      if (response.status === 401) { router.replace('/login'); return }
      if (response.status === 404) {
        setProxyReview(null)
        return
      }
      const payload = await response.json() as ApiEnvelope<{ review: ProxyReviewData }>
      if (!response.ok || !payload.data?.review) {
        throw new Error(apiError(payload, 'Não foi possível carregar o laudo do proxy.'))
      }
      setProxyReview(payload.data.review)
    } catch (error) {
      if (!quiet) {
        setNotice(error instanceof Error ? error.message : 'Não foi possível carregar o laudo do proxy.')
      }
    }
  }, [projectId, router])

  useEffect(() => {
    if (!workspace?.version || workspace.media.length === 0) return
    void loadReview()
    void loadProxyReview(true, workspace.version.id)
  }, [loadProxyReview, loadReview, workspace?.media.length, workspace?.version?.id])

  const activeOperation = workspace?.operations[0]
  useEffect(() => {
    if (!activeOperation || !['queued', 'running', 'waiting', 'retrying'].includes(activeOperation.status)) return
    const timer = window.setInterval(() => {
      void loadWorkspace(true)
      void loadReview(true, selectedReviewVersionId.current ?? undefined)
      void loadProxyReview(true, workspace?.version?.id)
    }, 2500)
    return () => window.clearInterval(timer)
  }, [activeOperation, loadProxyReview, loadReview, loadWorkspace, workspace?.version?.id])

  const finalOutput = useMemo(() => [...(workspace?.media ?? [])].reverse().find((item) => item.role === 'final-output'), [workspace])
  const editingProxy = useMemo(() => {
    const media = workspace?.media ?? []
    return media.find((item) => item.artifactId === review?.session.proxyArtifactId)
      ?? finalOutput
      ?? [...media].reverse().find((item) => item.role === 'editorial-proxy')
      ?? [...media].reverse().find((item) => item.role === 'editing-proxy')
  }, [finalOutput, review?.session.proxyArtifactId, workspace])
  const sourceMasters = useMemo(() => (workspace?.media ?? []).filter((item) => item.role === 'source-master'), [workspace])
  const selectedSourceDeconstruction = useMemo(
    () => sourceDeconstructions.find((report) =>
      report.id === selectedSourceDeconstructionId)
      ?? sourceDeconstructions[0]
      ?? null,
    [selectedSourceDeconstructionId, sourceDeconstructions],
  )
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
  const manualSelectedClip = useMemo(
    () => manualTimeline?.timeline.clips.find((clip) => clip.id === manualSelectedClipId),
    [manualSelectedClipId, manualTimeline?.timeline.clips],
  )
  useEffect(() => {
    setManualInspector(manualSelectedClip ? { ...manualSelectedClip.inspector } : {})
  }, [manualSelectedClip])
  useEffect(() => {
    const timeline = manualTimeline?.timeline
    const history = manualTimeline?.history ?? []
    if (!timeline || history.length < 2) {
      setCompareBeforeVersionId(null)
      setCompareAfterVersionId(null)
      setVersionComparison(null)
      setComparePreviews({})
      return
    }
    const ids = new Set(history.map((version) => version.id))
    const current = history.find((version) => version.id === timeline.versionId)
    const fallbackBefore = current?.parentVersionId
      ?? history.find((version) => version.id !== timeline.versionId)?.id
      ?? null
    setCompareAfterVersionId((selected) =>
      selected && ids.has(selected) ? selected : timeline.versionId)
    setCompareBeforeVersionId((selected) =>
      selected && ids.has(selected) && selected !== timeline.versionId ? selected : fallbackBefore)
  }, [manualTimeline?.history, manualTimeline?.timeline])

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

  async function submitManualEdit(input: {
    action: 'apply' | 'undo' | 'redo'
    operation?: ManualOperation
    targetVersionId?: string
  }): Promise<void> {
    if (!manualTimeline || !workspace?.version || manualBusy) return
    const selectedId = input.operation?.clipId ?? manualSelectedClipId ?? 'project-edit-plan'
    const video = previewVideo.current
    if (video) {
      video.pause()
      preservedPreviewTimeMs.current = Math.round(video.currentTime * 1000)
    }
    setManualBusy(true)
    setNotice(null)
    try {
      const result = await requestJson<ManualEditAppliedData>(
        `/v1/projects/${encodeURIComponent(projectId)}/manual-edits`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `manual-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            action: input.action,
            baseVersionId: manualTimeline.timeline.versionId,
            baseHash: manualTimeline.baseHash,
            expectedRevision: manualTimeline.timeline.revision,
            variantId: workspace.project.format ?? '9:16',
            targetId: selectedId,
            ...(input.operation ? { operation: input.operation } : {}),
            ...(input.targetVersionId ? { targetVersionId: input.targetVersionId } : {}),
          }),
        },
      )
      setManualTimeline((current) => current ? {
        ...current,
        timeline: result.timeline,
        baseHash: result.version.baseHash,
        editPlanHash: result.comparison.afterEditPlanHash,
      } : current)
      setManualSelectedClipId(
        result.timeline.clips.find((clip) => clip.id === selectedId)?.id
          ?? result.timeline.clips.find((clip) => clip.id.startsWith(`${selectedId}:`))?.id
          ?? result.timeline.clips[0]?.id
          ?? null,
      )
      setNotice(
        input.action === 'apply'
          ? `Edição registrada na versão ${result.version.sequence}. O novo proxy entrou na fila.`
          : `${input.action === 'undo' ? 'Undo' : 'Redo'} registrado como versão ${result.version.sequence}.`,
      )
      await loadWorkspace(true)
      await loadManualTimeline(true)
      await loadReview(true)
    } catch (error) {
      preservedPreviewTimeMs.current = null
      setNotice(error instanceof Error ? error.message : 'Não foi possível aplicar a edição manual.')
      await loadManualTimeline(true)
    } finally {
      setManualBusy(false)
    }
  }

  function selectManualClip(clip: ManualTimelineClipData): void {
    setManualSelectedClipId(clip.id)
    setManualInspector({ ...clip.inspector })
    const fps = review?.session.fps ?? editingProxy?.probe?.fps ?? 30
    seekPreviewToFrame(Math.round(clip.startMs / 1000 * fps))
  }

  function manualPointerDown(
    event: ReactPointerEvent<HTMLButtonElement>,
    clipId: string,
  ): void {
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
    if (!bounds) return
    manualDragStart.current = {
      clipId,
      clientX: event.clientX,
      boundsLeft: bounds.left,
      boundsWidth: bounds.width,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function manualPointerUp(event: ReactPointerEvent<HTMLButtonElement>): void {
    const drag = manualDragStart.current
    manualDragStart.current = null
    if (!drag || drag.clipId !== event.currentTarget.dataset.clipId) return
    const clip = manualTimeline?.timeline.clips.find((candidate) => candidate.id === drag.clipId)
    if (!clip || Math.abs(event.clientX - drag.clientX) < 8) {
      if (clip) selectManualClip(clip)
      return
    }
    const durationMs = Math.max(1, ...(manualTimeline?.timeline.clips.map((item) => item.endMs) ?? [1]))
    const startMs = Math.max(
      0,
      Math.min(durationMs - (clip.endMs - clip.startMs), (event.clientX - drag.boundsLeft) / drag.boundsWidth * durationMs),
    )
    void submitManualEdit({
      action: 'apply',
      operation: { kind: 'move', clipId: clip.id, startMs, track: clip.track },
    })
  }

  function manualKeyboard(event: React.KeyboardEvent<HTMLElement>): void {
    if (!manualSelectedClip || manualBusy) return
    const target = event.target as HTMLElement
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    const pointerMs = previewVideo.current
      ? Math.round(previewVideo.current.currentTime * 1000)
      : manualSelectedClip.startMs
    if (event.ctrlKey && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      const current = manualTimeline?.history.find((version) => version.id === manualTimeline.timeline.versionId)
      const targetVersionId = event.shiftKey
        ? (current?.action === 'undo' ? current.parentVersionId : undefined)
        : current?.parentVersionId
      if (targetVersionId) {
        void submitManualEdit({
          action: event.shiftKey ? 'redo' : 'undo',
          targetVersionId,
        })
      }
    } else if (event.key.toLowerCase() === 's') {
      event.preventDefault()
      void submitManualEdit({
        action: 'apply',
        operation: { kind: 'split', clipId: manualSelectedClip.id, atMs: pointerMs },
      })
    } else if (event.key === 'Delete') {
      event.preventDefault()
      void submitManualEdit({
        action: 'apply',
        operation: { kind: 'trim', clipId: manualSelectedClip.id, edge: 'end', atMs: pointerMs },
      })
    }
  }

  function submitManualInspector(): void {
    if (!manualSelectedClip) return
    const patch = Object.fromEntries(
      Object.entries(manualInspector).filter(([, value]) =>
        typeof value === 'number'
          ? Number.isFinite(value)
          : typeof value === 'string' && value.trim().length > 0),
    ) as ManualTimelineClipData['inspector']
    if (Object.keys(patch).length === 0) {
      setNotice('Informe ao menos um ajuste no inspector.')
      return
    }
    void submitManualEdit({
      action: 'apply',
      operation: { kind: 'inspect', clipId: manualSelectedClip.id, patch },
    })
  }

  async function loadVersionComparison(): Promise<void> {
    if (!compareBeforeVersionId || !compareAfterVersionId || compareBusy) return
    if (compareBeforeVersionId === compareAfterVersionId) {
      setNotice('Escolha duas versões diferentes para comparar.')
      return
    }
    setCompareBusy(true)
    setNotice(null)
    try {
      const query = new URLSearchParams({
        beforeVersionId: compareBeforeVersionId,
        afterVersionId: compareAfterVersionId,
        mode: compareMode,
      })
      const comparison = await requestJson<VersionComparisonData>(
        `/v1/projects/${encodeURIComponent(projectId)}/version-comparisons?${query.toString()}`,
      )
      const loadProxy = async (versionId: string): Promise<string | undefined> => {
        try {
          const reviewQuery = new URLSearchParams({ limit: '1', projectVersionId: versionId })
          const versionReview = await requestJson<ProjectReviewData>(
            `/v1/projects/${encodeURIComponent(projectId)}/annotations?${reviewQuery.toString()}`,
          )
          return versionReview.session.proxyUrl
        } catch {
          return undefined
        }
      }
      const [before, after] = await Promise.all([
        loadProxy(comparison.versions.before.id),
        loadProxy(comparison.versions.after.id),
      ])
      setVersionComparison(comparison)
      setComparePreviews({
        ...(before ? { before } : {}),
        ...(after ? { after } : {}),
      })
      setCompareToggleSide('after')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível comparar estas versões.')
    } finally {
      setCompareBusy(false)
    }
  }

  async function submitVersionComparisonAction(
    action: 'accept' | 'reopen' | 'restore',
  ): Promise<void> {
    if (!versionComparison || compareBusy) return
    setCompareBusy(true)
    setNotice(null)
    try {
      const result = await requestJson<{
        action: typeof action
        projectStatus?: string
        version?: { id: string; sequence: number }
      }>(
        `/v1/projects/${encodeURIComponent(projectId)}/version-comparisons`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `compare-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            action,
            beforeVersionId: versionComparison.versions.before.id,
            afterVersionId: versionComparison.versions.after.id,
            mode: versionComparison.comparison.mode,
            baseVersionId: versionComparison.current.versionId,
            baseHash: versionComparison.current.baseHash,
            expectedRevision: versionComparison.current.revision,
            variantId: workspace?.project.format ?? '9:16',
          }),
        },
      )
      setNotice(
        action === 'restore'
          ? `Versão anterior restaurada como V${result.version?.sequence ?? 'nova'}, sem apagar o histórico.`
          : action === 'accept'
            ? 'Comparação aceita e decisão registrada.'
            : 'Edição reaberta e decisão registrada.',
      )
      setVersionComparison(null)
      setComparePreviews({})
      await loadWorkspace(true)
      await loadManualTimeline(true)
      await loadReview(true)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível registrar a decisão da comparação.')
      await loadManualTimeline(true)
    } finally {
      setCompareBusy(false)
    }
  }

  function synchronizeComparedVideo(
    source: HTMLVideoElement,
    target: HTMLVideoElement | null,
  ): void {
    if (!versionComparison?.comparison.synchronized || !target) return
    if (Math.abs(target.currentTime - source.currentTime) > 0.08) {
      const maximum = Number.isFinite(target.duration)
        ? Math.max(0, target.duration - 0.001)
        : source.currentTime
      target.currentTime = Math.min(source.currentTime, maximum)
    }
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
    resetReviewElementResolution()
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

  function resetReviewElementResolution(): void {
    reviewElementLookup.current?.abort()
    reviewElementLookup.current = null
    setReviewElementResolution('idle')
    setReviewElementMap(null)
    setReviewElementCandidates([])
    setSelectedReviewElement(null)
    setReviewElementConfirmed(false)
  }

  async function resolveReviewElements(point: { x: number; y: number }, displayWidth: number, displayHeight: number): Promise<void> {
    const video = previewVideo.current
    if (!review || !video) return
    reviewElementLookup.current?.abort()
    const controller = new AbortController()
    reviewElementLookup.current = controller
    const identity = review.session
    const frame = Math.max(0, Math.min(identity.durationFrames - 1, Math.round(video.currentTime * identity.fps)))
    const query = new URLSearchParams({
      projectVersionId: identity.projectVersionId,
      proxyArtifactId: identity.proxyArtifactId,
      proxyHash: identity.proxyHash,
      frame: String(frame),
      x: String(point.x * displayWidth),
      y: String(point.y * displayHeight),
      displayWidth: String(displayWidth),
      displayHeight: String(displayHeight),
    })
    setReviewElementResolution('loading')
    setReviewElementMap(null)
    setReviewElementCandidates([])
    setSelectedReviewElement(null)
    setReviewElementConfirmed(false)
    try {
      const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/render-elements?${query.toString()}`, {
        headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal,
      })
      if (response.status === 401) { router.replace('/login'); return }
      const payload = await response.json() as ApiEnvelope<RenderElementHitTestData>
      if (response.status === 404) {
        setReviewElementResolution('unavailable')
        return
      }
      if (!response.ok || !payload.data) throw new Error(apiError(payload, 'Não foi possível identificar a camada renderizada.'))
      setReviewElementMap(payload.data.map)
      setReviewElementCandidates(payload.data.candidates)
      setSelectedReviewElement(payload.data.selected)
      setReviewElementConfirmed(!payload.data.chooserRequired)
      setReviewElementResolution('ready')
    } catch (error) {
      if (controller.signal.aborted) return
      setReviewElementResolution('error')
      setNotice(error instanceof Error ? error.message : 'Não foi possível identificar a camada renderizada.')
    } finally {
      if (reviewElementLookup.current === controller) reviewElementLookup.current = null
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
    const displayBounds = event.currentTarget.getBoundingClientRect()
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
    const anchor = region.width >= 0.015 && region.height >= 0.015
      ? { x: region.x + region.width / 2, y: region.y + region.height / 2 }
      : point
    void resolveReviewElements(anchor, displayBounds.width, displayBounds.height)
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
    resetReviewElementResolution()
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
    resetReviewElementResolution()
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
            targetIds: reviewScope === 'scene' ? [scene!.id] : selectedReviewElement && reviewElementConfirmed ? [selectedReviewElement.elementId] : [],
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

  async function proposeReviewPatch(annotationId: string, selectedChoiceId?: string): Promise<void> {
    setReviewPatchLoading(annotationId)
    setNotice(null)
    try {
      const result = await requestJson<{ proposal: ReviewPatchProposalData; replayed: boolean }>(
        `/v1/projects/${encodeURIComponent(projectId)}/patch-proposals`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ annotationId, ...(selectedChoiceId ? { selectedChoiceId } : {}) }),
        },
      )
      reviewPatchApplyKeyRef.current = null
      setReviewPatch(result.proposal)
      setNotice(result.proposal.status === 'ready'
        ? 'Proposta preparada. Revise o impacto antes de criar a nova versão.'
        : result.proposal.status === 'ambiguous'
          ? 'A annotation admite mais de uma leitura. Escolha a intenção correta.'
          : 'A proposta foi bloqueada antes de qualquer alteração no projeto.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível preparar o ajuste.')
    } finally {
      setReviewPatchLoading(null)
    }
  }

  async function applyReviewPatch(): Promise<void> {
    if (!reviewPatch || reviewPatch.status !== 'ready') return
    const idempotencyKey = reviewPatchApplyKeyRef.current?.proposalId === reviewPatch.id
      ? reviewPatchApplyKeyRef.current.key
      : crypto.randomUUID()
    reviewPatchApplyKeyRef.current = { proposalId: reviewPatch.id, key: idempotencyKey }
    setReviewPatchApplying(true)
    setNotice(null)
    try {
      const result = await requestJson<{ proposal: ReviewPatchProposalData; version: { id: string; sequence: number }; operation: PublicOperation; replayed: boolean }>(
        `/v1/projects/${encodeURIComponent(projectId)}/patch-proposals/${encodeURIComponent(reviewPatch.id)}/apply`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify({ confirmed: true }),
        },
      )
      setReviewPatch(result.proposal)
      setNotice(`Versão ${result.version.sequence} criada. O novo preview entrou na fila de renderização.`)
      await Promise.all([loadWorkspace(true), loadReview(true)])
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível aplicar o ajuste.')
    } finally {
      setReviewPatchApplying(false)
    }
  }

  function toggleReviewBatchAnnotation(annotationId: string): void {
    setReviewBatchSelection((current) => current.includes(annotationId)
      ? current.filter((id) => id !== annotationId)
      : [...current, annotationId])
    setReviewPatchBatch(null)
    reviewPatchBatchApplyKeyRef.current = null
  }

  async function prepareReviewPatchBatch(mode: 'all-or-nothing' | 'partial-retry'): Promise<void> {
    if (reviewBatchSelection.length < 2) return
    setReviewPatchBatchLoading(true)
    setNotice(null)
    try {
      const proposals = await Promise.all(reviewBatchSelection.map((annotationId) => requestJson<{ proposal: ReviewPatchProposalData; replayed: boolean }>(
        `/v1/projects/${encodeURIComponent(projectId)}/patch-proposals`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ annotationId }),
        },
      )))
      const blocked = proposals.find((result) => result.proposal.status !== 'ready')
      if (blocked) {
        setReviewPatch(blocked.proposal)
        setNotice(blocked.proposal.status === 'ambiguous'
          ? 'Uma annotation do lote precisa de decisão antes da compilação.'
          : 'Uma annotation do lote foi bloqueada pelos gates de segurança.')
        return
      }
      const result = await requestJson<{ batch: ReviewPatchBatchData; replayed: boolean }>(
        `/v1/projects/${encodeURIComponent(projectId)}/patch-batches`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
          body: JSON.stringify({ proposalIds: proposals.map((entry) => entry.proposal.id), mode }),
        },
      )
      reviewPatchBatchApplyKeyRef.current = null
      setReviewPatchBatch(result.batch)
      setNotice(result.batch.status === 'ready'
        ? 'Lote compatível. Revise o impacto único antes de criar a versão.'
        : result.batch.status === 'partial'
          ? 'Conflitos isolados. Somente o subconjunto não conflitante poderá ser aplicado.'
          : 'O lote foi revertido integralmente porque existem instruções conflitantes.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível preparar o lote de revisão.')
    } finally {
      setReviewPatchBatchLoading(false)
    }
  }

  async function applyReviewPatchBatch(): Promise<void> {
    if (!reviewPatchBatch || !['ready', 'partial'].includes(reviewPatchBatch.status)) return
    const idempotencyKey = reviewPatchBatchApplyKeyRef.current?.batchId === reviewPatchBatch.id
      ? reviewPatchBatchApplyKeyRef.current.key
      : crypto.randomUUID()
    reviewPatchBatchApplyKeyRef.current = { batchId: reviewPatchBatch.id, key: idempotencyKey }
    setReviewPatchBatchApplying(true)
    setNotice(null)
    try {
      const result = await requestJson<{ batch: ReviewPatchBatchData; version: { id: string; sequence: number }; operation: PublicOperation; replayed: boolean }>(
        `/v1/projects/${encodeURIComponent(projectId)}/patch-batches/${encodeURIComponent(reviewPatchBatch.id)}/apply`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
          body: JSON.stringify({ confirmed: true }),
        },
      )
      setReviewPatchBatch(result.batch)
      setReviewBatchSelection([])
      setNotice(`Versão ${result.version.sequence} criada com ${result.batch.items.filter((item) => item.status === 'applied').length} ajustes atômicos. O preview entrou na fila.`)
      await Promise.all([loadWorkspace(true), loadReview(true)])
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível aplicar o lote de revisão.')
    } finally {
      setReviewPatchBatchApplying(false)
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
    if (
      !workspace?.version ||
      !workspace.project.format ||
      !latestDirectorRun ||
      latestDirectorRun.resultVersionId !== workspace.version.id ||
      latestDirectorRun.status !== 'succeeded' ||
      latestDirectorRun.qualityStatus === 'blocked' ||
      proxyReview?.projectVersionId !== workspace.version.id ||
      !proxyReview.finalAllowed
    ) {
      setNotice('A exportação final exige o DirectorRun aprovado e o laudo do proxy liberado para esta versão.')
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

  async function acknowledgeProxyWarnings() {
    if (
      !workspace?.version ||
      !proxyReview ||
      proxyReview.projectVersionId !== workspace.version.id ||
      proxyReview.status !== 'warning-ack-required' ||
      proxyReviewBusy
    ) return
    setProxyReviewBusy(true)
    setNotice(null)
    try {
      const result = await requestJson<{ review: ProxyReviewData; replayed: boolean }>(
        `/v1/projects/${encodeURIComponent(projectId)}/proxy-reviews`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `proxy-warning-${crypto.randomUUID()}`,
          },
          body: JSON.stringify({
            action: 'acknowledge-warnings',
            proxyReviewId: proxyReview.id,
            projectVersionId: workspace.version.id,
            baseRevision: proxyReview.reviewHash,
            expectedRevision: proxyReview.revision,
          }),
        },
      )
      setProxyReview(result.review)
      setNotice('Ressalvas registradas. Esta versão está liberada para o render final.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível registrar a decisão sobre as ressalvas.')
      await loadProxyReview(true, workspace.version.id)
    } finally {
      setProxyReviewBusy(false)
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
  const manualDurationMs = Math.max(
    1,
    ...(manualTimeline?.timeline.clips.map((clip) => clip.endMs) ?? [1]),
  )
  const currentManualHistory = manualTimeline?.history.find(
    (version) => version.id === manualTimeline.timeline.versionId,
  )
  const undoTargetVersionId = currentManualHistory?.parentVersionId
  const redoTargetVersionId = currentManualHistory?.action === 'undo'
    ? currentManualHistory.parentVersionId
    : undefined

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
            {latestDirectorRun?.status === 'succeeded' && latestDirectorRun.resultVersionId === workspace.version?.id && latestDirectorRun.qualityStatus !== 'blocked' ? <button className="mt-2 w-full rounded-lg border border-[#62b47d]/25 bg-[#62b47d]/10 px-3 py-2.5 text-xs font-semibold text-[#8bd0a2] transition hover:bg-[#62b47d]/15 disabled:cursor-not-allowed disabled:opacity-45" disabled={exportRunning || proxyReview?.projectVersionId !== workspace.version?.id || !proxyReview.finalAllowed || Boolean(activeOperation && ['queued', 'running', 'waiting', 'retrying'].includes(activeOperation.status))} onClick={() => void exportFinal()} type="button">{exportRunning ? 'Registrando aprovação…' : proxyReview?.finalAllowed ? finalOutput ? 'Exportar novamente em alta resolução' : 'Aprovar e exportar MP4 final' : 'Aguardando liberação do proxy'}</button> : null}
            {finalOutput ? <a className="mt-2 block w-full rounded-lg border border-white/[0.08] px-3 py-2.5 text-center text-xs text-[#aaa49a] transition hover:border-white/[0.16] hover:text-white" download={finalOutput.originalFileName} href={`/v1/artifacts/${encodeURIComponent(finalOutput.artifactId)}/content`}>Baixar MP4 final</a> : null}
          </div>
          <div className="mt-5 overflow-hidden rounded-xl border border-white/[0.07] bg-[#0d0d0d]" data-testid="proxy-review-gate">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
              <div>
                <p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-[#716d65]">Laudo do proxy</p>
                <p className="mt-1 text-xs font-medium text-[#d8d2c8]">
                  {!proxyReview ? 'Aguardando materialização' : proxyReview.status === 'blocked' ? 'Correção obrigatória' : proxyReview.status === 'warning-ack-required' ? 'Ressalvas para decidir' : 'Liberado para alta'}
                </p>
              </div>
              <span
                className={`h-2.5 w-2.5 rounded-full ${!proxyReview ? 'bg-[#46433e]' : proxyReview.status === 'blocked' ? 'bg-[#d46868] shadow-[0_0_10px_rgba(212,104,104,.5)]' : proxyReview.status === 'warning-ack-required' ? 'bg-[#d9aa3d] shadow-[0_0_10px_rgba(217,170,61,.45)]' : 'bg-[#63ba84] shadow-[0_0_10px_rgba(99,186,132,.45)]'}`}
              />
            </div>
            {proxyReview ? (
              <div className="p-4">
                <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                  <div><p className="text-[8px] uppercase tracking-[0.14em] text-[#625f58]">Cópia de revisão</p><p className="mt-1 font-mono text-[10px] text-[#aaa49a]">{proxyReview.spec.codec.toUpperCase()} · {proxyReview.spec.width}×{proxyReview.spec.height}</p></div>
                  <div><p className="text-[8px] uppercase tracking-[0.14em] text-[#625f58]">Primeiro proxy</p><p className="mt-1 font-mono text-[10px] text-[#aaa49a]">{(proxyReview.timeToFirstProxyMs / 1000).toFixed(1)}s</p></div>
                  <div><p className="text-[8px] uppercase tracking-[0.14em] text-[#625f58]">Bloqueios</p><p className="mt-1 font-mono text-[10px] text-[#d57c7c]">{[...proxyReview.technicalIssues, ...proxyReview.criticIssues].filter((issue) => issue.severity === 'hard').length}</p></div>
                  <div><p className="text-[8px] uppercase tracking-[0.14em] text-[#625f58]">Ressalvas</p><p className="mt-1 font-mono text-[10px] text-[#d3af5d]">{[...proxyReview.technicalIssues, ...proxyReview.criticIssues].filter((issue) => issue.severity === 'warning').length}</p></div>
                </div>
                {[...proxyReview.technicalIssues, ...proxyReview.criticIssues].length ? (
                  <div className="mt-3 space-y-1.5" data-testid="proxy-review-issues">
                    {[...proxyReview.technicalIssues, ...proxyReview.criticIssues].slice(0, 4).map((issue) => (
                      <div className="flex items-start gap-2 border-l border-white/[0.09] pl-2 text-[9px] leading-4 text-[#8e8980]" key={`${issue.code}:${issue.targetId ?? 'proxy'}`}>
                        <span className={issue.severity === 'hard' ? 'text-[#dc7777]' : 'text-[#d5ae52]'}>{issue.severity === 'hard' ? '!' : '△'}</span>
                        <span>{issue.message}</span>
                      </div>
                    ))}
                  </div>
                ) : <p className="mt-3 text-[9px] leading-4 text-[#78aa87]">Codec, canvas, duração, mapa e crítica editorial aprovados.</p>}
                {proxyReview.status === 'warning-ack-required' ? (
                  <button
                    className="mt-4 w-full rounded-lg border border-[#d9aa3d]/25 bg-[#d9aa3d]/[0.08] px-3 py-2.5 text-[10px] font-semibold text-[#d8b45c] transition hover:bg-[#d9aa3d]/[0.13] disabled:opacity-45"
                    data-testid="proxy-review-acknowledge"
                    disabled={proxyReviewBusy}
                    onClick={() => void acknowledgeProxyWarnings()}
                    type="button"
                  >
                    {proxyReviewBusy ? 'Registrando decisão…' : 'Estou ciente · liberar render final'}
                  </button>
                ) : null}
                <p className="mt-3 truncate font-mono text-[7px] text-[#4f4c47]" title={proxyReview.rangeCacheKey}>range {proxyReview.rangeCacheKey.slice(0, 16)}</p>
              </div>
            ) : <p className="px-4 py-4 text-[9px] leading-4 text-[#716d65]">O render editorial criará uma cópia leve e reutilizável antes de qualquer exportação final.</p>}
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
                  {reviewMode === 'composing' && reviewElementMap ? reviewElementCandidates.map((candidate) => {
                    const selected = selectedReviewElement?.elementId === candidate.elementId
                    return (
                      <span
                        aria-hidden="true"
                        className={`absolute ${selected ? 'border-2 border-[#f0bd42] bg-[#f0bd42]/[0.08] shadow-[0_0_18px_rgba(224,174,57,.22)]' : 'border border-dashed border-[#d8ad49]/35 bg-[#d8ad49]/[0.025]'}`}
                        key={candidate.elementId}
                        style={{
                          left: `${candidate.bounds.x / reviewElementMap.canvas.width * 100}%`,
                          top: `${candidate.bounds.y / reviewElementMap.canvas.height * 100}%`,
                          width: `${candidate.bounds.width / reviewElementMap.canvas.width * 100}%`,
                          height: `${candidate.bounds.height / reviewElementMap.canvas.height * 100}%`,
                        }}
                      >
                        {selected ? <i className="absolute -top-5 left-0 bg-[#e0ae39] px-1.5 py-0.5 font-mono text-[7px] not-italic uppercase tracking-[0.12em] text-black">{RENDER_ELEMENT_LABELS[candidate.type]}</i> : null}
                      </span>
                    )
                  }) : null}
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

          {manualTimeline?.timeline.clips.length ? (
            <section
              aria-label="Editor manual da timeline"
              className="mt-5 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#090909]"
              data-testid="manual-editor"
              onKeyDown={manualKeyboard}
              tabIndex={0}
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#d9aa3d]" />
                    <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#b58d31]">Timeline manual V2</p>
                  </div>
                  <p className="mt-1 text-[10px] text-[#706c64]">
                    V{manualTimeline.timeline.revision} · snap 120 ms · S divide · Delete apara · Ctrl+Z desfaz
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="border border-white/[0.08] px-3 py-2 text-[9px] text-[#918b82] hover:border-white/[0.18] hover:text-white disabled:opacity-30"
                    data-testid="manual-undo"
                    disabled={manualBusy || !undoTargetVersionId}
                    onClick={() => undoTargetVersionId && void submitManualEdit({ action: 'undo', targetVersionId: undoTargetVersionId })}
                    type="button"
                  >
                    ↶ Desfazer
                  </button>
                  <button
                    className="border border-white/[0.08] px-3 py-2 text-[9px] text-[#918b82] hover:border-white/[0.18] hover:text-white disabled:opacity-30"
                    data-testid="manual-redo"
                    disabled={manualBusy || !redoTargetVersionId}
                    onClick={() => redoTargetVersionId && void submitManualEdit({ action: 'redo', targetVersionId: redoTargetVersionId })}
                    type="button"
                  >
                    ↷ Refazer
                  </button>
                </div>
              </div>

              <div className="border-b border-white/[0.07] bg-[#050505] px-4 py-4">
                <div className="mb-2 flex justify-between font-mono text-[8px] text-[#4f4c47]">
                  <span>00:00</span>
                  <span>{(manualDurationMs / 1000).toFixed(1)}s</span>
                </div>
                <div className="relative h-16 overflow-hidden border border-white/[0.07] bg-[#0d0d0d]" data-testid="manual-track">
                  <span className="absolute inset-y-0 left-0 z-10 w-12 border-r border-white/[0.08] bg-[#111] px-2 pt-2 text-[7px] uppercase tracking-[0.12em] text-[#5f5a53]">V1</span>
                  <div className="absolute inset-y-0 left-12 right-0">
                    {manualTimeline.timeline.clips.map((clip, index) => {
                      const selected = clip.id === manualSelectedClipId
                      return (
                        <button
                          aria-pressed={selected}
                          className={`absolute inset-y-2 overflow-hidden border px-2 text-left transition ${selected ? 'z-10 border-[#e2b344]/70 bg-[#a47a24]/25 text-[#eccb7b] shadow-[0_0_18px_rgba(220,170,54,.12)]' : 'border-white/[0.1] bg-[#181818] text-[#8d887f] hover:border-[#d9aa3d]/35'}`}
                          data-clip-id={clip.id}
                          data-testid={`manual-clip-${clip.id}`}
                          key={clip.id}
                          onPointerDown={(event) => manualPointerDown(event, clip.id)}
                          onPointerUp={manualPointerUp}
                          style={{
                            left: `${clip.startMs / manualDurationMs * 100}%`,
                            width: `${Math.max(2.5, (clip.endMs - clip.startMs) / manualDurationMs * 100)}%`,
                          }}
                          title={`${clip.id} · ${(clip.endMs - clip.startMs) / 1000}s`}
                          type="button"
                        >
                          <span className="block truncate font-mono text-[8px]">{index + 1} · {clip.id}</span>
                          <span className="mt-1 block truncate text-[7px] text-[#67625b]">{(clip.endMs - clip.startMs).toFixed(0)} ms</span>
                        </button>
                      )
                    })}
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 z-20 w-px bg-[#e7b642] shadow-[0_0_7px_rgba(231,182,66,.5)]"
                      style={{ left: `${Math.min(100, previewFrame / (review?.session.fps ?? editingProxy?.probe?.fps ?? 30) * 1000 / manualDurationMs * 100)}%` }}
                    />
                  </div>
                </div>
              </div>

              {manualSelectedClip ? (
                <div className="grid lg:grid-cols-[minmax(0,1fr)_280px]">
                  <div className="border-b border-white/[0.07] p-4 lg:border-b-0 lg:border-r">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mr-auto font-mono text-[9px] text-[#8a847b]" data-testid="manual-selected-clip">{manualSelectedClip.id}</span>
                      <button
                        className="border border-white/[0.09] px-3 py-2 text-[9px] text-[#aaa49a] hover:border-[#d9aa3d]/40 hover:text-white disabled:opacity-30"
                        disabled={manualBusy}
                        onClick={() => void submitManualEdit({ action: 'apply', operation: { kind: 'trim', clipId: manualSelectedClip.id, edge: 'start', atMs: Math.round((previewVideo.current?.currentTime ?? manualSelectedClip.startMs / 1000) * 1000) } })}
                        type="button"
                      >
                        Aparar início
                      </button>
                      <button
                        className="border border-white/[0.09] px-3 py-2 text-[9px] text-[#aaa49a] hover:border-[#d9aa3d]/40 hover:text-white disabled:opacity-30"
                        disabled={manualBusy}
                        onClick={() => void submitManualEdit({ action: 'apply', operation: { kind: 'split', clipId: manualSelectedClip.id, atMs: Math.round((previewVideo.current?.currentTime ?? manualSelectedClip.startMs / 1000) * 1000) } })}
                        type="button"
                      >
                        Dividir no cursor
                      </button>
                      <button
                        className="border border-white/[0.09] px-3 py-2 text-[9px] text-[#aaa49a] hover:border-[#d9aa3d]/40 hover:text-white disabled:opacity-30"
                        disabled={manualBusy}
                        onClick={() => void submitManualEdit({ action: 'apply', operation: { kind: 'trim', clipId: manualSelectedClip.id, edge: 'end', atMs: Math.round((previewVideo.current?.currentTime ?? manualSelectedClip.endMs / 1000) * 1000) } })}
                        type="button"
                      >
                        Aparar fim
                      </button>
                      <label className="flex items-center gap-2 border border-white/[0.09] px-3 py-1.5 text-[8px] uppercase tracking-[0.1em] text-[#706b63]">
                        Substituir
                        <select
                          className="max-w-36 bg-transparent text-[9px] normal-case text-[#b3ada4] outline-none"
                          data-testid="manual-replace"
                          disabled={manualBusy}
                          onChange={(event) => {
                            if (event.target.value && event.target.value !== manualSelectedClip.sourceId) {
                              void submitManualEdit({ action: 'apply', operation: { kind: 'replace', clipId: manualSelectedClip.id, sourceId: event.target.value } })
                            }
                          }}
                          value={manualSelectedClip.sourceId}
                        >
                          {sourceMasters.map((media) => <option className="bg-[#111]" key={media.artifactId} value={media.artifactId}>{media.originalFileName}</option>)}
                        </select>
                      </label>
                    </div>
                    <p className="mt-3 text-[9px] leading-4 text-[#5f5a53]">
                      Arraste o clipe para reordenar. O gesto vira uma Command com base, revision e scope; o servidor retima a trilha e cria uma versão filha.
                    </p>
                  </div>

                  <div className="p-4" data-testid="manual-inspector">
                    <div className="flex items-center justify-between">
                      <p className="text-[8px] font-semibold uppercase tracking-[0.17em] text-[#827b70]">Inspector</p>
                      <span className="text-[7px] uppercase tracking-[0.12em] text-[#4e4a45]">layout · texto · cor · motion · áudio</span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {([
                        ['layout', 'Layout'], ['text', 'Texto'], ['subtitle', 'Legenda'],
                        ['color', 'Cor / LUT'], ['motion', 'Movimento'],
                      ] as const).map(([field, label]) => (
                        <label className={field === 'text' ? 'col-span-2' : ''} key={field}>
                          <span className="mb-1 block text-[7px] uppercase tracking-[0.12em] text-[#55514c]">{label}</span>
                          <input
                            className="w-full border border-white/[0.08] bg-[#050505] px-2 py-2 text-[9px] text-[#b7b0a7] outline-none focus:border-[#d9aa3d]/45"
                            onChange={(event) => setManualInspector((current) => ({ ...current, [field]: event.target.value }))}
                            placeholder={label}
                            value={manualInspector[field] ?? ''}
                          />
                        </label>
                      ))}
                      <label>
                        <span className="mb-1 block text-[7px] uppercase tracking-[0.12em] text-[#55514c]">Ganho</span>
                        <input
                          className="w-full border border-white/[0.08] bg-[#050505] px-2 py-2 text-[9px] text-[#b7b0a7] outline-none focus:border-[#d9aa3d]/45"
                          max="4"
                          min="0"
                          onChange={(event) => setManualInspector((current) => ({ ...current, audioGain: Number(event.target.value) }))}
                          step="0.05"
                          type="number"
                          value={manualInspector.audioGain ?? 1}
                        />
                      </label>
                    </div>
                    <button
                      className="mt-3 w-full bg-[#dbae3f] px-3 py-2 text-[9px] font-bold text-[#171207] disabled:opacity-35"
                      data-testid="manual-inspector-apply"
                      disabled={manualBusy}
                      onClick={submitManualInspector}
                      type="button"
                    >
                      {manualBusy ? 'Criando versão…' : 'Aplicar inspector'}
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {manualTimeline && manualTimeline.history.length >= 2 ? (
            <section
              aria-label="Comparar versões"
              className="mt-5 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#090909]"
              data-testid="version-compare"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#7167ff]" />
                    <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#9a92ff]">Compare imutável</p>
                  </div>
                  <p className="mt-1 text-[10px] text-[#706c64]">Antes/depois com playhead compartilhado somente quando o mapping é compatível.</p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label>
                    <span className="mb-1 block text-[7px] uppercase tracking-[0.12em] text-[#55514c]">Antes</span>
                    <select
                      className="border border-white/[0.09] bg-[#050505] px-2 py-2 text-[9px] text-[#aaa49a]"
                      data-testid="compare-before"
                      onChange={(event) => {
                        setCompareBeforeVersionId(event.target.value)
                        setVersionComparison(null)
                      }}
                      value={compareBeforeVersionId ?? ''}
                    >
                      {manualTimeline.history.map((version) => (
                        <option className="bg-[#111]" key={version.id} value={version.id}>V{version.sequence}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span className="mb-1 block text-[7px] uppercase tracking-[0.12em] text-[#55514c]">Depois</span>
                    <select
                      className="border border-white/[0.09] bg-[#050505] px-2 py-2 text-[9px] text-[#aaa49a]"
                      data-testid="compare-after"
                      onChange={(event) => {
                        setCompareAfterVersionId(event.target.value)
                        setVersionComparison(null)
                      }}
                      value={compareAfterVersionId ?? ''}
                    >
                      {manualTimeline.history.map((version) => (
                        <option className="bg-[#111]" key={version.id} value={version.id}>V{version.sequence}</option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="bg-[#7167ff] px-4 py-2 text-[9px] font-bold text-white disabled:opacity-35"
                    data-testid="compare-load"
                    disabled={compareBusy || !compareBeforeVersionId || !compareAfterVersionId || compareBeforeVersionId === compareAfterVersionId}
                    onClick={() => void loadVersionComparison()}
                    type="button"
                  >
                    {compareBusy ? 'Comparando…' : 'Comparar'}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.07] px-4 py-3">
                {(['toggle', 'split', 'overlay'] as const).map((mode) => (
                  <button
                    aria-pressed={compareMode === mode}
                    className={`border px-3 py-2 text-[8px] uppercase tracking-[0.12em] ${compareMode === mode ? 'border-[#7167ff]/60 bg-[#7167ff]/15 text-[#b9b4ff]' : 'border-white/[0.08] text-[#777168]'}`}
                    data-testid={`compare-mode-${mode}`}
                    key={mode}
                    onClick={() => {
                      setCompareMode(mode)
                      setVersionComparison(null)
                    }}
                    type="button"
                  >
                    {mode}
                  </button>
                ))}
                {versionComparison ? (
                  <span className={`ml-auto border px-3 py-1.5 font-mono text-[8px] ${versionComparison.comparison.synchronized ? 'border-[#63ba84]/30 text-[#75c992]' : 'border-[#d9aa3d]/30 text-[#d7b35f]'}`} data-testid="compare-sync-state">
                    {versionComparison.comparison.synchronized ? 'playhead compartilhado' : 'timelines independentes'}
                  </span>
                ) : null}
              </div>

              {versionComparison ? (
                <div data-testid="compare-result">
                  <div className="grid gap-3 border-b border-white/[0.07] p-4 sm:grid-cols-3">
                    <div className="border border-white/[0.07] bg-[#050505] p-3">
                      <p className="text-[7px] uppercase tracking-[0.13em] text-[#5f5a53]">Duração</p>
                      <p className="mt-1 font-mono text-sm text-[#d5cec4]">{versionComparison.comparison.durationDeltaMs >= 0 ? '+' : ''}{(versionComparison.comparison.durationDeltaMs / 1000).toFixed(2)}s</p>
                    </div>
                    <div className="border border-white/[0.07] bg-[#050505] p-3">
                      <p className="text-[7px] uppercase tracking-[0.13em] text-[#5f5a53]">Score</p>
                      <p className="mt-1 font-mono text-sm text-[#d5cec4]">{versionComparison.comparison.scoreDelta >= 0 ? '+' : ''}{versionComparison.comparison.scoreDelta.toFixed(2)}</p>
                    </div>
                    <div className="border border-white/[0.07] bg-[#050505] p-3">
                      <p className="text-[7px] uppercase tracking-[0.13em] text-[#5f5a53]">Issues</p>
                      <p className="mt-1 font-mono text-sm text-[#d5cec4]">{versionComparison.comparison.issuesResolved.length} resolvidas · {versionComparison.comparison.issuesAdded.length} novas</p>
                    </div>
                  </div>

                  <div className="border-b border-white/[0.07] bg-[#030303] p-4">
                    {compareMode === 'toggle' ? (
                      <div>
                        <div className="mb-3 flex justify-center gap-2">
                          {(['before', 'after'] as const).map((side) => (
                            <button
                              aria-pressed={compareToggleSide === side}
                              className={`border px-4 py-2 text-[8px] uppercase ${compareToggleSide === side ? 'border-[#7167ff]/60 bg-[#7167ff]/15 text-[#c1bcff]' : 'border-white/[0.08] text-[#716d66]'}`}
                              key={side}
                              onClick={() => setCompareToggleSide(side)}
                              type="button"
                            >
                              {side === 'before' ? `Antes · V${versionComparison.versions.before.sequence}` : `Depois · V${versionComparison.versions.after.sequence}`}
                            </button>
                          ))}
                        </div>
                        {comparePreviews[compareToggleSide] ? (
                          <video
                            className="mx-auto max-h-[440px] w-full bg-black object-contain"
                            controls
                            data-testid="compare-toggle-video"
                            key={`${compareToggleSide}:${comparePreviews[compareToggleSide]}`}
                            ref={compareToggleSide === 'before' ? compareBeforeVideo : compareAfterVideo}
                            src={comparePreviews[compareToggleSide]}
                          />
                        ) : <p className="py-16 text-center text-[10px] text-[#5f5a53]">Esta versão ainda não possui proxy revisável.</p>}
                      </div>
                    ) : compareMode === 'split' ? (
                      <div className="grid gap-2 md:grid-cols-2" data-testid="compare-split-preview">
                        {(['before', 'after'] as const).map((side) => {
                          const preview = comparePreviews[side]
                          const target = side === 'before' ? compareAfterVideo : compareBeforeVideo
                          return (
                            <div className="overflow-hidden border border-white/[0.08] bg-black" key={side}>
                              <p className="border-b border-white/[0.07] bg-[#0b0b0b] px-3 py-2 font-mono text-[8px] text-[#777168]">
                                {side === 'before' ? `ANTES · V${versionComparison.versions.before.sequence}` : `DEPOIS · V${versionComparison.versions.after.sequence}`}
                              </p>
                              {preview ? (
                                <video
                                  className="aspect-video w-full object-contain"
                                  controls
                                  muted
                                  onPause={() => { if (versionComparison.comparison.synchronized) target.current?.pause() }}
                                  onPlay={() => { if (versionComparison.comparison.synchronized) void target.current?.play() }}
                                  onTimeUpdate={(event) => synchronizeComparedVideo(event.currentTarget, target.current)}
                                  ref={side === 'before' ? compareBeforeVideo : compareAfterVideo}
                                  src={preview}
                                />
                              ) : <p className="py-16 text-center text-[10px] text-[#5f5a53]">Proxy indisponível</p>}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div>
                        <div className="relative mx-auto aspect-video max-h-[520px] overflow-hidden bg-black" data-testid="compare-overlay-preview">
                          {comparePreviews.before ? (
                            <video
                              className="absolute inset-0 h-full w-full object-contain"
                              controls
                              muted
                              onTimeUpdate={(event) => synchronizeComparedVideo(event.currentTarget, compareAfterVideo.current)}
                              ref={compareBeforeVideo}
                              src={comparePreviews.before}
                            />
                          ) : null}
                          {comparePreviews.after ? (
                            <video
                              aria-label="Versão depois sobreposta"
                              className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                              muted
                              ref={compareAfterVideo}
                              src={comparePreviews.after}
                              style={{ opacity: compareOverlayOpacity }}
                            />
                          ) : null}
                        </div>
                        <label className="mx-auto mt-3 flex max-w-lg items-center gap-3 text-[8px] uppercase tracking-[0.12em] text-[#6d6860]">
                          Antes
                          <input
                            className="w-full accent-[#7167ff]"
                            max="1"
                            min="0"
                            onChange={(event) => setCompareOverlayOpacity(Number(event.target.value))}
                            step="0.05"
                            type="range"
                            value={compareOverlayOpacity}
                          />
                          Depois
                        </label>
                      </div>
                    )}
                  </div>

                  <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                    <div>
                      <p className="text-[8px] font-semibold uppercase tracking-[0.17em] text-[#827b70]">Diff semântico</p>
                      <div className="mt-2 space-y-1.5" data-testid="compare-semantic-diff">
                        {versionComparison.comparison.semanticChanges.length ? versionComparison.comparison.semanticChanges.map((change, index) => (
                          <div className="flex gap-3 border border-white/[0.06] bg-[#050505] px-3 py-2 text-[9px]" key={`${change.category}:${change.target}:${index}`}>
                            <span className="font-mono uppercase text-[#7167ff]">{change.category}</span>
                            <span className="text-[#9d978e]">{change.summary}</span>
                            <span className="ml-auto truncate font-mono text-[#55514c]">{change.target}</span>
                          </div>
                        )) : <p className="text-[9px] text-[#5f5a53]">Nenhuma alteração semântica detectada.</p>}
                      </div>
                    </div>
                    <div className="border border-white/[0.07] bg-[#050505] p-3">
                      <p className="text-[8px] font-semibold uppercase tracking-[0.17em] text-[#827b70]">Decisão</p>
                      <p className="mt-2 text-[9px] leading-4 text-[#625e57]">Aceitar e reabrir registram Command. Restaurar cria uma nova child version; A e B permanecem intactas.</p>
                      <div className="mt-3 grid gap-2">
                        <button className="bg-[#7167ff] px-3 py-2 text-[9px] font-bold text-white disabled:opacity-35" data-testid="compare-accept" disabled={compareBusy || versionComparison.versions.after.id !== versionComparison.current.versionId} onClick={() => void submitVersionComparisonAction('accept')} type="button">Aceitar depois</button>
                        <button className="border border-white/[0.1] px-3 py-2 text-[9px] text-[#aaa49a] disabled:opacity-35" data-testid="compare-reopen" disabled={compareBusy || versionComparison.versions.after.id !== versionComparison.current.versionId} onClick={() => void submitVersionComparisonAction('reopen')} type="button">Reabrir edição</button>
                        <button className="border border-[#d9aa3d]/30 px-3 py-2 text-[9px] text-[#d7b35f] disabled:opacity-35" data-testid="compare-restore" disabled={compareBusy || versionComparison.versions.after.id !== versionComparison.current.versionId} onClick={() => void submitVersionComparisonAction('restore')} type="button">Restaurar antes como nova versão</button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>
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
                    <div className="mt-2 border border-white/[0.08] bg-[#050505] px-3 py-3" data-testid="review-layer-resolver">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-[8px] font-semibold uppercase tracking-[0.17em] text-[#777168]">Camada sob a marcação</p>
                        {reviewElementMap ? <span className="font-mono text-[7px] text-[#4f4b45]" title={reviewElementMap.mapHash}>mapa {reviewElementMap.mapHash.slice(0, 8)}</span> : null}
                      </div>
                      {reviewElementResolution === 'loading' ? <p className="mt-2 text-[10px] text-[#a8873c]">Lendo as camadas deste frame…</p> : null}
                      {reviewElementResolution === 'unavailable' ? <p className="mt-2 text-[10px] leading-4 text-[#777168]">Esta versão histórica ainda não possui mapa de camadas. A anotação será registrada sem vínculo de elemento.</p> : null}
                      {reviewElementResolution === 'error' ? <p className="mt-2 text-[10px] leading-4 text-[#c97870]">A identidade do mapa não confere com o preview. Reabra a versão antes de registrar.</p> : null}
                      {reviewElementResolution === 'ready' && reviewElementCandidates.length === 0 ? <p className="mt-2 text-[10px] text-[#777168]">Nenhuma camada elegível neste ponto.</p> : null}
                      {reviewElementResolution === 'ready' && reviewElementCandidates.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5" role={reviewElementCandidates.length > 1 ? 'radiogroup' : undefined} aria-label="Escolha a camada do ajuste">
                          {reviewElementCandidates.map((candidate) => {
                            const selected = selectedReviewElement?.elementId === candidate.elementId
                            return (
                              <button
                                aria-checked={reviewElementCandidates.length > 1 ? selected && reviewElementConfirmed : undefined}
                                className={`border px-2.5 py-2 text-left transition ${selected && reviewElementConfirmed ? 'border-[#d9aa3d]/70 bg-[#d9aa3d]/12 text-[#e4bd62]' : selected ? 'border-[#d9aa3d]/35 bg-[#d9aa3d]/[0.05] text-[#bda15e]' : 'border-white/[0.08] text-[#777168] hover:border-white/[0.18] hover:text-[#c9c3b9]'}`}
                                data-testid="review-layer-option"
                                key={candidate.elementId}
                                onClick={() => { setSelectedReviewElement(candidate); setReviewElementConfirmed(true) }}
                                role={reviewElementCandidates.length > 1 ? 'radio' : undefined}
                                type="button"
                              >
                                <span className="block text-[9px] font-semibold">{RENDER_ELEMENT_LABELS[candidate.type]}</span>
                                <span className="mt-0.5 block font-mono text-[7px] text-[#5f5a52]">{candidate.clipId}</span>
                              </button>
                            )
                          })}
                        </div>
                      ) : null}
                      {reviewElementResolution === 'ready' && reviewElementCandidates.length > 1 && !reviewElementConfirmed ? <p className="mt-2 text-[9px] text-[#ad8c45]">Há camadas sobrepostas. Confirme qual delas deve receber o ajuste.</p> : null}
                    </div>
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
                    <div><p className="font-mono text-[10px] text-[#d8ad49]">{frameTimecode(previewFrame, review.session.fps)}</p>{selectedReviewElement && reviewElementConfirmed ? <p className="mt-2 text-[9px] font-medium uppercase tracking-[0.1em] text-[#a88842]">{RENDER_ELEMENT_LABELS[selectedReviewElement.type]} · {selectedReviewElement.sceneId}</p> : null}<p className="mt-2 text-[10px] leading-4 text-[#6f6b63]">Versão {review.versions.find((version) => version.id === review.session.projectVersionId)?.sequence ?? '—'} · {reviewGlobal ? `${selectedApplicationScopeOption?.affectedCount ?? 0} alvos declarados` : '1 alvo no formato e idioma atuais'}.</p></div>
                    <div className="mt-5 flex gap-2"><button className="flex-1 border border-white/[0.09] px-3 py-2 text-[10px] text-[#8b867d] hover:text-white" onClick={cancelReview} type="button">Cancelar</button><button className="flex-1 bg-[#dbae3f] px-3 py-2 text-[10px] font-bold text-[#171207] disabled:opacity-35" data-testid="review-save" disabled={reviewSaving || !reviewText.trim() || !selectedApplicationScopeOption?.enabled || (reviewGlobal && !reviewGlobalConfirmed) || reviewElementResolution === 'loading' || reviewElementResolution === 'error' || (reviewElementCandidates.length > 1 && !reviewElementConfirmed)} onClick={() => void saveReviewAnnotation()} type="button">{reviewSaving ? 'Salvando…' : 'Registrar'}</button></div>
                  </div>
                </div>
              ) : null}

              <div className="mt-5 border-t border-white/[0.07] pt-4">
                <div className="flex items-center justify-between"><p className="text-[9px] uppercase tracking-[0.17em] text-[#706c64]">Ajustes desta versão</p><span className="text-[9px] text-[#55524c]">{review.annotations.filter((item) => item.status === 'open').length} aberto{review.annotations.filter((item) => item.status === 'open').length === 1 ? '' : 's'}</span></div>
                {reviewBatchSelection.length ? (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border border-[#8f6c22]/30 bg-[#0c0a06] px-3 py-2.5" data-testid="review-batch-toolbar">
                    <div className="flex items-center gap-3"><span className="grid h-6 w-6 place-items-center rounded-full border border-[#bd8f29]/40 font-mono text-[9px] text-[#e0b852]">{reviewBatchSelection.length}</span><div><p className="text-[9px] font-medium text-[#c5bdaf]">Ajustes selecionados</p><p className="mt-0.5 text-[8px] text-[#666056]">O lote padrão é integral: conflito não altera nenhuma annotation.</p></div></div>
                    <div className="flex flex-wrap gap-2">
                      <button className="border border-white/[0.1] px-3 py-2 text-[9px] text-[#aaa49a] hover:border-[#a8802f]/50 hover:text-[#dfb752] disabled:opacity-30" disabled={reviewPatchBatchLoading || reviewBatchSelection.length < 2} onClick={() => void prepareReviewPatchBatch('partial-retry')} type="button">Separar conflitos</button>
                      <button className="bg-[#dbae3f] px-3 py-2 text-[9px] font-bold text-[#171207] disabled:opacity-30" data-testid="review-batch-prepare" disabled={reviewPatchBatchLoading || reviewBatchSelection.length < 2} onClick={() => void prepareReviewPatchBatch('all-or-nothing')} type="button">{reviewPatchBatchLoading ? 'Compilando…' : 'Preparar lote'}</button>
                    </div>
                  </div>
                ) : null}
                {review.annotations.length ? (
                  <div className="mt-3 grid gap-px bg-white/[0.06] sm:grid-cols-2">
                    {review.annotations.slice(0, 6).map((annotation) => (
                      <article className={`bg-[#090909] px-3 py-3 transition ${reviewPatch?.annotationId === annotation.id || reviewBatchSelection.includes(annotation.id) ? 'shadow-[inset_2px_0_0_#d9aa3d]' : ''}`} data-testid={`review-annotation-${annotation.id}`} key={annotation.id}>
                        <div className="flex items-start gap-2.5">
                          {annotation.status === 'open' ? <input aria-label={`Selecionar ajuste ${frameTimecode(annotation.frame, review.session.fps)}`} checked={reviewBatchSelection.includes(annotation.id)} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[#d9aa3d]" data-testid={`review-batch-select-${annotation.id}`} onChange={() => toggleReviewBatchAnnotation(annotation.id)} type="checkbox" /> : <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[#4e9568]" />}
                          <button className="block min-w-0 flex-1 text-left hover:text-white" onClick={() => seekPreviewToFrame(annotation.frame)} type="button">
                            <span className="font-mono text-[9px] text-[#b8943e]">{frameTimecode(annotation.frame, review.session.fps)}</span>
                            <span className="ml-2 text-[8px] uppercase tracking-[0.1em] text-[#5f5b54]">{annotation.scope === 'region' ? 'área' : annotation.scope === 'scene' ? 'cena' : 'ponto'} · {REVIEW_SCOPE_LABELS[annotation.applicationScope.kind]} · {annotation.affectedCount} alvo{annotation.affectedCount === 1 ? '' : 's'}</span>
                            <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-[#aaa49a]">{annotation.text}</p>
                          </button>
                        </div>
                        <div className="mt-3 flex items-center justify-between border-t border-white/[0.05] pt-2">
                          <span className={`text-[8px] uppercase tracking-[0.12em] ${annotation.status === 'open' ? 'text-[#716d65]' : 'text-[#5e9f74]'}`}>{annotation.status === 'open' ? 'aguarda decisão' : 'aplicado'}</span>
                          {annotation.status === 'open' ? <button className="text-[9px] font-semibold text-[#d7aa42] hover:text-[#f0c65d] disabled:opacity-35" data-testid={`review-patch-propose-${annotation.id}`} disabled={reviewPatchLoading === annotation.id} onClick={() => void proposeReviewPatch(annotation.id)} type="button">{reviewPatchLoading === annotation.id ? 'Interpretando…' : 'Preparar ajuste →'}</button> : null}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : <p className="mt-3 text-xs text-[#5f5b54]">Nenhum ajuste registrado nesta versão.</p>}

                {reviewPatch ? (
                  <div className="mt-3 border border-[#8f6c22]/35 bg-[#0b0a08]" data-testid="review-patch-impact">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
                      <div><p className="text-[8px] uppercase tracking-[0.2em] text-[#8b7650]">Dossiê de alteração</p><p className="mt-1 text-sm font-medium text-[#d8d2c7]">{reviewPatch.patch?.operations[0] ? PATCH_OPERATION_LABELS[reviewPatch.patch.operations[0].op] : reviewPatch.status === 'ambiguous' ? 'Decisão necessária' : 'Aplicação bloqueada'}</p></div>
                      <span className={`border px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.14em] ${reviewPatch.status === 'ready' ? 'border-[#bd8f29]/40 text-[#d9aa3d]' : reviewPatch.status === 'applied' ? 'border-[#4e9568]/40 text-[#6db886]' : 'border-[#b05d56]/35 text-[#c87870]'}`}>{reviewPatch.status === 'ready' ? 'pronto para confirmar' : reviewPatch.status === 'ambiguous' ? 'ambíguo' : reviewPatch.status === 'budget-blocked' ? 'budget excedido' : reviewPatch.status === 'applied' ? 'versão criada' : 'proibido'}</span>
                    </div>
                    <div className="grid gap-px bg-white/[0.06] sm:grid-cols-4">
                      {reviewPatch.gates.map((gate) => <div className={`bg-[#090909] px-3 py-3 shadow-[inset_2px_0_0_var(--gate-color)] ${gate.passed ? '[--gate-color:#4e9568]' : '[--gate-color:#b05d56]'}`} key={gate.gate}><div className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${gate.passed ? 'bg-[#63ba84]' : 'bg-[#d36e65]'}`} /><p className="text-[8px] uppercase tracking-[0.13em] text-[#777168]">{PATCH_GATE_LABELS[gate.gate]}</p></div><p className="mt-2 text-[9px] leading-4 text-[#8d877d]">{gate.message}</p></div>)}
                    </div>
                    {reviewPatch.status === 'ambiguous' ? (
                      <div className="px-4 py-4"><p className="text-[10px] leading-5 text-[#8d877d]">A instrução admite leituras diferentes. Escolha o efeito pretendido; os quatro gates serão executados novamente.</p><div className="mt-3 flex flex-wrap gap-2">{reviewPatch.choices.map((candidate) => <button className="border border-white/[0.1] px-3 py-2 text-[9px] text-[#bcb5aa] hover:border-[#a8802f]/60 hover:text-[#e0b852]" data-testid={`review-patch-choice-${candidate.choiceId}`} key={candidate.choiceId ?? `${candidate.op}:${candidate.targetId}`} onClick={() => void proposeReviewPatch(reviewPatch.annotationId, candidate.choiceId)} type="button">{PATCH_OPERATION_LABELS[candidate.op]} · {candidate.targetId}</button>)}</div></div>
                    ) : null}
                    {reviewPatch.impact ? (
                      <div className="grid border-t border-white/[0.07] sm:grid-cols-[1fr_auto]">
                        <div className="px-4 py-4"><div className="flex flex-wrap gap-x-5 gap-y-2 text-[9px]"><span className="text-[#777168]">Custo <strong className="ml-1 font-mono font-medium text-[#c7c0b5]">{reviewPatch.impact.cost}¢</strong></span><span className="text-[#777168]">Ranges <strong className="ml-1 font-mono font-medium text-[#c7c0b5]">{reviewPatch.impact.invalidatedRanges.length}</strong></span><span className="text-[#777168]">Invalida <strong className="ml-1 font-medium text-[#c7c0b5]">{reviewPatch.impact.invalidatedArtifacts.join(' + ')}</strong></span><span className="text-[#777168]">Delta esperado <strong className="ml-1 font-mono font-medium text-[#6db886]">+{reviewPatch.impact.expectedScoreDelta}</strong></span></div><p className="mt-3 truncate font-mono text-[9px] text-[#6b665e]">{reviewPatch.impact.changedTargets.join(', ')}</p></div>
                        {reviewPatch.status === 'ready' ? <div className="flex items-center border-t border-white/[0.07] px-4 py-3 sm:border-l sm:border-t-0"><button className="bg-[#dbae3f] px-4 py-2.5 text-[10px] font-bold text-[#171207] disabled:opacity-35" data-testid="review-patch-apply" disabled={reviewPatchApplying} onClick={() => void applyReviewPatch()} type="button">{reviewPatchApplying ? 'Criando versão…' : 'Confirmar e criar versão'}</button></div> : null}
                      </div>
                    ) : null}
                    {reviewPatch.status === 'applied' && reviewPatch.comparison ? <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#4e9568]/20 bg-[#4e9568]/[0.04] px-4 py-3" data-testid="review-patch-comparison"><p className="text-[9px] text-[#7ca88b]">Versão imutável criada · <span className="font-mono">{reviewPatch.comparison.beforeVersionId.slice(-8)} → {reviewPatch.comparison.afterVersionId.slice(-8)}</span></p><span className="text-[8px] uppercase tracking-[0.12em] text-[#6f9a7c]">Render {reviewPatch.render?.status ?? 'queued'}</span></div> : null}
                  </div>
                ) : null}
                {reviewPatchBatch ? (
                  <div className="mt-3 border border-[#8f6c22]/35 bg-[#0b0a08]" data-testid="review-batch-impact">
                    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
                      <div><p className="text-[8px] uppercase tracking-[0.2em] text-[#8b7650]">Caderno do lote</p><p className="mt-1 text-sm font-medium text-[#d8d2c7]">{reviewPatchBatch.items.length} decisões · uma versão</p></div>
                      <span className={`border px-2 py-1 text-[8px] font-semibold uppercase tracking-[0.14em] ${reviewPatchBatch.status === 'ready' ? 'border-[#bd8f29]/40 text-[#d9aa3d]' : reviewPatchBatch.status === 'applied' ? 'border-[#4e9568]/40 text-[#6db886]' : reviewPatchBatch.status === 'partial' ? 'border-[#a47d2d]/40 text-[#cda54a]' : 'border-[#b05d56]/35 text-[#c87870]'}`}>{reviewPatchBatch.status === 'ready' ? 'lote compatível' : reviewPatchBatch.status === 'partial' ? 'subconjunto seguro' : reviewPatchBatch.status === 'applied' ? 'versão criada' : 'revertido por conflito'}</span>
                    </div>
                    <div className="divide-y divide-white/[0.06]">
                      {reviewPatchBatch.items.map((item, index) => {
                        const annotation = review.annotations.find((candidate) => candidate.id === item.annotationId)
                        const successful = item.status === 'included' || item.status === 'applied'
                        return <div className="grid grid-cols-[28px_1fr_auto] items-center gap-3 px-4 py-3" key={item.id}><span className={`grid h-5 w-5 place-items-center rounded-full border font-mono text-[8px] ${successful ? 'border-[#4e9568]/50 text-[#69ae80]' : 'border-[#a95a53]/50 text-[#c9756e]'}`}>{index + 1}</span><div className="min-w-0"><p className="truncate text-[10px] text-[#aaa49a]">{annotation?.text ?? item.annotationId}</p><p className="mt-1 truncate font-mono text-[8px] text-[#5f5a52]">{item.operation ? `${PATCH_OPERATION_LABELS[item.operation.op]} · ${item.operation.targetId}` : 'sem operação'}</p></div><span className={`text-[8px] uppercase tracking-[0.1em] ${successful ? 'text-[#6aa37b]' : 'text-[#bd716a]'}`}>{item.status === 'rolled-back' ? 'rollback' : item.status === 'retryable' ? 'revisar' : item.status === 'applied' ? 'aplicado' : 'incluído'}</span></div>
                      })}
                    </div>
                    {reviewPatchBatch.impact ? (
                      <div className="grid border-t border-white/[0.07] sm:grid-cols-[1fr_auto]">
                        <div className="px-4 py-4"><div className="flex flex-wrap gap-x-5 gap-y-2 text-[9px]"><span className="text-[#777168]">Operações <strong className="ml-1 font-mono font-medium text-[#c7c0b5]">{reviewPatchBatch.impact.operationCount}</strong></span><span className="text-[#777168]">Custo <strong className="ml-1 font-mono font-medium text-[#c7c0b5]">{reviewPatchBatch.impact.cost}¢</strong></span><span className="text-[#777168]">Ranges <strong className="ml-1 font-mono font-medium text-[#c7c0b5]">{reviewPatchBatch.impact.invalidatedRanges.length}</strong></span><span className="text-[#777168]">Delta <strong className="ml-1 font-mono font-medium text-[#6db886]">+{reviewPatchBatch.impact.expectedScoreDelta}</strong></span></div><p className="mt-3 text-[9px] leading-4 text-[#6b665e]">{reviewPatchBatch.mode === 'all-or-nothing' ? 'Transação integral: qualquer mudança concorrente reverte o lote inteiro.' : 'Retry parcial explícito: itens conflitantes permanecem abertos.'}</p></div>
                        {['ready', 'partial'].includes(reviewPatchBatch.status) ? <div className="flex items-center border-t border-white/[0.07] px-4 py-3 sm:border-l sm:border-t-0"><button className="bg-[#dbae3f] px-4 py-2.5 text-[10px] font-bold text-[#171207] disabled:opacity-35" data-testid="review-batch-apply" disabled={reviewPatchBatchApplying} onClick={() => void applyReviewPatchBatch()} type="button">{reviewPatchBatchApplying ? 'Criando versão…' : 'Confirmar lote'}</button></div> : null}
                      </div>
                    ) : <div className="border-t border-[#b05d56]/20 bg-[#b05d56]/[0.04] px-4 py-3"><p className="text-[9px] leading-4 text-[#bd716a]">Nenhuma alteração foi aplicada. Separe os conflitos para gerar um lote parcial explícito.</p></div>}
                    {reviewPatchBatch.status === 'applied' && reviewPatchBatch.comparison ? <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#4e9568]/20 bg-[#4e9568]/[0.04] px-4 py-3"><p className="text-[9px] text-[#7ca88b]">Versão imutável criada · <span className="font-mono">{reviewPatchBatch.comparison.beforeVersionId.slice(-8)} → {reviewPatchBatch.comparison.afterVersionId.slice(-8)}</span></p><span className="text-[8px] uppercase tracking-[0.12em] text-[#6f9a7c]">Render {reviewPatchBatch.render?.status ?? 'queued'}</span></div> : null}
                  </div>
                ) : null}
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

          <section
            aria-label="Comparação entre a fonte publicada e os trechos limpos"
            className="mt-5 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#090909]"
            data-testid="source-deconstruction-panel"
          >
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4">
              <div>
                <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#b58d31]">Raio-X da fonte</p>
                <h2 className="mt-1.5 text-base font-semibold tracking-[-0.02em] text-[#e8e3da]">O que fica. O que sai. Por quê.</h2>
                <p className="mt-1 text-[10px] text-[#6e6961]">Leitura imutável do diretor sobre material já publicado.</p>
              </div>
              {sourceDeconstructions.length > 1 ? (
                <label className="grid gap-1 text-[8px] uppercase tracking-[0.14em] text-[#6f6a62]">
                  Leitura
                  <select
                    className="min-w-48 border border-white/[0.09] bg-[#0d0d0d] px-3 py-2 text-[10px] normal-case tracking-normal text-[#bdb6ac] outline-none focus:border-[#d8aa3d]/55"
                    data-testid="source-deconstruction-select"
                    onChange={(event) =>
                      setSelectedSourceDeconstructionId(event.target.value)}
                    value={selectedSourceDeconstruction?.id ?? ''}
                  >
                    {sourceDeconstructions.map((report) => (
                      <option key={report.id} value={report.id}>
                        {report.desiredRole === 'complete' ? 'Composição completa' : SOURCE_ROLE_LABELS[report.desiredRole]} · {new Date(report.createdAt).toLocaleString('pt-BR')}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>

            {sourceDeconstructionLoading ? (
              <div className="px-5 py-10 text-center text-xs text-[#716c64]">
                Lendo decisões sobre as fontes…
              </div>
            ) : !selectedSourceDeconstruction ? (
              <div className="grid gap-2 px-5 py-9 sm:grid-cols-[1fr_auto] sm:items-center">
                <div>
                  <p className="text-sm font-medium text-[#bdb7ae]">Nenhuma fonte publicada foi desconstruída ainda.</p>
                  <p className="mt-1 text-[10px] leading-5 text-[#69655e]">Quando o diretor reaproveitar um Reel, depoimento ou anúncio validado, os trechos mantidos e removidos aparecerão aqui.</p>
                </div>
                <span className="mt-2 border border-dashed border-white/[0.1] px-3 py-2 font-mono text-[8px] uppercase tracking-[0.14em] text-[#5f5a53] sm:mt-0">aguardando análise</span>
              </div>
            ) : (
              <div data-testid="source-deconstruction-result">
                <div className="grid divide-y divide-white/[0.06] sm:grid-cols-4 sm:divide-x sm:divide-y-0">
                  <div className="px-5 py-4">
                    <p className="text-[8px] uppercase tracking-[0.16em] text-[#69645c]">Alvo</p>
                    <p className="mt-2 text-sm font-medium text-[#d6d0c7]">{selectedSourceDeconstruction.desiredRole === 'complete' ? 'Composição completa' : SOURCE_ROLE_LABELS[selectedSourceDeconstruction.desiredRole]}</p>
                  </div>
                  <div className="px-5 py-4">
                    <p className="text-[8px] uppercase tracking-[0.16em] text-[#69645c]">Material limpo</p>
                    <p className="mt-2 font-mono text-sm text-[#72bd8a]">{readableDuration(selectedSourceDeconstruction.comparison.cleanDurationMs)}</p>
                  </div>
                  <div className="px-5 py-4">
                    <p className="text-[8px] uppercase tracking-[0.16em] text-[#69645c]">Removido</p>
                    <p className="mt-2 font-mono text-sm text-[#ce746d]">{readableDuration(selectedSourceDeconstruction.comparison.removedDurationMs)}</p>
                  </div>
                  <div className="px-5 py-4">
                    <p className="text-[8px] uppercase tracking-[0.16em] text-[#69645c]">Decisão</p>
                    <p className={`mt-2 text-sm font-medium ${selectedSourceDeconstruction.decision === 'automatic' ? 'text-[#72bd8a]' : selectedSourceDeconstruction.decision === 'human-review' ? 'text-[#ddb452]' : 'text-[#cf756e]'}`}>
                      {selectedSourceDeconstruction.decision === 'automatic' ? 'Editável automaticamente' : selectedSourceDeconstruction.decision === 'human-review' ? 'Revisão humana' : 'Rejeitar fonte'}
                    </p>
                  </div>
                </div>

                <div className="border-t border-white/[0.07] px-5 py-5">
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-[#777168]">Mapa temporal</p>
                    <p className="font-mono text-[8px] text-[#625d56]">0:00 — {readableDuration(selectedSourceDeconstruction.comparison.sourceDurationMs)}</p>
                  </div>
                  <div className="mt-4 grid grid-cols-[48px_1fr] items-center gap-x-3 gap-y-3">
                    <span className="text-[8px] font-semibold uppercase tracking-[0.12em] text-[#777168]">Fonte</span>
                    <div className="relative h-8 overflow-hidden border border-white/[0.08] bg-[#111]" data-testid="source-deconstruction-source-track">
                      {selectedSourceDeconstruction.segments.map((segment) => (
                        <span
                          className={`absolute inset-y-0 border-r border-black/50 ${segment.included ? 'bg-[#d7a93a]/70' : 'bg-[#853f42]/45'}`}
                          key={segment.id}
                          style={rangePosition(segment.rangeMs, selectedSourceDeconstruction.comparison.sourceDurationMs)}
                          title={`${SOURCE_ROLE_LABELS[segment.role]} · ${readableDuration(segment.rangeMs[1] - segment.rangeMs[0])}`}
                        />
                      ))}
                      <span className="pointer-events-none absolute inset-0 bg-[linear-gradient(110deg,transparent_0%,rgba(255,255,255,.035)_45%,transparent_46%)]" />
                    </div>
                    <span className="text-[8px] font-semibold uppercase tracking-[0.12em] text-[#72a980]">Clean</span>
                    <div className="relative h-8 overflow-hidden border border-[#5ca575]/20 bg-[#0e1510]" data-testid="source-deconstruction-clean-track">
                      {selectedSourceDeconstruction.comparison.cleanRangesMs.map((range, index) => (
                        <span
                          className="absolute inset-y-1 border border-[#70be88]/35 bg-[#4d9565]/75 shadow-[0_0_14px_rgba(86,159,111,.18)]"
                          key={`${range[0]}-${range[1]}-${index}`}
                          style={rangePosition(range, selectedSourceDeconstruction.comparison.sourceDurationMs)}
                          title={`Trecho limpo · ${readableDuration(range[1] - range[0])}`}
                        />
                      ))}
                      {selectedSourceDeconstruction.comparison.removedRangesMs.map((range, index) => (
                        <span
                          className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,rgba(165,75,72,.18)_0,rgba(165,75,72,.18)_3px,transparent_3px,transparent_7px)]"
                          key={`removed-${range[0]}-${range[1]}-${index}`}
                          style={rangePosition(range, selectedSourceDeconstruction.comparison.sourceDurationMs)}
                        />
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-[8px] text-[#6f6a62]">
                    <span className="flex items-center gap-1.5"><i className="h-2 w-2 bg-[#d7a93a]/70" /> fala-alvo</span>
                    <span className="flex items-center gap-1.5"><i className="h-2 w-2 bg-[#853f42]/55" /> material anterior</span>
                    <span className="flex items-center gap-1.5"><i className="h-2 w-2 bg-[#4d9565]/80" /> intervalo preservado</span>
                    <span className="ml-auto font-mono text-[#827b71]">{Math.round(selectedSourceDeconstruction.comparison.retainedRatio * 100)}% retido · score {selectedSourceDeconstruction.editabilityScore}</span>
                  </div>
                </div>

                <div className="grid border-t border-white/[0.07] lg:grid-cols-[minmax(0,1fr)_220px]">
                  <div className="grid gap-4 px-5 py-5 sm:grid-cols-2" data-testid="source-deconstruction-transcript">
                    <div>
                      <p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-[#7b756d]">Transcrição original</p>
                      <p className="mt-3 text-xs leading-6 text-[#7d7870]">
                        {selectedSourceDeconstruction.segments.map((segment) => (
                          <span
                            className={segment.included ? 'text-[#d9d2c8]' : 'text-[#795f5d] line-through decoration-[#a45a56]/60'}
                            key={segment.id}
                          >
                            {segment.exactText}{' '}
                          </span>
                        ))}
                      </p>
                    </div>
                    <div className="border-l border-white/[0.06] pl-4">
                      <p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-[#69a77c]">Fala limpa</p>
                      <p className="mt-3 text-xs leading-6 text-[#c9d8cd]">{selectedSourceDeconstruction.comparison.cleanTranscript}</p>
                      <p className="mt-3 font-mono text-[8px] text-[#66806e]">contexto {selectedSourceDeconstruction.contextPreserved ? 'preservado' : 'incompleto'} · confiança {Math.round(selectedSourceDeconstruction.confidence * 100)}%</p>
                    </div>
                  </div>
                  <div className="border-t border-white/[0.07] bg-[#0b0a0a] px-4 py-5 lg:border-l lg:border-t-0">
                    <p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-[#8b6c68]">Descartes sem perda</p>
                    <div className="mt-3 space-y-2">
                      {selectedSourceDeconstruction.semanticContaminants.map((item) => (
                        <div className="border-l border-[#a5524e]/40 pl-3" key={item.id}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[9px] font-medium text-[#b78a85]">{SOURCE_CONTAMINANT_LABELS[item.kind]}</span>
                            <span className="font-mono text-[7px] text-[#705e5b]">{readableDuration(item.rangeMs[1] - item.rangeMs[0])}</span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-[8px] leading-4 text-[#6e625f]">{item.exactText}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>
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
