'use client'

import Image from 'next/image'
import { useEffect, useMemo, useState, type FormEvent } from 'react'

type LutStatus = 'active' | 'inactive'
type ColorSpace = 'rec709' | 'display-p3' | 'rec2020'
type LicensePolicy = 'owned' | 'licensed' | 'restricted'

interface WorkspaceLut {
  id: string
  workspaceId: string
  status: LutStatus
  currentVersion: {
    id: string
    version: number
    name: string
    owner: string
    license: { policy: LicensePolicy; name: string; usageNotes?: string }
    tags: string[]
    compatibility: { inputColorSpace: ColorSpace; outputColorSpace: ColorSpace }
    intensity: { default: number; min: 0; max: 1 }
    cube: { title?: string; size: number; rows: number; contentHash: string }
    preview: { path: string; width: number; height: number; sha256: string }
    createdAt: string
  }
}

interface WorkspaceLutDefault {
  workspaceId: string
  revision: number
  current: null | {
    id: string
    revision: number
    mode: 'none' | 'lut-version'
    lut?: { id: string; version: number; name: string }
  }
}

interface ApiEnvelope<T> { data?: T; error?: { message?: string } }

const COLOR_SPACE_LABELS: Record<ColorSpace, string> = {
  rec709: 'Rec. 709',
  'display-p3': 'Display P3',
  rec2020: 'Rec. 2020',
}
const LICENSE_LABELS: Record<LicensePolicy, string> = {
  owned: 'Própria',
  licensed: 'Licenciada',
  restricted: 'Uso restrito',
}
const inputClass = 'w-full border border-white/[0.1] bg-[#0a0a0a] px-3 py-2.5 text-xs text-[#e2ddd4] outline-none transition placeholder:text-[#555149] focus:border-[#c6a15a]/60'
const buttonClass = 'border border-white/[0.11] bg-white/[0.035] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#d8d2c8] transition hover:border-[#c6a15a]/55 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c6a15a] disabled:cursor-not-allowed disabled:opacity-35'

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiEnvelope<T>
  if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'A operação não foi concluída.')
  return payload.data
}

function idempotencyKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

function shortHash(value: string): string { return `${value.slice(0, 7)}…${value.slice(-5)}` }

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' }).format(new Date(value))
}

function LutPreview({ lut, label }: Readonly<{ lut?: WorkspaceLut; label: string }>) {
  return (
    <figure className="min-w-0 bg-[#080808]" data-testid={`lut-compare-${label.toLowerCase()}`}>
      <div className="relative aspect-video overflow-hidden bg-[linear-gradient(135deg,#171717,#090909)]">
        {lut ? <Image alt={`Preview da LUT ${lut.currentVersion.name}`} className="object-cover" fill priority={label === 'A'} sizes="(min-width: 1280px) 34vw, 90vw" src={lut.currentVersion.preview.path} unoptimized /> : <div className="grid h-full place-items-center text-[10px] uppercase tracking-[0.18em] text-[#5f5a52]">Selecione uma LUT</div>}
        <span className="absolute left-3 top-3 border border-white/15 bg-black/65 px-2 py-1 font-mono text-[10px] text-white backdrop-blur">{label}</span>
      </div>
      <figcaption className="border-t border-white/[0.07] px-4 py-3">
        <p className="truncate text-sm font-medium text-[#e5dfd5]">{lut?.currentVersion.name ?? 'Sem seleção'}</p>
        <p className="mt-1 text-[10px] text-[#716b62]">{lut ? `${COLOR_SPACE_LABELS[lut.currentVersion.compatibility.inputColorSpace]} → ${COLOR_SPACE_LABELS[lut.currentVersion.compatibility.outputColorSpace]} · intensidade ${Math.round(lut.currentVersion.intensity.default * 100)}%` : 'Escolha uma referência no seletor acima.'}</p>
      </figcaption>
    </figure>
  )
}

export default function WorkspaceLutLibrary() {
  const [workspaceId, setWorkspaceId] = useState('')
  const [luts, setLuts] = useState<WorkspaceLut[]>([])
  const [workspaceDefault, setWorkspaceDefault] = useState<WorkspaceLutDefault | null>(null)
  const [compareA, setCompareA] = useState('')
  const [compareB, setCompareB] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [owner, setOwner] = useState('')
  const [licensePolicy, setLicensePolicy] = useState<LicensePolicy>('owned')
  const [licenseName, setLicenseName] = useState('Uso próprio')
  const [usageNotes, setUsageNotes] = useState('')
  const [tags, setTags] = useState('')
  const [inputColorSpace, setInputColorSpace] = useState<ColorSpace>('rec709')
  const [outputColorSpace, setOutputColorSpace] = useState<ColorSpace>('rec709')
  const [intensity, setIntensity] = useState(100)

  useEffect(() => {
    const controller = new AbortController()
    setState('loading')
    void fetch('/v1/session', { cache: 'no-store', signal: controller.signal })
      .then((response) => readJson<{ workspaceId: string }>(response))
      .then(async (session) => {
        const encodedWorkspaceId = encodeURIComponent(session.workspaceId)
        const [listResult, defaultResult] = await Promise.all([
          fetch(`/v1/workspaces/${encodedWorkspaceId}/luts?limit=100`, { cache: 'no-store', signal: controller.signal }).then((response) => readJson<{ items: WorkspaceLut[] }>(response)),
          fetch(`/v1/workspaces/${encodedWorkspaceId}/lut-default`, { cache: 'no-store', signal: controller.signal }).then((response) => readJson<{ default: WorkspaceLutDefault }>(response)),
        ])
        setWorkspaceId(session.workspaceId)
        setLuts(listResult.items)
        setWorkspaceDefault(defaultResult.default)
        const active = listResult.items.filter((item) => item.status === 'active')
        setCompareA((current) => active.some((item) => item.id === current) ? current : active[0]?.id ?? '')
        setCompareB((current) => active.some((item) => item.id === current) ? current : active[1]?.id ?? active[0]?.id ?? '')
        setState('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setMessage(error instanceof Error ? error.message : 'Não foi possível ler a biblioteca de LUTs.')
        setMessageTone('error')
        setState('error')
      })
    return () => controller.abort()
  }, [refreshVersion])

  const activeLuts = useMemo(() => luts.filter((item) => item.status === 'active'), [luts])
  const selectedA = activeLuts.find((item) => item.id === compareA)
  const selectedB = activeLuts.find((item) => item.id === compareB)
  const currentDefaultId = workspaceDefault?.current?.mode === 'lut-version' ? workspaceDefault.current.lut?.id : undefined

  async function mutate(key: string, operation: () => Promise<void>, success: string) {
    setBusy(key)
    setMessage('')
    setMessageTone('info')
    try {
      await operation()
      setMessage(success)
      setRefreshVersion((version) => version + 1)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A operação não foi concluída.')
      setMessageTone('error')
    } finally {
      setBusy('')
    }
  }

  async function importLut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!workspaceId || !file) return
    if (!file.name.toLocaleLowerCase('en-US').endsWith('.cube')) {
      setMessage('Escolha um arquivo com extensão .cube.')
      setMessageTone('error')
      return
    }
    if (file.size > 8 * 1024 * 1024) {
      setMessage('O arquivo .cube deve ter no máximo 8 MiB.')
      setMessageTone('error')
      return
    }
    const cubeContent = await file.text()
    await mutate('import', async () => {
      const workspacePathId = encodeURIComponent(workspaceId)
      await readJson<{ lut: WorkspaceLut }>(await fetch(`/v1/workspaces/${workspacePathId}/luts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey('ui-lut-import') },
        body: JSON.stringify({
          lutId: `lut-${globalThis.crypto.randomUUID()}`,
          name: name.trim(), owner: owner.trim(),
          license: { policy: licensePolicy, name: licenseName.trim(), ...(usageNotes.trim() ? { usageNotes: usageNotes.trim() } : {}) },
          tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
          compatibility: { inputColorSpace, outputColorSpace }, intensity: intensity / 100, cubeContent,
        }),
      }))
      setFile(null)
      setName('')
      setTags('')
      const picker = document.getElementById('workspace-lut-file') as HTMLInputElement | null
      if (picker) picker.value = ''
    }, 'LUT validada, versionada e adicionada à biblioteca.')
  }

  async function changeStatus(lut: WorkspaceLut, status: LutStatus) {
    if (!workspaceId) return
    await mutate(`status-${lut.id}`, async () => {
      const lifecycle = await readJson<{ lifecycle: { revision: number } }>(await fetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/luts/${encodeURIComponent(lut.id)}/status`, { cache: 'no-store' }))
      await readJson(await fetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/luts/${encodeURIComponent(lut.id)}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey('ui-lut-status') },
        body: JSON.stringify({ baseRevision: lifecycle.lifecycle.revision, status }),
      }))
    }, status === 'active' ? 'LUT reativada sem alterar a versão.' : 'LUT removida das novas seleções. Versões antigas continuam reproduzíveis.')
  }

  async function setDefault(lut?: WorkspaceLut) {
    if (!workspaceId || !workspaceDefault) return
    await mutate(`default-${lut?.id ?? 'none'}`, async () => {
      await readJson(await fetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/lut-default`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey('ui-lut-default') },
        body: JSON.stringify({
          baseRevision: workspaceDefault.revision,
          selection: lut ? { mode: 'lut-version', lutId: lut.id, version: lut.currentVersion.version } : { mode: 'none' },
        }),
      }))
    }, lut ? `${lut.currentVersion.name} definida como padrão do workspace.` : 'Workspace configurado explicitamente sem LUT criativa.')
  }

  return (
    <section className="mt-14 border-t border-white/[0.08] pt-10" data-testid="workspace-lut-library">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#b18b35]">Mesa de cor</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-[-0.035em] text-[#f4f1ea]">Biblioteca de LUTs</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[#8f8a81]">Compare a mesma carta de referência, defina o padrão do workspace e retire LUTs de novas seleções sem apagar o histórico.</p>
        </div>
        <div className="grid grid-cols-3 border border-white/[0.08] bg-[#0a0a0a]">
          {[[activeLuts.length, 'ativas'], [luts.length - activeLuts.length, 'arquivadas'], [workspaceDefault?.revision ?? 0, 'revisão padrão']].map(([value, label]) => <div className="min-w-[106px] border-r border-white/[0.08] px-4 py-3 last:border-r-0" key={label}><p className="font-mono text-xl text-[#e5ded2]">{value}</p><p className="mt-1 text-[9px] uppercase tracking-[0.12em] text-[#716c64]">{label}</p></div>)}
        </div>
      </div>

      {message ? <div className={`mt-6 border px-4 py-3 text-xs ${messageTone === 'error' ? 'border-[#a44d4d]/30 bg-[#a44d4d]/10 text-[#dc8c8c]' : 'border-[#b18b35]/25 bg-[#b18b35]/[0.07] text-[#d6b766]'}`} role={messageTone === 'error' ? 'alert' : 'status'}>{message}</div> : null}

      <div className="mt-7 grid gap-px border border-white/[0.08] bg-white/[0.08] xl:grid-cols-[1fr_1fr_280px]" data-testid="lut-comparison-table">
        <div className="bg-[#090909] p-4"><label className="mb-3 block text-[9px] font-semibold uppercase tracking-[0.16em] text-[#716b62]" htmlFor="lut-compare-a">Referência A</label><select className={inputClass} id="lut-compare-a" onChange={(event) => setCompareA(event.target.value)} value={compareA}><option value="">Escolha uma LUT</option>{activeLuts.map((lut) => <option key={lut.id} value={lut.id}>{lut.currentVersion.name} · v{lut.currentVersion.version}</option>)}</select><div className="mt-4"><LutPreview label="A" lut={selectedA} /></div></div>
        <div className="bg-[#090909] p-4"><label className="mb-3 block text-[9px] font-semibold uppercase tracking-[0.16em] text-[#716b62]" htmlFor="lut-compare-b">Referência B</label><select className={inputClass} id="lut-compare-b" onChange={(event) => setCompareB(event.target.value)} value={compareB}><option value="">Escolha uma LUT</option>{activeLuts.map((lut) => <option key={lut.id} value={lut.id}>{lut.currentVersion.name} · v{lut.currentVersion.version}</option>)}</select><div className="mt-4"><LutPreview label="B" lut={selectedB} /></div></div>
        <aside className="bg-[#0a0a0a] p-5">
          <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-[#716b62]">Padrão do workspace</p>
          <p className="mt-3 text-base font-medium text-[#e1dbd1]">{workspaceDefault?.current?.mode === 'lut-version' ? workspaceDefault.current.lut?.name : 'Sem LUT'}</p>
          <p className="mt-2 text-[10px] leading-5 text-[#6f6960]">A seleção fica presa à versão imutável. Alterar o padrão não reescreve projetos antigos.</p>
          <button className={`${buttonClass} mt-5 w-full`} disabled={busy !== '' || workspaceDefault?.current?.mode === 'none'} onClick={() => void setDefault()} type="button">Usar sem LUT</button>
        </aside>
      </div>

      <div className="mt-px border border-white/[0.08] bg-[#090909]" data-testid="lut-library-list">
        {state === 'loading' ? <p className="p-6 text-xs text-[#706a62]" role="status">Lendo versões e previews…</p> : null}
        {state === 'error' ? <div className="p-6"><p className="text-xs text-[#d58c8c]">A biblioteca não pôde ser carregada.</p><button className={`${buttonClass} mt-4`} onClick={() => setRefreshVersion((version) => version + 1)} type="button">Tentar novamente</button></div> : null}
        {state === 'ready' && luts.length === 0 ? <p className="p-6 text-xs leading-5 text-[#706a62]">Importe a primeira LUT .cube. O servidor validará toda a tabela antes de criar o preview.</p> : null}
        {luts.map((lut) => <article className="grid gap-5 border-b border-white/[0.07] p-5 last:border-b-0 lg:grid-cols-[120px_1fr_auto] lg:items-center" key={lut.id}>
          <div className="relative aspect-video overflow-hidden border border-white/[0.08] bg-[#111]"><Image alt={`Preview de ${lut.currentVersion.name}`} className="object-cover" fill sizes="120px" src={lut.currentVersion.preview.path} unoptimized /></div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-medium text-[#ddd7cd]">{lut.currentVersion.name}</h3><span className={`border px-2 py-0.5 text-[8px] font-semibold uppercase tracking-[0.12em] ${lut.status === 'active' ? 'border-[#4d8f73]/35 text-[#8bc7aa]' : 'border-white/[0.1] text-[#777168]'}`}>{lut.status === 'active' ? 'ativa' : 'arquivada'}</span>{currentDefaultId === lut.id ? <span className="border border-[#b18b35]/35 px-2 py-0.5 text-[8px] font-semibold uppercase tracking-[0.12em] text-[#d6b766]">padrão</span> : null}</div>
            <p className="mt-2 text-[10px] text-[#777168]">v{lut.currentVersion.version} · {lut.currentVersion.owner} · {LICENSE_LABELS[lut.currentVersion.license.policy]} · {lut.currentVersion.cube.size}³ ({lut.currentVersion.cube.rows} pontos)</p>
            <p className="mt-1 font-mono text-[9px] text-[#5f5a53]">{shortHash(lut.currentVersion.cube.contentHash)} · {formatDate(lut.currentVersion.createdAt)}</p>
            {lut.currentVersion.tags.length ? <div className="mt-2 flex flex-wrap gap-1">{lut.currentVersion.tags.map((tag) => <span className="bg-white/[0.035] px-2 py-1 text-[8px] uppercase tracking-[0.1em] text-[#777168]" key={tag}>{tag}</span>)}</div> : null}
          </div>
          <div className="flex flex-wrap gap-2 lg:max-w-[260px] lg:justify-end">
            {lut.status === 'active' && currentDefaultId !== lut.id ? <button className={buttonClass} disabled={busy !== ''} onClick={() => void setDefault(lut)} type="button">Definir padrão</button> : null}
            {lut.status === 'active' && currentDefaultId !== lut.id ? <button className={buttonClass} disabled={busy !== ''} onClick={() => void changeStatus(lut, 'inactive')} type="button">Retirar</button> : null}
            {lut.status === 'active' && currentDefaultId === lut.id ? <span className="max-w-[190px] text-right text-[9px] leading-4 text-[#756f66]">Troque o padrão antes de retirar.</span> : null}
            {lut.status === 'inactive' ? <button className={buttonClass} disabled={busy !== ''} onClick={() => void changeStatus(lut, 'active')} type="button">Reativar</button> : null}
          </div>
        </article>)}
      </div>

      <details className="mt-7 border border-white/[0.08] bg-[#0a0a0a]" data-testid="lut-import-panel">
        <summary className="cursor-pointer list-none px-5 py-4 text-xs font-semibold text-[#d7d1c7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c6a15a]">Adicionar arquivo .cube <span className="ml-2 font-normal text-[#69645c]">até 8 MiB · 3D · tamanho 2–65</span></summary>
        <form className="grid gap-4 border-t border-white/[0.07] p-5 md:grid-cols-2 xl:grid-cols-4" onSubmit={(event) => void importLut(event)}>
          <label className="xl:col-span-2"><span className="mb-1.5 block text-[9px] uppercase tracking-[0.14em] text-[#716b62]">Arquivo .cube</span><input accept=".cube,text/plain" className={`${inputClass} file:mr-3 file:border-0 file:bg-[#211c13] file:px-2 file:py-1 file:text-[10px] file:text-[#d2b56f]`} id="workspace-lut-file" onChange={(event) => { const selected = event.target.files?.[0] ?? null; setFile(selected); if (selected && !name) setName(selected.name.replace(/\.cube$/i, '')) }} required type="file" /></label>
          <label><span className="mb-1.5 block text-[9px] uppercase tracking-[0.14em] text-[#716b62]">Nome</span><input className={inputClass} maxLength={160} onChange={(event) => setName(event.target.value)} required value={name} /></label>
          <label><span className="mb-1.5 block text-[9px] uppercase tracking-[0.14em] text-[#716b62]">Owner</span><input className={inputClass} maxLength={240} onChange={(event) => setOwner(event.target.value)} required value={owner} /></label>
          <label><span className="mb-1.5 block text-[9px] uppercase tracking-[0.14em] text-[#716b62]">Licença</span><select className={inputClass} onChange={(event) => setLicensePolicy(event.target.value as LicensePolicy)} value={licensePolicy}><option value="owned">Própria</option><option value="licensed">Licenciada</option><option value="restricted">Uso restrito</option></select></label>
          <label><span className="mb-1.5 block text-[9px] uppercase tracking-[0.14em] text-[#716b62]">Nome da licença</span><input className={inputClass} maxLength={240} onChange={(event) => setLicenseName(event.target.value)} required value={licenseName} /></label>
          <label><span className="mb-1.5 block text-[9px] uppercase tracking-[0.14em] text-[#716b62]">Entrada</span><select className={inputClass} onChange={(event) => setInputColorSpace(event.target.value as ColorSpace)} value={inputColorSpace}>{Object.entries(COLOR_SPACE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span className="mb-1.5 block text-[9px] uppercase tracking-[0.14em] text-[#716b62]">Saída</span><select className={inputClass} onChange={(event) => setOutputColorSpace(event.target.value as ColorSpace)} value={outputColorSpace}>{Object.entries(COLOR_SPACE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label><span className="mb-1.5 block text-[9px] uppercase tracking-[0.14em] text-[#716b62]">Intensidade padrão · {intensity}%</span><input className="mt-2 w-full accent-[#c6a15a]" max={100} min={0} onChange={(event) => setIntensity(Number(event.target.value))} type="range" value={intensity} /></label>
          <label><span className="mb-1.5 block text-[9px] uppercase tracking-[0.14em] text-[#716b62]">Tags separadas por vírgula</span><input className={inputClass} onChange={(event) => setTags(event.target.value)} placeholder="cinema, pele, noturno" value={tags} /></label>
          <label className="md:col-span-2"><span className="mb-1.5 block text-[9px] uppercase tracking-[0.14em] text-[#716b62]">Notas de uso</span><input className={inputClass} maxLength={2000} onChange={(event) => setUsageNotes(event.target.value)} placeholder="Restrições territoriais ou de campanha" value={usageNotes} /></label>
          <div className="flex items-end md:col-span-2"><button className={`${buttonClass} w-full`} disabled={busy !== '' || !file || !name.trim() || !owner.trim() || !licenseName.trim()} type="submit">Validar e adicionar LUT</button></div>
        </form>
      </details>
    </section>
  )
}
