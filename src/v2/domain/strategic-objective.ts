import { assertDomain } from './errors.ts'

export const STRATEGIC_OBJECTIVES = [
  { id: 'discovery', label: 'Descoberta', description: 'Interromper o scroll e apresentar uma ideia nova.', exampleOutcome: 'A pessoa entende por que vale continuar assistindo.', rubricId: 'awareness-discovery' },
  { id: 'awareness', label: 'Elevar consciência', description: 'Tornar visível um problema, risco ou oportunidade.', exampleOutcome: 'A pessoa reconhece o problema no próprio contexto.', rubricId: 'awareness-level' },
  { id: 'warming', label: 'Aquecimento', description: 'Construir familiaridade, confiança e desejo de avançar.', exampleOutcome: 'A pessoa passa a considerar a solução e o especialista.', rubricId: 'awareness-warming' },
  { id: 'lead-generation', label: 'Captar leads', description: 'Trocar valor por um contato ou cadastro.', exampleOutcome: 'A pessoa envia seus dados no destino configurado.', rubricId: 'conversion-lead' },
  { id: 'sale', label: 'Venda', description: 'Levar uma oferta elegível até a compra.', exampleOutcome: 'A pessoa segue para checkout ou compra.', rubricId: 'conversion-sale' },
  { id: 'whatsapp', label: 'Chamar no WhatsApp', description: 'Iniciar uma conversa com contexto suficiente.', exampleOutcome: 'A pessoa abre o WhatsApp e envia a mensagem.', rubricId: 'conversion-whatsapp' },
  { id: 'booking', label: 'Agendar', description: 'Levar a pessoa a escolher um horário.', exampleOutcome: 'A pessoa conclui um agendamento.', rubricId: 'conversion-booking' },
  { id: 'download', label: 'Baixar material', description: 'Entregar um recurso específico mediante ação clara.', exampleOutcome: 'A pessoa solicita ou baixa o material.', rubricId: 'conversion-download' },
] as const

export type StrategicObjectiveId = (typeof STRATEGIC_OBJECTIVES)[number]['id']
export type StrategicObjective = (typeof STRATEGIC_OBJECTIVES)[number]

export function resolveStrategicObjective(value: string): StrategicObjective {
  const objective = STRATEGIC_OBJECTIVES.find((candidate) => candidate.id === value)
  assertDomain(objective, 'INVALID_ARGUMENT', 'Unsupported strategic objective', { objective: value })
  return objective
}

export interface DirectorRunObjective {
  runId: string
  projectId: string
  version: number
  objective: StrategicObjectiveId
  rubricRef: string
  state: 'draft' | 'approved'
  supersedesRunId?: string
}

export function createDirectorRunObjective(input: { runId: string; projectId: string; objective: string; version?: number; state?: 'draft' | 'approved'; supersedesRunId?: string }): Readonly<DirectorRunObjective> {
  const objective = resolveStrategicObjective(input.objective)
  return Object.freeze({ runId: input.runId, projectId: input.projectId, version: input.version ?? 1, objective: objective.id, rubricRef: `${objective.rubricId}/v1`, state: input.state ?? 'draft', ...(input.supersedesRunId ? { supersedesRunId: input.supersedesRunId } : {}) })
}

export function changeDirectorRunObjective(current: DirectorRunObjective, input: { objective: string; nextRunId: string }): Readonly<DirectorRunObjective> {
  const objective = resolveStrategicObjective(input.objective)
  if (objective.id === current.objective) return current
  if (current.state === 'draft') return createDirectorRunObjective({ ...current, objective: objective.id })
  assertDomain(input.nextRunId.trim().length > 0 && input.nextRunId !== current.runId, 'INVALID_ARGUMENT', 'Approved objective changes require a new run id')
  return createDirectorRunObjective({ runId: input.nextRunId, projectId: current.projectId, objective: objective.id, version: current.version + 1, supersedesRunId: current.runId })
}
