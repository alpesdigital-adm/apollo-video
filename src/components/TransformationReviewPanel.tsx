'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface Envelope<T> { data?: T; error?: { message?: string } }
interface ReviewRegionAnnotation {
  id: string
  scope: 'point' | 'region' | 'scene'
  region?: { x: number; y: number; width: number; height: number }
  status: 'open' | 'applied' | 'dismissed'
  text: string
}
interface TransformationBriefView {
  id: string
  projectVersionId: string
  mode: string
  editorialIntent: string
  durationFrames: number
  outputSpecIds: string[]
}
interface CleanupMaskView {
  id: string
  rootId: string
  transformationBrief: { id: string }
  tracking: { status: string; confidenceBps: number }
  region: { x: number; y: number; width: number; height: number }
  range: { startFrame: number; endFrame: number }
  keyframes: { frame: number; region: { x: number; y: number; width: number; height: number } }[]
  maskHash: string
  revision: number
}
interface FallbackAttemptView {
  sequence: number
  rung: string
  providerJobId?: string
  outcome: string
  observedCostMinorUnits: number
  reason: string
}
interface FallbackLedgerView {
  id: string
  briefId: string
  currentRung: string
  attempts: FallbackAttemptView[]
  bestArtifactId: string | null
  bestIntentScoreBps: number | null
  incurredCostMinorUnits: number
  costCurrency: string
  reviewDecision: 'accepted' | 'awaiting-review' | 'kept-source'
  ledgerHash: string
}
interface CriticReportView {
  id: string
  briefId: string
  providerJobId: string
  decision: 'approved' | 'rejected' | 'needs-review' | 'evidence-unavailable'
  action: string
  intentScoreBps: number | null
  hardGates: string[]
  measurements: { dimension: string; status: string; scoreBps: number | null; thresholdBps: number | null }[]
  issues: { dimension: string; severity: string; description: string }[]
  reportHash: string
}
interface NoveltyDecisionView {
  id: string
  treatment: 'sober' | 'balanced' | 'intense'
  acceptedUnits: number
  penalizedUnits: number
  blockedCount: number
  densityUnits: number
  lines: { briefId: string; outcome: string; chargedUnits: number; reason: string }[]
}
interface QualityView {
  ledgers: { ledger: FallbackLedgerView; actions: string[] }[]
  reports: CriticReportView[]
  novelty: NoveltyDecisionView[]
}

const RUNG_LABEL: Readonly<Record<string, string>> = {
  'video-to-video': 'Vídeo transformado',
  'actor-composite': 'Composição de sujeito',
  'generated-cutaway': 'Cutaway gerado',
  'still-parallax': 'Imagem com parallax',
  'source-unchanged': 'Fonte preservada',
}
const DECISION_LABEL: Readonly<Record<string, string>> = {
  approved: 'Aprovado pelo critic', rejected: 'Reprovado', 'needs-review': 'Revisão necessária',
  'evidence-unavailable': 'Evidência incompleta', accepted: 'Aceito', 'awaiting-review': 'Aguardando aceite',
  'kept-source': 'Fonte mantida',
}

async function responseData<T>(response: Response): Promise<T> {
  const body = await response.json() as Envelope<T>
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? 'A operação não pôde ser concluída.')
  return body.data
}

export default function TransformationReviewPanel(props: {
  projectId: string
  projectVersionId?: string
  annotations: readonly ReviewRegionAnnotation[]
  reviewResolution?: { width: number; height: number }
}) {
  const [quality, setQuality] = useState<QualityView | null>(null)
  const [briefs, setBriefs] = useState<TransformationBriefView[]>([])
  const [masks, setMasks] = useState<CleanupMaskView[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState('')
  const [selectedBriefId, setSelectedBriefId] = useState('')
  const [selectedMaskId, setSelectedMaskId] = useState('')
  const [maskRegion, setMaskRegion] = useState({ x: 0, y: 0, width: 0.2, height: 0.2 })
  const [trackingStatus, setTrackingStatus] = useState<'static' | 'tracked' | 'uncertain'>('static')
  const [trackingConfidenceBps, setTrackingConfidenceBps] = useState(9_000)
  const maskKeys = useRef(new Map<string, string>())
  const refinementKeys = useRef(new Map<string, string>())

  const load = useCallback(async (signal?: AbortSignal) => {
    setError(null)
    try {
      const [qualityResult, briefResult, maskResult] = await Promise.all([
        fetch(`/v1/projects/${encodeURIComponent(props.projectId)}/transformation-quality`, { signal, cache: 'no-store' }).then(responseData<QualityView>),
        fetch(`/v1/projects/${encodeURIComponent(props.projectId)}/transformation-briefs`, { signal, cache: 'no-store' }).then(responseData<{ briefs: TransformationBriefView[] }>),
        fetch(`/v1/projects/${encodeURIComponent(props.projectId)}/review-cleanup-masks`, { signal, cache: 'no-store' }).then(responseData<{ masks: CleanupMaskView[] }>),
      ])
      const briefsForVersion = props.projectVersionId ? briefResult.briefs.filter((brief) => brief.projectVersionId === props.projectVersionId) : briefResult.briefs
      const masksForVersion = props.projectVersionId ? maskResult.masks.filter((mask) => briefsForVersion.some((brief) => brief.id === mask.transformationBrief.id)) : maskResult.masks
      setQuality(qualityResult)
      setBriefs(briefsForVersion)
      setMasks(masksForVersion)
      setSelectedBriefId((current) => current || briefsForVersion[0]?.id || '')
      setSelectedMaskId((current) => {
        const stillCurrent = masksForVersion.some((mask) => mask.id === current)
        return stillCurrent ? current : (masksForVersion[0]?.id ?? '')
      })
    } catch (cause) {
      if ((cause as Error).name !== 'AbortError') setError(cause instanceof Error ? cause.message : 'A revisão de transformação não carregou.')
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [props.projectId, props.projectVersionId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const regionalAnnotations = useMemo(() => props.annotations.filter((annotation) =>
    annotation.scope === 'region' && annotation.region && annotation.status === 'open'), [props.annotations])
  useEffect(() => {
    if (!selectedAnnotationId && regionalAnnotations[0]) setSelectedAnnotationId(regionalAnnotations[0].id)
  }, [regionalAnnotations, selectedAnnotationId])

  const selectedMask = useMemo(() => masks.find((mask) => mask.id === selectedMaskId) ?? null, [masks, selectedMaskId])
  useEffect(() => {
    if (!selectedMask) return
    setMaskRegion(selectedMask.region)
    setTrackingStatus(selectedMask.tracking.status as 'static' | 'tracked' | 'uncertain')
    setTrackingConfidenceBps(selectedMask.tracking.confidenceBps)
  }, [selectedMask])

  const latestLedger = quality?.ledgers[0]
  const latestReport = latestLedger
    ? quality?.reports.find((report) => report.briefId === latestLedger.ledger.briefId)
    : quality?.reports[0]
  const latestNovelty = quality?.novelty[0]

  const act = useCallback(async (action: 'accept' | 'keep-source' | 'descend') => {
    if (!latestLedger) return
    setBusy(action)
    setError(null)
    try {
      await fetch(`/v1/projects/${encodeURIComponent(props.projectId)}/transformation-fallbacks/${encodeURIComponent(latestLedger.ledger.id)}/actions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action === 'descend' ? { action, because: 'intent-not-satisfied' } : { action }),
      }).then(responseData)
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'A decisão não foi registrada.') }
    finally { setBusy(null) }
  }, [latestLedger, load, props.projectId])

  const retry = useCallback(async () => {
    const jobId = latestLedger?.ledger.attempts.toReversed().find((attempt) => attempt.providerJobId)?.providerJobId
    if (!jobId) return
    setBusy('retry')
    setError(null)
    try {
      await fetch(`/v1/projects/${encodeURIComponent(props.projectId)}/transformation-jobs/${encodeURIComponent(jobId)}/retries`, { method: 'POST' }).then(responseData)
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'A nova tentativa não foi iniciada.') }
    finally { setBusy(null) }
  }, [latestLedger, load, props.projectId])

  const createMask = useCallback(async () => {
    const brief = briefs.find((item) => item.id === selectedBriefId)
    const resolution = props.reviewResolution
    if (!brief || !selectedAnnotationId || !resolution || !brief.outputSpecIds[0]) return
    const identity = `${selectedAnnotationId}:${brief.id}:${brief.outputSpecIds[0]}`
    const key = maskKeys.current.get(identity) ?? crypto.randomUUID()
    maskKeys.current.set(identity, key)
    setBusy('mask')
    setError(null)
    try {
      await fetch(`/v1/projects/${encodeURIComponent(props.projectId)}/review-cleanup-masks`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          annotationId: selectedAnnotationId,
          transformationBriefId: brief.id,
          format: { outputSpecId: brief.outputSpecIds[0], width: resolution.width, height: resolution.height },
          trackingConfidenceBps: 9_000,
        }),
      }).then(responseData)
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'A máscara não foi criada.') }
    finally { setBusy(null) }
  }, [briefs, load, props.projectId, props.reviewResolution, selectedAnnotationId, selectedBriefId])

  const refineMask = useCallback(async () => {
    if (!selectedMask) return
    const identity = `${selectedMask.id}:${selectedMask.maskHash}:${JSON.stringify(maskRegion)}:${trackingStatus}:${trackingConfidenceBps}`
    const key = refinementKeys.current.get(identity) ?? crypto.randomUUID()
    refinementKeys.current.set(identity, key)
    setBusy('refine-mask')
    setError(null)
    try {
      await fetch(`/v1/projects/${encodeURIComponent(props.projectId)}/review-cleanup-masks/${encodeURIComponent(selectedMask.id)}/refinements`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({
          expectedMaskHash: selectedMask.maskHash,
          region: maskRegion,
          range: selectedMask.range,
          keyframes: selectedMask.keyframes.map((keyframe, index) => ({
            frame: keyframe.frame,
            region: index === 0 ? maskRegion : keyframe.region,
          })),
          trackingStatus,
          trackingConfidenceBps,
        }),
      }).then(responseData)
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'A máscara não foi refinada.') }
    finally { setBusy(null) }
  }, [load, maskRegion, props.projectId, selectedMask, trackingConfidenceBps, trackingStatus])

  return (
    <section aria-label="Revisão de transformações generativas" className="mt-5 overflow-hidden rounded-2xl border border-white/[0.08] bg-[#090909]" data-testid="transformation-review-panel">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-4">
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-[#ad8950]">Transformações</p>
          <h2 className="mt-1.5 text-base font-semibold tracking-[-0.02em] text-[#e8e3da]">O efeito precisa provar que respeitou a fonte.</h2>
          <p className="mt-1 max-w-3xl text-[10px] leading-5 text-[#6e6961]">Custo, regiões protegidas e cada degrau alternativo ficam visíveis antes do aceite.</p>
        </div>
        <button className="border border-white/[0.09] px-3 py-2 text-[9px] uppercase tracking-[0.12em] text-[#8a847b] hover:border-[#a98235]/50 hover:text-[#d4ac50]" onClick={() => void load()} type="button">Atualizar provas</button>
      </div>

      {loading ? <div className="px-5 py-10 text-center text-xs text-[#716c64]">Lendo critic, orçamento e tentativas…</div> : null}
      {!loading && !quality?.ledgers.length && !quality?.reports.length && !quality?.novelty.length ? (
        <div className="px-5 py-9"><p className="text-sm text-[#bdb7ae]">Nenhuma transformação foi avaliada ainda.</p><p className="mt-1 text-[10px] leading-5 text-[#69655e]">Quando o worker receber um resultado, a comparação de pixels, o custo e a escada de fallback aparecerão aqui.</p></div>
      ) : null}
      {!loading && (latestLedger || latestReport || latestNovelty) ? (
        <div className="grid divide-y divide-white/[0.07] lg:grid-cols-[0.8fr_1.15fr_1.4fr] lg:divide-x lg:divide-y-0">
          <div className="px-5 py-5">
            <p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-[#777168]">Densidade narrativa</p>
            <p className="mt-3 text-xl font-semibold text-[#d7b259]">{latestNovelty ? latestNovelty.treatment : '—'}</p>
            <div className="mt-4 space-y-2 font-mono text-[8px] text-[#756f66]">
              <p className="flex justify-between"><span>consumo</span><span>{latestNovelty?.acceptedUnits ?? 0} un.</span></p>
              <p className="flex justify-between"><span>penalidades</span><span>{latestNovelty?.penalizedUnits ?? 0} un.</span></p>
              <p className="flex justify-between"><span>densidade visual</span><span>{latestNovelty?.densityUnits ?? 0} un.</span></p>
              <p className="flex justify-between"><span>bloqueios</span><span>{latestNovelty?.blockedCount ?? 0}</span></p>
            </div>
          </div>
          <div className="px-5 py-5">
            <div className="flex items-center justify-between gap-3"><p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-[#777168]">Critic de 14 dimensões</p><span className={`text-[8px] uppercase ${latestReport?.decision === 'approved' ? 'text-[#71b985]' : 'text-[#d07168]'}`}>{latestReport ? DECISION_LABEL[latestReport.decision] : 'sem relatório'}</span></div>
            <p className="mt-3 font-mono text-lg text-[#d8d0c4]">{latestReport?.intentScoreBps === null || latestReport?.intentScoreBps === undefined ? '—' : `${(latestReport.intentScoreBps / 100).toFixed(0)}%`} <span className="text-[8px] uppercase tracking-[0.12em] text-[#625d56]">aderência</span></p>
            <div className="mt-4 grid grid-cols-2 gap-1.5">
              {latestReport?.measurements.map((measurement) => (
                <span className={`border px-2 py-1 text-[7px] ${measurement.status !== 'measured' ? 'border-[#805e2d]/35 text-[#a48148]' : (measurement.scoreBps ?? 0) >= (measurement.thresholdBps ?? 0) ? 'border-[#477a58]/30 text-[#6ca17b]' : 'border-[#914b47]/35 text-[#bd6c66]'}`} key={measurement.dimension}>{measurement.dimension}</span>
              ))}
            </div>
            {latestReport?.issues[0] ? <p className="mt-3 border-l border-[#a9524c]/50 pl-3 text-[9px] leading-4 text-[#a97a75]">{latestReport.issues[0].description}</p> : null}
          </div>
          <div className="px-5 py-5">
            <div className="flex items-center justify-between gap-3"><p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-[#777168]">Escada de contingência</p><span className="font-mono text-[8px] text-[#7c756b]">{latestLedger ? `${latestLedger.ledger.costCurrency} ${(latestLedger.ledger.incurredCostMinorUnits / 100).toFixed(2)}` : '—'}</span></div>
            <ol className="mt-4 space-y-1.5">
              {['video-to-video','actor-composite','generated-cutaway','still-parallax','source-unchanged'].map((rung, index) => {
                const current = latestLedger?.ledger.currentRung === rung
                const attempted = latestLedger?.ledger.attempts.some((attempt) => attempt.rung === rung && attempt.outcome !== 'skipped')
                return <li className={`grid grid-cols-[22px_1fr_auto] items-center gap-2 border px-2.5 py-2 ${current ? 'border-[#b58a35]/50 bg-[#a67b28]/[0.07]' : 'border-white/[0.055]'}`} key={rung}><span className={`grid h-4 w-4 place-items-center rounded-full text-[7px] ${attempted ? 'bg-[#578f68]/20 text-[#72af83]' : current ? 'bg-[#bd9138]/20 text-[#d5ac51]' : 'bg-white/[0.03] text-[#565149]'}`}>{index + 1}</span><span className={`text-[9px] ${current ? 'text-[#d2b266]' : 'text-[#777168]'}`}>{RUNG_LABEL[rung]}</span><span className="text-[7px] uppercase text-[#5f5a53]">{current ? 'atual' : attempted ? 'tentado' : ''}</span></li>
              })}
            </ol>
            {latestLedger ? <div className="mt-4 flex flex-wrap gap-2">
              {latestLedger.actions.includes('accept') ? <button className="bg-[#5a9a6d] px-3 py-2 text-[8px] font-bold uppercase text-[#06130a] disabled:opacity-40" disabled={busy !== null} onClick={() => void act('accept')} type="button">{busy === 'accept' ? 'Aceitando…' : 'Aceitar resultado'}</button> : null}
              {latestLedger.actions.includes('retry') ? <button className="border border-white/[0.1] px-3 py-2 text-[8px] uppercase text-[#aaa299] disabled:opacity-40" disabled={busy !== null} onClick={() => void retry()} type="button">{busy === 'retry' ? 'Reiniciando…' : 'Tentar de novo'}</button> : null}
              {latestLedger.actions.includes('descend') ? <button className="border border-[#a57c2d]/40 px-3 py-2 text-[8px] uppercase text-[#c29b4d] disabled:opacity-40" disabled={busy !== null} onClick={() => void act('descend')} type="button">Descer um degrau</button> : null}
              {latestLedger.actions.includes('keep-source') ? <button className="border border-white/[0.08] px-3 py-2 text-[8px] uppercase text-[#777168] disabled:opacity-40" disabled={busy !== null} onClick={() => void act('keep-source')} type="button">Manter original</button> : null}
            </div> : null}
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 border-t border-white/[0.07] bg-[#0b0a09] px-5 py-5 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
        <label className="grid gap-1.5 text-[8px] uppercase tracking-[0.12em] text-[#746e65]">Área marcada pelo editor<select className="border border-white/[0.09] bg-[#0d0d0d] px-3 py-2 text-[10px] normal-case tracking-normal text-[#bdb6ac]" onChange={(event) => setSelectedAnnotationId(event.target.value)} value={selectedAnnotationId}><option value="">Selecione uma área aberta</option>{regionalAnnotations.map((annotation) => <option key={annotation.id} value={annotation.id}>{annotation.text.slice(0, 80)}</option>)}</select></label>
        <label className="grid gap-1.5 text-[8px] uppercase tracking-[0.12em] text-[#746e65]">Transformação autorizada<select className="border border-white/[0.09] bg-[#0d0d0d] px-3 py-2 text-[10px] normal-case tracking-normal text-[#bdb6ac]" onChange={(event) => setSelectedBriefId(event.target.value)} value={selectedBriefId}><option value="">Selecione um brief</option>{briefs.map((brief) => <option key={brief.id} value={brief.id}>{brief.mode} · {brief.editorialIntent.slice(0, 70)}</option>)}</select></label>
        <button className="border border-[#9f7b31]/40 bg-[#a47d29]/[0.07] px-4 py-2.5 text-[8px] font-semibold uppercase tracking-[0.1em] text-[#cda94f] disabled:cursor-not-allowed disabled:opacity-35" disabled={!selectedAnnotationId || !selectedBriefId || !props.reviewResolution || busy !== null} onClick={() => void createMask()} type="button">{busy === 'mask' ? 'Selando máscara…' : 'Criar máscara revisável'}</button>
        <p className="text-[8px] text-[#625d56] lg:col-span-3">{masks.length} máscara{masks.length === 1 ? '' : 's'} persistida{masks.length === 1 ? '' : 's'} · o master original nunca é sobrescrito.</p>
      </div>
      {selectedMask ? <div className="border-t border-white/[0.07] bg-[#080808] px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-[8px] font-semibold uppercase tracking-[0.18em] text-[#777168]">Refino antes do custo</p><p className="mt-1 text-[10px] text-[#6f6a62]">Cada ajuste cria uma revisão imutável; a anterior permanece auditável.</p></div>
          <label className="grid gap-1 text-[8px] uppercase tracking-[0.12em] text-[#746e65]">Máscara<select aria-label="Máscara para refinar" className="border border-white/[0.09] bg-[#0d0d0d] px-3 py-2 text-[9px] normal-case tracking-normal text-[#bdb6ac]" onChange={(event) => setSelectedMaskId(event.target.value)} value={selectedMaskId}>{masks.map((mask) => <option key={mask.id} value={mask.id}>revisão {mask.revision} · {mask.tracking.status} · {mask.id.slice(-10)}</option>)}</select></label>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,0.7fr))_1fr_1fr_auto] lg:items-end">
          {(['x', 'y', 'width', 'height'] as const).map((field) => <label className="grid gap-1 text-[8px] uppercase tracking-[0.1em] text-[#69645c]" key={field}>{field}<input aria-label={`Região ${field}`} className="border border-white/[0.08] bg-[#0d0d0d] px-2 py-2 font-mono text-[9px] text-[#bdb6ac]" max="1" min="0" onChange={(event) => setMaskRegion((current) => ({ ...current, [field]: Number(event.target.value) }))} step="0.001" type="number" value={maskRegion[field]} /></label>)}
          <label className="grid gap-1 text-[8px] uppercase tracking-[0.1em] text-[#69645c]">Tracking<select aria-label="Estado do tracking" className="border border-white/[0.08] bg-[#0d0d0d] px-2 py-2 text-[9px] normal-case tracking-normal text-[#bdb6ac]" onChange={(event) => setTrackingStatus(event.target.value as typeof trackingStatus)} value={trackingStatus}><option value="static">estático</option><option value="tracked">rastreado</option><option value="uncertain">incerto</option></select></label>
          <label className="grid gap-1 text-[8px] uppercase tracking-[0.1em] text-[#69645c]">Confiança (0–100%)<input aria-label="Confiança do tracking" className="border border-white/[0.08] bg-[#0d0d0d] px-2 py-2 font-mono text-[9px] text-[#bdb6ac]" max="100" min="0" onChange={(event) => setTrackingConfidenceBps(Math.round(Number(event.target.value) * 100))} step="1" type="number" value={trackingConfidenceBps / 100} /></label>
          <button className="border border-[#9f7b31]/40 px-4 py-2.5 text-[8px] font-semibold uppercase tracking-[0.1em] text-[#cda94f] disabled:opacity-35" disabled={busy !== null || maskRegion.width <= 0 || maskRegion.height <= 0 || maskRegion.x < 0 || maskRegion.y < 0 || maskRegion.x + maskRegion.width > 1 || maskRegion.y + maskRegion.height > 1 || trackingConfidenceBps < 0 || trackingConfidenceBps > 10_000} onClick={() => void refineMask()} type="button">{busy === 'refine-mask' ? 'Gravando revisão…' : 'Gravar refino'}</button>
        </div>
      </div> : null}
      {error ? <p className="border-t border-[#8b423e]/30 bg-[#321817]/20 px-5 py-3 text-[10px] text-[#c87972]" role="alert">{error}</p> : null}
    </section>
  )
}
