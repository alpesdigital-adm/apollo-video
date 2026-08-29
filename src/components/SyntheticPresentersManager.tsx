'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

interface ApiError { code: string; message: string }

interface PresenterSummary {
  profileId: string
  currentVersion: number
  status: 'active' | 'disabled' | 'expired'
  defaultLocale: string
  disclosure: string
  voice: { adapterId: string; adapterVersion: string; version: number }
  avatarAdapterId: string
  consent: { granted: boolean; expiresAt: string; revokedAt?: string }
  updatedAt: string
}

interface PresenterProfile {
  id: string
  version: number
  status: 'active' | 'disabled' | 'expired'
  actorIdentityId: string
  avatar: { adapterId: string; adapterVersion: string; identityRef: string }
  voice: { id: string; version: number; adapterId: string; adapterVersion: string }
  defaultLocale: string
  disclosure: string
  consent: {
    id: string
    evidenceArtifactId: string
    granted: boolean
    allowedUses: string[]
    allowedMarkets: string[]
    allowedLocales: string[]
    allowedOperations: string[]
    expiresAt: string
    revokedAt?: string
  }
  restrictions?: string[]
  visualContinuity?: { wardrobe?: string; background?: string; framing?: string }
  createdAt: string
}

interface PresenterDetail {
  profileId: string
  head: { currentVersion: number; currentSnapshotId: string; updatedAt: string }
  current: PresenterProfile
  versions: PresenterProfile[]
}

interface Eligibility {
  policyVersion: string
  allowed: boolean
  reasons: { code: string; message: string }[]
  profileVersion: number
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { data?: T; error?: ApiError } | null
  if (!response.ok || !payload || payload.error || payload.data === undefined) {
    const error = payload?.error ?? { code: `HTTP_${response.status}`, message: 'A requisição falhou' }
    throw Object.assign(new Error(error.message), { code: error.code, status: response.status })
  }
  return payload.data
}

function describeConsent(consent: PresenterSummary['consent']): string {
  if (!consent.granted) return 'Consentimento ausente'
  if (consent.revokedAt && Date.parse(consent.revokedAt) <= Date.now()) return `Consentimento revogado em ${consent.revokedAt.slice(0, 10)}`
  if (Date.parse(consent.expiresAt) <= Date.now()) return `Consentimento expirado em ${consent.expiresAt.slice(0, 10)}`
  return `Consentimento válido até ${consent.expiresAt.slice(0, 10)}`
}

const STATUS_LABEL: Record<PresenterSummary['status'], string> = {
  active: 'Ativo',
  disabled: 'Desativado',
  expired: 'Expirado',
}

const emptyCreateForm = {
  profileId: '', actorIdentityId: '', avatarAdapterId: 'heygen-v3', avatarAdapterVersion: '3.0.0', avatarIdentityRef: '',
  voiceId: '', voiceAdapterId: 'elevenlabs-tts', voiceAdapterVersion: '1.0.0',
  defaultLocale: 'pt-BR', disclosure: 'Conteúdo gerado com IA',
  consentId: '', consentEvidenceArtifactId: '', consentUses: 'ads', consentMarkets: 'BRA',
  consentLocales: 'pt-BR', consentExpiresAt: '',
}

const emptyConsentForm = {
  consentId: '', evidenceArtifactId: '', uses: 'ads', markets: 'BRA', locales: 'pt-BR', expiresAt: '',
}

const emptyEligibilityForm = { operation: 'tts', use: 'ads', market: 'BRA', locale: 'pt-BR' }

export default function SyntheticPresentersManager() {
  const router = useRouter()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [presenters, setPresenters] = useState<PresenterSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<PresenterDetail | null>(null)
  const [detailState, setDetailState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [actionError, setActionError] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [confirmingDeactivation, setConfirmingDeactivation] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [createForm, setCreateForm] = useState(emptyCreateForm)
  const [consentForm, setConsentForm] = useState(emptyConsentForm)
  const [showConsentForm, setShowConsentForm] = useState(false)
  const [eligibilityForm, setEligibilityForm] = useState(emptyEligibilityForm)
  const [eligibility, setEligibility] = useState<Eligibility | null>(null)
  const idempotency = useRef(new Map<string, string>())

  const keyFor = (action: string) => {
    const existing = idempotency.current.get(action)
    if (existing) return existing
    const key = `ui-${action}-${crypto.randomUUID()}`
    idempotency.current.set(action, key)
    return key
  }
  const consumeKey = (action: string) => idempotency.current.delete(action)

  const guard = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work()
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 401) {
        router.replace('/login?next=%2Fpresenters')
        return null
      }
      throw error
    }
  }, [router])

  const loadList = useCallback(async (workspace: string) => {
    const data = await readEnvelope<{ presenters: PresenterSummary[] }>(
      await fetch(`/v1/workspaces/${encodeURIComponent(workspace)}/synthetic-presenters`, { cache: 'no-store', headers: { accept: 'application/json' } }),
    )
    setPresenters(data.presenters)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const session = await readEnvelope<{ workspaceId: string }>(
          await fetch('/v1/session', { cache: 'no-store', headers: { accept: 'application/json' } }),
        )
        if (cancelled) return
        setWorkspaceId(session.workspaceId)
        await loadList(session.workspaceId)
        if (!cancelled) setState('ready')
      } catch (error) {
        if (cancelled) return
        const status = (error as { status?: number }).status
        if (status === 401) {
          router.replace('/login?next=%2Fpresenters')
          return
        }
        setLoadError((error as Error).message)
        setState('error')
      }
    })()
    return () => { cancelled = true }
  }, [loadList, router])

  const openDetail = useCallback(async (profileId: string) => {
    setSelectedId(profileId)
    setDetail(null)
    setEligibility(null)
    setActionError('')
    setConfirmingDeactivation(false)
    setDetailState('loading')
    try {
      const data = await guard(async () => readEnvelope<PresenterDetail>(
        await fetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/synthetic-presenters/${encodeURIComponent(profileId)}`, { cache: 'no-store', headers: { accept: 'application/json' } }),
      ))
      if (data) {
        setDetail(data)
        setDetailState('idle')
      }
    } catch (error) {
      setActionError((error as Error).message)
      setDetailState('error')
    }
  }, [guard, workspaceId])

  const refresh = useCallback(async () => {
    await loadList(workspaceId)
    if (selectedId) await openDetail(selectedId)
  }, [loadList, openDetail, selectedId, workspaceId])

  const runAction = useCallback(async (action: string, work: () => Promise<unknown>) => {
    setActionBusy(true)
    setActionError('')
    try {
      const outcome = await guard(work)
      if (outcome !== null) {
        consumeKey(action)
        await refresh()
      }
      return outcome !== null
    } catch (error) {
      const typed = error as Error & { code?: string }
      setActionError(`${typed.code ?? 'ERRO'}: ${typed.message}`)
      return false
    } finally {
      setActionBusy(false)
    }
  }, [guard, refresh])

  const csv = (value: string) => value.split(',').map((entry) => entry.trim()).filter(Boolean)

  const submitCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    const ok = await runAction('create', async () => readEnvelope(
      await fetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/synthetic-presenters`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': keyFor('create') },
        body: JSON.stringify({
          profileId: createForm.profileId,
          version: 1,
          actorIdentityId: createForm.actorIdentityId,
          avatar: { adapterId: createForm.avatarAdapterId, adapterVersion: createForm.avatarAdapterVersion, identityRef: createForm.avatarIdentityRef },
          voice: { id: createForm.voiceId, version: 1, adapterId: createForm.voiceAdapterId, adapterVersion: createForm.voiceAdapterVersion },
          defaultLocale: createForm.defaultLocale,
          status: 'active',
          disclosure: createForm.disclosure,
          consent: {
            id: createForm.consentId,
            evidenceArtifactId: createForm.consentEvidenceArtifactId,
            granted: true,
            allowedUses: csv(createForm.consentUses),
            allowedMarkets: csv(createForm.consentMarkets),
            allowedLocales: csv(createForm.consentLocales),
            allowedOperations: ['tts', 'audio-avatar'],
            expiresAt: createForm.consentExpiresAt,
          },
        }),
      }),
    ))
    if (ok) {
      setShowCreate(false)
      setCreateForm(emptyCreateForm)
    }
  }

  const submitConsent = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!detail) return
    const ok = await runAction('consent', async () => readEnvelope(
      await fetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/synthetic-presenters/${encodeURIComponent(detail.profileId)}/consent-proofs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': keyFor('consent') },
        body: JSON.stringify({
          baseRevision: detail.head.currentVersion,
          consent: {
            id: consentForm.consentId,
            evidenceArtifactId: consentForm.evidenceArtifactId,
            granted: true,
            allowedUses: csv(consentForm.uses),
            allowedMarkets: csv(consentForm.markets),
            allowedLocales: csv(consentForm.locales),
            allowedOperations: ['tts', 'audio-avatar'],
            expiresAt: consentForm.expiresAt,
          },
        }),
      }),
    ))
    if (ok) {
      setShowConsentForm(false)
      setConsentForm(emptyConsentForm)
    }
  }

  const activate = async () => {
    if (!detail) return
    await runAction('activation', async () => readEnvelope(
      await fetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/synthetic-presenters/${encodeURIComponent(detail.profileId)}/activation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': keyFor('activation') },
        body: JSON.stringify({ baseRevision: detail.head.currentVersion }),
      }),
    ))
  }

  const deactivate = async () => {
    if (!detail) return
    await runAction('deactivation', async () => readEnvelope(
      await fetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/synthetic-presenters/${encodeURIComponent(detail.profileId)}/deactivation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': keyFor('deactivation') },
        body: JSON.stringify({ baseRevision: detail.head.currentVersion }),
      }),
    ))
    setConfirmingDeactivation(false)
  }

  const submitEligibility = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!detail) return
    setActionError('')
    try {
      const verdict = await guard(async () => readEnvelope<Eligibility>(
        await fetch(`/v1/workspaces/${encodeURIComponent(workspaceId)}/synthetic-presenters/${encodeURIComponent(detail.profileId)}/eligibility-evaluations`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(eligibilityForm),
        }),
      ))
      if (verdict) setEligibility(verdict)
    } catch (error) {
      const typed = error as Error & { code?: string }
      setActionError(`${typed.code ?? 'ERRO'}: ${typed.message}`)
    }
  }

  if (state === 'loading') {
    return <p role="status" data-testid="presenters-loading">Carregando apresentadores sintéticos…</p>
  }
  if (state === 'error') {
    return (
      <div role="alert" data-testid="presenters-error">
        <p>Falha ao carregar os apresentadores: {loadError}</p>
        <button type="button" onClick={() => window.location.reload()}>Tentar novamente</button>
      </div>
    )
  }

  const field = (id: string, label: string, value: string, onChange: (next: string) => void, extra: Record<string, unknown> = {}) => (
    <label htmlFor={id} style={{ display: 'block', marginBottom: 8 }}>
      <span style={{ display: 'block', fontWeight: 600 }}>{label}</span>
      <input id={id} name={id} value={value} required onChange={(event) => onChange(event.target.value)} style={{ width: '100%', maxWidth: 420 }} {...extra} />
    </label>
  )

  return (
    <main data-testid="presenters-manager" style={{ display: 'grid', gap: 24, gridTemplateColumns: 'minmax(280px, 380px) 1fr', alignItems: 'start' }}>
      <section aria-label="Apresentadores sintéticos">
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Apresentadores sintéticos</h1>
          <button type="button" data-testid="presenter-create-toggle" onClick={() => setShowCreate((current) => !current)}>
            {showCreate ? 'Fechar formulário' : 'Criar profile'}
          </button>
        </header>
        {presenters.length === 0 && !showCreate && (
          <p data-testid="presenters-empty">Nenhum apresentador cadastrado neste workspace ainda.</p>
        )}
        <ul data-testid="presenters-list" style={{ listStyle: 'none', padding: 0, display: 'grid', gap: 8 }}>
          {presenters.map((presenter) => (
            <li key={presenter.profileId}>
              <button
                type="button"
                data-testid={`presenter-card-${presenter.profileId}`}
                onClick={() => void openDetail(presenter.profileId)}
                aria-pressed={selectedId === presenter.profileId}
                style={{ width: '100%', textAlign: 'left', padding: 12, border: '1px solid currentColor', borderRadius: 8 }}
              >
                <strong>{presenter.profileId}</strong> · v{presenter.currentVersion}
                <br />
                <span data-testid={`presenter-status-${presenter.profileId}`}>{STATUS_LABEL[presenter.status]}</span>
                {' · '}{presenter.defaultLocale} · voz {presenter.voice.adapterId}
                <br />
                <span>{describeConsent(presenter.consent)}</span>
              </button>
            </li>
          ))}
        </ul>
        {showCreate && (
          <form onSubmit={submitCreate} data-testid="presenter-create-form" aria-label="Criar apresentador sintético" style={{ marginTop: 16 }}>
            {field('profileId', 'Identificador do profile', createForm.profileId, (value) => setCreateForm({ ...createForm, profileId: value }))}
            {field('actorIdentityId', 'Identidade do ator real', createForm.actorIdentityId, (value) => setCreateForm({ ...createForm, actorIdentityId: value }))}
            {field('avatarIdentityRef', 'Referência do avatar no provider', createForm.avatarIdentityRef, (value) => setCreateForm({ ...createForm, avatarIdentityRef: value }))}
            {field('voiceId', 'Voz no provider', createForm.voiceId, (value) => setCreateForm({ ...createForm, voiceId: value }))}
            {field('defaultLocale', 'Locale padrão', createForm.defaultLocale, (value) => setCreateForm({ ...createForm, defaultLocale: value }))}
            {field('disclosure', 'Disclosure obrigatório', createForm.disclosure, (value) => setCreateForm({ ...createForm, disclosure: value }))}
            {field('consentId', 'Identificador do consentimento', createForm.consentId, (value) => setCreateForm({ ...createForm, consentId: value }))}
            {field('consentEvidenceArtifactId', 'Artifact da prova de consentimento', createForm.consentEvidenceArtifactId, (value) => setCreateForm({ ...createForm, consentEvidenceArtifactId: value }))}
            {field('consentUses', 'Usos permitidos (separados por vírgula)', createForm.consentUses, (value) => setCreateForm({ ...createForm, consentUses: value }))}
            {field('consentMarkets', 'Mercados permitidos', createForm.consentMarkets, (value) => setCreateForm({ ...createForm, consentMarkets: value }))}
            {field('consentLocales', 'Locales permitidos', createForm.consentLocales, (value) => setCreateForm({ ...createForm, consentLocales: value }))}
            {field('consentExpiresAt', 'Consentimento expira em (ISO)', createForm.consentExpiresAt, (value) => setCreateForm({ ...createForm, consentExpiresAt: value }), { placeholder: '2030-01-01T00:00:00.000Z' })}
            <button type="submit" data-testid="presenter-create-submit" disabled={actionBusy}>Registrar profile v1</button>
          </form>
        )}
      </section>

      <section aria-label="Detalhe do apresentador" aria-live="polite">
        {actionError && (
          <p role="alert" data-testid="presenter-action-error" style={{ border: '1px solid currentColor', padding: 8, borderRadius: 8 }}>
            {actionError}
          </p>
        )}
        {!selectedId && <p data-testid="presenter-detail-empty">Selecione um apresentador para ver o histórico e operar o ciclo de vida.</p>}
        {detailState === 'loading' && <p role="status">Carregando detalhe…</p>}
        {detailState === 'error' && selectedId && (
          <div role="alert">
            <p>Falha ao carregar {selectedId}.</p>
            <button type="button" onClick={() => void openDetail(selectedId)}>Tentar novamente</button>
          </div>
        )}
        {detail && (
          <article data-testid="presenter-detail">
            <h2 style={{ marginTop: 0 }}>{detail.profileId} · v{detail.head.currentVersion}</h2>
            <p data-testid="presenter-detail-status">
              Status atual: {STATUS_LABEL[detail.current.status]} · {describeConsent(detail.current.consent)}
            </p>
            <p>Disclosure exigido: <strong data-testid="presenter-detail-disclosure">{detail.current.disclosure}</strong></p>
            <p>
              Ator: {detail.current.actorIdentityId} · Avatar: {detail.current.avatar.adapterId}@{detail.current.avatar.adapterVersion}
              {' · '}Voz: {detail.current.voice.adapterId}@{detail.current.voice.adapterVersion} (v{detail.current.voice.version})
            </p>
            <p>
              Usos: {detail.current.consent.allowedUses.join(', ')} · Mercados: {detail.current.consent.allowedMarkets.join(', ')}
              {' · '}Locales: {detail.current.consent.allowedLocales.join(', ')}
            </p>
            {detail.current.restrictions && detail.current.restrictions.length > 0 && (
              <p data-testid="presenter-detail-restrictions">Restrições: {detail.current.restrictions.join(' · ')}</p>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
              {detail.current.status !== 'active' && (
                <button type="button" data-testid="presenter-activate" disabled={actionBusy} onClick={() => void activate()}>
                  Ativar
                </button>
              )}
              {detail.current.status === 'active' && !confirmingDeactivation && (
                <button type="button" data-testid="presenter-deactivate" disabled={actionBusy} onClick={() => setConfirmingDeactivation(true)}>
                  Desativar…
                </button>
              )}
              {confirmingDeactivation && (
                <>
                  <button type="button" data-testid="presenter-deactivate-confirm" disabled={actionBusy} onClick={() => void deactivate()}>
                    Confirmar desativação
                  </button>
                  <button type="button" onClick={() => setConfirmingDeactivation(false)}>Cancelar</button>
                </>
              )}
              <button type="button" data-testid="presenter-consent-toggle" onClick={() => setShowConsentForm((current) => !current)}>
                {showConsentForm ? 'Fechar consentimento' : 'Registrar novo consentimento'}
              </button>
            </div>

            {showConsentForm && (
              <form onSubmit={submitConsent} data-testid="presenter-consent-form" aria-label="Registrar prova de consentimento">
                {field('newConsentId', 'Identificador do consentimento', consentForm.consentId, (value) => setConsentForm({ ...consentForm, consentId: value }))}
                {field('newConsentEvidence', 'Artifact da prova', consentForm.evidenceArtifactId, (value) => setConsentForm({ ...consentForm, evidenceArtifactId: value }))}
                {field('newConsentUses', 'Usos permitidos', consentForm.uses, (value) => setConsentForm({ ...consentForm, uses: value }))}
                {field('newConsentMarkets', 'Mercados permitidos', consentForm.markets, (value) => setConsentForm({ ...consentForm, markets: value }))}
                {field('newConsentLocales', 'Locales permitidos', consentForm.locales, (value) => setConsentForm({ ...consentForm, locales: value }))}
                {field('newConsentExpiresAt', 'Expira em (ISO)', consentForm.expiresAt, (value) => setConsentForm({ ...consentForm, expiresAt: value }), { placeholder: '2031-01-01T00:00:00.000Z' })}
                <button type="submit" data-testid="presenter-consent-submit" disabled={actionBusy}>Anexar prova de consentimento</button>
              </form>
            )}

            <form onSubmit={submitEligibility} data-testid="presenter-eligibility-form" aria-label="Avaliar elegibilidade" style={{ marginTop: 16 }}>
              <label htmlFor="eligibilityOperation" style={{ display: 'block', marginBottom: 8 }}>
                <span style={{ display: 'block', fontWeight: 600 }}>Operação</span>
                <select
                  id="eligibilityOperation"
                  value={eligibilityForm.operation}
                  onChange={(event) => setEligibilityForm({ ...eligibilityForm, operation: event.target.value })}
                >
                  <option value="tts">tts</option>
                  <option value="audio-avatar">audio-avatar</option>
                  <option value="voice-clone">voice-clone (não classificada)</option>
                  <option value="lip-sync">lip-sync (não classificada)</option>
                </select>
              </label>
              {field('eligibilityUse', 'Uso', eligibilityForm.use, (value) => setEligibilityForm({ ...eligibilityForm, use: value }))}
              {field('eligibilityMarket', 'Mercado', eligibilityForm.market, (value) => setEligibilityForm({ ...eligibilityForm, market: value }))}
              {field('eligibilityLocale', 'Locale', eligibilityForm.locale, (value) => setEligibilityForm({ ...eligibilityForm, locale: value }))}
              <button type="submit" data-testid="presenter-eligibility-submit" disabled={actionBusy}>Avaliar elegibilidade</button>
            </form>
            {eligibility && (
              <div data-testid="presenter-eligibility-result" role="status" style={{ marginTop: 8 }}>
                <p>
                  Veredito: <strong>{eligibility.allowed ? 'Elegível' : 'Não elegível'}</strong> (v{eligibility.profileVersion})
                </p>
                {eligibility.reasons.length > 0 && (
                  <ul>
                    {eligibility.reasons.map((reason) => (
                      <li key={reason.code}><code>{reason.code}</code>: {reason.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <h3>Histórico de versões</h3>
            <table data-testid="presenter-versions" style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th scope="col" style={{ textAlign: 'left', padding: 4 }}>Versão</th>
                  <th scope="col" style={{ textAlign: 'left', padding: 4 }}>Status</th>
                  <th scope="col" style={{ textAlign: 'left', padding: 4 }}>Voz</th>
                  <th scope="col" style={{ textAlign: 'left', padding: 4 }}>Consentimento</th>
                  <th scope="col" style={{ textAlign: 'left', padding: 4 }}>Criada em</th>
                </tr>
              </thead>
              <tbody>
                {detail.versions.map((version) => (
                  <tr key={version.version} data-testid={`presenter-version-${version.version}`}>
                    <td style={{ padding: 4 }}>v{version.version}</td>
                    <td style={{ padding: 4 }}>{STATUS_LABEL[version.status]}</td>
                    <td style={{ padding: 4 }}>{version.voice.id} (v{version.voice.version})</td>
                    <td style={{ padding: 4 }}>{describeConsent(version.consent)}</td>
                    <td style={{ padding: 4 }}>{version.createdAt.slice(0, 19).replace('T', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        )}
      </section>
    </main>
  )
}
