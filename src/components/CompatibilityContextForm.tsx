import {
  type ContextField,
  type ContextStatement,
  type OwnerCompatibilityContext,
} from '@/v2/ui/compatibility-context'
import { LOCALE_NOT_INFORMED_LABEL, LOCALE_OPTIONS } from '@/v2/ui/locale-options'

const OWNER_FIELDS: readonly { field: Exclude<ContextField, 'tone'>; owner: keyof OwnerCompatibilityContext; help: string }[] = [
  { field: 'audience', owner: 'audience', help: 'Para quem os takes falam.' },
  { field: 'offer', owner: 'offer', help: 'O que está sendo oferecido.' },
  { field: 'persona', owner: 'persona', help: 'Quem aparece falando nos takes.' },
  { field: 'action', owner: 'action', help: 'O que o vídeo pede para a pessoa fazer.' },
  { field: 'locale', owner: 'locale', help: 'O idioma da fala dos takes.' },
]

const SOURCE_LABELS = { owner: 'informado por você', briefing: 'do briefing do lote', script: 'do roteiro', missing: 'não informado' } as const

/**
 * ADR-160 F8. What the Apollo knows about the context of the batch before it crosses the takes, and what it asks the owner. Each item says where
 * it came from (the owner, the batch briefing) or that it is missing; a missing item is not filled in: the check that needs it is not made and
 * the screen says so after the map is computed.
 */
export default function CompatibilityContextForm({
  idPrefix,
  statements,
  owner,
  onChange,
}: {
  idPrefix: string
  statements: readonly Readonly<ContextStatement>[]
  owner: Readonly<OwnerCompatibilityContext>
  onChange: (next: OwnerCompatibilityContext) => void
}) {
  const tone = statements.find((item) => item.field === 'tone')
  const missing = statements.filter((item) => item.source === 'missing' && item.field !== 'tone')
  return (
    <fieldset className="mt-4 rounded-xl border border-white/[0.07] bg-[#0a0a0a] p-4" data-testid="compatibility-context-form">
      <legend className="px-1 text-xs font-semibold text-[#c8c2b8]">O que o Apollo sabe sobre estes takes</legend>
      <p className="text-[10px] leading-4 text-[#746f67]">
        O mapa só confere o que foi informado. O que ficar em branco não é preenchido pelo Apollo: a verificação que depende dele fica de fora e o mapa avisa quais.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {OWNER_FIELDS.map(({ field, owner: key, help }) => {
          const statement = statements.find((item) => item.field === field)!
          const inputId = `${idPrefix}-${field}`
          return (
            <div key={field}>
              <label className="block text-[10px] font-semibold text-[#aaa49a]" htmlFor={inputId}>{statement.label}</label>
              {field === 'locale' ? (
                <select aria-describedby={`${inputId}-help`} className="mt-1 h-9 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-[#d1cbc1] outline-hidden focus:border-[#7895d4]/45" id={inputId} onChange={(event) => onChange({ ...owner, locale: event.target.value })} value={owner.locale}>
                  <option value="">{LOCALE_NOT_INFORMED_LABEL}</option>
                  {LOCALE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : (
                <input aria-describedby={`${inputId}-help`} className="mt-1 h-9 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-[#d1cbc1] outline-hidden focus:border-[#7895d4]/45" id={inputId} maxLength={200} onChange={(event) => onChange({ ...owner, [key]: event.target.value })} value={owner[key]} />
              )}
              <p className="mt-1 text-[9px] leading-4 text-[#68645d]" id={`${inputId}-help`}>
                {help} <span className={statement.source === 'missing' ? 'text-[#c79b42]' : 'text-[#76b38a]'} data-testid={`compatibility-context-source-${field}`}>{SOURCE_LABELS[statement.source].replace(/^./, (letter) => letter.toUpperCase())}</span>
                {statement.source === 'briefing' && statement.text ? <> — “{statement.text}”</> : null}
                {statement.source === 'script' && statement.text ? <> — {statement.text}</> : null}
              </p>
            </div>
          )
        })}
      </div>
      <p className="mt-3 text-[10px] leading-4 text-[#746f67]" data-testid="compatibility-context-tone">
        {tone?.source === 'briefing'
          ? <>Tom, energia, visual e variação: o briefing fala de tom (“{tone.text}”), mas o Apollo não transforma isso em número. Essas quatro medidas ficam de fora da nota.</>
          : <>Tom, energia, visual e variação: ninguém informou, e o Apollo não estima. Essas quatro medidas ficam de fora da nota.</>}
      </p>
      {missing.length > 0 ? (
        <p className="mt-2 text-[10px] leading-4 text-[#c79b42]" data-testid="compatibility-context-missing" role="status">
          Faltam: {missing.map((item) => item.label.toLocaleLowerCase('pt-BR')).join(', ')}. Informe acima para que essas conferências sejam feitas.
        </p>
      ) : null}
    </fieldset>
  )
}
