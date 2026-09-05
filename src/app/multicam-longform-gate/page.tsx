'use client'

import { useCallback, useEffect, useState } from 'react'

import AppShellNavigation from '@/components/AppShellNavigation'
import LogoutButton from '@/components/LogoutButton'

/**
 * The operable surface of the multicamera and long-form phase gate (F4.016).
 *
 * ADR-135 names six conditions and one sentence that outranks them: every
 * condition is independently visible before the phase is approved. This screen
 * is that sentence. There is no percentage anywhere on it and no single badge
 * that could be read as "almost there": the ten criteria are listed one by one,
 * always all ten, each with the checks it is made of, what each check read, and
 * the exact reason any of them said no.
 *
 * Three distinctions the page refuses to smooth over, because acting on them is
 * different work:
 *
 * 1. **Never evaluated is not failed.** A criterion nobody has ever answered
 *    says so in its own words and is listed first in what is missing. "Nobody
 *    ran it" is work to start; "it ran and refused" is work to fix.
 * 2. **A digest that disagreed is not a digest that was never taken.** A row
 *    whose hash did not recompute is tampering and is called that. A media
 *    artifact whose table stores no digest is "sem hash próprio" — nothing
 *    could be recomputed, which is not a suspicion.
 * 3. **An artifact is a place to go, not a string to read.** Every reference
 *    whose kind has a published address is a link; the ones that do not are
 *    shown as what they are rather than as dead links.
 *
 * Everything on it comes from `/v1`. The page calls the same seven capabilities
 * an external client would, including the evaluation, so nothing here can be
 * true on screen and false over the API.
 */

type ViewState = 'idle' | 'loading' | 'never-run' | 'ready' | 'failed'

interface ApiEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

interface EvidenceReference {
  type: string
  id: string
  hash: string | null
  verified: boolean
}

interface GateCheck {
  code: string
  passed: boolean
  failureReason: string | null
  detail: string
  references: EvidenceReference[]
}

interface GateCriterion {
  criterion: string
  passed: boolean
  checkCount: number
  failedCheckCount: number
  missingCheckCount: number
  unverifiedReferenceCount: number
  unhashedReferenceCount: number
  checks: GateCheck[]
}

interface GateRecord {
  id: string
  projectId: string
  sessionId: string | null
  projectVersionId: string | null
  createdAt: string
  recordHash: string
  report: {
    approved: boolean
    satisfied: number
    evaluated: number
    total: number
    failed: string[]
    evaluatedAt: string
    criteria: GateCriterion[]
  }
}

interface CriterionCatalogueEntry {
  criterion: string
  statement: string
  checks: string[]
}

interface OutstandingEntry {
  criterion: string
  statement: string
  neverEvaluated: boolean
  missingCheckCount: number
  failedCheckCount: number
  unverifiedReferenceCount: number
  unhashedReferenceCount: number
  blocking: { check: string; reason: string | null; detail: string }[]
}

interface GateArtifact {
  type: string
  id: string
  hash: string | null
  verified: boolean
  citedBy: { criterion: string; check: string; passed: boolean }[]
}

const REASON_LABEL: Record<string, string> = {
  'evidence-missing': 'nenhuma linha responde a esta checagem',
  'evidence-unverified': 'o hash da linha lida não confere — foi editada por baixo',
  'evidence-not-measured': 'o campo de que esta checagem precisa nunca foi medido',
  'requirement-unmet': 'a evidência confere e diz que a exigência não foi cumprida',
  'evidence-stale': 'a evidência confere, mas descreve outra versão do assunto',
}

/**
 * Where a reference of each kind can actually be opened.
 *
 * Only the four kinds whose reference id IS the resource id of a published
 * endpoint. Everything else is shown as an id and a kind: inventing an address
 * for a row that has none would hand an operator a link that 404s and teach
 * them the gate is unreliable.
 */
function artifactHref(projectId: string, artifact: GateArtifact): string | null {
  const id = encodeURIComponent(artifact.id)
  const project = encodeURIComponent(projectId)
  if (artifact.type === 'media-artifact') return `/v1/artifacts/${id}`
  if (artifact.type === 'final-export') return `/v1/operations/${id}`
  if (artifact.type === 'capture-session') return `/v1/projects/${project}/capture-sessions/${id}`
  if (artifact.type === 'colour-critic-report') {
    return `/v1/projects/${project}/color-critic-reports/${id}`
  }
  return null
}

export default function MulticamLongformGatePage() {
  const [state, setState] = useState<ViewState>('idle')
  const [projectId, setProjectId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [catalogue, setCatalogue] = useState<CriterionCatalogueEntry[]>([])
  const [gate, setGate] = useState<GateRecord | null>(null)
  const [outstanding, setOutstanding] = useState<OutstandingEntry[]>([])
  const [artifacts, setArtifacts] = useState<GateArtifact[]>([])
  const [history, setHistory] = useState<GateRecord[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadCatalogue = useCallback(async () => {
    // The criteria are readable before any project has been evaluated: an
    // operator asking what this phase demands should not have to run anything
    // to find out.
    const response = await fetch('/v1/multicam-longform-gate/criteria', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    const body = (await response.json()) as ApiEnvelope<{ criteria: CriterionCatalogueEntry[] }>
    if (!response.ok || !body.data) {
      throw new Error(body.error?.message ?? 'Não foi possível ler os critérios do gate.')
    }
    setCatalogue(body.data.criteria)
  }, [])

  const loadArtifacts = useCallback(async (project: string, gateId: string) => {
    const response = await fetch(
      `/v1/projects/${encodeURIComponent(project)}/multicam-longform-gate/evaluations/${encodeURIComponent(gateId)}/artifacts`,
      { headers: { accept: 'application/json' }, cache: 'no-store' },
    )
    const body = (await response.json()) as ApiEnvelope<{ artifacts: GateArtifact[] }>
    setArtifacts(response.ok && body.data ? body.data.artifacts : [])
  }, [])

  const loadHistory = useCallback(async (project: string) => {
    const response = await fetch(
      `/v1/projects/${encodeURIComponent(project)}/multicam-longform-gate/evaluations?limit=20`,
      { headers: { accept: 'application/json' }, cache: 'no-store' },
    )
    const body = (await response.json()) as ApiEnvelope<{ gates: GateRecord[] }>
    setHistory(response.ok && body.data ? body.data.gates : [])
  }, [])

  const loadOutstanding = useCallback(async (project: string) => {
    const response = await fetch(
      `/v1/projects/${encodeURIComponent(project)}/multicam-longform-gate/outstanding`,
      { headers: { accept: 'application/json' }, cache: 'no-store' },
    )
    const body = (await response.json()) as ApiEnvelope<{ outstanding: OutstandingEntry[] }>
    setOutstanding(response.ok && body.data ? body.data.outstanding : [])
  }, [])

  const loadGate = useCallback(async (project: string) => {
    if (project.trim().length === 0) {
      setState('idle')
      return
    }
    setState('loading')
    setMessage(null)
    try {
      await loadCatalogue()
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(project.trim())}/multicam-longform-gate`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const body = (await response.json()) as ApiEnvelope<{ gate: GateRecord }>
      if (body.error?.code === 'MULTICAM_LONGFORM_GATE_NOT_FOUND') {
        // Not an error, and emphatically not "reprovado": nobody has run it.
        // The ten criteria are still shown, all of them unanswered.
        setGate(null)
        setOutstanding([])
        setArtifacts([])
        setHistory([])
        setState('never-run')
        return
      }
      if (!response.ok || !body.data) {
        setMessage(body.error?.message ?? 'Não foi possível ler o gate.')
        setState('failed')
        return
      }
      setGate(body.data.gate)
      await loadOutstanding(project.trim())
      await loadArtifacts(project.trim(), body.data.gate.id)
      await loadHistory(project.trim())
      setState('ready')
    } catch {
      setMessage('A rede falhou ao ler o gate.')
      setState('failed')
    }
  }, [loadCatalogue, loadOutstanding, loadArtifacts, loadHistory])

  const evaluate = useCallback(async () => {
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId.trim())}/multicam-longform-gate/evaluations`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            // Bound to the project and to this minute: a double click rejoins
            // the evaluation it already asked for instead of writing a second
            // record of the same evidence.
            'idempotency-key': `gate-${projectId.trim()}-${new Date().toISOString().slice(0, 16)}`,
          },
          // The whole body. No measurement, no criterion, no approval — the
          // server reads every one of those itself.
          body: JSON.stringify(
            sessionId.trim().length > 0 ? { sessionId: sessionId.trim() } : {},
          ),
        },
      )
      const body = (await response.json()) as ApiEnvelope<{ gate: GateRecord; replayed: boolean }>
      if (!response.ok || !body.data) {
        setMessage(body.error?.message ?? 'Não foi possível avaliar o gate.')
        setState('failed')
        return
      }
      setMessage(
        body.data.replayed
          ? 'Esta avaliação já existia: a mesma chave devolveu o mesmo registro.'
          : 'Avaliação registrada.',
      )
      await loadGate(projectId)
    } catch {
      setMessage('A rede falhou ao avaliar o gate.')
      setState('failed')
    } finally {
      setBusy(false)
    }
  }, [projectId, sessionId, loadGate])

  const openEvaluation = useCallback(async (gateId: string) => {
    setBusy(true)
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(projectId.trim())}/multicam-longform-gate/evaluations/${encodeURIComponent(gateId)}`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const body = (await response.json()) as ApiEnvelope<{ gate: GateRecord }>
      if (!response.ok || !body.data) {
        setMessage(body.error?.message ?? 'Não foi possível ler esta avaliação.')
        return
      }
      setGate(body.data.gate)
      await loadArtifacts(projectId.trim(), body.data.gate.id)
      setMessage(`Mostrando a avaliação de ${body.data.gate.report.evaluatedAt}.`)
    } finally {
      setBusy(false)
    }
  }, [projectId, loadArtifacts])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const initialProject = params.get('projeto') ?? ''
    const initialSession = params.get('sessao') ?? ''
    setProjectId(initialProject)
    setSessionId(initialSession)
    void loadGate(initialProject)
  }, [loadGate])

  const resultByCriterion = new Map(
    (gate?.report.criteria ?? []).map((criterion) => [criterion.criterion, criterion]),
  )
  const outstandingByCriterion = new Map(
    outstanding.map((entry) => [entry.criterion, entry]),
  )

  return (
    <main data-testid="multicam-longform-gate-page">
      <header>
        <AppShellNavigation active="capture-sessions" />
        <LogoutButton />
      </header>

      <h1>Gate de fase — multicâmera e formato longo</h1>
      <p>
        Dez condições, cada uma visível sozinha. Nada aqui é uma porcentagem: um
        gate resumido a um número foi como 1.247 de 1.255 caixas marcadas
        conviveram com nenhum produto integrado.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void loadGate(projectId)
        }}
      >
        <label htmlFor="projeto">Projeto</label>
        <input
          id="projeto"
          name="projeto"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          placeholder="project-..."
        />
        <label htmlFor="sessao">Sessão (opcional)</label>
        <input
          id="sessao"
          name="sessao"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          placeholder="capture-session-..."
        />
        <button type="submit" disabled={busy}>Carregar</button>
        <button
          type="button"
          data-testid="evaluate-gate"
          onClick={() => void evaluate()}
          disabled={busy || projectId.trim().length === 0}
        >
          Avaliar agora
        </button>
      </form>

      {state === 'loading' && <p data-testid="state-loading">Carregando…</p>}

      {state === 'failed' && (
        <section data-testid="state-failed" role="alert">
          <p>{message ?? 'Alguma coisa falhou.'}</p>
          <button type="button" onClick={() => void loadGate(projectId)} disabled={busy}>
            Tentar de novo
          </button>
        </section>
      )}

      {state === 'never-run' && (
        <p data-testid="state-never-run" role="status">
          Este projeto nunca foi avaliado. Isso não é reprovação: nenhuma das dez
          condições foi respondida ainda. Abaixo está o que o gate exige.
        </p>
      )}

      {gate && (
        <section data-testid="gate-summary" data-approved={String(gate.report.approved)}>
          <h2>
            Avaliação {gate.id} — {gate.report.approved ? 'aprovado' : 'não aprovado'}
          </h2>
          <p data-testid="gate-counts">
            {gate.report.satisfied} de {gate.report.total} condições satisfeitas;{' '}
            {gate.report.evaluated} de {gate.report.total} chegaram a ser avaliadas.
          </p>
          <p>
            Avaliado em {gate.report.evaluatedAt}. Versão de projeto lida:{' '}
            {gate.projectVersionId ?? 'nenhuma'}. Sessão julgada:{' '}
            <span data-testid="gate-session">{gate.sessionId ?? 'nenhuma'}</span>.
          </p>
          <p data-testid="gate-record-hash">Hash do registro: {gate.recordHash}</p>
        </section>
      )}

      {message && state !== 'failed' && <p data-testid="message">{message}</p>}

      <section>
        <h2>As dez condições</h2>
        <ol data-testid="criteria-list">
          {catalogue.map((entry) => {
            const result = resultByCriterion.get(entry.criterion)
            const pending = outstandingByCriterion.get(entry.criterion)
            const status = result === undefined
              ? 'não avaliado'
              : result.passed
                ? 'aprovado'
                : result.missingCheckCount === result.checkCount
                  ? 'não avaliado'
                  : 'reprovado'
            const cited = artifacts.filter((artifact) =>
              artifact.citedBy.some((citation) => citation.criterion === entry.criterion))
            return (
              <li key={entry.criterion} data-testid={`criterion-${entry.criterion}`}>
                <h3>{entry.criterion}</h3>
                <p data-testid={`criterion-statement-${entry.criterion}`}>{entry.statement}</p>
                <p data-testid={`criterion-status-${entry.criterion}`}>{status}</p>

                <h4>O que cada checagem leu</h4>
                <ul data-testid={`criterion-checks-${entry.criterion}`}>
                  {entry.checks.map((code) => {
                    const check = result?.checks.find((candidate) => candidate.code === code)
                    return (
                      <li key={code} data-testid={`check-${entry.criterion}-${code}`}>
                        <strong>{code}</strong>{' '}
                        {check === undefined ? (
                          <span data-testid={`check-unread-${entry.criterion}-${code}`}>
                            nada foi lido: esta condição ainda não foi avaliada
                          </span>
                        ) : (
                          <>
                            <span>{check.passed ? 'passou' : 'não passou'}</span>{' '}
                            <span data-testid={`check-detail-${entry.criterion}-${code}`}>
                              {check.detail}
                            </span>
                            {!check.passed && check.failureReason && (
                              <span data-testid={`check-reason-${entry.criterion}-${code}`}>
                                {' '}— {REASON_LABEL[check.failureReason] ?? check.failureReason}
                              </span>
                            )}
                          </>
                        )}
                      </li>
                    )
                  })}
                </ul>

                {pending && (
                  <p data-testid={`criterion-missing-${entry.criterion}`}>
                    Falta: {pending.neverEvaluated
                      ? 'esta condição nunca foi avaliada — não há o que corrigir ainda, há o que fazer'
                      : `${pending.failedCheckCount} de ${entry.checks.length} checagens não passaram`}
                    {pending.unverifiedReferenceCount > 0 && (
                      <span data-testid={`criterion-tampered-${entry.criterion}`}>
                        {' '}· {pending.unverifiedReferenceCount} evidência(s) com hash que não
                        confere: alguém editou a linha por baixo
                      </span>
                    )}
                    {pending.unhashedReferenceCount > 0 && (
                      <span data-testid={`criterion-unhashed-${entry.criterion}`}>
                        {' '}· {pending.unhashedReferenceCount} evidência(s) sem hash próprio: não
                        havia o que recalcular, o que não é o mesmo que hash errado
                      </span>
                    )}
                  </p>
                )}

                {cited.length > 0 && (
                  <ul data-testid={`criterion-artifacts-${entry.criterion}`}>
                    {cited.map((artifact) => {
                      const href = artifactHref(gate?.projectId ?? projectId.trim(), artifact)
                      return (
                        <li
                          key={`${artifact.type}:${artifact.id}`}
                          data-testid={`artifact-${entry.criterion}-${artifact.type}`}
                        >
                          {href === null ? (
                            <span>{artifact.type}: {artifact.id}</span>
                          ) : (
                            <a href={href}>{artifact.type}: {artifact.id}</a>
                          )}{' '}
                          <span data-testid={`artifact-hash-${entry.criterion}-${artifact.type}`}>
                            {artifact.hash === null
                              ? 'sem hash próprio'
                              : artifact.verified
                                ? 'hash confere'
                                : 'hash NÃO confere'}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ol>
      </section>

      {outstanding.length > 0 && (
        <section>
          <h2>O que falta, na ordem de fazer</h2>
          <ol data-testid="outstanding-list">
            {outstanding.map((entry) => (
              <li key={entry.criterion} data-testid={`outstanding-${entry.criterion}`}>
                <strong>{entry.criterion}</strong>{' '}
                <span data-testid={`outstanding-kind-${entry.criterion}`}>
                  {entry.neverEvaluated ? 'nunca avaliada' : 'avaliada e recusada'}
                </span>
                <ul>
                  {entry.blocking.map((blocker) => (
                    <li key={blocker.check}>
                      {blocker.check}: {REASON_LABEL[blocker.reason ?? ''] ?? blocker.reason} —{' '}
                      {blocker.detail}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </section>
      )}

      {history.length > 0 && (
        <section>
          <h2>Histórico</h2>
          <table data-testid="history-list">
            <thead>
              <tr>
                <th scope="col">Avaliação</th>
                <th scope="col">Quando</th>
                <th scope="col">Satisfeitas</th>
                <th scope="col">Resultado</th>
                <th scope="col">Ações</th>
              </tr>
            </thead>
            <tbody>
              {history.map((entry) => (
                <tr key={entry.id} data-testid={`history-${entry.id}`}>
                  <td>{entry.id}</td>
                  <td>{entry.report.evaluatedAt}</td>
                  <td>{entry.report.satisfied} de {entry.report.total}</td>
                  <td>{entry.report.approved ? 'aprovado' : 'não aprovado'}</td>
                  <td>
                    <button
                      type="button"
                      data-testid={`open-evaluation-${entry.id}`}
                      onClick={() => void openEvaluation(entry.id)}
                      disabled={busy}
                    >
                      Abrir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* The gate is not a shell destination — there are seven, fixed. It is
          reached from the captures screen, which is where an operator already
          is when the question "can this phase be closed?" comes up. */}
      <p data-testid="open-capture-sessions">
        <a href={`/capture-sessions?projectId=${encodeURIComponent(projectId.trim())}`}>
          Voltar às sessões de captura
        </a>
      </p>
    </main>
  )
}
