import {
  describeMissingContext,
  pathLinks,
  type PathLink,
  type PathPicks,
  type PickRole,
  type ProofChoice,
} from '@/v2/ui/compatibility-context'

export interface PickerNode { id: string; takeId: string; role: PickRole; durationMs: number }
export interface PickerTake { id: string; spokenText: string; assignment: { label: string } }
export interface PickerEdge {
  id: string
  fromNodeId: string
  toNodeId: string
  decision: 'accepted' | 'borderline' | 'blocked'
  reasonCodes?: readonly string[]
  softScores?: readonly { dimension: string; score: number | null }[]
  notEvaluable?: readonly unknown[]
}
export interface PickerGraph {
  nodes: readonly PickerNode[]
  edges: readonly PickerEdge[]
}

const ROLE_LABELS: Readonly<Record<PickRole, string>> = Object.freeze({ hook: 'Abertura (hook)', body: 'Corpo', proof: 'Prova', cta: 'Chamada final (CTA)' })

function snippet(text: string): string {
  const clean = text.replace(/\s+/gu, ' ').trim()
  return clean.length > 70 ? `${clean.slice(0, 67)}…` : clean
}

function linkText(link: Readonly<PathLink>, notEvaluable: boolean): string {
  switch (link.verdict) {
    case 'accepted':
      return `A ligação com o take anterior foi aceita${notEvaluable ? '; algumas conferências não puderam ser feitas por falta de informação' : ''}.`
    case 'borderline':
      return link.needsOwner
        ? `O Apollo não decide esta ligação sozinho (${describeMissingContext(link)}). Se você acha que estes dois takes combinam, confirme abaixo.`
        : 'A ligação com o take anterior ficou no limite. Se você acha que combina, confirme abaixo.'
    case 'blocked':
      return 'A ligação com o take anterior foi bloqueada. Escolha outro take.'
    default:
      return 'Não existe ligação calculada com o take anterior.'
  }
}

/**
 * ADR-160 F8. The owner builds the path of a recipe: which take opens, which carries the body, whether there is a proof and which closes. The
 * Apollo does not pick "the best accepted path" for them. Beside each pick it says what the map computed between it and the previous take.
 * A link the map could not decide for lack of context (or left at the limit) is never taken alone and never refused alone: the owner confirms
 * it here, and the confirmation is written into the recipe. A link the map blocked cannot be confirmed.
 *
 * When the objective of the batch requires a proof, this is said before the choice, and "no proof" cannot be picked and then refused in silence.
 */
export default function RecipePathPicker({
  idPrefix,
  graph,
  takes,
  picks,
  proof,
  proofRequired,
  confirmed,
  onPick,
  onProof,
  onConfirm,
}: {
  idPrefix: string
  graph: Readonly<PickerGraph>
  takes: readonly Readonly<PickerTake>[]
  picks: Readonly<PathPicks>
  proof: ProofChoice
  /** The objective of the batch requires a proof in the recipe. */
  proofRequired: boolean
  /** The ids of the edges the owner confirmed. */
  confirmed: ReadonlySet<string>
  onPick: (role: PickRole, nodeId: string) => void
  onProof: (choice: ProofChoice) => void
  onConfirm: (edgeId: string, confirmed: boolean) => void
}) {
  const takeById = new Map(takes.map((take) => [take.id, take]))
  const roles: PickRole[] = proof === 'with-proof' ? ['hook', 'body', 'proof', 'cta'] : ['hook', 'body', 'cta']
  const links = pathLinks(picks, proof, graph)
  return (
    <fieldset className="mt-4 rounded-xl border border-white/[0.07] bg-[#0a0a0a] p-4" data-testid="recipe-path-picker">
      <legend className="px-1 text-xs font-semibold text-[#c8c2b8]">Escolha o caminho da receita</legend>
      <p className="text-[10px] leading-4 text-[#746f67]">Você decide a ordem. O Apollo mostra o que o mapa calculou entre um take e o seguinte.</p>
      <div className="mt-3">
        <label className="block text-[10px] font-semibold text-[#aaa49a]" htmlFor={`${idPrefix}-proof`}>Esta receita leva prova?</label>
        <select className="mt-1 h-9 w-full max-w-xs rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-[#d1cbc1] outline-hidden focus:border-[#c09a5a]/45" data-testid="recipe-proof-choice" id={`${idPrefix}-proof`} onChange={(event) => onProof(event.target.value as ProofChoice)} value={proof}>
          <option value="">Escolha</option>
          <option value="with-proof">Sim, com um take de prova</option>
          <option disabled={proofRequired} value="without-proof">{proofRequired ? 'Não, sem prova (este objetivo exige uma prova)' : 'Não, sem prova'}</option>
        </select>
        {proofRequired ? (
          <p className="mt-1 text-[10px] leading-4 text-[#c79b42]" data-testid="recipe-proof-required" role="status">Este objetivo exige uma prova: a receita precisa de um take de prova.</p>
        ) : null}
      </div>
      {proof === '' ? (
        <p className="mt-3 text-[10px] text-[#c79b42]" role="status">Diga se a receita leva prova para escolher os takes.</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {roles.map((role) => {
            const options = graph.nodes.filter((node) => node.role === role)
            const link = links.find((item) => item.toRole === role)
            const edge = link?.edgeId ? graph.edges.find((item) => item.id === link.edgeId) : undefined
            const selectId = `${idPrefix}-${role}`
            const canConfirm = link?.verdict === 'borderline' && link.edgeId !== null
            return (
              <li key={role}>
                <label className="block text-[10px] font-semibold text-[#aaa49a]" htmlFor={selectId}>{ROLE_LABELS[role]}</label>
                <select className="mt-1 h-9 w-full rounded-lg border border-white/[0.09] bg-[#080808] px-2 text-xs text-[#d1cbc1] outline-hidden focus:border-[#c09a5a]/45" data-testid={`recipe-pick-${role}`} id={selectId} onChange={(event) => onPick(role, event.target.value)} value={picks[role]}>
                  <option value="">{options.length === 0 ? 'Nenhum take disponível' : 'Escolha um take'}</option>
                  {options.map((node) => {
                    const take = takeById.get(node.takeId)
                    return <option key={node.id} value={node.id}>{take ? snippet(take.spokenText) || take.assignment.label : node.takeId} · {(node.durationMs / 1000).toFixed(1)} s</option>
                  })}
                </select>
                {link ? (
                  <p className={`mt-1 text-[10px] leading-4 ${link.verdict === 'accepted' ? 'text-[#76b38a]' : 'text-[#c79b42]'}`} data-testid={`recipe-link-${role}`} data-verdict={link.verdict}>
                    {linkText(link, (edge?.notEvaluable?.length ?? 0) > 0)}
                  </p>
                ) : null}
                {canConfirm ? (
                  <label className="mt-1 flex items-start gap-2 text-[10px] leading-4 text-[#d1cbc1]">
                    <input
                      checked={confirmed.has(link.edgeId!)}
                      className="mt-0.5 size-4 accent-[#c09a5a]"
                      data-testid={`recipe-confirm-${role}`}
                      onChange={(event) => onConfirm(link.edgeId!, event.target.checked)}
                      type="checkbox"
                    />
                    <span>Eu confirmo que estes dois takes combinam</span>
                  </label>
                ) : null}
              </li>
            )
          })}
        </ol>
      )}
    </fieldset>
  )
}
