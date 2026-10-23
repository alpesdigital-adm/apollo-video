'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import BriefingGuidance from '@/components/BriefingGuidance'
import {
  BRIEFING_FIELD_LABEL,
  BRIEFING_MAX_LENGTH,
  BRIEFING_REQUIRED_MESSAGE,
  normalizeBriefingInput,
} from '@/v2/ui/briefing-guidance'
import {
  ANSWER_MAX_LENGTH,
  COVERAGE_LABELS,
  UNSUPPORTED_REASON_LABELS,
  buildAnswersBody,
  describeChoice,
  describeDirective,
  describeRequestBlock,
  describeRequestFailure,
  type EditorialRequestData,
} from '@/v2/ui/editorial-request-view'

/**
 * ADR-160 F7. How the Apollo read the briefing of a project, and the only way to act on it: answer the questions it left open, or
 * change the briefing so it is read again. Everything comes from `GET/POST /v1/projects/{id}/editorial-request`; nothing here decides
 * for the owner, and a question left open is shown as what it is: the Director stays blocked until it is answered.
 */

type CurrentRequest = EditorialRequestData & { version: { id: string; baseHash: string } }
interface Envelope<T> { data?: T; error?: { code?: string; message?: string; requestId?: string; details?: { reason?: string } } }

export default function EditorialRequestPanel({
  projectId,
  readWhenUnread = false,
  answersNeedOutput = false,
  onChanged,
}: {
  projectId: string
  /** Read the briefing right away when nobody has read it yet. */
  readWhenUnread?: boolean
  /** A project with no output cannot have its questions answered yet (a revision is made on a Version that has one): they are shown and the way to answer is said. */
  answersNeedOutput?: boolean
  onChanged?: (data: Readonly<EditorialRequestData>) => void
}) {
  const router = useRouter()
  const [current, setCurrent] = useState<CurrentRequest | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<null | 'reading' | 'answering' | 'saving'>(null)
  const [error, setError] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const idempotency = useRef<{ fingerprint: string; key: string } | null>(null)
  const autoRead = useRef(false)

  const keyFor = useCallback((fingerprint: string) => {
    if (idempotency.current?.fingerprint !== fingerprint) idempotency.current = { fingerprint, key: globalThis.crypto.randomUUID() }
    return idempotency.current.key
  }, [])

  const load = useCallback(async (): Promise<CurrentRequest | null> => {
    setError(null)
    try {
      const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/editorial-request`, { cache: 'no-store', headers: { accept: 'application/json' } })
      if (response.status === 401) { router.replace('/login'); return null }
      const payload = await response.json().catch(() => null) as Envelope<CurrentRequest> | null
      if (!response.ok || !payload?.data) throw new Error(describeRequestFailure(response.status, payload).message)
      setCurrent(payload.data)
      return payload.data
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível ler o pedido do vídeo.')
      return null
    } finally {
      setLoading(false)
    }
  }, [projectId, router])

  const revise = useCallback(async (base: CurrentRequest, body: Record<string, unknown>, activity: 'reading' | 'answering' | 'saving') => {
    setBusy(activity)
    setError(null)
    try {
      const fingerprint = JSON.stringify([base.version.id, body])
      const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/editorial-request`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': keyFor(fingerprint) },
        body: JSON.stringify({ baseVersionId: base.version.id, baseHash: base.version.baseHash, ...body }),
      })
      if (response.status === 401) { router.replace('/login'); return false }
      const payload = await response.json().catch(() => null) as Envelope<unknown> | null
      if (!response.ok || !payload?.data) throw new Error(describeRequestFailure(response.status, payload).message)
      const next = await load()
      if (next) onChanged?.(next)
      return true
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Não foi possível salvar o pedido do vídeo.'
      // The request is read again (another session may have changed it), and the reason it failed stays on the screen.
      await load()
      setError(message)
      return false
    } finally {
      setBusy(null)
    }
  }, [keyFor, load, onChanged, projectId, router])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!readWhenUnread || autoRead.current || !current || current.state !== 'awaiting-interpretation' || !current.request.briefing) return
    autoRead.current = true
    void revise(current, { briefing: current.request.briefing.text }, 'reading')
  }, [current, readWhenUnread, revise])

  if (loading) return <p className="text-xs text-[#8f897f]" role="status">Lendo o pedido deste vídeo…</p>
  if (!current) {
    return (
      <div className="rounded-xl border border-[#c76c6c]/25 bg-[#c76c6c]/[0.07] p-4" role="alert">
        <p className="text-xs leading-5 text-[#e0a0a0]">{error ?? 'Não foi possível ler o pedido do vídeo.'}</p>
        <button className="mt-3 h-9 rounded-lg border border-white/[0.12] px-3 text-xs text-[#d1cbc1] hover:bg-white/[0.04]" onClick={() => { setLoading(true); void load() }} type="button">Tentar de novo</button>
      </div>
    )
  }

  const block = describeRequestBlock(current)
  const blocked = block.kind !== 'free' && block.kind !== 'no-briefing'
  const interpretation = current.interpretation
  const briefingText = current.request.briefing?.text ?? null
  const answersBody = buildAnswersBody(answers, current.openQuestions)
  const answered = (interpretation?.questions ?? []).filter((question) => question.status === 'answered')
  const structured = current.request.directives

  return (
    <section aria-labelledby={`request-title-${projectId}`} className="space-y-5" data-testid="editorial-request-panel">
      <div>
        <h3 className="text-sm font-semibold text-[#f1ede5]" id={`request-title-${projectId}`}>Como o Apollo leu o seu briefing</h3>
        <p className="mt-1 text-[11px] leading-5 text-[#8f897f]">Cada item abaixo mostra o trecho do briefing em que o Apollo se apoiou. O que o briefing não diz, o Apollo não inventa.</p>
      </div>

      <div
        className={`rounded-xl border px-4 py-3 text-xs leading-5 ${blocked ? 'border-[#d9a43a]/35 bg-[#d9a43a]/[0.07] text-[#e6cf93]' : 'border-[#5fbd7e]/25 bg-[#5fbd7e]/[0.06] text-[#8fd4a5]'}`}
        data-blocks-director={blocked ? 'true' : 'false'}
        data-testid="editorial-request-block"
        role="status"
      >
        {busy === 'reading' ? 'Lendo o briefing… isso pode levar alguns segundos.' : block.message}
      </div>

      {error ? <p className="rounded-xl border border-[#c76c6c]/25 bg-[#c76c6c]/[0.07] px-4 py-3 text-xs leading-5 text-[#e0a0a0]" data-testid="editorial-request-error" role="alert">{error}</p> : null}

      {block.kind === 'unread' && busy !== 'reading' ? (
        <button className="h-10 rounded-xl bg-[#e0af37] px-4 text-xs font-bold text-[#171207] transition hover:bg-[#edc34f] disabled:opacity-45" disabled={busy !== null || !current.request.briefing} onClick={() => void revise(current, { briefing: briefingText }, 'reading')} type="button">Ler o briefing agora</button>
      ) : null}

      <div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#77736c]">Seu briefing</p>
          {!editing ? <button className="text-[11px] text-[#d9ad44] underline-offset-2 hover:underline disabled:opacity-45" disabled={busy !== null} onClick={() => { setDraft(briefingText ?? ''); setDraftError(null); setEditing(true) }} type="button">{briefingText ? 'Mudar o briefing' : 'Escrever o briefing'}</button> : null}
        </div>
        {editing ? (
          <form
            className="mt-2 space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              const text = normalizeBriefingInput(draft)
              if (!text) { setDraftError(BRIEFING_REQUIRED_MESSAGE); return }
              setDraftError(null)
              void revise(current, { briefing: text }, 'saving').then((saved) => { if (saved) setEditing(false) })
            }}
          >
            <label className="block" htmlFor={`briefing-edit-${projectId}`}>
              <span className="text-xs font-semibold text-[#c8c2b8]">{BRIEFING_FIELD_LABEL}</span>
              <textarea aria-describedby={`briefing-guidance-edit-${projectId} ${draftError ? `briefing-edit-error-${projectId}` : ''}`.trim()} aria-invalid={draftError ? true : undefined} className="mt-2 min-h-28 w-full resize-y rounded-xl border border-white/[0.09] bg-[#080808] p-3 text-sm leading-6 text-[#f2eee7] outline-hidden focus:border-[#d5a535]/55" id={`briefing-edit-${projectId}`} maxLength={BRIEFING_MAX_LENGTH} onChange={(event) => setDraft(event.target.value)} required value={draft} />
            </label>
            {draftError ? <p className="text-[11px] text-[#e0a0a0]" id={`briefing-edit-error-${projectId}`} role="alert">{draftError}</p> : null}
            <BriefingGuidance id={`briefing-guidance-edit-${projectId}`} />
            <p className="text-[11px] leading-5 text-[#8f897f]">Ao salvar, o Apollo lê o texto de novo. As respostas dadas ao texto anterior não valem para o novo, e o vídeo precisa passar pelo Diretor outra vez.</p>
            <div className="flex gap-2">
              <button className="h-10 rounded-xl px-4 text-xs text-[#8b877f] hover:bg-white/[0.04] disabled:opacity-40" disabled={busy !== null} onClick={() => setEditing(false)} type="button">Cancelar</button>
              <button className="h-10 rounded-xl bg-[#e0af37] px-4 text-xs font-bold text-[#171207] hover:bg-[#edc34f] disabled:opacity-45" disabled={busy !== null} type="submit">{busy === 'saving' ? 'Salvando e lendo…' : 'Salvar e ler de novo'}</button>
            </div>
          </form>
        ) : briefingText ? (
          <blockquote className="mt-2 whitespace-pre-wrap rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-xs leading-5 text-[#b5afa5]" data-testid="editorial-request-briefing">{briefingText}</blockquote>
        ) : (
          <p className="mt-2 text-xs text-[#8f897f]">Este projeto não tem briefing escrito.</p>
        )}
      </div>

      {current.openQuestions.length > 0 ? (
        <form
          className="space-y-4 rounded-xl border border-[#d9a43a]/30 bg-[#d9a43a]/[0.04] p-4"
          data-testid="editorial-request-questions"
          onSubmit={(event) => {
            event.preventDefault()
            if (!answersBody || answersNeedOutput) return
            void revise(current, answersBody, 'answering').then((saved) => { if (saved) setAnswers({}) })
          }}
        >
          <p className="text-xs font-semibold text-[#e6cf93]">{current.openQuestions.length === 1 ? 'O Apollo precisa de uma resposta' : `O Apollo precisa de ${current.openQuestions.length} respostas`}</p>
          {current.openQuestions.map((question) => (
            <div key={question.id}>
              {question.choices ? (
                <fieldset aria-describedby={question.excerpt ? `answer-${question.id}-excerpt` : undefined} data-testid={`question-choices-${question.id}`}>
                  <legend className="text-xs leading-5 text-[#d1cbc1]">{question.question}</legend>
                  {question.excerpt ? <p className="mt-1 text-[11px] leading-4 text-[#8f897f]" id={`answer-${question.id}-excerpt`}>Trecho do briefing: “{question.excerpt}”</p> : null}
                  <div className="mt-2 grid gap-2 sm:grid-cols-2" role="radiogroup">
                    {question.choices.map((choice) => {
                      const selected = answers[question.id] === choice.id
                      return (
                        <label className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-5 transition focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#f5d77f] ${selected ? 'border-[#d5a535]/60 bg-[#d5a535]/[0.1] text-[#edc45d]' : 'border-white/[0.09] bg-[#090909] text-[#c5c0b7] hover:border-white/[0.18]'} ${answersNeedOutput ? 'cursor-not-allowed opacity-60' : ''}`} key={choice.id}>
                          <input checked={selected} className="mt-1 h-4 w-4 accent-[#dcae3a]" disabled={answersNeedOutput} name={`answer-${question.id}`} onChange={() => setAnswers((currentAnswers) => ({ ...currentAnswers, [question.id]: choice.id }))} type="radio" value={choice.id} />
                          <span>{describeChoice(choice)}</span>
                        </label>
                      )
                    })}
                  </div>
                </fieldset>
              ) : (
                <>
                  <label className="block" htmlFor={`answer-${question.id}`}>
                    <span className="text-xs leading-5 text-[#d1cbc1]">{question.question}</span>
                  </label>
                  {question.excerpt ? <p className="mt-1 text-[11px] leading-4 text-[#8f897f]">Trecho do briefing: “{question.excerpt}”</p> : null}
                  <textarea className="mt-2 min-h-16 w-full resize-y rounded-xl border border-white/[0.09] bg-[#080808] p-3 text-sm text-[#f2eee7] outline-hidden focus:border-[#d5a535]/55 disabled:opacity-60" disabled={answersNeedOutput} id={`answer-${question.id}`} maxLength={ANSWER_MAX_LENGTH} onChange={(event) => setAnswers((currentAnswers) => ({ ...currentAnswers, [question.id]: event.target.value }))} value={answers[question.id] ?? ''} />
                </>
              )}
            </div>
          ))}
          {answersNeedOutput ? (
            <p className="text-[11px] leading-5 text-[#8f897f]" data-testid="editorial-request-answers-later">Você responde estas perguntas na página do projeto, assim que ele tiver um vídeo e uma saída. O que o Apollo entendeu já está salvo.</p>
          ) : (
            <>
              <p className="text-[11px] leading-5 text-[#8f897f]">Sua resposta fica registrada como sua. Se ela mudar o que o vídeo deve fazer, mude também o briefing.</p>
              <button className="h-10 rounded-xl bg-[#e0af37] px-4 text-xs font-bold text-[#171207] hover:bg-[#edc34f] disabled:cursor-not-allowed disabled:opacity-45" disabled={busy !== null || !answersBody} type="submit">{busy === 'answering' ? 'Enviando…' : 'Enviar respostas'}</button>
            </>
          )}
        </form>
      ) : null}

      {current.unsupported.length > 0 ? (
        <div data-testid="editorial-request-unsupported">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#c99e39]">O que o Apollo não consegue fazer</p>
          <ul className="mt-2 space-y-3">
            {current.unsupported.map((item) => (
              <li className="rounded-xl border border-[#c76c6c]/20 bg-[#c76c6c]/[0.04] p-3" key={item.id}>
                <p className="text-xs leading-5 text-[#d1cbc1]">{item.summary}</p>
                {item.excerpt ? <p className="mt-1 text-[11px] leading-4 text-[#8f897f]">Trecho do briefing: “{item.excerpt}”</p> : null}
                <p className="mt-1 text-[11px] leading-4 text-[#c9908f]">{UNSUPPORTED_REASON_LABELS[item.reason]}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {interpretation && interpretation.directives.length > 0 ? (
        <div data-testid="editorial-request-directives">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#77736c]">O que o Apollo entendeu</p>
          <ul className="mt-2 space-y-2">
            {interpretation.directives.map((directive) => {
              const { label, text } = describeDirective(directive)
              return (
                <li className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3" key={directive.id}>
                  <p className="text-xs leading-5 text-[#d1cbc1]"><strong className="font-semibold text-[#e3dccd]">{label}:</strong> {text}</p>
                  {directive.excerpt ? <p className="mt-1 text-[11px] leading-4 text-[#8f897f]">Trecho do briefing: “{directive.excerpt.text}”</p> : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : interpretation ? (
        <p className="text-xs leading-5 text-[#8f897f]" data-testid="editorial-request-no-directives">O briefing não pediu nenhuma das decisões que o Apollo sabe executar. Nenhuma foi tomada por conta própria.</p>
      ) : null}

      {interpretation?.coverage && interpretation.coverage.length > 0 ? (
        <div data-testid="editorial-request-coverage">
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#77736c]">O que o briefing diz sobre</p>
          <ul className="mt-2 space-y-2">
            {interpretation.coverage.map((item) => (
              <li className="text-xs leading-5 text-[#b5afa5]" key={item.topic}><strong className="font-semibold text-[#d1cbc1]">{COVERAGE_LABELS[item.topic]}:</strong> “{item.excerpt.text}”</li>
            ))}
          </ul>
        </div>
      ) : null}

      {structured.length > 0 ? (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#77736c]">Pedidos feitos em campos próprios</p>
          <ul className="mt-2 space-y-1">
            {structured.map((directive) => {
              const { label, text } = describeDirective(directive)
              return <li className="text-xs leading-5 text-[#b5afa5]" key={directive.id}><strong className="font-semibold text-[#d1cbc1]">{label}:</strong> {text}</li>
            })}
          </ul>
        </div>
      ) : null}

      {answered.length > 0 ? (
        <div data-testid="editorial-request-answered">
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
