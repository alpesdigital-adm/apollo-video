'use client'

import { useEffect, useMemo, useState } from 'react'

type EndpointStatus = 'pending-verification' | 'active' | 'suspended' | 'revoked'
type SubscriptionStatus = 'pending-verification' | 'active' | 'paused' | 'revoked'
type DeliveryStatus = 'pending' | 'in-flight' | 'retry-scheduled' | 'succeeded' | 'dead-lettered'

interface Endpoint {
  id: string
  status: EndpointStatus
  revision: string
  destinationOrigin: string
  urlFingerprint: string
  createdAt: string
  verifiedAt?: string
  currentSigningSecret?: { version: number; fingerprint: string; status: string; createdAt: string }
}

interface Subscription {
  id: string
  endpointId: string
  status: SubscriptionStatus
  revision: string
  eventTypes: string[]
  resourceIds?: string[]
  createdAt: string
}

interface Delivery {
  id: string
  endpointId: string
  subscriptionId: string
  eventId: string
  status: DeliveryStatus
  attemptCount: number
  maxAttempts: number
  nextAttemptAt: string
  createdAt: string
  completedAt?: string
  deadLetteredAt?: string
}

interface DeliveryAttempt {
  id: string
  attemptNumber: number
  status: 'scheduled' | 'in-flight' | 'succeeded' | 'failed'
  scheduledAt: string
  createdAt: string
  startedAt?: string
  completedAt?: string
  responseStatus?: number
  errorCode?: string
}

interface Rotation {
  id: string
  endpointId: string
  candidateVersion: number
  fingerprint: string
  status: 'staged' | 'activated' | 'cancelled' | 'expired'
  overlapSeconds: number
  baseRevision: string
  createdAt: string
  expiresAt: string
  overlapUntil?: string
}

interface CatalogEvent { type: string; description: string }
interface ApiEnvelope<T> { data?: T; error?: { message?: string } }

const STATUS_LABELS: Record<string, string> = {
  'pending-verification': 'aguardando verificação', active: 'ativo', suspended: 'suspenso',
  revoked: 'revogado', paused: 'pausada', pending: 'na fila', 'in-flight': 'enviando',
  'retry-scheduled': 'retry agendado', succeeded: 'entregue', 'dead-lettered': 'dead-letter',
  staged: 'preparada', activated: 'ativada', cancelled: 'cancelada', expired: 'expirada',
  scheduled: 'agendada', failed: 'falhou',
}

const STATUS_TONES: Record<string, string> = {
  active: 'border-[#4d8f73]/35 bg-[#4d8f73]/10 text-[#8bc7aa]',
  succeeded: 'border-[#4d8f73]/35 bg-[#4d8f73]/10 text-[#8bc7aa]',
  activated: 'border-[#4d8f73]/35 bg-[#4d8f73]/10 text-[#8bc7aa]',
  'in-flight': 'border-[#b18b35]/35 bg-[#b18b35]/10 text-[#e0b94e]',
  'retry-scheduled': 'border-[#b18b35]/35 bg-[#b18b35]/10 text-[#e0b94e]',
  staged: 'border-[#b18b35]/35 bg-[#b18b35]/10 text-[#e0b94e]',
  'pending-verification': 'border-[#7e7890]/35 bg-[#7e7890]/10 text-[#b8b0c9]',
  pending: 'border-[#7e7890]/35 bg-[#7e7890]/10 text-[#b8b0c9]',
  scheduled: 'border-[#7e7890]/35 bg-[#7e7890]/10 text-[#b8b0c9]',
  paused: 'border-[#7e7890]/35 bg-[#7e7890]/10 text-[#b8b0c9]',
  suspended: 'border-[#b26845]/35 bg-[#b26845]/10 text-[#dca17f]',
  failed: 'border-[#a44d4d]/35 bg-[#a44d4d]/10 text-[#dc8c8c]',
  'dead-lettered': 'border-[#a44d4d]/35 bg-[#a44d4d]/10 text-[#dc8c8c]',
  revoked: 'border-[#a44d4d]/35 bg-[#a44d4d]/10 text-[#dc8c8c]',
  cancelled: 'border-[#6d6760]/35 bg-[#6d6760]/10 text-[#a39c92]',
  expired: 'border-[#6d6760]/35 bg-[#6d6760]/10 text-[#a39c92]',
}

function StatusBadge({ status }: Readonly<{ status: string }>) {
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] ${STATUS_TONES[status] ?? STATUS_TONES.pending}`}>{STATUS_LABELS[status] ?? status}</span>
}

function shortId(value: string) { return `${value.slice(0, 8)}…${value.slice(-4)}` }
function formatTime(value?: string) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as ApiEnvelope<T>
  if (!response.ok || !payload.data) throw new Error(payload.error?.message ?? 'A operação não foi concluída.')
  return payload.data
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  return readJson<T>(await fetch(path, init))
}

function actionKey(prefix: string) {
  return `${prefix}-${globalThis.crypto.randomUUID()}`
}

export default function WebhookControlRoom() {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([])
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [catalog, setCatalog] = useState<CatalogEvent[]>([])
  const [rotations, setRotations] = useState<Rotation[]>([])
  const [diagnostic, setDiagnostic] = useState<(Delivery & { attempts: DeliveryAttempt[] }) | null>(null)
  const [selectedEndpointId, setSelectedEndpointId] = useState('')
  const [selectedDeliveryId, setSelectedDeliveryId] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
  const [secret, setSecret] = useState('')
  const [endpointUrl, setEndpointUrl] = useState('')
  const [subscriptionEndpointId, setSubscriptionEndpointId] = useState('')
  const [selectedEventTypes, setSelectedEventTypes] = useState<string[]>([])
  const [overlapSeconds, setOverlapSeconds] = useState(3600)

  useEffect(() => {
    const controller = new AbortController()
    setState('loading')
    setMessageTone('info')
    void Promise.all([
      fetch('/v1/webhooks/endpoints?limit=100', { cache: 'no-store', signal: controller.signal }).then((response) => readJson<{ endpoints: Endpoint[] }>(response)),
      fetch('/v1/webhooks/subscriptions?limit=100', { cache: 'no-store', signal: controller.signal }).then((response) => readJson<{ subscriptions: Subscription[] }>(response)),
      fetch('/v1/webhooks/deliveries?limit=100', { cache: 'no-store', signal: controller.signal }).then((response) => readJson<{ deliveries: Delivery[] }>(response)),
      fetch('/v1/events/catalog', { cache: 'no-store', signal: controller.signal }).then((response) => readJson<{ events: CatalogEvent[] }>(response)),
    ]).then(([endpointResult, subscriptionResult, deliveryResult, catalogResult]) => {
      setEndpoints(endpointResult.endpoints)
      setSubscriptions(subscriptionResult.subscriptions)
      setDeliveries(deliveryResult.deliveries)
      setCatalog(catalogResult.events)
      setSelectedEndpointId((current) => current || endpointResult.endpoints[0]?.id || '')
      setSubscriptionEndpointId((current) => current || endpointResult.endpoints.find((item) => item.status === 'active')?.id || '')
      setSelectedDeliveryId((current) => current || deliveryResult.deliveries[0]?.id || '')
      setState('ready')
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      setMessage(error instanceof Error ? error.message : 'Não foi possível ler as integrações.')
      setMessageTone('error')
      setState('error')
    })
    return () => controller.abort()
  }, [refreshVersion])

  useEffect(() => {
    if (!selectedEndpointId) { setRotations([]); return }
    const controller = new AbortController()
    void fetch(`/v1/webhooks/endpoints/${encodeURIComponent(selectedEndpointId)}/signing-secrets/rotations?limit=100`, { cache: 'no-store', signal: controller.signal })
      .then((response) => readJson<{ rotations: Rotation[] }>(response))
      .then((result) => setRotations(result.rotations))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setMessage(error instanceof Error ? error.message : 'Não foi possível ler as rotações.')
        setMessageTone('error')
      })
    return () => controller.abort()
  }, [selectedEndpointId, refreshVersion])

  useEffect(() => {
    if (!selectedDeliveryId) { setDiagnostic(null); return }
    const controller = new AbortController()
    void fetch(`/v1/webhooks/deliveries/${encodeURIComponent(selectedDeliveryId)}`, { cache: 'no-store', signal: controller.signal })
      .then((response) => readJson<{ delivery: Delivery & { attempts: DeliveryAttempt[] } }>(response))
      .then((result) => setDiagnostic(result.delivery))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setMessage(error instanceof Error ? error.message : 'Não foi possível ler os attempts.')
        setMessageTone('error')
      })
    return () => controller.abort()
  }, [selectedDeliveryId, refreshVersion])

  const selectedEndpoint = endpoints.find((item) => item.id === selectedEndpointId)
  const selectedDelivery = deliveries.find((item) => item.id === selectedDeliveryId)
  const health = useMemo(() => ({
    activeEndpoints: endpoints.filter((item) => item.status === 'active').length,
    activeSubscriptions: subscriptions.filter((item) => item.status === 'active').length,
    attention: deliveries.filter((item) => item.status === 'retry-scheduled' || item.status === 'dead-lettered').length,
  }), [deliveries, endpoints, subscriptions])

  async function mutate(input: { key: string; request: () => Promise<Record<string, unknown>>; success: string }) {
    setBusy(input.key)
    setMessage('')
    setMessageTone('info')
    try {
      const data = await input.request()
      const disclosed = typeof data.secretBase64url === 'string' ? data.secretBase64url : ''
      if (disclosed) setSecret(disclosed)
      setMessage(input.success)
      setMessageTone('info')
      setRefreshVersion((version) => version + 1)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'A operação não foi concluída.')
      setMessageTone('error')
    } finally {
      setBusy('')
    }
  }

  async function createEndpoint(event: React.FormEvent) {
    event.preventDefault()
    const url = endpointUrl.trim()
    if (!url) return
    await mutate({
      key: 'create-endpoint',
      request: () => requestJson('/v1/webhooks/endpoints', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': actionKey('ui-webhook-endpoint') },
        body: JSON.stringify({ url }),
      }),
      success: 'Endpoint criado. Execute a verificação antes de assinar eventos.',
    })
    setEndpointUrl('')
  }

  async function createSubscription(event: React.FormEvent) {
    event.preventDefault()
    if (!subscriptionEndpointId || selectedEventTypes.length === 0) return
    await mutate({
      key: 'create-subscription',
      request: () => requestJson('/v1/webhooks/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': actionKey('ui-webhook-subscription') },
        body: JSON.stringify({ endpointId: subscriptionEndpointId, eventTypes: selectedEventTypes }),
      }),
      success: 'Assinatura criada com os eventos selecionados.',
    })
    setSelectedEventTypes([])
  }

  function changeSubscription(subscription: Subscription, status: 'active' | 'paused') {
    return mutate({
      key: `${status}-${subscription.id}`,
      request: () => requestJson(`/v1/webhooks/subscriptions/${encodeURIComponent(subscription.id)}/status`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, baseRevision: subscription.revision }),
      }),
      success: status === 'active' ? 'Assinatura reativada.' : 'Assinatura pausada.',
    })
  }

  function challengeEndpoint(endpoint: Endpoint) {
    return mutate({
      key: 'challenge',
      request: () => requestJson(`/v1/webhooks/endpoints/${encodeURIComponent(endpoint.id)}/challenge`, { method: 'POST' }),
      success: 'Challenge confirmado. O destino está ativo.',
    })
  }

  function changeEndpoint(endpoint: Endpoint, status: 'active' | 'suspended') {
    return mutate({
      key: `${status}-endpoint`,
      request: () => requestJson(`/v1/webhooks/endpoints/${encodeURIComponent(endpoint.id)}/status`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status, baseRevision: endpoint.revision }),
      }),
      success: status === 'active' ? 'Destino reativado.' : 'Destino suspenso e assinaturas pausadas.',
    })
  }

  function stageRotation(endpoint: Endpoint) {
    return mutate({
      key: 'stage-rotation',
      request: () => requestJson(`/v1/webhooks/endpoints/${encodeURIComponent(endpoint.id)}/signing-secrets/rotations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': actionKey('ui-webhook-rotation') },
        body: JSON.stringify({ baseRevision: endpoint.revision, overlapSeconds }),
      }),
      success: 'Nova chave preparada. Copie-a antes de ativar.',
    })
  }

  function activateRotation(rotation: Rotation) {
    return mutate({
      key: `activate-rotation-${rotation.id}`,
      request: () => requestJson(`/v1/webhooks/endpoints/${encodeURIComponent(rotation.endpointId)}/signing-secrets/rotations/${encodeURIComponent(rotation.id)}/activate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: rotation.baseRevision }),
      }),
      success: 'Rotação ativada com janela de sobreposição.',
    })
  }

  function cancelRotation(rotation: Rotation) {
    return mutate({
      key: `cancel-rotation-${rotation.id}`,
      request: () => requestJson(`/v1/webhooks/endpoints/${encodeURIComponent(rotation.endpointId)}/signing-secrets/rotations/${encodeURIComponent(rotation.id)}/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseRevision: rotation.baseRevision }),
      }),
      success: 'Rotação cancelada e envelope destruído.',
    })
  }

  function replayDelivery(delivery: Delivery) {
    return mutate({
      key: 'replay-delivery',
      request: () => requestJson(`/v1/webhooks/deliveries/${encodeURIComponent(delivery.id)}/replay`, {
        method: 'POST',
        headers: { 'idempotency-key': actionKey('ui-webhook-replay') },
      }),
      success: 'Replay aceito. A entrega voltou para a fila.',
    })
  }

  const buttonClass = 'border border-white/[0.1] bg-white/[0.035] px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#d8d2c8] transition hover:border-[#c49a3a]/45 hover:text-white disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <section className="mt-14 border-t border-white/[0.08] pt-10" data-testid="webhook-control-room">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#b18b35]">Sinal de entrega</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-[-0.035em] text-[#f4f1ea]">Integrações em tempo real</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[#8f8a81]">Verifique destinos, acompanhe cada tentativa e troque chaves sem expor detalhes internos do worker.</p>
        </div>
        <div className="grid grid-cols-3 border border-white/[0.08] bg-[#0a0a0a]">
          {[[health.activeEndpoints, 'destinos ativos'], [health.activeSubscriptions, 'assinaturas'], [health.attention, 'pedem atenção']].map(([value, label]) => <div className="min-w-[112px] border-r border-white/[0.08] px-4 py-3 last:border-r-0" key={label}><p className="font-mono text-xl text-[#e5ded2]">{value}</p><p className="mt-1 text-[9px] uppercase tracking-[0.12em] text-[#716c64]">{label}</p></div>)}
        </div>
      </div>

      {message ? <div className={`mt-6 border px-4 py-3 text-xs ${messageTone === 'error' ? 'border-[#a44d4d]/30 bg-[#a44d4d]/10 text-[#dc8c8c]' : 'border-[#b18b35]/25 bg-[#b18b35]/[0.07] text-[#d6b766]'}`} role={messageTone === 'error' ? 'alert' : 'status'}>{message}</div> : null}
      {secret ? <div className="mt-4 border border-[#b18b35]/35 bg-[#b18b35]/[0.07] p-4" data-testid="webhook-secret-disclosure"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold text-[#e8cb82]">Copie agora. Esta chave não será exibida novamente.</p><p className="mt-2 break-all font-mono text-[11px] leading-5 text-[#b9aa87]">{secret}</p></div><button className={buttonClass} onClick={() => setSecret('')} type="button">Descartar</button></div></div> : null}

      <div className="mt-7 grid gap-px border border-white/[0.08] bg-white/[0.08] xl:grid-cols-[1.05fr_1fr_1.15fr]">
        <div className="bg-[#090909] p-5">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#c9c2b7]">Destinos</h3><span className="font-mono text-[10px] text-[#69645d]">{endpoints.length}</span></div>
          <form className="mt-4 flex gap-2" onSubmit={(event) => void createEndpoint(event)}><input aria-label="URL HTTPS do novo endpoint" className="min-w-0 flex-1 border border-white/[0.1] bg-black/30 px-3 py-2 text-xs text-white outline-none placeholder:text-[#5e5952] focus:border-[#b18b35]/60" onChange={(event) => setEndpointUrl(event.target.value)} placeholder="https://hooks.exemplo.com/apollo" required type="url" value={endpointUrl} /><button className={buttonClass} disabled={busy !== ''} type="submit">Criar</button></form>
          <div className="mt-4 max-h-[360px] space-y-1 overflow-y-auto [content-visibility:auto]">{endpoints.map((endpoint) => <button className={`w-full border px-3 py-3 text-left transition ${selectedEndpointId === endpoint.id ? 'border-[#b18b35]/35 bg-[#b18b35]/[0.07]' : 'border-transparent hover:border-white/[0.08] hover:bg-white/[0.02]'}`} key={endpoint.id} onClick={() => setSelectedEndpointId(endpoint.id)} type="button"><div className="flex items-center justify-between gap-3"><span className="truncate text-xs text-[#d5cfc5]">{endpoint.destinationOrigin}</span><StatusBadge status={endpoint.status} /></div><p className="mt-2 font-mono text-[9px] text-[#625d56]">{shortId(endpoint.id)} · v{endpoint.currentSigningSecret?.version ?? '—'}</p></button>)}</div>
        </div>

        <div className="bg-[#090909] p-5">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#c9c2b7]">Assinaturas</h3><span className="font-mono text-[10px] text-[#69645d]">{subscriptions.length}</span></div>
          <form className="mt-4 border border-white/[0.08] bg-black/20 p-3" onSubmit={(event) => void createSubscription(event)}><select aria-label="Destino da assinatura" className="w-full border border-white/[0.1] bg-[#111] px-2 py-2 text-xs text-[#c8c1b6]" onChange={(event) => setSubscriptionEndpointId(event.target.value)} value={subscriptionEndpointId}><option value="">Escolha um destino ativo</option>{endpoints.filter((item) => item.status === 'active').map((endpoint) => <option key={endpoint.id} value={endpoint.id}>{endpoint.destinationOrigin}</option>)}</select><div className="mt-3 max-h-28 space-y-1 overflow-y-auto">{catalog.map((item) => <label className="flex cursor-pointer items-start gap-2 text-[10px] leading-4 text-[#817b72]" key={item.type}><input checked={selectedEventTypes.includes(item.type)} className="mt-0.5 accent-[#c49a3a]" onChange={() => setSelectedEventTypes((current) => current.includes(item.type) ? current.filter((type) => type !== item.type) : [...current, item.type])} type="checkbox" /><span><strong className="font-mono font-medium text-[#aaa399]">{item.type}</strong></span></label>)}</div><button className={`${buttonClass} mt-3 w-full`} disabled={busy !== '' || !subscriptionEndpointId || selectedEventTypes.length === 0} type="submit">Assinar {selectedEventTypes.length || ''} eventos</button></form>
          <div className="mt-4 max-h-[250px] space-y-1 overflow-y-auto [content-visibility:auto]">
            {subscriptions.map((subscription) => <article className="border border-transparent px-3 py-3 hover:border-white/[0.08]" key={subscription.id}>
              <div className="flex items-center justify-between gap-3"><span className="font-mono text-[10px] text-[#8d867c]">{shortId(subscription.id)}</span><StatusBadge status={subscription.status} /></div>
              <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-[#69645d]">{subscription.eventTypes.join(' · ')}</p>
              <div className="mt-2 flex gap-2">
                {subscription.status === 'active' ? <button className={buttonClass} disabled={busy !== ''} onClick={() => void changeSubscription(subscription, 'paused')} type="button">Pausar</button> : null}
                {subscription.status === 'paused' ? <button className={buttonClass} disabled={busy !== ''} onClick={() => void changeSubscription(subscription, 'active')} type="button">Ativar</button> : null}
              </div>
            </article>)}
          </div>
        </div>

        <div className="bg-[#090909] p-5">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-[#c9c2b7]">Entregas</h3><span className="font-mono text-[10px] text-[#69645d]">{deliveries.length}</span></div>
          <div className="mt-4 max-h-[520px] space-y-1 overflow-y-auto [content-visibility:auto]">{deliveries.map((delivery) => <button className={`w-full border px-3 py-3 text-left transition ${selectedDeliveryId === delivery.id ? 'border-[#b18b35]/35 bg-[#b18b35]/[0.07]' : 'border-transparent hover:border-white/[0.08] hover:bg-white/[0.02]'}`} key={delivery.id} onClick={() => setSelectedDeliveryId(delivery.id)} type="button"><div className="flex items-center justify-between gap-3"><span className="font-mono text-[10px] text-[#948d83]">{shortId(delivery.eventId)}</span><StatusBadge status={delivery.status} /></div><div className="mt-2 flex items-center justify-between text-[9px] text-[#625d56]"><span>{delivery.attemptCount}/{delivery.maxAttempts} attempts</span><span>{formatTime(delivery.createdAt)}</span></div></button>)}</div>
        </div>
      </div>

      <div className="mt-px grid gap-px border border-white/[0.08] bg-white/[0.08] xl:grid-cols-2">
        <div className="bg-[#0a0a0a] p-5" data-testid="webhook-endpoint-operations">
          <div className="flex items-start justify-between gap-4"><div><p className="text-[10px] uppercase tracking-[0.16em] text-[#706a62]">Destino selecionado</p><h3 className="mt-2 text-sm font-medium text-[#d8d2c8]">{selectedEndpoint?.destinationOrigin ?? 'Nenhum destino'}</h3></div>{selectedEndpoint ? <StatusBadge status={selectedEndpoint.status} /> : null}</div>
          {selectedEndpoint ? <>
            <dl className="mt-5 grid grid-cols-2 gap-4 text-[10px]"><div><dt className="text-[#625d56]">Fingerprint da URL</dt><dd className="mt-1 font-mono text-[#928b81]">{shortId(selectedEndpoint.urlFingerprint)}</dd></div><div><dt className="text-[#625d56]">Chave ativa</dt><dd className="mt-1 font-mono text-[#928b81]">v{selectedEndpoint.currentSigningSecret?.version ?? '—'} · {selectedEndpoint.currentSigningSecret ? shortId(selectedEndpoint.currentSigningSecret.fingerprint) : 'não provisionada'}</dd></div></dl>
            <div className="mt-5 flex flex-wrap gap-2">
              {selectedEndpoint.status === 'pending-verification' ? <button className={buttonClass} disabled={busy !== ''} onClick={() => void challengeEndpoint(selectedEndpoint)} type="button">Verificar destino</button> : null}
              {selectedEndpoint.status === 'active' ? <button className={buttonClass} disabled={busy !== ''} onClick={() => void changeEndpoint(selectedEndpoint, 'suspended')} type="button">Suspender</button> : null}
              {selectedEndpoint.status === 'suspended' ? <button className={buttonClass} disabled={busy !== ''} onClick={() => void changeEndpoint(selectedEndpoint, 'active')} type="button">Reativar</button> : null}
              {selectedEndpoint.status === 'active' ? <><input aria-label="Sobreposição da rotação em segundos" className="w-24 border border-white/[0.1] bg-black/30 px-2 text-xs text-[#bdb5aa]" max={86400} min={60} onChange={(event) => setOverlapSeconds(Number(event.target.value))} type="number" value={overlapSeconds} /><button className={buttonClass} disabled={busy !== '' || overlapSeconds < 60 || overlapSeconds > 86400} onClick={() => void stageRotation(selectedEndpoint)} type="button">Preparar rotação</button></> : null}
            </div>
            <div className="mt-5 space-y-2">{rotations.slice(0, 5).map((rotation) => <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-3" key={rotation.id}><div><p className="font-mono text-[10px] text-[#a0988d]">v{rotation.candidateVersion} · {shortId(rotation.fingerprint)}</p><p className="mt-1 text-[9px] text-[#625d56]">expira {formatTime(rotation.expiresAt)}</p></div><div className="flex items-center gap-2"><StatusBadge status={rotation.status} />{rotation.status === 'staged' ? <><button className={buttonClass} disabled={busy !== ''} onClick={() => void activateRotation(rotation)} type="button">Ativar</button><button className={buttonClass} disabled={busy !== ''} onClick={() => void cancelRotation(rotation)} type="button">Cancelar</button></> : null}</div></div>)}</div>
          </> : <p className="mt-5 text-xs text-[#625d56]">Crie ou selecione um destino para administrar.</p>}
        </div>

        <div className="bg-[#0a0a0a] p-5" data-testid="webhook-attempt-timeline"><div className="flex items-start justify-between gap-4"><div><p className="text-[10px] uppercase tracking-[0.16em] text-[#706a62]">Trilha de attempts</p><h3 className="mt-2 font-mono text-sm text-[#d8d2c8]">{selectedDelivery ? shortId(selectedDelivery.id) : 'Nenhuma entrega'}</h3></div>{selectedDelivery ? <StatusBadge status={selectedDelivery.status} /> : null}</div>{diagnostic?.attempts.length ? <ol className="relative mt-6 space-y-0 before:absolute before:bottom-4 before:left-[7px] before:top-4 before:w-px before:bg-white/[0.1]">{diagnostic.attempts.map((attempt) => <li className="relative grid grid-cols-[16px_1fr_auto] gap-3 border-b border-white/[0.06] py-3 last:border-b-0" key={attempt.id}><span className={`relative z-10 mt-1 h-[15px] w-[15px] rounded-full border-2 border-[#0a0a0a] ${attempt.status === 'succeeded' ? 'bg-[#68a887]' : attempt.status === 'failed' ? 'bg-[#b95f5f]' : 'bg-[#b18b35]'}`} /><div><p className="text-[11px] text-[#c8c1b6]">Attempt {attempt.attemptNumber}</p><p className="mt-1 font-mono text-[9px] text-[#625d56]">{attempt.responseStatus ? `HTTP ${attempt.responseStatus}` : attempt.errorCode ?? 'sem resposta ainda'}</p></div><div className="text-right"><StatusBadge status={attempt.status} /><p className="mt-1 text-[9px] text-[#625d56]">{formatTime(attempt.completedAt ?? attempt.createdAt)}</p></div></li>)}</ol> : <p className="mt-6 text-xs leading-5 text-[#625d56]">Selecione uma entrega para ver a sequência real de tentativas.</p>}{selectedDelivery?.status === 'dead-lettered' ? <button className={`${buttonClass} mt-5`} disabled={busy !== ''} onClick={() => void replayDelivery(selectedDelivery)} type="button">Reabrir dead-letter</button> : null}</div>
      </div>

      {state === 'loading' ? <p className="mt-5 text-xs text-[#706a62]" role="status">Atualizando o sinal das integrações…</p> : null}
    </section>
  )
}
