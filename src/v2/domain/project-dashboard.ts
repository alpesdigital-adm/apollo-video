export type DashboardProjectState = 'processing' | 'awaiting-review' | 'failed' | 'completed' | 'archived' | 'draft'

export function deriveDashboardProject(input: { status: string; completed?: number | null; total?: number | null; archivedAt?: string | null }) {
  const state: DashboardProjectState = input.archivedAt ? 'archived' : input.status === 'error' ? 'failed' : input.status === 'complete' ? 'completed' : input.status === 'ready' ? 'awaiting-review' : ['uploading', 'normalizing', 'transcribing', 'analyzing', 'rendering'].includes(input.status) ? 'processing' : 'draft'
  const hasMeasuredProgress = Number.isInteger(input.completed) && Number.isInteger(input.total) && Number(input.total) > 0 && Number(input.completed) >= 0 && Number(input.completed) <= Number(input.total)
  const progress = hasMeasuredProgress ? Math.round((Number(input.completed) / Number(input.total)) * 100) : null
  const action = state === 'failed' ? 'Tentar novamente' : state === 'awaiting-review' ? 'Revisar edição' : state === 'completed' ? 'Abrir projeto' : state === 'processing' ? 'Acompanhar' : state === 'archived' ? 'Restaurar' : 'Continuar configuração'
  return Object.freeze({ state, progress, action })
}
