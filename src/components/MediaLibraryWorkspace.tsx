'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

import AppShellNavigation from './AppShellNavigation'
import LogoutButton from './LogoutButton'

interface LibraryItem {
  id: string; kind: 'video' | 'audio' | 'image' | 'segment'; label: string
  people: string[]; topics: string[]; status: 'processing' | 'usable' | 'failed'
  rights: { status: 'eligible' | 'review' | 'restricted' | 'expired'; reasonCodes: string[] }
  origin: { type: 'upload' | 'generated' | 'derived'; parentArtifactId?: string }
  preview: { thumbnail: { status: string; artifactId?: string }; waveform: { status: string; artifactId?: string } }
  technical: { mediaType: string; container: string; byteSize: string }; createdAt: string
}

interface ProjectSummary { id: string; name: string }
interface ApiEnvelope<T> { data?: T; error?: { message?: string } }

const rightsCopy = { eligible: 'Liberado', review: 'Revisar direitos', restricted: 'Restrito', expired: 'Expirado' } as const
const kindCopy = { video: 'Vídeo', audio: 'Áudio', image: 'Imagem', segment: 'Segmento' } as const

function byteSize(value: string) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes)) return value
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}

export default function MediaLibraryWorkspace() {
  const [items, setItems] = useState<LibraryItem[]>([])
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [projectId, setProjectId] = useState('')
  const [filters, setFilters] = useState({ kind: '', person: '', topic: '', rightsStatus: '' })
  const [applied, setApplied] = useState(filters)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [attaching, setAttaching] = useState<string | null>(null)

  const load = useCallback(async (after?: string) => {
    setState('loading'); setMessage('')
    try {
      const params = new URLSearchParams({ limit: '24' })
      for (const [key, value] of Object.entries(applied)) if (value) params.set(key, value)
      if (after) params.set('after', after)
      const response = await fetch(`/v1/media/library?${params.toString()}`)
      const payload = await response.json() as ApiEnvelope<{ items: LibraryItem[]; nextCursor: string | null }>
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'Não foi possível carregar a biblioteca.')
      setItems((current) => after ? [...current, ...payload.data!.items] : payload.data!.items)
      setNextCursor(payload.data.nextCursor)
      setState('ready')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível carregar a biblioteca.')
      setState('error')
    }
  }, [applied])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/v1/projects?limit=100', { signal: controller.signal }).then(async (response) => {
      const payload = await response.json() as ApiEnvelope<{ projects: ProjectSummary[] }>
      if (response.ok && payload.data) setProjects(payload.data.projects)
    }).catch(() => undefined)
    return () => controller.abort()
  }, [])

  function applyFilters(event: FormEvent) { event.preventDefault(); setApplied({ ...filters }) }

  async function attach(item: LibraryItem) {
    if (!projectId) { setMessage('Escolha um projeto antes de inserir a mídia.'); return }
    setAttaching(item.id); setMessage('')
    try {
      const response = await fetch(`/v1/projects/${encodeURIComponent(projectId)}/media-library-attachments`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artifactId: item.id }),
      })
      const payload = await response.json() as ApiEnvelope<{ replayed: boolean }>
      if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'A mídia não pôde ser inserida.')
      setMessage(payload.data.replayed ? 'Esta mídia já estava vinculada ao projeto.' : 'Mídia inserida no projeto por referência, sem copiar o arquivo.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A mídia não pôde ser inserida.')
    } finally { setAttaching(null) }
  }

  return <main className="min-h-screen bg-[#070707] text-[#f4f1ea]">
    <div className="mx-auto flex min-h-screen max-w-[1720px]">
      <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-white/[0.07] bg-[#0a0a0a] px-5 py-6 lg:flex">
        <Link className="flex items-center gap-3 px-2" href="/"><span className="grid h-9 w-9 place-items-center rounded-[10px] border border-[#e0af37]/35 bg-[#e0af37]/10 text-sm font-black text-[#efc75f]">A</span><span className="text-sm font-bold tracking-[0.22em] text-white">APOLLO</span></Link>
        <AppShellNavigation active="library" /><div className="mt-auto"><LogoutButton /></div>
      </aside>
      <section className="min-w-0 flex-1 px-5 py-8 sm:px-8 xl:px-12">
        <header className="border-b border-white/[0.09] pb-7">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#c19a43]">Mesa de seleção</p>
          <div className="mt-3 flex flex-col justify-between gap-6 xl:flex-row xl:items-end">
            <div><h1 className="text-4xl font-semibold tracking-[-0.045em] sm:text-5xl">Biblioteca de mídia</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#938d83]">Encontre material do workspace, confira a licença atual e insira no projeto sem duplicar arquivos.</p></div>
            <label className="grid gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8f887e]">Projeto de destino<select className="min-w-[260px] border border-white/[0.12] bg-[#10100f] px-3 py-3 text-sm normal-case tracking-normal text-[#eee8dc] outline-none focus:border-[#d2a841]" value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">Escolha um projeto</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          </div>
        </header>

        <form className="grid gap-3 border-b border-white/[0.08] py-5 md:grid-cols-2 xl:grid-cols-[170px_1fr_1fr_190px_auto]" onSubmit={applyFilters}>
          <select aria-label="Tipo" className="border border-white/[0.1] bg-[#0d0d0c] px-3 py-3 text-sm text-[#cfc8bc]" value={filters.kind} onChange={(e) => setFilters({ ...filters, kind: e.target.value })}><option value="">Todos os tipos</option><option value="video">Vídeo</option><option value="audio">Áudio</option><option value="image">Imagem</option><option value="segment">Segmento</option></select>
          <input aria-label="Pessoa" className="border border-white/[0.1] bg-[#0d0d0c] px-3 py-3 text-sm placeholder:text-[#625e57]" placeholder="Pessoa" value={filters.person} onChange={(e) => setFilters({ ...filters, person: e.target.value })} />
          <input aria-label="Tema" className="border border-white/[0.1] bg-[#0d0d0c] px-3 py-3 text-sm placeholder:text-[#625e57]" placeholder="Tema" value={filters.topic} onChange={(e) => setFilters({ ...filters, topic: e.target.value })} />
          <select aria-label="Direitos" className="border border-white/[0.1] bg-[#0d0d0c] px-3 py-3 text-sm text-[#cfc8bc]" value={filters.rightsStatus} onChange={(e) => setFilters({ ...filters, rightsStatus: e.target.value })}><option value="">Todos os direitos</option><option value="eligible">Liberado</option><option value="review">Revisar</option><option value="restricted">Restrito</option><option value="expired">Expirado</option></select>
          <button className="bg-[#d0a43a] px-5 py-3 text-xs font-bold uppercase tracking-[0.14em] text-[#171208] transition hover:bg-[#e1bb5a] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e1bb5a]">Filtrar</button>
        </form>

        {message ? <p className="mt-5 border-l-2 border-[#c99f3d] bg-[#c99f3d]/[0.06] px-4 py-3 text-sm text-[#cfc5b4]" role="status">{message}</p> : null}
        {state === 'loading' && items.length === 0 ? <p className="py-14 text-sm text-[#777168]" role="status">Organizando a mesa de seleção…</p> : null}
        {state === 'error' && items.length === 0 ? <p className="py-14 text-sm text-[#c67e78]" role="alert">{message}</p> : null}
        {state === 'ready' && items.length === 0 ? <div className="my-10 border border-dashed border-white/[0.12] p-10 text-center"><p className="text-lg text-[#d4cec3]">Nenhuma mídia encontrada.</p><p className="mt-2 text-sm text-[#777168]">Remova um filtro ou faça o ingest de um arquivo no projeto.</p></div> : null}

        <div className="mt-7 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {items.map((item) => <article className="group overflow-hidden border border-white/[0.09] bg-[#0b0b0a] transition hover:border-white/[0.18]" key={item.id}>
            <div className="relative flex h-28 items-center overflow-hidden border-b border-white/[0.08] bg-[repeating-linear-gradient(90deg,#111_0,#111_31px,#0b0b0b_32px,#0b0b0b_34px)] px-5">
              <span className="font-mono text-4xl font-black tracking-[-0.08em] text-white/[0.14]">{item.kind === 'audio' ? '⌁⌁⌁' : item.kind === 'image' ? '▧' : '▶'}</span>
              <div className="absolute bottom-0 left-0 h-1 bg-[#cda23f]" style={{ width: item.rights.status === 'eligible' ? '100%' : item.rights.status === 'review' ? '55%' : '18%' }} />
              <span className="absolute right-4 top-4 bg-black/60 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.16em] text-[#aaa39a]">{kindCopy[item.kind]} · {item.technical.container}</span>
            </div>
            <div className="p-5">
              <div className="flex items-start justify-between gap-4"><div className="min-w-0"><h2 className="truncate text-base font-semibold text-[#eee9df]" title={item.label}>{item.label}</h2><p className="mt-1 font-mono text-[10px] text-[#67635d]">{item.id}</p></div><span className={`shrink-0 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.12em] ${item.rights.status === 'eligible' ? 'bg-[#315f46]/35 text-[#79c394]' : item.rights.status === 'review' ? 'bg-[#8a6a25]/30 text-[#d5b15b]' : 'bg-[#783d3d]/30 text-[#d17b76]'}`}>{rightsCopy[item.rights.status]}</span></div>
              <dl className="mt-5 grid grid-cols-3 gap-2 border-y border-white/[0.07] py-3 text-[10px]"><div><dt className="text-[#625e57]">Tamanho</dt><dd className="mt-1 text-[#b6afa4]">{byteSize(item.technical.byteSize)}</dd></div><div><dt className="text-[#625e57]">Origem</dt><dd className="mt-1 capitalize text-[#b6afa4]">{item.origin.type}</dd></div><div><dt className="text-[#625e57]">Estado</dt><dd className="mt-1 capitalize text-[#b6afa4]">{item.status}</dd></div></dl>
              {(item.people.length || item.topics.length) ? <div className="mt-4 flex flex-wrap gap-1.5">{[...item.people, ...item.topics].slice(0, 6).map((tag) => <span className="border border-white/[0.08] px-2 py-1 text-[9px] text-[#8b857b]" key={tag}>{tag}</span>)}</div> : null}
              <button className="mt-5 w-full border border-[#cda23f]/35 px-4 py-2.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[#d7b55f] transition enabled:hover:bg-[#cda23f]/10 disabled:cursor-not-allowed disabled:border-white/[0.07] disabled:text-[#55514b]" disabled={item.status !== 'usable' || item.rights.status !== 'eligible' || attaching !== null} onClick={() => void attach(item)} type="button">{attaching === item.id ? 'Inserindo…' : item.rights.status === 'eligible' ? 'Inserir no projeto' : 'Uso bloqueado'}</button>
            </div>
          </article>)}
        </div>
        {nextCursor ? <div className="py-10 text-center"><button className="border border-white/[0.12] px-6 py-3 text-xs font-semibold text-[#aaa398] hover:border-[#cda23f]/50 hover:text-[#d5b45f]" onClick={() => void load(nextCursor)} disabled={state === 'loading'}>{state === 'loading' ? 'Carregando…' : 'Carregar mais'}</button></div> : null}
      </section>
    </div>
  </main>
}
