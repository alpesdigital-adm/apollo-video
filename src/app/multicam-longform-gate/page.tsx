'use client'

import { useCallback, useEffect, useState } from 'react'

import AppShellNavigation from '@/components/AppShellNavigation'
import LogoutButton from '@/components/LogoutButton'
import {
  MULTICAM_LONGFORM_ARTIFACT_PAGE_LIMIT,
  multicamLongformArtifactHref,
} from '@/v2/ui/multicam-longform-gate-addresses'

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

interface ArtifactListing {
  artifacts: GateArtifact[]
  /** Tampered and unhashed references in the whole evaluation, not on this page. */
  unverifiedCount: number
  unhashedCount: number
  filteredOut: number
  omittedArtifacts: number
}

interface ArtifactTotals {
  omitted: number
  filteredOut: number
  unverified: number
  unhashed: number
}

const NO_ARTIFACTS: ArtifactTotals = {
  omitted: 0, filteredOut: 0, unverified: 0, unhashed: 0,
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
 * The idempotency key for one evaluation of one project, in one minute.
 *
 * Not `gate-${projectId}-${minute}`, which is what this was: the server bounds
 * the key at `/^[!-~]{8,128}$/`, and a project id is allowed 128
 * characters of its own, so a long id produced a 150-character key and the
 * operator was told the gate could not be evaluated when the truth was that
 * the key was refused. A digest of the id is bounded, printable, and still the
 * same string for the same project inside the same minute, so a double click
 * still rejoins the evaluation it already asked for. Two different projects
 * that collide here are still two different rows: the server's uniqueness is
 * (workspace, project, key).
 */
function evaluationIdempotencyKey(projectId: string, minute: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < projectId.length; index += 1) {
    hash ^= projectId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `gate-${hash.toString(36)}-${minute}`
}

export default function MulticamLongformGatePage() {
  const [state, setState] = useState<ViewState>('idle')
  const [projectId, setProjectId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [catalogue, setCatalogue] = useState<CriterionCatalogueEntry[]>([])
  const [gate, setGate] = useState<GateRecord | null>(null)
  const [latestGateId, setLatestGateId] = useState<string | null>(null)
  const [outstanding, setOutstanding] = useState<OutstandingEntry[]>([])
  const [artifacts, setArtifacts] = useState<GateArtifact[]>([])
  const [artifactTotals, setArtifactTotals] = useState<ArtifactTotals>(NO_ARTIFACTS)
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
      `/v1/projects/${encodeURIComponent(project)}/multicam-longform-gate/evaluations/${encodeURIComponent(gateId)}/artifacts?limit=${MULTICAM_LONGFORM_ARTIFACT_PAGE_LIMIT}`,
      { headers: { accept: 'application/json' }, cache: 'no-store' },
    )
    const body = (await response.json()) as ApiEnvelope<ArtifactListing>
    // `omittedArtifacts` and `filteredOut` are read, not dropped. The API ships
    // them precisely so a narrowed or truncated list cannot read as the whole
    // evidence of the evaluation, and the two counters beside them are counted
    // over the evaluation rather than over this page.
    setArtifacts(response.ok && body.data ? body.data.artifacts : [])
    setArtifactTotals(
      response.ok && body.data
        ? {
            omitted: body.data.omittedArtifacts,
            filteredOut: body.data.filteredOut,
            unverified: body.data.unverifiedCount,
            unhashed: body.data.unhashedCount,
          }
        : NO_ARTIFACTS,
    )
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

  /**
   * Read everything about one project.
   *
   * `notice` is what the caller wants said once the screen is showing the
   * result of what it just did. It is a parameter rather than a `setMessage`
   * beside the call because this function clears the message on its way in:
   * "Avaliação registrada." used to be set by `evaluate` and then wiped by the
   * reload that followed it, so the one confirmation the page had never
   * reached the screen. A reload that fails still replaces it with its own
   * reason — the newest true thing wins.
   */
  const loadGate = useCallback(async (project: string, notice: string | null = null) => {
    if (project.trim().length === 0) {
      setState('idle')
      setMessage(notice)
      return
    }
    setState('loading')
    setMessage(notice)
    try {
      const response = await fetch(
        `/v1/projects/${encodeURIComponent(project.trim())}/multicam-longform-gate`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const body = (await response.json()) as ApiEnvelope<{ gate: GateRecord }>
      if (body.error?.code === 'MULTICAM_LONGFORM_GATE_NOT_FOUND') {
        // Not an error, and emphatically not "reprovado": nobody has run it.
        // The ten criteria are still shown, all of them unanswered.
        setGate(null)
        setLatestGateId(null)
        setOutstanding([])
        setArtifacts([])
        setArtifactTotals(NO_ARTIFACTS)
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
      setLatestGateId(body.data.gate.id)
      await loadOutstanding(project.trim())
      await loadArtifacts(project.trim(), body.data.gate.id)
      await loadHistory(project.trim())
      setState('ready')
    } catch {
      setMessage('A rede falhou ao ler o gate.')
      setState('failed')
    }
  }, [loadOutstanding, loadArtifacts, loadHistory])

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
            'idempotency-key': evaluationIdempotencyKey(
              projectId.trim(),
              new Date().toISOString().slice(0, 16),
            ),
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
      await loadGate(
        projectId,
        body.data.replayed
          ? 'Esta avaliação já existia: a mesma chave devolveu o mesmo registro.'
          : 'Avaliação registrada.',
      )
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
    } catch {
      // The same answer the other two handlers give. Without it the promise
      // `void openEvaluation(...)` created rejected unhandled, the screen kept
      // the previous evaluation on it and nothing said why the click did
      // nothing.
      setMessage('A rede falhou ao abrir esta avaliação.')
    } finally {
      setBusy(false)
    }
  }, [projectId, loadArtifacts])

  // The catalogue is project-independent and is read on mount, whatever the
  // URL carries. It used to be fetched inside `loadGate`, after the early
  // return for an empty project: arriving here with no `projeto` — which the
  // link on the captures screen does whenever nothing is typed yet — rendered
  // the heading "As dez condições" above an empty list. A screen headed "ten
  // conditions" showing zero is the aggregated nothing this page exists to
  // refuse.
  useEffect(() => {
    void (async () => {
      try {
        await loadCatalogue()
      } catch (error) {
        setMessage(
          error instanceof Error
            ? error.message
            : 'Não foi possível ler os critérios do gate.',
        )
      }
    })()
  }, [loadCatalogue])

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
  // "O que falta" is always about the newest evaluation, so it is shown only
  // while the newest one is the one on screen. Rendering it beside a historical
  // record would answer about a different set of rows than the criteria above
  // it — the sort of quiet mismatch that makes an operator distrust the page.
  const viewingLatest = gate !== null && gate.id === latestGateId
  const outstandingByCriterion = new Map(
    viewingLatest ? outstanding.map((entry) => [entry.criterion, entry]) : [],
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

      {state === 'idle' && (
        <p data-testid="state-idle" role="status">
          Nenhum projeto informado. Abaixo estão as dez condições que este gate
          exige, ainda sem nenhuma resposta: informe um projeto para ver o que
          já foi lido sobre cada uma.
        </p>
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
                      const href = multicamLongformArtifactHref(
                        gate?.projectId ?? projectId.trim(),
                        artifact,
                      )
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
        {gate && (artifactTotals.omitted > 0 || artifactTotals.filteredOut > 0) && (
          <p data-testid="artifacts-omitted" role="status">
            {artifactTotals.omitted} evidência(s) desta avaliação não aparecem
            acima porque a listagem devolve no máximo{' '}
            {MULTICAM_LONGFORM_ARTIFACT_PAGE_LIMIT} referências por página, e{' '}
            {artifactTotals.filteredOut} ficaram de fora por filtro de tipo. No
            registro inteiro há {artifactTotals.unverified} com hash que não
            confere e {artifactTotals.unhashed} sem hash próprio — os dois
            números são da avaliação, não desta página, para que um corte de
            página não possa dizer que nada foi adulterado.
          </p>
        )}
      </section>

      {gate && !viewingLatest && (
        <p data-testid="viewing-historical" role="status">
          Esta é uma avaliação anterior. O que falta hoje é calculado sobre a
          avaliação mais recente e não é mostrado aqui.
        </p>
      )}

      {viewingLatest && outstanding.length > 0 && (
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
