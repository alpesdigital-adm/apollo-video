'use client'

import { FormEvent, useState } from 'react'
import { useRouter } from 'next/navigation'

function EyeIcon({ crossed = false }: { crossed?: boolean }) {
  return crossed ? (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" d="M3 3l18 18M10.6 10.7a2 2 0 002.7 2.7M9.9 4.4A10.8 10.8 0 0112 4c5.4 0 8.6 5.2 8.6 5.2a11.6 11.6 0 01-2.5 3.1M6.2 6.3C4.4 7.5 3.4 9.2 3.4 9.2S6.6 14.4 12 14.4c.7 0 1.4-.1 2-.3" /></svg>
  ) : (
    <svg aria-hidden="true" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.7"><path strokeLinecap="round" strokeLinejoin="round" d="M3.4 12S6.6 6.8 12 6.8 20.6 12 20.6 12 17.4 17.2 12 17.2 3.4 12 3.4 12z" /><circle cx="12" cy="12" r="2.4" /></svg>
  )
}

export default function LoginForm() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError('')
    const next = new URLSearchParams(window.location.search).get('next') ?? '/'
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password, next }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error?.message ?? 'Não foi possível entrar.')
      router.replace(result.data?.redirectTo ?? '/')
      router.refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível entrar.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <form className="mt-10" onSubmit={submit}>
      <div className="space-y-5">
        <label className="block">
          <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[#868b9c]">Usuário</span>
          <input autoComplete="username" autoFocus className="h-12 w-full rounded-xl border border-white/10 bg-[#0a0b10] px-4 text-[15px] text-white outline-none transition placeholder:text-[#555a69] hover:border-white/20 focus:border-[#7167ff] focus:ring-4 focus:ring-[#7167ff]/10" name="username" onChange={(event) => setUsername(event.target.value)} placeholder="Seu usuário" required value={username} />
        </label>
        <label className="block">
          <span className="mb-2 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[#868b9c]">Senha</span>
          <span className="relative block">
            <input autoComplete="current-password" className="h-12 w-full rounded-xl border border-white/10 bg-[#0a0b10] px-4 pr-12 text-[15px] text-white outline-none transition placeholder:text-[#555a69] hover:border-white/20 focus:border-[#7167ff] focus:ring-4 focus:ring-[#7167ff]/10" name="password" onChange={(event) => setPassword(event.target.value)} placeholder="Sua senha" required type={showPassword ? 'text' : 'password'} value={password} />
            <button aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} className="absolute inset-y-0 right-0 grid w-12 place-items-center text-[#777c8c] transition hover:text-white focus-visible:text-white" onClick={() => setShowPassword((value) => !value)} type="button"><EyeIcon crossed={showPassword} /></button>
          </span>
        </label>
      </div>

      <div aria-live="polite" className="min-h-11 pt-3">
        {error ? <p className="rounded-lg border border-red-400/20 bg-red-400/8 px-3 py-2 text-sm text-red-200">{error}</p> : null}
      </div>

      <button className="group mt-2 flex h-12 w-full items-center justify-between rounded-xl bg-[#7167ff] px-5 text-sm font-semibold text-white transition hover:bg-[#8077ff] focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#101116] disabled:cursor-wait disabled:opacity-60" disabled={loading || !username || !password} type="submit">
        <span>{loading ? 'Abrindo o workspace…' : 'Entrar no Apollo'}</span>
        <span aria-hidden="true" className="transition-transform group-hover:translate-x-1">→</span>
      </button>
      <p className="mt-5 text-center text-xs leading-5 text-[#686d7d]">Sessão privada neste dispositivo por até 12 horas.</p>
    </form>
  )
}
