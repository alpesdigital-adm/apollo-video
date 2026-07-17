'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

interface Asset {
  id: string
  kind: 'image' | 'video' | 'audio'
  label: string
  tags: string[]
  path: string
  width?: number
  height?: number
  addedAt: string
}

type SaveState = 'idle' | 'saving' | 'error'

export default function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadTags, setUploadTags] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const [retryFiles, setRetryFiles] = useState<File[]>([])

  useEffect(() => {
    loadAssets()
  }, [])

  async function loadAssets() {
    try {
      setLoading(true)
      const response = await fetch('/api/assets')
      if (response.ok) {
        const data = await response.json()
        setAssets(Array.isArray(data.assets) ? data.assets : [])
      }
    } catch (error) {
      console.error('Failed to load assets:', error)
    } finally {
      setLoading(false)
    }
  }

  async function handleFiles(fileList: FileList | File[] | null) {
    if (!fileList || fileList.length === 0) return
    const files = Array.from(fileList)
    setUploadError(null)
    setUploading(true)
    setRetryFiles([])
    const controller = new AbortController()
    uploadAbortRef.current = controller
    setProgress({ done: 0, total: files.length })

    const created: Asset[] = []
    const failed: File[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      try {
        const formData = new FormData()
        formData.append('file', file)
        formData.append('label', file.name.replace(/\.[a-zA-Z0-9]+$/, ''))
        formData.append('tags', uploadTags)

        const response = await fetch('/api/assets', { method: 'POST', body: formData, signal: controller.signal })
        const data = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error(data?.error || `Falha ao subir ${file.name}`)
        }
        if (data?.asset) created.push(data.asset)
      } catch (error) {
        failed.push(file)
        setUploadError(error instanceof Error ? error.message : `Falha ao subir ${file.name}`)
      } finally {
        setProgress({ done: i + 1, total: files.length })
      }
    }

    if (created.length > 0) {
      setAssets((prev) => [...created, ...prev])
    }
    setUploading(false)
    uploadAbortRef.current = null
    setRetryFiles(failed)
    setProgress(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleDelete(asset: Asset) {
    const confirmed = window.confirm(
      `Excluir o asset "${asset.label || asset.id}"? O arquivo será apagado permanentemente.`
    )
    if (!confirmed) return

    try {
      const response = await fetch(`/api/assets/${asset.id}`, { method: 'DELETE' })
      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Falha ao excluir')
      }
      setAssets((prev) => prev.filter((a) => a.id !== asset.id))
    } catch (error) {
      console.error('Delete asset failed:', error)
      alert(error instanceof Error ? error.message : 'Falha ao excluir o asset')
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#050508] to-zinc-900">
      <header className="border-b border-zinc-800 bg-black/40 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-6 py-6">
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

      <main className="max-w-5xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold mb-2">
          Biblioteca de <span className="text-amber-400">assets</span>
        </h1>
        <p className="text-zinc-500 mb-10">
          Suba suas próprias imagens e clipes (fotos de credibilidade, memes, prints de notícia,
          b-roll de evento). Marque com tags e a IA usa nos seus vídeos.
        </p>

        {/* Upload zone */}
        <div className="mb-12">
          <div className="mb-3">
            <label className="block text-sm font-medium text-zinc-300 mb-2">
              Tags para os próximos uploads (separadas por vírgula)
            </label>
            <input
              type="text"
              value={uploadTags}
              onChange={(e) => setUploadTags(e.target.value)}
              placeholder="ex.: depoimento, cliente, autoridade"
              className="input-field w-full"
            />
          </div>

          <label
            className={`block p-10 rounded-2xl border-2 border-dashed transition-all cursor-pointer text-center ${
              uploading
                ? 'border-zinc-700 bg-zinc-900/40'
                : 'border-zinc-700 hover:border-amber-400/50 bg-zinc-900/30 hover:bg-zinc-900/50'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,audio/*"
              multiple
              onChange={(e) => handleFiles(e.target.files)}
              disabled={uploading}
              className="hidden"
            />
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br from-amber-400/20 to-orange-500/20 mb-3">
              <svg className="w-7 h-7 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
            </div>
            <p className="text-lg font-bold mb-1">
              {uploading ? 'Enviando...' : 'Subir imagens, vídeos ou áudios'}
            </p>
            <p className="text-sm text-zinc-500">
              Vários arquivos de uma vez · imagem, vídeo ou áudio · máx 80MB cada
            </p>
            {progress && (
              <p className="text-amber-400 text-sm mt-3">
                {progress.done}/{progress.total} enviados
              </p>
            )}
          </label>

          <div className="mt-3 flex gap-2">
            {uploading ? <button type="button" className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-red-400 hover:text-red-300" onClick={() => uploadAbortRef.current?.abort()}>Cancelar envio</button> : null}
            {!uploading && retryFiles.length > 0 ? <button type="button" className="rounded-lg border border-amber-400/40 px-3 py-2 text-sm text-amber-300 hover:bg-amber-400/10" onClick={() => handleFiles(retryFiles)}>Retomar {retryFiles.length} arquivo{retryFiles.length > 1 ? 's' : ''}</button> : null}
          </div>

          {uploadError && <p className="text-sm text-red-400 mt-3">{uploadError}</p>}
        </div>

        {/* Grid */}
        <h2 className="text-2xl font-bold mb-6">
          {assets.length > 0 ? `${assets.length} asset${assets.length > 1 ? 's' : ''}` : 'Seus assets'}
        </h2>

        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-56 rounded-xl bg-zinc-800/50 animate-pulse" />
            ))}
          </div>
        ) : assets.length > 0 ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {assets.map((asset) => (
              <AssetCardItem
                key={asset.id}
                asset={asset}
                onDelete={() => handleDelete(asset)}
                onUpdated={(updated) =>
                  setAssets((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
                }
              />
            ))}
          </div>
        ) : (
          <div className="text-center py-12">
            <p className="text-zinc-400 mb-2">Nenhum asset ainda</p>
            <p className="text-sm text-zinc-500">Suba fotos e clipes para a IA usar nos vídeos</p>
          </div>
        )}
      </main>
    </div>
  )
}

function AssetCardItem({
  asset,
  onDelete,
  onUpdated
}: {
  asset: Asset
  onDelete: () => void
  onUpdated: (asset: Asset) => void
}) {
  const [label, setLabel] = useState(asset.label)
  const [tagsText, setTagsText] = useState(asset.tags.join(', '))
  const [saveState, setSaveState] = useState<SaveState>('idle')

  async function save(patch: { label?: string; tags?: string }) {
    try {
      setSaveState('saving')
      const response = await fetch(`/api/assets/${asset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.asset) {
        throw new Error(data?.error || 'Falha ao salvar')
      }
      onUpdated(data.asset)
      setLabel(data.asset.label)
      setTagsText(data.asset.tags.join(', '))
      setSaveState('idle')
    } catch (error) {
      console.error('Failed to update asset:', error)
      setSaveState('error')
    }
  }

  return (
    <div className="group rounded-xl bg-zinc-900/50 border border-zinc-800 overflow-hidden hover:border-amber-400/40 transition-colors">
      <div className="relative aspect-square bg-black overflow-hidden">
        {asset.kind === 'video' ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={asset.path}
            muted
            playsInline
            preload="metadata"
            className="w-full h-full object-cover"
          />
        ) : asset.kind === 'audio' ? (
          <div className="grid h-full place-items-center bg-zinc-950 p-4"><audio src={asset.path} controls preload="metadata" className="w-full"/></div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.path} alt={asset.label} className="w-full h-full object-cover" />
        )}
        <span className="absolute top-2 left-2 text-[10px] font-mono uppercase px-2 py-1 rounded bg-black/70 text-zinc-300">
          {asset.kind === 'video' ? '▶ vídeo' : asset.kind === 'audio' ? '♪ áudio' : 'imagem'}
        </span>
        <button
          type="button"
          onClick={onDelete}
          title="Excluir asset"
          aria-label={`Excluir ${asset.label}`}
          className="absolute top-2 right-2 p-1.5 rounded-lg text-zinc-300 bg-black/60 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-red-500/20 transition-all"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      <div className="p-3 space-y-2">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== asset.label && save({ label })}
          placeholder="Rótulo"
          className="w-full bg-transparent text-sm font-semibold text-white outline-none border-b border-transparent focus:border-amber-400/50 transition-colors py-0.5"
        />
        <input
          type="text"
          value={tagsText}
          onChange={(e) => setTagsText(e.target.value)}
          onBlur={() => tagsText !== asset.tags.join(', ') && save({ tags: tagsText })}
          placeholder="tags, separadas, por vírgula"
          className="w-full bg-transparent text-xs text-zinc-400 outline-none border-b border-transparent focus:border-amber-400/50 transition-colors py-0.5"
        />
        <div className="flex flex-wrap gap-1 min-h-[18px]">
          {asset.tags.map((tag) => (
            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
              {tag}
            </span>
          ))}
          {saveState === 'saving' && <span className="text-[10px] text-amber-400">salvando…</span>}
          {saveState === 'error' && <span className="text-[10px] text-red-400">erro ao salvar</span>}
        </div>
      </div>
    </div>
  )
}
