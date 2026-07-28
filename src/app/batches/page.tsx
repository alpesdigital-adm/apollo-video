'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import LogoutButton from '@/components/LogoutButton'

type BatchStatus =
  | 'queued'
  | 'running'
  | 'review'
  | 'partially-completed'
  | 'completed'
  | 'failed'
  | 'cancelled'
type ItemState =
  | 'queued'
  | 'planning'
  | 'materializing'
  | 'rendering'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'superseded'
type StepName = 'planning' | 'materializing' | 'rendering' | 'reviewing'
type StepState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

interface ApiEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string }
}

interface ProjectSummary {
  id: string
  name: string
  status: string
  objective?: string
  format?: string
  locale?: string
}

interface MediaRecord {
  id: string
  artifactId: string
  role: 'source-master' | 'editing-proxy' | 'editorial-proxy' | 'final-output'
  originalFileName: string
  mediaType: string
  rightsStatus?: string
  status: string
  probe?: { width: number; height: number; duration: number; fps: number }
}

type ScriptRole =
  | 'hook'
  | 'body'
  | 'proof'
  | 'objection'
  | 'bridge'
  | 'offer'
  | 'cta'

interface TranscriptSummary {
  id: string
  sourceArtifactId: string
  language: string
  transcriptHash: string
  text: string
  wordCount: number
}

interface ScriptCandidate {
  id: string
  transcriptId: string
  sourceArtifactId: string
  kind: 'exact' | 'near' | 'partial'
  sourceRangeMs: [number, number]
  spokenText: string
  metrics: { total: number }
  deviations: {
    kind: string
    reasonCode: string
    plannedTokens: string[]
    spokenTokens: string[]
  }[]
}

interface ScriptBlockAlignment {
  blockId: string
  role: ScriptRole
  documentOrder: number
  kind: 'exact' | 'near' | 'partial' | 'missing'
  confidence: number
  reviewStatus:
    | 'auto-linked'
    | 'review-required'
    | 'accepted'
    | 'marked-missing'
  ambiguous: boolean
  reasonCodes: string[]
  selectedCandidate: ScriptCandidate | null
  alternatives: ScriptCandidate[]
}

interface ScriptExtraTake {
  id: string
  transcriptId: string
  sourceArtifactId: string
  sourceRangeMs: [number, number]
  spokenText: string
  reviewStatus: 'review-required' | 'accepted' | 'rejected'
}

interface ScriptAlignmentRun {
  id: string
  runHash: string
  status: 'completed' | 'review-required' | 'reviewed'
  revision: number
  document: {
    title: string
    locale: string
    rawText: string
    blocks: {
      id: string
      role: ScriptRole
      plannedText: string
      documentOrder: number
    }[]
  }
  alignments: ScriptBlockAlignment[]
  extraTakes: ScriptExtraTake[]
  summary: {
    blockCount: number
    exactCount: number
    nearCount: number
    partialCount: number
    missingCount: number
    extraTakeCount: number
    ambiguousCount: number
    reviewRequiredCount: number
    resolvedReviewCount: number
    averageConfidence: number
  }
  createdAt: string
  updatedAt: string
}

type TakeDimension =
  | 'completeness'
  | 'performance'
  | 'audio'
  | 'video'
  | 'integrity'
type TakeStatus =
  | 'primary'
  | 'alternate'
  | 'rejected'
  | 'needs-review'

interface TakeDimensionEvaluation {
  dimension: TakeDimension
  score: number | null
  state: 'measured' | 'derived' | 'unavailable'
  reasonCodes: string[]
}

interface TakeRecord {
  id: string
  groupId: string
  retakeBoundaryId: string
  sourceKind: 'alignment-candidate' | 'extra-take'
  sourceId: string
  sourceHash: string
  sourceRangeMs: [number, number]
  spokenText: string
  assignment: {
    kind: 'script-block' | 'inferred-intention'
    role: ScriptRole | 'other'
    label: string
    confidence: number
  }
  evaluations: TakeDimensionEvaluation[]
  weightedScore: number | null
  status: TakeStatus
  protected: boolean
  selectionSource: 'automatic' | 'manual'
  reasonCodes: string[]
}

interface TakeGroup {
  id: string
  assignmentKind: 'script-block' | 'inferred-intention'
  role: ScriptRole | 'other'
  label: string
  scriptBlockId?: string
  takeIds: string[]
  primaryTakeId?: string
  protectedTakeId?: string
}

interface TakeLibraryRun {
  id: string
  alignmentId: string
  alignmentRunHash: string
  status: 'completed' | 'review-required' | 'reviewed'
  revision: number
  groups: TakeGroup[]
  takes: TakeRecord[]
  summary: {
    groupCount: number
    takeCount: number
    primaryCount: number
    alternateCount: number
    rejectedCount: number
    needsReviewCount: number
    protectedCount: number
    measuredDimensionCount: number
    unavailableDimensionCount: number
    averageWeightedScore: number
  }
  updatedAt: string
}

type ScriptReviewDecision =
  | {
      targetKind: 'block'
      blockId: string
      resolution: 'accept' | 'mark-missing' | 'select-alternative'
      candidateId?: string
    }
  | {
      targetKind: 'extra-take'
      extraTakeId: string
      resolution: 'accept-extra' | 'reject-extra'
    }

interface BatchStep {
  step: StepName
  sequence: number
  state: StepState
  attempt: number
  costMinorUnits: number
  cacheHit: boolean
  error?: { code: string; message: string }
}

interface BatchItem {
  id: string
  key: string
  sourceGroupId: string
  recipeId: string
  variantId: string
  state: ItemState
  revision: number
  steps: BatchStep[]
  artifactIds: string[]
  retryCount: number
  error?: { code: string; message: string }
  updatedAt: string
}

interface ProductionBatch {
  id: string
  projectId: string
  name: string
  objective: string
  revision: number
  status: BatchStatus
  sourceGroups: { id: string; name: string; sourceArtifactIds: string[] }[]
  recipes: { id: string; name: string; sourceGroupIds: string[] }[]
  variants: { id: string; name: string; outputSpecId: string; locale: string }[]
  budget: { currency: 'USD'; maxCostMinorUnits: number; reservedCostMinorUnits: number }
  items: BatchItem[]
  progress: {
    completedSteps: number
    failedSteps: number
    cancelledSteps: number
    runningSteps: number
    totalSteps: number
    percent: number
    completedItems: number
    failedItems: number
    cancelledItems: number
    activeItems: number
    queuedItems: number
    totalItems: number
    spentMinorUnits: number
    remainingMinorUnits: number
  }
  createdAt: string
  updatedAt: string
}

const STATUSES: { value: 'all' | BatchStatus; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'running', label: 'Em produção' },
  { value: 'review', label: 'Em revisão' },
  { value: 'partially-completed', label: 'Parcial' },
  { value: 'completed', label: 'Concluído' },
  { value: 'failed', label: 'Com falha' },
  { value: 'cancelled', label: 'Cancelado' },
  { value: 'queued', label: 'Na fila' },
]

const STATUS_LABELS: Record<BatchStatus, string> = {
  queued: 'Na fila',
  running: 'Em produção',
  review: 'Em revisão',
  'partially-completed': 'Conclusão parcial',
  completed: 'Concluído',
  failed: 'Requer atenção',
  cancelled: 'Cancelado',
}

const STATUS_STYLES: Record<BatchStatus, string> = {
  queued: 'border-[#8c877e]/20 bg-[#8c877e]/10 text-[#aaa59c]',
  running: 'border-[#5d8cc9]/25 bg-[#5d8cc9]/10 text-[#7ea8db]',
  review: 'border-[#b57ac0]/25 bg-[#b57ac0]/10 text-[#ca91d4]',
  'partially-completed': 'border-[#dcaa35]/25 bg-[#dcaa35]/10 text-[#e6bd5d]',
  completed: 'border-[#58a979]/25 bg-[#58a979]/10 text-[#75c393]',
  failed: 'border-[#ce6565]/25 bg-[#ce6565]/10 text-[#e38181]',
  cancelled: 'border-[#8c877e]/20 bg-[#8c877e]/10 text-[#aaa59c]',
}

const STEP_LABELS: Record<StepName, string> = {
  planning: 'Plano',
  materializing: 'Materiais',
  rendering: 'Render',
  reviewing: 'Revisão',
}

const SCRIPT_ROLE_LABELS: Record<ScriptRole, string> = {
  hook: 'Hook',
  body: 'Corpo',
  proof: 'Prova',
  objection: 'Objeção',
  bridge: 'Ponte',
  offer: 'Oferta',
  cta: 'CTA',
}

const SCRIPT_KIND_LABELS: Record<ScriptBlockAlignment['kind'], string> = {
  exact: 'Exato',
  near: 'Próximo',
  partial: 'Parcial',
  missing: 'Ausente',
}

const TAKE_STATUS_LABELS: Record<TakeStatus, string> = {
  primary: 'Principal',
  alternate: 'Alternativo',
  rejected: 'Rejeitado',
  'needs-review': 'Revisar',
}

const TAKE_STATUS_STYLES: Record<TakeStatus, string> = {
  primary: 'border-[#57aa77]/25 bg-[#57aa77]/10 text-[#7bc493]',
  alternate: 'border-[#6b87b8]/25 bg-[#6b87b8]/10 text-[#8da8d4]',
  rejected: 'border-[#c75e5e]/25 bg-[#c75e5e]/10 text-[#dc8080]',
  'needs-review': 'border-[#bd8a3d]/25 bg-[#bd8a3d]/10 text-[#dcb568]',
}

const TAKE_DIMENSION_LABELS: Record<TakeDimension, string> = {
  completeness: 'Completude',
  performance: 'Performance',
  audio: 'Áudio',
  video: 'Vídeo',
  integrity: 'Integridade',
}

const FORMATS = [
  { id: '9:16', name: 'Vertical', use: 'Reels · Shorts' },
  { id: '16:9', name: 'Horizontal', use: 'YouTube · sites' },
  { id: '4:5', name: 'Retrato', use: 'Feed social' },
  { id: '1:1', name: 'Quadrado', use: 'Feed · display' },
  { id: '21:9', name: 'Cinema', use: 'Telas amplas' },
] as const

function Icon({ path, className = 'h-5 w-5' }: { path: string; className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
      <path d={path} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  )
}

function apiError(payload: ApiEnvelope<unknown>, fallback: string) {
  return payload.error?.message?.trim() || fallback
}

function money(minorUnits: number) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'USD',
  }).format(minorUnits / 100)
}

function elapsed(instant: string) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(instant)) / 1000))
  if (seconds < 60) return 'agora'
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`
  if (seconds < 86_400) return `há ${Math.floor(seconds / 3600)} h`
  return new Date(instant).toLocaleDateString('pt-BR')
}

function timecode(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const tenths = Math.floor((milliseconds % 1000) / 100)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`
}

function stepTone(state: StepState) {
  if (state === 'completed') return 'border-[#5cb47e] bg-[#5cb47e] text-[#07110b]'
  if (state === 'running') return 'border-[#dbae3e] bg-[#dbae3e] text-[#171207] shadow-[0_0_12px_rgba(219,174,62,.25)]'
  if (state === 'failed') return 'border-[#d76565] bg-[#d76565] text-[#1b0808]'
  if (state === 'cancelled') return 'border-[#5e5a54] bg-[#242321] text-[#76716a]'
  return 'border-white/[0.13] bg-[#101010] text-[#5f5b54]'
}

function StepRail({ steps, compact = false }: { steps: BatchStep[]; compact?: boolean }) {
  return (
    <div aria-label="Etapas reais do item" className="flex min-w-0 items-start">
      {steps.map((step, index) => (
        <div className="flex min-w-0 flex-1 items-start" key={step.step}>
          <div className="min-w-0 text-center">
            <span
              aria-label={`${STEP_LABELS[step.step]}: ${step.state}`}
              className={`mx-auto grid ${compact ? 'h-4 w-4 text-[8px]' : 'h-6 w-6 text-[10px]'} place-items-center rounded-full border font-bold transition ${stepTone(step.state)}`}
              title={`${STEP_LABELS[step.step]} · tentativa ${step.attempt || 1}`}
            >
              {step.state === 'completed' ? '✓' : step.sequence + 1}
            </span>
            {!compact ? <span className="mt-1.5 block truncate text-[9px] text-[#6f6a62]">{STEP_LABELS[step.step]}</span> : null}
          </div>
          {index < steps.length - 1 ? (
            <span className={`mt-[7px] h-px min-w-2 flex-1 ${step.state === 'completed' ? 'bg-[#5cb47e]/45' : 'bg-white/[0.08]'}`} />
          ) : null}
        </div>
      ))}
    </div>
  )
}

export default function BatchesPage() {
  const router = useRouter()
  const [batches, setBatches] = useState<ProductionBatch[]>([])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectMedia, setProjectMedia] = useState<MediaRecord[]>([])
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | BatchStatus>('all')
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(false)
  const [projectId, setProjectId] = useState('')
  const [name, setName] = useState('')
  const [sourceIds, setSourceIds] = useState<Set<string>>(new Set())
  const [recipeText, setRecipeText] = useState('Composição principal')
  const [formats, setFormats] = useState<Set<string>>(new Set(['9:16']))
  const [matrix, setMatrix] = useState<Set<string>>(new Set(['0::9:16']))
  const [locale, setLocale] = useState('pt-BR')
  const [budget, setBudget] = useState('25.00')
  const idempotencyKey = useRef<string | null>(null)
  const [detailView, setDetailView] =
    useState<'script' | 'outputs'>('script')
  const [batchTranscripts, setBatchTranscripts] =
    useState<TranscriptSummary[]>([])
  const [alignments, setAlignments] = useState<ScriptAlignmentRun[]>([])
  const [activeAlignmentId, setActiveAlignmentId] =
    useState<string | null>(null)
  const [takeLibraries, setTakeLibraries] =
    useState<TakeLibraryRun[]>([])
  const [activeTakeLibraryId, setActiveTakeLibraryId] =
    useState<string | null>(null)
  const [alignmentLoading, setAlignmentLoading] = useState(false)
  const [scriptComposerOpen, setScriptComposerOpen] = useState(false)
  const [scriptTitle, setScriptTitle] = useState('')
  const [scriptLocale, setScriptLocale] = useState('pt-BR')
  const [scriptRawText, setScriptRawText] = useState('')
  const [scriptSourceIds, setScriptSourceIds] =
    useState<Set<string>>(new Set())
  const [scriptRoleHints, setScriptRoleHints] =
    useState<Record<string, ScriptRole | ''>>({})
  const scriptIdempotencyKey = useRef<string | null>(null)
  const takeLibraryIdempotencyKey = useRef<string | null>(null)

  const fetchBatches = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    const params = new URLSearchParams({ limit: '100' })
    if (query.trim()) params.set('q', query.trim())
    if (statusFilter !== 'all') params.set('status', statusFilter)
    try {
      const response = await fetch(`/v1/batches?${params}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      const payload = await response.json() as ApiEnvelope<{ batches: ProductionBatch[] }>
      if (!response.ok || !payload.data) throw new Error(apiError(payload, 'Não foi possível carregar os lotes.'))
      setBatches(payload.data.batches)
      setSelectedBatchId((current) => current ?? payload.data!.batches[0]?.id ?? null)
    } catch (error) {
      if (!quiet) setNotice(error instanceof Error ? error.message : 'Não foi possível carregar os lotes.')
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [query, router, statusFilter])

  useEffect(() => {
    const handle = window.setTimeout(() => void fetchBatches(), 180)
    return () => window.clearTimeout(handle)
  }, [fetchBatches])

  useEffect(() => {
    const hasActive = batches.some((batch) => ['queued', 'running', 'review'].includes(batch.status))
    if (!hasActive) return
    const handle = window.setInterval(() => void fetchBatches(true), 6000)
    return () => window.clearInterval(handle)
  }, [batches, fetchBatches])

  useEffect(() => {
    async function loadProjects() {
      try {
        const response = await fetch('/v1/projects?limit=100', {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (response.status === 401) {
          router.replace('/login')
          return
        }
        const payload = await response.json() as ApiEnvelope<{ projects: ProjectSummary[] }>
        if (!response.ok || !payload.data) throw new Error(apiError(payload, 'Não foi possível carregar os projetos.'))
        setProjects(payload.data.projects)
        setProjectId((current) => current || payload.data!.projects[0]?.id || '')
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Não foi possível carregar os projetos.')
      }
    }
    void loadProjects()
  }, [router])

  useEffect(() => {
    if (!projectId || !composerOpen) {
      setProjectMedia([])
      return
    }
    const controller = new AbortController()
    async function loadMedia() {
      try {
        const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/workspace`, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
          cache: 'no-store',
        })
        if (response.status === 401) {
          router.replace('/login')
          return
        }
        const payload = await response.json() as ApiEnvelope<{ media: MediaRecord[] }>
        if (!response.ok || !payload.data) throw new Error(apiError(payload, 'Não foi possível carregar os materiais do projeto.'))
        setProjectMedia(payload.data.media)
        const approved = payload.data.media
          .filter((media) => media.status === 'available' && media.rightsStatus === 'approved')
          .map((media) => media.artifactId)
        setSourceIds(new Set(approved))
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setNotice(error instanceof Error ? error.message : 'Não foi possível carregar os materiais do projeto.')
      }
    }
    void loadMedia()
    return () => controller.abort()
  }, [composerOpen, projectId, router])

  useEffect(() => {
    if (!composerOpen && !scriptComposerOpen) return
    function close(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) {
        setComposerOpen(false)
        setScriptComposerOpen(false)
      }
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [busy, composerOpen, scriptComposerOpen])

  const selectedBatch = useMemo(
    () => batches.find((batch) => batch.id === selectedBatchId) ?? null,
    [batches, selectedBatchId],
  )
  const selectedBatchKey = selectedBatch
    ? `${selectedBatch.id}:${selectedBatch.projectId}`
    : ''

  useEffect(() => {
    if (!selectedBatch) {
      setBatchTranscripts([])
      setAlignments([])
      setActiveAlignmentId(null)
      setTakeLibraries([])
      setActiveTakeLibraryId(null)
      return
    }
    const controller = new AbortController()
    async function loadScriptWorkspace() {
      setAlignmentLoading(true)
      try {
        const [
          workspaceResponse,
          alignmentsResponse,
          takeLibrariesResponse,
        ] = await Promise.all([
          fetch(
            `/v1/projects/${encodeURIComponent(selectedBatch!.projectId)}/workspace`,
            {
              signal: controller.signal,
              headers: { accept: 'application/json' },
              cache: 'no-store',
            },
          ),
          fetch(
            `/v1/batches/${encodeURIComponent(selectedBatch!.id)}/script-alignments?limit=50`,
            {
              signal: controller.signal,
              headers: { accept: 'application/json' },
              cache: 'no-store',
            },
          ),
          fetch(
            `/v1/batches/${encodeURIComponent(selectedBatch!.id)}/take-libraries?limit=100`,
            {
              signal: controller.signal,
              headers: { accept: 'application/json' },
              cache: 'no-store',
            },
          ),
        ])
        if (
          workspaceResponse.status === 401 ||
          alignmentsResponse.status === 401 ||
          takeLibrariesResponse.status === 401
        ) {
          router.replace('/login')
          return
        }
        const workspacePayload = await workspaceResponse.json() as
          ApiEnvelope<{ transcripts: TranscriptSummary[] }>
        const alignmentsPayload = await alignmentsResponse.json() as
          ApiEnvelope<{ alignments: ScriptAlignmentRun[] }>
        const takeLibrariesPayload = await takeLibrariesResponse.json() as
          ApiEnvelope<{ libraries: TakeLibraryRun[] }>
        if (!workspaceResponse.ok || !workspacePayload.data) {
          throw new Error(apiError(
            workspacePayload,
            'Não foi possível carregar as transcrições do lote.',
          ))
        }
        if (!alignmentsResponse.ok || !alignmentsPayload.data) {
          throw new Error(apiError(
            alignmentsPayload,
            'Não foi possível carregar os alinhamentos.',
          ))
        }
        if (!takeLibrariesResponse.ok || !takeLibrariesPayload.data) {
          throw new Error(apiError(
            takeLibrariesPayload,
            'Não foi possível carregar a biblioteca de takes.',
          ))
        }
        const allowedArtifacts = new Set(
          selectedBatch!.sourceGroups.flatMap((group) =>
            group.sourceArtifactIds),
        )
        const transcripts = workspacePayload.data.transcripts
          .filter((transcript) =>
            allowedArtifacts.has(transcript.sourceArtifactId))
        setBatchTranscripts(transcripts)
        setScriptSourceIds(new Set(
          transcripts.map((transcript) => transcript.id),
        ))
        setScriptRoleHints((current) => Object.fromEntries(
          transcripts.map((transcript) => [
            transcript.id,
            current[transcript.id] ?? '',
          ]),
        ))
        const runs = alignmentsPayload.data.alignments
        setAlignments(runs)
        setActiveAlignmentId((current) =>
          current && runs.some((run) => run.id === current)
            ? current
            : runs[0]?.id ?? null)
        const libraries = takeLibrariesPayload.data.libraries
        setTakeLibraries(libraries)
        setActiveTakeLibraryId((current) =>
          current && libraries.some((library) => library.id === current)
            ? current
            : libraries[0]?.id ?? null)
        const project = projects.find((candidate) =>
          candidate.id === selectedBatch!.projectId)
        setScriptLocale(project?.locale || 'pt-BR')
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        setNotice(
          error instanceof Error
            ? error.message
            : 'Não foi possível carregar o roteiro do lote.',
        )
      } finally {
        if (!controller.signal.aborted) setAlignmentLoading(false)
      }
    }
    void loadScriptWorkspace()
    return () => controller.abort()
    // selectedBatchKey is stable across polling revisions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBatchKey, router])

  const selectedProject = projects.find((project) => project.id === projectId)
  const activeAlignment = alignments.find((alignment) =>
    alignment.id === activeAlignmentId) ?? alignments[0] ?? null
  const activeAlignmentLibraries = useMemo(
    () => activeAlignment
      ? takeLibraries.filter((library) =>
          library.alignmentId === activeAlignment.id &&
          library.alignmentRunHash === activeAlignment.runHash)
      : [],
    [activeAlignment, takeLibraries],
  )
  const activeTakeLibrary =
    activeAlignmentLibraries.find((library) =>
      library.id === activeTakeLibraryId) ??
    activeAlignmentLibraries[0] ??
    null
  const activeTakesByGroup = useMemo(() => {
    const result = new Map<string, TakeRecord[]>()
    for (const take of activeTakeLibrary?.takes ?? []) {
      const group = result.get(take.groupId)
      if (group) group.push(take)
      else result.set(take.groupId, [take])
    }
    return result
  }, [activeTakeLibrary])
  const eligibleMedia = projectMedia.filter((media) => media.status === 'available' && media.rightsStatus === 'approved')
  const blockedMedia = projectMedia.filter((media) => media.status !== 'available' || media.rightsStatus !== 'approved')
  const recipes = useMemo(
    () => recipeText.split('\n').map((item) => item.trim()).filter(Boolean).slice(0, 25),
    [recipeText],
  )
  const possibleCells = recipes.flatMap((_, recipeIndex) =>
    FORMATS.filter((format) => formats.has(format.id)).map((format) => `${recipeIndex}::${format.id}`),
  )
  const selectedCells = possibleCells.filter((cell) => matrix.has(cell))
  const totalCounts = useMemo(() => batches.reduce((counts, batch) => {
    counts.total += 1
    if (batch.status === 'running') counts.running += 1
    if (batch.status === 'review') counts.review += 1
    if (batch.status === 'failed' || batch.status === 'partially-completed') counts.attention += 1
    return counts
  }, { total: 0, running: 0, review: 0, attention: 0 }), [batches])

  function toggleFormat(format: string) {
    setFormats((current) => {
      const next = new Set(current)
      if (next.has(format)) {
        if (next.size === 1) return current
        next.delete(format)
        setMatrix((cells) => new Set([...cells].filter((cell) => !cell.endsWith(`::${format}`))))
      } else {
        next.add(format)
        setMatrix((cells) => {
          const result = new Set(cells)
          recipes.forEach((_, index) => result.add(`${index}::${format}`))
          return result
        })
      }
      return next
    })
  }

  function toggleCell(cell: string) {
    setMatrix((current) => {
      const next = new Set(current)
      if (next.has(cell)) next.delete(cell)
      else next.add(cell)
      return next
    })
  }

  function toggleSource(artifactId: string) {
    setSourceIds((current) => {
      const next = new Set(current)
      if (next.has(artifactId)) next.delete(artifactId)
      else next.add(artifactId)
      return next
    })
  }

  function resetComposer() {
    setName('')
    setRecipeText('Composição principal')
    setFormats(new Set(['9:16']))
    setMatrix(new Set(['0::9:16']))
    setLocale('pt-BR')
    setBudget('25.00')
    setSourceIds(new Set())
    idempotencyKey.current = null
  }

  async function createBatch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!projectId || name.trim().length < 2) {
      setNotice('Escolha o projeto e informe um nome para o lote.')
      return
    }
    if (sourceIds.size === 0) {
      setNotice('Selecione pelo menos um material com direitos aprovados.')
      return
    }
    if (recipes.length === 0 || selectedCells.length === 0) {
      setNotice('Selecione explicitamente pelo menos uma saída na matriz.')
      return
    }
    const maxCostMinorUnits = Math.round(Number(budget) * 100)
    if (!Number.isSafeInteger(maxCostMinorUnits) || maxCostMinorUnits < 0) {
      setNotice('Informe um teto de custo válido.')
      return
    }
    setBusy(true)
    setNotice(null)
    idempotencyKey.current ??= globalThis.crypto.randomUUID()
    const variants = FORMATS
      .filter((format) => formats.has(format.id))
      .map((format) => ({
        id: `variant-${format.id.replace(':', 'x')}`,
        name: `${format.name} ${format.id}`,
        outputSpecId: format.id,
        locale,
      }))
    const recipeDefinitions = recipes.map((recipe, index) => ({
      id: `recipe-${index + 1}`,
      name: recipe,
      sourceGroupIds: ['sources'],
    }))
    const items = selectedCells.map((cell) => {
      const [recipeIndexText, format] = cell.split('::')
      const recipeIndex = Number(recipeIndexText)
      return {
        key: `output-${recipeIndex + 1}-${format.replace(':', 'x')}`,
        sourceGroupId: 'sources',
        recipeId: `recipe-${recipeIndex + 1}`,
        variantId: `variant-${format.replace(':', 'x')}`,
      }
    })
    try {
      const response = await fetch('/v1/batches', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey.current,
        },
        body: JSON.stringify({
          projectId,
          name: name.trim(),
          objective: selectedProject?.objective || 'discovery',
          sourceGroups: [{
            id: 'sources',
            name: 'Materiais selecionados',
            sourceArtifactIds: [...sourceIds],
          }],
          recipes: recipeDefinitions,
          variants,
          budget: {
            currency: 'USD',
            maxCostMinorUnits,
            reservedCostMinorUnits: 0,
          },
          items,
        }),
      })
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      const payload = await response.json() as ApiEnvelope<{ batch: ProductionBatch }>
      if (!response.ok || !payload.data) throw new Error(apiError(payload, 'Não foi possível criar o lote.'))
      const created = payload.data.batch
      setBatches((current) => [created, ...current.filter((batch) => batch.id !== created.id)])
      setSelectedBatchId(created.id)
      setComposerOpen(false)
      resetComposer()
      setNotice(`Lote “${created.name}” criado com ${created.items.length} saídas explícitas.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível criar o lote.')
    } finally {
      setBusy(false)
    }
  }

  async function readBatch(batchId: string) {
    setSelectedBatchId(batchId)
    setDetailLoading(true)
    try {
      const response = await fetch(`/v1/batches/${encodeURIComponent(batchId)}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      const payload = await response.json() as ApiEnvelope<{ batch: ProductionBatch }>
      if (!response.ok || !payload.data) throw new Error(apiError(payload, 'Não foi possível atualizar o lote.'))
      setBatches((current) => current.map((batch) => batch.id === batchId ? payload.data!.batch : batch))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível atualizar o lote.')
    } finally {
      setDetailLoading(false)
    }
  }

  async function batchAction(batch: ProductionBatch, action: 'cancel' | 'resume', quiet = false) {
    if (!quiet) setBusy(true)
    try {
      const response = await fetch(`/v1/batches/${encodeURIComponent(batch.id)}/actions`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': globalThis.crypto.randomUUID(),
        },
        body: JSON.stringify({ action, expectedBatchRevision: batch.revision }),
      })
      if (response.status === 401) {
        router.replace('/login')
        return false
      }
      const payload = await response.json() as ApiEnvelope<{ batch: ProductionBatch }>
      if (!response.ok || !payload.data) throw new Error(apiError(payload, `Não foi possível ${action === 'cancel' ? 'cancelar' : 'retomar'} o lote.`))
      setBatches((current) => current.map((candidate) => candidate.id === batch.id ? payload.data!.batch : candidate))
      return true
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível alterar o lote.')
      return false
    } finally {
      if (!quiet) setBusy(false)
    }
  }

  async function itemAction(batch: ProductionBatch, item: BatchItem, action: 'resume' | 'retry-step', step?: StepName) {
    setBusy(true)
    try {
      const response = await fetch(`/v1/batches/${encodeURIComponent(batch.id)}/items/${encodeURIComponent(item.id)}/actions`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': globalThis.crypto.randomUUID(),
        },
        body: JSON.stringify({
          action,
          ...(step ? { step } : {}),
          expectedBatchRevision: batch.revision,
          expectedItemRevision: item.revision,
        }),
      })
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      const payload = await response.json() as ApiEnvelope<{ batch: ProductionBatch }>
      if (!response.ok || !payload.data) throw new Error(apiError(payload, 'Não foi possível retentar o item.'))
      setBatches((current) => current.map((candidate) => candidate.id === batch.id ? payload.data!.batch : candidate))
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível retentar o item.')
    } finally {
      setBusy(false)
    }
  }

  async function bulkAction(action: 'cancel' | 'resume') {
    const candidates = batches.filter((batch) =>
      selectedIds.has(batch.id) &&
      (action === 'cancel'
        ? !['completed', 'cancelled'].includes(batch.status)
        : batch.status === 'cancelled'),
    )
    if (candidates.length === 0) {
      setNotice(`Nenhum lote selecionado pode ser ${action === 'cancel' ? 'cancelado' : 'retomado'}.`)
      return
    }
    setBusy(true)
    setNotice(null)
    let completed = 0
    for (const batch of candidates) {
      if (await batchAction(batch, action, true)) completed += 1
    }
    setBusy(false)
    setSelectedIds(new Set())
    setNotice(`${completed} lote${completed === 1 ? '' : 's'} ${action === 'cancel' ? 'cancelado' : 'retomados'} pela API.`)
  }

  function openScriptComposer() {
    if (!selectedBatch) return
    setScriptTitle(
      activeAlignment?.document.title ||
      `Roteiro · ${selectedBatch.name}`,
    )
    if (!scriptRawText) {
      setScriptRawText([
        'HOOK 1: ',
        '',
        'CORPO 1: ',
        '',
        'PROVA 1: ',
        '',
        'CTA 1: ',
      ].join('\n'))
    }
    setScriptComposerOpen(true)
    scriptIdempotencyKey.current = null
  }

  function toggleScriptSource(transcriptId: string) {
    setScriptSourceIds((current) => {
      const next = new Set(current)
      if (next.has(transcriptId)) next.delete(transcriptId)
      else next.add(transcriptId)
      return next
    })
    scriptIdempotencyKey.current = null
  }

  async function createAlignment(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault()
    if (
      !selectedBatch ||
      scriptTitle.trim().length < 2 ||
      scriptRawText.trim().length < 3 ||
      scriptSourceIds.size === 0
    ) {
      setNotice(
        'Informe o roteiro e selecione pelo menos uma transcrição do lote.',
      )
      return
    }
    setBusy(true)
    setNotice(null)
    scriptIdempotencyKey.current ??= globalThis.crypto.randomUUID()
    try {
      const sources = batchTranscripts
        .filter((transcript) => scriptSourceIds.has(transcript.id))
        .map((transcript) => ({
          transcriptId: transcript.id,
          expectedTranscriptHash: transcript.transcriptHash,
          ...(scriptRoleHints[transcript.id]
            ? { roleHint: scriptRoleHints[transcript.id] }
            : {}),
        }))
      const response = await fetch(
        `/v1/batches/${encodeURIComponent(selectedBatch.id)}/script-alignments`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': scriptIdempotencyKey.current,
          },
          body: JSON.stringify({
            title: scriptTitle.trim(),
            locale: scriptLocale.trim(),
            rawText: scriptRawText,
            sources,
          }),
        },
      )
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      const payload = await response.json() as
        ApiEnvelope<{ alignment: ScriptAlignmentRun; replayed: boolean }>
      if (!response.ok || !payload.data) {
        throw new Error(apiError(
          payload,
          'Não foi possível alinhar o roteiro.',
        ))
      }
      const alignment = payload.data.alignment
      setAlignments((current) => [
        alignment,
        ...current.filter((candidate) =>
          candidate.id !== alignment.id),
      ])
      setActiveAlignmentId(alignment.id)
      setActiveTakeLibraryId(null)
      setScriptComposerOpen(false)
      setDetailView('script')
      scriptIdempotencyKey.current = null
      takeLibraryIdempotencyKey.current = null
      setNotice(
        alignment.summary.reviewRequiredCount > 0
          ? `Roteiro alinhado. ${alignment.summary.reviewRequiredCount} decisão${alignment.summary.reviewRequiredCount === 1 ? '' : 'ões'} precisa${alignment.summary.reviewRequiredCount === 1 ? '' : 'm'} de revisão.`
          : 'Roteiro alinhado sem pendências.',
      )
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Não foi possível alinhar o roteiro.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function reviewAlignment(decision: ScriptReviewDecision) {
    if (!selectedBatch || !activeAlignment) return
    setBusy(true)
    setNotice(null)
    try {
      const response = await fetch(
        `/v1/batches/${encodeURIComponent(selectedBatch.id)}/script-alignments/${encodeURIComponent(activeAlignment.id)}/reviews`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': globalThis.crypto.randomUUID(),
          },
          body: JSON.stringify({
            expectedRevision: activeAlignment.revision,
            decisions: [decision],
          }),
        },
      )
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      const payload = await response.json() as
        ApiEnvelope<{ alignment: ScriptAlignmentRun }>
      if (!response.ok || !payload.data) {
        throw new Error(apiError(
          payload,
          'Não foi possível registrar a revisão.',
        ))
      }
      const alignment = payload.data.alignment
      setAlignments((current) => current.map((candidate) =>
        candidate.id === alignment.id ? alignment : candidate))
      setActiveTakeLibraryId(null)
      takeLibraryIdempotencyKey.current = null
      setNotice(
        alignment.summary.reviewRequiredCount > 0
          ? `Decisão registrada. Restam ${alignment.summary.reviewRequiredCount}.`
          : 'Revisão do roteiro concluída.',
      )
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Não foi possível registrar a revisão.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function createTakeLibrary() {
    if (!selectedBatch || !activeAlignment) return
    setBusy(true)
    setNotice(null)
    takeLibraryIdempotencyKey.current ??= globalThis.crypto.randomUUID()
    try {
      const response = await fetch(
        `/v1/batches/${encodeURIComponent(selectedBatch.id)}/take-libraries`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': takeLibraryIdempotencyKey.current,
          },
          body: JSON.stringify({
            alignmentId: activeAlignment.id,
            expectedAlignmentRunHash: activeAlignment.runHash,
            evaluations: [],
          }),
        },
      )
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      const payload = await response.json() as
        ApiEnvelope<{ library: TakeLibraryRun; replayed: boolean }>
      if (!response.ok || !payload.data) {
        throw new Error(apiError(
          payload,
          'Não foi possível criar a biblioteca de takes.',
        ))
      }
      const library = payload.data.library
      setTakeLibraries((current) => [
        library,
        ...current.filter((candidate) => candidate.id !== library.id),
      ])
      setActiveTakeLibraryId(library.id)
      takeLibraryIdempotencyKey.current = null
      setNotice(
        library.summary.needsReviewCount > 0
          ? `Biblioteca criada. ${library.summary.needsReviewCount} take${library.summary.needsReviewCount === 1 ? '' : 's'} precisa${library.summary.needsReviewCount === 1 ? '' : 'm'} de revisão.`
          : 'Biblioteca criada com escolhas automáticas completas.',
      )
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Não foi possível criar a biblioteca de takes.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function selectAndProtectTake(
    group: TakeGroup,
    take: TakeRecord,
  ) {
    if (!selectedBatch || !activeTakeLibrary) return
    const replacedProtectedTakeId =
      group.protectedTakeId && group.protectedTakeId !== take.id
        ? group.protectedTakeId
        : undefined
    if (
      replacedProtectedTakeId &&
      !globalThis.confirm(
        'Este grupo já tem um take protegido. Confirma a troca da proteção?',
      )
    ) {
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const response = await fetch(
        `/v1/batches/${encodeURIComponent(selectedBatch.id)}/take-libraries/${encodeURIComponent(activeTakeLibrary.id)}/selections`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': globalThis.crypto.randomUUID(),
          },
          body: JSON.stringify({
            expectedRevision: activeTakeLibrary.revision,
            groupId: group.id,
            takeId: take.id,
            protect: true,
            ...(replacedProtectedTakeId
              ? { replacedProtectedTakeId }
              : {}),
            note: replacedProtectedTakeId
              ? 'Proteção substituída manualmente no take room.'
              : 'Take escolhido e protegido manualmente no take room.',
          }),
        },
      )
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      const payload = await response.json() as
        ApiEnvelope<{ library: TakeLibraryRun; replayed: boolean }>
      if (!response.ok || !payload.data) {
        throw new Error(apiError(
          payload,
          'Não foi possível proteger o take.',
        ))
      }
      const library = payload.data.library
      setTakeLibraries((current) => current.map((candidate) =>
        candidate.id === library.id ? library : candidate))
      setNotice('Take escolhido e protegido. A fonte original foi preservada.')
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Não foi possível proteger o take.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#070707] text-[#f4f1ea] selection:bg-[#eab83e]/25 selection:text-[#fff8df]">
      <div className="mx-auto flex min-h-screen max-w-[1800px]">
        <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-white/[0.07] bg-[#0a0a0a] px-5 py-6 lg:flex">
          <a className="flex items-center gap-3 px-2" href="/">
            <div className="grid h-9 w-9 place-items-center rounded-[10px] border border-[#e0af37]/35 bg-[#e0af37]/10 text-sm font-black text-[#efc75f]">A</div>
            <div>
              <p className="text-sm font-bold tracking-[0.22em] text-white">APOLLO</p>
              <p className="mt-0.5 text-[9px] uppercase tracking-[0.18em] text-[#66635c]">AI video director</p>
            </div>
          </a>
          <nav aria-label="Navegação principal" className="mt-10 space-y-1">
            <a className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-[#8e8a82] transition hover:bg-white/[0.035] hover:text-white" href="/">
              <Icon path="M4 5.5A1.5 1.5 0 0 1 5.5 4h5A1.5 1.5 0 0 1 12 5.5v5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 10.5v-5Zm8 8A1.5 1.5 0 0 1 13.5 12h5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5v-5Z" />
              Projetos
            </a>
            <a className="flex items-center gap-3 rounded-xl border border-[#e0af37]/20 bg-[#e0af37]/10 px-3 py-2.5 text-sm font-medium text-[#f0c65c]" href="/batches">
              <Icon path="M5 4h14v4H5V4Zm0 6h14v4H5v-4Zm0 6h14v4H5v-4Zm3-10h8m-8 6h5m-5 6h7" />
              Lotes
              <span className="ml-auto rounded-md bg-[#e0af37]/10 px-1.5 py-0.5 text-[8px] uppercase tracking-wider">V2</span>
            </a>
            <div className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-[#5f5c56]">
              <Icon path="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11ZM8 5V3m8 2V3M4 9h16" />
              Biblioteca
              <span className="ml-auto text-[8px] uppercase tracking-wider">em breve</span>
            </div>
          </nav>
          <div className="mt-auto rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3.5">
            <div className="flex items-center gap-2 text-[11px] font-medium text-[#a5a198]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#4fb97a] shadow-[0_0_8px_rgba(79,185,122,.7)]" />
              API V2 conectada
            </div>
            <p className="mt-2 text-[10px] leading-4 text-[#5f5c56]">Matriz explícita · custo real · retry isolado</p>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#070707]/92 px-5 py-4 backdrop-blur-xl sm:px-8 xl:px-10">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <a className="grid h-9 w-9 place-items-center rounded-[10px] border border-[#e0af37]/35 bg-[#e0af37]/10 text-sm font-black text-[#efc75f] lg:hidden" href="/">A</a>
                <div>
                  <p className="text-[9px] uppercase tracking-[0.2em] text-[#6e6a62]">Workspace · Alpes Digital</p>
                  <p className="mt-1 text-sm font-medium text-[#d7d2c8]">Controle de lotes</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button className="hidden h-10 items-center gap-2 rounded-xl border border-white/[0.08] px-3 text-xs text-[#8a867e] transition hover:border-white/[0.16] hover:text-white sm:flex" onClick={() => void fetchBatches()} type="button">
                  <Icon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} path="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6" />
                  Atualizar
                </button>
                <LogoutButton />
              </div>
            </div>
          </header>

          <div className="px-5 py-7 sm:px-8 xl:px-10 xl:py-9">
            <section className="relative overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#0d0d0d] px-6 py-7 sm:px-8 xl:px-9">
              <div aria-hidden="true" className="absolute inset-y-0 left-0 w-[5px] bg-[#dcae3a]" />
              <div aria-hidden="true" className="absolute right-8 top-0 hidden h-full w-52 opacity-[0.055] xl:block" style={{ backgroundImage: 'repeating-linear-gradient(90deg, #fff 0 1px, transparent 1px 26px), repeating-linear-gradient(0deg, #fff 0 1px, transparent 1px 26px)' }} />
              <div className="relative flex flex-col justify-between gap-6 md:flex-row md:items-end">
                <div>
                  <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#c49b39]">
                    <span className="h-px w-7 bg-[#c49b39]/70" /> Production control
                  </div>
                  <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-[-0.045em] text-[#faf7f0] sm:text-4xl xl:text-[44px] xl:leading-[1.02]">
                    Cada saída é uma decisão.
                    <span className="block text-[#8e8980]">Nenhuma combinação nasce por acidente.</span>
                  </h1>
                  <p className="mt-4 max-w-2xl text-sm leading-6 text-[#817d75]">
                    Escolha materiais, receitas e formatos. O Apollo acompanha cada item separadamente e preserva o que já foi concluído.
                  </p>
                </div>
                <button className="group flex h-12 shrink-0 items-center justify-center gap-3 rounded-xl bg-[#e0af37] px-5 text-sm font-bold text-[#171207] shadow-[0_12px_35px_rgba(224,175,55,.16)] transition hover:-translate-y-0.5 hover:bg-[#efc34f]" onClick={() => { setNotice(null); setComposerOpen(true) }} type="button">
                  <span className="text-xl font-light">＋</span>
                  Planejar lote
                  <span className="transition-transform group-hover:translate-x-0.5">→</span>
                </button>
              </div>
            </section>

            {notice ? (
              <div className="mt-4 flex items-start justify-between gap-4 rounded-xl border border-[#d6a638]/20 bg-[#d6a638]/[0.07] px-4 py-3 text-sm leading-5 text-[#d8c590]" role="status">
                <span>{notice}</span>
                <button aria-label="Fechar aviso" className="text-[#8f8059] hover:text-[#e4c878]" onClick={() => setNotice(null)} type="button">×</button>
              </div>
            ) : null}

            <section aria-label="Resumo dos lotes" className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
              {[
                ['total', 'Lotes visíveis', totalCounts.total, '#e7e1d7'],
                ['running', 'Em produção', totalCounts.running, '#78a5dc'],
                ['review', 'Aguardando revisão', totalCounts.review, '#ca91d4'],
                ['attention', 'Pedem atenção', totalCounts.attention, '#e2b94f'],
              ].map(([key, label, value, color]) => (
                <article className="rounded-2xl border border-white/[0.07] bg-[#0b0b0b] px-4 py-4 sm:px-5" key={String(key)}>
                  <p className="text-2xl font-semibold tabular-nums" style={{ color: String(color) }}>{Number(value)}</p>
                  <p className="mt-1 text-[11px] text-[#77736c]">{String(label)}</p>
                </article>
              ))}
            </section>

            <section className="mt-8 grid gap-5 2xl:grid-cols-[minmax(390px,0.74fr)_minmax(650px,1.26fr)]">
              <div className="min-w-0">
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#6d6962]">Fila de produção</p>
                    <h2 className="mt-1 text-2xl font-semibold tracking-[-0.025em] text-[#f0ece4]">Lotes do workspace</h2>
                  </div>
                  <div className="flex gap-2">
                    <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/[0.08] bg-[#0c0c0c] px-3 text-[#77736b]">
                      <Icon className="h-4 w-4 shrink-0" path="m20 20-4.4-4.4m2.4-4.1a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" />
                      <input aria-label="Buscar lotes" className="h-10 min-w-0 flex-1 bg-transparent text-sm text-[#e6e1d8] outline-none placeholder:text-[#5e5b55]" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar lote" value={query} />
                    </label>
                    <select aria-label="Filtrar lotes por status" className="h-10 max-w-[150px] rounded-xl border border-white/[0.08] bg-[#0c0c0c] px-3 text-xs text-[#aaa59c] outline-none focus:border-[#d7a936]/50" onChange={(event) => setStatusFilter(event.target.value as 'all' | BatchStatus)} value={statusFilter}>
                      {STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}
                    </select>
                  </div>
                </div>

                {selectedIds.size > 0 ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-[#d7aa39]/20 bg-[#d7aa39]/[0.06] px-3 py-2">
                    <span className="mr-auto text-[11px] font-medium text-[#d3b86f]">{selectedIds.size} selecionado{selectedIds.size === 1 ? '' : 's'}</span>
                    <button className="rounded-lg border border-white/[0.1] px-2.5 py-1.5 text-[10px] text-[#aaa49a] transition hover:text-white disabled:opacity-40" disabled={busy} onClick={() => void bulkAction('resume')} type="button">Retomar</button>
                    <button className="rounded-lg border border-[#bd6262]/20 px-2.5 py-1.5 text-[10px] text-[#d78383] transition hover:bg-[#bd6262]/10 disabled:opacity-40" disabled={busy} onClick={() => void bulkAction('cancel')} type="button">Cancelar</button>
                    <button aria-label="Limpar seleção" className="px-1 text-[#756f65] hover:text-white" onClick={() => setSelectedIds(new Set())} type="button">×</button>
                  </div>
                ) : null}

                <div className="mt-4 space-y-3">
                  {loading ? (
                    [0, 1, 2].map((item) => <div className="h-44 animate-pulse rounded-2xl border border-white/[0.05] bg-white/[0.025]" key={item} />)
                  ) : batches.length === 0 ? (
                    <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-white/[0.11] bg-[#0a0a0a] px-6 text-center">
                      <div>
                        <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-[#d8a936]/20 bg-[#d8a936]/[0.06] text-[#c89d35]">
                          <Icon path="M5 4h14v4H5V4Zm0 6h14v4H5v-4Zm0 6h14v4H5v-4Z" />
                        </div>
                        <h3 className="mt-4 text-base font-semibold text-[#e8e3da]">Nenhum lote neste recorte</h3>
                        <p className="mt-1 text-xs leading-5 text-[#77736c]">Ajuste os filtros ou planeje a primeira matriz de saídas.</p>
                      </div>
                    </div>
                  ) : batches.map((batch) => {
                    const active = selectedBatchId === batch.id
                    const checked = selectedIds.has(batch.id)
                    return (
                      <article className={`relative overflow-hidden rounded-2xl border bg-[#0b0b0b] transition ${active ? 'border-[#d8a936]/45 shadow-[0_10px_40px_rgba(0,0,0,.22)]' : 'border-white/[0.075] hover:border-white/[0.15]'}`} key={batch.id}>
                        {active ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-[#ddaF3b]" /> : null}
                        <div className="p-4 sm:p-5">
                          <div className="flex items-start gap-3">
                            <label className="mt-0.5 grid h-6 w-6 shrink-0 cursor-pointer place-items-center">
                              <input
                                aria-label={`Selecionar lote ${batch.name}`}
                                checked={checked}
                                className="h-4 w-4 accent-[#dcae3a]"
                                onChange={() => setSelectedIds((current) => {
                                  const next = new Set(current)
                                  if (next.has(batch.id)) next.delete(batch.id)
                                  else next.add(batch.id)
                                  return next
                                })}
                                type="checkbox"
                              />
                            </label>
                            <button className="min-w-0 flex-1 text-left" onClick={() => void readBatch(batch.id)} type="button">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <h3 className="truncate text-sm font-semibold text-[#eee9e0]">{batch.name}</h3>
                                  <p className="mt-1 truncate text-[10px] uppercase tracking-[0.12em] text-[#66625b]">{projects.find((project) => project.id === batch.projectId)?.name ?? batch.projectId}</p>
                                </div>
                                <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[9px] ${STATUS_STYLES[batch.status]}`}>{STATUS_LABELS[batch.status]}</span>
                              </div>
                              <div className="mt-4 flex items-end gap-4">
                                <div className="min-w-0 flex-1">
                                  <div className="mb-1.5 flex justify-between text-[10px] text-[#77736c]">
                                    <span>{batch.progress.completedSteps}/{batch.progress.totalSteps} etapas</span>
                                    <span className="font-mono text-[#bcb6ac]">{batch.progress.percent}%</span>
                                  </div>
                                  <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                                    <div className="h-full rounded-full bg-[#d9aa39] transition-[width] duration-500" style={{ width: `${batch.progress.percent}%` }} />
                                  </div>
                                </div>
                                <span className="font-mono text-[10px] text-[#827d74]">{batch.progress.totalItems} saídas</span>
                              </div>
                              <div className="mt-4 flex items-center justify-between border-t border-white/[0.055] pt-3 text-[10px] text-[#625f59]">
                                <span>{batch.variants.map((variant) => variant.outputSpecId).join(' · ')}</span>
                                <span>{money(batch.progress.spentMinorUnits)} · {elapsed(batch.updatedAt)}</span>
                              </div>
                            </button>
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              </div>

              <aside className="min-w-0 2xl:sticky 2xl:top-[92px] 2xl:self-start">
                {!selectedBatch ? (
                  <div className="grid min-h-[520px] place-items-center rounded-[22px] border border-dashed border-white/[0.1] bg-[#0a0a0a] px-8 text-center">
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.2em] text-[#66625b]">Telemetry</p>
                      <h3 className="mt-3 text-lg font-semibold text-[#d8d2c8]">Selecione um lote</h3>
                      <p className="mt-2 max-w-sm text-sm leading-6 text-[#716d66]">Aqui aparecem os itens, as quatro etapas, falhas, artifacts e tentativas reais.</p>
                    </div>
                  </div>
                ) : (
                  <div className={`overflow-hidden rounded-[22px] border border-white/[0.08] bg-[#0b0b0b] ${detailLoading ? 'opacity-70' : ''}`}>
                    <div className="border-b border-white/[0.07] px-5 py-5 sm:px-6">
                      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-[#9a762c]">
                            <span className="h-px w-5 bg-[#9a762c]" /> Lote ativo
                          </div>
                          <h2 className="mt-2 truncate text-xl font-semibold tracking-[-0.025em] text-[#f0ece4]">{selectedBatch.name}</h2>
                          <p className="mt-1 text-xs text-[#6f6b64]">{selectedBatch.objective} · revisão {selectedBatch.revision}</p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {selectedBatch.status === 'cancelled' ? (
                            <button className="rounded-lg border border-[#d5a638]/25 px-3 py-2 text-[10px] font-semibold text-[#dcba62] transition hover:bg-[#d5a638]/10 disabled:opacity-40" disabled={busy} onClick={() => void batchAction(selectedBatch, 'resume')} type="button">Retomar lote</button>
                          ) : selectedBatch.status !== 'completed' ? (
                            <button className="rounded-lg border border-[#ba5e5e]/20 px-3 py-2 text-[10px] font-semibold text-[#d17a7a] transition hover:bg-[#ba5e5e]/10 disabled:opacity-40" disabled={busy} onClick={() => void batchAction(selectedBatch, 'cancel')} type="button">Cancelar lote</button>
                          ) : null}
                          <button aria-label="Atualizar detalhe" className="grid h-9 w-9 place-items-center rounded-lg border border-white/[0.08] text-[#77736c] transition hover:text-white" disabled={detailLoading} onClick={() => void readBatch(selectedBatch.id)} type="button">
                            <Icon className={`h-4 w-4 ${detailLoading ? 'animate-spin' : ''}`} path="M20 12a8 8 0 1 1-2.34-5.66M20 4v6h-6" />
                          </button>
                        </div>
                      </div>

                      <div className="mt-5 grid grid-cols-[110px_1fr] items-center gap-5 sm:grid-cols-[132px_1fr]">
                        <div className="relative grid aspect-square place-items-center rounded-full" style={{ background: `conic-gradient(#dcae3a ${selectedBatch.progress.percent * 3.6}deg, #24221e 0deg)` }}>
                          <div className="grid h-[82%] w-[82%] place-items-center rounded-full bg-[#0b0b0b]">
                            <div className="text-center">
                              <p className="font-mono text-2xl font-semibold text-[#f0ca67]">{selectedBatch.progress.percent}%</p>
                              <p className="mt-0.5 text-[8px] uppercase tracking-[0.16em] text-[#66625b]">real</p>
                            </div>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3">
                          <div><p className="font-mono text-base text-[#ddd7cd]">{selectedBatch.progress.totalItems}</p><p className="text-[9px] text-[#6e6a63]">saídas</p></div>
                          <div><p className="font-mono text-base text-[#75bd90]">{selectedBatch.progress.completedItems}</p><p className="text-[9px] text-[#6e6a63]">concluídas</p></div>
                          <div><p className="font-mono text-base text-[#de7f7f]">{selectedBatch.progress.failedItems}</p><p className="text-[9px] text-[#6e6a63]">com falha</p></div>
                          <div><p className="font-mono text-base text-[#ddd7cd]">{money(selectedBatch.progress.spentMinorUnits)}</p><p className="text-[9px] text-[#6e6a63]">consumido</p></div>
                          <div><p className="font-mono text-base text-[#ddd7cd]">{money(selectedBatch.progress.remainingMinorUnits)}</p><p className="text-[9px] text-[#6e6a63]">disponível</p></div>
                          <div><p className="font-mono text-base text-[#ddd7cd]">{selectedBatch.recipes.length} × {selectedBatch.variants.length}</p><p className="text-[9px] text-[#6e6a63]">receitas × formatos</p></div>
                        </div>
                      </div>
                    </div>

                    <div className="flex border-b border-white/[0.07] bg-[#090909] px-3 pt-2 sm:px-4">
                      <button
                        className={`relative px-3 py-3 text-[10px] font-semibold transition ${detailView === 'script' ? 'text-[#e7bd59]' : 'text-[#77736c] hover:text-[#bbb5ab]'}`}
                        onClick={() => setDetailView('script')}
                        type="button"
                      >
                        Roteiro & takes
                        {activeAlignment?.summary.reviewRequiredCount ? (
                          <span className="ml-2 rounded-full bg-[#d8a936]/15 px-1.5 py-0.5 font-mono text-[8px] text-[#dfba60]">{activeAlignment.summary.reviewRequiredCount}</span>
                        ) : null}
                        {detailView === 'script' ? <span className="absolute inset-x-2 bottom-0 h-px bg-[#d8a936]" /> : null}
                      </button>
                      <button
                        className={`relative px-3 py-3 text-[10px] font-semibold transition ${detailView === 'outputs' ? 'text-[#e7bd59]' : 'text-[#77736c] hover:text-[#bbb5ab]'}`}
                        onClick={() => setDetailView('outputs')}
                        type="button"
                      >
                        Saídas do lote
                        <span className="ml-2 font-mono text-[8px] text-[#6c6861]">{selectedBatch.items.length}</span>
                        {detailView === 'outputs' ? <span className="absolute inset-x-2 bottom-0 h-px bg-[#d8a936]" /> : null}
                      </button>
                    </div>

                    {detailView === 'outputs' ? (
                    <div className="max-h-[620px] space-y-2 overflow-y-auto p-3 sm:p-4">
                      {selectedBatch.items.map((item, index) => {
                        const recipe = selectedBatch.recipes.find((candidate) => candidate.id === item.recipeId)
                        const variant = selectedBatch.variants.find((candidate) => candidate.id === item.variantId)
                        const failedStep = item.steps.find((step) => step.state === 'failed')
                        return (
                          <article className={`rounded-xl border p-3.5 ${item.state === 'failed' ? 'border-[#c95f5f]/25 bg-[#c95f5f]/[0.04]' : item.state === 'cancelled' ? 'border-white/[0.06] bg-white/[0.015] opacity-75' : 'border-white/[0.07] bg-[#0e0e0e]'}`} key={item.id}>
                            <div className="flex items-start gap-3">
                              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-[#090909] font-mono text-[10px] text-[#77736c]">{String(index + 1).padStart(2, '0')}</div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <h3 className="truncate text-xs font-semibold text-[#dcd6cc]">{recipe?.name ?? item.recipeId}</h3>
                                    <p className="mt-1 text-[9px] uppercase tracking-[0.12em] text-[#69655e]">{variant?.outputSpecId ?? item.variantId} · {variant?.locale ?? '—'} · retry {item.retryCount}</p>
                                  </div>
                                  <span className={`shrink-0 text-[9px] ${item.state === 'failed' ? 'text-[#e08080]' : item.state === 'completed' ? 'text-[#70bc8b]' : 'text-[#8f8980]'}`}>{item.state}</span>
                                </div>
                                <div className="mt-3"><StepRail compact steps={item.steps} /></div>
                                {item.error ? (
                                  <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-[#c65e5e]/15 bg-[#c65e5e]/[0.05] px-3 py-2">
                                    <p className="min-w-0 text-[10px] leading-4 text-[#cf8989]"><span className="font-mono text-[#e39a9a]">{item.error.code}</span> · {item.error.message}</p>
                                    {failedStep ? (
                                      <button className="shrink-0 rounded-md border border-[#d5a638]/20 px-2 py-1 text-[9px] font-semibold text-[#d8b65c] hover:bg-[#d5a638]/10 disabled:opacity-40" disabled={busy} onClick={() => void itemAction(selectedBatch, item, 'retry-step', failedStep.step)} type="button">Retentar {STEP_LABELS[failedStep.step]}</button>
                                    ) : null}
                                  </div>
                                ) : item.state === 'cancelled' && selectedBatch.status !== 'cancelled' ? (
                                  <button className="mt-3 rounded-md border border-[#d5a638]/20 px-2 py-1 text-[9px] font-semibold text-[#d8b65c] hover:bg-[#d5a638]/10 disabled:opacity-40" disabled={busy} onClick={() => void itemAction(selectedBatch, item, 'resume')} type="button">Retomar item</button>
                                ) : null}
                                {item.artifactIds.length > 0 ? (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {item.artifactIds.map((artifactId) => <span className="max-w-[190px] truncate rounded-md bg-white/[0.035] px-2 py-1 font-mono text-[8px] text-[#77736c]" key={artifactId} title={artifactId}>↳ {artifactId}</span>)}
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </article>
                        )
                      })}
                    </div>
                    ) : (
                      <div className="max-h-[720px] overflow-y-auto p-3 sm:p-4" data-testid="script-alignment-panel">
                        {alignmentLoading ? (
                          <div className="space-y-3">
                            <div className="h-24 animate-pulse rounded-xl bg-white/[0.025]" />
                            <div className="h-40 animate-pulse rounded-xl bg-white/[0.025]" />
                          </div>
                        ) : batchTranscripts.length === 0 ? (
                          <div className="grid min-h-56 place-items-center rounded-xl border border-dashed border-[#bd6666]/25 bg-[#bd6666]/[0.035] p-7 text-center">
                            <div>
                              <p className="text-sm font-semibold text-[#d9b0b0]">Nenhuma fala transcrita neste lote</p>
                              <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-[#846f6f]">Conclua a ingestão e a transcrição dos materiais selecionados. O alinhamento usa as palavras e os tempos canônicos da API.</p>
                            </div>
                          </div>
                        ) : !activeAlignment ? (
                          <div className="relative overflow-hidden rounded-xl border border-[#d5a638]/20 bg-[#d5a638]/[0.035] p-5">
                            <div aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-[#d7a937]" />
                            <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#a98536]">Script slate · aguardando</p>
                            <h3 className="mt-3 text-lg font-semibold tracking-[-0.02em] text-[#e9e3d9]">Compare o planejado com o que foi gravado.</h3>
                            <p className="mt-2 max-w-xl text-xs leading-5 text-[#817c73]">O Apollo separa hooks, corpos, provas e CTAs, encontra os ranges exatos e sinaliza somente o que exige decisão humana.</p>
                            <div className="mt-5 flex flex-wrap items-center gap-3">
                              <button className="rounded-lg bg-[#dcae3a] px-4 py-2.5 text-xs font-bold text-[#171207] transition hover:bg-[#efc34f] disabled:opacity-40" disabled={busy} onClick={openScriptComposer} type="button">Importar roteiro</button>
                              <span className="font-mono text-[9px] text-[#777169]">{batchTranscripts.length} transcrição{batchTranscripts.length === 1 ? '' : 'ões'} disponível{batchTranscripts.length === 1 ? '' : 'is'}</span>
                            </div>
                          </div>
                        ) : (
                          <div>
                            <div className="flex flex-col gap-3 rounded-xl border border-white/[0.07] bg-[#0e0e0e] p-4 sm:flex-row sm:items-start sm:justify-between">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-[#9a762c]"><span className="h-px w-5 bg-[#9a762c]" /> Script slate</div>
                                <h3 className="mt-2 truncate text-base font-semibold text-[#eee8de]">{activeAlignment.document.title}</h3>
                                <p className="mt-1 text-[10px] text-[#6e6961]">{activeAlignment.document.locale} · revisão {activeAlignment.revision} · {elapsed(activeAlignment.updatedAt)}</p>
                              </div>
                              <div className="flex shrink-0 items-center gap-2">
                                {alignments.length > 1 ? (
                                  <select aria-label="Escolher alinhamento" className="h-9 max-w-[180px] rounded-lg border border-white/[0.08] bg-[#090909] px-2 text-[10px] text-[#aaa49a] outline-none" onChange={(event) => { setActiveAlignmentId(event.target.value); setActiveTakeLibraryId(null); takeLibraryIdempotencyKey.current = null }} value={activeAlignment.id}>
                                    {alignments.map((alignment) => <option key={alignment.id} value={alignment.id}>{alignment.document.title} · r{alignment.revision}</option>)}
                                  </select>
                                ) : null}
                                <button className="h-9 rounded-lg border border-[#d5a638]/20 px-3 text-[10px] font-semibold text-[#d7b559] transition hover:bg-[#d5a638]/10" onClick={openScriptComposer} type="button">Novo alinhamento</button>
                              </div>
                            </div>

                            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                              {[
                                ['Confiança média', `${Math.round(activeAlignment.summary.averageConfidence)}%`],
                                ['Blocos', activeAlignment.summary.blockCount],
                                ['Ambíguos', activeAlignment.summary.ambiguousCount],
                                ['Pendências', activeAlignment.summary.reviewRequiredCount],
                              ].map(([label, value]) => (
                                <div className="rounded-lg border border-white/[0.06] bg-[#0d0d0d] px-3 py-2.5" key={String(label)}>
                                  <p className="font-mono text-sm font-semibold text-[#d8d1c6]">{value}</p>
                                  <p className="mt-1 text-[8px] uppercase tracking-[0.1em] text-[#625e57]">{label}</p>
                                </div>
                              ))}
                            </div>

                            <div aria-label="Ordem planejada do roteiro" className="mt-4 flex overflow-hidden rounded-lg border border-white/[0.07] bg-[#090909] p-2">
                              {activeAlignment.alignments.map((alignment) => (
                                <div className="flex min-w-0 flex-1 items-center" key={alignment.blockId}>
                                  <div className={`grid h-6 w-6 shrink-0 place-items-center rounded-md border font-mono text-[8px] ${alignment.reviewStatus === 'review-required' ? 'border-[#d8a936]/40 bg-[#d8a936]/10 text-[#e4bd60]' : alignment.kind === 'missing' ? 'border-[#c96262]/30 bg-[#c96262]/10 text-[#d77b7b]' : 'border-[#5dae7a]/25 bg-[#5dae7a]/10 text-[#76bf90]'}`}>{alignment.documentOrder + 1}</div>
                                  {alignment.documentOrder < activeAlignment.alignments.length - 1 ? <span className="h-px min-w-2 flex-1 bg-white/[0.08]" /> : null}
                                </div>
                              ))}
                            </div>

                            <div className="mt-4 space-y-3">
                              {activeAlignment.alignments.map((alignment) => {
                                const block = activeAlignment.document.blocks.find((candidate) => candidate.id === alignment.blockId)
                                const range = alignment.selectedCandidate?.sourceRangeMs
                                return (
                                  <article className={`relative overflow-hidden rounded-xl border bg-[#0d0d0d] ${alignment.reviewStatus === 'review-required' ? 'border-[#d6a638]/25' : 'border-white/[0.07]'}`} data-testid={`alignment-block-${alignment.blockId}`} key={alignment.blockId}>
                                    <div aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${alignment.reviewStatus === 'review-required' ? 'bg-[#d8a936]' : 'bg-[#4d8c67]'}`} />
                                    <div className="p-4 pl-5">
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                          <span className="font-mono text-[9px] text-[#777169]">{String(alignment.documentOrder + 1).padStart(2, '0')}</span>
                                          <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[#b28c38]">{SCRIPT_ROLE_LABELS[alignment.role]}</span>
                                          <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[8px] text-[#777169]">{SCRIPT_KIND_LABELS[alignment.kind]}</span>
                                        </div>
                                        <div className="text-right">
                                          <p className={`font-mono text-sm font-semibold ${alignment.confidence >= 80 ? 'text-[#73bb8d]' : alignment.confidence >= 60 ? 'text-[#dfb85b]' : 'text-[#d57979]'}`}>{Math.round(alignment.confidence)}%</p>
                                          {range ? <p className="mt-0.5 font-mono text-[8px] text-[#625e57]">{timecode(range[0])} → {timecode(range[1])}</p> : null}
                                        </div>
                                      </div>
                                      <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                        <div className="rounded-lg border border-white/[0.055] bg-[#090909] p-3">
                                          <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-[#5f5b54]">Planejado</p>
                                          <p className="mt-2 text-xs leading-5 text-[#c9c2b8]">{block?.plannedText ?? 'Bloco não encontrado'}</p>
                                        </div>
                                        <div className="rounded-lg border border-white/[0.055] bg-[#090909] p-3">
                                          <p className="text-[8px] font-semibold uppercase tracking-[0.14em] text-[#5f5b54]">Falado</p>
                                          <p className="mt-2 text-xs leading-5 text-[#e1dbd1]">{alignment.selectedCandidate?.spokenText ?? 'Nenhum trecho atribuído'}</p>
                                        </div>
                                      </div>
                                      {alignment.selectedCandidate?.deviations.length ? (
                                        <div className="mt-2 flex flex-wrap gap-1.5">
                                          {alignment.selectedCandidate.deviations.map((deviation) => <span className="rounded-md border border-[#c98a4d]/15 bg-[#c98a4d]/[0.06] px-2 py-1 text-[8px] text-[#bd9269]" key={`${deviation.kind}-${deviation.reasonCode}`}>{deviation.kind}</span>)}
                                        </div>
                                      ) : null}
                                      {alignment.reviewStatus === 'review-required' ? (
                                        <div className="mt-3 flex flex-wrap gap-2 border-t border-white/[0.055] pt-3">
                                          {alignment.selectedCandidate ? <button className="rounded-lg bg-[#d7a936] px-3 py-2 text-[9px] font-bold text-[#171207] disabled:opacity-40" disabled={busy} onClick={() => void reviewAlignment({ targetKind: 'block', blockId: alignment.blockId, resolution: 'accept' })} type="button">Confirmar trecho</button> : null}
                                          <button className="rounded-lg border border-white/[0.09] px-3 py-2 text-[9px] font-semibold text-[#9b958c] disabled:opacity-40" disabled={busy} onClick={() => void reviewAlignment({ targetKind: 'block', blockId: alignment.blockId, resolution: 'mark-missing' })} type="button">Marcar ausente</button>
                                          {alignment.alternatives.map((alternative, index) => (
                                            <button className="rounded-lg border border-[#7b79bd]/20 px-3 py-2 text-[9px] font-semibold text-[#9c9ad4] disabled:opacity-40" disabled={busy} key={alternative.id} onClick={() => void reviewAlignment({ targetKind: 'block', blockId: alignment.blockId, resolution: 'select-alternative', candidateId: alternative.id })} title={alternative.spokenText} type="button">Usar take {index + 2} · {Math.round(alternative.metrics.total)}%</button>
                                          ))}
                                        </div>
                                      ) : (
                                        <p className="mt-3 text-[9px] text-[#63856f]">✓ Decisão registrada</p>
                                      )}
                                    </div>
                                  </article>
                                )
                              })}
                            </div>

                            {activeAlignment.extraTakes.length > 0 ? (
                              <section className="mt-5">
                                <div className="flex items-end justify-between">
                                  <div>
                                    <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#756f66]">Fora do roteiro</p>
                                    <h4 className="mt-1 text-sm font-semibold text-[#cfc8be]">Takes extras</h4>
                                  </div>
                                  <span className="font-mono text-[9px] text-[#6d6860]">{activeAlignment.extraTakes.length}</span>
                                </div>
                                <div className="mt-2 space-y-2">
                                  {activeAlignment.extraTakes.map((extra) => (
                                    <article className="rounded-lg border border-white/[0.06] bg-[#0d0d0d] p-3" key={extra.id}>
                                      <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                          <p className="text-[10px] leading-4 text-[#aaa49a]">{extra.spokenText}</p>
                                          <p className="mt-1 font-mono text-[8px] text-[#5f5b54]">{timecode(extra.sourceRangeMs[0])} → {timecode(extra.sourceRangeMs[1])}</p>
                                        </div>
                                        {extra.reviewStatus === 'review-required' ? (
                                          <div className="flex shrink-0 gap-1.5">
                                            <button className="rounded-md border border-[#5da879]/20 px-2 py-1.5 text-[8px] font-semibold text-[#75b98d] disabled:opacity-40" disabled={busy} onClick={() => void reviewAlignment({ targetKind: 'extra-take', extraTakeId: extra.id, resolution: 'accept-extra' })} type="button">Aproveitar</button>
                                            <button className="rounded-md border border-white/[0.08] px-2 py-1.5 text-[8px] font-semibold text-[#858078] disabled:opacity-40" disabled={busy} onClick={() => void reviewAlignment({ targetKind: 'extra-take', extraTakeId: extra.id, resolution: 'reject-extra' })} type="button">Ignorar</button>
                                          </div>
                                        ) : <span className={`shrink-0 text-[8px] ${extra.reviewStatus === 'accepted' ? 'text-[#70b588]' : 'text-[#6e6961]'}`}>{extra.reviewStatus === 'accepted' ? 'aproveitado' : 'ignorado'}</span>}
                                      </div>
                                    </article>
                                  ))}
                                </div>
                              </section>
                            ) : null}

                            <section
                              className="mt-6 border-t border-dashed border-[#d8aa38]/20 pt-5"
                              data-testid="take-library-panel"
                            >
                              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.18em] text-[#a8802f]">
                                    <span className="grid h-5 w-5 place-items-center rounded-full border border-[#c99a32]/30 font-mono text-[7px]">T</span>
                                    Take room
                                  </div>
                                  <h4 className="mt-2 text-base font-semibold tracking-[-0.02em] text-[#ede7dd]">Biblioteca de performance</h4>
                                  <p className="mt-1 max-w-xl text-[10px] leading-4 text-[#746f67]">Cada cartão é um take preservado na fonte. O Apollo separa retakes, mede cinco dimensões e só troca uma escolha protegida com confirmação explícita.</p>
                                </div>
                                <div className="flex shrink-0 flex-wrap items-center gap-2">
                                  {activeAlignmentLibraries.length > 1 && activeTakeLibrary ? (
                                    <select
                                      aria-label="Escolher avaliação de takes"
                                      className="h-9 max-w-[190px] rounded-lg border border-white/[0.08] bg-[#090909] px-2 text-[9px] text-[#aaa49a] outline-none focus:border-[#d5a535]/45"
                                      onChange={(event) => setActiveTakeLibraryId(event.target.value)}
                                      value={activeTakeLibrary.id}
                                    >
                                      {activeAlignmentLibraries.map((library) => (
                                        <option key={library.id} value={library.id}>
                                          {library.summary.takeCount} takes · r{library.revision} · {elapsed(library.updatedAt)}
                                        </option>
                                      ))}
                                    </select>
                                  ) : null}
                                  <button
                                    className="h-9 rounded-lg bg-[#dcae3a] px-3 text-[10px] font-bold text-[#171207] transition hover:bg-[#efc34f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#efc34f] disabled:cursor-not-allowed disabled:opacity-40"
                                    data-testid="create-take-library"
                                    disabled={busy}
                                    onClick={() => void createTakeLibrary()}
                                    type="button"
                                  >
                                    {activeTakeLibrary ? 'Nova avaliação' : 'Avaliar takes'}
                                  </button>
                                </div>
                              </div>

                              {!activeTakeLibrary ? (
                                <div className="mt-4 rounded-xl border border-[#d5a638]/18 bg-[#d5a638]/[0.035] p-4">
                                  <p className="text-xs font-semibold text-[#d9c08a]">
                                    {takeLibraries.some((library) =>
                                      library.alignmentId === activeAlignment.id)
                                      ? 'O roteiro mudou desde a última avaliação.'
                                      : 'Os takes ainda não foram avaliados.'}
                                  </p>
                                  <p className="mt-1 text-[10px] leading-4 text-[#81755f]">Crie uma biblioteca vinculada ao hash exato deste alinhamento. Dimensões sem evidência ficam visivelmente pendentes, nunca recebem nota inventada.</p>
                                </div>
                              ) : (
                                <div className="mt-4">
                                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                    {[
                                      ['Grupos', activeTakeLibrary.summary.groupCount],
                                      ['Takes', activeTakeLibrary.summary.takeCount],
                                      ['Protegidos', activeTakeLibrary.summary.protectedCount],
                                      ['Revisar', activeTakeLibrary.summary.needsReviewCount],
                                    ].map(([label, value]) => (
                                      <div className="rounded-lg border border-white/[0.06] bg-[#0a0a0a] px-3 py-2.5" key={String(label)}>
                                        <p className="font-mono text-sm font-semibold text-[#ddd6cb]">{value}</p>
                                        <p className="mt-1 text-[8px] uppercase tracking-[0.1em] text-[#625e57]">{label}</p>
                                      </div>
                                    ))}
                                  </div>

                                  <div className="mt-4 space-y-4">
                                    {activeTakeLibrary.groups.map((group, groupIndex) => {
                                      const groupTakes = activeTakesByGroup.get(group.id) ?? []
                                      return (
                                        <article
                                          className="overflow-hidden rounded-xl border border-white/[0.07] bg-[#0a0a0a]"
                                          data-testid={`take-group-${group.id}`}
                                          key={group.id}
                                          style={{ contentVisibility: 'auto' }}
                                        >
                                          <div className="flex flex-col gap-2 border-b border-dashed border-white/[0.09] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                                            <div className="min-w-0">
                                              <div className="flex flex-wrap items-center gap-2">
                                                <span className="font-mono text-[8px] text-[#625e57]">{String(groupIndex + 1).padStart(2, '0')}</span>
                                                <span className="text-[9px] font-semibold uppercase tracking-[0.13em] text-[#b58b35]">{group.role === 'other' ? 'Outro' : SCRIPT_ROLE_LABELS[group.role]}</span>
                                                <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[8px] text-[#716c64]">{group.assignmentKind === 'script-block' ? 'bloco do roteiro' : 'intenção inferida'}</span>
                                              </div>
                                              <h5 className="mt-1 truncate text-xs font-semibold text-[#d8d1c7]">{group.label}</h5>
                                            </div>
                                            <div className="flex items-center gap-2 font-mono text-[8px] text-[#6d6860]">
                                              <span>{groupTakes.length} take{groupTakes.length === 1 ? '' : 's'}</span>
                                              {group.protectedTakeId ? <span className="rounded-full border border-[#d9aa38]/25 bg-[#d9aa38]/10 px-2 py-1 text-[#dfba5e]">protegido</span> : null}
                                            </div>
                                          </div>

                                          <div className="grid gap-2 p-2 sm:grid-cols-2">
                                            {groupTakes.map((take, takeIndex) => (
                                              <div
                                                className={`relative min-w-0 overflow-hidden rounded-lg border p-3 ${take.protected ? 'border-[#d8aa38]/40 bg-[#d8aa38]/[0.045]' : take.status === 'primary' ? 'border-[#57aa77]/20 bg-[#57aa77]/[0.025]' : 'border-white/[0.065] bg-[#0d0d0d]'}`}
                                                data-testid={`take-card-${take.id}`}
                                                key={take.id}
                                              >
                                                <div aria-hidden="true" className="absolute inset-x-0 top-0 flex h-1 justify-around overflow-hidden opacity-50">
                                                  {Array.from({ length: 14 }, (_, index) => <span className="h-1 w-1 rounded-full bg-[#756c59]" key={index} />)}
                                                </div>
                                                <div className="flex items-start justify-between gap-2 pt-1">
                                                  <div className="min-w-0">
                                                    <p className="font-mono text-[8px] text-[#716b62]">TAKE {String(takeIndex + 1).padStart(2, '0')} · {take.retakeBoundaryId.slice(-8)}</p>
                                                    <p className="mt-1 font-mono text-[8px] text-[#59554f]">{timecode(take.sourceRangeMs[0])} → {timecode(take.sourceRangeMs[1])}</p>
                                                  </div>
                                                  <span className={`shrink-0 rounded-full border px-2 py-1 text-[8px] ${TAKE_STATUS_STYLES[take.status]}`}>{TAKE_STATUS_LABELS[take.status]}</span>
                                                </div>

                                                <p className="mt-3 line-clamp-3 min-h-12 text-[10px] leading-4 text-[#c6bfb5]">{take.spokenText}</p>

                                                <div className="mt-3 space-y-1.5 border-t border-white/[0.055] pt-3">
                                                  {take.evaluations.map((evaluation) => (
                                                    <div className="grid grid-cols-[74px_1fr_34px] items-center gap-2" key={evaluation.dimension}>
                                                      <span className="truncate text-[8px] text-[#736e66]">{TAKE_DIMENSION_LABELS[evaluation.dimension]}</span>
                                                      <span className="h-1 overflow-hidden rounded-full bg-white/[0.06]">
                                                        <span
                                                          className={`block h-full rounded-full ${evaluation.score === null ? 'bg-[#3f3c37]' : evaluation.score >= 0.8 ? 'bg-[#63ad7d]' : evaluation.score >= 0.65 ? 'bg-[#d0a344]' : 'bg-[#c45f5f]'}`}
                                                          style={{ width: `${evaluation.score === null ? 0 : Math.round(evaluation.score * 100)}%` }}
                                                        />
                                                      </span>
                                                      <span className={`text-right font-mono text-[8px] ${evaluation.score === null ? 'text-[#665f56]' : 'text-[#aaa298]'}`}>{evaluation.score === null ? '—' : `${Math.round(evaluation.score * 100)}%`}</span>
                                                    </div>
                                                  ))}
                                                </div>

                                                <div className="mt-3 flex items-end justify-between gap-3">
                                                  <div className="min-w-0">
                                                    <p className="truncate font-mono text-[7px] text-[#56514b]" title={take.sourceHash}>fonte {take.sourceHash.slice(0, 10)}… preservada</p>
                                                    <p className="mt-1 text-[8px] text-[#686159]">{take.assignment.kind === 'script-block' ? 'roteiro' : 'inferido'} · {Math.round(take.assignment.confidence * 100)}%</p>
                                                  </div>
                                                  {take.status === 'rejected' ? (
                                                    <span className="shrink-0 text-[8px] text-[#875e5e]">não elegível</span>
                                                  ) : take.protected ? (
                                                    <button className="shrink-0 cursor-default rounded-md border border-[#d8aa38]/25 bg-[#d8aa38]/10 px-2 py-1.5 text-[8px] font-semibold text-[#dfba5e]" disabled type="button">Protegido</button>
                                                  ) : (
                                                    <button
                                                      className="shrink-0 rounded-md border border-[#d5a638]/25 px-2 py-1.5 text-[8px] font-semibold text-[#d9b65c] transition hover:bg-[#d5a638]/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#d5a638] disabled:opacity-40"
                                                      disabled={busy}
                                                      onClick={() => void selectAndProtectTake(group, take)}
                                                      type="button"
                                                    >
                                                      {group.protectedTakeId ? 'Trocar proteção' : take.status === 'primary' ? 'Proteger' : 'Escolher e proteger'}
                                                    </button>
                                                  )}
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        </article>
                                      )
                                    })}
                                  </div>
                                </div>
                              )}
                            </section>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </aside>
            </section>
          </div>
        </section>
      </div>

      {scriptComposerOpen ? (
        <div aria-labelledby="script-composer-title" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-3 backdrop-blur-sm sm:p-5" role="dialog">
          <button aria-label="Fechar importação do roteiro" className="absolute inset-0 cursor-default" disabled={busy} onClick={() => setScriptComposerOpen(false)} type="button" />
          <form className="relative max-h-[95vh] w-full max-w-[1060px] overflow-x-hidden overflow-y-auto rounded-[24px] border border-white/[0.1] bg-[#0d0d0d] shadow-[0_30px_110px_rgba(0,0,0,.78)]" data-testid="script-alignment-composer" onSubmit={createAlignment}>
            <div className="sticky top-0 z-10 flex items-start justify-between border-b border-white/[0.07] bg-[#0d0d0d]/95 px-5 py-5 backdrop-blur-xl sm:px-7">
              <div>
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#b89034]"><span className="h-px w-6 bg-[#b89034]" /> Script slate</div>
                <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#f4f0e8]" id="script-composer-title">Importar roteiro gravado</h2>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-[#77736c]">Identifique cada bloco pelo papel. O texto original fica preservado; a normalização e o alinhamento são derivados separadamente.</p>
              </div>
              <button aria-label="Fechar" className="grid h-9 w-9 place-items-center rounded-lg border border-white/[0.07] text-lg text-[#77736c] transition hover:bg-white/[0.04] hover:text-white" disabled={busy} onClick={() => setScriptComposerOpen(false)} type="button">×</button>
            </div>

            <div className="grid min-w-0 lg:grid-cols-[minmax(0,1.15fr)_minmax(330px,.85fr)]">
              <div className="min-w-0 space-y-4 px-5 py-6 sm:px-7">
                <div className="grid gap-4 sm:grid-cols-[1fr_130px]">
                  <label>
                    <span className="text-xs font-semibold text-[#c8c2b8]">Nome do roteiro</span>
                    <input autoFocus className="mt-2 h-11 min-w-0 w-full rounded-xl border border-white/[0.09] bg-[#080808] px-4 text-sm text-[#f2eee7] outline-none placeholder:text-[#55524d] focus:border-[#d5a535]/55" maxLength={200} onChange={(event) => { setScriptTitle(event.target.value); scriptIdempotencyKey.current = null }} required value={scriptTitle} />
                  </label>
                  <label>
                    <span className="text-xs font-semibold text-[#c8c2b8]">Idioma</span>
                    <input className="mt-2 h-11 min-w-0 w-full rounded-xl border border-white/[0.09] bg-[#080808] px-3 text-sm text-[#f2eee7] outline-none focus:border-[#d5a535]/55" maxLength={35} onChange={(event) => { setScriptLocale(event.target.value); scriptIdempotencyKey.current = null }} required value={scriptLocale} />
                  </label>
                </div>
                <label className="block">
                  <span className="text-xs font-semibold text-[#c8c2b8]">Texto planejado</span>
                  <span className="ml-2 text-[10px] text-[#77736c]">um marcador por bloco</span>
                  <textarea className="mt-2 min-h-[390px] min-w-0 w-full resize-y rounded-xl border border-white/[0.09] bg-[#080808] p-4 font-mono text-[12px] leading-6 text-[#eee8de] outline-none placeholder:text-[#55524d] focus:border-[#d5a535]/55" maxLength={500000} onChange={(event) => { setScriptRawText(event.target.value); scriptIdempotencyKey.current = null }} placeholder={'HOOK 1: Uma abertura completa.\nCORPO 1: O argumento principal.\nPROVA 1: A evidência.\nCTA 1: A chamada para ação.'} required spellCheck value={scriptRawText} />
                </label>
                <p className="text-[9px] leading-4 text-[#656159]">Marcadores aceitos: HOOK/GANCHO, BODY/CORPO, PROOF/PROVA, OBJECTION/OBJEÇÃO, BRIDGE/PONTE, OFFER/OFERTA e CTA.</p>
              </div>

              <aside className="min-w-0 border-t border-white/[0.07] bg-[#0a0a0a] px-5 py-6 sm:px-7 lg:border-l lg:border-t-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a762c]">Fontes canônicas</p>
                <h3 className="mt-1 text-lg font-semibold text-[#e8e3da]">Gravações do lote</h3>
                <p className="mt-2 text-[10px] leading-4 text-[#6f6b64]">O papel é uma pista opcional. O servidor sempre usa o hash e as palavras persistidas, nunca um texto enviado pelo navegador.</p>

                <div className="mt-4 max-h-[430px] space-y-2 overflow-y-auto">
                  {batchTranscripts.map((transcript) => {
                    const checked = scriptSourceIds.has(transcript.id)
                    return (
                      <div className={`rounded-xl border p-3 transition ${checked ? 'border-[#d5a535]/35 bg-[#d5a535]/[0.055]' : 'border-white/[0.07] bg-[#090909]'}`} key={transcript.id}>
                        <label className="flex cursor-pointer items-start gap-3">
                          <input checked={checked} className="mt-0.5 h-4 w-4 accent-[#dcae3a]" onChange={() => toggleScriptSource(transcript.id)} type="checkbox" />
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-medium text-[#d8d1c7]">{transcript.text.slice(0, 100) || transcript.id}</span>
                            <span className="mt-1 block font-mono text-[8px] text-[#625e57]">{transcript.language} · {transcript.wordCount} palavras</span>
                          </span>
                        </label>
                        {checked ? (
                          <label className="mt-3 block border-t border-white/[0.055] pt-2">
                            <span className="text-[8px] uppercase tracking-[0.12em] text-[#625e57]">Pista de papel</span>
                            <select className="mt-1 h-8 w-full rounded-lg border border-white/[0.07] bg-[#080808] px-2 text-[10px] text-[#9d978e] outline-none" onChange={(event) => { setScriptRoleHints((current) => ({ ...current, [transcript.id]: event.target.value as ScriptRole | '' })); scriptIdempotencyKey.current = null }} value={scriptRoleHints[transcript.id] ?? ''}>
                              <option value="">Detectar automaticamente</option>
                              {(Object.keys(SCRIPT_ROLE_LABELS) as ScriptRole[]).map((role) => <option key={role} value={role}>{SCRIPT_ROLE_LABELS[role]}</option>)}
                            </select>
                          </label>
                        ) : null}
                      </div>
                    )
                  })}
                </div>

                <div className="mt-5 rounded-xl border border-white/[0.07] bg-[#0d0d0d] p-4">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#77736c]">Transcrições escolhidas</span>
                    <span className="font-mono text-[#d7b65d]">{scriptSourceIds.size}</span>
                  </div>
                  <div className="mt-2 flex justify-between text-[10px]">
                    <span className="text-[#77736c]">Decisão automática</span>
                    <span className="font-mono text-[#a49e94]">≥ 80%</span>
                  </div>
                  <div className="mt-2 flex justify-between text-[10px]">
                    <span className="text-[#77736c]">Revisão humana</span>
                    <span className="font-mono text-[#a49e94]">ambíguo · desvio · &lt; 80%</span>
                  </div>
                </div>

                <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button className="h-11 rounded-xl border border-white/[0.08] px-4 text-xs font-medium text-[#8e8980] transition hover:text-white disabled:opacity-40" disabled={busy} onClick={() => setScriptComposerOpen(false)} type="button">Cancelar</button>
                  <button className="h-11 rounded-xl bg-[#dfae38] px-5 text-xs font-bold text-[#171207] transition hover:bg-[#efc34f] disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || scriptSourceIds.size === 0} type="submit">{busy ? 'Alinhando pela API…' : 'Alinhar roteiro'}</button>
                </div>
              </aside>
            </div>
          </form>
        </div>
      ) : null}

      {composerOpen ? (
        <div aria-labelledby="batch-composer-title" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-3 backdrop-blur-sm sm:p-5" role="dialog">
          <button aria-label="Fechar planejamento do lote" className="absolute inset-0 cursor-default" disabled={busy} onClick={() => setComposerOpen(false)} type="button" />
          <form className="relative max-h-[96vh] w-full max-w-[1180px] overflow-y-auto rounded-[24px] border border-white/[0.1] bg-[#0d0d0d] shadow-[0_30px_110px_rgba(0,0,0,.78)]" onSubmit={createBatch}>
            <div className="sticky top-0 z-10 flex items-start justify-between border-b border-white/[0.07] bg-[#0d0d0d]/95 px-5 py-5 backdrop-blur-xl sm:px-7">
              <div>
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#b89034]"><span className="h-px w-6 bg-[#b89034]" /> Matriz de produção</div>
                <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#f4f0e8]" id="batch-composer-title">Planejar novo lote</h2>
                <p className="mt-1 text-xs leading-5 text-[#77736c]">O produto teórico é apenas uma referência. Só as células marcadas serão criadas.</p>
              </div>
              <button aria-label="Fechar" className="grid h-9 w-9 place-items-center rounded-lg border border-white/[0.07] text-lg text-[#77736c] transition hover:bg-white/[0.04] hover:text-white" disabled={busy} onClick={() => setComposerOpen(false)} type="button">×</button>
            </div>

            <div className="grid lg:grid-cols-[minmax(0,1.06fr)_minmax(370px,.94fr)]">
              <div className="space-y-7 px-5 py-6 sm:px-7">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-semibold text-[#c8c2b8]">Projeto</span>
                    <select className="mt-2 h-12 w-full rounded-xl border border-white/[0.09] bg-[#080808] px-3 text-sm text-[#f2eee7] outline-none focus:border-[#d5a535]/55" onChange={(event) => { setProjectId(event.target.value); idempotencyKey.current = null }} required value={projectId}>
                      <option value="">Selecione</option>
                      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-[#c8c2b8]">Nome do lote</span>
                    <input autoFocus className="mt-2 h-12 w-full rounded-xl border border-white/[0.09] bg-[#080808] px-4 text-sm text-[#f2eee7] outline-none placeholder:text-[#55524d] focus:border-[#d5a535]/55" maxLength={200} onChange={(event) => { setName(event.target.value); idempotencyKey.current = null }} placeholder="Ex.: Hooks validados · agosto" required value={name} />
                  </label>
                </div>

                <fieldset>
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <legend className="text-xs font-semibold text-[#c8c2b8]">Materiais autorizados</legend>
                      <p className="mt-1 text-[10px] leading-4 text-[#6f6b64]">Somente artifacts disponíveis e com direitos aprovados podem entrar no lote.</p>
                    </div>
                    <span className="font-mono text-[10px] text-[#9d9486]">{sourceIds.size} selecionado{sourceIds.size === 1 ? '' : 's'}</span>
                  </div>
                  <div className="mt-3 grid max-h-52 gap-2 overflow-y-auto sm:grid-cols-2">
                    {eligibleMedia.length === 0 ? (
                      <div className="col-span-full rounded-xl border border-dashed border-[#bc6666]/25 bg-[#bc6666]/[0.04] p-4 text-xs leading-5 text-[#bb8585]">
                        Este projeto ainda não possui material disponível com direitos aprovados. Aprove os direitos no workspace antes de criar o lote.
                      </div>
                    ) : eligibleMedia.map((media) => {
                      const checked = sourceIds.has(media.artifactId)
                      return (
                        <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition ${checked ? 'border-[#d5a535]/40 bg-[#d5a535]/[0.07]' : 'border-white/[0.07] bg-[#090909] hover:border-white/[0.14]'}`} key={media.id}>
                          <input checked={checked} className="mt-0.5 h-4 w-4 accent-[#dcae3a]" onChange={() => toggleSource(media.artifactId)} type="checkbox" />
                          <span className="min-w-0">
                            <span className="block truncate text-xs font-medium text-[#d5cfc5]">{media.originalFileName}</span>
                            <span className="mt-1 block text-[9px] uppercase tracking-[0.1em] text-[#6c6861]">{media.role} · {media.mediaType}{media.probe ? ` · ${Math.round(media.probe.duration)}s` : ''}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                  {blockedMedia.length > 0 ? <p className="mt-2 text-[9px] text-[#766f65]">{blockedMedia.length} material{blockedMedia.length === 1 ? '' : 'is'} oculto{blockedMedia.length === 1 ? '' : 's'} por estado ou direitos.</p> : null}
                </fieldset>

                <label className="block">
                  <span className="text-xs font-semibold text-[#c8c2b8]">Receitas editoriais</span>
                  <span className="ml-2 text-[10px] text-[#77736c]">uma por linha</span>
                  <textarea className="mt-2 min-h-28 w-full resize-y rounded-xl border border-white/[0.09] bg-[#080808] p-4 text-sm leading-6 text-[#f2eee7] outline-none placeholder:text-[#55524d] focus:border-[#d5a535]/55" maxLength={3000} onChange={(event) => { setRecipeText(event.target.value); idempotencyKey.current = null }} placeholder={'Hook direto + corpo + CTA\nHook de prova + corpo + CTA'} value={recipeText} />
                  <p className="mt-1.5 text-[9px] text-[#68645d]">{recipes.length} receita{recipes.length === 1 ? '' : 's'} válida{recipes.length === 1 ? '' : 's'}</p>
                </label>

                <fieldset>
                  <legend className="text-xs font-semibold text-[#c8c2b8]">Formatos candidatos</legend>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3">
                    {FORMATS.map((format) => {
                      const checked = formats.has(format.id)
                      return (
                        <button aria-pressed={checked} className={`rounded-xl border px-3 py-3 text-left transition ${checked ? 'border-[#d5a535]/45 bg-[#d5a535]/[0.07]' : 'border-white/[0.07] bg-[#090909] hover:border-white/[0.14]'}`} key={format.id} onClick={() => toggleFormat(format.id)} type="button">
                          <span className={`block font-mono text-xs font-semibold ${checked ? 'text-[#e7be59]' : 'text-[#aaa49a]'}`}>{format.id}</span>
                          <span className="mt-1 block text-[10px] text-[#69665f]">{format.name} · {format.use}</span>
                        </button>
                      )
                    })}
                  </div>
                </fieldset>

                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-semibold text-[#c8c2b8]">Idioma</span>
                    <input className="mt-2 h-11 w-full rounded-xl border border-white/[0.09] bg-[#080808] px-4 text-sm text-[#f2eee7] outline-none focus:border-[#d5a535]/55" maxLength={35} onChange={(event) => setLocale(event.target.value)} pattern="[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}" required value={locale} />
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-[#c8c2b8]">Teto de custo</span>
                    <div className="mt-2 flex h-11 items-center rounded-xl border border-white/[0.09] bg-[#080808] px-4 focus-within:border-[#d5a535]/55">
                      <span className="mr-2 text-[10px] text-[#6f6b64]">USD</span>
                      <input className="min-w-0 flex-1 bg-transparent text-sm text-[#f2eee7] outline-none" min="0" onChange={(event) => setBudget(event.target.value)} required step="0.01" type="number" value={budget} />
                    </div>
                  </label>
                </div>
              </div>

              <aside className="border-t border-white/[0.07] bg-[#0a0a0a] px-5 py-6 sm:px-7 lg:border-l lg:border-t-0">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9a762c]">Seleção explícita</p>
                    <h3 className="mt-1 text-lg font-semibold text-[#e8e3da]">Matriz de saídas</h3>
                  </div>
                  <span className="rounded-lg border border-[#d5a638]/20 bg-[#d5a638]/[0.06] px-2.5 py-1.5 font-mono text-[10px] text-[#d6b55d]">{selectedCells.length} escolhida{selectedCells.length === 1 ? '' : 's'}</span>
                </div>
                <p className="mt-2 text-[10px] leading-4 text-[#6f6b64]">Marcar formatos acima não cria saídas automaticamente. Confirme cada interseção abaixo.</p>

                <div className="mt-4 overflow-x-auto rounded-xl border border-white/[0.07]">
                  <table className="w-full min-w-[360px] border-collapse text-left">
                    <thead>
                      <tr className="border-b border-white/[0.07] bg-white/[0.02]">
                        <th className="px-3 py-2.5 text-[9px] font-medium uppercase tracking-[0.12em] text-[#69655e]">Receita</th>
                        {FORMATS.filter((format) => formats.has(format.id)).map((format) => <th className="px-2 py-2.5 text-center font-mono text-[9px] font-medium text-[#807a71]" key={format.id}>{format.id}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {recipes.length === 0 ? (
                        <tr><td className="px-3 py-6 text-center text-[10px] text-[#68645d]" colSpan={formats.size + 1}>Informe pelo menos uma receita.</td></tr>
                      ) : recipes.map((recipe, recipeIndex) => (
                        <tr className="border-b border-white/[0.05] last:border-0" key={`${recipeIndex}-${recipe}`}>
                          <td className="max-w-[190px] truncate px-3 py-3 text-[10px] text-[#aaa49a]" title={recipe}>{recipe}</td>
                          {FORMATS.filter((format) => formats.has(format.id)).map((format) => {
                            const cell = `${recipeIndex}::${format.id}`
                            return (
                              <td className="px-2 py-3 text-center" key={format.id}>
                                <input aria-label={`${recipe} em ${format.id}`} checked={matrix.has(cell)} className="h-4 w-4 accent-[#dcae3a]" onChange={() => toggleCell(cell)} type="checkbox" />
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-5 rounded-xl border border-white/[0.07] bg-[#0d0d0d] p-4">
                  <div className="flex justify-between text-[10px]">
                    <span className="text-[#77736c]">Produto teórico</span>
                    <span className="font-mono text-[#a49e94]">{recipes.length} × {formats.size} = {recipes.length * formats.size}</span>
                  </div>
                  <div className="mt-2 flex justify-between text-[10px]">
                    <span className="text-[#77736c]">Saídas que serão criadas</span>
                    <span className="font-mono font-semibold text-[#e1ba58]">{selectedCells.length}</span>
                  </div>
                  <div className="mt-2 flex justify-between text-[10px]">
                    <span className="text-[#77736c]">Etapas monitoradas</span>
                    <span className="font-mono text-[#a49e94]">{selectedCells.length * 4}</span>
                  </div>
                  <div className="mt-3 border-t border-white/[0.06] pt-3">
                    <StepRail steps={[
                      { step: 'planning', sequence: 0, state: 'queued', attempt: 0, costMinorUnits: 0, cacheHit: false },
                      { step: 'materializing', sequence: 1, state: 'queued', attempt: 0, costMinorUnits: 0, cacheHit: false },
                      { step: 'rendering', sequence: 2, state: 'queued', attempt: 0, costMinorUnits: 0, cacheHit: false },
                      { step: 'reviewing', sequence: 3, state: 'queued', attempt: 0, costMinorUnits: 0, cacheHit: false },
                    ]} />
                  </div>
                </div>

                <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button className="h-11 rounded-xl border border-white/[0.08] px-4 text-xs font-medium text-[#8e8980] transition hover:text-white disabled:opacity-40" disabled={busy} onClick={() => setComposerOpen(false)} type="button">Cancelar</button>
                  <button className="h-11 rounded-xl bg-[#dfae38] px-5 text-xs font-bold text-[#171207] transition hover:bg-[#efc34f] disabled:cursor-not-allowed disabled:opacity-45" disabled={busy || selectedCells.length === 0 || sourceIds.size === 0} type="submit">
                    {busy ? 'Registrando pela API…' : `Criar ${selectedCells.length} saída${selectedCells.length === 1 ? '' : 's'}`}
                  </button>
                </div>
              </aside>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  )
}
