'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import AppShellNavigation from '@/components/AppShellNavigation'
import LogoutButton from '@/components/LogoutButton'

/**
 * The sync diagnostic surface (F4.011, FR-149).
 *
 * The page has one job that is easy to get wrong: **show what is known, what
 * is not, and keep those apart.** A track nobody could measure is not a track
 * that lined up at zero, and an editor who reads the second will cut as though
 * the cameras agreed. So every unmeasured field renders as "não medido" and
 * never as a number.
 *
 * The auto-edit gate is read from the API, never recomputed here. A page that
 * derived "posso cortar?" from the same fields could arrive at a kinder answer
 * than the server did — which is exactly the failure the gate exists to stop.
 *
 * Nudging an anchor is fenced on the diagnostic version and hash the page is
 * holding. If somebody else has moved it, the page stops and offers a reload
 * rather than retrying with a document that no longer exists.
 */

interface ApiEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

type DiagnosticStatus = 'synced-high' | 'synced-medium' | 'partial' | 'needs-input' | 'failed'

interface TickInterval { start: string; end: string }

interface Anchor {
  anchorId: string
  origin: 'automatic' | 'manual'
  sourceMs: number
  sessionMs: number
  method: string
  confidence: number
  residualMs: number | null
  evidenceRef: string
  createdAt: string
}

interface TrackDiagnostic {
  trackId: string
  methods: string[]
  confidence: number
  offsetMs: number | null
  residualMs: number | null
  driftPpm: number | null
  coverageBps: number | null
  gaps: TickInterval[]
  automaticAnchors: Anchor[]
  manualAnchors: Anchor[]
  pieceIds: string[]
  status: DiagnosticStatus
  warnings: string[]
  previewSampleMs: number[]
}

/** Only the part of the session read: which file backs each track. */
interface SessionTrack {
  trackId: string
  parts: { partId: string; ordinal: number; evidence: { ingestArtifactId: string } }[]
}

interface Diagnostic {
  sessionId: string
  referenceTrackId: string
  version: number
  previousVersionHash: string | null
  sessionVersion: number
  referenceEpoch: number
  status: DiagnosticStatus
  globalConfidence: number
  tracks: TrackDiagnostic[]
  warnings: string[]
  recommendedActions: string[]
  manualRequired: boolean
  protocolCeiling: string | null
  generatedAt: string
  diagnosticHash: string
  autoEdit: { allowed: boolean; blockedBy: string[] }
}

const STATUS_TEXT: Record<DiagnosticStatus, string> = {
  'synced-high': 'Alinhado, com folga',
  'synced-medium': 'Alinhado, convém conferir',
  partial: 'Parcial',
  'needs-input': 'Precisa de decisão',
  failed: 'Falhou',
}

/**
 * A measurement, or the honest absence of one.
 *
 * The whole page turns on this function. Rendering `null` as `0` would be the
 * single most damaging bug here: it reads as "medido, e bate", which is the
 * one thing nobody knows.
 */
function showMs(value: number | null, digits = 1): string {
  return value === null ? 'não medido' : `${value.toFixed(digits)} ms`
}

function showCoverage(bps: number | null): string {
  return bps === null ? 'não medida' : `${(bps / 100).toFixed(2)} %`
}

/** One frame at 30000/1001, in milliseconds — the nudge step an editor thinks in. */
const FRAME_MS = 1001 / 30

export default function SyncDiagnosticPage() {
  const [projectId, setProjectId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<{ currentVersion: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [nudgeMs, setNudgeMs] = useState<Record<string, number>>({})
  // trackId -> the artifact that holds its footage. Read from the session,
  // because the diagnostic is about time and says nothing about bytes.
  const [previewOf, setPreviewOf] = useState<Record<string, string>>({})
  const players = useRef<Record<string, HTMLVideoElement | null>>({})

  // Deliberately two values rather than one joined path: the parity audit
  // reads each fetch's URL out of the source, and a variable holding the whole
  // route would make these calls invisible to it.
  const project = useMemo(() => encodeURIComponent(projectId.trim()), [projectId])
  const session = useMemo(() => encodeURIComponent(sessionId.trim()), [sessionId])

  // The session list links here with the session already chosen. Ignoring
  // those would make the link land on an empty form and quietly ask the
  // operator to retype what they just clicked.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const linkedProject = params.get('projeto')
    const linkedSession = params.get('sessao')
    if (linkedProject) setProjectId(linkedProject)
    if (linkedSession) setSessionId(linkedSession)
  }, [])

  const load = useCallback(async () => {
    if (projectId.trim().length === 0 || sessionId.trim().length === 0) return
    setBusy(true)
    setMessage(null)
    setConflict(null)
    try {
      const response = await fetch(`/v1/projects/${project}/capture-sessions/${session}/sync-diagnostic`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const body = (await response.json()) as ApiEnvelope<{ diagnostic: Diagnostic }>
      if (!response.ok || !body.data) {
        setMessage(body.error?.message ?? 'Não foi possível ler o diagnóstico.')
        setDiagnostic(null)
        return
      }
      setDiagnostic(body.data.diagnostic)

      // The players need the files. A track whose footage cannot be located
      // renders as "sem prévia" rather than as an empty <video>, which would
      // look like a recording that is simply black.
      const sessionResponse = await fetch(`/v1/projects/${project}/capture-sessions/${session}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const sessionBody = (await sessionResponse.json()) as ApiEnvelope<{
        session: { tracks: SessionTrack[] }
      }>
      const sources: Record<string, string> = {}
      for (const track of sessionBody.data?.session.tracks ?? []) {
        const first = [...track.parts].sort((left, right) => left.ordinal - right.ordinal)[0]
        if (first) sources[track.trackId] = first.evidence.ingestArtifactId
      }
      setPreviewOf(sources)
    } catch {
      setMessage('A rede falhou ao ler o diagnóstico.')
    } finally {
      setBusy(false)
    }
  }, [project, projectId, session, sessionId])

  const linkedRef = useRef(false)
  useEffect(() => {
    if (linkedRef.current || projectId.length === 0 || sessionId.length === 0) return
    linkedRef.current = true
    void load()
  }, [load, projectId, sessionId])

  const editAnchor = useCallback(
    async (track: TrackDiagnostic, deltaMs: number) => {
      if (!diagnostic) return
      const anchor = track.manualAnchors[0] ?? track.automaticAnchors[0]
      if (!anchor) {
        setMessage('Não há âncora para mover nesta trilha.')
        return
      }
      setBusy(true)
      setMessage(null)
      setConflict(null)
      try {
        const response = await fetch(`/v1/projects/${project}/capture-sessions/${session}/sync-diagnostic/anchors`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            // The fence is the version AND hash the page is holding. Sending
            // only the number would let this nudge land on a document somebody
            // else has already replaced.
            baseVersionId: `${diagnostic.sessionId}:diagnostic:v${diagnostic.version}`,
            baseHash: diagnostic.diagnosticHash,
            trackId: track.trackId,
            // Moving an automatic anchor is not allowed, so a nudge always
            // writes a manual one carrying the operator's correction.
            action: track.manualAnchors.length > 0 ? 'move' : 'add',
            anchorId: track.manualAnchors[0]?.anchorId ?? `manual-${track.trackId}`,
            sourceMs: anchor.sourceMs,
            sessionMs: anchor.sessionMs + deltaMs,
            evidenceRef: 'operator-frame-nudge',
          }),
        })
        const body = (await response.json()) as ApiEnvelope<{ diagnostic: Diagnostic }>
        if (response.status === 409) {
          const current = body.error?.details?.currentVersion
          setConflict({ currentVersion: typeof current === 'number' ? current : diagnostic.version })
          setMessage(
            'Outra pessoa mudou este diagnóstico enquanto você olhava. Recarregue antes de mexer.',
          )
          return
        }
        if (!response.ok || !body.data) {
          setMessage(body.error?.message ?? 'O ajuste foi recusado.')
          return
        }
        setDiagnostic(body.data.diagnostic)
        setNudgeMs((current) => ({
          ...current,
          [track.trackId]: (current[track.trackId] ?? 0) + deltaMs,
        }))
      } catch {
        setMessage('A rede falhou ao ajustar a âncora.')
      } finally {
        setBusy(false)
      }
    },
    [diagnostic, project, session],
  )

  /**
   * Play every track at once, each shifted by its own measured offset.
   *
   * A track with no offset is deliberately left at zero AND flagged, rather
   * than quietly played in step: pretending an unmeasured track is aligned is
   * how a preview convinces someone the session is fine.
   */
  const previewTogether = useCallback(() => {
    if (!diagnostic) return
    for (const track of diagnostic.tracks) {
      const element = players.current[track.trackId]
      if (!element) continue
      const offsetSeconds = (track.offsetMs ?? 0) / 1000
      element.currentTime = Math.max(0, offsetSeconds)
      void element.play().catch(() => {})
    }
  }, [diagnostic])

  return (
    <main data-testid="sync-diagnostic-page" data-status={diagnostic?.status ?? 'none'}>
      <AppShellNavigation active="capture-sessions" />
      <LogoutButton />

      <h1>Diagnóstico de sincronia</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void load()
        }}
      >
        <label>
          Projeto
          <input
            data-testid="project-input"
            onChange={(event) => setProjectId(event.target.value)}
            value={projectId}
          />
        </label>
        <label>
          Sessão
          <input
            data-testid="session-input"
            onChange={(event) => setSessionId(event.target.value)}
            value={sessionId}
          />
        </label>
        <button data-testid="load-diagnostic" disabled={busy} type="submit">
          Abrir
        </button>
      </form>

      {message && <p data-testid="diagnostic-message" role="alert">{message}</p>}

      {conflict && (
        <p data-testid="stale-conflict">
          O diagnóstico está na versão {conflict.currentVersion}.{' '}
          <button data-testid="reload-diagnostic" onClick={() => void load()} type="button">
            Recarregar
          </button>
        </p>
      )}

      {diagnostic && (
        <section data-testid="diagnostic" data-version={diagnostic.version}>
          <h2>
            {STATUS_TEXT[diagnostic.status]} · versão {diagnostic.version}
          </h2>
          <p data-testid="session-binding">
            Descreve a versão {diagnostic.sessionVersion} da sessão, época{' '}
            {diagnostic.referenceEpoch}, referência {diagnostic.referenceTrackId}.
          </p>

          {/* Read from the API, never recomputed. Every reason is shown: an
              operator told only "bloqueado" cannot act on it. */}
          <div data-testid="auto-edit" data-allowed={String(diagnostic.autoEdit.allowed)}>
            {diagnostic.autoEdit.allowed ? (
              <p>Liberado para corte automático.</p>
            ) : (
              <>
                <p>Corte automático bloqueado porque:</p>
                <ul data-testid="auto-edit-blocked">
                  {diagnostic.autoEdit.blockedBy.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {diagnostic.protocolCeiling && (
            <p data-testid="protocol-ceiling">
              Teto do protocolo: {diagnostic.protocolCeiling}. Nenhum ajuste aqui
              sobe esse teto — ele veio do que foi gravado.
            </p>
          )}

          {diagnostic.recommendedActions.length > 0 && (
            <ul data-testid="recommended-actions">
              {diagnostic.recommendedActions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
          )}

          <button data-testid="preview-together" onClick={previewTogether} type="button">
            Pré-visualizar as trilhas juntas
          </button>

          {diagnostic.tracks.map((track) => (
            <article data-testid={`track-${track.trackId}`} key={track.trackId}>
              <h3>
                {track.trackId} — {STATUS_TEXT[track.status]}
              </h3>

              <dl>
                <dt>Deslocamento</dt>
                <dd data-testid={`offset-${track.trackId}`}>{showMs(track.offsetMs)}</dd>
                <dt>Resíduo</dt>
                <dd data-testid={`residual-${track.trackId}`}>{showMs(track.residualMs, 2)}</dd>
                <dt>Deriva</dt>
                <dd data-testid={`drift-${track.trackId}`}>
                  {track.driftPpm === null ? 'não medida' : `${track.driftPpm.toFixed(2)} ppm`}
                </dd>
                <dt>Cobertura</dt>
                <dd data-testid={`coverage-${track.trackId}`}>{showCoverage(track.coverageBps)}</dd>
              </dl>

              {track.offsetMs === null && (
                <p data-testid={`unmeasured-${track.trackId}`}>
                  Não foi possível medir esta trilha. Isso não é o mesmo que
                  estar em zero: nada aqui pode ser cortado às cegas.
                </p>
              )}

              {/* Two players, positioned by the measured offset. The reference
                  is the fixed one; everything else moves relative to it. */}
              <div data-testid={`players-${track.trackId}`}>
                {previewOf[diagnostic.referenceTrackId] ? (
                  <video
                    data-testid={`player-reference-${track.trackId}`}
                    muted
                    ref={(element) => {
                      players.current[diagnostic.referenceTrackId] = element
                    }}
                    src={`/v1/artifacts/${encodeURIComponent(previewOf[diagnostic.referenceTrackId]!)}/content`}
                  />
                ) : (
                  <p data-testid={`no-preview-${diagnostic.referenceTrackId}`}>
                    Sem prévia da trilha de referência.
                  </p>
                )}
                {previewOf[track.trackId] ? (
                  <video
                    data-testid={`player-${track.trackId}`}
                    muted
                    ref={(element) => {
                      players.current[track.trackId] = element
                    }}
                    src={`/v1/artifacts/${encodeURIComponent(previewOf[track.trackId]!)}/content`}
                  />
                ) : (
                  <p data-testid={`no-preview-${track.trackId}`}>Sem prévia desta trilha.</p>
                )}
              </div>

              {/* The waveform is drawn from the preview samples the diagnostic
                  published. An empty list draws nothing rather than a flat
                  line, because a flat line reads as silence that was measured. */}
              {track.previewSampleMs.length > 0 ? (
                <ol data-testid={`waveform-${track.trackId}`}>
                  {track.previewSampleMs.map((sample) => (
                    <li key={sample} style={{ height: 4 }}>
                      {sample}
                    </li>
                  ))}
                </ol>
              ) : (
                <p data-testid={`no-waveform-${track.trackId}`}>
                  Sem amostras de forma de onda para esta trilha.
                </p>
              )}

              <h4>Âncoras</h4>
              <table data-testid={`anchors-${track.trackId}`}>
                <thead>
                  <tr>
                    <th scope="col">Origem</th>
                    <th scope="col">Na fonte</th>
                    <th scope="col">Na sessão</th>
                    <th scope="col">Método</th>
                    <th scope="col">Resíduo</th>
                  </tr>
                </thead>
                <tbody>
                  {[...track.automaticAnchors, ...track.manualAnchors].map((anchor) => (
                    <tr data-origin={anchor.origin} key={anchor.anchorId}>
                      <td>{anchor.origin === 'automatic' ? 'medida' : 'manual'}</td>
                      <td>{anchor.sourceMs.toFixed(1)} ms</td>
                      <td>{anchor.sessionMs.toFixed(1)} ms</td>
                      <td>{anchor.method}</td>
                      <td>{showMs(anchor.residualMs, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div data-testid={`nudge-${track.trackId}`}>
                <button
                  data-testid={`nudge-back-${track.trackId}`}
                  disabled={busy}
                  onClick={() => void editAnchor(track, -FRAME_MS)}
                  type="button"
                >
                  ◀ um quadro
                </button>
                <button
                  data-testid={`nudge-forward-${track.trackId}`}
                  disabled={busy}
                  onClick={() => void editAnchor(track, FRAME_MS)}
                  type="button"
                >
                  um quadro ▶
                </button>
                <span data-testid={`nudge-total-${track.trackId}`}>
                  {(nudgeMs[track.trackId] ?? 0).toFixed(1)} ms acumulados
                </span>
              </div>

              {track.gaps.length > 0 && (
                <p data-testid={`gaps-${track.trackId}`}>
                  Buracos de cobertura:{' '}
                  {track.gaps.map((gap) => `${gap.start}–${gap.end}`).join('; ')}. Nada
                  é resolvido nesses intervalos.
                </p>
              )}

              {track.pieceIds.length > 0 && (
                <p data-testid={`pieces-${track.trackId}`}>
                  Mapa em {track.pieceIds.length} trecho
                  {track.pieceIds.length === 1 ? '' : 's'}: {track.pieceIds.join(', ')}.
                </p>
              )}

              {track.warnings.length > 0 && (
                <ul data-testid={`warnings-${track.trackId}`}>
                  {track.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </section>
      )}
    </main>
  )
}
