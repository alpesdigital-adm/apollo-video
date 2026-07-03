'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

interface ProfileResponse {
  name: string
  handle: string
  avatarUrl: string | null
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

export default function SettingsPage() {
  const [name, setName] = useState('')
  const [handle, setHandle] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null)
  const [avatarFile, setAvatarFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadProfile()
  }, [])

  async function loadProfile() {
    try {
      setLoading(true)
      const response = await fetch('/api/settings/profile')
      if (response.ok) {
        const data: ProfileResponse = await response.json()
        setName(data.name || '')
        setHandle(data.handle || '')
        setAvatarUrl(data.avatarUrl || null)
      }
    } catch (error) {
      console.error('Failed to load profile:', error)
    } finally {
      setLoading(false)
    }
  }

  function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setErrorMessage('Selecione um arquivo de imagem')
      return
    }

    setAvatarFile(file)
    setAvatarPreview(URL.createObjectURL(file))
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setErrorMessage(null)

    if (!name.trim()) {
      setErrorMessage('Informe o nome')
      return
    }
    if (!handle.trim()) {
      setErrorMessage('Informe o @ do Instagram')
      return
    }

    try {
      setSaveState('saving')
      const formData = new FormData()
      formData.append('name', name.trim())
      formData.append('handle', handle.trim())
      if (avatarFile) {
        formData.append('avatar', avatarFile)
      }

      const response = await fetch('/api/settings/profile', {
        method: 'POST',
        body: formData
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Falha ao salvar perfil')
      }

      setName(data.name || '')
      setHandle(data.handle || '')
      setAvatarUrl(data.avatarUrl || null)
      setAvatarFile(null)
      setAvatarPreview(null)
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 2500)
    } catch (error) {
      console.error('Failed to save profile:', error)
      setErrorMessage(error instanceof Error ? error.message : 'Falha ao salvar perfil')
      setSaveState('error')
    }
  }

  const displayAvatar = avatarPreview || avatarUrl

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#050508] to-zinc-900">
      <header className="border-b border-zinc-800 bg-black/40 backdrop-blur-md">
        <div className="max-w-3xl mx-auto px-6 py-6">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-amber-400 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Voltar ao dashboard
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">
          Perfil do <span className="text-amber-400">criador</span>
        </h1>
        <p className="text-zinc-500 mb-10">
          Essas informações aparecem no CTA final dos seus vídeos.
        </p>

        {loading ? (
          <div className="rounded-2xl bg-zinc-900/50 border border-zinc-800 p-8 animate-pulse h-80" />
        ) : (
          <form
            onSubmit={handleSave}
            className="rounded-2xl bg-zinc-900/50 border border-zinc-800 p-8"
          >
            <div className="flex flex-col items-center mb-8">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="group relative w-24 h-24 rounded-full overflow-hidden border-2 border-zinc-700 hover:border-amber-400 transition-colors bg-zinc-800 flex items-center justify-center"
              >
                {displayAvatar ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={displayAvatar}
                    alt="Avatar do criador"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-2xl font-bold text-zinc-500">
                    {getInitials(name)}
                  </span>
                )}
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                    />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={handleAvatarChange}
                className="hidden"
              />
              <p className="text-xs text-zinc-500 mt-3">PNG, JPG ou WEBP · máx 5MB</p>
            </div>

            <div className="mb-5">
              <label className="block text-sm font-medium text-zinc-300 mb-2">Nome</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Seu nome"
                className="input-field"
              />
            </div>

            <div className="mb-8">
              <label className="block text-sm font-medium text-zinc-300 mb-2">
                Instagram
              </label>
              <div className="flex items-center rounded-lg bg-zinc-800 border border-zinc-700 focus-within:border-amber-400 focus-within:ring-2 focus-within:ring-amber-400/20 transition-all">
                <span className="pl-4 pr-1 text-zinc-500 select-none">@</span>
                <input
                  type="text"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value.replace(/^@+/, ''))}
                  placeholder="seu.usuario"
                  className="w-full py-2 pr-4 bg-transparent text-white placeholder-zinc-500 outline-none"
                />
              </div>
            </div>

            {errorMessage && (
              <p className="text-sm text-red-400 mb-4">{errorMessage}</p>
            )}

            <button
              type="submit"
              disabled={saveState === 'saving'}
              className="btn-primary w-full disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
            >
              {saveState === 'saving' && 'Salvando...'}
              {saveState === 'saved' && 'Salvo ✓'}
              {(saveState === 'idle' || saveState === 'error') && 'Salvar'}
            </button>
          </form>
        )}
      </main>
    </div>
  )
}
