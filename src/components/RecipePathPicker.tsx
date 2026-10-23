import {
  edgeBetween,
  type PathPicks,
  type PickRole,
  type ProofChoice,
} from '@/v2/ui/compatibility-context'

export interface PickerNode { id: string; takeId: string; role: PickRole; durationMs: number }
export interface PickerTake { id: string; spokenText: string; assignment: { label: string } }
export interface PickerGraph {
  nodes: readonly PickerNode[]
  edges: readonly { fromNodeId: string; toNodeId: string; decision: 'accepted' | 'borderline' | 'blocked'; notEvaluable?: readonly unknown[] }[]
}

const ROLE_LABELS: Readonly<Record<PickRole, string>> = Object.freeze({ hook: 'Abertura (hook)', body: 'Corpo', proof: 'Prova', cta: 'Chamada final (CTA)' })
const VERDICT_TEXT = {
  accepted: 'a ligação com o take anterior foi aceita',
  borderline: 'a ligação com o take anterior ficou no limite: o servidor só aceita ligações aceitas',
  blocked: 'a ligação com o take anterior foi bloqueada',
  absent: 'não existe ligação calculada com o take anterior',
} as const

function snippet(text: string): string {
  const clean = text.replace(/\s+/gu, ' ').trim()
  return clean.length > 70 ? `${clean.slice(0, 67)}…` : clean
}

/**
 * ADR-160 F8. The owner builds the path of a recipe: which take opens, which carries the body, whether there is a proof and which closes. The
 * Apollo does not pick "the best accepted path" for them. Beside each pick it says what the map computed between it and the previous take; the
 * server refuses a path whose links are not accepted.
 */
export default function RecipePathPicker({
  idPrefix,
  graph,
  takes,
  picks,
  proof,
  onPick,
  onProof,
}: {
  idPrefix: string
  graph: Readonly<PickerGraph>
  takes: readonly Readonly<PickerTake>[]
  picks: Readonly<PathPicks>
  proof: ProofChoice
  onPick: (role: PickRole, nodeId: string) => void
  onProof: (choice: ProofChoice) => void
}) {
  const takeById = new Map(takes.map((take) => [take.id, take]))
  const roles: PickRole[] = proof === 'with-proof' ? ['hook', 'body', 'proof', 'cta'] : ['hook', 'body', 'cta']
  return (
    <fieldset className="mt-4 rounded-xl border border-white/[0.07] bg-[#0a0a0a] p-4" data-testid="recipe-path-picker">
      <legend className="px-1 text-xs font-semibold text-[#c8c2b8]">Escolha o caminho da receita</legend>
      <p className="text-[10px] leading-4 text-[#746f67]">Você decide a ordem. O Apollo mostra o que o mapa calculou entre um take e o seguinte.</p>
      <div className="mt-3">
        <label className="block text-[10px] font-semibold text-[#aaa49a]" htmlFor={`${idPrefix}-proof`}>Esta receita leva prova?</label>
        <select className="mt-1 h-9 w-full max-w-xs rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-[#d1cbc1] outline-hidden focus:border-[#c09a5a]/45" data-testid="recipe-proof-choice" id={`${idPrefix}-proof`} onChange={(event) => onProof(event.target.value as ProofChoice)} value={proof}>
          <option value="">Escolha</option>
          <option value="with-proof">Sim, com um take de prova</option>
          <option value="without-proof">Não, sem prova</option>
        </select>
      </div>
      {proof === '' ? (
        <p className="mt-3 text-[10px] text-[#c79b42]" role="status">Diga se a receita leva prova para escolher os takes.</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {roles.map((role, index) => {
            const options = graph.nodes.filter((node) => node.role === role)
            const previousRole = roles[index - 1]
            const previous = previousRole ? picks[previousRole] : ''
            const current = picks[role]
            const link = previous && current ? edgeBetween(graph, previous, current) : null
            const selectId = `${idPrefix}-${role}`
            return (
              <li key={role}>
                <label className="block text-[10px] font-semibold text-[#aaa49a]" htmlFor={selectId}>{ROLE_LABELS[role]}</label>
                <select className="mt-1 h-9 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-[#d1cbc1] outline-hidden focus:border-[#c09a5a]/45" data-testid={`recipe-pick-${role}`} id={selectId} onChange={(event) => onPick(role, event.target.value)} value={current}>
                  <option value="">{options.length === 0 ? 'Nenhum take disponível' : 'Escolha um take'}</option>
                  {options.map((node) => {
                    const take = takeById.get(node.takeId)
                    return <option key={node.id} value={node.id}>{take ? snippet(take.spokenText) || take.assignment.label : node.takeId} · {(node.durationMs / 1000).toFixed(1)} s</option>
                  })}
                </select>
                {link ? (
                  <p className={`mt-1 text-[9px] leading-4 ${link.verdict === 'accepted' ? 'text-[#76b38a]' : 'text-[#c79b42]'}`} data-testid={`recipe-link-${role}`}>
                    {VERDICT_TEXT[link.verdict]}
                    {link.notEvaluable ? '; algumas conferências não puderam ser feitas por falta de informação' : ''}.
                  </p>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
    </fieldset>
  )
}
