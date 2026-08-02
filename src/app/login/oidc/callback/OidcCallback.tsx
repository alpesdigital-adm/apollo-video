'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

export default function OidcCallback({ code, state }: Readonly<{ code: string; state: string }>) {
  const router = useRouter()
  const started = useRef(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (started.current) return
    started.current = true
    window.history.replaceState(null, '', '/login/oidc/callback')
    void (async () => {
      try {
        const response = await fetch('/v1/session/oidc/callback', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, state }),
        })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error?.message ?? 'NÃ£o foi possÃ­vel concluir o acesso.')
        router.replace(result.data?.redirectTo ?? '/')
        router.refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'NÃ£o foi possÃ­vel concluir o acesso.')
      }
    })()
  }, [code, router, state])

  return (
    <main className="grid min-h-screen place-items-center bg-[#08090d] px-6 text-[#f4f5f7]">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0b0c12] p-8 text-center shadow-2xl">
        <div className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-[#7167ff] text-lg font-black">A</div>
        <h1 className="mt-6 text-2xl font-semibold">Validando seu acesso</h1>
        <p className="mt-3 text-sm leading-6 text-[#8d92a2]">Estamos verificando a identidade e o workspace autorizado.</p>
        {error ? <div className="mt-6 rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-3 text-sm text-red-200">{error}<a className="mt-3 block text-white underline" href="/login">Tentar novamente</a></div> : <div className="mx-auto mt-7 h-6 w-6 animate-spin rounded-full border-2 border-[#7167ff] border-t-transparent" />}
      </div>
    </main>
  )
}

