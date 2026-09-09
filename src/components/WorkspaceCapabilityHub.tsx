'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'

import type { AppShellDestinationId } from '@/v2/domain/app-shell'
import AppShellNavigation from './AppShellNavigation'
import LogoutButton from './LogoutButton'
import WebhookControlRoom from './WebhookControlRoom'

const WorkspaceLutLibrary = dynamic(() => import('./WorkspaceLutLibrary'))

interface Capability {
  id: string
  title: string
  description: string
  endpoint?: { method: string; path: string }
}

interface CapabilityEnvelope {
  data?: { capabilities?: Capability[] }
  error?: { message?: string }
}

/**
 * Sections that are a *listing* of authorized capabilities.
 *
 * Projects, batches and capture sessions are excluded because they are
 * operable pages with their own state machine, not catalogues. Giving one of
 * them a hub entry here would add a second, weaker view of the same thing.
 */
const HUBS: Record<Exclude<AppShellDestinationId, 'projects' | 'batches' | 'capture-sessions'>, {
  eyebrow: string
  title: string
  description: string
  prefixes: readonly string[]
  empty: string
}> = {
  library: {
    eyebrow: 'Catálogos do workspace', title: 'Biblioteca',
    description: 'Capabilities publicadas para fala, evidência, momentos, busca semântica e takes.',
    prefixes: ['apollo.projects.speech-segments.', 'apollo.projects.evidence-segments.', 'apollo.projects.long-form-', 'apollo.projects.semantic-search.', 'apollo.batches.take-libraries.'],
    empty: 'Nenhuma capability de biblioteca está autorizada para esta sessão.',
  },
  presenters: {
    eyebrow: 'Produção sintética', title: 'Apresentadores',
    description: 'Somente profiles e operações sintéticas publicados na API aparecem aqui.',
    prefixes: ['apollo.synthetic-presenters.'],
    empty: 'Ainda não existe capability operável de apresentador sintético. Nenhum profile fictício foi criado.',
  },
  brand: {
    eyebrow: 'Identidade visual', title: 'Marca',
    description: 'Recursos versionados de marca que já possuem contrato público e enforcement server-side.',
    prefixes: ['apollo.workspace-luts.'],
    empty: 'Nenhuma capability de marca está autorizada para esta sessão.',
  },
  settings: {
    eyebrow: 'Administração', title: 'Configurações',
    description: 'Sessão, clientes e integrações administráveis pelo mesmo contrato externo usado pela UI.',
    prefixes: ['apollo.sessions.', 'apollo.clients.', 'apollo.webhooks.'],
    empty: 'Nenhuma capability administrativa está autorizada para esta sessão.',
  },
}

export default function WorkspaceCapabilityHub({ section }: Readonly<{
  section: Exclude<AppShellDestinationId, 'projects' | 'batches' | 'capture-sessions'>
}>) {
  const hub = HUBS[section]
  const [capabilities, setCapabilities] = useState<Capability[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/v1/capabilities', { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as CapabilityEnvelope
        if (!response.ok) throw new Error(payload.error?.message ?? 'Não foi possível ler as capabilities.')
        setCapabilities(payload.data?.capabilities ?? [])
        setState('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setMessage(error instanceof Error ? error.message : 'Não foi possível ler as capabilities.')
        setState('error')
      })
    return () => controller.abort()
  }, [])

  const visible = useMemo(
    () => capabilities.filter((capability) => hub.prefixes.some((prefix) => capability.id.startsWith(prefix))),
    [capabilities, hub.prefixes],
  )

  return (
    <main className="min-h-screen bg-[#070707] text-[#f4f1ea]">
      <div className="mx-auto flex min-h-screen max-w-[1720px]">
        <aside className="sticky top-0 hidden h-screen w-[236px] shrink-0 flex-col border-r border-white/[0.07] bg-[#0a0a0a] px-5 py-6 lg:flex">
          <Link className="flex items-center gap-3 px-2" href="/"><span className="grid h-9 w-9 place-items-center rounded-[10px] border border-[#e0af37]/35 bg-[#e0af37]/10 text-sm font-black text-[#efc75f]">A</span><span className="text-sm font-bold tracking-[0.22em] text-white">APOLLO</span></Link>
          <AppShellNavigation active={section} />
          <div className="mt-auto"><LogoutButton /></div>
        </aside>
        <section className="min-w-0 flex-1 px-5 py-10 sm:px-8 xl:px-12">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#b18b35]">{hub.eyebrow}</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-[-0.04em]">{hub.title}</h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-[#8f8a81]">{hub.description}</p>
          {state === 'loading' ? <p className="mt-10 text-sm text-[#777168]" role="status">Consultando capability registry…</p> : null}
          {state === 'error' ? <div className="mt-10 border border-[#a44d4d]/30 bg-[#a44d4d]/10 p-4 text-sm text-[#d58c8c]" role="alert">{message}</div> : null}
          {state === 'ready' && visible.length === 0 ? <div className="mt-10 border border-white/[0.08] bg-white/[0.02] p-6 text-sm leading-6 text-[#817c73]" data-testid="capability-empty-state">{hub.empty}</div> : null}
          {visible.length > 0 && section !== 'brand' ? <div className="mt-10 grid gap-3 lg:grid-cols-2" data-testid="capability-list">{visible.map((capability) => <article className="border border-white/[0.08] bg-white/[0.02] p-5" key={capability.id}><p className="text-xs font-semibold text-[#ddd7cc]">{capability.title}</p><p className="mt-2 text-xs leading-5 text-[#777168]">{capability.description}</p>{capability.endpoint ? <p className="mt-4 font-mono text-[10px] text-[#b18b35]">{capability.endpoint.method} {capability.endpoint.path}</p> : null}</article>)}</div> : null}
          {section === 'brand' ? <WorkspaceLutLibrary /> : null}
          {section === 'settings' ? <WebhookControlRoom /> : null}
        </section>
      </div>
    </main>
  )
}
