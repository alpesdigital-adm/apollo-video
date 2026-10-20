import { CHIP_LABELS, timecode, type IssueChip, type ProvenanceRow } from '@/v2/ui/issue-override-view'

/**
 * W68. The chips of a proxy review and the evidence behind one of them. Presentational on purpose (no hooks, no router, no network):
 * what the operator sees is a function of the review the server persisted, and nothing in here can accept, resolve or hide an issue.
 */
export function IssueChipList({ chips, selectedKey, fps, onSelect }: {
  chips: readonly IssueChip[]
  selectedKey: string | null
  fps: number
  onSelect: (chip: IssueChip) => void
}) {
  return (
    <ul className="flex flex-wrap gap-2 px-4 py-3" data-testid="issue-chip-list">
      {chips.map((chip) => (
        <li key={chip.key}>
          <button
            aria-pressed={chip.key === selectedKey}
            className={`rounded-lg border px-2.5 py-2 text-left transition ${chip.severity === 'block' ? 'border-[#c66f68]/40 bg-[#c66f68]/10 text-[#df8a82]' : 'border-[#d5aa4e]/35 bg-[#d5aa4e]/10 text-[#e2bd69]'} ${chip.key === selectedKey ? 'ring-1 ring-white/40' : ''}`}
            data-cue-id={chip.cueId ?? ''}
            data-domain={chip.domain}
            data-issue-code={chip.code}
            data-issue-key={chip.key}
            data-severity={chip.severity}
            data-testid="issue-chip"
            onClick={() => onSelect(chip)}
            type="button"
          >
            <span className="block text-[9px] font-bold uppercase tracking-[0.12em]">{CHIP_LABELS[chip.severity]} · {chip.code}</span>
            <span className="mt-0.5 block font-mono text-[8px] opacity-80">
              {chip.range ? `quadros ${chip.range.startFrame}–${chip.range.endFrame} · ${timecode(chip.range.startFrame, fps)}` : 'sem faixa'}
              {chip.cueId ? ` · legenda ${chip.cueId}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** The evidence and provenance of one chip. Open by default, never collapsed away, and an absent list says so. */
export function IssueEvidence({ chip, rows }: { chip: IssueChip; rows: readonly ProvenanceRow[] }) {
  return (
    <details className="mt-3 rounded border border-white/[0.07] bg-white/[0.02] px-3 py-2" data-testid="issue-evidence" open>
      <summary className="cursor-pointer text-[9px] font-semibold uppercase tracking-[0.14em] text-[#8e8980]">Evidência e proveniência</summary>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_minmax(0,1fr)]">
        {rows.map((row, index) => (
          <div className="contents" key={`${row.label}:${row.value}:${index}`}>
            <dt className="text-[8px] uppercase tracking-[0.12em] text-[#625f58]">{row.label}</dt>
            <dd className="break-all font-mono text-[9px] text-[#aaa49a]" data-evidence-kind={row.kind}>{row.value}</dd>
          </div>
        ))}
      </dl>
      {chip.evidenceIds.length === 0 ? <p className="mt-2 text-[9px] text-[#716d65]">Este problema não traz identificadores de evidência além do laudo.</p> : null}
    </details>
  )
}
