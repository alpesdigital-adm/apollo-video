'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import LogoutButton from '@/components/LogoutButton'
import {
  STRATEGIC_OBJECTIVES,
  type StrategicObjectiveId,
} from '@/v2/domain/strategic-objective'
import {
  OUTPUT_ASPECT_RATIOS,
  type OutputAspectRatio,
} from '@/v2/domain/output-spec'

interface ProjectSummary {
  id: string
  name: string
  status: string
  objective?: StrategicObjectiveId
  format?: OutputAspectRatio
  locale?: string
  ownerId?: string
  currentVersionId?: string
  createdAt: string
}

interface PublicApiEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string }
}

const DESTINATION_REQUIRED = new Set<StrategicObjectiveId>([
  'lead-generation',
  'sale',
  'whatsapp',
  'booking',
  'download',
])

const OBJECTIVE_GROUPS = [
  {
    label: 'Distribuição de conteúdo',
    ids: ['discovery', 'awareness', 'warming'] as StrategicObjectiveId[],
  },
  {
    label: 'Conversão',
    ids: ['lead-generation', 'sale', 'whatsapp', 'booking', 'download'] as StrategicObjectiveId[],
  },
]

const FORMAT_DETAILS: Record<OutputAspectRatio, { label: string; use: string; shape: string }> = {
  '9:16': { label: 'Vertical', use: 'Reels, Shorts, TikTok', shape: 'h-8 w-[18px]' },
  '16:9': { label: 'Horizontal', use: 'YouTube, sites', shape: 'h-[18px] w-8' },
  '4:5': { label: 'Retrato', use: 'Feed social', shape: 'h-8 w-[26px]' },
  '1:1': { label: 'Quadrado', use: 'Feed e display', shape: 'h-7 w-7' },
  '21:9': { label: 'Cinema', use: 'Telas amplas', shape: 'h-[14px] w-8' },
}

const STATUS_LABELS: Record<string, string> = {
  draft: 'Configuração',
  processing: 'Em produção',
  review: 'Em revisão',
  completed: 'Concluído',
  failed: 'Requer atenção',
}

function ApiIcon({ path, className = 'h-5 w-5' }: { path: string; className?: string }) {
  return (
    <svg aria-hidden="true" className={className} fill="none" viewBox="0 0 24 24">
      <path d={path} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </svg>
  )
}

function errorMessage(payload: PublicApiEnvelope<unknown>, fallback: string): string {
  return payload.error?.message?.trim() || fallback
}

function projectState(status: string): 'draft' | 'processing' | 'review' | 'completed' | 'failed' {
  if (status === 'completed' || status === 'complete') return 'completed'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'review' || status === 'ready' || status === 'awaiting-review') return 'review'
  if (['processing', 'ingesting', 'directing', 'rendering'].includes(status)) return 'processing'
  return 'draft'
}

export default function Dashboard() {
  const router = useRouter()
  const idempotencyKey = useRef<string | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [name, setName] = useState('')
  const [objective, setObjective] = useState<StrategicObjectiveId>('discovery')
  const [format, setFormat] = useState<OutputAspectRatio>('9:16')
  const [locale, setLocale] = useState('pt-BR')
  const [briefing, setBriefing] = useState('')
  const [destination, setDestination] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    async function loadProjects() {
      try {
        const response = await fetch('/v1/projects?limit=100', {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        })
        if (response.status === 401) {
          router.replace('/login')
          return
        }
        const payload = await response.json() as PublicApiEnvelope<{ projects: ProjectSummary[] }>
        if (!response.ok || !payload.data) {
          throw new Error(errorMessage(payload, 'Não foi possível carregar os projetos.'))
        }
        setProjects(payload.data.projects)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setNotice(error instanceof Error ? error.message : 'Não foi possível carregar os projetos.')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void loadProjects()
    return () => controller.abort()
  }, [router])

  useEffect(() => {
    if (!composerOpen) return
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !creating) setComposerOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [composerOpen, creating])

  const visibleProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('pt-BR')
    return projects.filter((project) => {
      if (normalizedQuery && !project.name.toLocaleLowerCase('pt-BR').includes(normalizedQuery)) return false
      if (statusFilter !== 'all' && projectState(project.status) !== statusFilter) return false
      return true
    })
  }, [projects, query, statusFilter])

  const counts = useMemo(() => projects.reduce((result, project) => {
    const state = projectState(project.status)
    result[state] = (result[state] ?? 0) + 1
    return result
  }, {} as Record<string, number>), [projects])

  function resetComposer() {
    setName('')
    setObjective('discovery')
    setFormat('9:16')
    setLocale('pt-BR')
    setBriefing('')
    setDestination('')
    idempotencyKey.current = null
  }

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const normalizedName = name.trim()
    const normalizedDestination = destination.trim()
    if (normalizedName.length < 2) {
      setNotice('Dê um nome com pelo menos 2 caracteres para a produção.')
      return
    }
    if (DESTINATION_REQUIRED.has(objective) && !normalizedDestination) {
      setNotice('Informe o destino da ação para este objetivo de conversão.')
      return
    }
    setCreating(true)
    setNotice(null)
    idempotencyKey.current ??= globalThis.crypto.randomUUID()
    try {
      const response = await fetch('/v1/projects', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey.current,
        },
        body: JSON.stringify({
          name: normalizedName,
          objective,
          format,
          locale,
          ...(briefing.trim() ? { briefing: briefing.trim() } : {}),
          ...(normalizedDestination ? { destination: normalizedDestination } : {}),
        }),
      })
      if (response.status === 401) {
        router.replace('/login')
        return
      }
      const payload = await response.json() as PublicApiEnvelope<{ project: ProjectSummary }>
      if (!response.ok || !payload.data) {
        throw new Error(errorMessage(payload, 'Não foi possível criar o projeto.'))
      }
      setProjects((current) => [payload.data!.project, ...current.filter((item) => item.id !== payload.data!.project.id)])
      setComposerOpen(false)
      resetComposer()
      setNotice('Projeto criado com direção e formato salvos. A mídia será vinculada na próxima etapa.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Não foi possível criar o projeto.')
    } finally {
      setCreating(false)
    }
  }

  const selectedObjective = STRATEGIC_OBJECTIVES.find((item) => item.id === objective)!
  const requiresDestination = DESTINATION_REQUIRED.has(objective)
  const hasProjects = projects.length > 0

  return (
    <main className="min-h-screen bg-[#070707] text-[#f4f1ea] selection:bg-[#eab83e]/25 selection:text-[#fff8df]">
      <div className="mx-auto flex min-h-screen max-w-[1720px]">
        <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-white/[0.07] bg-[#0a0a0a] px-5 py-6 lg:flex">
          <div className="flex items-center gap-3 px-2">
            <div className="grid h-9 w-9 place-items-center rounded-[10px] border border-[#e0af37]/35 bg-[#e0af37]/10 text-sm font-black text-[#efc75f]">A</div>
            <div>
              <p className="text-sm font-bold tracking-[0.22em] text-white">APOLLO</p>
              <p className="mt-0.5 text-[9px] uppercase tracking-[0.18em] text-[#66635c]">AI video director</p>
            </div>
          </div>

          <nav aria-label="Navegação principal" className="mt-10 space-y-1">
            <a className="flex items-center gap-3 rounded-xl border border-[#e0af37]/20 bg-[#e0af37]/10 px-3 py-2.5 text-sm font-medium text-[#f0c65c]" href="/">
              <ApiIcon path="M4 5.5A1.5 1.5 0 0 1 5.5 4h5A1.5 1.5 0 0 1 12 5.5v5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 4 10.5v-5Zm8 8A1.5 1.5 0 0 1 13.5 12h5a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5v-5Zm2-8.5h5m-2.5-2.5V7.5M4 16h5" />
              Projetos
            </a>
            <div className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-[#696762]" title="A biblioteca V2 será conectada em uma etapa posterior">
              <ApiIcon path="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-11ZM8 5V3m8 2V3M4 9h16" />
              Biblioteca
              <span className="ml-auto text-[9px] uppercase tracking-wider">em breve</span>
            </div>
            <div className="flex cursor-not-allowed items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-[#696762]" title="As configurações V2 do workspace ainda não estão conectadas">
              <ApiIcon path="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7-3.5 2-1-2-3-2.2.2L15.5 6 16 4h-4l-1 2-2.5.2L7 4 4 6l.8 2.2L3 10v4l2 1 .5 2.5L4 19l3 2 1.5-2.2L11 19l1 2h4l-.5-2.5 1.7-1.7L20 17l1-3-2-2Z" />
              Workspace
              <span className="ml-auto text-[9px] uppercase tracking-wider">em breve</span>
            </div>
          </nav>

          <div className="mt-auto rounded-2xl border border-white/[0.07] bg-white/[0.025] p-3.5">
            <div className="flex items-center gap-2 text-[11px] font-medium text-[#a5a198]">
              <span className="h-1.5 w-1.5 rounded-full bg-[#4fb97a] shadow-[0_0_8px_rgba(79,185,122,.7)]" />
              API V2 conectada
            </div>
            <p className="mt-2 text-[10px] leading-4 text-[#5f5c56]">Postgres · versões imutáveis · sessão segura</p>
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b border-white/[0.07] bg-[#070707]/90 px-5 py-4 backdrop-blur-xl sm:px-8 xl:px-12">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 lg:hidden">
                <div className="grid h-9 w-9 place-items-center rounded-[10px] border border-[#e0af37]/35 bg-[#e0af37]/10 text-sm font-black text-[#efc75f]">A</div>
                <span className="text-sm font-bold tracking-[0.2em]">APOLLO</span>
              </div>
              <div className="hidden lg:block">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[#6e6a62]">Workspace</p>
                <p className="mt-1 text-sm font-medium text-[#d7d2c8]">Alpes Digital</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="hidden items-center gap-2 rounded-xl border border-white/[0.08] bg-[#0c0c0c] px-3 py-2 text-[#77736b] sm:flex">
                  <ApiIcon className="h-4 w-4" path="m20 20-4.4-4.4m2.4-4.1a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" />
                  <input aria-label="Buscar projetos" className="w-40 bg-transparent text-sm text-[#e6e1d8] outline-none placeholder:text-[#5e5b55] xl:w-56" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar projeto" value={query} />
                </div>
                <LogoutButton />
              </div>
            </div>
          </header>

          <div className="px-5 py-8 sm:px-8 xl:px-12 xl:py-10">
            <section className="relative overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#0d0d0d] px-6 py-7 sm:px-8 sm:py-9 xl:px-10">
              <div aria-hidden="true" className="absolute -right-28 -top-36 h-80 w-80 rounded-full bg-[#d9a82f]/[0.07] blur-3xl" />
              <div className="relative flex flex-col justify-between gap-8 md:flex-row md:items-end">
                <div>
                  <div className="mb-4 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.22em] text-[#c49b39]">
                    <span className="h-px w-7 bg-[#c49b39]/70" /> Sala de produção
                  </div>
                  <h1 className="max-w-3xl text-3xl font-semibold tracking-[-0.045em] text-[#faf7f0] sm:text-4xl xl:text-[46px] xl:leading-[1.03]">
                    Um projeto começa pela direção,
                    <span className="block text-[#8e8980]">antes de começar pelo arquivo.</span>
                  </h1>
                  <p className="mt-4 max-w-2xl text-sm leading-6 text-[#817d75] sm:text-[15px]">
                    Defina objetivo, entrega e contexto. O Apollo registra essas decisões na primeira versão e só então recebe o material bruto.
                  </p>
                </div>
                <button className="group flex h-12 shrink-0 items-center justify-center gap-3 rounded-xl bg-[#e0af37] px-5 text-sm font-bold text-[#171207] shadow-[0_12px_35px_rgba(224,175,55,.16)] transition hover:-translate-y-0.5 hover:bg-[#efc34f] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f5d77f]" onClick={() => { setNotice(null); setComposerOpen(true) }} type="button">
                  <span className="text-xl font-light leading-none">＋</span>
                  Novo projeto
                  <span className="transition-transform group-hover:translate-x-0.5">→</span>
                </button>
              </div>
            </section>

            {notice ? (
              <div className="mt-5 flex items-start justify-between gap-4 rounded-xl border border-[#d6a638]/20 bg-[#d6a638]/[0.07] px-4 py-3 text-sm leading-5 text-[#d8c590]" role="status">
                <span>{notice}</span>
                <button aria-label="Fechar aviso" className="text-[#8f8059] hover:text-[#e4c878]" onClick={() => setNotice(null)} type="button">×</button>
              </div>
            ) : null}

            <section aria-label="Resumo dos projetos" className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { state: 'draft', label: 'Em configuração', accent: 'text-[#dbb551]' },
                { state: 'processing', label: 'Em produção', accent: 'text-[#739ed8]' },
                { state: 'review', label: 'Aguardando revisão', accent: 'text-[#c98bd3]' },
                { state: 'completed', label: 'Concluídos', accent: 'text-[#70b98b]' },
              ].map((item) => (
                <article className="rounded-2xl border border-white/[0.07] bg-[#0b0b0b] px-5 py-4" key={item.state}>
                  <div className="flex items-center justify-between">
                    <p className={`text-2xl font-semibold tabular-nums ${item.accent}`}>{counts[item.state] ?? 0}</p>
                    <span className={`h-1.5 w-1.5 rounded-full bg-current opacity-70 ${item.accent}`} />
                  </div>
                  <p className="mt-1 text-xs text-[#77736c]">{item.label}</p>
                </article>
              ))}
            </section>

            <section className="mt-10">
              <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#6d6962]">Projetos</p>
                  <h2 className="mt-1 text-2xl font-semibold tracking-[-0.025em] text-[#f0ece4]">Produções do workspace</h2>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-[#0c0c0c] px-3 py-2 text-[#77736b] sm:hidden">
                    <ApiIcon className="h-4 w-4" path="m20 20-4.4-4.4m2.4-4.1a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z" />
                    <input aria-label="Buscar projetos" className="min-w-0 bg-transparent text-sm text-[#e6e1d8] outline-none placeholder:text-[#5e5b55]" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar" value={query} />
                  </div>
                  <select aria-label="Filtrar por status" className="h-10 rounded-xl border border-white/[0.08] bg-[#0c0c0c] px-3 text-xs text-[#aaa59c] outline-none focus:border-[#d7a936]/50" onChange={(event) => setStatusFilter(event.target.value)} value={statusFilter}>
                    <option value="all">Todos os status</option>
                    <option value="draft">Configuração</option>
                    <option value="processing">Em produção</option>
                    <option value="review">Em revisão</option>
                    <option value="completed">Concluído</option>
                    <option value="failed">Requer atenção</option>
                  </select>
                </div>
              </div>

              {loading ? (
                <div className="mt-5 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                  {[0, 1, 2].map((item) => <div className="h-56 animate-pulse rounded-2xl border border-white/[0.05] bg-white/[0.025]" key={item} />)}
                </div>
              ) : !hasProjects ? (
                <div className="mt-5 grid min-h-72 place-items-center rounded-2xl border border-dashed border-white/[0.11] bg-[#0a0a0a] px-6 py-12 text-center">
                  <div>
                    <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[#d8a936]/20 bg-[#d8a936]/[0.06] text-[#c89d35]">
                      <ApiIcon className="h-7 w-7" path="m9 8 6 4-6 4V8Zm-5-2.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13Z" />
                    </div>
                    <h3 className="mt-5 text-lg font-semibold text-[#e8e3da]">Nenhuma produção ainda</h3>
                    <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#77736c]">Crie o projeto para registrar a direção editorial. O envio dos vídeos vem na etapa seguinte.</p>
                    <button className="mt-5 rounded-xl border border-[#d9aa38]/30 px-4 py-2.5 text-sm font-medium text-[#dab455] transition hover:bg-[#d9aa38]/10" onClick={() => setComposerOpen(true)} type="button">Criar primeiro projeto</button>
                  </div>
                </div>
              ) : visibleProjects.length === 0 ? (
                <div className="mt-5 rounded-2xl border border-dashed border-white/[0.1] px-6 py-14 text-center text-sm text-[#77736c]">Nenhum projeto corresponde a esses filtros.</div>
              ) : (
                <div className="mt-5 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                  {visibleProjects.map((project) => {
                    const state = projectState(project.status)
                    const objectiveLabel = STRATEGIC_OBJECTIVES.find((item) => item.id === project.objective)?.label ?? 'Objetivo não informado'
                    return (
                      <article className="group overflow-hidden rounded-2xl border border-white/[0.075] bg-[#0b0b0b] transition hover:-translate-y-0.5 hover:border-[#d5a533]/30" key={project.id}>
                        <div className="relative h-24 overflow-hidden border-b border-white/[0.06] bg-[linear-gradient(130deg,#15130e_0%,#0e0e0e_48%,#11100d_100%)] px-5 py-4">
                          <div aria-hidden="true" className="absolute -right-10 -top-20 h-40 w-40 rounded-full bg-[#d3a02e]/[0.08] blur-2xl" />
                          <div className="relative flex items-center justify-between">
                            <span className="rounded-md border border-white/[0.09] bg-black/20 px-2 py-1 text-[10px] font-semibold tracking-wide text-[#aaa49a]">{project.format ?? '—'}</span>
                            <span className="text-[10px] uppercase tracking-[0.16em] text-[#5f5b54]">{project.locale ?? 'pt-BR'}</span>
                          </div>
                        </div>
                        <div className="p-5">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <h3 className="truncate text-base font-semibold text-[#eee9e0]">{project.name}</h3>
                              <p className="mt-1 truncate text-xs text-[#77736c]">{objectiveLabel}</p>
                            </div>
                            <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] ${state === 'failed' ? 'border-[#d16969]/20 bg-[#d16969]/10 text-[#e08b8b]' : state === 'completed' ? 'border-[#65ad7f]/20 bg-[#65ad7f]/10 text-[#7ec397]' : state === 'review' ? 'border-[#ba7fc4]/20 bg-[#ba7fc4]/10 text-[#ca92d4]' : state === 'processing' ? 'border-[#648fc6]/20 bg-[#648fc6]/10 text-[#79a5da]' : 'border-[#c99e36]/20 bg-[#c99e36]/10 text-[#d6b257]'}`}>{STATUS_LABELS[state]}</span>
                          </div>
                          <div className="mt-5 flex items-center justify-between border-t border-white/[0.06] pt-4">
                            <p className="text-[11px] text-[#625f59]">Criado em {new Date(project.createdAt).toLocaleDateString('pt-BR')}</p>
                            <button className="cursor-not-allowed text-xs font-medium text-[#6f6858]" disabled title="O workspace V2 será conectado após o upload V2" type="button">Abrir em breve</button>
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        </section>
      </div>

      {composerOpen ? (
        <div aria-labelledby="new-project-title" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-3 backdrop-blur-sm sm:p-6" role="dialog">
          <button aria-label="Fechar criação de projeto" className="absolute inset-0 cursor-default" disabled={creating} onClick={() => setComposerOpen(false)} type="button" />
          <form className="relative max-h-[94vh] w-full max-w-[980px] overflow-y-auto rounded-[24px] border border-white/[0.1] bg-[#0d0d0d] shadow-[0_30px_100px_rgba(0,0,0,.7)]" onSubmit={createProject}>
            <div className="flex items-start justify-between border-b border-white/[0.07] px-5 py-5 sm:px-7">
              <div>
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#b89034]"><span className="h-px w-6 bg-[#b89034]" /> Direção inicial</div>
                <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-[#f4f0e8]" id="new-project-title">Criar nova produção</h2>
                <p className="mt-1 text-sm text-[#77736c]">Estas decisões entram na versão 1 e orientam todo o trabalho do Diretor.</p>
              </div>
              <button aria-label="Fechar" className="grid h-9 w-9 place-items-center rounded-lg border border-white/[0.07] text-lg text-[#77736c] transition hover:bg-white/[0.04] hover:text-white" disabled={creating} onClick={() => setComposerOpen(false)} type="button">×</button>
            </div>

            <div className="grid lg:grid-cols-[minmax(0,1fr)_310px]">
              <div className="space-y-7 px-5 py-6 sm:px-7">
                <label className="block">
                  <span className="text-xs font-semibold text-[#c8c2b8]">Nome da produção</span>
                  <input autoFocus className="mt-2 h-12 w-full rounded-xl border border-white/[0.09] bg-[#080808] px-4 text-sm text-[#f2eee7] outline-none transition placeholder:text-[#55524d] focus:border-[#d5a535]/55 focus:ring-2 focus:ring-[#d5a535]/10" maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Ex.: Campanha Imersão — descoberta" required value={name} />
                </label>

                <fieldset>
                  <legend className="text-xs font-semibold text-[#c8c2b8]">O que este vídeo precisa provocar?</legend>
                  <div className="mt-3 space-y-4">
                    {OBJECTIVE_GROUPS.map((group) => (
                      <div key={group.label}>
                        <p className="mb-2 text-[10px] uppercase tracking-[0.16em] text-[#66625b]">{group.label}</p>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {group.ids.map((id) => {
                            const item = STRATEGIC_OBJECTIVES.find((candidate) => candidate.id === id)!
                            const selected = objective === id
                            return (
                              <button aria-pressed={selected} className={`rounded-xl border px-3.5 py-3 text-left transition ${selected ? 'border-[#d5a535]/55 bg-[#d5a535]/[0.09]' : 'border-white/[0.07] bg-[#090909] hover:border-white/[0.15]'}`} key={id} onClick={() => { setObjective(id); setDestination('') }} type="button">
                                <span className={`block text-sm font-medium ${selected ? 'text-[#edc45d]' : 'text-[#c5c0b7]'}`}>{item.label}</span>
                                <span className="mt-1 block text-[11px] leading-4 text-[#69665f]">{item.description}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </fieldset>

                {requiresDestination ? (
                  <label className="block">
                    <span className="text-xs font-semibold text-[#c8c2b8]">Destino da ação</span>
                    <span className="ml-2 text-[10px] text-[#77736c]">obrigatório para {selectedObjective.label.toLocaleLowerCase('pt-BR')}</span>
                    <input className="mt-2 h-12 w-full rounded-xl border border-white/[0.09] bg-[#080808] px-4 text-sm text-[#f2eee7] outline-none transition placeholder:text-[#55524d] focus:border-[#d5a535]/55 focus:ring-2 focus:ring-[#d5a535]/10" onChange={(event) => setDestination(event.target.value)} placeholder={objective === 'whatsapp' ? 'Número, link ou instrução para WhatsApp' : objective === 'booking' ? 'Agenda ou identificador do calendário' : objective === 'download' ? 'Material ou arquivo de destino' : 'https://seu-dominio.com/...'} required value={destination} />
                    {['lead-generation', 'sale'].includes(objective) ? <span className="mt-1.5 block text-[10px] text-[#68645d]">Para links externos, use HTTPS.</span> : null}
                  </label>
                ) : null}

                <label className="block">
                  <span className="text-xs font-semibold text-[#c8c2b8]">Briefing para o Diretor</span>
                  <span className="ml-2 text-[10px] text-[#77736c]">opcional</span>
                  <textarea className="mt-2 min-h-32 w-full resize-y rounded-xl border border-white/[0.09] bg-[#080808] p-4 text-sm leading-6 text-[#f2eee7] outline-none transition placeholder:text-[#55524d] focus:border-[#d5a535]/55 focus:ring-2 focus:ring-[#d5a535]/10" maxLength={10000} onChange={(event) => setBriefing(event.target.value)} placeholder="Público, oferta, tom, restrições, referências, elementos que devem ou não aparecer..." value={briefing} />
                  <span className="mt-1.5 flex justify-between text-[10px] text-[#625f59]"><span>Se ficar vazio, o Diretor registra explicitamente as premissas ausentes.</span><span>{briefing.length}/10.000</span></span>
                </label>
              </div>

              <aside className="border-t border-white/[0.07] bg-[#0a0a0a] px-5 py-6 sm:px-7 lg:border-l lg:border-t-0">
                <fieldset>
                  <legend className="text-xs font-semibold text-[#c8c2b8]">Formato de saída</legend>
                  <p className="mt-1 text-[11px] leading-4 text-[#69665f]">O enquadramento, as legendas e as áreas seguras nascem deste canvas.</p>
                  <div className="mt-4 space-y-2">
                    {OUTPUT_ASPECT_RATIOS.map((value) => {
                      const item = FORMAT_DETAILS[value]
                      const selected = format === value
                      return (
                        <button aria-pressed={selected} className={`flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition ${selected ? 'border-[#d5a535]/55 bg-[#d5a535]/[0.09]' : 'border-white/[0.07] hover:border-white/[0.14]'}`} key={value} onClick={() => setFormat(value)} type="button">
                          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-black/35"><span className={`rounded-[2px] border ${item.shape} ${selected ? 'border-[#e3b849] bg-[#e3b849]/10' : 'border-[#6c6860]'}`} /></span>
                          <span className="min-w-0 flex-1"><span className={`block text-xs font-semibold ${selected ? 'text-[#e6bd55]' : 'text-[#bbb6ad]'}`}>{value} · {item.label}</span><span className="mt-0.5 block truncate text-[10px] text-[#66625b]">{item.use}</span></span>
                        </button>
                      )
                    })}
                  </div>
                </fieldset>

                <label className="mt-6 block">
                  <span className="text-xs font-semibold text-[#c8c2b8]">Idioma principal</span>
                  <select className="mt-2 h-11 w-full rounded-xl border border-white/[0.09] bg-[#080808] px-3 text-sm text-[#c7c1b8] outline-none focus:border-[#d5a535]/55" onChange={(event) => setLocale(event.target.value)} value={locale}>
                    <option value="pt-BR">Português (Brasil)</option>
                    <option value="en-US">English (US)</option>
                    <option value="es-ES">Español</option>
                  </select>
                </label>

                <div className="mt-6 rounded-xl border border-white/[0.07] bg-white/[0.025] p-3.5">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.15em] text-[#77736c]">O que será salvo agora</p>
                  <ul className="mt-3 space-y-2 text-[11px] leading-4 text-[#918c83]">
                    <li className="flex gap-2"><span className="text-[#c99e39]">✓</span> Objetivo estratégico e ação desejada</li>
                    <li className="flex gap-2"><span className="text-[#c99e39]">✓</span> Canvas, idioma e áreas seguras</li>
                    <li className="flex gap-2"><span className="text-[#c99e39]">✓</span> Briefing e premissas explícitas</li>
                    <li className="flex gap-2"><span className="text-[#c99e39]">✓</span> Versão inicial imutável e auditável</li>
                  </ul>
                </div>
              </aside>
            </div>

            <div className="flex flex-col-reverse items-stretch justify-between gap-3 border-t border-white/[0.07] px-5 py-4 sm:flex-row sm:items-center sm:px-7">
              <p className="text-[10px] leading-4 text-[#625f59]">Nenhum vídeo é enviado nesta etapa. A origem será vinculada ao projeto criado.</p>
              <div className="flex gap-2">
                <button className="h-11 rounded-xl px-4 text-sm text-[#8b877f] transition hover:bg-white/[0.04] hover:text-white disabled:opacity-40" disabled={creating} onClick={() => setComposerOpen(false)} type="button">Cancelar</button>
                <button className="h-11 min-w-40 rounded-xl bg-[#e0af37] px-5 text-sm font-bold text-[#171207] transition hover:bg-[#edc34f] disabled:cursor-not-allowed disabled:opacity-45" disabled={creating || name.trim().length < 2 || (requiresDestination && !destination.trim())} type="submit">{creating ? 'Salvando direção…' : 'Criar e continuar'}</button>
              </div>
            </div>
          </form>
        </div>
      ) : null}
    </main>
  )
}
