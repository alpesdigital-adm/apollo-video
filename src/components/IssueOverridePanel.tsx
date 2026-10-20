'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import type { EditorReads } from '@/app/_operator/editor-reads'
import { IssueChipList, IssueEvidence } from './IssueChips'
import {
  CHIP_LABELS,
  DELTA_LABELS,
  SUBTITLE_ANCHOR_LABELS,
  SUBTITLE_PRESET_LABELS,
  SUBTITLE_TEXT_MAX,
  classifyCommandFailure,
  compareIssues,
  createIdempotencyKeys,
  issueChips,
  issueProvenance,
  mergeSubtitleDimensions,
  panCrop,
  reframeResetBody,
  reframeSetBody,
  subtitleResetBody,
  subtitleSetBody,
  timecode,
  validateFrameRange,
  validateSubtitleDimensions,
  type CommandFailure,
  type CropBounds,
  type IssueChip,
  type ReviewInput,
  type SubtitleDimension,
} from '@/v2/ui/issue-override-view'

/* -------------------------------------------------------------------------- */
/* Wire shapes (what the published /v1 routes answer)                          */
/* -------------------------------------------------------------------------- */

interface Envelope<T> { data?: T; error?: { code?: string; message?: string; requestId?: string; details?: { reason?: string } } }

interface SegmentRow {
  segmentId: string
  startFrame: number
  endFrame: number
  text: string
  state: 'inherited' | 'overridden' | 'stale'
  override: null | {
    overrideId: string; overrideHash: string; action: 'set' | 'reset'; dimensions: SubtitleDimension[]
    protected: boolean; previousOverrideId: string | null; createdAt: string
  }
  effective: { text: string; visible: boolean; pinnedAnchor: string | null; presetId: string | null }
}
interface SegmentsView {
  version: { id: string; sequence: number; baseHash: string }
  variantId: string
  fps: number
  durationFrames: number
  presets: { presetId: string; presetVersion: 1; presetHash: string }[]
  segments: SegmentRow[]
}

interface ReframeRange { clipId: string; startFrame: number; endFrame: number; source: 'plan' | 'manual' | 'fallback'; keyframes: { frame: number; crop: CropBounds }[] }
interface ReframePlanView {
  variantId: string
  projectVersionId: string
  plan: null | {
    recordHash: string
    disposition: string
    serverPlanHash: string
    finalPlanHash: string
    renderPlan: { ranges: ReframeRange[] }
    overrides: { applied: { id: string; clipId: string; startFrame: number; endFrame: number; crop: CropBounds }[]; inactive: { id: string; clipId: string; startFrame: number; endFrame: number; reasonCode: string }[] }
    issues: { code: string; severity: 'hard' | 'warning'; clipId: string | null; startFrame: number; endFrame: number; evidenceIds: string[]; observationIds: string[]; reasonCode: string | null }[]
  }
}

interface ImpactView {
  affectedArtifacts: { artifactId: string; kind: 'proxy' | 'final'; variantId: string; sourceVersionId: string }[]
  minimalRenders: { kind: 'proxy'; variantId: string; ranges: { startFrame: number; endFrame: number }[] }[]
  affectedVariantIds: string[]
  renderSemanticsChanged: boolean
}

interface OperationView { id: string; type: string; status: string; phase?: string; updatedAt?: string; error?: { message?: string }; visibleState?: { terminal: boolean } }

interface AppliedCommand {
  kind: 'subtitle' | 'reframe'
  action: 'set' | 'reset'
  variantId: string
  baseVersionId: string
  versionId: string
  versionSequence: number
  commandId: string
  replayed: boolean
  impact: ImpactView
  summary: string
  before: {
    chips: readonly IssueChip[]
    reviewId: string
    reviewHash: string
    proxyArtifactId: string
    proxySha256: string | null
    versionId: string
  }
  recompile: { phase: 'pending' | 'queued' | 'failed'; operationId: string | null; failure: string | null }
}

export interface IssueOverridePanelProps {
  projectId: string
  reads: EditorReads
  version: { id: string; baseHash: string; sequence: number } | null
  variantId: string | null
  aspectRatio: string | null
  fps: number
  review: ReviewInput | null
  reviewLoading: boolean
  reviewFailure: string | null
  proxyArtifact: { artifactId: string; sha256: string | null } | null
  operations: readonly OperationView[]
  /** Moves the preview to a frame of the selected output. */
  onSeekFrame: (frame: number) => void
  /** Rereads the workspace and the reviews after a Command or an enqueue. */
  onChanged: () => Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

type CallResult<T> = { ok: true; data: T; status: number } | { ok: false; failure: CommandFailure }

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<CallResult<T>> {
  try {
    const response = await fetch(url, { ...init, cache: 'no-store', headers: { accept: 'application/json', ...(init.headers ?? {}) } })
    const payload = await response.json().catch(() => null) as Envelope<T> | null
    if (!response.ok || !payload?.data) return { ok: false, failure: classifyCommandFailure(response.status, payload) }
    return { ok: true, data: payload.data, status: response.status }
  } catch {
    return { ok: false, failure: classifyCommandFailure(0, null) }
  }
}

const idempotencyKeys = createIdempotencyKeys(() => globalThis.crypto.randomUUID())

/* -------------------------------------------------------------------------- */
/* Draft (survives a re-authentication)                                       */
/* -------------------------------------------------------------------------- */

interface CaptionForm { anchor: string; text: string; visible: boolean; presetId: string; protectedException: boolean; reason: string }
interface StoredDraft { segmentId: string; form: CaptionForm }

function draftKey(projectId: string, variantId: string): string { return `apollo:v2:issue-draft:${projectId}:${variantId}` }
function readDraft(projectId: string, variantId: string): StoredDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(projectId, variantId))
    return raw ? JSON.parse(raw) as StoredDraft : null
  } catch { return null }
}
function writeDraft(projectId: string, variantId: string, draft: StoredDraft | null): void {
  try {
    if (draft) window.localStorage.setItem(draftKey(projectId, variantId), JSON.stringify(draft))
    else window.localStorage.removeItem(draftKey(projectId, variantId))
  } catch { /* the draft is a convenience: a browser without storage still edits */ }
}

/* -------------------------------------------------------------------------- */
/* Small pieces                                                               */
/* -------------------------------------------------------------------------- */

const OPERATION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  queued: 'Na fila', running: 'Renderizando', waiting: 'Aguardando', retrying: 'Nova tentativa', succeeded: 'Concluído', failed: 'Falhou', canceled: 'Cancelado', cancelled: 'Cancelado',
})

const TERMINAL = new Set(['succeeded', 'failed', 'canceled', 'cancelled'])

const inputClass = 'mt-1 w-full rounded border border-white/[0.1] bg-[#050505] px-2 py-1.5 text-[11px] text-[#d8d2c8] outline-hidden focus:border-[#d9aa3d]/55'
const labelClass = 'block text-[8px] uppercase tracking-[0.14em] text-[#777168]'

function FailureNotice({ failure, onRefresh }: { failure: CommandFailure; onRefresh: () => void }) {
  return (
    <div className="mt-3 border-l-2 border-[#d46f63] bg-[#d46f63]/[0.06] px-3 py-2 text-[10px] leading-4 text-[#d99288]" data-failure-kind={failure.kind} data-testid="issue-command-failure" role="alert">
      <p>{failure.message}</p>
      <p className="mt-1 font-mono text-[8px] text-[#9a6c66]">{failure.code ?? `HTTP ${failure.status}`}{failure.requestId ? ` · request ${failure.requestId}` : ''}</p>
      {failure.kind === 'stale-base' ? (
        <button className="mt-2 rounded border border-[#d9aa3d]/30 px-2 py-1 text-[9px] text-[#ddb858]" data-testid="issue-conflict-refetch" onClick={onRefresh} type="button">Reler o projeto e tentar de novo</button>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                      */
/* -------------------------------------------------------------------------- */

export default function IssueOverridePanel(props: IssueOverridePanelProps) {
  const { projectId, reads, version, variantId, review, onSeekFrame, onChanged } = props
  const router = useRouter()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [segments, setSegments] = useState<SegmentsView | null>(null)
  const [segmentsFailure, setSegmentsFailure] = useState<string | null>(null)
  const [plan, setPlan] = useState<ReframePlanView | null>(null)
  const [planFailure, setPlanFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<CommandFailure | null>(null)
  const [applied, setApplied] = useState<AppliedCommand | null>(null)
  const [cancelArmed, setCancelArmed] = useState(false)
  const [cancelledOperationId, setCancelledOperationId] = useState<string | null>(null)
  const [segmentId, setSegmentId] = useState<string | null>(null)
  const [form, setForm] = useState<CaptionForm | null>(null)
  const formOwner = useRef<string | null>(null)

  const chips = useMemo(() => (review && variantId ? issueChips(review, variantId) : []), [review, variantId])
  const selected = useMemo(() => chips.find((chip) => chip.key === selectedKey) ?? null, [chips, selectedKey])
  const blockCount = chips.filter((chip) => chip.severity === 'block').length
  const reviewCount = chips.length - blockCount

  // A selection that is no longer reported (a new review) is dropped; nothing keeps an issue alive or dead by itself.
  useEffect(() => {
    if (selectedKey && !chips.some((chip) => chip.key === selectedKey)) setSelectedKey(null)
  }, [chips, selectedKey])

  const sessionExpired = useCallback(() => {
    // The draft is already in storage; leave for the sign-in and come back to this very page.
    router.replace(`/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`)
  }, [router])

  const refresh = useCallback(async () => {
    reads.invalidate('subtitle-segments', 'reframe-plan')
    await onChanged()
  }, [onChanged, reads])

  /* ---- segments of the selected output (caption issues) ---- */
  const loadSegments = useCallback(async () => {
    if (!variantId || !version) return
    const result = await reads.read<SegmentsView>({
      name: 'subtitle-segments',
      url: `/v1/projects/${encodeURIComponent(projectId)}/subtitle-segments?variantId=${encodeURIComponent(variantId)}`,
      versionId: version.id,
      query: `variantId=${variantId}`,
    })
    if (!result.ok) {
      if (result.failure.dropped) return
      if (result.failure.kind === 'auth') { sessionExpired(); return }
      setSegments(null)
      setSegmentsFailure(result.failure.kind === 'not-found' ? 'Este projeto não existe neste workspace.' : result.failure.message)
      return
    }
    setSegmentsFailure(null)
    setSegments(result.data)
  }, [projectId, reads, sessionExpired, variantId, version])

  /* ---- reframe plan of the selected output (reframe issues) ---- */
  const loadPlan = useCallback(async () => {
    if (!variantId || !version) return
    const result = await reads.read<ReframePlanView>({
      name: 'reframe-plan',
      url: `/v1/projects/${encodeURIComponent(projectId)}/reframe-plans?variantId=${encodeURIComponent(variantId)}&projectVersionId=${encodeURIComponent(version.id)}`,
      versionId: version.id,
      query: `variantId=${variantId}&projectVersionId=${version.id}`,
    })
    if (!result.ok) {
      if (result.failure.dropped) return
      if (result.failure.kind === 'auth') { sessionExpired(); return }
      setPlan(null)
      setPlanFailure(result.failure.message)
      return
    }
    setPlanFailure(null)
    setPlan(result.data)
  }, [projectId, reads, sessionExpired, variantId, version])

  const selectedDomain = selected?.domain ?? null
  useEffect(() => {
    if (selectedDomain === 'caption') void loadSegments()
    if (selectedDomain === 'reframe') void loadPlan()
  }, [selectedDomain, loadSegments, loadPlan, version?.id, variantId])

  /* ---- which segment and which form ---- */
  const candidateSegments = useMemo(() => {
    if (!selected || selected.domain !== 'caption' || !segments) return []
    if (selected.cueId) return segments.segments.filter((segment) => segment.segmentId === selected.cueId)
    if (!selected.range) return []
    const range = selected.range
    return segments.segments.filter((segment) => segment.startFrame < range.endFrame && segment.endFrame > range.startFrame)
  }, [segments, selected])

  useEffect(() => {
    if (!selected || selected.domain !== 'caption') { setSegmentId(null); return }
    setSegmentId((current) => candidateSegments.some((segment) => segment.segmentId === current) ? current : candidateSegments[0]?.segmentId ?? null)
  }, [candidateSegments, selected])

  const segment = candidateSegments.find((candidate) => candidate.segmentId === segmentId) ?? null
  useEffect(() => {
    if (!segment || !variantId) { setForm(null); formOwner.current = null; return }
    const owner = `${variantId}:${segment.segmentId}:${segment.override?.overrideId ?? 'none'}:${segments?.version.id ?? ''}`
    if (formOwner.current === owner) return
    formOwner.current = owner
    const stored = readDraft(projectId, variantId)
    if (stored && stored.segmentId === segment.segmentId) { setForm(stored.form); return }
    setForm({
      anchor: segment.effective.pinnedAnchor ?? '',
      text: segment.effective.text,
      visible: segment.effective.visible,
      presetId: segment.effective.presetId ?? '',
      protectedException: segment.override?.protected ?? false,
      reason: '',
    })
  }, [projectId, segment, segments?.version.id, variantId])

  const updateForm = (patch: Partial<CaptionForm>) => {
    setForm((current) => {
      if (!current || !segment || !variantId) return current
      const next = { ...current, ...patch }
      writeDraft(projectId, variantId, { segmentId: segment.segmentId, form: next })
      return next
    })
  }

  /* ---- recompile ---- */
  const enqueueRecompile = useCallback(async (command: AppliedCommand): Promise<void> => {
    const body = { variantId: command.variantId }
    const result = await requestJson<{ operation: OperationView; replayed: boolean }>(
      `/v1/projects/${encodeURIComponent(projectId)}/proxy-renders`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKeys(`recompile-${command.versionId}`, body) }, body: JSON.stringify(body) },
    )
    if (!result.ok) {
      if (result.failure.kind === 'session-expired') { sessionExpired(); return }
      setApplied((current) => current && current.commandId === command.commandId
        ? { ...current, recompile: { phase: 'failed', operationId: null, failure: result.failure.message } } : current)
      return
    }
    setApplied((current) => current && current.commandId === command.commandId
      ? { ...current, recompile: { phase: 'queued', operationId: result.data.operation.id, failure: null } } : current)
    await refresh()
  }, [projectId, refresh, sessionExpired])

  const finishCommand = useCallback(async (command: AppliedCommand): Promise<void> => {
    setApplied(command)
    setCancelArmed(false)
    setCancelledOperationId(null)
    if (variantId) writeDraft(projectId, variantId, null)
    formOwner.current = null
    await refresh()
    await enqueueRecompile(command)
  }, [enqueueRecompile, projectId, refresh, variantId])

  const baseOf = () => (version && variantId ? { baseVersionId: version.id, baseHash: version.baseHash, variantId } : null)

  const beforeSnapshot = () => review && props.proxyArtifact && version ? {
    chips, reviewId: review.id, reviewHash: review.reviewHash, proxyArtifactId: review.proxyArtifactId,
    proxySha256: props.proxyArtifact.artifactId === review.proxyArtifactId ? props.proxyArtifact.sha256 : null, versionId: version.id,
  } : null

  const failWith = (result: { failure: CommandFailure }) => {
    setFailure(result.failure)
    if (result.failure.kind === 'session-expired') sessionExpired()
  }

  /* ---- subtitle Commands ---- */
  async function submitSubtitle(action: 'set' | 'reset') {
    const base = baseOf()
    const before = beforeSnapshot()
    if (!base || !before || !segment || !form || !segments || busy) return
    setBusy(true); setFailure(null)
    try {
      let body: ReturnType<typeof subtitleSetBody> | ReturnType<typeof subtitleResetBody>
      if (action === 'reset') body = subtitleResetBody(base, { segmentId: segment.segmentId, reason: form.reason })
      else {
        const hashes = Object.fromEntries(segments.presets.map((preset) => [preset.presetId, preset.presetHash]))
        const current = segment.state === 'overridden' && segment.override ? segment.override.dimensions : []
        const dimensions = mergeSubtitleDimensions(current, {
          anchor: form.anchor === '' ? null : form.anchor,
          text: form.text.trim() === segment.text.trim() ? null : form.text,
          visible: form.visible,
          presetId: form.presetId === '' ? null : form.presetId,
        }, hashes)
        const invalid = validateSubtitleDimensions(dimensions)
        if (invalid) { setFailure({ kind: 'refused', status: 422, code: null, message: invalid, requestId: null }); return }
        body = subtitleSetBody(base, { segmentId: segment.segmentId, dimensions, protectedException: form.protectedException, reason: form.reason })
      }
      const result = await requestJson<{
        version: { id: string; sequence: number }; command: { id: string }; impact: ImpactView; replayed: boolean
        resolution: { inherited: boolean; dimensions: SubtitleDimension[] }
      }>(`/v1/projects/${encodeURIComponent(projectId)}/subtitle-segment-overrides`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKeys(`subtitle-${action}`, body) },
        body: JSON.stringify(body),
      })
      if (!result.ok) { failWith(result); return }
      await finishCommand({
        kind: 'subtitle', action, variantId: base.variantId, baseVersionId: base.baseVersionId,
        versionId: result.data.version.id, versionSequence: result.data.version.sequence, commandId: result.data.command.id,
        replayed: result.data.replayed, impact: result.data.impact, before,
        summary: action === 'reset'
          ? (result.data.resolution.inherited ? `Legenda ${segment.segmentId} voltou ao nível herdado.` : `Legenda ${segment.segmentId} voltou à exceção anterior.`)
          : `Exceção aplicada à legenda ${segment.segmentId}.`,
        recompile: { phase: 'pending', operationId: null, failure: null },
      })
    } finally { setBusy(false) }
  }

  /* ---- reframe Commands ---- */
  const [reframeRange, setReframeRange] = useState<{ startFrame: number; endFrame: number }>({ startFrame: 0, endFrame: 1 })
  const [reframeX, setReframeX] = useState(0)
  const [reframeReason, setReframeReason] = useState('')

  const reframeIssue = useMemo(() => {
    if (!selected || selected.domain !== 'reframe' || !plan?.plan || !selected.range) return null
    const range = selected.range
    const code = selected.code.replace(/^REFRAME_/, '')
    return plan.plan.issues.find((issue) => issue.code === code && issue.startFrame < range.endFrame && issue.endFrame > range.startFrame) ?? null
  }, [plan, selected])

  const reframeClip = useMemo(() => {
    if (!plan?.plan || !reframeIssue?.clipId) return null
    const ranges = plan.plan.renderPlan.ranges.filter((candidate) => candidate.clipId === reframeIssue.clipId)
    if (ranges.length === 0) return null
    return {
      clipId: reframeIssue.clipId,
      startFrame: Math.min(...ranges.map((range) => range.startFrame)),
      endFrame: Math.max(...ranges.map((range) => range.endFrame)),
      reference: ranges.find((range) => range.keyframes.length > 0)?.keyframes[0]?.crop ?? null,
      ranges,
    }
  }, [plan, reframeIssue])

  useEffect(() => {
    if (!reframeIssue || !reframeClip) return
    setReframeRange({ startFrame: Math.max(reframeIssue.startFrame, reframeClip.startFrame), endFrame: Math.min(reframeIssue.endFrame, reframeClip.endFrame) })
    setReframeX(reframeClip.reference?.x ?? 0)
  }, [reframeClip, reframeIssue])

  async function submitReframe(action: 'set' | 'reset', range: { startFrame: number; endFrame: number }) {
    const base = baseOf()
    const before = beforeSnapshot()
    if (!base || !before || !reframeClip || busy) return
    const invalid = validateFrameRange(range, { startFrame: reframeClip.startFrame, endFrame: reframeClip.endFrame })
    if (invalid) { setFailure({ kind: 'refused', status: 422, code: null, message: invalid, requestId: null }); return }
    if (action === 'set' && !reframeClip.reference) { setFailure({ kind: 'refused', status: 422, code: null, message: 'Esta faixa não tem um recorte de referência para mover.', requestId: null }); return }
    setBusy(true); setFailure(null)
    try {
      const body = action === 'set'
        ? reframeSetBody(base, { clipId: reframeClip.clipId, ...range, crop: panCrop(reframeClip.reference!, reframeX), reason: reframeReason })
        : reframeResetBody(base, { clipId: reframeClip.clipId, ...range, reason: reframeReason })
      const result = await requestJson<{ version: { id: string; sequence: number }; command: { id: string }; impact: ImpactView; replayed: boolean }>(
        `/v1/projects/${encodeURIComponent(projectId)}/variant-reframe-overrides`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKeys(`reframe-${action}`, body) }, body: JSON.stringify(body) },
      )
      if (!result.ok) { failWith(result); return }
      await finishCommand({
        kind: 'reframe', action, variantId: base.variantId, baseVersionId: base.baseVersionId,
        versionId: result.data.version.id, versionSequence: result.data.version.sequence, commandId: result.data.command.id,
        replayed: result.data.replayed, impact: result.data.impact, before,
        summary: action === 'reset'
          ? `Enquadramento do trecho ${range.startFrame}–${range.endFrame} voltou ao nível automático.`
          : `Enquadramento manual aplicado ao trecho ${range.startFrame}–${range.endFrame}.`,
        recompile: { phase: 'pending', operationId: null, failure: null },
      })
    } finally { setBusy(false) }
  }

  async function requestPlan() {
    const base = baseOf()
    if (!base || busy) return
    setBusy(true); setFailure(null)
    try {
      const body = { baseVersionId: base.baseVersionId, variantId: base.variantId }
      const result = await requestJson<{ recordHash: string }>(`/v1/projects/${encodeURIComponent(projectId)}/reframe-plans`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!result.ok) { failWith(result); return }
      reads.invalidate('reframe-plan')
      await loadPlan()
    } finally { setBusy(false) }
  }

  /* ---- operation of the recompile ---- */
  const operation = useMemo(() => {
    const id = applied?.recompile.operationId
    return id ? props.operations.find((candidate) => candidate.id === id) ?? null : null
  }, [applied?.recompile.operationId, props.operations])
  const operationActive = operation !== null && !(operation.visibleState?.terminal ?? TERMINAL.has(operation.status))

  async function cancelRecompile() {
    const id = applied?.recompile.operationId
    if (!id || busy) return
    if (!cancelArmed) { setCancelArmed(true); return }
    setBusy(true); setFailure(null)
    try {
      const result = await requestJson<{ operation: OperationView }>(`/v1/operations/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
      if (!result.ok) { failWith(result); return }
      setCancelledOperationId(id); setCancelArmed(false)
      await refresh()
    } finally { setBusy(false) }
  }

  async function retryRecompile() {
    if (!applied || busy) return
    setBusy(true)
    try { await enqueueRecompile(applied) } finally { setBusy(false) }
  }

  /* ---- before / after: only against a review made AFTER the command, for the new Version ---- */
  const afterChips = useMemo(() => {
    if (!applied || !review || !variantId) return null
    if (review.projectVersionId !== applied.versionId) return null
    if (review.reviewHash === applied.before.reviewHash) return null
    return issueChips(review, variantId)
  }, [applied, review, variantId])
  const comparison = useMemo(() => applied ? compareIssues(applied.before.chips, afterChips) : [], [afterChips, applied])
  const proxyAfter = review && applied && review.projectVersionId === applied.versionId ? { artifactId: review.proxyArtifactId, sha256: props.proxyArtifact?.artifactId === review.proxyArtifactId ? props.proxyArtifact.sha256 : null } : null

  const selectedProvenance = selected && review && props.proxyArtifact ? issueProvenance(selected, review, props.proxyArtifact) : []

  /* ---------------------------------------------------------------------- */
  return (
    <section aria-label="Problemas do render" className="mt-5 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#090909]" data-testid="issue-override-panel" data-variant-id={variantId ?? ''}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.07] px-4 py-3">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#b58d31]">Problemas do render</p>
          <p className="mt-1 text-[10px] text-[#706c64]">
            Saída <span className="font-mono text-[#aaa49a]">{props.aspectRatio ?? variantId ?? '—'}</span>
            {version ? <> · versão V{version.sequence}</> : null}
            {' · '}<span data-testid="issue-count-block">{blockCount}</span> bloqueio(s) · <span data-testid="issue-count-review">{reviewCount}</span> ressalva(s)
          </p>
        </div>
        <p className="max-w-sm text-[9px] leading-4 text-[#625f58]">Nenhum botão aqui aceita um problema. Ele só some quando um novo render, com pixels novos, deixa de reportá-lo.</p>
      </div>

      {props.reviewFailure ? <p className="px-4 py-3 text-[10px] text-[#c97870]" data-testid="issue-review-unavailable">{props.reviewFailure}</p> : null}
      {!review && !props.reviewFailure ? <p className="px-4 py-3 text-[10px] text-[#716d65]" data-testid="issue-no-review">{props.reviewLoading ? 'Lendo o laudo desta saída…' : 'Esta saída ainda não tem laudo para esta versão. Renderize o proxy para que o critic aponte problemas.'}</p> : null}
      {review && chips.length === 0 ? <p className="px-4 py-3 text-[10px] text-[#78aa87]" data-testid="issue-none">O critic não reportou problemas neste render ({review.reviewHash.slice(0, 12)}).</p> : null}

      {chips.length ? (
        <IssueChipList chips={chips} fps={props.fps} onSelect={(chip) => { setSelectedKey(chip.key); setFailure(null); if (chip.range) onSeekFrame(chip.range.startFrame) }} selectedKey={selectedKey} />
      ) : null}

      {selected && review ? (
        <div className="border-t border-white/[0.06] px-4 py-4" data-issue-key={selected.key} data-testid="issue-detail">
          <p className="text-xs leading-5 text-[#d8d2c8]">{selected.message}</p>
          <IssueEvidence chip={selected} rows={selectedProvenance} />
          <p className="mt-3 text-[9px] leading-4 text-[#8e8980]" data-testid="issue-acknowledge-note">
            {selected.acknowledgeable
              ? 'Esta é uma ressalva: pode ser reconhecida no laudo do proxy, com o seu nome e o horário. Corrigi-la é outra ação.'
              : 'Este é um bloqueio: não pode ser reconhecido. Só um novo render que deixe de reportá-lo libera a saída.'}
          </p>

          {failure ? <FailureNotice failure={failure} onRefresh={() => { setFailure(null); void refresh().then(() => selected.domain === 'caption' ? loadSegments() : loadPlan()) }} /> : null}

          {selected.domain === 'caption' ? (
            <div className="mt-4 border-t border-white/[0.06] pt-4" data-testid="caption-editor">
              <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#b58d31]">Exceção da legenda nesta saída</p>
              {segmentsFailure ? <p className="mt-2 text-[10px] text-[#c97870]" data-testid="caption-segments-failure">{segmentsFailure}</p> : null}
              {!segments && !segmentsFailure ? <p className="mt-2 text-[10px] text-[#716d65]">Lendo as legendas desta saída…</p> : null}
              {segments && candidateSegments.length === 0 ? <p className="mt-2 text-[10px] text-[#716d65]" data-testid="caption-no-segment">Nenhuma legenda desta saída ocupa esta faixa.</p> : null}
              {candidateSegments.length > 1 ? (
                <label className={`${labelClass} mt-2`}>Legenda
                  <select className={inputClass} data-testid="caption-segment-select" onChange={(event) => setSegmentId(event.target.value)} value={segmentId ?? ''}>
                    {candidateSegments.map((candidate) => <option key={candidate.segmentId} value={candidate.segmentId}>{candidate.segmentId} · {candidate.startFrame}–{candidate.endFrame}</option>)}
                  </select>
                </label>
              ) : null}
              {segment && form && segments ? (
                <div className="mt-2" data-segment-id={segment.segmentId} data-segment-state={segment.state} data-testid="caption-form">
                  <p className="font-mono text-[8px] text-[#625f58]">
                    {segment.segmentId} · quadros {segment.startFrame}–{segment.endFrame} · {segment.state === 'overridden' ? 'com exceção' : segment.state === 'stale' ? 'exceção fora da faixa atual (não desenhada)' : 'herdada'}
                    {segment.override ? ` · exceção ${segment.override.overrideHash.slice(0, 12)}` : ''}
                  </p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-2">
                    <label className={labelClass}>Posição
                      <select className={inputClass} data-testid="caption-anchor" onChange={(event) => updateForm({ anchor: event.target.value })} value={form.anchor}>
                        <option value="">Automática (herdada)</option>
                        {Object.entries(SUBTITLE_ANCHOR_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      </select>
                    </label>
                    <label className={labelClass}>Estilo
                      <select className={inputClass} data-testid="caption-style" onChange={(event) => updateForm({ presetId: event.target.value })} value={form.presetId}>
                        <option value="">Herdado do projeto</option>
                        {segments.presets.map((preset) => <option key={preset.presetId} value={preset.presetId}>{SUBTITLE_PRESET_LABELS[preset.presetId] ?? preset.presetId}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className={`${labelClass} mt-3`}>Texto ({form.text.length}/{SUBTITLE_TEXT_MAX})
                    <textarea className={`${inputClass} min-h-16`} data-testid="caption-text" maxLength={SUBTITLE_TEXT_MAX} onChange={(event) => updateForm({ text: event.target.value })} value={form.text} />
                  </label>
                  {form.text.length > 40 ? <p className="mt-1 text-[9px] text-[#ad8c45]">A legenda queimada mostra até duas linhas de cerca de 20 caracteres.</p> : null}
                  <div className="mt-3 flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 text-[10px] text-[#aaa49a]"><input checked={form.visible} data-testid="caption-visible" onChange={(event) => updateForm({ visible: event.target.checked })} type="checkbox" />Mostrar esta legenda</label>
                    <label className="flex items-center gap-2 text-[10px] text-[#aaa49a]"><input checked={form.protectedException} data-testid="caption-protected" onChange={(event) => updateForm({ protectedException: event.target.checked })} type="checkbox" />Proteger a exceção em uma nova direção</label>
                  </div>
                  <label className={`${labelClass} mt-3`}>Motivo (opcional)
                    <input className={inputClass} data-testid="caption-reason" maxLength={1000} onChange={(event) => updateForm({ reason: event.target.value })} value={form.reason} />
                  </label>
                  <p className="mt-2 text-[9px] leading-4 text-[#716d65]">A posição escolhida continua sujeita à evidência de rosto: se a faixa pedida estiver ocupada ou sem cobertura certificada, a legenda não é desenhada e o motivo aparece como problema.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className="rounded-lg bg-[#dbae3f] px-3 py-2 text-[10px] font-bold text-[#171207] disabled:opacity-40" data-testid="caption-apply" disabled={busy || operationActive || !version} onClick={() => void submitSubtitle('set')} type="button">{busy ? 'Aplicando…' : 'Aplicar exceção e recompilar esta saída'}</button>
                    <button className="rounded-lg border border-white/[0.12] px-3 py-2 text-[10px] text-[#aaa49a] disabled:opacity-40" data-testid="caption-reset" disabled={busy || operationActive || !version || !segment.override || segment.override.action === 'reset'} onClick={() => void submitSubtitle('reset')} type="button">Reverter exceção</button>
                  </div>
                  {segment.override && segment.override.previousOverrideId ? <p className="mt-1 text-[9px] text-[#716d65]">Reverter volta ao nível anterior desta legenda, que também é uma exceção; repita até chegar ao herdado.</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {selected.domain === 'reframe' ? (
            <div className="mt-4 border-t border-white/[0.06] pt-4" data-testid="reframe-editor">
              <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#b58d31]">Enquadramento manual nesta saída</p>
              {planFailure ? <p className="mt-2 text-[10px] text-[#c97870]">{planFailure}</p> : null}
              {plan && !plan.plan ? (
                <div className="mt-2" data-testid="reframe-plan-missing">
                  <p className="text-[10px] leading-4 text-[#8e8980]">Esta versão ainda não tem o plano de enquadramento desta saída. Ele é decidido pelo servidor, com a evidência de rosto selada; nada é gravado sem ela.</p>
                  <button className="mt-2 rounded-lg border border-[#d9aa3d]/30 px-3 py-2 text-[10px] text-[#ddb858] disabled:opacity-40" data-testid="reframe-request-plan" disabled={busy || !version} onClick={() => void requestPlan()} type="button">Planejar o enquadramento desta saída</button>
                </div>
              ) : null}
              {plan?.plan && !reframeIssue ? <p className="mt-2 text-[10px] text-[#716d65]" data-testid="reframe-no-issue">O plano persistido desta versão não tem um problema nesta faixa.</p> : null}
              {plan?.plan && reframeIssue && reframeClip ? (
                <div className="mt-2" data-clip-id={reframeClip.clipId} data-testid="reframe-form">
                  <p className="font-mono text-[8px] text-[#625f58]">clipe {reframeClip.clipId} · quadros {reframeClip.startFrame}–{reframeClip.endFrame} · plano {plan.plan.recordHash.slice(0, 12)} · {plan.plan.disposition}</p>
                  <div className="mt-2 grid grid-cols-2 gap-3">
                    <label className={labelClass}>Quadro inicial
                      <input className={inputClass} data-testid="reframe-start" min={reframeClip.startFrame} onChange={(event) => setReframeRange((current) => ({ ...current, startFrame: Number(event.target.value) }))} type="number" value={reframeRange.startFrame} />
                    </label>
                    <label className={labelClass}>Quadro final (exclusivo)
                      <input className={inputClass} data-testid="reframe-end" max={reframeClip.endFrame} onChange={(event) => setReframeRange((current) => ({ ...current, endFrame: Number(event.target.value) }))} type="number" value={reframeRange.endFrame} />
                    </label>
                  </div>
                  {reframeClip.reference ? (
                    <div className="mt-3">
                      <label className={labelClass}>Posição horizontal do recorte ({Math.round(panCrop(reframeClip.reference, reframeX).x * 100)}%)
                        <input className="mt-1 w-full" data-testid="reframe-x" max={Math.max(0, 1 - reframeClip.reference.width)} min={0} onChange={(event) => setReframeX(Number(event.target.value))} step={0.005} type="range" value={reframeX} />
                      </label>
                      <div className="relative mt-2 h-4 w-full rounded bg-white/[0.06]" data-testid="reframe-crop-preview">
                        <span className="absolute top-0 h-4 rounded border border-[#d9aa3d] bg-[#d9aa3d]/25" style={{ left: `${panCrop(reframeClip.reference, reframeX).x * 100}%`, width: `${reframeClip.reference.width * 100}%` }} />
                      </div>
                      <p className="mt-1 text-[9px] text-[#716d65]">O recorte só se move: o tamanho é o do plano, sem zoom. Esconder um sujeito de que o servidor tem certeza é recusado.</p>
                    </div>
                  ) : <p className="mt-2 text-[10px] text-[#ad8c45]">Este clipe não tem recorte rastreado para mover (o trecho aparece inteiro).</p>}
                  <label className={`${labelClass} mt-3`}>Motivo (opcional)
                    <input className={inputClass} data-testid="reframe-reason" maxLength={1000} onChange={(event) => setReframeReason(event.target.value)} value={reframeReason} />
                  </label>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button className="rounded-lg bg-[#dbae3f] px-3 py-2 text-[10px] font-bold text-[#171207] disabled:opacity-40" data-testid="reframe-apply" disabled={busy || operationActive || !reframeClip.reference} onClick={() => void submitReframe('set', reframeRange)} type="button">{busy ? 'Aplicando…' : 'Aplicar enquadramento e recompilar esta saída'}</button>
                  </div>
                  {plan.plan.overrides.applied.filter((override) => override.clipId === reframeClip.clipId).map((override) => (
                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-white/[0.05] pt-2" data-testid="reframe-applied-override" key={override.id}>
                      <span className="font-mono text-[9px] text-[#aaa49a]">manual {override.startFrame}–{override.endFrame} · x {Math.round(override.crop.x * 100)}%</span>
                      <button className="rounded border border-white/[0.12] px-2 py-1 text-[9px] text-[#aaa49a] disabled:opacity-40" data-testid="reframe-reset" disabled={busy || operationActive} onClick={() => void submitReframe('reset', { startFrame: override.startFrame, endFrame: override.endFrame })} type="button">Voltar ao automático</button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {selected.domain === 'other' ? <p className="mt-3 text-[10px] text-[#716d65]" data-testid="issue-no-action">Este problema não tem uma ação de exceção própria. Corrija a causa na edição e renderize de novo.</p> : null}
        </div>
      ) : null}

      {applied ? (
        <div className="border-t border-white/[0.06] px-4 py-4" data-command-id={applied.commandId} data-testid="issue-applied">
          <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#b58d31]">Resultado</p>
          <p className="mt-2 text-[11px] text-[#d8d2c8]" data-testid="issue-applied-summary">{applied.summary}</p>
          <p className="mt-1 font-mono text-[9px] text-[#8e8980]" data-testid="issue-applied-version">
            Nova versão V{applied.versionSequence} <span className="text-[#625f58]">{applied.versionId}</span>{applied.replayed ? ' · repetição da mesma chave: nenhuma versão nova foi criada' : ''}
          </p>
          <p className="mt-1 text-[10px] leading-4 text-[#8e8980]" data-testid="issue-applied-impact">
            Renders invalidados: {applied.impact.affectedArtifacts.length === 0 ? 'nenhum render existente desta saída' : applied.impact.affectedArtifacts.map((artifact) => `${artifact.kind === 'final' ? 'final' : 'proxy'} ${artifact.artifactId}`).join(', ')}.
            {' '}Saídas afetadas: {applied.impact.affectedVariantIds.join(', ') || applied.variantId}. As outras saídas e a versão anterior não mudam.
            {applied.impact.affectedArtifacts.some((artifact) => artifact.kind === 'final') ? ' O MP4 final desta saída ficou desatualizado e exige um novo render final.' : ''}
          </p>

          <div className="mt-3 rounded border border-white/[0.07] bg-white/[0.02] px-3 py-2" data-recompile-phase={applied.recompile.phase} data-testid="issue-recompile">
            <p className="text-[8px] uppercase tracking-[0.14em] text-[#625f58]">Recompilação do proxy desta saída</p>
            {applied.recompile.phase === 'pending' ? <p className="mt-1 text-[10px] text-[#a8873c]">Enfileirando o render…</p> : null}
            {applied.recompile.phase === 'failed' ? (
              <div className="mt-1">
                <p className="text-[10px] text-[#c97870]" data-testid="issue-recompile-failure">{applied.recompile.failure}</p>
                <button className="mt-2 rounded border border-[#d9aa3d]/30 px-2 py-1 text-[9px] text-[#ddb858] disabled:opacity-40" data-testid="issue-recompile-retry" disabled={busy} onClick={() => void retryRecompile()} type="button">Enfileirar de novo</button>
              </div>
            ) : null}
            {applied.recompile.phase === 'queued' ? (
              <div className="mt-1">
                <p className="text-[10px] text-[#d8d2c8]" data-operation-id={applied.recompile.operationId ?? ''} data-operation-status={operation?.status ?? 'queued'} data-testid="issue-recompile-status">
                  {cancelledOperationId === applied.recompile.operationId || operation?.status === 'canceled' || operation?.status === 'cancelled'
                    ? 'Cancelado: nenhum proxy novo foi promovido. A versão nova existe e continua sem render.'
                    : OPERATION_LABELS[operation?.status ?? 'queued'] ?? operation?.status}
                  {operation?.phase ? ` · ${operation.phase}` : ''}
                </p>
                {operation?.status === 'failed' ? <p className="mt-1 text-[10px] text-[#c97870]">{operation.error?.message ?? 'O render falhou.'}</p> : null}
                {operationActive ? (
                  <button className={`mt-2 rounded border px-2 py-1 text-[9px] ${cancelArmed ? 'border-[#c66f68] text-[#df8a82]' : 'border-white/[0.12] text-[#aaa49a]'} disabled:opacity-40`} data-testid="issue-recompile-cancel" disabled={busy} onClick={() => void cancelRecompile()} type="button">
                    {cancelArmed ? 'Confirmar o cancelamento' : 'Cancelar recompilação'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="mt-3" data-testid="issue-comparison">
            <p className="text-[8px] uppercase tracking-[0.14em] text-[#625f58]">Antes e depois</p>
            <p className="mt-1 font-mono text-[8px] text-[#625f58]">
              antes: versão {applied.before.versionId} · laudo {applied.before.reviewHash.slice(0, 12)} · proxy {applied.before.proxyArtifactId}{applied.before.proxySha256 ? ` · sha ${applied.before.proxySha256.slice(0, 16)}` : ''}
            </p>
            <p className="font-mono text-[8px] text-[#625f58]" data-testid="issue-comparison-after">
              {afterChips && review && proxyAfter ? `depois: ${applied.versionId} · laudo ${review.reviewHash.slice(0, 12)} · proxy ${proxyAfter.artifactId}${proxyAfter.sha256 ? ` · sha ${proxyAfter.sha256.slice(0, 16)}` : ''}` : 'depois: ainda sem um novo laudo para a versão nova'}
            </p>
            <ul className="mt-2 space-y-1">
              {comparison.map((row) => (
                <li className="flex flex-wrap items-center gap-2 text-[10px]" data-delta={row.delta} data-testid="issue-comparison-row" key={`${row.delta}:${row.key}`}>
                  <span className={`rounded px-1.5 py-0.5 text-[8px] font-bold uppercase ${row.severity === 'block' ? 'bg-[#c66f68]/15 text-[#df8a82]' : 'bg-[#d5aa4e]/15 text-[#e2bd69]'}`}>{CHIP_LABELS[row.severity]}</span>
                  <span className="font-mono text-[#aaa49a]">{row.code}</span>
                  {row.range ? <span className="font-mono text-[8px] text-[#625f58]">{row.range.startFrame}–{row.range.endFrame}</span> : null}
                  <span className="text-[#8e8980]">{DELTA_LABELS[row.delta]}</span>
                </li>
              ))}
              {comparison.length === 0 ? <li className="text-[10px] text-[#716d65]">Nenhum problema no laudo anterior.</li> : null}
            </ul>
          </div>
        </div>
      ) : null}
    </section>
  )
}
