'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  classifyConflict,
  conflictingVersionFrom,
  REPEATED_REQUEST_MESSAGE,
  UNKNOWN_CONFLICT_MESSAGE,
} from '@/app/_operator/refusal'
import { formatTicks, showNumber, tickRateFrom } from '@/app/_operator/tick-format'
import AppShellNavigation from '@/components/AppShellNavigation'
import LogoutButton from '@/components/LogoutButton'

/**
 * The multicam colour surface (F4.013 and F4.014).
 *
 * One colour input reaches the server from this page and it is not a
 * measurement: **which camera is the reference**. Every delta, every
 * confidence, every issue and every verdict below is measured from decoded
 * frames on the server and only read here. The single exception is the local
 * override — an operator's own correction of one range of one camera — and it
 * is bounded by the domain, labelled as human, and shown apart from the fitted
 * transforms so it can never be mistaken for something that was measured.
 *
 * The page also refuses to derive the camera key. A camera key is a fold of a
 * track id with a collision rule the domain owns; a page that recomputed it
 * would be a second implementation of an identity, and identities that are
 * computed twice eventually disagree. So the reference camera is typed or
 * chosen from the plan, and when the server refuses it, it answers with the
 * keys the session actually carries — those are what the page then offers.
 *
 * Nulls stay null. A white balance shown as 1/1/1 where none was measured
 * reads as "measured, and this camera already matches", which is the most
 * expensive possible lie in a grading surface.
 */

interface ApiEnvelope<T> {
  data?: T
  error?: { code?: string; message?: string; details?: Record<string, unknown> }
}

interface TickInterval { start: string; end: string }

interface ColorTransform {
  id: string
  kind: string
  version: number
  enabled: boolean
  implementation: {
    provider: string
    version: string
    parameters: Record<string, unknown>
    parametersHash: string
  }
}

interface CameraTransform {
  cameraId: string
  transform: ColorTransform
  derivedFrom: string[]
  deltas: {
    exposureEv: number | null
    whiteBalance: { redGain: number; greenGain: number; blueGain: number } | null
    contrast: number | null
    saturation: number | null
  }
  confidence: number
  rangePairs: number
}

interface RangeOverride {
  overrideId: string
  cameraId: string
  segmentId: string | null
  range: TickInterval | null
  transform: ColorTransform
  reason: string
  actor: { kind: string; id: string }
}

interface MatchPlan {
  planId: string
  sessionId: string
  sessionVersion: number
  referenceEpoch: number
  referenceCameraId: string
  referenceCameraSelection: {
    selectedBy: { kind: string; id: string }
    selectedAt: string
    baseVersionId: string
    baseHash: string
  }
  cameraTransforms: CameraTransform[]
  rangeOverrides: RangeOverride[]
  confidence: number
  issues: { code: string; cameraId: string | null; message: string; humanReviewRequired: boolean }[]
  nonComparableRanges: { cameraId: string; measurementId: string; range: TickInterval; reason: string }[]
  humanReviewRequired: boolean
  pipelineStage: string
  createdAt: string
  planHash: string
}

interface MatchPlanRead {
  plan: MatchPlan
  version: number
  previousVersionHash: string | null
  versionRef: string
  isHead: boolean
}

interface CriticReportSummary {
  reportId: string
  projectVersionId: string
  action: string
  cause: string
  confidence: number
  confidenceBand: string
  referenceCameraId: string | null
  matchPlanId: string | null
  hardIssues: number
  warningIssues: number
  evaluatedAt: string
  reportHash: string
}

interface CriticReportListing {
  reports: CriticReportSummary[]
  correctionsApplied: number
  correctionBudgetExhausted: boolean
}

interface CriticBytes { artifactId: string; sha256: string }

interface CriticIssue {
  code: string
  dimension: string
  severity: string
  classification: string
  cause: string
  stage: string
  cameraId: string | null
  range: TickInterval | null
  measured: number | null
  threshold: number | null
  thresholdVersion: string
  confidence: number | null
  evidenceRefs: string[]
}

interface CriticReport {
  reportId: string
  projectVersionId: string
  subject: { kind: string; cameraId: string | null; artifactId: string | null }
  referenceCameraId: string | null
  matchPlanId: string | null
  sections: { stage: string; bytesEvaluated: CriticBytes[]; measurementIds: string[] }[]
  stagePairs: { cameraId: string; beforeMeasurementId: string; afterMeasurementId: string }[]
  bytesEvaluated: CriticBytes[]
  dimensions: {
    dimension: string
    status: string
    stage: string
    value: number | null
    unit: string | null
    threshold: number | null
    reason: string | null
  }[]
  issues: CriticIssue[]
  cause: string
  action: string
  confidence: number
  confidenceBand: string
  evaluatedAt: string
  reportHash: string
}

interface CriticIssueListing {
  reportId: string
  action: string
  cause: string
  referenceCameraId: string | null
  issues: CriticIssue[]
  filteredOut: number
}

interface SessionRead {
  sessionId: string
  version: number
  sessionHash: string
  clock: { timebase: string; rounding: string }
  tracks: { trackId: string; role: string }[]
}

interface ProjectVersion { id: string; sequence: number; baseHash: string }

const SEVERITY_TEXT: Record<string, string> = { hard: 'bloqueia', warning: 'avisa' }

/**
 * A tick as the boundary spells one: decimal digits, up to nineteen of them.
 *
 * Checked here so a mistyped instant is refused on screen, with the two words
 * that say what is wrong, instead of coming back as a schema violation the
 * operator has to decode.
 */
const TICK = /^[0-9]{1,19}$/

const ACTION_TEXT: Record<string, string> = {
  approve: 'aprovar',
  'bounded-correction': 'correção limitada',
  'human-review': 'revisão humana',
  reject: 'reprovar',
}

export default function ColorMatchPage() {
  const [projectId, setProjectId] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [read, setRead] = useState<MatchPlanRead | null>(null)
  const [session, setSession] = useState<SessionRead | null>(null)
  const [projectVersion, setProjectVersion] = useState<ProjectVersion | null>(null)
  const [reports, setReports] = useState<CriticReportListing | null>(null)
  const [report, setReport] = useState<CriticReport | null>(null)
  const [issues, setIssues] = useState<CriticIssueListing | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [referenceCameraId, setReferenceCameraId] = useState('')
  // Camera keys the server named when it refused a reference. Read from the
  // refusal, never folded out of a track id here: the fold and its collision
  // rule belong to the domain, and a second implementation of an identity is
  // an identity that will eventually disagree with itself.
  const [offeredCameras, setOfferedCameras] = useState<string[]>([])
  const [overrideCameraId, setOverrideCameraId] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  // The scope of the correction. Both empty means the whole camera, and the
  // page says so rather than implying a range it never sent.
  const [overrideStartTick, setOverrideStartTick] = useState('')
  const [overrideEndTick, setOverrideEndTick] = useState('')
  const [overrideSegmentId, setOverrideSegmentId] = useState('')
  const [brightness, setBrightness] = useState('0')
  const [contrast, setContrast] = useState('1')
  const [saturation, setSaturation] = useState('1')

  const project = useMemo(() => encodeURIComponent(projectId.trim()), [projectId])
  const encodedSession = useMemo(() => encodeURIComponent(sessionId.trim()), [sessionId])
  const tickRate = useMemo(() => tickRateFrom(session?.clock.timebase), [session])

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
      const version = workspaceBody.data?.version ?? null
      setProjectVersion(version)

      const response = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/color-match`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const body = (await response.json()) as ApiEnvelope<MatchPlanRead>
      if (response.ok && body.data) {
        setRead(body.data)
        setReferenceCameraId((current) => (current.length > 0 ? current : body.data!.plan.referenceCameraId))
      } else {
        setRead(null)
        setMessage(body.error?.message ?? 'Esta sessão ainda não tem plano de casamento de cor.')
      }

      // A verdict is about one exact version of a cut, so the version has to be
      // named. It comes from the workspace read; without it the list is not
      // narrowed, it is meaningless.
      if (version) {
        const encodedVersion = encodeURIComponent(version.id)
        const reportsResponse = await fetch(
          `/v1/projects/${project}/color-critic-reports?projectVersionId=${encodedVersion}`,
          { headers: { accept: 'application/json' }, cache: 'no-store' },
        )
        const reportsBody = (await reportsResponse.json()) as ApiEnvelope<CriticReportListing>
        setReports(reportsResponse.ok && reportsBody.data ? reportsBody.data : null)
      } else {
        setReports(null)
      }
    } catch {
      setMessage('A rede falhou ao ler o casamento de cor.')
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

  const openReport = useCallback(async (reportId: string) => {
    setBusy(true)
    setMessage(null)
    try {
      const encodedReport = encodeURIComponent(reportId)
      const response = await fetch(
        `/v1/projects/${project}/color-critic-reports/${encodedReport}`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const body = (await response.json()) as ApiEnvelope<{ report: CriticReport }>
      if (!response.ok || !body.data) {
        setMessage(body.error?.message ?? 'Não foi possível ler o veredito.')
        return
      }
      setReport(body.data.report)

      const issuesResponse = await fetch(
        `/v1/projects/${project}/color-critic-reports/${encodedReport}/issues`,
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      )
      const issuesBody = (await issuesResponse.json()) as ApiEnvelope<CriticIssueListing>
      setIssues(issuesResponse.ok && issuesBody.data ? issuesBody.data : null)
    } catch {
      setMessage('A rede falhou ao abrir o veredito.')
    } finally {
      setBusy(false)
    }
  }, [project])

  /** A 409 read by its code: only two of them mean a fence moved. */
  const handleRefusal = useCallback((status: number, body: ApiEnvelope<unknown>) => {
    const kind = classifyConflict(status, body.error?.code)
    if (kind === 'stale-fence') {
      setConflict(conflictingVersionFrom(body.error?.details))
      setMessage(
        'Alguma coisa avançou enquanto esta tela olhava para outra versão. Recarregue antes de repetir: '
        + 'o pedido foi calculado sobre uma versão que já não é a corrente.',
      )
      return true
    }
    if (kind !== null) {
      setConflict(null)
      setMessage(kind === 'repeated-request' ? REPEATED_REQUEST_MESSAGE : UNKNOWN_CONFLICT_MESSAGE)
      return true
    }
    // The server knows which camera keys the session carries. When it refuses
    // the one that was typed it says so, and those are the keys offered below.
    const cameras = body.error?.details?.cameras
    if (Array.isArray(cameras)) {
      setOfferedCameras(cameras.filter((camera): camera is string => typeof camera === 'string'))
    }
    return false
  }, [])

  const derive = useCallback(async () => {
    if (!session || !projectVersion) {
      setMessage('Sem sessão ou versão de projeto lidas: não há em que ancorar a derivação.')
      return
    }
    if (referenceCameraId.trim().length === 0) {
      setMessage('Escolha a câmera de referência. É a única entrada de cor que esta tela envia.')
      return
    }
    setBusy(true)
    setMessage(null)
    setConflict(null)
    try {
      const response = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/color-match`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            referenceCameraId: referenceCameraId.trim(),
            // Two fences, both read: the session the reference was chosen
            // against, and the project version the ColorPlan layers land on.
            // Neither stands in for the other — a session that moved means the
            // cameras changed, a project that moved means the cut did.
            baseVersionId: `${session.sessionId}:v${session.version}`,
            baseHash: session.sessionHash,
            projectBaseVersionId: projectVersion.id,
            projectBaseHash: projectVersion.baseHash,
          }),
        },
      )
      const body = (await response.json()) as ApiEnvelope<{ replayed: boolean }>
      if (handleRefusal(response.status, body)) return
      if (!response.ok) {
        setMessage(body.error?.message ?? 'A derivação foi recusada.')
        return
      }
      setMessage(body.data?.replayed
        ? 'Os mesmos bytes deram o mesmo plano: nada foi medido de novo.'
        : 'Casamento de cor derivado.')
      await load()
    } catch {
      setMessage('A rede falhou ao derivar o casamento de cor.')
    } finally {
      setBusy(false)
    }
  }, [encodedSession, handleRefusal, load, project, projectVersion, referenceCameraId, session])

  const applyOverride = useCallback(async () => {
    if (!read || !projectVersion) {
      setMessage('Sem plano e versão de projeto lidos, não há o que emendar.')
      return
    }
    if (overrideCameraId.trim().length === 0 || overrideReason.trim().length === 0) {
      setMessage('Diga qual câmera e por quê: uma correção manual entra assinada.')
      return
    }
    // Both ends or neither. Half a range is not a narrower correction, it is an
    // ambiguous one, and the schema would refuse it after the operator had
    // already been told the correction was on its way.
    const start = overrideStartTick.trim()
    const end = overrideEndTick.trim()
    if ((start.length === 0) !== (end.length === 0)) {
      setMessage('Um trecho tem começo e fim. Preencha os dois instantes, ou deixe os dois vazios.')
      return
    }
    if (start.length > 0 && (!TICK.test(start) || !TICK.test(end))) {
      setMessage('Os instantes são ticks: só dígitos, no relógio da sessão.')
      return
    }
    if (start.length > 0 && BigInt(end) <= BigInt(start)) {
      setMessage('O fim do trecho tem que vir depois do começo.')
      return
    }
    const segmentId = overrideSegmentId.trim()
    setBusy(true)
    setMessage(null)
    setConflict(null)
    try {
      const response = await fetch(
        `/v1/projects/${project}/capture-sessions/${encodedSession}/color-match/overrides`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            // The fence the page is holding, as the read handed it over.
            baseVersionId: read.versionRef,
            baseHash: read.plan.planHash,
            projectBaseVersionId: projectVersion.id,
            projectBaseHash: projectVersion.baseHash,
            override: {
              overrideId: `override-${read.plan.rangeOverrides.length + 1}-v${read.version}`,
              cameraId: overrideCameraId.trim(),
              // The scope, when the operator gave one. Omitted rather than sent
              // as null: the schema refuses an unknown key, and an absent scope
              // is what the domain reads as "the whole camera".
              ...(segmentId.length === 0 ? {} : { segmentId }),
              ...(start.length === 0 ? {} : { range: { start, end } }),
              parameters: {
                brightness: Number(brightness),
                contrast: Number(contrast),
                saturation: Number(saturation),
              },
              reason: overrideReason.trim(),
            },
          }),
        },
      )
      const body = (await response.json()) as ApiEnvelope<{ replayed: boolean }>
      if (handleRefusal(response.status, body)) return
      if (!response.ok) {
        setMessage(body.error?.message ?? 'A correção local foi recusada.')
        return
      }
      // Says what was actually sent. The old sentence promised a scope the
      // request never carried, which is the difference between a correction on
      // one take and a correction on the whole camera.
      setMessage(
        start.length > 0
          ? `Correção local aplicada entre ${start} e ${end}, nessa câmera e em mais nada.`
          : segmentId.length > 0
            ? `Correção local aplicada no trecho ${segmentId}, nessa câmera e em mais nada.`
            : 'Correção local aplicada na câmera inteira: nenhum trecho foi indicado.',
      )
      setOverrideReason('')
      await load()
    } catch {
      setMessage('A rede falhou ao aplicar a correção local.')
    } finally {
      setBusy(false)
    }
  }, [
    brightness, contrast, encodedSession, handleRefusal, load, overrideCameraId,
    overrideEndTick, overrideReason, overrideSegmentId, overrideStartTick,
    project, projectVersion, read, saturation,
  ])

  const plan = read?.plan ?? null
  const cameraChoices = plan
    ? [...new Set([plan.referenceCameraId, ...plan.cameraTransforms.map((entry) => entry.cameraId)])]
    : offeredCameras

  return (
    <main data-testid="color-match-page" data-review={String(plan?.humanReviewRequired ?? false)}>
      <AppShellNavigation active="capture-sessions" />
      <LogoutButton />

      <h1>Cor multicâmera</h1>

      <nav data-testid="color-siblings">
        <a data-testid="link-capture-sessions" href="/capture-sessions">Sessões de captura</a>
        <a
          data-testid="link-multicam-direction"
          href={`/multicam-direction?projeto=${encodeURIComponent(projectId.trim())}&sessao=${encodeURIComponent(sessionId.trim())}`}
        >
          Direção multicâmera
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
        <button data-testid="load-color-match" disabled={busy} type="submit">Abrir</button>
      </form>

      {message && <p data-testid="color-message" role="alert">{message}</p>}

      {conflict && (
        <p data-testid="stale-conflict">
          A versão corrente é {conflict}.{' '}
          <button data-testid="reload-color-match" onClick={() => void load()} type="button">
            Recarregar
          </button>
        </p>
      )}

      <section data-testid="derive-command">
        <h2>Câmera de referência</h2>
        <p>
          É a única entrada de cor que esta tela manda. Todo delta abaixo é
          medido do quadro decodificado, no servidor.
        </p>
        <label>
          Chave da câmera
          <input
            data-testid="reference-camera"
            list="color-camera-keys"
            onChange={(event) => setReferenceCameraId(event.target.value)}
            value={referenceCameraId}
          />
        </label>
        <datalist id="color-camera-keys">
          {cameraChoices.map((camera) => <option key={camera} value={camera} />)}
        </datalist>
        {offeredCameras.length > 0 && (
          <p data-testid="offered-cameras">
            A sessão carrega estas câmeras: {offeredCameras.join(', ')}.
          </p>
        )}
        <button
          data-testid="derive-match"
          disabled={busy || !session || !projectVersion}
          onClick={() => void derive()}
          type="button"
        >
          Derivar o casamento de cor
        </button>
      </section>

      {plan && read && (
        <section data-testid="match-plan" data-version={read.version}>
          <h2>Plano v{read.version} · referência {plan.referenceCameraId}</h2>
          <p data-testid="match-head">
            {read.isHead
              ? 'Este é o elo corrente da cadeia.'
              : 'Este elo foi superado — a cor corrente é outra.'}
          </p>
          <p data-testid="reference-selection">
            Escolhida por {plan.referenceCameraSelection.selectedBy.kind}{' '}
            {plan.referenceCameraSelection.selectedBy.id} em{' '}
            {plan.referenceCameraSelection.selectedAt}, contra{' '}
            {plan.referenceCameraSelection.baseVersionId}.
          </p>
          <p data-testid="match-confidence">
            Confiança do plano {plan.confidence.toFixed(3)} · etapa {plan.pipelineStage}
          </p>
          <div data-testid="match-review" data-required={String(plan.humanReviewRequired)}>
            {plan.humanReviewRequired
              ? <p>Alguma correção foi limitada ou não pôde ser medida: uma pessoa tem que olhar.</p>
              : <p>Nada neste plano exige revisão humana.</p>}
          </div>

          <table data-testid="camera-deltas">
            <thead>
              <tr>
                <th scope="col">Câmera</th>
                <th scope="col">Exposição</th>
                <th scope="col">Balanço de branco</th>
                <th scope="col">Contraste</th>
                <th scope="col">Saturação</th>
                <th scope="col">Confiança</th>
                <th scope="col">Pares medidos</th>
              </tr>
            </thead>
            <tbody>
              {plan.cameraTransforms.map((entry) => (
                <tr data-testid={`camera-${entry.cameraId}`} key={entry.cameraId}>
                  <td>{entry.cameraId}</td>
                  <td data-testid={`exposure-${entry.cameraId}`}>
                    {showNumber(entry.deltas.exposureEv, 2, ' EV')}
                  </td>
                  <td data-testid={`white-balance-${entry.cameraId}`}>
                    {entry.deltas.whiteBalance === null
                      ? 'não medido'
                      : `R ${entry.deltas.whiteBalance.redGain.toFixed(3)} · `
                        + `G ${entry.deltas.whiteBalance.greenGain.toFixed(3)} · `
                        + `B ${entry.deltas.whiteBalance.blueGain.toFixed(3)}`}
                  </td>
                  <td data-testid={`contrast-${entry.cameraId}`}>{showNumber(entry.deltas.contrast)}</td>
                  <td data-testid={`saturation-${entry.cameraId}`}>{showNumber(entry.deltas.saturation)}</td>
                  <td>{entry.confidence.toFixed(3)}</td>
                  <td data-testid={`pairs-${entry.cameraId}`}>{entry.rangePairs}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {plan.rangeOverrides.length === 0 ? (
            <p data-testid="overrides-empty">Nenhuma correção local em vigor.</p>
          ) : (
            <ul data-testid="range-overrides">
              {plan.rangeOverrides.map((override) => (
                <li data-testid={`override-${override.overrideId}`} key={override.overrideId}>
                  {override.cameraId}
                  {override.range
                    ? ` entre ${formatTicks(override.range.start, tickRate)} e ${formatTicks(override.range.end, tickRate)}`
                    : override.segmentId
                      ? ` no trecho ${override.segmentId}`
                      : ' na câmera inteira'}
                  {' — '}{override.reason}{' ('}{override.actor.kind} {override.actor.id}{')'}
                </li>
              ))}
            </ul>
          )}

          {plan.nonComparableRanges.length > 0 && (
            <ul data-testid="non-comparable">
              {plan.nonComparableRanges.map((range) => (
                <li key={`${range.cameraId}-${range.measurementId}`}>
                  {range.cameraId} entre {formatTicks(range.range.start, tickRate)} e{' '}
                  {formatTicks(range.range.end, tickRate)}: {range.reason}. Fora do ajuste,
                  não diluído nele.
                </li>
              ))}
            </ul>
          )}

          {plan.issues.length > 0 && (
            <ul data-testid="plan-issues">
              {plan.issues.map((issue, index) => (
                <li data-testid={`plan-issue-${issue.code}`} key={`${issue.code}-${index}`}>
                  {issue.code}
                  {issue.cameraId ? ` (${issue.cameraId})` : ''}: {issue.message}
                  {issue.humanReviewRequired ? ' — exige uma pessoa.' : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {plan && read && (
        <section data-testid="override-command">
          <h2>Correção local</h2>
          <p>
            A única cor que esta tela manda além da referência. As camadas das
            outras câmeras passam intactas.
          </p>
          <p data-testid="override-scope-note">
            {overrideStartTick.trim().length > 0
              ? 'Esta correção vale só entre os dois instantes abaixo.'
              : overrideSegmentId.trim().length > 0
                ? 'Esta correção vale só no trecho nomeado abaixo.'
                : 'Sem trecho e sem instantes, esta correção pega a câmera inteira — '
                  + 'todo plano dela, do começo ao fim da sessão.'}
          </p>
          <label>
            Câmera
            <input
              data-testid="override-camera"
              list="color-camera-keys"
              onChange={(event) => setOverrideCameraId(event.target.value)}
              value={overrideCameraId}
            />
          </label>
          <label>
            Do instante (ticks; vazio = câmera inteira)
            <input
              data-testid="override-range-start"
              onChange={(event) => setOverrideStartTick(event.target.value)}
              value={overrideStartTick}
            />
          </label>
          <label>
            Até o instante (ticks)
            <input
              data-testid="override-range-end"
              onChange={(event) => setOverrideEndTick(event.target.value)}
              value={overrideEndTick}
            />
          </label>
          <label>
            Ou o trecho, pelo nome
            <input
              data-testid="override-segment"
              onChange={(event) => setOverrideSegmentId(event.target.value)}
              value={overrideSegmentId}
            />
          </label>
          <label>
            Brilho
            <input
              data-testid="override-brightness"
              onChange={(event) => setBrightness(event.target.value)}
              step="0.01"
              type="number"
              value={brightness}
            />
          </label>
          <label>
            Contraste
            <input
              data-testid="override-contrast"
              onChange={(event) => setContrast(event.target.value)}
              step="0.01"
              type="number"
              value={contrast}
            />
          </label>
          <label>
            Saturação
            <input
              data-testid="override-saturation"
              onChange={(event) => setSaturation(event.target.value)}
              step="0.01"
              type="number"
              value={saturation}
            />
          </label>
          <label>
            Motivo
            <input
              data-testid="override-reason"
              onChange={(event) => setOverrideReason(event.target.value)}
              value={overrideReason}
            />
          </label>
          <button data-testid="apply-override" disabled={busy} onClick={() => void applyOverride()} type="button">
            Aplicar a correção local
          </button>
        </section>
      )}

      {reports && (
        <section data-testid="critic-reports">
          <h2>Vereditos de cor</h2>
          <p data-testid="correction-budget">
            {reports.correctionsApplied} correção
            {reports.correctionsApplied === 1 ? '' : 'ões'} limitada
            {reports.correctionsApplied === 1 ? '' : 's'} nesta versão.{' '}
            {reports.correctionBudgetExhausted
              ? 'O orçamento acabou: a próxima passa por uma pessoa.'
              : 'Ainda cabe outra.'}
          </p>
          {reports.reports.length === 0 && (
            <p data-testid="critic-empty">Nenhum veredito sobre esta versão do projeto.</p>
          )}
          <ul>
            {reports.reports.map((summary) => (
              <li data-testid={`critic-${summary.reportId}`} key={summary.reportId}>
                <button
                  data-testid={`open-critic-${summary.reportId}`}
                  disabled={busy}
                  onClick={() => void openReport(summary.reportId)}
                  type="button"
                >
                  {ACTION_TEXT[summary.action] ?? summary.action} · {summary.cause} ·{' '}
                  {summary.hardIssues} bloqueio{summary.hardIssues === 1 ? '' : 's'},{' '}
                  {summary.warningIssues} aviso{summary.warningIssues === 1 ? '' : 's'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report && (
        <section data-testid="critic-report" data-action={report.action}>
          <h2>Veredito {report.reportId}</h2>
          <p data-testid="critic-verdict">
            {ACTION_TEXT[report.action] ?? report.action}, porque {report.cause}. Confiança{' '}
            {report.confidence.toFixed(3)} ({report.confidenceBand}).
          </p>

          {/* The pairing is what makes the verdict checkable: which "before"
              reading was compared with which "after" reading, for which camera.
              Without it "the critic compared A with A" is something a reader
              can only trust. */}
          {report.stagePairs.length > 0 && (
            <ul data-testid="stage-pairs">
              {report.stagePairs.map((pair) => (
                <li key={`${pair.cameraId}-${pair.beforeMeasurementId}`}>
                  {pair.cameraId}: {pair.beforeMeasurementId} → {pair.afterMeasurementId}
                </li>
              ))}
            </ul>
          )}

          {/* The bytes it judged, playable. Evidence a person can look at is
              the difference between a verdict and an assertion. */}
          {report.sections.map((section) => (
            <div data-testid={`stage-${section.stage}`} key={section.stage}>
              <h3>{section.stage}</h3>
              {section.bytesEvaluated.length === 0 ? (
                <p data-testid={`no-evidence-${section.stage}`}>
                  Sem bytes retidos desta etapa.
                </p>
              ) : (
                section.bytesEvaluated.map((bytes) => (
                  <video
                    controls
                    data-testid={`evidence-${bytes.artifactId}`}
                    key={bytes.artifactId}
                    muted
                    src={`/v1/artifacts/${encodeURIComponent(bytes.artifactId)}/content`}
                  />
                ))
              )}
            </div>
          ))}

          <table data-testid="critic-dimensions">
            <thead>
              <tr>
                <th scope="col">Dimensão</th>
                <th scope="col">Situação</th>
                <th scope="col">Medido</th>
                <th scope="col">Limite</th>
                <th scope="col">Por quê</th>
              </tr>
            </thead>
            <tbody>
              {report.dimensions.map((dimension) => (
                <tr data-testid={`dimension-${dimension.dimension}`} key={`${dimension.dimension}-${dimension.stage}`}>
                  <td>{dimension.dimension}</td>
                  <td>{dimension.status}</td>
                  <td data-testid={`measured-${dimension.dimension}`}>
                    {showNumber(dimension.value, 3, dimension.unit ? ` ${dimension.unit}` : '')}
                  </td>
                  <td>{showNumber(dimension.threshold)}</td>
                  <td>{dimension.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {issues && (
        <section data-testid="critic-issues">
          <h2>Problemas apontados</h2>
          {issues.filteredOut > 0 && (
            <p data-testid="issues-filtered">
              Os filtros tiraram {issues.filteredOut} problema
              {issues.filteredOut === 1 ? '' : 's'} desta lista.
            </p>
          )}
          {issues.issues.length === 0 && <p data-testid="issues-empty">Nenhum problema nesta leitura.</p>}
          {issues.issues.map((issue, index) => (
            <article data-testid={`issue-${issue.code}-${index}`} key={`${issue.code}-${index}`}>
              <h3>
                {issue.code} · {SEVERITY_TEXT[issue.severity] ?? issue.severity}
              </h3>
              <p data-testid={`issue-measure-${issue.code}-${index}`}>
                {issue.dimension}: {showNumber(issue.measured)} contra o limite{' '}
                {showNumber(issue.threshold)} ({issue.thresholdVersion})
              </p>
              <p>
                {issue.classification} · {issue.cause} · etapa {issue.stage}
                {issue.cameraId ? ` · câmera ${issue.cameraId}` : ''}
                {issue.range
                  ? ` · entre ${formatTicks(issue.range.start, tickRate)} e ${formatTicks(issue.range.end, tickRate)}`
                  : ''}
              </p>
              {issue.evidenceRefs.length === 0 ? (
                <p data-testid={`issue-no-evidence-${index}`}>Sem evidência citada.</p>
              ) : (
                <ul data-testid={`issue-evidence-${index}`}>
                  {issue.evidenceRefs.map((ref) => <li key={ref}>{ref}</li>)}
                </ul>
              )}
            </article>
          ))}
        </section>
      )}
    </main>
  )
}
