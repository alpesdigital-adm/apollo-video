'use client'

import { useRef, useState } from 'react'

import { CUT_CONFIRMATION_TEXTS, type CutProposal } from '@/v2/ui/editorial-request-view'
import { speechCandidateLine } from '@/v2/domain/editorial-request-texts'

/**
 * ADR-160. The Apollo found, in the speech, what the request asks to take out, and shows exactly which stretches would go (time and words). The button is the
 * owner's confirmation: it sends the subject, never the words of the cut, and the Apollo cuts what it showed.
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
  const keys = useRef(new Map<string, string>())

  async function confirm(proposal: CutProposal) {
    setBusy(proposal.subject)
    setError(null)
    try {
      const fingerprint = JSON.stringify([baseVersionId, baseHash, variantId, proposal.sourceTranscriptId, proposal.subject])
      if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, globalThis.crypto.randomUUID())
      const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/speech-removals`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': keys.current.get(fingerprint)! },
        body: JSON.stringify({ baseVersionId, baseHash, sourceTranscriptId: proposal.sourceTranscriptId, variantId, subject: proposal.subject }),
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
          <ul className="mt-2 space-y-1">
            {proposal.matches.map((match) => (
              <li className="text-xs leading-5 text-[#b5afa5]" key={`${match.startSeconds}-${match.endSeconds}`}>{speechCandidateLine(match.startSeconds, match.endSeconds, match.text)}</li>
            ))}
          </ul>
          <button
            className="mt-3 h-10 rounded-xl bg-[#e0af37] px-4 text-xs font-bold text-[#171207] hover:bg-[#edc34f] disabled:cursor-not-allowed disabled:opacity-45"
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
