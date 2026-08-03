'use client'

import { useEffect, useState } from 'react'

interface WorkspaceOption {
  memberId: string
  workspaceId: string
  workspaceSlug: string
  workspaceName: string
  role: string
}

interface SessionEnvelope {
  data?: { workspaceId?: string; workspaces?: WorkspaceOption[] }
  error?: { message?: string }
}

async function invalidateWorkspaceClientState(targetWorkspaceId: string): Promise<void> {
  window.dispatchEvent(new CustomEvent('apollo:workspace-changing', { detail: { targetWorkspaceId } }))
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)
      if (key?.startsWith('apollo:workspace:')) storage.removeItem(key)
    }
  }
  if ('caches' in window) {
    const names = await window.caches.keys()
    await Promise.all(names.filter((name) => name.startsWith('apollo-workspace-')).map((name) => window.caches.delete(name)))
  }
}

export default function WorkspaceSelector() {
  const [current, setCurrent] = useState('')
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'switching' | 'error'>('loading')
  const [message, setMessage] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let inFlight = false
    const refreshSession = async (initial: boolean) => {
      if (inFlight || controller.signal.aborted) return
      inFlight = true
      try {
        const response = await fetch('/v1/session', { cache: 'no-store', signal: controller.signal })
        const payload = await response.json() as SessionEnvelope
        if (response.status === 401) {
          const returnTo = `${window.location.pathname}${window.location.search}`
          window.location.assign(`/login?next=${encodeURIComponent(returnTo)}`)
          return
        }
        if (!response.ok) throw new Error(payload.error?.message ?? 'Não foi possível ler o workspace.')
        setCurrent(payload.data?.workspaceId ?? '')
        setWorkspaces(payload.data?.workspaces ?? [])
        setMessage('')
        setState('ready')
      } catch (error) {
        if (controller.signal.aborted) return
        setMessage(error instanceof Error ? error.message : 'Não foi possível ler o workspace.')
        if (initial) setState('error')
      } finally {
        inFlight = false
      }
    }
    void refreshSession(true)
    const interval = window.setInterval(() => void refreshSession(false), 5 * 60 * 1000)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void refreshSession(false)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      controller.abort()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  async function switchWorkspace(workspaceId: string) {
    if (!workspaceId || workspaceId === current || state === 'switching') return
    setState('switching')
    setMessage('')
    try {
      const response = await fetch('/v1/session/workspace', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
      })
      const payload = await response.json() as SessionEnvelope
      if (!response.ok) throw new Error(payload.error?.message ?? 'Não foi possível trocar o workspace.')
      await invalidateWorkspaceClientState(workspaceId)
      window.location.assign('/')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível trocar o workspace.')
      setState('error')
    }
  }

  if (state === 'loading') return <div className="mt-6 h-14 animate-pulse rounded-xl bg-white/[0.035]" aria-label="Carregando workspace" />
  return (
    <div className="mt-6" data-testid="workspace-selector">
      <label className="mb-1.5 block text-[9px] font-semibold uppercase tracking-[0.18em] text-[#69645c]" htmlFor="workspace-selector">Workspace</label>
      <select
        className="w-full rounded-lg border border-white/[0.08] bg-[#111] px-2.5 py-2 text-xs text-[#d8d2c7] outline-none focus:border-[#e0af37]/50 disabled:opacity-60"
        disabled={state === 'switching' || workspaces.length < 2}
        id="workspace-selector"
        onChange={(event) => void switchWorkspace(event.target.value)}
        value={current}
      >
        {workspaces.map((workspace) => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.workspaceName}</option>)}
      </select>
      {state === 'switching' ? <p className="mt-2 text-[10px] text-[#8f8a81]" role="status">Trocando com segurança…</p> : null}
      {state === 'error' ? <p className="mt-2 text-[10px] leading-4 text-[#d58c8c]" role="alert">{message}</p> : null}
    </div>
  )
}
