'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import AppShellNavigation from '@/components/AppShellNavigation'
import LogoutButton from '@/components/LogoutButton'

/**
 * The react playback map surface (F4.015).
 *
 * The map says what the player did — playing, paused, rewound, replayed,
 * seeked, or talked over with the reference stopped — and this page draws that
 * account without smoothing any of its three honest absences.
 *
 * **A rate is measured or it is absent.** Only the fingerprinter measures one;
 * a piece a person placed carries none. Rendered as `1/1` an unmeasured rate
 * would make a hand-answered map indistinguishable from a verified one, so
 * null renders as "não medida".
 *
 * **A paused stretch has no reference range, and that is the answer.** The
 * reference produced no time at all there; an interval printed in that column
 * would be a claim nobody measured.
 *
 * **An uncovered stretch is not a piece with holes.** It travels in its own
 * list with the reason nobody could resolve it, because "the player was hidden
 * and it could have been any of three things" is a finding, not a gap.
 *
 * The anchor editor answers those stretches and nothing else. An anchor is
 * added and never moved or removed: the list only grows, automatic anchors are
 * never touched, and an instant outside an uncovered stretch is refused by the
 * server — overruling a measurement is a different act from answering an
 * absence, and this page does not offer the first one.
 */

interface ApiEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

interface TickInterval { start: string; end: string }

interface PlaybackPiece {
  pieceId: string
  ordinal: number
  mode: string
  reactionRange: TickInterval
  referenceRange: TickInterval | null
  rate: string | null
  direction: string
  confidence: number
  evidenceRefs: string[]
  detectionMethod: string
  residualTicks: string | null
  discontinuityReason: string | null
}

interface PlaybackAnchor {
  anchorId: string
  origin: string
  reactionTick: string
  referenceTick: string | null
  mode: string
  method: string
  confidence: number
  evidenceRef: string
  createdAt: string
}

interface PlaybackMap {
  mapId: string
  sessionId: string
  sessionVersion: number
  referenceEpoch: number
  reactionTrackId: string
  referenceTrackId: string
  referenceMedia: {
    assetId: string
    sha256: string
    durationTicks: string
    timebase: { secondsPerTick: string }
  }
  reactionMedia: { assetId: string; sha256: string; durationTicks: string }
  version: number
  previousVersionHash: string | null
  supersedesMapId: string | null
  pieceCount: number
  uncovered: { range: TickInterval; reason: string }[]
  anchors: PlaybackAnchor[]
  status: string
  warnings: string[]
  mapHash: string
}

interface PlaybackMapRead {
  map: PlaybackMap
  versionRef: string
  manualReviewRequired: boolean
}

interface PieceListing extends PlaybackMapRead {
  pieces: PlaybackPiece[]
  filteredOut: number
  omittedPieces: number
}

interface SessionRead {
  sessionId: string
  version: number
  sessionHash: string
  clock: { timebase: string; rounding: string }
  tracks: { trackId: string; role: string }[]
}

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

/**
 * Ticks divided exactly. A tick is 64-bit; `Number` would round it invisibly,
 * which is the whole reason it crosses the boundary as a decimal string.
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

const MODE_TEXT: Record<string, string> = {
  playing: 'tocando',
  paused: 'pausado',
  rewind: 'voltando',
  replay: 'revendo',
  seek: 'pulou',
  'commentary-only': 'só comentário',
}

const UNCOVERED_TEXT: Record<string, string> = {
  'manual-anchor-required': 'ninguém conseguiu medir; precisa de uma âncora manual',
  'conflicting-evidence': 'as evidências discordam entre si',
}

const ANCHOR_MODES = ['playing', 'paused', 'rewind', 'replay', 'seek', 'commentary-only'] as const

export default function PlaybackMapPage() {
  const [projectId, setProjectId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [reactionTrackId, setReactionTrackId] = useState('')
  const [session, setSession] = useState<SessionRead | null>(null)
  const [listing, setListing] = useState<PieceListing | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [anchorIndex, setAnchorIndex] = useState('0')
  const [anchorReactionTick, setAnchorReactionTick] = useState('')
  const [anchorReferenceTick, setAnchorReferenceTick] = useState('')
  const [anchorMode, setAnchorMode] = useState<string>('playing')
  const [anchorNote, setAnchorNote] = useState('')

  const project = useMemo(() => encodeURIComponent(projectId.trim()), [projectId])
  const encodedSession = useMemo(() => encodeURIComponent(sessionId.trim()), [sessionId])
  const reactor = useMemo(() => encodeURIComponent(reactionTrackId.trim()), [reactionTrackId])
  const sessionTicksPerSecond = useMemo(
    () => ticksPerSecondFrom(session?.clock.timebase),
    [session],
  )
  // The reference has its own timebase, carried by the map. Reference ticks
  // formatted with the reaction's rate would be a plausible-looking number that
  // means nothing.
  const referenceTicksPerSecond = useMemo(
    () => ticksPerSecondFrom(listing?.map.referenceMedia.timebase.secondsPerTick),
    [listing],
  )

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const linkedProject = params.get('projeto')
    const linkedSession = params.get('sessao')
    const linkedTrack = params.get('reator')
    if (linkedProject) setProjectId(linkedProject)
    if (linkedSession) setSessionId(linkedSession)
    if (linkedTrack) setReactionTrackId(linkedTrack)
  }, [])

  const loadSession = useCallback(async () => {
    if (projectId.trim().length === 0 || sessionId.trim().length === 0) return
    try {
      const response = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const body = (await response.json()) as ApiEnvelope<{ session: SessionRead }>
      if (!response.ok || !body.data) {
        setMessage(body.error?.message ?? 'Não foi possível ler a sessão.')
        return
      }
      setSession(body.data.session)
      // Which reactor is required, never guessed: a session with two reaction
      // tracks is two edits, and answering about the first would answer about
      // the wrong one. Offering the first as a default is a suggestion the
      // operator can see and change, not an assumption the page hides.
      setReactionTrackId((current) => {
        if (current.trim().length > 0) return current
        const reaction = body.data!.session.tracks.find((track) => track.role === 'reaction')
        return reaction?.trackId ?? ''
      })
    } catch {
      setMessage('A rede falhou ao ler a sessão.')
    }
  }, [encodedSession, project, projectId, sessionId])

  const load = useCallback(async () => {
    if (projectId.trim().length === 0 || sessionId.trim().length === 0) return
    setBusy(true)
    setMessage(null)
    setConflict(null)
    try {
      await loadSession()
      if (reactionTrackId.trim().length === 0) {
        setListing(null)
        setMessage('Diga qual reator: a sessão pode ter mais de um, e cada um é uma edição.')
        return
      }
      const response = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/playback-map?reactionTrackId=${reactor}`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const body = (await response.json()) as ApiEnvelope<PlaybackMapRead>
      if (!response.ok || !body.data) {
        setListing(null)
        setMessage(body.error?.message ?? 'Este reator ainda não tem mapa de playback.')
        return
      }

      const piecesResponse = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/playback-map/pieces?reactionTrackId=${reactor}`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const piecesBody = (await piecesResponse.json()) as ApiEnvelope<PieceListing>
      if (piecesResponse.ok && piecesBody.data) {
        setListing(piecesBody.data)
      } else {
        // The map read succeeded; only the piece-by-piece account did not. Kept
        // apart so an empty piece list never reads as "the player did nothing".
        setListing({ ...body.data, pieces: [], filteredOut: 0, omittedPieces: 0 })
        setMessage(piecesBody.error?.message ?? 'O mapa foi lido, mas os trechos não.')
      }
    } catch {
      setMessage('A rede falhou ao ler o mapa de playback.')
    } finally {
      setBusy(false)
    }
  }, [encodedSession, loadSession, project, projectId, reactionTrackId, reactor, sessionId])

  const linkedRef = useRef(false)
  useEffect(() => {
    if (linkedRef.current || projectId.length === 0 || sessionId.length === 0) return
    linkedRef.current = true
    void load()
  }, [load, projectId, sessionId])

  const handleRefusal = useCallback((status: number, body: ApiEnvelope<unknown>) => {
    if (status === 409) {
      const current = body.error?.details?.currentVersionId ?? body.error?.details?.currentVersion
      setConflict(typeof current === 'string' || typeof current === 'number' ? String(current) : 'outra')
      setMessage(
        'O mapa ou a sessão avançaram enquanto esta tela olhava. Recarregue antes de repetir: '
        + 'a versão em mãos é a vencida.',
      )
      return true
    }
    return false
  }, [])

  const build = useCallback(async () => {
    if (!session) {
      setMessage('Sem sessão lida não há em que ancorar a medição.')
      return
    }
    setBusy(true)
    setMessage(null)
    setConflict(null)
    try {
      const response = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/playback-map`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            // The session fence and which reactor: nothing else. Every piece,
            // mode, rate and residual is read off the recordings, and a request
            // that could contribute one could say the player never paused.
            baseVersionId: `${session.sessionId}:v${session.version}`,
            baseHash: session.sessionHash,
            reactionTrackId: reactionTrackId.trim(),
          }),
        },
      )
      const body = (await response.json()) as ApiEnvelope<{
        replayed: boolean
        carriedAnchors: number
        droppedAnchors: number
      }>
      if (handleRefusal(response.status, body)) return
      if (!response.ok || !body.data) {
        setMessage(body.error?.message ?? 'A medição foi recusada.')
        return
      }
      setMessage(
        body.data.replayed
          ? 'As mesmas gravações deram o mesmo mapa: nada foi medido de novo.'
          : `Mapa construído. ${body.data.carriedAnchors} âncora(s) seguiram; `
            + `${body.data.droppedAnchors} caíram porque a gravação que elas apontavam mudou.`,
      )
      await load()
    } catch {
      setMessage('A rede falhou ao construir o mapa.')
    } finally {
      setBusy(false)
    }
  }, [encodedSession, handleRefusal, load, project, reactionTrackId, session])

  const addAnchor = useCallback(async () => {
    if (!listing) return
    const stretch = listing.map.uncovered[Number(anchorIndex)]
    if (!stretch) {
      setMessage('Escolha o trecho sem resposta que esta âncora responde.')
      return
    }
    if (anchorReactionTick.trim().length === 0) {
      setMessage('Diga o instante da reação, em ticks.')
      return
    }
    setBusy(true)
    setMessage(null)
    setConflict(null)
    try {
      const response = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/playback-map/anchors`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            // The fence as the read handed it over — the exact version and hash
            // this screen was looking at when the operator placed the anchor.
            baseVersionId: listing.versionRef,
            baseHash: listing.map.mapHash,
            reactionTrackId: listing.map.reactionTrackId,
            anchor: {
              anchorId: `manual-${listing.map.reactionTrackId}-v${listing.map.version}-${listing.map.anchors.length + 1}`,
              reactionTick: anchorReactionTick.trim(),
              // Null is an answer — "there was no reference here" — and it is
              // sent explicitly. Omitting the field would leave that and "the
              // operator said nothing" indistinguishable, so the boundary
              // refuses an absent one.
              referenceTick: anchorReferenceTick.trim().length === 0 ? null : anchorReferenceTick.trim(),
              mode: anchorMode,
              ...(anchorNote.trim().length === 0 ? {} : { note: anchorNote.trim() }),
            },
          }),
        },
      )
      const body = (await response.json()) as ApiEnvelope<{ replayed: boolean }>
      if (handleRefusal(response.status, body)) return
      if (!response.ok) {
        setMessage(body.error?.message ?? 'A âncora foi recusada.')
        return
      }
      setMessage('Âncora registrada. Âncoras são acrescentadas, nunca movidas nem apagadas.')
      setAnchorNote('')
      await load()
    } catch {
      setMessage('A rede falhou ao registrar a âncora.')
    } finally {
      setBusy(false)
    }
  }, [
    anchorIndex, anchorMode, anchorNote, anchorReactionTick, anchorReferenceTick,
    encodedSession, handleRefusal, listing, load, project,
  ])

  const map = listing?.map ?? null

  return (
    <main data-testid="playback-map-page" data-status={map?.status ?? 'none'}>
      <AppShellNavigation active="capture-sessions" />
      <LogoutButton />

      <h1>Mapa de playback</h1>

      <nav data-testid="playback-siblings">
        <a data-testid="link-capture-sessions" href="/capture-sessions">Sessões de captura</a>
        <a
          data-testid="link-multicam-direction"
          href={`/multicam-direction?projeto=${encodeURIComponent(projectId.trim())}&sessao=${encodeURIComponent(sessionId.trim())}`}
        >
          Direção multicâmera
        </a>
        <a
          data-testid="link-color-match"
          href={`/color-match?projeto=${encodeURIComponent(projectId.trim())}&sessao=${encodeURIComponent(sessionId.trim())}`}
        >
          Cor multicâmera
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
        <label>
          Reator
          <input
            data-testid="reactor-input"
            list="playback-reaction-tracks"
            onChange={(event) => setReactionTrackId(event.target.value)}
            value={reactionTrackId}
          />
        </label>
        <datalist id="playback-reaction-tracks">
          {(session?.tracks ?? [])
            .filter((track) => track.role === 'reaction')
            .map((track) => <option key={track.trackId} value={track.trackId} />)}
        </datalist>
        <button data-testid="load-playback-map" disabled={busy} type="submit">Abrir</button>
      </form>

      {message && <p data-testid="playback-message" role="alert">{message}</p>}

      {conflict && (
        <p data-testid="stale-conflict">
          A versão corrente é {conflict}.{' '}
          <button data-testid="reload-playback-map" onClick={() => void load()} type="button">
            Recarregar
          </button>
        </p>
      )}

      <section data-testid="build-command">
        <h2>Medir o playback</h2>
        <p>
          A impressão digital do áudio compara a reação com a referência. O que
          esta tela manda é só a sessão e o reator.
        </p>
        <button data-testid="build-map" disabled={busy || !session} onClick={() => void build()} type="button">
          Construir o mapa
        </button>
      </section>

      {map && listing && (
        <section data-testid="playback-summary" data-version={map.version}>
          <h2>
            Mapa v{map.version} · {map.status} · {map.pieceCount} trecho
            {map.pieceCount === 1 ? '' : 's'}
          </h2>
          <p data-testid="playback-media">
            Referência {map.referenceTrackId} ({map.referenceMedia.assetId},{' '}
            {formatTicks(map.referenceMedia.durationTicks, referenceTicksPerSecond)}) · reação{' '}
            {map.reactionTrackId} ({map.reactionMedia.assetId},{' '}
            {formatTicks(map.reactionMedia.durationTicks, sessionTicksPerSecond)})
          </p>
          <div data-testid="playback-review" data-required={String(listing.manualReviewRequired)}>
            {listing.manualReviewRequired
              ? <p>Há trecho sem resposta: uma pessoa tem que dizer o que aconteceu ali.</p>
              : <p>Nada neste mapa está esperando uma pessoa.</p>}
          </div>
          {map.supersedesMapId && (
            <p data-testid="playback-superseded">
              Este mapa substitui {map.supersedesMapId}: a gravação de referência
              mudou, e todo tick de referência antigo passou a significar outra coisa.
            </p>
          )}
          {map.warnings.length > 0 && (
            <ul data-testid="playback-warnings">
              {map.warnings.map((warning) => (
                <li data-testid={`warning-${warning}`} key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {listing && (
        <section data-testid="piece-list">
          <h2>O que o player fez</h2>
          {listing.filteredOut > 0 && (
            <p data-testid="pieces-filtered">
              O filtro tirou {listing.filteredOut} trecho
              {listing.filteredOut === 1 ? '' : 's'} desta lista.
            </p>
          )}
          {listing.omittedPieces > 0 && (
            <p data-testid="pieces-omitted">
              O limite deixou {listing.omittedPieces} trecho
              {listing.omittedPieces === 1 ? '' : 's'} de fora.
            </p>
          )}
          {listing.pieces.length === 0 && <p data-testid="pieces-empty">Nenhum trecho nesta leitura.</p>}
          {listing.pieces.length > 0 && (
            <table data-testid="pieces">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Modo</th>
                  <th scope="col">Na reação</th>
                  <th scope="col">Na referência</th>
                  <th scope="col">Velocidade</th>
                  <th scope="col">Resíduo</th>
                  <th scope="col">Método</th>
                </tr>
              </thead>
              <tbody>
                {listing.pieces.map((piece) => (
                  <tr data-mode={piece.mode} data-testid={`piece-${piece.pieceId}`} key={piece.pieceId}>
                    <td>{piece.ordinal}</td>
                    <td data-testid={`mode-${piece.pieceId}`}>{MODE_TEXT[piece.mode] ?? piece.mode}</td>
                    <td>
                      {formatTicks(piece.reactionRange.start, sessionTicksPerSecond)} →{' '}
                      {formatTicks(piece.reactionRange.end, sessionTicksPerSecond)}
                    </td>
                    <td data-testid={`reference-${piece.pieceId}`}>
                      {piece.referenceRange === null
                        ? 'a referência não andou'
                        : `${formatTicks(piece.referenceRange.start, referenceTicksPerSecond)} → `
                          + `${formatTicks(piece.referenceRange.end, referenceTicksPerSecond)}`}
                    </td>
                    <td data-testid={`rate-${piece.pieceId}`}>{piece.rate ?? 'não medida'}</td>
                    <td data-testid={`residual-${piece.pieceId}`}>
                      {piece.residualTicks === null
                        ? 'não medido'
                        : formatTicks(piece.residualTicks, referenceTicksPerSecond)}
                    </td>
                    <td data-testid={`method-${piece.pieceId}`}>{piece.detectionMethod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {map && (
        <section data-testid="uncovered-list">
          <h2>Trechos sem resposta</h2>
          {map.uncovered.length === 0 ? (
            <p data-testid="uncovered-empty">Todo o material foi resolvido.</p>
          ) : (
            <ul>
              {map.uncovered.map((entry, index) => (
                <li data-testid={`uncovered-${index}`} key={`${entry.range.start}-${entry.range.end}`}>
                  {formatTicks(entry.range.start, sessionTicksPerSecond)} →{' '}
                  {formatTicks(entry.range.end, sessionTicksPerSecond)}:{' '}
                  {UNCOVERED_TEXT[entry.reason] ?? entry.reason}
                  {' '}
                  <button
                    data-testid={`answer-${index}`}
                    onClick={() => {
                      setAnchorIndex(String(index))
                      setAnchorReactionTick(entry.range.start)
                    }}
                    type="button"
                  >
                    Responder este trecho
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {map && (
        <section data-testid="anchor-editor">
          <h2>Âncoras</h2>
          <table data-testid="anchors">
            <thead>
              <tr>
                <th scope="col">Origem</th>
                <th scope="col">Na reação</th>
                <th scope="col">Na referência</th>
                <th scope="col">Modo</th>
                <th scope="col">Quem</th>
              </tr>
            </thead>
            <tbody>
              {map.anchors.map((anchor) => (
                <tr data-origin={anchor.origin} data-testid={`anchor-${anchor.anchorId}`} key={anchor.anchorId}>
                  <td>{anchor.origin === 'automatic' ? 'medida' : 'manual'}</td>
                  <td>{formatTicks(anchor.reactionTick, sessionTicksPerSecond)}</td>
                  <td data-testid={`anchor-reference-${anchor.anchorId}`}>
                    {anchor.referenceTick === null
                      ? 'não havia referência'
                      : formatTicks(anchor.referenceTick, referenceTicksPerSecond)}
                  </td>
                  <td>{MODE_TEXT[anchor.mode] ?? anchor.mode}</td>
                  <td data-testid={`anchor-evidence-${anchor.anchorId}`}>{anchor.evidenceRef}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p>
            Uma âncora responde um trecho que ninguém conseguiu medir. Ela é
            acrescentada e nunca movida nem removida, e não toca em âncora
            automática: sobrepor uma medição é outro ato, e este editor não o
            oferece.
          </p>

          <label>
            Trecho sem resposta
            <select
              data-testid="anchor-stretch"
              onChange={(event) => {
                setAnchorIndex(event.target.value)
                const stretch = map.uncovered[Number(event.target.value)]
                if (stretch) setAnchorReactionTick(stretch.range.start)
              }}
              value={anchorIndex}
            >
              {map.uncovered.map((entry, index) => (
                <option key={`${entry.range.start}-${entry.range.end}`} value={String(index)}>
                  {entry.range.start} → {entry.range.end}
                </option>
              ))}
            </select>
          </label>
          <label>
            Instante na reação (ticks)
            <input
              data-testid="anchor-reaction-tick"
              onChange={(event) => setAnchorReactionTick(event.target.value)}
              value={anchorReactionTick}
            />
          </label>
          <label>
            Instante na referência (ticks; vazio = não havia referência)
            <input
              data-testid="anchor-reference-tick"
              onChange={(event) => setAnchorReferenceTick(event.target.value)}
              value={anchorReferenceTick}
            />
          </label>
          <label>
            O que o player estava fazendo
            <select
              data-testid="anchor-mode"
              onChange={(event) => setAnchorMode(event.target.value)}
              value={anchorMode}
            >
              {ANCHOR_MODES.map((mode) => (
                <option key={mode} value={mode}>{MODE_TEXT[mode] ?? mode}</option>
              ))}
            </select>
          </label>
          <label>
            Observação
            <input
              data-testid="anchor-note"
              onChange={(event) => setAnchorNote(event.target.value)}
              value={anchorNote}
            />
          </label>
          <button
            data-testid="add-anchor"
            disabled={busy || map.uncovered.length === 0}
            onClick={() => void addAnchor()}
            type="button"
          >
            Registrar a âncora
          </button>
        </section>
      )}
    </main>
  )
}
