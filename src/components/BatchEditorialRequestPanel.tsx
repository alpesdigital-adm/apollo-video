import {
  COVERAGE_LABELS,
  UNSUPPORTED_REASON_LABELS,
  describeDirective,
  type ViewCoverageItem,
  type ViewDirective,
  type ViewInterpretationQuestion,
  type ViewQuestion,
  type ViewUnsupported,
} from '@/v2/ui/editorial-request-view'

/** The part of `GET /v1/batches/{batchId}/editorial-request` the screen shows. */
export interface BatchEditorialRequestData {
  batch: { id: string; projectId: string; name: string }
  state: 'no-request' | 'interpreted'
  request: { briefing?: { text: string; sha256: string }; directives: readonly ViewDirective[]; requestHash: string } | null
  interpretation: null | {
    interpretationHash: string
    directives: readonly ViewDirective[]
    questions: readonly ViewInterpretationQuestion[]
    coverage?: readonly ViewCoverageItem[]
  }
  unsupported: readonly ViewUnsupported[]
  openQuestions: readonly ViewQuestion[]
}

/**
 * ADR-160 F8. The request of a batch, read-only: the briefing as written and how the Apollo read it. A batch has no Director to block and no
 * Command to revise its request, so questions the reading left open are shown as what they are, and the way to change the request is another batch.
 */
export default function BatchEditorialRequestPanel({ data, error, loading }: { data: BatchEditorialRequestData | null; error: string | null; loading: boolean }) {
  if (loading) return <p className="text-[11px] text-[#8f897f]" role="status">Lendo o pedido deste lote…</p>
  if (error) return <p className="text-[11px] leading-5 text-[#e0a0a0]" data-testid="batch-request-error" role="alert">{error}</p>
  if (!data) return null
  if (data.state === 'no-request' || !data.request) {
    return (
      <p className="text-[11px] leading-5 text-[#8f897f]" data-testid="batch-request-none">
        Este lote foi criado antes de o pedido existir. Ele não tem briefing, e o Apollo não supõe nenhum: o contexto dos takes só vale se você informar.
      </p>
    )
  }
  const interpretation = data.interpretation
  return (
    <section aria-label="Pedido do lote" className="space-y-4" data-testid="batch-request-panel">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#77736c]">Briefing do lote</p>
        <blockquote className="mt-2 whitespace-pre-wrap rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-xs leading-5 text-[#b5afa5]" data-testid="batch-request-briefing">{data.request.briefing?.text}</blockquote>
        <p className="mt-2 text-[10px] leading-4 text-[#68645d]">Para mudar o pedido de um lote, crie outro lote: este fica como foi pedido.</p>
      </div>

      {data.openQuestions.length > 0 ? (
        <div className="rounded-xl border border-[#d9a43a]/30 bg-[#d9a43a]/[0.04] p-3" data-testid="batch-request-questions">
          <p className="text-xs font-semibold text-[#e6cf93]">O Apollo ficou em dúvida sobre {data.openQuestions.length === 1 ? 'um ponto' : `${data.openQuestions.length} pontos`} do briefing</p>
          <ul className="mt-2 space-y-2">
            {data.openQuestions.map((question) => (
              <li className="text-xs leading-5 text-[#d1cbc1]" key={question.id}>
                {question.question}
                {question.excerpt ? <span className="block text-[11px] text-[#8f897f]">Trecho do briefing: “{question.excerpt}”</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {data.unsupported.length > 0 ? (
        <div data-testid="batch-request-unsupported">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#c99e39]">O que o Apollo não consegue fazer</p>
          <ul className="mt-2 space-y-2">
            {data.unsupported.map((item) => (
              <li className="rounded-xl border border-[#c76c6c]/20 bg-[#c76c6c]/[0.04] p-3" key={item.id}>
                <p className="text-xs leading-5 text-[#d1cbc1]">{item.summary}</p>
                {item.excerpt ? <p className="mt-1 text-[11px] text-[#8f897f]">Trecho do briefing: “{item.excerpt}”</p> : null}
                <p className="mt-1 text-[11px] text-[#c9908f]">{UNSUPPORTED_REASON_LABELS[item.reason]}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {interpretation && interpretation.directives.length > 0 ? (
        <div data-testid="batch-request-directives">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#77736c]">O que o Apollo entendeu</p>
          <ul className="mt-2 space-y-2">
            {interpretation.directives.map((directive) => {
              const { label, text } = describeDirective(directive)
              return (
                <li className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3" key={directive.id}>
                  <p className="text-xs leading-5 text-[#d1cbc1]"><strong className="font-semibold text-[#e3dccd]">{label}:</strong> {text}</p>
                  {directive.excerpt ? <p className="mt-1 text-[11px] text-[#8f897f]">Trecho do briefing: “{directive.excerpt.text}”</p> : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : interpretation ? (
        <p className="text-xs leading-5 text-[#8f897f]">O briefing não pediu nenhuma das decisões que o Apollo sabe executar. Nenhuma foi tomada por conta própria.</p>
      ) : null}

      {interpretation?.coverage && interpretation.coverage.length > 0 ? (
        <ul className="space-y-1" data-testid="batch-request-coverage">
          {interpretation.coverage.map((item) => (
            <li className="text-xs leading-5 text-[#b5afa5]" key={item.topic}><strong className="font-semibold text-[#d1cbc1]">{COVERAGE_LABELS[item.topic]}:</strong> “{item.excerpt.text}”</li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
