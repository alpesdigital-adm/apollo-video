'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

interface ProfileResponse {
  name: string
  handle: string
  avatarUrl: string | null
}

interface BrandColorGroup {
  id: string
  name: string
  accent: string
  primary?: string
  background?: string
  text?: string
}

type BrandColorMode = 'ai-pick' | 'round-robin'

interface BrandColorsResponse {
  groups: BrandColorGroup[]
  mode: BrandColorMode
  lastUsedIndex: number
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/
const MAX_COLOR_GROUPS = 8
const DEFAULT_NEW_GROUP_ACCENT = '#FF6B35'

function makeLocalGroupId(): string {
  return `local_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function toSixDigitHex(value: string): string {
  const hex = value.trim()
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const [, r, g, b] = hex
    return `#${r}${r}${g}${g}${b}${b}`
  }
  return hex
}

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

  const [colorGroups, setColorGroups] = useState<BrandColorGroup[]>([])
  const [colorMode, setColorMode] = useState<BrandColorMode>('ai-pick')
  const [colorsLoading, setColorsLoading] = useState(true)
  const [colorsSaveState, setColorsSaveState] = useState<SaveState>('idle')
  const [colorsErrorMessage, setColorsErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    loadProfile()
    loadBrandColors()
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

  async function loadBrandColors() {
    try {
      setColorsLoading(true)
      const response = await fetch('/api/settings/colors')
      if (response.ok) {
        const data: BrandColorsResponse = await response.json()
        setColorGroups(Array.isArray(data.groups) ? data.groups : [])
        setColorMode(data.mode === 'round-robin' ? 'round-robin' : 'ai-pick')
      }
    } catch (error) {
      console.error('Failed to load brand colors:', error)
    } finally {
      setColorsLoading(false)
    }
  }

  function addColorGroup() {
    if (colorGroups.length >= MAX_COLOR_GROUPS) return
    setColorGroups((prev) => [
      ...prev,
      { id: makeLocalGroupId(), name: '', accent: DEFAULT_NEW_GROUP_ACCENT }
    ])
  }

  function removeColorGroup(id: string) {
    setColorGroups((prev) => prev.filter((group) => group.id !== id))
  }

  function updateColorGroup(id: string, patch: Partial<BrandColorGroup>) {
    setColorGroups((prev) => prev.map((group) => (group.id === id ? { ...group, ...patch } : group)))
  }

  function toggleOptionalColor(id: string, field: 'primary' | 'background' | 'text', enabled: boolean) {
    setColorGroups((prev) =>
      prev.map((group) => {
        if (group.id !== id) return group
        if (!enabled) {
          const next = { ...group }
          delete next[field]
          return next
        }
        return { ...group, [field]: group[field] || '#FFFFFF' }
      })
    )
  }

  async function handleSaveColors() {
    setColorsErrorMessage(null)

    for (const group of colorGroups) {
      if (!group.name.trim()) {
        setColorsErrorMessage('Todo grupo precisa de um nome')
        return
      }
      if (!HEX_COLOR_RE.test(group.accent.trim())) {
        setColorsErrorMessage(`Grupo "${group.name}": cor de destaque inválida`)
        return
      }
      for (const field of ['primary', 'background', 'text'] as const) {
        const value = group[field]
        if (value !== undefined && !HEX_COLOR_RE.test(value.trim())) {
          setColorsErrorMessage(`Grupo "${group.name}": cor "${field}" inválida`)
          return
        }
      }
    }

    try {
      setColorsSaveState('saving')
      const response = await fetch('/api/settings/colors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groups: colorGroups.map((group) => ({
            ...group,
            id: group.id.startsWith('local_') ? undefined : group.id
          })),
          mode: colorMode
        })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || 'Falha ao salvar cores da marca')
      }

      setColorGroups(Array.isArray(data.groups) ? data.groups : [])
      setColorMode(data.mode === 'round-robin' ? 'round-robin' : 'ai-pick')
      setColorsSaveState('saved')
      setTimeout(() => setColorsSaveState('idle'), 2500)
    } catch (error) {
      console.error('Failed to save brand colors:', error)
      setColorsErrorMessage(error instanceof Error ? error.message : 'Falha ao salvar cores da marca')
      setColorsSaveState('error')
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

        <h2 className="text-2xl font-bold mt-14 mb-2">
          Cores da <span className="text-amber-400">marca</span>
        </h2>
        <p className="text-zinc-500 mb-6">
          Cadastre um ou mais grupos de cores. Seus vídeos usam essas cores em vez de uma
          paleta inventada pela IA.
        </p>

        {colorsLoading ? (
          <div className="rounded-2xl bg-zinc-900/50 border border-zinc-800 p-8 animate-pulse h-64" />
        ) : (
          <div className="rounded-2xl bg-zinc-900/50 border border-zinc-800 p-8">
            {colorGroups.length === 0 && (
              <p className="text-sm text-zinc-500 mb-6">
                Nenhum grupo cadastrado ainda — a IA vai inventar a paleta a cada vídeo. Adicione
                um grupo para fixar as cores da sua marca.
              </p>
            )}

            <div className="space-y-4 mb-6">
              {colorGroups.map((group) => (
                <div key={group.id} className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-5">
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <input
                      type="text"
                      value={group.name}
                      onChange={(e) => updateColorGroup(group.id, { name: e.target.value })}
                      placeholder="Nome do grupo (ex.: Principal, Alternativa)"
                      className="input-field flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => removeColorGroup(group.id)}
                      className="shrink-0 text-zinc-500 hover:text-red-400 transition-colors p-2"
                      aria-label="Remover grupo"
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3M4 7h16"
                        />
                      </svg>
                    </button>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                        Destaque (accent)
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={toSixDigitHex(group.accent) || '#000000'}
                          onChange={(e) => updateColorGroup(group.id, { accent: e.target.value })}
                          className="w-9 h-9 rounded-md border border-zinc-700 bg-transparent cursor-pointer shrink-0"
                        />
                        <input
                          type="text"
                          value={group.accent}
                          onChange={(e) => updateColorGroup(group.id, { accent: e.target.value })}
                          placeholder="#FF6B35"
                          className="input-field text-sm px-2 py-1.5 min-w-0"
                        />
                      </div>
                    </div>

                    {(['primary', 'background', 'text'] as const).map((field) => {
                      const label = field === 'primary' ? 'Primária' : field === 'background' ? 'Fundo' : 'Texto'
                      const enabled = group[field] !== undefined
                      return (
                        <div key={field}>
                          <div className="flex items-center justify-between mb-1.5">
                            <label className="block text-xs font-medium text-zinc-400">{label}</label>
                            <button
                              type="button"
                              onClick={() => toggleOptionalColor(group.id, field, !enabled)}
                              className="text-[10px] text-zinc-500 hover:text-amber-400 transition-colors"
                            >
                              {enabled ? 'usar padrão' : 'personalizar'}
                            </button>
                          </div>
                          {enabled ? (
                            <div className="flex items-center gap-2">
                              <input
                                type="color"
                                value={toSixDigitHex(group[field] || '#FFFFFF')}
                                onChange={(e) => updateColorGroup(group.id, { [field]: e.target.value })}
                                className="w-9 h-9 rounded-md border border-zinc-700 bg-transparent cursor-pointer shrink-0"
                              />
                              <input
                                type="text"
                                value={group[field] || ''}
                                onChange={(e) => updateColorGroup(group.id, { [field]: e.target.value })}
                                placeholder="#FFFFFF"
                                className="input-field text-sm px-2 py-1.5 min-w-0"
                              />
                            </div>
                          ) : (
                            <div className="h-9 flex items-center text-xs text-zinc-600 italic">
                              a IA completa
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>

            <button
              type="button"
              onClick={addColorGroup}
              disabled={colorGroups.length >= MAX_COLOR_GROUPS}
              className="w-full mb-8 rounded-lg border border-dashed border-zinc-700 text-zinc-400 hover:text-amber-400 hover:border-amber-400/50 transition-colors py-3 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {colorGroups.length >= MAX_COLOR_GROUPS
                ? `Máximo de ${MAX_COLOR_GROUPS} grupos`
                : '+ Adicionar grupo de cores'}
            </button>

            <div className="mb-8">
              <label className="block text-sm font-medium text-zinc-300 mb-3">
                Como escolher o grupo em cada vídeo
              </label>
              <div className="space-y-2">
                <label
                  className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors ${
                    colorMode === 'ai-pick'
                      ? 'border-amber-400 bg-amber-400/5'
                      : 'border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="colorMode"
                    checked={colorMode === 'ai-pick'}
                    onChange={() => setColorMode('ai-pick')}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm text-white">IA escolhe o grupo conforme o conteúdo</span>
                    <span className="block text-xs text-zinc-500 mt-0.5">
                      A cada vídeo, a IA analisa o conteúdo e escolhe o grupo que combina melhor.
                    </span>
                  </span>
                </label>
                <label
                  className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors ${
                    colorMode === 'round-robin'
                      ? 'border-amber-400 bg-amber-400/5'
                      : 'border-zinc-800 hover:border-zinc-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="colorMode"
                    checked={colorMode === 'round-robin'}
                    onChange={() => setColorMode('round-robin')}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm text-white">Alternar em sequência a cada vídeo</span>
                    <span className="block text-xs text-zinc-500 mt-0.5">
                      Cada vídeo novo usa o próximo grupo da lista, em rodízio.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {colorsErrorMessage && (
              <p className="text-sm text-red-400 mb-4">{colorsErrorMessage}</p>
            )}

            <button
              type="button"
              onClick={handleSaveColors}
              disabled={colorsSaveState === 'saving'}
              className="btn-primary w-full disabled:opacity-60 disabled:cursor-not-allowed disabled:hover:scale-100"
            >
              {colorsSaveState === 'saving' && 'Salvando...'}
              {colorsSaveState === 'saved' && 'Salvo ✓'}
              {(colorsSaveState === 'idle' || colorsSaveState === 'error') && 'Salvar cores'}
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
