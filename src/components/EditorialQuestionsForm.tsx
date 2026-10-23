'use client'

import type { ReactNode } from 'react'

import { ANSWER_MAX_LENGTH, describeChoice, type ViewQuestion } from '@/v2/ui/editorial-request-view'

/**
 * ADR-160 F7/F8. The questions the Apollo left open about a briefing, answered one by one: a question with closed answers is answered by choosing
 * one of them, any other in the owner's own words. The form only collects the answers (`answers` is the draft of each question: the id of the
 * choice, or the text); what is done with them, and whether they can be sent, is the caller's. Used by the project and by the batch.
 */
export default function EditorialQuestionsForm({
  testId,
  questions,
  answers,
  onAnswers,
  disabled = false,
  onSubmit,
  children,
}: {
  testId: string
  questions: readonly ViewQuestion[]
  answers: Readonly<Record<string, string>>
  onAnswers: (update: (current: Readonly<Record<string, string>>) => Record<string, string>) => void
  /** The answers cannot be given now (the caller says why in its own words). */
  disabled?: boolean
  onSubmit: () => void
  /** What follows the questions: the note, and the button that sends them. */
  children?: ReactNode
}) {
  return (
    <form
      className="space-y-4 rounded-xl border border-[#d9a43a]/30 bg-[#d9a43a]/[0.04] p-4"
      data-testid={testId}
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled) onSubmit()
      }}
    >
      <p className="text-xs font-semibold text-[#e6cf93]">{questions.length === 1 ? 'O Apollo precisa de uma resposta' : `O Apollo precisa de ${questions.length} respostas`}</p>
      {questions.map((question) => (
        <div key={question.id}>
          {question.choices ? (
            <fieldset aria-describedby={question.excerpt ? `answer-${question.id}-excerpt` : undefined} data-testid={`question-choices-${question.id}`}>
              <legend className="text-xs leading-5 text-[#d1cbc1]">{question.question}</legend>
              {question.excerpt ? <p className="mt-1 text-[11px] leading-4 text-[#8f897f]" id={`answer-${question.id}-excerpt`}>Trecho do briefing: “{question.excerpt}”</p> : null}
              <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-2" role="radiogroup">
                {question.choices.map((choice) => {
                  const selected = answers[question.id] === choice.id
                  return (
                    <label className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-5 transition focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#f5d77f] ${selected ? 'border-[#d5a535]/60 bg-[#d5a535]/[0.1] text-[#edc45d]' : 'border-white/[0.09] bg-[#090909] text-[#c5c0b7] hover:border-white/[0.18]'} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`} key={choice.id}>
                      <input checked={selected} className="mt-1 h-4 w-4 accent-[#dcae3a]" disabled={disabled} name={`answer-${question.id}`} onChange={() => onAnswers((currentAnswers) => ({ ...currentAnswers, [question.id]: choice.id }))} type="radio" value={choice.id} />
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
              <textarea className="mt-2 min-h-16 w-full resize-y rounded-xl border border-white/[0.09] bg-[#080808] p-3 text-sm text-[#f2eee7] outline-hidden focus:border-[#d5a535]/55 disabled:opacity-60" disabled={disabled} id={`answer-${question.id}`} maxLength={ANSWER_MAX_LENGTH} onChange={(event) => onAnswers((currentAnswers) => ({ ...currentAnswers, [question.id]: event.target.value }))} value={answers[question.id] ?? ''} />
            </>
          )}
        </div>
      ))}
      {children}
    </form>
  )
}
