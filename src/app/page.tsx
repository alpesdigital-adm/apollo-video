'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { deriveDashboardProject } from '@/v2/domain/project-dashboard'
import { optimisticProjectPatch } from '@/v2/application/project-quick-actions'
import { STRATEGIC_OBJECTIVES, type StrategicObjectiveId } from '@/v2/domain/strategic-objective'
import { createProductionBrief } from '@/v2/domain/production-brief'
import LogoutButton from '@/components/LogoutButton'

interface ProjectSummary {
  id: string; name: string; format: string; stylePreset: string; status: string; error?: string | null
  objective?: string | null; locale?: string | null; ownerId?: string | null
  createdAt: string; updatedAt: string; currentVersion: number | null; reviewIssueCount: number | null; outputCount: number
  job?: { id: string; status: string; completed: number | null; total: number | null } | null
}

interface ProjectFilters { text: string; status: string; objective: string; format: string; locale: string; createdFrom: string; createdTo: string; ownerId: string }
const EMPTY_FILTERS: ProjectFilters = { text: '', status: '', objective: '', format: '', locale: '', createdFrom: '', createdTo: '', ownerId: '' }
const FILTER_KEYS = Object.keys(EMPTY_FILTERS) as (keyof ProjectFilters)[]
const DESTINATION_REQUIRED = new Set<StrategicObjectiveId>(['lead-generation', 'sale', 'whatsapp', 'booking', 'download'])

const STATE_LABELS = { draft: 'Rascunho', processing: 'Em produção', 'awaiting-review': 'Aguardando revisão', failed: 'Precisa de atenção', completed: 'Concluído', archived: 'Arquivado' } as const

export default function Dashboard() {
  const router = useRouter()
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [filters, setFilters] = useState<ProjectFilters>(EMPTY_FILTERS)
  const [filtersReady, setFiltersReady] = useState(false)
  const [actionProjectId, setActionProjectId] = useState<string | null>(null)
  const [objective, setObjective] = useState<StrategicObjectiveId>('discovery')
  const [outputFormat, setOutputFormat] = useState('9:16')
  const [destination, setDestination] = useState('')
  const [briefing, setBriefing] = useState('')
  const [isNavigating, startNavigation] = useTransition()

  async function loadProjects(signal?: AbortSignal) {
    const response = await fetch('/api/projects', { signal })
    if (!response.ok) throw new Error('Não foi possível carregar os projetos.')
    const data = await response.json()
    setProjects(data.projects ?? [])
  }

  useEffect(() => {
    const controller = new AbortController()
    loadProjects(controller.signal).catch((error) => { if (error.name !== 'AbortError') setMessage(error.message) }).finally(() => setLoading(false))
    const refresh = () => loadProjects().catch(() => setMessage('Um projeto mudou, mas a atualização falhou. Recarregue a página.'))
    window.addEventListener('apollo:project-updated', refresh)
    return () => { controller.abort(); window.removeEventListener('apollo:project-updated', refresh) }
  }, [])

  useEffect(() => {
    const saved = sessionStorage.getItem('apollo:project-filters')
    let stored: Partial<ProjectFilters> = {}
    try { stored = saved ? JSON.parse(saved) as Partial<ProjectFilters> : {} } catch { sessionStorage.removeItem('apollo:project-filters') }
    const params = new URLSearchParams(window.location.search)
    setFilters(Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) ?? stored[key] ?? ''])) as unknown as ProjectFilters)
    setFiltersReady(true)
  }, [])

  useEffect(() => {
    if (!filtersReady) return
    sessionStorage.setItem('apollo:project-filters', JSON.stringify(filters))
    const params = new URLSearchParams()
    for (const key of FILTER_KEYS) if (filters[key]) params.set(key, filters[key])
    window.history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}`)
  }, [filters, filtersReady])

  async function upload(file: File) {
    if (!file.type.startsWith('video/')) { setMessage('Escolha um arquivo de vídeo válido.'); return }
    setUploading(true); setMessage('Enviando e preparando o vídeo…')
    try {
      const body = new FormData(); body.append('file', file); body.append('objective', objective); body.append('format', outputFormat); if (destination.trim()) body.append('destination', destination.trim()); if (briefing.trim()) body.append('briefing', briefing.trim())
      const response = await fetch('/api/upload', { method: 'POST', body })
      const data = await response.json()
      if (!response.ok || !data.projectId) throw new Error(data.error ?? 'O upload não foi concluído.')
      startNavigation(() => router.push(`/project/${data.projectId}`))
    } catch (error) { setMessage(error instanceof Error ? error.message : 'O upload não foi concluído.') }
    finally { setUploading(false) }
  }

  async function runQuickAction(project: ProjectSummary, action: 'duplicate' | 'rename' | 'archive' | 'restore') {
    let name: string | undefined
    if (action === 'rename') {
      const answer = window.prompt('Novo nome do projeto', project.name)
      if (answer === null) return
      name = answer.trim()
      if (!name) { setMessage('O nome do projeto não pode ficar vazio.'); return }
    }
    if (action === 'archive' && !window.confirm(`Arquivar “${project.name}”? O projeto poderá ser restaurado depois.`)) return
    const patch = action === 'rename' ? { name } : action === 'archive' ? { status: 'archived' } : action === 'restore' ? { status: 'created' } : null
    const optimistic = patch ? optimisticProjectPatch(projects, project.id, patch) : null
    if (optimistic) setProjects([...optimistic.next])
    setActionProjectId(project.id); setMessage(null)
    try {
      const response = await fetch(action === 'duplicate' ? `/api/projects/${project.id}/duplicate` : `/api/projects/${project.id}`, {
        method: action === 'duplicate' ? 'POST' : 'PATCH',
        headers: action === 'duplicate' ? undefined : { 'content-type': 'application/json' },
        ...(action === 'duplicate' ? {} : { body: JSON.stringify({ action, ...(name ? { name } : {}) }) }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? 'A ação não foi concluída.')
      await loadProjects()
      setMessage(action === 'duplicate' ? 'Cópia criada sem duplicar os arquivos de origem.' : 'Projeto atualizado.')
    } catch (error) {
      if (optimistic) setProjects([...optimistic.rollback()])
      setMessage(error instanceof Error ? error.message : 'A ação não foi concluída.')
    } finally { setActionProjectId(null) }
  }

  const normalizedText = filters.text.trim().toLocaleLowerCase('pt-BR')
  const briefPreview = createProductionBrief({ ownerText: briefing })
  const visibleProjects = projects.filter((project) => {
    if (normalizedText && !project.name.toLocaleLowerCase('pt-BR').includes(normalizedText)) return false
    if (filters.status && deriveDashboardProject({ status: project.status }).state !== filters.status) return false
    if (filters.objective && project.objective !== filters.objective) return false
    if (filters.format && project.format !== filters.format) return false
    if (filters.locale && project.locale !== filters.locale) return false
    if (filters.ownerId && project.ownerId !== filters.ownerId) return false
    const created = Date.parse(project.createdAt)
    if (filters.createdFrom && created < Date.parse(`${filters.createdFrom}T00:00:00`)) return false
    if (filters.createdTo && created > Date.parse(`${filters.createdTo}T23:59:59.999`)) return false
    return true
  })

  const counts = visibleProjects.reduce((result, project) => {
    const state = deriveDashboardProject({ status: project.status }).state
    result[state] = (result[state] ?? 0) + 1
    return result
  }, {} as Record<string, number>)

  return (
    <main className="min-h-screen bg-[#08090d] text-[#f4f5f7]">
      <header className="border-b border-white/10 bg-[#08090d]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-6 py-5 lg:px-10">
          <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#7167ff] font-black text-white">A</div><div><p className="text-[11px] uppercase tracking-[0.24em] text-[#8f93a3]">Apollo studio</p><h1 className="text-lg font-semibold">Central de produções</h1></div></div>
          <nav className="flex items-center gap-2 text-sm"><a className="rounded-lg px-3 py-2 text-[#b9bdc9] hover:bg-white/5 hover:text-white" href="/assets">Biblioteca</a><a className="rounded-lg px-3 py-2 text-[#b9bdc9] hover:bg-white/5 hover:text-white" href="/settings">Workspace</a><LogoutButton /></nav>
        </div>
      </header>

      <div className="mx-auto max-w-[1440px] px-6 py-8 lg:px-10 lg:py-10">
        <section className="grid gap-6 border-b border-white/10 pb-8 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-end xl:grid-cols-[minmax(0,1fr)_420px]">
          <div><p className="mb-3 text-xs font-medium uppercase tracking-[0.22em] text-[#7f86ff]">Fila editorial</p><h2 className="max-w-3xl text-4xl font-semibold leading-[1.04] tracking-[-0.04em] md:text-6xl">Do bruto ao anúncio,<br/><span className="text-[#9da2b4]">sem perder o fio.</span></h2><p className="mt-5 max-w-2xl text-base leading-7 text-[#9da2b4]">Acompanhe decisões do diretor, revisões e saídas finais. O progresso só aparece quando existe medição real.</p></div>
          <div className="rounded-2xl border border-[#7167ff]/40 bg-[#7167ff]/8 p-4">
            <label className="block text-[11px] uppercase tracking-[0.16em] text-[#aaaee0]">Objetivo desta produção<select className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-[#0b0c12] px-3 text-sm normal-case tracking-normal text-white outline-none focus:border-[#7167ff]" value={objective} onChange={(event) => setObjective(event.target.value as StrategicObjectiveId)}>{STRATEGIC_OBJECTIVES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
            <p className="mt-2 min-h-10 text-xs leading-5 text-[#999ec0]">{STRATEGIC_OBJECTIVES.find((item) => item.id === objective)?.description}</p>
            {DESTINATION_REQUIRED.has(objective) ? <label className="mt-2 block text-[11px] text-[#aaaee0]">Destino da ação<input className="mt-1 h-10 w-full rounded-lg border border-white/10 bg-[#0b0c12] px-3 text-sm text-white outline-none placeholder:text-[#62677a] focus:border-[#7167ff]" placeholder={objective === 'whatsapp' ? '+55…' : objective === 'booking' ? 'Link ou agenda' : objective === 'download' ? 'Material ou arquivo' : 'https://…'} value={destination} onChange={(event) => setDestination(event.target.value)}/></label> : null}
            <fieldset className="mt-3"><legend className="text-[11px] uppercase tracking-[0.14em] text-[#aaaee0]">Formato de saída</legend><div className="mt-2 grid grid-cols-5 gap-1" aria-label="Formato do vídeo">{['9:16','16:9','4:5','1:1','21:9'].map((value) => <button key={value} type="button" onClick={() => setOutputFormat(value)} aria-pressed={outputFormat === value} className={`rounded-lg border px-1 py-2 text-xs transition ${outputFormat === value ? 'border-[#8b84ff] bg-[#7167ff] text-white' : 'border-white/10 bg-[#0b0c12] text-[#9ca1b4] hover:border-white/25'}`}>{value}</button>)}</div><p className="mt-1.5 text-[11px] text-[#777d8e]">O vídeo bruto não limita o formato final.</p></fieldset>
            <label className="mt-3 block text-[11px] uppercase tracking-[0.14em] text-[#aaaee0]">Briefing <span className="normal-case tracking-normal text-[#777d8e]">(opcional)</span><textarea className="mt-2 min-h-24 w-full resize-y rounded-lg border border-white/10 bg-[#0b0c12] p-3 text-sm normal-case tracking-normal text-white outline-none placeholder:text-[#62677a] focus:border-[#7167ff]" maxLength={10000} placeholder="Público, oferta, tom, limites, referências e o que o Diretor deve evitar…" value={briefing} onChange={(event) => setBriefing(event.target.value)}/></label>
            {briefing.trim() ? <div className="mt-2 rounded-lg bg-black/20 p-2 text-[11px] leading-4 text-[#999ec0]"><span className="text-white/80">Entendido pelo Diretor:</span> {briefPreview.summary.text}</div> : null}
            <label className="group mt-3 flex cursor-pointer items-center justify-between rounded-xl bg-[#7167ff] px-4 py-3 transition hover:bg-[#8178ff] focus-within:ring-2 focus-within:ring-white/70">
              <input className="sr-only" type="file" accept="video/*" disabled={uploading || isNavigating || (DESTINATION_REQUIRED.has(objective) && !destination.trim())} onChange={(event) => { const file = event.target.files?.[0]; if (file) upload(file) }} />
              <span><span className="block font-semibold">Nova produção</span><span className="block text-xs text-white/75">Envie o primeiro vídeo bruto</span></span><span className="text-2xl">+</span>
            </label>
          </div>
        </section>

        <section aria-label="Resumo dos projetos" className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-4 lg:grid-cols-6 my-8">
          {(['processing','awaiting-review','failed','completed'] as const).map((state) => <div className="bg-[#0d0f15] px-5 py-4" key={state}><p className="text-2xl font-semibold tabular-nums">{counts[state] ?? 0}</p><p className="mt-1 text-xs text-[#8e93a3]">{STATE_LABELS[state]}</p></div>)}
          <div className="col-span-2 bg-[#0d0f15] px-5 py-4"><p className="text-sm font-medium">{message ?? (uploading ? 'Preparando vídeo…' : 'Sistema pronto')}</p><p className="mt-1 text-xs text-[#8e93a3]">Atualizações entram por evento, sem percentual estimado.</p></div>
        </section>

        <section><div className="mb-5 flex items-end justify-between"><div><p className="text-xs uppercase tracking-[0.2em] text-[#777d8e]">Projetos</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">Em andamento e concluídos</h2></div><span className="text-sm text-[#777d8e]">{visibleProjects.length} projetos</span></div>
          <div className="mb-5 grid gap-3 rounded-2xl border border-white/10 bg-[#0d0f15] p-4 md:grid-cols-[minmax(0,1fr)_180px_140px_auto]">
            <label><span className="sr-only">Buscar projetos</span><input className="h-11 w-full rounded-xl border border-white/10 bg-[#08090d] px-4 text-sm outline-none placeholder:text-[#666b7b] focus:border-[#7167ff]" placeholder="Buscar por nome" value={filters.text} onChange={(event) => setFilters({ ...filters, text: event.target.value })}/></label>
            <label><span className="sr-only">Filtrar por status</span><select className="h-11 w-full rounded-xl border border-white/10 bg-[#08090d] px-3 text-sm text-[#c4c7d1] outline-none focus:border-[#7167ff]" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">Todos os status</option>{Object.entries(STATE_LABELS).map(([value,label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label><span className="sr-only">Filtrar por formato</span><select className="h-11 w-full rounded-xl border border-white/10 bg-[#08090d] px-3 text-sm text-[#c4c7d1] outline-none focus:border-[#7167ff]" value={filters.format} onChange={(event) => setFilters({ ...filters, format: event.target.value })}><option value="">Formatos</option>{['9:16','16:9','4:5','1:1','21:9'].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
            <button className="h-11 rounded-xl px-4 text-sm text-[#aaaee0] hover:bg-white/5 disabled:opacity-40" disabled={!FILTER_KEYS.some((key) => filters[key])} onClick={() => setFilters(EMPTY_FILTERS)}>Limpar</button>
            <details className="md:col-span-4"><summary className="cursor-pointer text-xs text-[#8e93a3]">Filtros avançados</summary><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><input aria-label="Objetivo" className="h-10 rounded-lg border border-white/10 bg-[#08090d] px-3 text-sm" placeholder="Objetivo" value={filters.objective} onChange={(event) => setFilters({ ...filters, objective: event.target.value })}/><input aria-label="Idioma" className="h-10 rounded-lg border border-white/10 bg-[#08090d] px-3 text-sm" placeholder="Idioma (pt-BR)" value={filters.locale} onChange={(event) => setFilters({ ...filters, locale: event.target.value })}/><input aria-label="Responsável" className="h-10 rounded-lg border border-white/10 bg-[#08090d] px-3 text-sm" placeholder="Responsável" value={filters.ownerId} onChange={(event) => setFilters({ ...filters, ownerId: event.target.value })}/><input aria-label="Criado a partir de" type="date" className="h-10 rounded-lg border border-white/10 bg-[#08090d] px-3 text-sm" value={filters.createdFrom} onChange={(event) => setFilters({ ...filters, createdFrom: event.target.value })}/><input aria-label="Criado até" type="date" className="h-10 rounded-lg border border-white/10 bg-[#08090d] px-3 text-sm" value={filters.createdTo} onChange={(event) => setFilters({ ...filters, createdTo: event.target.value })}/></div></details>
          </div>
          {loading ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0,1,2,3,4,5].map((item) => <div className="h-64 animate-pulse rounded-2xl bg-white/5" key={item}/>)}</div> : projects.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-white/15 px-8 py-20 text-center"><p className="text-xl font-semibold">Sua primeira produção começa aqui.</p><p className="mx-auto mt-2 max-w-md text-[#9297a7]">Envie um vídeo bruto. O Apollo organiza o material e mostra o próximo passo.</p></div>
          ) : visibleProjects.length === 0 ? <div className="rounded-3xl border border-dashed border-white/15 px-8 py-16 text-center"><p className="text-lg font-semibold">Nenhum projeto corresponde aos filtros.</p><p className="mt-2 text-sm text-[#9297a7]">Ajuste ou limpe os filtros para ver outras produções.</p></div> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{visibleProjects.map((project) => {
            const view = deriveDashboardProject({ status: project.status, completed: project.job?.completed, total: project.job?.total })
            return <article className="group overflow-hidden rounded-2xl border border-white/10 bg-[#0d0f15] transition hover:-translate-y-0.5 hover:border-[#7167ff]/55" key={project.id}>
              <button className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#7167ff]" onClick={() => startNavigation(() => router.push(`/project/${project.id}`))}>
                <div className="relative aspect-[16/7] overflow-hidden bg-[radial-gradient(circle_at_25%_20%,#36306d_0%,#161827_42%,#0b0c11_100%)] p-5"><span className="rounded-md border border-white/15 bg-black/25 px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-white/80">{project.format}</span><div className="absolute inset-x-5 bottom-5 flex items-end justify-between"><span className="text-xs text-white/55">{project.stylePreset}</span><span className="text-4xl font-light text-white/20">▶</span></div></div>
                <div className="p-5"><div className="flex items-start justify-between gap-4"><div className="min-w-0"><h3 className="truncate text-lg font-semibold">{project.name}</h3><p className="mt-1 text-xs text-[#777d8e]">Atualizado {new Date(project.updatedAt).toLocaleDateString('pt-BR')}</p></div><span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] ${view.state === 'failed' ? 'bg-red-500/15 text-red-300' : view.state === 'awaiting-review' ? 'bg-amber-400/15 text-amber-200' : view.state === 'completed' ? 'bg-emerald-400/15 text-emerald-200' : 'bg-[#7167ff]/15 text-[#b9b5ff]'}`}>{STATE_LABELS[view.state]}</span></div>
                  <div className="mt-5 border-t border-white/8 pt-4">{view.progress === null ? <div className="flex items-center gap-2 text-xs text-[#8d92a2]"><span className="h-1.5 w-1.5 rounded-full bg-[#7167ff]"/>Etapa atual: {project.job?.status ?? project.status}</div> : <><div className="mb-2 flex justify-between text-xs text-[#8d92a2]"><span>Progresso medido</span><span>{view.progress}%</span></div><div className="h-1 overflow-hidden rounded-full bg-white/8"><div className="h-full bg-[#7167ff]" style={{ width: `${view.progress}%` }}/></div></>}
                    <div className="mt-4 flex items-center justify-between text-sm"><span className="text-[#a5a9b7]">{project.outputCount} saídas · {project.reviewIssueCount ?? '—'} pendências</span><span className="font-medium text-[#8e87ff]">{view.action} →</span></div>
                  </div></div>
              </button>
              <div className="flex flex-wrap items-center gap-1 border-t border-white/8 px-4 py-3 text-xs">
                <button className="rounded-lg px-2.5 py-2 text-[#c4c7d1] hover:bg-white/5" onClick={() => startNavigation(() => router.push(`/project/${project.id}`))}>{view.state === 'awaiting-review' ? 'Revisar' : 'Abrir'}</button>
                <button className="rounded-lg px-2.5 py-2 text-[#c4c7d1] hover:bg-white/5 disabled:opacity-40" disabled={actionProjectId === project.id} onClick={() => runQuickAction(project, 'duplicate')}>Duplicar</button>
                <button className="rounded-lg px-2.5 py-2 text-[#c4c7d1] hover:bg-white/5 disabled:opacity-40" disabled={actionProjectId === project.id} onClick={() => runQuickAction(project, 'rename')}>Renomear</button>
                <button className="ml-auto rounded-lg px-2.5 py-2 text-[#9da2b4] hover:bg-white/5 disabled:opacity-40" disabled={actionProjectId === project.id} onClick={() => runQuickAction(project, view.state === 'archived' ? 'restore' : 'archive')}>{view.state === 'archived' ? 'Restaurar' : 'Arquivar'}</button>
              </div>
            </article>
          })}</div>}
        </section>
      </div>
    </main>
  )
}
