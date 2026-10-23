import {
  BRIEFING_GUIDANCE_INTRO,
  BRIEFING_GUIDANCE_TITLE,
  BRIEFING_GUIDANCE_TOPICS,
} from '@/v2/ui/briefing-guidance'

/**
 * ADR-160 F7/F8. The help that sits beside the briefing field: topics only. No sentence to copy, no example and no value (an example
 * would become a default). The field it describes points here with `aria-describedby`.
 */
export default function BriefingGuidance({ id, className = '' }: { id: string; className?: string }) {
  return (
    <section aria-labelledby={`${id}-title`} className={`rounded-xl border border-white/[0.07] bg-white/[0.025] p-4 ${className}`} data-testid="briefing-guidance" id={id}>
      <h3 className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#b58d31]" id={`${id}-title`}>{BRIEFING_GUIDANCE_TITLE}</h3>
      <p className="mt-2 text-[11px] leading-5 text-[#918c83]">{BRIEFING_GUIDANCE_INTRO}</p>
      <ul className="mt-3 space-y-2 text-[11px] leading-4 text-[#a49e94]">
        {BRIEFING_GUIDANCE_TOPICS.map((topic) => (
          <li className="flex gap-2" key={topic.id}>
            <span aria-hidden="true" className="text-[#c99e39]">•</span>
            <span><strong className="font-semibold text-[#c8c2b8]">{topic.label}</strong> — {topic.about}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
