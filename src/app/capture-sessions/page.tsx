'use client'

import { useCallback, useEffect, useState } from 'react'

import AppShellNavigation from '@/components/AppShellNavigation'
import LogoutButton from '@/components/LogoutButton'

/**
 * The operable surface for capture sessions (F4.002–F4.007).
 *
 * The whole page is organised around one distinction the API is careful to
 * make and a UI can easily lose: **"we could not tell" is not "they lined up".**
 * A track with no map is shown as needing input, never as synchronized at zero,
 * because an editor who reads the second will cut as if the tracks aligned.
 *
 * The second thing it refuses to smooth over is a stale conflict. A session is
 * an immutable chain, so a command computed against version 4 is meaningless
 * once version 5 exists. When the API says so, the page stops and offers a
 * reload rather than retrying with the version it happens to be holding.
 */

type ViewState =
  | 'loading'
  | 'empty'
  | 'ready'
  | 'partial'
  | 'needs-input'
  | 'failed'
  | 'stale-conflict'

interface ApiEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

interface SessionSummary {
  sessionId: string
  version: number
  status: 'draft' | 'analyzing' | 'needs-input' | 'synced' | 'partial' | 'failed'
  sessionHash: string
  referenceTrackId: string
  referenceEpoch: number
  trackCount: number
  staleDerivations: string[]
}

interface TickInterval { start: string; end: string }

interface ClockMapPiece {
  pieceId: string
  ordinal: number
  sourceCoverage: TickInterval
  sessionCoverage: TickInterval
  rate: string
  offsetTicks: string
  driftPpm: number
  confidence: 'high' | 'medium' | 'low'
  residualBoundTicks: string
  openedBy: string | null
  openedByDetail: string | null
}

interface SyncTrack {
  trackId: string
  outcome: 'auto-apply' | 'review' | 'insufficient-evidence'
  manualRequired: boolean
  selectedMethod: string | null
  outcomeReasons: string[]
  map: { sourceBounds: TickInterval; uncovered: TickInterval[]; pieces: ClockMapPiece[] } | null
  coverage: {
    bounds: TickInterval
    coveredTicks: string
    gapTicks: string
    minConfidenceBps: number
    autoEditable: boolean
    unresolvedOverlaps: number
  } | null
}

interface SyncView {
  sessionId: string
  sessionVersion: number
  referenceEpoch: number
  referenceTrackId: string
  tracks: SyncTrack[]
}

const OUTCOME_LABEL: Record<SyncTrack['outcome'], string> = {
  'auto-apply': 'Sincronizada',
  review: 'Revisar',
  'insufficient-evidence': 'Sem evidência',
}

/**
 * Ticks are decimal strings on the wire, so they are formatted as strings.
 *
 * Parsing one into a Number to divide it would undo the entire reason the API
 * sends strings: a nanosecond tick exceeds what a double represents exactly,
 * and the rounding would be invisible. `BigInt` divides exactly, and the
 * remainder is shown rather than dropped.
 */
function formatTicks(ticks: string, ticksPerSecond = BigInt(90_000)): string {
  try {
    const value = BigInt(ticks)
    const negative = value < BigInt(0)
    const absolute = negative ? -value : value
    const seconds = absolute / ticksPerSecond
    const remainder = absolute % ticksPerSecond
    const millis = (remainder * BigInt(1_000)) / ticksPerSecond
    const sign = negative ? '−' : ''
    return `${sign}${seconds},${String(millis).padStart(3, '0')} s`
  } catch {
    return ticks
  }
}

export default function CaptureSessionsPage() {
  const [state, setState] = useState<ViewState>('loading')
  const [projectId, setProjectId] = useState('')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [sync, setSync] = useState<SyncView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ currentVersion: number } | null>(null)
  const [busy, setBusy] = useState(false)

  const loadSessions = useCallback(async (project: string) => {
    if (project.trim().length === 0) {
      setState('empty')
      setSessions([])
      return
    }
    setState('loading')
    setMessage(null)
    setConflict(null)
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(project.trim())}/capture-sessions`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const body = (await response.json()) as ApiEnvelope<{ sessions: SessionSummary[] }>
      if (!response.ok) {
        setMessage(body.error?.message ?? 'Não foi possível carregar as sessões.')
        setState('failed')
        return
      }
      const found = body.data?.sessions ?? []
      setSessions(found)
      setState(found.length === 0 ? 'empty' : 'ready')
    } catch {
      setMessage('A rede falhou ao carregar as sessões.')
      setState('failed')
    }
  }, [])

  const loadSync = useCallback(async (project: string, sessionId: string) => {
    setBusy(true)
    setMessage(null)
    setConflict(null)
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(project.trim())}/capture-sessions/${encodeURIComponent(sessionId)}/sync`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const body = (await response.json()) as ApiEnvelope<SyncView>
      if (!response.ok || !body.data) {
        setMessage(body.error?.message ?? 'Não foi possível ler a sincronização.')
        setState('failed')
        return
      }
      setSync(body.data)
      setSelected(sessionId)
      // The page's state follows the worst answer among the tracks, not the
      // best. A session where one track could not be measured is not
      // "synchronized with a caveat": something has to be decided before it can
      // be cut unattended.
      const anyMissing = body.data.tracks.some((track) => track.outcome === 'insufficient-evidence')
      const anyReview = body.data.tracks.some((track) => track.outcome === 'review')
      setState(anyMissing ? 'needs-input' : anyReview ? 'partial' : 'ready')
    } catch {
      setMessage('A rede falhou ao ler a sincronização.')
      setState('failed')
    } finally {
      setBusy(false)
    }
  }, [])

  const requestSync = useCallback(async (session: SessionSummary) => {
    setBusy(true)
    setMessage(null)
    setConflict(null)
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId.trim())}/capture-sessions/${encodeURIComponent(session.sessionId)}/sync-runs`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            // The key is the exact version, so a double click rejoins the run
            // it already started rather than starting a second pass over the
            // same media.
            'idempotency-key': `sync-${session.sessionId}-v${session.version}`,
          },
          body: JSON.stringify({
            baseVersionId: `${session.sessionId}:v${session.version}`,
            baseHash: session.sessionHash,
          }),
        },
      )
      const body = (await response.json()) as ApiEnvelope<{ run: { operationId: string } }>
      if (response.status === 409 || body.error?.code === 'CAPTURE_SESSION_VERSION_STALE') {
        // Do not retry with the version in hand: it is the stale one. The only
        // honest next step is to read the session again.
        const current = body.error?.details?.currentVersion
        setConflict({ currentVersion: typeof current === 'number' ? current : session.version + 1 })
        setState('stale-conflict')
        return
      }
      if (!response.ok) {
        setMessage(body.error?.message ?? 'Não foi possível pedir a sincronização.')
        setState('failed')
        return
      }
      setMessage(`Sincronização enfileirada (${body.data?.run.operationId ?? 'operação'}).`)
      await loadSync(projectId, session.sessionId)
    } catch {
      setMessage('A rede falhou ao pedir a sincronização.')
      setState('failed')
    } finally {
      setBusy(false)
    }
  }, [projectId, loadSync])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const initial = params.get('projectId') ?? ''
    setProjectId(initial)
    void loadSessions(initial)
  }, [loadSessions])

  return (
    <main data-testid="capture-sessions-page">
      <header>
        <AppShellNavigation active="capture-sessions" />
        <LogoutButton />
      </header>

      <h1>Sessões de captura</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void loadSessions(projectId)
        }}
      >
        <label htmlFor="projectId">Projeto</label>
        <input
          id="projectId"
          name="projectId"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          placeholder="project-..."
        />
        <button type="submit" disabled={busy}>Carregar</button>
      </form>

      {state === 'loading' && <p data-testid="state-loading">Carregando…</p>}

      {state === 'empty' && (
        <p data-testid="state-empty">
          Nenhuma sessão de captura neste projeto. Uma sessão começa quando a
          primeira faixa é ingerida.
        </p>
      )}

      {state === 'failed' && (
        <section data-testid="state-failed" role="alert">
          <p>{message ?? 'Alguma coisa falhou.'}</p>
          <button type="button" onClick={() => void loadSessions(projectId)} disabled={busy}>
            Tentar de novo
          </button>
        </section>
      )}

      {state === 'stale-conflict' && conflict && (
        <section data-testid="state-stale-conflict" role="alert">
          <p>
            A sessão avançou para a versão {conflict.currentVersion} enquanto
            esta tela olhava para outra. Recarregue antes de pedir de novo — o
            pedido anterior foi calculado sobre uma sessão que já não existe.
          </p>
          <button type="button" onClick={() => void loadSessions(projectId)} disabled={busy}>
            Recarregar sessão
          </button>
        </section>
      )}

      {sessions.length > 0 && (
        <table data-testid="session-list">
          <thead>
            <tr>
              <th scope="col">Sessão</th>
              <th scope="col">Versão</th>
              <th scope="col">Estado</th>
              <th scope="col">Faixas</th>
              <th scope="col">Derivações vencidas</th>
              <th scope="col">Ações</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.sessionId} data-testid={`session-${session.sessionId}`}>
                <td>{session.sessionId}</td>
                <td>{session.version}</td>
                <td data-testid={`session-status-${session.sessionId}`}>{session.status}</td>
                <td>{session.trackCount}</td>
                <td>
                  {session.staleDerivations.length === 0
                    ? '—'
                    : session.staleDerivations.join(', ')}
                </td>
                <td>
                  <button
                    type="button"
                    onClick={() => void loadSync(projectId, session.sessionId)}
                    disabled={busy}
                  >
                    Ver sincronização
                  </button>
                  <button type="button" onClick={() => void requestSync(session)} disabled={busy}>
                    Sincronizar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {state === 'needs-input' && (
        <p data-testid="state-needs-input" role="status">
          Pelo menos uma faixa não pôde ser medida. Isso não é o mesmo que estar
          alinhada em zero: nada foi medido, e cortar sem decidir seria cortar no
          escuro.
        </p>
      )}

      {state === 'partial' && (
        <p data-testid="state-partial" role="status">
          Há faixas medidas que pedem revisão antes de corte automático.
        </p>
      )}

      {message && state !== 'failed' && <p data-testid="message">{message}</p>}

      {/* The pre-recording protocols live at their own route rather than in the
          shell, which declares a fixed set of destinations. They are reached
          from here because this is where an operator already is when the
          question "what should the next shoot look like?" comes up. */}
      <p data-testid="open-capture-protocols">
        <a href="/capture-protocols">Ver as exigências antes de gravar</a>
      </p>

      {selected && (
        <p data-testid="open-diagnostic">
          <a
            href={`/sync-diagnostic?projeto=${encodeURIComponent(projectId.trim())}&sessao=${encodeURIComponent(selected)}`}
          >
            Abrir o diagnóstico desta sessão
          </a>
        </p>
      )}

      {sync && (
        <section data-testid="sync-detail">
          <h2>
            Sincronização de {sync.sessionId} (versão {sync.sessionVersion}, época{' '}
            {sync.referenceEpoch})
          </h2>
          <p>Referência: {sync.referenceTrackId}</p>
          {sync.tracks.length === 0 && (
            <p data-testid="sync-empty">Nada sincronizado ainda para esta versão.</p>
          )}
          {sync.tracks.map((track) => (
            <article key={track.trackId} data-testid={`sync-track-${track.trackId}`}>
              <h3>
                {track.trackId} — <span data-testid={`outcome-${track.trackId}`}>{OUTCOME_LABEL[track.outcome]}</span>
              </h3>
              {track.selectedMethod && <p>Método: {track.selectedMethod}</p>}
              {track.outcomeReasons.length > 0 && (
                <ul>
                  {track.outcomeReasons.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
              )}

              {track.map === null ? (
                <p data-testid={`no-map-${track.trackId}`}>
                  Sem mapa. A cascata não conseguiu decidir — nenhum deslocamento
                  foi gravado, e isso é a resposta, não a ausência dela.
                </p>
              ) : (
                <table data-testid={`pieces-${track.trackId}`}>
                  <thead>
                    <tr>
                      <th scope="col">Trecho</th>
                      <th scope="col">Origem</th>
                      <th scope="col">Sessão</th>
                      <th scope="col">Deriva</th>
                      <th scope="col">Abriu por</th>
                    </tr>
                  </thead>
                  <tbody>
                    {track.map.pieces.map((piece) => (
                      <tr key={piece.pieceId}>
                        <td>{piece.ordinal}</td>
                        <td>
                          {formatTicks(piece.sourceCoverage.start)} → {formatTicks(piece.sourceCoverage.end)}
                        </td>
                        <td>
                          {formatTicks(piece.sessionCoverage.start)} → {formatTicks(piece.sessionCoverage.end)}
                        </td>
                        <td>{piece.driftPpm} ppm</td>
                        <td>{piece.openedByDetail ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {track.map && track.map.uncovered.length > 0 && (
                <p data-testid={`uncovered-${track.trackId}`}>
                  Sem cobertura entre{' '}
                  {track.map.uncovered
                    .map((gap) => `${formatTicks(gap.start)} e ${formatTicks(gap.end)}`)
                    .join('; ')}
                  . Nada é resolvido aí.
                </p>
              )}

              {track.coverage && (
                <p data-testid={`coverage-${track.trackId}`}>
                  Coberto {formatTicks(track.coverage.coveredTicks)}, buracos{' '}
                  {formatTicks(track.coverage.gapTicks)}.{' '}
                  {track.coverage.autoEditable
                    ? 'Liberada para corte automático.'
                    : 'Não liberada para corte automático.'}
                </p>
              )}
            </article>
          ))}
        </section>
      )}
    </main>
  )
}
