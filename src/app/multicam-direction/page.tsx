'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import AppShellNavigation from '@/components/AppShellNavigation'
import LogoutButton from '@/components/LogoutButton'

/**
 * The multicam direction surface (F4.012).
 *
 * The page answers four questions an editor actually asks of a re-cut, and it
 * refuses to answer any of them itself.
 *
 * **Which angle is on screen, and under which rule?** Read out of the stored
 * direction. The page never re-scores: a screen that recomputed "which camera
 * wins" from the same fields could arrive at a different answer than the cut
 * that was rendered, and then two things would claim to be the direction.
 *
 * **Why did the others lose?** Every alternative carries its score and the
 * sentence that rejected it, and every candidate carries its own rejection
 * reasons. A shot that shows only its winner is a decision without a defence.
 *
 * **What did nobody measure?** Coverage confidence and sync confidence are
 * nullable, and a null renders as "não medida". Rendered as `0` it would read
 * as "measured, and useless", which is a different and much more confident
 * claim than "nobody looked".
 *
 * **What still needs a person?** `manualReviewRequired`, the warnings and the
 * uncovered stretches, each shown with its own detail rather than folded into
 * a single badge.
 *
 * Both commands here are fenced on the project version the page read, and the
 * fence comes from the API, never from this file. When the server answers that
 * the version moved, the page stops and offers a reload instead of retrying
 * with the version in its hand — that version is the stale one.
 */

interface ApiEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

interface TickInterval { start: string; end: string }

interface ScorePart { value: number; evidenceRefs: string[] }

interface AngleCandidate {
  candidateId: string
  trackId: string
  role: string
  context: string
  sessionRange: TickInterval
  sourceRange: TickInterval | null
  coverage: { availability: string; confidenceBps: number | null }
  syncStatus: string | null
  syncConfidence: number | null
  protectedSelection: { selectionId: string; reason: string } | null
  eligible: boolean
  rejectionReasons: string[]
  score: { total: number } & Record<string, ScorePart | number>
}

interface ShotAlternative {
  candidateId: string
  trackId: string
  scoreTotal: number
  rejectedBecause: string
}

interface ShotDecision {
  shotId: string
  ordinal: number
  sessionRange: TickInterval
  chosen: AngleCandidate
  audioTrackId: string | null
  alternatives: ShotAlternative[]
  rule: string
  reason: string
  evidenceRefs: string[]
  evidenceRefsTruncated: number
  confidence: number
  confidenceBand: string
}

interface DirectionWarning {
  code: string
  shotId: string | null
  trackId: string | null
  detail: string
}

interface Direction {
  sessionId: string
  sessionVersion: number
  referenceEpoch: number
  diagnosticVersion: number
  range: TickInterval
  format: { aspectRatio: string }
  policy: {
    calibrationVersion: string
    minimumShotMs: number
    maxCutawayMs: number
    jumpCutSameAngleMs: number
    redundancyThreshold: number
    ambiguityMargin: number
  }
  audio: { trackId: string | null; rejected: { trackId: string; reason: string }[] }
  shotCount: number
  uncovered: TickInterval[]
  warnings: DirectionWarning[]
  manualReviewRequired: boolean
  generatedAt: string
  directionHash: string
}

interface DirectionRead {
  direction: Direction
  version: number
  previousVersionHash: string | null
  versionRef: string
  isHead: boolean
}

interface ShotListing extends DirectionRead {
  shots: ShotDecision[]
  omittedShots: number
}

interface CandidateWindow {
  shotId: string
  ordinal: number
  sessionRange: TickInterval
  rule: string
  chosenCandidateId: string
  candidates: AngleCandidate[]
}

interface CandidateListing extends DirectionRead {
  windows: CandidateWindow[]
  omittedWindows: number
}

interface SessionRead {
  sessionId: string
  version: number
  sessionHash: string
  referenceTrackId: string
  clock: { timebase: string; rounding: string }
  tracks: { trackId: string; role: string }[]
}

interface ProjectVersion { id: string; sequence: number; baseHash: string }

/**
 * Ticks divided exactly, or handed back as they arrived.
 *
 * A tick is 64-bit. Parsing one into a `Number` to divide it would undo the
 * whole reason the boundary sends decimal strings, and the rounding would be
 * invisible. When the timebase is unknown the raw string is shown: a duration
 * invented from an assumed rate would be a measurement nobody took.
 */
function formatTicks(ticks: string, ticksPerSecond: bigint | null): string {
  if (ticksPerSecond === null || ticksPerSecond <= BigInt(0)) return `${ticks} ticks`
  try {
    const value = BigInt(ticks)
    const negative = value < BigInt(0)
    const absolute = negative ? -value : value
    const seconds = absolute / ticksPerSecond
    const millis = ((absolute % ticksPerSecond) * BigInt(1_000)) / ticksPerSecond
    return `${negative ? '−' : ''}${seconds},${String(millis).padStart(3, '0')} s`
  } catch {
    return `${ticks} ticks`
  }
}

/** `"1/90000"` seconds per tick means ninety thousand ticks in a second. */
function ticksPerSecondFrom(secondsPerTick: string | undefined): bigint | null {
  if (!secondsPerTick) return null
  const [num, den] = secondsPerTick.split('/')
  try {
    const numerator = BigInt(num ?? '')
    const denominator = BigInt(den ?? '')
    if (numerator <= BigInt(0) || denominator <= BigInt(0)) return null
    return denominator / numerator
  } catch {
    return null
  }
}

/** A measurement in basis points, or the honest absence of one. */
function showBps(value: number | null): string {
  return value === null ? 'não medida' : `${(value / 100).toFixed(2)} %`
}

function showRatio(value: number | null): string {
  return value === null ? 'não medida' : value.toFixed(3)
}

const RULE_TEXT: Record<string, string> = {
  'demonstration-prefers-screen': 'demonstração pede a tela',
  'speech-prefers-active-speaker': 'fala pede quem está falando',
  'reaction-cutaway': 'corte para a reação',
  'cutaway-return': 'volta do corte de reação',
  'redundant-angles-hold': 'ângulos redundantes: segurou',
  'minimum-shot-hold': 'plano mínimo: segurou',
  'jump-cut-avoided': 'evitou o salto',
  'protected-selection': 'seleção protegida por uma pessoa',
  'conservative-hold': 'na dúvida, segurou',
}

const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5'] as const

export default function MulticamDirectionPage() {
  const [projectId, setProjectId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [read, setRead] = useState<DirectionRead | null>(null)
  const [shots, setShots] = useState<ShotListing | null>(null)
  const [candidates, setCandidates] = useState<CandidateListing | null>(null)
  const [session, setSession] = useState<SessionRead | null>(null)
  const [projectVersion, setProjectVersion] = useState<ProjectVersion | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [aspectRatio, setAspectRatio] = useState<string>('16:9')
  const [openWindow, setOpenWindow] = useState<string | null>(null)
  const [protectShotId, setProtectShotId] = useState('')
  const [protectTrackId, setProtectTrackId] = useState('')
  const [protectNote, setProtectNote] = useState('')

  // Two values rather than one joined path: the parity audit reads each fetch's
  // URL out of the source, and a variable holding the whole route would make
  // these calls invisible to it.
  const project = useMemo(() => encodeURIComponent(projectId.trim()), [projectId])
  const encodedSession = useMemo(() => encodeURIComponent(sessionId.trim()), [sessionId])
  const ticksPerSecond = useMemo(
    () => ticksPerSecondFrom(session?.clock.timebase),
    [session],
  )

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
      // The session and the project version are read, never assumed: they are
      // the fence both commands below have to name, and a fence a page made up
      // would be a fence that never fences anything.
      const sessionResponse = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const sessionBody = (await sessionResponse.json()) as ApiEnvelope<{ session: SessionRead }>
      if (sessionResponse.ok && sessionBody.data) setSession(sessionBody.data.session)

      const workspaceResponse = await fetch(
        `/v1/projects/${project}/workspace`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const workspaceBody = (await workspaceResponse.json()) as ApiEnvelope<{ version?: ProjectVersion }>
      setProjectVersion(workspaceBody.data?.version ?? null)

      const response = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/direction`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const body = (await response.json()) as ApiEnvelope<DirectionRead>
      if (!response.ok || !body.data) {
        setRead(null)
        setShots(null)
        setCandidates(null)
        setMessage(body.error?.message ?? 'Esta sessão ainda não foi dirigida.')
        return
      }
      setRead(body.data)
      setAspectRatio(body.data.direction.format.aspectRatio)

      const shotsResponse = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/direction/shots`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const shotsBody = (await shotsResponse.json()) as ApiEnvelope<ShotListing>
      setShots(shotsResponse.ok && shotsBody.data ? shotsBody.data : null)

      const candidatesResponse = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/direction/candidates`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const candidatesBody = (await candidatesResponse.json()) as ApiEnvelope<CandidateListing>
      setCandidates(candidatesResponse.ok && candidatesBody.data ? candidatesBody.data : null)
    } catch {
      setMessage('A rede falhou ao ler a direção.')
    } finally {
      setBusy(false)
    }
  }, [encodedSession, project, projectId, sessionId])

  const linkedRef = useRef(false)
  useEffect(() => {
    if (linkedRef.current || projectId.length === 0 || sessionId.length === 0) return
    linkedRef.current = true
    void load()
  }, [load, projectId, sessionId])

  /** 409 with the version the server is actually holding, or a plain refusal. */
  const handleRefusal = useCallback((status: number, body: ApiEnvelope<unknown>) => {
    if (status === 409) {
      const current = body.error?.details?.currentVersionId ?? body.error?.details?.currentVersion
      setConflict(typeof current === 'string' || typeof current === 'number' ? String(current) : 'outra')
      setMessage(
        'O projeto avançou enquanto esta tela olhava para outra versão. '
        + 'Recarregue antes de dirigir de novo: o pedido foi calculado sobre uma versão que já não é a atual.',
      )
      return true
    }
    return false
  }, [])

  const direct = useCallback(async () => {
    if (!projectVersion) {
      setMessage('Sem versão de projeto para ancorar o comando. Recarregue.')
      return
    }
    setBusy(true)
    setMessage(null)
    setConflict(null)
    try {
      const response = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/direction`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            // The key is the exact version this cut was computed against, so a
            // double click rejoins the run it already started instead of
            // cutting the session twice.
            'idempotency-key': `direct-${sessionId.trim()}-${projectVersion.id}-${aspectRatio}`,
          },
          body: JSON.stringify({
            baseVersionId: projectVersion.id,
            baseHash: projectVersion.baseHash,
            format: { aspectRatio },
          }),
        },
      )
      const body = (await response.json()) as ApiEnvelope<{ directed: unknown; replayed: boolean }>
      if (handleRefusal(response.status, body)) return
      if (!response.ok) {
        setMessage(body.error?.message ?? 'A direção foi recusada.')
        return
      }
      setMessage(body.data?.replayed ? 'Mesmo pedido, mesma resposta: nada foi cortado de novo.' : 'Sessão dirigida.')
      await load()
    } catch {
      setMessage('A rede falhou ao dirigir a sessão.')
    } finally {
      setBusy(false)
    }
  }, [aspectRatio, encodedSession, handleRefusal, load, project, projectVersion, sessionId])

  const protectSelection = useCallback(async () => {
    const shot = shots?.shots.find((entry) => entry.shotId === protectShotId)
    if (!shot || !projectVersion) {
      setMessage('Escolha um plano e recarregue a versão antes de proteger uma seleção.')
      return
    }
    if (protectNote.trim().length === 0) {
      setMessage('Diga por que esta seleção é protegida: quem sobrepõe a medição assina o motivo.')
      return
    }
    setBusy(true)
    setMessage(null)
    setConflict(null)
    try {
      const response = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/direction/protected-selections`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'idempotency-key': `protect-${shot.shotId}-${projectVersion.id}`,
          },
          body: JSON.stringify({
            baseVersionId: projectVersion.id,
            baseHash: projectVersion.baseHash,
            format: { aspectRatio },
            protectedSelections: [{
              selectionId: `selection-${shot.shotId}`,
              trackId: protectTrackId.trim().length > 0 ? protectTrackId.trim() : shot.chosen.trackId,
              sessionStartTicks: shot.sessionRange.start,
              sessionEndTicks: shot.sessionRange.end,
              // The operator's own words. Who attested it is the authenticated
              // actor, and the server concatenates the two rather than letting
              // this note stand in for an identity.
              note: protectNote.trim(),
            }],
          }),
        },
      )
      const body = (await response.json()) as ApiEnvelope<{ replayed: boolean }>
      if (handleRefusal(response.status, body)) return
      if (!response.ok) {
        setMessage(body.error?.message ?? 'A seleção protegida foi recusada.')
        return
      }
      setMessage('Seleção protegida e sessão redirigida.')
      setProtectNote('')
      await load()
    } catch {
      setMessage('A rede falhou ao proteger a seleção.')
    } finally {
      setBusy(false)
    }
  }, [
    aspectRatio, encodedSession, handleRefusal, load, project, projectVersion,
    protectNote, protectShotId, protectTrackId, shots,
  ])

  const direction = read?.direction ?? null

  return (
    <main data-testid="multicam-direction-page" data-review={String(direction?.manualReviewRequired ?? false)}>
      <AppShellNavigation active="capture-sessions" />
      <LogoutButton />

      <h1>Direção multicâmera</h1>

      {/* Cross navigation: the shell has a fixed set of destinations, so the
          sibling operator surfaces are reached from one another. */}
      <nav data-testid="direction-siblings">
        <a data-testid="link-capture-sessions" href="/capture-sessions">Sessões de captura</a>
        <a
          data-testid="link-color-match"
          href={`/color-match?projeto=${encodeURIComponent(projectId.trim())}&sessao=${encodeURIComponent(sessionId.trim())}`}
        >
          Cor multicâmera
        </a>
        <a
          data-testid="link-playback-map"
          href={`/playback-map?projeto=${encodeURIComponent(projectId.trim())}&sessao=${encodeURIComponent(sessionId.trim())}`}
        >
          Mapa de playback
        </a>
        <a
          data-testid="link-sync-diagnostic"
          href={`/sync-diagnostic?projeto=${encodeURIComponent(projectId.trim())}&sessao=${encodeURIComponent(sessionId.trim())}`}
        >
          Diagnóstico de sincronia
        </a>
      </nav>

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
        <button data-testid="load-direction" disabled={busy} type="submit">Abrir</button>
      </form>

      {message && <p data-testid="direction-message" role="alert">{message}</p>}

      {conflict && (
        <p data-testid="stale-conflict">
          A versão corrente é {conflict}.{' '}
          <button data-testid="reload-direction" onClick={() => void load()} type="button">
            Recarregar
          </button>
        </p>
      )}

      <section data-testid="direction-command">
        <h2>Dirigir</h2>
        <label>
          Formato
          <select
            data-testid="aspect-ratio"
            onChange={(event) => setAspectRatio(event.target.value)}
            value={aspectRatio}
          >
            {ASPECT_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
          </select>
        </label>
        <p data-testid="direction-fence">
          {projectVersion
            ? `Ancorado na versão ${projectVersion.id} (sequência ${projectVersion.sequence}) do projeto.`
            : 'Sem versão de projeto lida — nada pode ser ancorado.'}
        </p>
        <button data-testid="run-direction" disabled={busy || !projectVersion} onClick={() => void direct()} type="button">
          Dirigir a sessão
        </button>
      </section>

      {direction && read && (
        <section data-testid="direction-summary" data-version={read.version}>
          <h2>
            Direção v{read.version} · {direction.shotCount} plano{direction.shotCount === 1 ? '' : 's'}
          </h2>
          <p data-testid="direction-head">
            {read.isHead
              ? 'Este é o elo corrente da cadeia.'
              : 'Este elo foi superado por outro corte — não é a direção corrente.'}
          </p>
          <dl>
            <dt>Trecho dirigido</dt>
            <dd data-testid="direction-range">
              {formatTicks(direction.range.start, ticksPerSecond)} → {formatTicks(direction.range.end, ticksPerSecond)}
            </dd>
            <dt>Formato</dt>
            <dd data-testid="direction-format">{direction.format.aspectRatio}</dd>
            <dt>Sessão</dt>
            <dd data-testid="direction-session">
              versão {direction.sessionVersion}, época {direction.referenceEpoch}, diagnóstico v{direction.diagnosticVersion}
            </dd>
            <dt>Calibração</dt>
            <dd data-testid="direction-calibration">{direction.policy.calibrationVersion}</dd>
            <dt>Leito de áudio</dt>
            <dd data-testid="direction-audio">
              {direction.audio.trackId ?? 'nenhuma faixa serviu de leito'}
            </dd>
          </dl>

          <p data-testid="direction-policy">
            Plano mínimo {direction.policy.minimumShotMs} ms · corte de reação até{' '}
            {direction.policy.maxCutawayMs} ms · mesmo ângulo por{' '}
            {direction.policy.jumpCutSameAngleMs} ms · redundância{' '}
            {direction.policy.redundancyThreshold} · margem de ambiguidade{' '}
            {direction.policy.ambiguityMargin}
          </p>

          {direction.audio.rejected.length > 0 && (
            <ul data-testid="audio-rejected">
              {direction.audio.rejected.map((entry) => (
                <li key={entry.trackId}>{entry.trackId}: {entry.reason}</li>
              ))}
            </ul>
          )}

          <div data-testid="manual-review" data-required={String(direction.manualReviewRequired)}>
            {direction.manualReviewRequired
              ? <p>Esta direção exige revisão humana antes de virar corte final.</p>
              : <p>Nada nesta direção exige revisão humana.</p>}
          </div>

          {direction.warnings.length > 0 && (
            <ul data-testid="direction-warnings">
              {direction.warnings.map((warning, index) => (
                <li data-testid={`warning-${warning.code}`} key={`${warning.code}-${index}`}>
                  {warning.code}: {warning.detail}
                  {warning.shotId ? ` (plano ${warning.shotId})` : ''}
                  {warning.trackId ? ` (faixa ${warning.trackId})` : ''}
                </li>
              ))}
            </ul>
          )}

          {direction.uncovered.length > 0 && (
            <p data-testid="direction-uncovered">
              Nenhum ângulo era elegível entre{' '}
              {direction.uncovered
                .map((gap) => `${formatTicks(gap.start, ticksPerSecond)} e ${formatTicks(gap.end, ticksPerSecond)}`)
                .join('; ')}
              . Nada é ligado por cima desses trechos.
            </p>
          )}
        </section>
      )}

      {shots && (
        <section data-testid="shot-list">
          <h2>Planos e o que perdeu</h2>
          {shots.omittedShots > 0 && (
            <p data-testid="shots-omitted">
              O limite deixou {shots.omittedShots} plano{shots.omittedShots === 1 ? '' : 's'} de fora desta página.
            </p>
          )}
          {shots.shots.length === 0 && <p data-testid="shots-empty">Nenhum plano nesta direção.</p>}
          {shots.shots.map((shot) => (
            <article data-testid={`shot-${shot.shotId}`} key={shot.shotId}>
              <h3>
                #{shot.ordinal} ·{' '}
                <span data-testid={`chosen-${shot.shotId}`}>{shot.chosen.trackId}</span>{' '}
                ({shot.chosen.context})
              </h3>
              <p data-testid={`range-${shot.shotId}`}>
                {formatTicks(shot.sessionRange.start, ticksPerSecond)} →{' '}
                {formatTicks(shot.sessionRange.end, ticksPerSecond)}
              </p>
              <p data-testid={`rule-${shot.shotId}`}>
                Regra: {RULE_TEXT[shot.rule] ?? shot.rule}
              </p>
              <p data-testid={`reason-${shot.shotId}`}>{shot.reason}</p>
              <p data-testid={`confidence-${shot.shotId}`}>
                Confiança {shot.confidence.toFixed(3)} ({shot.confidenceBand})
              </p>
              <p data-testid={`audio-${shot.shotId}`}>
                Áudio: {shot.audioTrackId ?? 'o próprio som do plano'}
              </p>

              {shot.alternatives.length === 0 ? (
                <p data-testid={`alternatives-empty-${shot.shotId}`}>
                  Nenhum outro ângulo foi oferecido aqui.
                </p>
              ) : (
                <table data-testid={`alternatives-${shot.shotId}`}>
                  <thead>
                    <tr>
                      <th scope="col">Ângulo</th>
                      <th scope="col">Nota</th>
                      <th scope="col">Por que perdeu</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shot.alternatives.map((alternative) => (
                      <tr data-testid={`alternative-${alternative.candidateId}`} key={alternative.candidateId}>
                        <td>{alternative.trackId}</td>
                        <td>{alternative.scoreTotal.toFixed(3)}</td>
                        <td data-testid={`lost-${alternative.candidateId}`}>{alternative.rejectedBecause}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <p data-testid={`evidence-${shot.shotId}`}>
                {shot.evidenceRefs.length} citação{shot.evidenceRefs.length === 1 ? '' : 'ões'}
                {shot.evidenceRefsTruncated > 0
                  ? `, e o teto cortou outras ${shot.evidenceRefsTruncated}.`
                  : ' — a lista está inteira.'}
              </p>

              <button
                data-testid={`open-window-${shot.shotId}`}
                onClick={() => setOpenWindow((current) => (current === shot.shotId ? null : shot.shotId))}
                type="button"
              >
                Ver todos os ângulos avaliados
              </button>
            </article>
          ))}
        </section>
      )}

      {candidates && (
        <section data-testid="candidate-windows">
          <h2>Ângulos avaliados</h2>
          {candidates.omittedWindows > 0 && (
            <p data-testid="windows-omitted">
              O limite deixou {candidates.omittedWindows} janela
              {candidates.omittedWindows === 1 ? '' : 's'} de fora.
            </p>
          )}
          {candidates.windows
            .filter((window) => openWindow === null || openWindow === window.shotId)
            .map((window) => (
              <article data-testid={`window-${window.shotId}`} key={window.shotId}>
                <h3>
                  #{window.ordinal} · {RULE_TEXT[window.rule] ?? window.rule}
                </h3>
                <table data-testid={`candidates-${window.shotId}`}>
                  <thead>
                    <tr>
                      <th scope="col">Faixa</th>
                      <th scope="col">Elegível</th>
                      <th scope="col">Cobertura</th>
                      <th scope="col">Sincronia</th>
                      <th scope="col">Nota</th>
                      <th scope="col">Recusas</th>
                    </tr>
                  </thead>
                  <tbody>
                    {window.candidates.map((candidate) => (
                      <tr
                        data-chosen={String(candidate.candidateId === window.chosenCandidateId)}
                        data-testid={`candidate-${candidate.candidateId}`}
                        key={candidate.candidateId}
                      >
                        <td>{candidate.trackId}</td>
                        <td>{candidate.eligible ? 'sim' : 'não'}</td>
                        <td data-testid={`coverage-${candidate.candidateId}`}>
                          {candidate.coverage.availability} · {showBps(candidate.coverage.confidenceBps)}
                        </td>
                        <td data-testid={`sync-${candidate.candidateId}`}>
                          {candidate.syncStatus ?? 'não medida'} · {showRatio(candidate.syncConfidence)}
                        </td>
                        <td>{candidate.score.total.toFixed(3)}</td>
                        <td data-testid={`rejections-${candidate.candidateId}`}>
                          {candidate.rejectionReasons.length === 0
                            ? '—'
                            : candidate.rejectionReasons.join(', ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </article>
            ))}
        </section>
      )}

      {shots && shots.shots.length > 0 && (
        <section data-testid="protect-selection">
          <h2>Proteger uma seleção</h2>
          <p>
            Proteger é uma pessoa sobrepondo o que o medidor preferiu. O motivo
            é seu; a identidade é a do ator autenticado, e o servidor guarda as
            duas.
          </p>
          <label>
            Plano
            <select
              data-testid="protect-shot"
              onChange={(event) => setProtectShotId(event.target.value)}
              value={protectShotId}
            >
              <option value="">escolha um plano</option>
              {shots.shots.map((shot) => (
                <option key={shot.shotId} value={shot.shotId}>
                  #{shot.ordinal} — {shot.chosen.trackId}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ângulo (vazio mantém o escolhido)
            <select
              data-testid="protect-track"
              onChange={(event) => setProtectTrackId(event.target.value)}
              value={protectTrackId}
            >
              <option value="">manter o ângulo escolhido</option>
              {(session?.tracks ?? []).map((track) => (
                <option key={track.trackId} value={track.trackId}>
                  {track.trackId} ({track.role})
                </option>
              ))}
            </select>
          </label>
          <label>
            Motivo
            <input
              data-testid="protect-note"
              onChange={(event) => setProtectNote(event.target.value)}
              value={protectNote}
            />
          </label>
          <button
            data-testid="submit-protect"
            disabled={busy || protectShotId.length === 0}
            onClick={() => void protectSelection()}
            type="button"
          >
            Proteger e redirigir
          </button>
        </section>
      )}
    </main>
  )
}
