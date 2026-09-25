'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import { createLatestReadFence, type EditorReads, type ReadFailure } from '@/app/_operator/editor-reads'
import { addressSyntheticPhaseGateReference } from '@/v2/ui/synthetic-phase-gate-addresses'
import {
  capSyntheticPhaseGateHistory,
  classifySyntheticPhaseGateSnapshot,
  insertSyntheticPhaseGateFirst,
  NO_SYNTHETIC_PHASE_GATE_SELECTION,
  reconcileSyntheticPhaseGateSelection,
  SYNTHETIC_PHASE_GATE_HISTORY_LIMIT,
  type SyntheticPhaseGateSelection,
} from '@/v2/ui/synthetic-phase-gate-history'

const CRITERIA = Object.freeze([
  Object.freeze({
    code: 'F3-GATE-001', title: 'Providers ao vivo',
    checks: Object.freeze([
      ['elevenlabs-audio-alignment-live', 'ElevenLabs com áudio e alignment observados ao vivo'],
      ['heygen-generated-audio-avatar-live', 'HeyGen com áudio gerado e identidade observada ao vivo'],
      ['heygen-ready-audio-avatar-live', 'HeyGen com áudio pronto e identidade observada ao vivo'],
    ] as const),
  }),
  Object.freeze({
    code: 'F3-GATE-002', title: 'Catálogo e reuso',
    checks: Object.freeze([
      ['approved-blocks-catalogued', 'Blocos aprovados publicados no catálogo'],
      ['cross-project-reuse-with-zero-provider-work', 'Outro projeto reutilizou o master sem novo trabalho de provider'],
    ] as const),
  }),
  Object.freeze({
    code: 'F3-GATE-003', title: 'Fallback controlado',
    checks: Object.freeze([
      ['transformation-rejected-before-fallback', 'Transformação recusada antes do fallback'],
      ['fallback-result-approved', 'Resultado de fallback aprovado'],
    ] as const),
  }),
  Object.freeze({
    code: 'F3-GATE-004', title: 'Contrato do renderer',
    checks: Object.freeze([
      ['provider-swap-keeps-plan-and-renderer-contracts', 'Troca de provider preservou plano, assets e runtime'],
    ] as const),
  }),
] as const)

const TOTAL_CHECKS = CRITERIA.reduce((total, criterion) => total + criterion.checks.length, 0)

interface GateReference {
  type: string
  id: string
  hash: string
}

interface GateCheck {
  code: string
  passed: boolean
  missingEvidenceTypes: string[]
  references: GateReference[]
}

interface GateCriterion {
  criterion: string
  passed: boolean
  missingChecks: string[]
  checks: GateCheck[]
}

interface SyntheticPhaseGateView {
  id: string
  projectVersionId: string
  projectVersionHash: string
  reportFingerprint: string
  recordHash: string
  createdAt: string
  report: {
    approved: boolean
    passed: number
    total: number
    missing: string[]
    failed: string[]
    evaluatedAt: string
    evidence: GateCriterion[]
  }
}

interface CapabilityView {
  id: string
}

interface PublicEnvelope<T> {
  data?: T
  error?: { message?: string; code?: string; requestId?: string }
}

type PanelState = 'loading' | 'ready' | 'empty' | 'error'
type GateVerdict = 'approved' | 'failed' | 'incomplete'

interface GateHistory extends SyntheticPhaseGateSelection {
  /** Project, version and hash of the props the list was read or evaluated for. */
  gatesIdentity: string
  /** Server order (`createdAt desc, id desc`), at most the history limit. */
  gates: readonly SyntheticPhaseGateView[]
}

const NO_GATES: readonly SyntheticPhaseGateView[] = Object.freeze([])
const EMPTY_HISTORY: Readonly<GateHistory> = Object.freeze({
  ...NO_SYNTHETIC_PHASE_GATE_SELECTION,
  gatesIdentity: '',
  gates: NO_GATES,
})

const VERDICT_LABELS: Readonly<Record<GateVerdict, string>> = Object.freeze({
  approved: 'Aprovado',
  failed: 'Reprovado',
  incomplete: 'Incompleto',
})

function visibleFailure(failure: ReadFailure): string {
  if (failure.kind === 'auth') return 'A sessão expirou. Entre novamente para consultar o gate.'
  if (failure.kind === 'forbidden') return 'Esta sessão não pode consultar o gate sintético.'
  if (failure.kind === 'rate-limited') return 'O servidor pediu uma pausa antes de consultar o gate novamente.'
  return failure.message
}

function newIdempotencyKey(): string {
  return `synthetic-phase-gate-ui-${globalThis.crypto.randomUUID()}`
}

function shortHash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-6)}`
}

function panelIdentity(projectId: string, versionId: string, versionHash: string): string {
  return `${projectId}\u0000${versionId}\u0000${versionHash}`
}

function gateVerdict(gate: SyntheticPhaseGateView): GateVerdict {
  if (gate.report.approved) return 'approved'
  const incomplete = gate.report.missing.length > 0 ||
    gate.report.evidence.some((criterion) =>
      criterion.missingChecks.length > 0 ||
      criterion.checks.some((check) => check.missingEvidenceTypes.length > 0))
  return incomplete ? 'incomplete' : 'failed'
}

export default function SyntheticPhaseGatePanel(props: Readonly<{
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  reads: EditorReads
}>) {
  const router = useRouter()
  const [state, setState] = useState<PanelState>('loading')
  const [history, setHistory] = useState<Readonly<GateHistory>>(EMPTY_HISTORY)
  const [failure, setFailure] = useState<string | null>(null)
  const [publishedCapabilityIds, setPublishedCapabilityIds] = useState<ReadonlySet<string>>(new Set())
  const [running, setRunning] = useState(false)
  const readFenceRef = useRef(createLatestReadFence())
  const mutationGenerationRef = useRef(0)
  const mutationPendingRef = useRef(false)
  const identityRef = useRef('')
  const idempotencyRef = useRef<{
    projectId: string
    versionId: string
    versionHash: string
    key: string
  } | null>(null)

  const load = useCallback(async (explicitRetry = false) => {
    if (mutationPendingRef.current) return
    const ticket = readFenceRef.current.begin()
    const mutationGeneration = mutationGenerationRef.current
    const loadIdentity = panelIdentity(props.projectId, props.projectVersionId, props.projectVersionHash)
    setState('loading')
    setFailure(null)
    const query = 'limit=20'
    let gateResult
    let capabilityResult
    try {
      [gateResult, capabilityResult] = await Promise.all([
        props.reads.read<{ gates: SyntheticPhaseGateView[] }>({
          name: 'synthetic-phase-gates',
          url: `/v1/projects/${encodeURIComponent(props.projectId)}/synthetic-phase-gates?${query}`,
          versionId: props.projectVersionId,
          query,
        }, { explicitRetry }),
        props.reads.read<{ capabilities: CapabilityView[] }>({
          name: 'capabilities',
          url: '/v1/capabilities',
          versionId: props.projectVersionId,
        }, { explicitRetry }),
      ])
    } catch (error) {
      if (
        !readFenceRef.current.isCurrent(ticket) ||
        mutationGenerationRef.current !== mutationGeneration
      ) return
      setHistory({ ...EMPTY_HISTORY, gatesIdentity: loadIdentity })
      setFailure(error instanceof Error ? error.message : 'Não foi possível consultar o gate sintético.')
      setState('error')
      return
    }
    if (
      !readFenceRef.current.isCurrent(ticket) ||
      mutationGenerationRef.current !== mutationGeneration
    ) return
    if (!capabilityResult.ok && capabilityResult.failure.kind === 'auth') {
      router.replace('/login')
      return
    }
    setPublishedCapabilityIds(new Set(
      capabilityResult.ok ? capabilityResult.data.capabilities.map(({ id }) => id) : [],
    ))
    if (!gateResult.ok) {
      if (gateResult.failure.dropped) return
      if (gateResult.failure.kind === 'auth') {
        router.replace('/login')
        return
      }
      setHistory({ ...EMPTY_HISTORY, gatesIdentity: loadIdentity })
      setFailure(visibleFailure(gateResult.failure))
      setState('error')
      return
    }
    // The server order is the history order; the list is only cut, never sorted.
    const gates = capSyntheticPhaseGateHistory(gateResult.data.gates)
    setHistory((current) => {
      const selection = reconcileSyntheticPhaseGateSelection(
        gates,
        current.gatesIdentity === loadIdentity ? current : NO_SYNTHETIC_PHASE_GATE_SELECTION,
      )
      return {
        gatesIdentity: loadIdentity,
        gates,
        selectedGateId: selection.selectedGateId,
        selectionPinned: selection.selectionPinned,
      }
    })
    setState(gates.length > 0 ? 'ready' : 'empty')
  }, [props.projectId, props.projectVersionHash, props.projectVersionId, props.reads, router])

  const identity = panelIdentity(props.projectId, props.projectVersionId, props.projectVersionHash)
  useEffect(() => {
    const readFence = readFenceRef.current
    if (identityRef.current !== identity) {
      identityRef.current = identity
      mutationGenerationRef.current += 1
      mutationPendingRef.current = false
      setRunning(false)
      // Nothing read or evaluated for the previous identity may render, and no
      // pin survives it: the new identity starts from its own first gate.
      setHistory(EMPTY_HISTORY)
      setFailure(null)
    }
    void load()
    return () => readFence.invalidate()
  }, [identity, load])

  const run = useCallback(async () => {
    const requestIdentity = panelIdentity(props.projectId, props.projectVersionId, props.projectVersionHash)
    const mutationGeneration = mutationGenerationRef.current + 1
    mutationGenerationRef.current = mutationGeneration
    mutationPendingRef.current = true
    readFenceRef.current.invalidate()
    const identity = idempotencyRef.current
    const key = identity?.projectId === props.projectId &&
      identity.versionId === props.projectVersionId &&
      identity.versionHash === props.projectVersionHash
      ? identity.key
      : newIdempotencyKey()
    idempotencyRef.current = {
      projectId: props.projectId,
      versionId: props.projectVersionId,
      versionHash: props.projectVersionHash,
      key,
    }
    setRunning(true)
    setFailure(null)
    let evaluated = false
    try {
      // Always the editor's current version, never the selected gate's.
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(props.projectId)}/synthetic-phase-gates`,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'idempotency-key': key,
          },
          body: JSON.stringify({
            projectVersionId: props.projectVersionId,
            projectVersionHash: props.projectVersionHash,
          }),
          signal: AbortSignal.timeout(10_000),
        },
      )
      const payload = await response.json() as PublicEnvelope<{ gate: SyntheticPhaseGateView }>
      if (
        mutationGenerationRef.current !== mutationGeneration ||
        identityRef.current !== requestIdentity
      ) return
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      if (!response.ok || !payload.data?.gate) {
        throw new Error(payload.error?.message ?? `A avaliação foi recusada (HTTP ${response.status}).`)
      }
      const evaluatedGate = payload.data.gate
      idempotencyRef.current = null
      props.reads.invalidate('synthetic-phase-gates')
      setHistory((current) => ({
        gatesIdentity: requestIdentity,
        gates: insertSyntheticPhaseGateFirst(
          current.gatesIdentity === requestIdentity ? current.gates : NO_GATES,
          evaluatedGate,
        ),
        selectedGateId: evaluatedGate.id,
        selectionPinned: 'mutation',
      }))
      setState('ready')
      evaluated = true
    } catch (error) {
      if (
        mutationGenerationRef.current !== mutationGeneration ||
        identityRef.current !== requestIdentity
      ) return
      setFailure(error instanceof Error && error.name === 'TimeoutError'
        ? 'A resposta da avaliação não chegou a tempo. Tente novamente para consultar a mesma intenção.'
        : error instanceof Error ? error.message : 'Não foi possível avaliar o gate sintético.')
      setState(history.gatesIdentity === requestIdentity && history.gates.length > 0 ? 'ready' : 'error')
    } finally {
      if (
        mutationGenerationRef.current === mutationGeneration &&
        identityRef.current === requestIdentity
      ) {
        mutationPendingRef.current = false
        setRunning(false)
        // The canonical list replaces the optimistic one; the pin keeps the
        // evaluated gate selected while that list still contains it.
        if (evaluated) void load()
      }
    }
  }, [history.gates.length, history.gatesIdentity, load, props.projectId, props.projectVersionHash, props.projectVersionId, props.reads, router])

  // State can survive a route transition for one render. Bind the displayed
  // history to the identity that produced it so gates read for project A are
  // never shown, nor their references addressed with project B's URL, while
  // the new read is in flight.
  const gates = history.gatesIdentity === identity ? history.gates : NO_GATES
  const visibleGate = useMemo(
    () => gates.find((gate) => gate.id === history.selectedGateId) ?? null,
    [gates, history.selectedGateId],
  )
  const selectedGateId = visibleGate?.id ?? null

  const checksByCode = useMemo(() => new Map(
    visibleGate?.report.evidence.flatMap((criterion) => criterion.checks).map((check) => [check.code, check]) ?? [],
  ), [visibleGate])
  const checkCoverage = useMemo(() => {
    let covered = 0
    let passed = 0
    for (const criterion of CRITERIA) {
      for (const [code] of criterion.checks) {
        const check = checksByCode.get(code)
        if (!check || check.missingEvidenceTypes.length > 0) continue
        covered += 1
        if (check.passed) passed += 1
      }
    }
    return Object.freeze({ covered, passed, total: TOTAL_CHECKS })
  }, [checksByCode])
  const snapshot = visibleGate
    ? classifySyntheticPhaseGateSnapshot({
      gate: visibleGate,
      gates,
      projectVersionId: props.projectVersionId,
      projectVersionHash: props.projectVersionHash,
    })
    : null
  const verdict: GateVerdict = visibleGate ? gateVerdict(visibleGate) : 'incomplete'

  return (
    <section className="mt-5 overflow-hidden rounded-xl border border-[#6962de]/20 bg-[#6962de]/[0.04]" data-gates-count={gates.length} data-selected-gate-id={selectedGateId ?? ''} data-testid="synthetic-phase-gate-panel">
      <header className="border-b border-white/[0.07] px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-[#9992f0]">Gate sintético · Fase 3</p>
            <p className="mt-1 text-xs text-[#aaa5bd]" data-testid="synthetic-phase-gate-summary">
              {visibleGate ? `${visibleGate.report.passed}/${visibleGate.report.total} critérios · ${checkCoverage.covered}/${checkCoverage.total} checks com evidência` : `0/4 critérios · 0/${TOTAL_CHECKS} checks com evidência`}
            </p>
          </div>
          <span className={`rounded-full border px-2 py-1 text-[9px] font-semibold ${verdict === 'approved' ? 'border-[#62b47d]/35 text-[#86cf9d]' : verdict === 'failed' ? 'border-[#ba6262]/35 text-[#d99a94]' : 'border-[#d2a647]/30 text-[#d9b765]'}`} data-gate-verdict={verdict}>
            {VERDICT_LABELS[verdict]}
          </span>
        </div>
        <p className="mt-2 text-[9px] leading-4 text-[#77728a]" data-testid="synthetic-phase-gate-snapshot-note">Estado do retrato selecionado. Nenhuma avaliação histórica equivale a aprovação da versão atual.</p>
        {gates.length > 0 ? (
          <div className="mt-3">
            <select
              aria-label="Histórico de avaliações"
              className="w-full rounded-lg border border-white/[0.08] bg-[#111018] px-2.5 py-2 font-mono text-[9px] text-[#c2bdcf] outline-none transition focus:border-[#8f86e8]/45 disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="synthetic-phase-gate-history"
              disabled={state === 'loading' || running}
              onChange={(event) => {
                const gateId = event.target.value
                setHistory((current) => ({ ...current, selectedGateId: gateId, selectionPinned: 'user' }))
              }}
              value={selectedGateId ?? ''}
            >
              {gates.map((gate) => {
                const gateState = gateVerdict(gate)
                return <option className="bg-[#111]" data-gate-id={gate.id} data-gate-state={gateState} data-gate-version={gate.projectVersionId} data-testid="synthetic-phase-gate-history-option" key={gate.id} value={gate.id}>{`${new Date(gate.createdAt).toLocaleString('pt-BR')} · versão ${gate.projectVersionId} · ${VERDICT_LABELS[gateState]}`}</option>
              })}
            </select>
            <p className="mt-1 text-[8px] text-[#656071]" data-testid="synthetic-phase-gate-history-count">{`${gates.length} avaliação(ões) · últimas ${SYNTHETIC_PHASE_GATE_HISTORY_LIMIT} do projeto`}</p>
          </div>
        ) : null}
        {state === 'loading' ? <p className="mt-3 animate-pulse text-[10px] text-[#77728a]" role="status">Lendo avaliação persistida…</p> : null}
        {state === 'empty' ? <p className="mt-3 text-[10px] leading-4 text-[#817c91]" data-testid="synthetic-phase-gate-empty">Este projeto ainda não tem avaliações persistidas. Os oito checks permanecem visíveis como ausentes.</p> : null}
        {failure ? <div className="mt-3 rounded-lg border border-[#ba6262]/25 bg-[#ba6262]/10 p-3 text-[10px] leading-4 text-[#d99a94]" role="alert"><p>{failure}</p><button className="mt-2 underline underline-offset-2 disabled:opacity-50" disabled={running} onClick={() => { void load(true) }} type="button">Tentar leitura novamente</button></div> : null}
        {visibleGate ? (
          <div className="mt-3 space-y-1 font-mono text-[8px] leading-4 text-[#6f6a7c]" data-testid="synthetic-phase-gate-identity">
            <p>Avaliado em {new Date(visibleGate.report.evaluatedAt).toLocaleString('pt-BR')} · versão {visibleGate.projectVersionId}</p>
            <p title={visibleGate.reportFingerprint}>report {shortHash(visibleGate.reportFingerprint)} · record {shortHash(visibleGate.recordHash)}</p>
            {snapshot === 'divergent'
              ? <p className="font-sans text-[10px] text-[#d5a958]" data-testid="synthetic-phase-gate-stale">{`Avaliação de outra versão ou hash: o editor está na versão ${props.projectVersionId}. Use "Avaliar versão atual" para o estado atual.`}</p>
              : snapshot === 'historical'
                ? <p className="font-sans text-[10px] text-[#aba2dc]" data-testid="synthetic-phase-gate-historical">Avaliação histórica desta versão: existe uma avaliação mais recente na lista.</p>
                : <p className="font-sans text-[10px] text-[#79738a]">Retrato imutável da versão e das evidências existentes no instante acima.</p>}
          </div>
        ) : null}
      </header>
      <div className="space-y-4 p-4">
        {CRITERIA.map((criterion) => (
          <article data-criterion={criterion.code} key={criterion.code}>
            <div className="flex items-center justify-between gap-2"><h3 className="text-[10px] font-semibold text-[#c2bdcf]">{criterion.title}</h3><span className="font-mono text-[8px] text-[#656071]">{criterion.code}</span></div>
            <ul className="mt-2 space-y-2">
              {criterion.checks.map(([code, label]) => {
                const check = checksByCode.get(code)
                const missing = !check || check.missingEvidenceTypes.length > 0
                const status = missing ? 'missing' : check.passed ? 'passed' : 'failed'
                return (
                  <li className="rounded-lg border border-white/[0.06] bg-black/10 p-2.5" data-check-code={code} data-check-status={status} key={code}>
                    <div className="flex items-start gap-2"><span aria-hidden className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${status === 'passed' ? 'bg-[#63ba84]' : status === 'failed' ? 'bg-[#d16d68]' : 'bg-[#5b5662]'}`} /><div className="min-w-0"><p className="text-[10px] leading-4 text-[#a9a3b3]">{label}</p><p className="mt-0.5 text-[8px] uppercase tracking-[0.12em] text-[#656071]">{status === 'passed' ? 'Comprovado' : status === 'failed' ? 'Reprovado' : 'Evidência ausente'}</p></div></div>
                    {check?.missingEvidenceTypes.length ? <p className="mt-2 text-[8px] text-[#746e7d]">Falta: {check.missingEvidenceTypes.join(', ')}</p> : null}
                    {check?.references.length ? <ul className="mt-2 space-y-1 border-t border-white/[0.05] pt-2">{check.references.map((reference) => {
                      const address = addressSyntheticPhaseGateReference({ gateProjectId: props.projectId, reference, publishedCapabilityIds })
                      const content = <><span>{reference.type}</span> <span className="font-mono text-[#696374]" title={reference.hash}>{reference.id} · {shortHash(reference.hash)}</span></>
                      return <li className="truncate text-[8px] text-[#858090]" key={`${reference.type}:${reference.id}:${reference.hash}`}>{address ? <a className="underline decoration-white/20 underline-offset-2 hover:text-[#bdb6cb]" href={address.href}>{content}</a> : content}</li>
                    })}</ul> : null}
                  </li>
                )
              })}
            </ul>
          </article>
        ))}
        <div>
          <button className="w-full rounded-lg border border-[#8f86e8]/30 bg-[#8f86e8]/10 px-3 py-2.5 text-xs font-semibold text-[#b5aef4] transition hover:bg-[#8f86e8]/15 disabled:cursor-not-allowed disabled:opacity-45" data-testid="synthetic-phase-gate-run" disabled={running || state === 'loading'} onClick={() => { void run() }} type="button">{running ? 'Avaliando evidências…' : 'Avaliar versão atual'}</button>
          <p className="mt-2 text-[9px] leading-4 text-[#77728a]" data-testid="synthetic-phase-gate-run-note">{`Avalia a versão atual do editor (${props.projectVersionId}), independentemente da avaliação selecionada.`}</p>
        </div>
      </div>
    </section>
  )
}
