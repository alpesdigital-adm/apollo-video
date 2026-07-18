'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function LogoutButton() {
  const router = useRouter()
  const [leaving, setLeaving] = useState(false)

  async function logout() {
    setLeaving(true)
    try {
      await fetch('/v1/session', { method: 'DELETE' })
    } finally {
      router.replace('/login')
      router.refresh()
    }
  }

  return <button className="rounded-lg px-3 py-2 text-[#818696] transition hover:bg-white/5 hover:text-white disabled:opacity-50" disabled={leaving} onClick={logout} type="button">{leaving ? 'Saindo…' : 'Sair'}</button>
}
