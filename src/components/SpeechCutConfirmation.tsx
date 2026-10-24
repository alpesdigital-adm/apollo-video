'use client'

import { useRef, useState } from 'react'

import {
  CUT_CONFIRMATION_TEXTS,
  cutAdjustmentsOf,
  cutEndOptions,
  cutStartOptions,
  highlightMentions,
  type CutPassage,
  type CutProposal,
} from '@/v2/ui/editorial-request-view'
import { secondsInWords, speechCandidateLine } from '@/v2/domain/editorial-request-texts'

type Chosen = Readonly<Record<string, { startSeconds: number; endSeconds: number }>>

/**
 * ADR-160. The Apollo found, in the speech, what the request asks to take out, and shows exactly which PASSAGES would go: the whole text of each (the words that
 * mention the subject marked) and the time it starts and ends. A person may choose another start or end for a passage, only among the places the Apollo offers (the
 * start or end of a segment of the speech, inside the limits of the passage). The button is the owner's confirmation: it sends the subject and the passages the
 * person moved, never the words of the cut, and the Apollo cuts exactly what is shown here.
 */
export default function SpeechCutConfirmation({
  projectId,
  baseVersionId,
  baseHash,
  variantId,
  proposals,
  onConfirmed,
}: {
  projectId: string
  baseVersionId: string
  baseHash: string
  variantId: string
  proposals: readonly CutProposal[]
  onConfirmed: (message: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [chosenBySubject, setChosenBySubject] = useState<Readonly<Record<string, Chosen>>>({})
  const keys = useRef(new Map<string, string>())

  const chosenOf = (proposal: CutProposal, passage: CutPassage) =>
    chosenBySubject[proposal.subject]?.[passage.id] ?? { startSeconds: passage.startSeconds, endSeconds: passage.endSeconds }

  function choose(proposal: CutProposal, passage: CutPassage, next: Partial<{ startSeconds: number; endSeconds: number }>) {
    setChosenBySubject((current) => ({
      ...current,
      [proposal.subject]: { ...current[proposal.subject], [passage.id]: { ...chosenOf(proposal, passage), ...next } },
    }))
  }

  async function confirm(proposal: CutProposal) {
    setBusy(proposal.subject)
    setError(null)
    try {
      const adjustments = cutAdjustmentsOf(proposal.passages, chosenBySubject[proposal.subject] ?? {})
      const fingerprint = JSON.stringify([baseVersionId, baseHash, variantId, proposal.sourceTranscriptId, proposal.subject, adjustments])
      if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, globalThis.crypto.randomUUID())
      const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/speech-removals`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': keys.current.get(fingerprint)! },
        body: JSON.stringify({
          baseVersionId, baseHash, sourceTranscriptId: proposal.sourceTranscriptId, variantId, subject: proposal.subject,
          ...(adjustments.length > 0 ? { adjustments } : {}),
        }),
      })
      const payload = await response.json().catch(() => null) as { data?: unknown; error?: { message?: string } } | null
      if (!response.ok || !payload?.data) throw new Error(payload?.error?.message ?? 'Não foi possível cortar agora.')
      onConfirmed(CUT_CONFIRMATION_TEXTS.done)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível cortar agora.')
    } finally {
      setBusy(null)
    }
  }

  if (proposals.length === 0) return null
  return (
    <section className="mt-5 rounded-xl border border-[#d9a43a]/25 bg-[#d9a43a]/[0.04] p-4" data-testid="speech-cut-confirmation">
      <h3 className="text-sm font-semibold text-[#f1ede5]">{CUT_CONFIRMATION_TEXTS.title}</h3>
      <p className="mt-1 text-[11px] leading-5 text-[#8f897f]">{CUT_CONFIRMATION_TEXTS.note}</p>
      {proposals.map((proposal) => (
        <div className="mt-3" data-testid="speech-cut-proposal" key={proposal.subject}>
          <p className="text-xs font-semibold text-[#d1cbc1]">Sobre “{proposal.subject}”</p>
          {proposal.notice ? <p className="mt-1 text-[11px] leading-5 text-[#d9a43a]" data-testid="speech-cut-notice">{proposal.notice}</p> : null}
          {proposal.passages.length === 0 ? (
            <ul className="mt-2 space-y-1">
              {proposal.matches.map((match) => (
                <li className="text-xs leading-5 text-[#b5afa5]" key={`${match.startSeconds}-${match.endSeconds}`}>{speechCandidateLine(match.startSeconds, match.endSeconds, match.text)}</li>
              ))}
            </ul>
          ) : proposal.passages.map((passage, index) => {
            const chosen = chosenOf(proposal, passage)
            const moved = chosen.startSeconds !== passage.startSeconds || chosen.endSeconds !== passage.endSeconds
            const startId = `cut-start-${passage.id}`
            const endId = `cut-end-${passage.id}`
            return (
              <div className="mt-3 rounded-lg border border-white/[0.08] bg-black/20 p-3" data-testid="speech-cut-passage" key={passage.id}>
                <p className="text-[11px] font-semibold text-[#d1cbc1]">
                  {CUT_CONFIRMATION_TEXTS.passageTitle(index + 1, proposal.passages.length)}: {secondsInWords(chosen.startSeconds)} a {secondsInWords(chosen.endSeconds)}
                </p>
                <p className="mt-2 text-xs leading-6 text-[#b5afa5]" data-testid="speech-cut-passage-text">
                  {highlightMentions(passage.text, passage.mentions).map((piece, position) => (
                    piece.mention
                      ? <mark className="rounded bg-[#e0af37]/25 px-0.5 text-[#f1ede5]" key={position}>{piece.text}</mark>
                      : <span key={position}>{piece.text}</span>
                  ))}
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="block text-[10px] text-[#8f897f]" htmlFor={startId}>
                    {CUT_CONFIRMATION_TEXTS.startLabel}
                    <select
                      className="mt-1 h-11 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-[#d1cbc1] outline-hidden focus:border-[#d9a43a]/55"
                      data-testid="speech-cut-start"
                      disabled={busy !== null}
                      id={startId}
                      onChange={(event) => choose(proposal, passage, { startSeconds: Number(event.target.value) })}
                      value={chosen.startSeconds}
                    >
                      {cutStartOptions(passage).map((option) => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}
                    </select>
                  </label>
                  <label className="block text-[10px] text-[#8f897f]" htmlFor={endId}>
                    {CUT_CONFIRMATION_TEXTS.endLabel}
                    <select
                      className="mt-1 h-11 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-[#d1cbc1] outline-hidden focus:border-[#d9a43a]/55"
                      data-testid="speech-cut-end"
                      disabled={busy !== null}
                      id={endId}
                      onChange={(event) => choose(proposal, passage, { endSeconds: Number(event.target.value) })}
                      value={chosen.endSeconds}
                    >
                      {cutEndOptions(passage).map((option) => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}
                    </select>
                  </label>
                </div>
                <p className="mt-2 text-[10px] leading-4 text-[#8f897f]" data-testid="speech-cut-passage-state">{moved ? CUT_CONFIRMATION_TEXTS.moved : CUT_CONFIRMATION_TEXTS.proposed}</p>
              </div>
            )
          })}
          <button
            className="mt-3 h-11 rounded-xl bg-[#e0af37] px-4 text-xs font-bold text-[#171207] hover:bg-[#edc34f] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={busy !== null}
            onClick={() => { void confirm(proposal) }}
            type="button"
          >
            {busy === proposal.subject ? CUT_CONFIRMATION_TEXTS.working : CUT_CONFIRMATION_TEXTS.button}
          </button>
        </div>
      ))}
      {error ? <p className="mt-3 text-[11px] leading-5 text-[#e0a0a0]" role="alert">{error}</p> : null}
    </section>
  )
}
