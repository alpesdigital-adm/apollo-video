'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import {
  createLatestReadFence,
  type EditorReads,
  type ReadFailureKind,
  type ReadResult,
} from '@/app/_operator/editor-reads'
import {
  CRITIC_ACTION_LABELS,
  CRITIC_DECISION_LABELS,
  CRITIC_REPORT_IDENTITY_MISMATCH,
  CRITIC_SEVERITY_LABELS,
  CRITIC_STATUS_LABELS,
  criticLabel,
  formatBasisPoints,
  formatCriticEvaluatedAt,
  frameRangeLabel,
  matchesTransformationCriticReportReference,
  resolveMeasurementOrigin,
  viewerFailureText,
  violatedPreserveText,
  type CriticReportViewerPhase,
  type PublicCriticReport,
} from '@/v2/ui/transformation-critic-report-view'

interface ViewerFailure {
  kind: ReadFailureKind | 'identity'
  code?: string
  retryAfterMs?: number
  message: string
}

/** Identifiers shown in the technical details, each under `data-field` with its own name. */
const DETAIL_FIELDS = Object.freeze([
  'id',
  'reportHash',
  'projectId',
  'providerJobId',
  'briefId',
  'briefHash',
  'policyId',
  'policyHash',
  'sourceArtifactId',
  'sourceArtifactSha256',
  'resultArtifactId',
  'resultArtifactSha256',
  'schemaVersion',
] as const satisfies readonly (keyof PublicCriticReport)[])

const SECTION_TITLE = 'text-[8px] uppercase tracking-[0.12em] text-[#656071]'

function decisionTone(decision: string): string {
  if (decision === 'approved') return 'border-[#62b47d]/35 text-[#86cf9d]'
  if (decision === 'rejected') return 'border-[#ba6262]/35 text-[#d99a94]'
  return 'border-[#d2a647]/30 text-[#d9b765]'
}

/**
 * The transformation critic report referenced by the visible gate, read inline.
 *
 * It only reads: one GET through the page's read coordinator, issued on mount
 * and on an explicit retry. The panel mounts it under a key made of project,
 * gate and reference, so any change of those unmounts it, and unmounting is
 * the close.
 */
export default function TransformationCriticReportViewer(props: Readonly<{
  projectId: string
  reference: Readonly<{ id: string; hash: string }>
  href: string
  reads: EditorReads
  onClose: () => void
  /** Lets the panel keep its "Ver relatório" button disabled while this read is loading. */
  onPhaseChange?: (phase: CriticReportViewerPhase) => void
}>) {
  const router = useRouter()
  const [phase, setPhase] = useState<CriticReportViewerPhase>('loading')
  const [report, setReport] = useState<PublicCriticReport | null>(null)
  const [failure, setFailure] = useState<ViewerFailure | null>(null)
  const fenceRef = useRef(createLatestReadFence())
  const closedRef = useRef(false)
  const pendingRef = useRef(false)
  const referenceId = props.reference.id
  const referenceHash = props.reference.hash

  const load = useCallback(async (explicitRetry: boolean) => {
    // One read at a time: a retry clicked again while the first is out asks nothing.
    if (closedRef.current || pendingRef.current) return
    pendingRef.current = true
    const ticket = fenceRef.current.begin()
    setPhase('loading')
    setFailure(null)
    setReport(null)
    let result: ReadResult<{ report?: PublicCriticReport }>
    try {
      // A GET through the page's coordinator and session. The report is not
      // about a project version, so no versionId travels with it.
      result = await props.reads.read<{ report?: PublicCriticReport }>({
        name: 'transformation-critic-report',
        url: props.href,
      }, { explicitRetry })
    } catch (error) {
      result = {
        ok: false,
        failure: {
          kind: 'error',
          status: 0,
          message: error instanceof Error ? error.message : 'Não foi possível consultar o relatório crítico.',
        },
      }
    }
    if (!fenceRef.current.isCurrent(ticket) || closedRef.current) return
    pendingRef.current = false
    if (!result.ok) {
      if (result.failure.dropped) return
      if (result.failure.kind === 'auth') {
        router.replace('/login')
        return
      }
      setReport(null)
      setFailure({
        kind: result.failure.kind,
        ...(result.failure.code === undefined ? {} : { code: result.failure.code }),
        ...(result.failure.retryAfterMs === undefined ? {} : { retryAfterMs: result.failure.retryAfterMs }),
        message: result.failure.message,
      })
      setPhase('error')
      return
    }
    const candidate = result.data?.report
    if (
      typeof candidate !== 'object' || candidate === null ||
      !matchesTransformationCriticReportReference({
        report: candidate,
        projectId: props.projectId,
        reference: { id: referenceId, hash: referenceHash },
      })
    ) {
      // An answer about another project, id or hash is not shown, not even in part.
      setReport(null)
      setFailure({ kind: 'identity', message: CRITIC_REPORT_IDENTITY_MISMATCH })
      setPhase('error')
      return
    }
    setReport(candidate)
    setPhase('ready')
  }, [props.href, props.projectId, props.reads, referenceHash, referenceId, router])

  useEffect(() => {
    closedRef.current = false
    const fence = fenceRef.current
    void load(false)
    return () => {
      // Unmounting is the close: whatever answers after this never reaches
      // state. The flag refuses it, and a ticket no read holds retires the
      // one it carries.
      closedRef.current = true
      pendingRef.current = false
      fence.begin()
    }
  }, [load])

  const { onPhaseChange } = props
  useEffect(() => {
    onPhaseChange?.(phase)
  }, [onPhaseChange, phase])

  return (
    <div
      className="rounded-lg border border-[#8f86e8]/25 bg-black/20 p-3"
      data-reference-hash={referenceHash}
      data-reference-id={referenceId}
      data-report-hash={report?.reportHash ?? ''}
      data-report-id={report?.id ?? ''}
      data-state={phase}
      data-testid="transformation-critic-report-viewer"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-semibold text-[#c2bdcf]">Relatório crítico</h3>
        <button className="text-[9px] text-[#aaa5bd] underline decoration-white/20 underline-offset-2 hover:text-[#c2bdcf]" data-testid="transformation-critic-report-close" onClick={() => { props.onClose() }} type="button">Fechar</button>
      </div>
      <p className="mt-1 truncate font-mono text-[8px] text-[#696374]" title={referenceHash}>{referenceId}</p>
      {phase === 'loading' ? <p className="mt-2 animate-pulse text-[10px] text-[#77728a]" data-testid="transformation-critic-report-loading" role="status">Carregando relatório…</p> : null}
      {phase === 'error' && failure ? (
        <div className="mt-2 rounded-lg border border-[#ba6262]/25 bg-[#ba6262]/10 p-3 text-[10px] leading-4 text-[#d99a94]" data-failure-code={failure.code ?? ''} data-failure-kind={failure.kind} data-testid="transformation-critic-report-error" role="alert">
          <p>{viewerFailureText(failure)}</p>
          <button className="mt-2 underline underline-offset-2" data-testid="transformation-critic-report-retry" onClick={() => { void load(true) }} type="button">Tentar novamente</button>
        </div>
      ) : null}
      {phase === 'ready' && report ? <CriticReportContent report={report} /> : null}
    </div>
  )
}

function CriticReportContent({ report }: Readonly<{ report: PublicCriticReport }>) {
  const confidence = typeof report.confidenceBps === 'number' ? report.confidenceBps : null
  const intent = typeof report.intentScoreBps === 'number' ? report.intentScoreBps : null
  return (
    <div className="mt-3 space-y-3">
      <span className={`inline-block rounded-full border px-2 py-1 text-[9px] font-semibold ${decisionTone(report.decision)}`} data-decision={report.decision} data-testid="transformation-critic-report-decision">{criticLabel(CRITIC_DECISION_LABELS, report.decision)}</span>
      <p className="text-[9px] leading-4 text-[#aaa5bd]" data-action={report.action} data-testid="transformation-critic-report-action">
        <span>{`Ação sugerida: ${criticLabel(CRITIC_ACTION_LABELS, report.action)}.`}</span>{' '}
        <span className="text-[#77728a]">Registrada no relatório; nada é executado a partir daqui.</span>
      </p>
      <p className="font-mono text-[8px] text-[#6f6a7c]" data-evaluated-at={report.evaluatedAt} data-testid="transformation-critic-report-evaluated-at">{`Avaliado em ${formatCriticEvaluatedAt(report.evaluatedAt)}`}</p>
      <section data-count={report.hardGates.length} data-testid="transformation-critic-report-hard-gates">
        <h4 className={SECTION_TITLE}>Hard gates</h4>
        {report.hardGates.length > 0 ? (
          <ul className="mt-1 flex flex-wrap gap-1">
            {report.hardGates.map((dimension, index) => (
              <li className="rounded border border-[#ba6262]/30 px-1.5 py-0.5 font-mono text-[8px] text-[#d99a94]" data-dimension={dimension} data-testid="transformation-critic-report-hard-gate" key={`${index}:${dimension}`}>{dimension}</li>
            ))}
          </ul>
        ) : <p className="mt-1 text-[9px] text-[#a9a3b3]">Nenhum hard gate acionado.</p>}
        <p className="mt-1 text-[8px] leading-4 text-[#77728a]">Lista vazia não significa aprovação: vale a decisão registrada acima.</p>
      </section>
      <section>
        <h4 className={SECTION_TITLE}>Medições</h4>
        <ul className="mt-1 space-y-1.5" data-count={report.measurements.length} data-testid="transformation-critic-report-measurements">
          {report.measurements.map((measurement, index) => {
            const origin = resolveMeasurementOrigin(measurement, report.evaluators)
            return (
              <li className="rounded-lg border border-white/[0.06] bg-black/10 p-2" data-dimension={measurement.dimension} data-evaluator-id={origin.evaluatorId} data-evaluator-kind={origin.kind} data-status={measurement.status} data-testid="transformation-critic-report-measurement" key={`${index}:${measurement.dimension}`}>
                <div className="flex items-center justify-between gap-2"><span className="font-mono text-[9px] text-[#c2bdcf]">{measurement.dimension}</span><span className="text-[8px] uppercase tracking-[0.12em] text-[#656071]" data-field="status">{criticLabel(CRITIC_STATUS_LABELS, measurement.status)}</span></div>
                <p className="mt-0.5 font-mono text-[8px] text-[#a9a3b3]">score <span data-field="scoreBps">{formatBasisPoints(measurement.scoreBps)}</span> · limiar <span data-field="thresholdBps">{formatBasisPoints(measurement.thresholdBps)}</span></p>
                {measurement.note ? <p className="mt-0.5 text-[8px] leading-4 text-[#858090]" data-field="note">{measurement.note}</p> : null}
                <p className="mt-0.5 text-[8px] text-[#77728a]" data-field="frameRange">{frameRangeLabel(measurement.frameRange)}</p>
                <p className="mt-0.5 text-[8px] text-[#696374]" data-field="origin">{origin.label}</p>
              </li>
            )
          })}
        </ul>
      </section>
      {confidence !== null || intent !== null ? (
        <p className="font-mono text-[8px] text-[#a9a3b3]" data-testid="transformation-critic-report-scores">
          {confidence !== null ? <span data-field="confidenceBps">{`confiança ${formatBasisPoints(confidence)}`}</span> : null}
          {confidence !== null && intent !== null ? ' · ' : null}
          {intent !== null ? <span data-field="intentScoreBps">{`intenção ${formatBasisPoints(intent)}`}</span> : null}
        </p>
      ) : null}
      <section>
        <h4 className={SECTION_TITLE}>Issues</h4>
        <ul className="mt-1 space-y-1.5" data-count={report.issues.length} data-testid="transformation-critic-report-issues">
          {report.issues.map((issue, index) => (
            <li className="rounded-lg border border-white/[0.06] bg-black/10 p-2" data-dimension={issue.dimension} data-end-frame={issue.frameRange?.endFrame ?? ''} data-severity={issue.severity} data-start-frame={issue.frameRange?.startFrame ?? ''} data-testid="transformation-critic-report-issue" key={`${index}:${issue.dimension}`}>
              <p className="text-[9px] text-[#c2bdcf]">{`${criticLabel(CRITIC_SEVERITY_LABELS, issue.severity)} · ${issue.dimension} · ${frameRangeLabel(issue.frameRange)}`}</p>
              <p className="mt-0.5 text-[9px] leading-4 text-[#a9a3b3]" data-field="description">{issue.description}</p>
              {issue.violatedPreserve !== undefined ? <p className="mt-0.5 text-[8px] text-[#858090]">viola preservação: <code className="font-mono" data-field="violatedPreserve">{violatedPreserveText(issue.violatedPreserve)}</code></p> : null}
            </li>
          ))}
        </ul>
        {report.issues.length === 0 ? (
          <>
            <p className="mt-1 text-[9px] text-[#a9a3b3]">Nenhuma issue registrada.</p>
            <p className="mt-1 text-[8px] leading-4 text-[#77728a]">Ausência de issues não significa aprovação.</p>
          </>
        ) : null}
      </section>
      <details className="rounded-lg border border-white/[0.06] bg-black/10 p-2" data-testid="transformation-critic-report-details">
        <summary className="cursor-pointer text-[9px] text-[#aaa5bd]">Detalhes técnicos</summary>
        <dl className="mt-2 space-y-1 font-mono text-[8px] leading-4">
          {DETAIL_FIELDS.map((field) => (
            <div className="grid grid-cols-[auto_1fr] gap-2" key={field}>
              <dt className="text-[#656071]">{field}</dt>
              <dd className="break-all text-[#a9a3b3]" data-field={field}>{report[field]}</dd>
            </div>
          ))}
        </dl>
        <ul className="mt-2 space-y-1 font-mono text-[8px] leading-4 text-[#858090]" data-field="evaluators">
          {report.evaluators.map((evaluator, index) => (
            <li data-evaluator-id={evaluator.id} data-evaluator-kind={evaluator.kind} key={`${index}:${evaluator.id}`}>{`${evaluator.id} · ${evaluator.kind} · ${evaluator.version} · ${evaluator.scope}`}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}
