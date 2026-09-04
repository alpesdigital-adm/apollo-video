'use client'

import { useCallback, useEffect, useState } from 'react'

import AppShellNavigation from '@/components/AppShellNavigation'
import LogoutButton from '@/components/LogoutButton'

/**
 * The pre-recording surface (F4.009, FR-147), served at /capture-protocols.
 *
 * Not at /capture: that path belongs to the retired Apollo runtime and the
 * architecture lint refuses code there. The name here mirrors the API's own
 * /v1/capture-protocols, which is the better name anyway — the page is about
 * the protocols, not about capturing.
 *
 * This page exists because of when it is read: **before the camera rolls**,
 * when a requirement still costs nothing to satisfy. Afterwards the same text
 * is only an explanation of why the footage cannot be aligned.
 *
 * So it is built around consequence, not instruction. Every required item says
 * what stops working if it is skipped — not "use headphones" but "without
 * headphones the speaker's voice bleeds into the guest's track and audio
 * fingerprinting stops being usable". A checklist without that is a list of
 * chores an operator will reasonably decide to skip when running late.
 *
 * Recommended items are shown apart from required ones and never styled to
 * look equally urgent. A page that shouts at everything teaches an operator to
 * ignore the shouting.
 */

interface ApiEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

type SyncCeiling =
  | 'automatic'
  | 'automatic-with-review'
  | 'manual-anchors-required'
  | 'not-synchronizable'

interface ProtocolSummary {
  protocolId: string
  scenario: string
  version: number
  title: string
  summary: string
  bestCeiling: SyncCeiling
  requirementCount: number
  protocolHash: string
}

interface Requirement {
  requirementId: string
  level: 'required' | 'recommended'
  verification: 'observed' | 'attested'
  checkKind: string
  statement: string
  losesCapabilities: string[]
  consequence: string
}

interface ExpectedTrack {
  role: string
  minimum: number
  maximum: number | null
  mustCarryAudio: boolean
  note: string
}

interface Protocol extends ProtocolSummary {
  requirements: Requirement[]
  expectedTracks: ExpectedTrack[]
}

type ViewState = 'loading' | 'ready' | 'failed'

/**
 * What the best case actually means, in the operator's terms.
 *
 * Deliberately not "automatic / assisted / manual": those name the machine's
 * effort, and the person about to record cares about their own.
 */
const CEILING_TEXT: Record<SyncCeiling, string> = {
  automatic: 'Seguindo tudo, o alinhamento sai sozinho e o corte pode ser automático.',
  'automatic-with-review':
    'Seguindo tudo, o alinhamento sai sozinho, mas alguém precisa conferir antes de cortar.',
  'manual-anchors-required':
    'Mesmo seguindo tudo, este cenário exige âncoras manuais: alguém vai marcar o ponto a olho.',
  'not-synchronizable':
    'Este cenário não tem como ser sincronizado automaticamente. O material precisa ser reconciliado à mão.',
}

const CAPABILITY_TEXT: Record<string, string> = {
  'shared-clock': 'relógio compartilhado entre os gravadores',
  'audio-fingerprint': 'alinhamento pela impressão digital do áudio',
  'marker-correlation': 'alinhamento pelo marcador Apollo',
  'drift-measurement': 'medição de deriva entre os relógios',
  'continuous-piecewise-map': 'mapa contínuo por trechos',
  'reference-cross-check': 'conferência cruzada contra a trilha de referência',
}

function describeLoss(capabilities: string[]): string {
  if (capabilities.length === 0) return ''
  return capabilities.map((capability) => CAPABILITY_TEXT[capability] ?? capability).join(', ')
}

export default function CapturePage() {
  const [state, setState] = useState<ViewState>('loading')
  const [protocols, setProtocols] = useState<ProtocolSummary[]>([])
  const [selected, setSelected] = useState<Protocol | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set())

  const loadProtocols = useCallback(async () => {
    setState('loading')
    setMessage(null)
    try {
      const response = await fetch('/v1/capture-protocols', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const body = (await response.json()) as ApiEnvelope<{ protocols: ProtocolSummary[] }>
      if (!response.ok) {
        setMessage(body.error?.message ?? 'Não foi possível carregar os protocolos.')
        setState('failed')
        return
      }
      setProtocols(body.data?.protocols ?? [])
      setState('ready')
    } catch {
      setMessage('A rede falhou ao carregar os protocolos.')
      setState('failed')
    }
  }, [])

  const openProtocol = useCallback(async (protocolId: string) => {
    setMessage(null)
    // The acknowledgements belong to the protocol being read. Carrying them
    // across would let a tick made for the podcast checklist stand for a
    // different requirement in the multicam one.
    setAcknowledged(new Set())
    try {
      const response = await fetch(`/v1/capture-protocols/${encodeURIComponent(protocolId)}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const body = (await response.json()) as ApiEnvelope<{ protocol: Protocol }>
      if (!response.ok || !body.data) {
        setMessage(body.error?.message ?? 'Não foi possível abrir o protocolo.')
        setState('failed')
        return
      }
      setSelected(body.data.protocol)
    } catch {
      setMessage('A rede falhou ao abrir o protocolo.')
      setState('failed')
    }
  }, [])

  useEffect(() => {
    void loadProtocols()
  }, [loadProtocols])

  const required = selected?.requirements.filter((item) => item.level === 'required') ?? []
  const recommended = selected?.requirements.filter((item) => item.level === 'recommended') ?? []
  const pending = required.filter((item) => !acknowledged.has(item.requirementId))

  return (
    <main data-testid="capture-page" data-state={state}>
      <AppShellNavigation active="capture-sessions" />
      <LogoutButton />

      <h1>Antes de gravar</h1>
      <p>
        Escolha o formato da gravação. Cada exigência abaixo diz o que deixa de
        funcionar se não for cumprida — depois de gravar, não há como recuperar.
      </p>

      {message && <p data-testid="capture-message" role="alert">{message}</p>}

      {state === 'loading' && <p data-testid="capture-loading">Carregando protocolos…</p>}

      {state === 'ready' && (
        <section data-testid="protocol-list">
          <h2>Formatos</h2>
          <ul>
            {protocols.map((protocol) => (
              <li key={protocol.protocolId}>
                <button
                  data-testid={`protocol-${protocol.scenario}`}
                  onClick={() => void openProtocol(protocol.protocolId)}
                  type="button"
                >
                  {protocol.title}
                </button>
                <p>{protocol.summary}</p>
                <p data-testid={`ceiling-${protocol.scenario}`}>
                  {CEILING_TEXT[protocol.bestCeiling]}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {selected && (
        <section data-testid="protocol-detail" data-protocol={selected.protocolId}>
          <h2>{selected.title}</h2>
          <p data-testid="protocol-version">
            Versão {selected.version} · {selected.protocolHash.slice(0, 12)}
          </p>
          <p data-testid="protocol-ceiling">{CEILING_TEXT[selected.bestCeiling]}</p>

          <h3>Obrigatório</h3>
          <ul data-testid="required-list">
            {required.map((item) => (
              <li data-testid={`requirement-${item.requirementId}`} key={item.requirementId}>
                <label>
                  <input
                    checked={acknowledged.has(item.requirementId)}
                    data-testid={`ack-${item.requirementId}`}
                    onChange={(event) => {
                      setAcknowledged((current) => {
                        const next = new Set(current)
                        if (event.target.checked) next.add(item.requirementId)
                        else next.delete(item.requirementId)
                        return next
                      })
                    }}
                    type="checkbox"
                  />
                  {item.statement}
                </label>
                {/* The consequence, always. A checklist that only says what to
                    do is a list of chores; this one says what it costs. */}
                <p data-testid={`consequence-${item.requirementId}`}>{item.consequence}</p>
                {item.losesCapabilities.length > 0 && (
                  <p data-testid={`loses-${item.requirementId}`}>
                    Sem isso, perde-se: {describeLoss(item.losesCapabilities)}.
                  </p>
                )}
                {item.verification === 'attested' && (
                  <p data-testid={`attested-${item.requirementId}`}>
                    Nada no material comprova isto. Fica registrado como
                    declaração de quem gravou, não como medição.
                  </p>
                )}
              </li>
            ))}
          </ul>

          {recommended.length > 0 && (
            <>
              <h3>Recomendado</h3>
              <ul data-testid="recommended-list">
                {recommended.map((item) => (
                  <li data-testid={`requirement-${item.requirementId}`} key={item.requirementId}>
                    {item.statement}
                    <p data-testid={`consequence-${item.requirementId}`}>{item.consequence}</p>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3>Trilhas esperadas</h3>
          <table data-testid="expected-tracks">
            <thead>
              <tr>
                <th scope="col">Papel</th>
                <th scope="col">Quantidade</th>
                <th scope="col">Áudio</th>
                <th scope="col">Observação</th>
              </tr>
            </thead>
            <tbody>
              {selected.expectedTracks.map((track) => (
                <tr key={track.role}>
                  <td>{track.role}</td>
                  <td>
                    {track.minimum}
                    {track.maximum === null ? ' ou mais' : track.maximum === track.minimum ? '' : ` a ${track.maximum}`}
                  </td>
                  <td>{track.mustCarryAudio ? 'precisa ter áudio' : 'áudio opcional'}</td>
                  <td>{track.note}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* The count is stated rather than the upload being blocked. The
              page cannot verify any of this — only the recording can — and a
              gate that pretends otherwise teaches people to tick boxes. */}
          <p data-testid="acknowledgement-state">
            {pending.length === 0
              ? 'Todas as exigências foram lidas.'
              : `${pending.length} de ${required.length} exigências ainda não foram lidas.`}
          </p>
        </section>
      )}
    </main>
  )
}
