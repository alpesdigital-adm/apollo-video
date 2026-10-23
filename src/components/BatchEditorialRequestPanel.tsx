'use client'

import { useState } from 'react'

import BriefingGuidance from '@/components/BriefingGuidance'
import EditorialQuestionsForm from '@/components/EditorialQuestionsForm'
import {
  BRIEFING_FIELD_LABEL,
  BRIEFING_MAX_LENGTH,
  BRIEFING_REQUIRED_MESSAGE,
  normalizeBriefingInput,
} from '@/v2/ui/briefing-guidance'
import {
  COVERAGE_LABELS,
  COVERAGE_NOTE,
  UNACCOUNTED_NOTE,
  UNSUPPORTED_REASON_LABELS,
  buildAnswersBody,
  describeBatchGenerationBlock,
  describeDirective,
  type ViewCoverageItem,
  type ViewDirective,
  type ViewInterpretationQuestion,
  type ViewQuestion,
  type ViewUnaccounted,
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
    unaccounted?: readonly ViewUnaccounted[]
  }
  unsupported: readonly ViewUnsupported[]
  openQuestions: readonly ViewQuestion[]
  blocksGeneration: boolean
  revision: { sequence: number; createdAt: string } | null
}

/**
 * ADR-160 F8. The request of a batch: the briefing as written, how the Apollo read it, and what the owner can do with it. A question left open or
 * an item the Apollo cannot do keeps the batch from being generated, and the screen says so; the owner answers the questions or changes the
 * briefing of the batch (it is read again), and the request it replaces is kept as a revision.
 */
export default function BatchEditorialRequestPanel({
  data,
  error,
  loading,
  busy = false,
  actionError = null,
  onAnswer,
  onChangeBriefing,
}: {
  data: BatchEditorialRequestData | null
  error: string | null
  loading: boolean
  busy?: boolean
  actionError?: string | null
  /** Sends the answers; resolves true when they were saved. */
  onAnswer?: (answers: { answers: ({ questionId: string; answer: string } | { questionId: string; choiceId: string })[] }) => Promise<boolean>
  /** Sends the new briefing of the batch; resolves true when it was saved and read. */
  onChangeBriefing?: (briefing: string) => Promise<boolean>
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
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
  const block = describeBatchGenerationBlock(data)
  const answersBody = buildAnswersBody(answers, data.openQuestions)
  const answered = (interpretation?.questions ?? []).filter((question) => question.status === 'answered')
  const canAct = Boolean(onAnswer && onChangeBriefing)
  return (
    <section aria-label="Pedido do lote" className="space-y-4" data-testid="batch-request-panel">
      <div
        className={`rounded-xl border px-4 py-3 text-xs leading-5 ${block.blocked ? 'border-[#d9a43a]/35 bg-[#d9a43a]/[0.07] text-[#e6cf93]' : 'border-[#5fbd7e]/25 bg-[#5fbd7e]/[0.06] text-[#8fd4a5]'}`}
        data-blocks-generation={block.blocked ? 'true' : 'false'}
        data-testid="batch-request-block"
        role="status"
      >
        {busy ? 'Lendo o briefing… isso pode levar alguns segundos.' : block.message}
      </div>

      {actionError ? <p className="rounded-xl border border-[#c76c6c]/25 bg-[#c76c6c]/[0.07] px-4 py-3 text-xs leading-5 text-[#e0a0a0]" data-testid="batch-request-action-error" role="alert">{actionError}</p> : null}

      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#77736c]">Briefing do lote</p>
          {canAct && !editing ? (
            <button className="text-[11px] text-[#d9ad44] underline-offset-2 hover:underline disabled:opacity-45" data-testid="batch-request-change" disabled={busy} onClick={() => { setDraft(data.request?.briefing?.text ?? ''); setDraftError(null); setEditing(true) }} type="button">Mudar o briefing do lote</button>
          ) : null}
        </div>
        {editing ? (
          <form
            className="mt-2 space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              const text = normalizeBriefingInput(draft)
              if (!text) { setDraftError(BRIEFING_REQUIRED_MESSAGE); return }
              setDraftError(null)
              void onChangeBriefing?.(text).then((saved) => { if (saved) { setEditing(false); setAnswers({}) } })
            }}
          >
            <label className="block" htmlFor={`batch-briefing-edit-${data.batch.id}`}>
              <span className="text-xs font-semibold text-[#c8c2b8]">{BRIEFING_FIELD_LABEL}</span>
              <textarea aria-describedby={`batch-briefing-guidance-edit-${data.batch.id}${draftError ? ` batch-briefing-edit-error-${data.batch.id}` : ''}`} aria-invalid={draftError ? true : undefined} className="mt-2 min-h-28 w-full resize-y rounded-xl border border-white/[0.09] bg-[#080808] p-3 text-sm leading-6 text-[#f2eee7] outline-hidden focus:border-[#d5a535]/55" data-testid="batch-request-draft" id={`batch-briefing-edit-${data.batch.id}`} maxLength={BRIEFING_MAX_LENGTH} onChange={(event) => { setDraft(event.target.value); if (draftError) setDraftError(null) }} value={draft} />
            </label>
            {draftError ? <p className="text-[11px] text-[#e0a0a0]" id={`batch-briefing-edit-error-${data.batch.id}`} role="alert">{draftError}</p> : null}
            <BriefingGuidance id={`batch-briefing-guidance-edit-${data.batch.id}`} />
            <p className="text-[11px] leading-5 text-[#8f897f]">Ao salvar, o Apollo lê o texto de novo. As respostas dadas ao texto anterior não valem para o novo. O pedido anterior fica guardado.</p>
            <div className="flex gap-2">
              <button className="h-10 rounded-xl px-4 text-xs text-[#8b877f] hover:bg-white/[0.04] disabled:opacity-40" disabled={busy} onClick={() => setEditing(false)} type="button">Cancelar</button>
              <button className="h-10 rounded-xl bg-[#e0af37] px-4 text-xs font-bold text-[#171207] hover:bg-[#edc34f] disabled:opacity-45" data-testid="batch-request-save" disabled={busy} type="submit">{busy ? 'Salvando e lendo…' : 'Salvar e ler de novo'}</button>
            </div>
          </form>
        ) : (
          <blockquote className="mt-2 whitespace-pre-wrap rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-xs leading-5 text-[#b5afa5]" data-testid="batch-request-briefing">{data.request.briefing?.text}</blockquote>
        )}
        {data.revision && data.revision.sequence > 0 ? <p className="mt-2 text-[10px] leading-4 text-[#68645d]" data-testid="batch-request-revision">Este pedido já foi mudado {data.revision.sequence === 1 ? 'uma vez' : `${data.revision.sequence} vezes`}; os anteriores ficam guardados.</p> : null}
      </div>

      {data.openQuestions.length > 0 ? (
        <EditorialQuestionsForm
          answers={answers}
          disabled={!canAct || busy}
          onAnswers={(update) => setAnswers(update)}
          onSubmit={() => {
            if (!answersBody) return
            void onAnswer?.(answersBody).then((saved) => { if (saved) setAnswers({}) })
          }}
          questions={data.openQuestions}
          testId="batch-request-questions"
        >
          <p className="text-[11px] leading-5 text-[#8f897f]">Sua resposta fica registrada como sua. Se ela mudar o que o lote deve fazer, mude também o briefing do lote.</p>
          <button className="h-10 rounded-xl bg-[#e0af37] px-4 text-xs font-bold text-[#171207] hover:bg-[#edc34f] disabled:cursor-not-allowed disabled:opacity-45" data-testid="batch-request-send-answers" disabled={busy || !canAct || !answersBody} type="submit">{busy ? 'Enviando…' : 'Enviar respostas'}</button>
        </EditorialQuestionsForm>
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

      {data.request.directives.length > 0 ? (
        <div data-testid="batch-request-chosen">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#77736c]">Escolhas que você fez</p>
          <ul className="mt-2 space-y-1">
            {data.request.directives.map((directive) => {
              const { label, text } = describeDirective(directive)
              return <li className="text-xs leading-5 text-[#b5afa5]" key={directive.id}><strong className="font-semibold text-[#d1cbc1]">{label}:</strong> {text}</li>
            })}
          </ul>
        </div>
      ) : null}

      {interpretation?.coverage && interpretation.coverage.length > 0 ? (
        <div data-testid="batch-request-coverage">
          <ul className="space-y-1">
            {interpretation.coverage.map((item) => (
              <li className="text-xs leading-5 text-[#b5afa5]" key={item.topic}><strong className="font-semibold text-[#d1cbc1]">{COVERAGE_LABELS[item.topic]}:</strong> “{item.excerpt.text}”</li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-5 text-[#8f897f]">{COVERAGE_NOTE}</p>
        </div>
      ) : null}

      {interpretation?.unaccounted && interpretation.unaccounted.length > 0 ? (
        <div data-testid="batch-request-unaccounted">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#c99e39]">Frases que o Apollo não classificou</p>
          <ul className="mt-2 space-y-1">
            {interpretation.unaccounted.map((item) => (
              <li className="text-xs leading-5 text-[#b5afa5]" key={item.excerpt.start}>“{item.excerpt.text}”</li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-5 text-[#8f897f]">{UNACCOUNTED_NOTE}</p>
        </div>
      ) : null}

      {answered.length > 0 ? (
        <div data-testid="batch-request-answered">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#77736c]">Perguntas já respondidas</p>
          <ul className="mt-2 space-y-2">
            {answered.map((question) => (
              <li className="text-xs leading-5 text-[#b5afa5]" key={question.id}>{question.question}<br /><span className="text-[#d1cbc1]">Sua resposta: {question.answer}</span></li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
