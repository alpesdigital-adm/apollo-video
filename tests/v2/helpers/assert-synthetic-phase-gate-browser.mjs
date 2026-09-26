import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const SHA256 = /^[a-f0-9]{64}$/
const CRITERION_CHECKS = Object.freeze({
  'F3-GATE-001': Object.freeze([
    'elevenlabs-audio-alignment-live',
    'heygen-generated-audio-avatar-live',
    'heygen-ready-audio-avatar-live',
  ]),
  'F3-GATE-002': Object.freeze([
    'approved-blocks-catalogued',
    'cross-project-reuse-with-zero-provider-work',
  ]),
  'F3-GATE-003': Object.freeze([
    'transformation-rejected-before-fallback',
    'fallback-result-approved',
  ]),
  'F3-GATE-004': Object.freeze([
    'provider-swap-keeps-plan-and-renderer-contracts',
  ]),
})
const CHECK_CODES = Object.freeze(Object.values(CRITERION_CHECKS).flat())

// Wave 25 UI contract of the history panel. Every string is asserted exactly.
const HISTORY_LIMIT = 20
const TEXT = Object.freeze({
  selectLabel: 'Histórico de avaliações',
  historical: 'Avaliação histórica desta versão: existe uma avaliação mais recente na lista.',
  latest: 'Retrato imutável da versão e das evidências existentes no instante acima.',
  snapshotNote: 'Estado do retrato selecionado. Nenhuma avaliação histórica equivale a aprovação da versão atual.',
  run: 'Avaliar versão atual',
  running: 'Avaliando evidências…',
  retry: 'Tentar leitura novamente',
  forbidden: 'Esta sessão não pode consultar o gate sintético.',
  rateLimited: 'O servidor pediu uma pausa antes de consultar o gate novamente.',
  timeout: 'A resposta da avaliação não chegou a tempo. Tente novamente para consultar a mesma intenção.',
})
const VERDICT_LABELS = Object.freeze({ approved: 'Aprovado', failed: 'Reprovado', incomplete: 'Incompleto' })
const staleText = (versionId) =>
  `Avaliação de outra versão ou hash: o editor está na versão ${versionId}. Use "Avaliar versão atual" para o estado atual.`
const runNoteText = (versionId) =>
  `Avalia a versão atual do editor (${versionId}), independentemente da avaliação selecionada.`
const countText = (count) => `${count} avaliação(ões) · últimas ${HISTORY_LIMIT} do projeto`
const CONTROLLED_PREFIX = 'controlled-w25-'
const SELECTION_SETTLE_MS = 1_500
const QUIET_WINDOW_MS = 750

// Wave 27 UI contract of the inline critic report viewer. The labels are the
// contract's words; every value they are keyed by comes from the API record.
const CRITIC_REFERENCE_TYPE = 'transformation-critic-report'
const CRITIC_READ_NAME = 'transformation-critic-report'
const W27_CONTROLLED_PREFIX = 'controlled-w27-'
const CRITIC_TEXT = Object.freeze({
  json: 'Abrir JSON',
  open: 'Ver relatório',
  header: 'Relatório crítico',
  close: 'Fechar',
  loading: 'Carregando relatório…',
  actionNote: 'Registrada no relatório; nada é executado a partir daqui.',
  hardGatesEmpty: 'Nenhum hard gate acionado.',
  hardGatesNote: 'Lista vazia não significa aprovação: vale a decisão registrada acima.',
  issuesEmpty: 'Nenhuma issue registrada.',
  issuesNote: 'Ausência de issues não significa aprovação.',
  details: 'Detalhes técnicos',
  identity: 'O relatório retornado não corresponde à referência selecionada (projeto, ID ou hash divergente).',
  forbidden: 'Esta sessão não pode consultar o relatório crítico.',
  notFound: 'Relatório não encontrado neste projeto (ASSET_NOT_FOUND).',
})
const criticRateLimitedText = (seconds) =>
  `O servidor pediu uma pausa de ${seconds} s antes de consultar o relatório novamente.`
const CRITIC_DECISION_LABELS = Object.freeze({
  approved: 'Aprovado',
  rejected: 'Rejeitado',
  'needs-review': 'Precisa de revisão',
  'evidence-unavailable': 'Evidência indisponível',
})
const CRITIC_ACTION_LABELS = Object.freeze({
  approve: 'aprovar',
  retry: 'repetir',
  fallback: 'usar alternativa',
  review: 'revisar',
})
const CRITIC_STATUS_LABELS = Object.freeze({
  measured: 'Medida',
  'not-applicable': 'Não se aplica',
  unavailable: 'Indisponível',
})
const CRITIC_SEVERITY_LABELS = Object.freeze({ blocking: 'Bloqueante', major: 'Grave', minor: 'Menor' })
const CRITIC_EVALUATOR_KIND_LABELS = Object.freeze({ measured: 'medição real', controlled: 'prova controlada' })
const CRITIC_DETAIL_FIELDS = Object.freeze([
  'id', 'reportHash', 'projectId', 'providerJobId', 'briefId', 'briefHash', 'policyId', 'policyHash',
  'sourceArtifactId', 'sourceArtifactSha256', 'resultArtifactId', 'resultArtifactSha256', 'schemaVersion',
])
const CRITIC_JSON_CONTROL = 'synthetic-phase-gate-critic-json'
const CRITIC_OPEN_CONTROL = 'synthetic-phase-gate-critic-open'
// The codes the report route itself answers with (PUBLIC_ERROR_CATALOG), so
// each controlled refusal is shaped like a real one.
const CRITIC_FORBIDDEN_CODE = 'AUTH_SCOPE_REQUIRED'
const CRITIC_RATE_LIMIT_CODE = 'GOVERNANCE_LIMIT_EXCEEDED'

export function summarizeSyntheticPhaseGateCoverage(report) {
  const evidenceByCriterion = new Map(report.evidence.map((criterion) => [criterion.criterion, criterion]))
  assert.equal(evidenceByCriterion.size, report.evidence.length, 'gate criteria must be unique')
  const missingCriteria = new Set(report.missing)
  assert.equal(missingCriteria.size, report.missing.length, 'missing gate criteria must be unique')
  assert.deepEqual(
    [...new Set([...evidenceByCriterion.keys(), ...missingCriteria])].sort(),
    Object.keys(CRITERION_CHECKS).sort(),
    'present and missing criteria must cover the fixed gate contract exactly',
  )

  const missingCodes = []
  let covered = 0
  let total = 0
  for (const [criterionCode, requiredCodes] of Object.entries(CRITERION_CHECKS)) {
    const criterion = evidenceByCriterion.get(criterionCode)
    if (!criterion) {
      assert.ok(missingCriteria.has(criterionCode), `${criterionCode} must be declared missing`)
      missingCodes.push(...requiredCodes)
      total += requiredCodes.length
      continue
    }
    assert.equal(missingCriteria.has(criterionCode), false, `${criterionCode} cannot be present and missing`)
    const checksByCode = new Map(criterion.checks.map((check) => [check.code, check]))
    assert.equal(checksByCode.size, criterion.checks.length, `${criterionCode} checks must be unique`)
    const missingChecks = new Set(criterion.missingChecks)
    assert.equal(missingChecks.size, criterion.missingChecks.length, `${criterionCode} missing checks must be unique`)
    assert.ok(
      [...checksByCode.keys(), ...missingChecks].every((code) => requiredCodes.includes(code)),
      `${criterionCode} contains a check outside the fixed gate contract`,
    )
    for (const code of requiredCodes) {
      total += 1
      const check = checksByCode.get(code)
      const missing = !check || missingChecks.has(code) || check.missingEvidenceTypes.length > 0
      if (missing) missingCodes.push(code)
      else covered += 1
    }
  }
  return Object.freeze({ covered, total, missingCodes: Object.freeze(missingCodes.sort()) })
}

function shortHash(value) {
  return `${value.slice(0, 10)}…${value.slice(-6)}`
}

function gateVerdict(gate) {
  if (gate.report.approved) return 'approved'
  const incomplete = gate.report.missing.length > 0 ||
    gate.report.evidence.some((criterion) =>
      criterion.missingChecks.length > 0 ||
      criterion.checks.some((check) => check.missingEvidenceTypes.length > 0))
  return incomplete ? 'incomplete' : 'failed'
}

/**
 * What the panel must show for one gate, derived only from the API record.
 * Statuses and references follow the eight fixed checks, not the page.
 */
function expectedGateView(gate) {
  const coverage = summarizeSyntheticPhaseGateCoverage(gate.report)
  const checksByCode = new Map(gate.report.evidence
    .flatMap((criterion) => criterion.checks)
    .map((check) => [check.code, check]))
  return Object.freeze({
    summary: `${gate.report.passed}/${gate.report.total} critérios · ${coverage.covered}/${coverage.total} checks com evidência`,
    verdict: gateVerdict(gate),
    checks: CHECK_CODES.map((code) => {
      const check = checksByCode.get(code)
      const status = !check || check.missingEvidenceTypes.length > 0
        ? 'missing'
        : check.passed ? 'passed' : 'failed'
      return Object.freeze({
        code,
        status,
        references: (check?.references ?? [])
          .map((reference) => `${reference.type} ${reference.id} · ${shortHash(reference.hash)}`)
          .sort(),
        hashes: (check?.references ?? []).map((reference) => reference.hash).sort(),
        criticReferences: (check?.references ?? [])
          .filter((reference) => reference.type === CRITIC_REFERENCE_TYPE)
          .map((reference) => `${reference.id}:${reference.hash}`)
          .sort(),
      })
    }),
    identityHashes: `report ${shortHash(gate.reportFingerprint)} · record ${shortHash(gate.recordHash)}`,
  })
}

function comparableView(state) {
  return {
    summary: state.summary,
    verdict: state.verdict,
    statuses: state.checks.map(({ code, status }) => `${code}=${status}`),
    references: state.checks.map(({ code, references }) => `${code}:${references.map(({ text }) => text).join('|')}`),
    identity: state.identity?.text ?? null,
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** A browser-only gate for controlled transport answers; it never reaches the server. */
function controlledGate(base, overrides) {
  assert.ok(overrides.id.startsWith(CONTROLLED_PREFIX), 'controlled gates must carry the controlled prefix')
  const gate = structuredClone(base)
  gate.id = overrides.id
  gate.createdAt = overrides.createdAt ?? base.createdAt
  gate.recordHash = sha256Hex(`${overrides.id}:record`)
  gate.reportFingerprint = sha256Hex(`${overrides.id}:report`)
  if (overrides.projectId) gate.projectId = overrides.projectId
  if (overrides.projectVersionId) {
    gate.projectVersionId = overrides.projectVersionId
    gate.report.projectVersionId = overrides.projectVersionId
  }
  if (overrides.projectVersionHash) {
    gate.projectVersionHash = overrides.projectVersionHash
    gate.report.projectVersionHash = overrides.projectVersionHash
  }
  return gate
}

function criticReportPath(projectId, reportId) {
  return `/v1/projects/${encodeURIComponent(projectId)}/transformation-critic-reports/${encodeURIComponent(reportId)}`
}

/** Every critic report a gate references, with the check that carries it. */
function criticReferencesOf(gate) {
  return gate.report.evidence
    .flatMap((criterion) => criterion.checks)
    .flatMap((check) => check.references
      .filter((reference) => reference.type === CRITIC_REFERENCE_TYPE)
      .map((reference) => ({ checkCode: check.code, id: reference.id, hash: reference.hash })))
}

function collapse(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

/** A score that was not produced reads as unavailable, never as zero. */
function expectedBps(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} bps` : 'indisponível'
}

function expectedFrames(range) {
  return range ? `quadros ${range.startFrame}–${range.endFrame}` : 'resultado inteiro'
}

function assertInOrder(text, fragments, label) {
  let from = 0
  for (const fragment of fragments.map(collapse)) {
    const at = text.indexOf(fragment, from)
    assert.ok(at >= 0, `${label}: expected "${fragment}" after position ${from} in "${text.slice(0, 600)}"`)
    from = at + fragment.length
  }
}

/**
 * What the ready viewer must render for one record, derived only from that
 * record: counts, per-item attributes in record order and the texts the
 * contract composes from each field.
 */
function expectedCriticView(record) {
  const evaluators = new Map(record.evaluators.map((evaluator) => [evaluator.id, evaluator]))
  return Object.freeze({
    measurements: record.measurements.map((measurement) => {
      const evaluator = measurement.evaluatorId ? evaluators.get(measurement.evaluatorId) : undefined
      const known = evaluator && Object.hasOwn(CRITIC_EVALUATOR_KIND_LABELS, evaluator.kind) ? evaluator : undefined
      return Object.freeze({
        attributes: {
          dimension: measurement.dimension,
          status: measurement.status,
          evaluatorId: measurement.evaluatorId ?? '',
          evaluatorKind: known ? known.kind : '',
        },
        fragments: [
          measurement.dimension,
          CRITIC_STATUS_LABELS[measurement.status],
          `score ${expectedBps(measurement.scoreBps)} · limiar ${expectedBps(measurement.thresholdBps)}`,
          ...(measurement.note ? [measurement.note] : []),
          expectedFrames(measurement.frameRange),
          known
            ? `origem: ${known.id} · ${CRITIC_EVALUATOR_KIND_LABELS[known.kind]} · v${known.version}`
            : 'origem não informada',
        ],
        // A null score must never read as zero, and a controlled proxy is
        // never described as a real measurement (nor the reverse).
        absent: [
          ...(measurement.scoreBps === null ? ['score 0'] : []),
          ...(measurement.thresholdBps === null ? ['limiar 0'] : []),
          ...(known?.kind === 'controlled' ? [CRITIC_EVALUATOR_KIND_LABELS.measured] : []),
          ...(known?.kind === 'measured' ? [CRITIC_EVALUATOR_KIND_LABELS.controlled] : []),
        ],
      })
    }),
    issues: record.issues.map((issue) => Object.freeze({
      attributes: {
        dimension: issue.dimension,
        severity: issue.severity,
        startFrame: String(issue.frameRange.startFrame),
        endFrame: String(issue.frameRange.endFrame),
      },
      fragments: [
        `${CRITIC_SEVERITY_LABELS[issue.severity]} · ${issue.dimension} · ${expectedFrames(issue.frameRange)}`,
        issue.description,
        ...(issue.violatedPreserve === undefined
          ? []
          : [`viola preservação: ${typeof issue.violatedPreserve === 'string' ? issue.violatedPreserve : JSON.stringify(issue.violatedPreserve)}`]),
      ],
      description: issue.description,
    })),
    scores: [
      ...(record.confidenceBps === null ? [] : [`confiança ${expectedBps(record.confidenceBps)}`]),
      ...(record.intentScoreBps === null ? [] : [`intenção ${expectedBps(record.intentScoreBps)}`]),
    ],
    evaluators: record.evaluators.map((evaluator) =>
      `${evaluator.id} · ${evaluator.kind} · ${evaluator.version} · ${evaluator.scope}`),
  })
}

/** The whole ready viewer against the API record; nothing is compared with a literal value. */
function assertCriticViewerShowsRecord(view, record, input) {
  const { label, evaluatedAtText } = input
  assert.equal(view.viewerCount, 1, `${label}: exactly one viewer`)
  const viewer = view.viewer
  const expected = expectedCriticView(record)
  assert.equal(viewer.state, 'ready', `${label}: data-state`)
  assert.equal(viewer.referenceId, record.id, `${label}: data-reference-id`)
  assert.equal(viewer.referenceHash, record.reportHash, `${label}: data-reference-hash`)
  assert.equal(viewer.reportId, record.id, `${label}: data-report-id`)
  assert.equal(viewer.reportHash, record.reportHash, `${label}: data-report-hash`)
  assert.equal(viewer.insidePanel && viewer.afterCriteria && viewer.beforeRun, true,
    `${label}: the viewer sits in the panel after the criteria and before the run button`)
  assert.equal(viewer.error, null, `${label}: no error block`)
  assert.equal(viewer.loading, null, `${label}: no loading line`)
  assert.equal(viewer.retryCount, 0, `${label}: no retry control`)
  assert.ok(viewer.text.includes(CRITIC_TEXT.header), `${label}: header`)
  assert.deepEqual(viewer.close, { count: 1, tag: 'button', text: CRITIC_TEXT.close }, `${label}: close control`)
  assert.deepEqual(viewer.decision, {
    value: record.decision,
    text: CRITIC_DECISION_LABELS[record.decision],
  }, `${label}: decision badge`)
  assert.equal(viewer.action?.value, record.action, `${label}: data-action`)
  assertInOrder(viewer.action.text, [`Ação sugerida: ${CRITIC_ACTION_LABELS[record.action]}`, CRITIC_TEXT.actionNote],
    `${label}: suggested action`)
  assert.equal(viewer.evaluatedAt?.value, record.evaluatedAt, `${label}: data-evaluated-at`)
  assert.ok(viewer.evaluatedAt.text.includes(evaluatedAtText), `${label}: pt-BR evaluatedAt "${evaluatedAtText}" in "${viewer.evaluatedAt.text}"`)

  assert.equal(viewer.hardGates?.count, String(record.hardGates.length), `${label}: hard gates data-count`)
  assert.deepEqual(viewer.hardGates.items.map(({ dimension }) => dimension), [...record.hardGates], `${label}: hard gates`)
  for (const item of viewer.hardGates.items) assert.ok(item.text.includes(item.dimension), `${label}: hard gate text`)
  assert.ok(viewer.text.includes(CRITIC_TEXT.hardGatesNote), `${label}: hard gates note`)
  assert.equal(viewer.text.includes(CRITIC_TEXT.hardGatesEmpty), record.hardGates.length === 0, `${label}: empty hard gates text`)

  assert.equal(viewer.measurements?.count, String(record.measurements.length), `${label}: measurements data-count`)
  assert.deepEqual(
    viewer.measurements.items.map(({ dimension, status, evaluatorId, evaluatorKind }) => ({ dimension, status, evaluatorId, evaluatorKind })),
    expected.measurements.map(({ attributes }) => attributes),
    `${label}: measurements in record order, with the evaluator kind resolved through evaluators`,
  )
  for (const [index, measurement] of expected.measurements.entries()) {
    const shown = viewer.measurements.items[index]
    assertInOrder(shown.text, measurement.fragments, `${label}: measurement ${index} ${measurement.attributes.dimension}`)
    for (const absent of measurement.absent) {
      assert.equal(shown.text.includes(absent), false, `${label}: measurement ${index} must not show "${absent}": ${shown.text}`)
    }
  }

  if (expected.scores.length === 0) {
    assert.equal(viewer.scores, null, `${label}: no overall scores block without scores`)
  } else {
    assertInOrder(viewer.scores ?? '', expected.scores, `${label}: overall scores`)
    if (record.confidenceBps === null) assert.equal(viewer.scores.includes('confiança'), false)
    if (record.intentScoreBps === null) assert.equal(viewer.scores.includes('intenção'), false)
  }

  assert.equal(viewer.issues?.count, String(record.issues.length), `${label}: issues data-count`)
  assert.deepEqual(
    viewer.issues.items.map(({ dimension, severity, startFrame, endFrame }) => ({ dimension, severity, startFrame, endFrame })),
    expected.issues.map(({ attributes }) => attributes),
    `${label}: issues in record order`,
  )
  for (const [index, issue] of expected.issues.entries()) {
    const shown = viewer.issues.items[index]
    assertInOrder(shown.text, issue.fragments, `${label}: issue ${index}`)
    // Ranges are stated in frames only: nothing outside the description reads as seconds.
    assert.doesNotMatch(shown.text.replace(collapse(issue.description), ''), /\d\s?s\b/, `${label}: issue ${index} shows seconds`)
  }
  assert.equal(viewer.text.includes(CRITIC_TEXT.issuesEmpty), record.issues.length === 0, `${label}: empty issues text`)
  assert.equal(viewer.text.includes(CRITIC_TEXT.issuesNote), record.issues.length === 0, `${label}: empty issues note`)

  assert.equal(viewer.details?.tag, 'details', `${label}: technical details element`)
  assert.equal(viewer.details.summary, CRITIC_TEXT.details, `${label}: technical details summary`)
  const fields = new Map()
  for (const [name, value] of viewer.details.fields) fields.set(name, [...(fields.get(name) ?? []), value])
  for (const name of CRITIC_DETAIL_FIELDS) {
    assert.deepEqual(fields.get(name), [record[name]], `${label}: details data-field="${name}"`)
  }
  assertInOrder(viewer.details.text, expected.evaluators, `${label}: evaluators in technical details`)
  assert.equal(viewer.addresses, 0, `${label}: no link or href is derived from the response`)
  return Object.freeze({
    measurements: viewer.measurements.items.length,
    issues: viewer.issues.items.length,
    hardGates: viewer.hardGates.items.length,
    detailFields: Object.fromEntries(CRITIC_DETAIL_FIELDS.map((name) => [name, fields.get(name)?.[0] ?? null])),
  })
}

/** A report answer produced by the browser transport only; it never reaches the server. */
function controlledCriticEnvelope(record, overrides = {}) {
  return JSON.stringify({ data: { report: { ...structuredClone(record), ...overrides } }, meta: { apiVersion: 'v1' } })
}

function controlledCriticRefusal(code, status) {
  return JSON.stringify({ error: { code, message: 'controlled refusal', requestId: `${W27_CONTROLLED_PREFIX}${status}` } })
}

function browserExecutable() {
  return [
    process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((candidate) => candidate && existsSync(candidate))
}

async function bounded(promise, signal, label) {
  if (signal.aborted) throw signal.reason ?? new Error(`${label} aborted`)
  let removeAbort = () => undefined
  const aborted = new Promise((_, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error(`${label} aborted`))
    signal.addEventListener('abort', onAbort, { once: true })
    removeAbort = () => signal.removeEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    removeAbort()
  }
}

function assertGate(gate, input) {
  assert.ok(gate, 'phase gate response must contain a gate')
  assert.equal(gate.report.approved, input.expected.approved)
  assert.equal(gate.report.passed, input.expected.criteriaPassed)
  assert.equal(gate.report.total, input.expected.criteriaTotal)
  assert.match(gate.reportFingerprint, SHA256)
  assert.match(gate.recordHash, SHA256)
  assert.ok(Number.isFinite(Date.parse(gate.report.evaluatedAt)), 'gate must expose a valid evaluatedAt')
  assert.ok(Number.isFinite(Date.parse(gate.createdAt)), 'gate must expose a valid createdAt')

  const coverage = summarizeSyntheticPhaseGateCoverage(gate.report)
  assert.equal(coverage.total, input.expected.checksTotal)
  assert.equal(coverage.covered, input.expected.checksPassed)
  assert.deepEqual(coverage.missingCodes, [...input.expected.missingLiveChecks].sort())
}

async function diagnostic(readServerLogs, page) {
  const [logs, body] = await Promise.all([
    typeof readServerLogs === 'function'
      ? Promise.resolve(readServerLogs()).catch(() => '')
      : Promise.resolve(''),
    page?.locator('body').innerText({ timeout: 1_000 }).catch(() => '') ?? Promise.resolve(''),
  ])
  return `\npage=${String(body).slice(-2_000)}\nserver=${String(logs).slice(-4_000)}`
}

/** One synchronous DOM read of the whole panel, so every field is from the same commit. */
function readPanelInPage() {
  const node = document.querySelector('[data-testid="synthetic-phase-gate-panel"]')
  if (!node) return null
  const text = (element) => element ? (element.textContent ?? '').replace(/\s+/g, ' ').trim() : null
  const byTestId = (id) => node.querySelector(`[data-testid="${id}"]`)
  const select = byTestId('synthetic-phase-gate-history')
  const identity = byTestId('synthetic-phase-gate-identity')
  const run = byTestId('synthetic-phase-gate-run')
  return {
    selectedGateId: node.getAttribute('data-selected-gate-id'),
    gatesCount: node.getAttribute('data-gates-count'),
    select: select
      ? { value: select.value, disabled: select.disabled, ariaLabel: select.getAttribute('aria-label') }
      : null,
    options: [...node.querySelectorAll('[data-testid="synthetic-phase-gate-history-option"]')].map((option) => ({
      value: option.value,
      gateId: option.getAttribute('data-gate-id'),
      version: option.getAttribute('data-gate-version'),
      state: option.getAttribute('data-gate-state'),
      text: text(option),
      selected: option.selected,
    })),
    countText: text(byTestId('synthetic-phase-gate-history-count')),
    summary: text(byTestId('synthetic-phase-gate-summary')),
    verdict: node.querySelector('[data-gate-verdict]')?.getAttribute('data-gate-verdict') ?? null,
    checks: [...node.querySelectorAll('[data-check-code]')].map((check) => ({
      code: check.getAttribute('data-check-code'),
      status: check.getAttribute('data-check-status'),
      references: [...check.querySelectorAll('li')].map((reference) => {
        // Wave 27: an addressed critic reference also holds "Abrir JSON" and
        // "Ver relatório". The identity text is read without those two
        // controls, and the controls are read apart and asserted exactly.
        const controlSelector = '[data-testid="synthetic-phase-gate-critic-json"], [data-testid="synthetic-phase-gate-critic-open"]'
        const identity = reference.cloneNode(true)
        for (const control of identity.querySelectorAll(controlSelector)) control.remove()
        return {
          text: text(identity),
          titles: [...reference.querySelectorAll('[title]')].map((element) => element.getAttribute('title')),
          href: reference.querySelector('a')?.getAttribute('href') ?? null,
          critic: reference.getAttribute('data-testid') === 'synthetic-phase-gate-critic-reference'
            ? {
                referenceId: reference.getAttribute('data-reference-id'),
                referenceHash: reference.getAttribute('data-reference-hash'),
              }
            : null,
          controls: [...reference.querySelectorAll(controlSelector)].map((control) => ({
            testId: control.getAttribute('data-testid'),
            tag: control.tagName.toLowerCase(),
            text: text(control),
            href: control.getAttribute('href'),
            type: control.getAttribute('type'),
            referenceId: control.getAttribute('data-reference-id'),
            referenceHash: control.getAttribute('data-reference-hash'),
          })).sort((left, right) => left.testId.localeCompare(right.testId)),
        }
      }),
    })),
    identity: identity
      ? {
          text: text(identity),
          titles: [...identity.querySelectorAll('[title]')].map((element) => element.getAttribute('title')),
        }
      : null,
    historical: text(byTestId('synthetic-phase-gate-historical')),
    stale: text(byTestId('synthetic-phase-gate-stale')),
    snapshotNote: text(byTestId('synthetic-phase-gate-snapshot-note')),
    runNote: text(byTestId('synthetic-phase-gate-run-note')),
    runButton: run ? { text: text(run), disabled: run.disabled } : null,
    empty: text(byTestId('synthetic-phase-gate-empty')),
    loading: Boolean(node.querySelector('[role="status"]')),
    alerts: [...node.querySelectorAll('[role="alert"]')].map((alert) => text(alert)),
    html: node.innerHTML,
  }
}

function boundedState(state) {
  if (!state) return 'null'
  const { html: _html, ...rest } = state
  return JSON.stringify(rest).slice(0, 3_000)
}

/**
 * One synchronous DOM read of the Wave 27 critic viewer, of every critic
 * reference item and of any report data anywhere in the document.
 */
function readCriticViewerInPage() {
  const text = (element) => element ? (element.textContent ?? '').replace(/\s+/g, ' ').trim() : null
  const attribute = (element, name) => element ? element.getAttribute(name) : null
  const dataSelector = ['decision', 'action', 'evaluated-at', 'hard-gates', 'hard-gate', 'measurements',
    'measurement', 'scores', 'issues', 'issue', 'details']
    .map((id) => `[data-testid="transformation-critic-report-${id}"]`).join(', ')
  const controlSelector = '[data-testid="synthetic-phase-gate-critic-json"], [data-testid="synthetic-phase-gate-critic-open"]'
  const panel = document.querySelector('[data-testid="synthetic-phase-gate-panel"]')
  const references = [...document.querySelectorAll('[data-testid="synthetic-phase-gate-critic-reference"]')].map((item) => {
    const identity = item.cloneNode(true)
    for (const control of identity.querySelectorAll(controlSelector)) control.remove()
    const jsonLinks = [...item.querySelectorAll('[data-testid="synthetic-phase-gate-critic-json"]')]
    const openButtons = [...item.querySelectorAll('[data-testid="synthetic-phase-gate-critic-open"]')]
    const [json] = jsonLinks
    const [open] = openButtons
    return {
      checkCode: item.closest('[data-check-code]')?.getAttribute('data-check-code') ?? null,
      referenceId: attribute(item, 'data-reference-id'),
      referenceHash: attribute(item, 'data-reference-hash'),
      identity: {
        text: text(identity),
        titles: [...identity.querySelectorAll('[title]')].map((element) => element.getAttribute('title')),
      },
      json: json
        ? { count: jsonLinks.length, tag: json.tagName.toLowerCase(), text: text(json), href: attribute(json, 'href') }
        : { count: 0 },
      open: open
        ? {
            count: openButtons.length,
            tag: open.tagName.toLowerCase(),
            type: attribute(open, 'type'),
            text: text(open),
            ariaExpanded: attribute(open, 'aria-expanded'),
            disabled: open.disabled === true,
            referenceId: attribute(open, 'data-reference-id'),
            referenceHash: attribute(open, 'data-reference-hash'),
          }
        : { count: 0 },
    }
  })
  const viewers = [...document.querySelectorAll('[data-testid="transformation-critic-report-viewer"]')]
  const base = {
    url: `${location.pathname}${location.search}`,
    selectedGateId: panel?.getAttribute('data-selected-gate-id') ?? null,
    viewerCount: viewers.length,
    reportDataAnywhere: document.querySelectorAll(dataSelector).length,
    errorsAnywhere: document.querySelectorAll('[data-testid="transformation-critic-report-error"]').length,
    references,
  }
  if (viewers.length !== 1) return { ...base, viewer: null }
  const [root] = viewers
  const one = (id) => root.querySelector(`[data-testid="transformation-critic-report-${id}"]`)
  const all = (id) => [...root.querySelectorAll(`[data-testid="transformation-critic-report-${id}"]`)]
  const criteria = panel ? [...panel.querySelectorAll('[data-criterion]')] : []
  const run = panel?.querySelector('[data-testid="synthetic-phase-gate-run"]') ?? null
  const error = one('error')
  const errorMessage = error ? error.cloneNode(true) : null
  for (const control of errorMessage?.querySelectorAll('[data-testid="transformation-critic-report-retry"]') ?? []) control.remove()
  const closes = all('close')
  const retries = all('retry')
  const decision = one('decision')
  const action = one('action')
  const evaluatedAt = one('evaluated-at')
  const hardGates = one('hard-gates')
  const measurements = one('measurements')
  const scores = one('scores')
  const issues = one('issues')
  const details = one('details')
  return {
    ...base,
    viewer: {
      state: attribute(root, 'data-state'),
      referenceId: attribute(root, 'data-reference-id'),
      referenceHash: attribute(root, 'data-reference-hash'),
      reportId: attribute(root, 'data-report-id'),
      reportHash: attribute(root, 'data-report-hash'),
      insidePanel: Boolean(panel?.contains(root)),
      afterCriteria: criteria.length > 0 &&
        criteria.every((criterion) => Boolean(criterion.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING)),
      beforeRun: Boolean(run && (root.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING)),
      text: text(root),
      close: closes.length ? { count: closes.length, tag: closes[0].tagName.toLowerCase(), text: text(closes[0]) } : { count: 0 },
      loading: text(one('loading')),
      error: error
        ? {
            kind: attribute(error, 'data-failure-kind'),
            code: attribute(error, 'data-failure-code'),
            text: text(error),
            message: text(errorMessage),
            retry: retries.length ? { count: retries.length, tag: retries[0].tagName.toLowerCase(), text: text(retries[0]) } : { count: 0 },
          }
        : null,
      retryCount: retries.length,
      decision: decision ? { value: attribute(decision, 'data-decision'), text: text(decision) } : null,
      action: action ? { value: attribute(action, 'data-action'), text: text(action) } : null,
      evaluatedAt: evaluatedAt ? { value: attribute(evaluatedAt, 'data-evaluated-at'), text: text(evaluatedAt) } : null,
      hardGates: hardGates
        ? {
            count: attribute(hardGates, 'data-count'),
            items: all('hard-gate').map((item) => ({ dimension: attribute(item, 'data-dimension'), text: text(item) })),
          }
        : null,
      measurements: measurements
        ? {
            count: attribute(measurements, 'data-count'),
            items: all('measurement').map((item) => ({
              dimension: attribute(item, 'data-dimension'),
              status: attribute(item, 'data-status'),
              evaluatorId: attribute(item, 'data-evaluator-id'),
              evaluatorKind: attribute(item, 'data-evaluator-kind'),
              text: text(item),
            })),
          }
        : null,
      scores: text(scores),
      issues: issues
        ? {
            count: attribute(issues, 'data-count'),
            items: all('issue').map((item) => ({
              dimension: attribute(item, 'data-dimension'),
              severity: attribute(item, 'data-severity'),
              startFrame: attribute(item, 'data-start-frame'),
              endFrame: attribute(item, 'data-end-frame'),
              text: text(item),
            })),
          }
        : null,
      details: details
        ? {
            tag: details.tagName.toLowerCase(),
            summary: text(details.querySelector('summary')),
            text: text(details),
            fields: [...details.querySelectorAll('[data-field]')].map((field) => [field.getAttribute('data-field'), text(field)]),
          }
        : null,
      addresses: root.querySelectorAll('a, [href]').length,
    },
  }
}

/**
 * Watches the document between two reads: every viewer state it passed
 * through (intermediate ones recovered from the attribute's old value),
 * whether report data ever appeared, and whether a sentinel string ever
 * reached the page text.
 */
function installCriticViewerWatchInPage(sentinels) {
  const viewerSelector = '[data-testid="transformation-critic-report-viewer"]'
  const dataSelector = ['decision', 'action', 'evaluated-at', 'hard-gates', 'hard-gate', 'measurements',
    'measurement', 'scores', 'issues', 'issue', 'details']
    .map((id) => `[data-testid="transformation-critic-report-${id}"]`).join(', ')
  window.__apolloW27Watch?.observer.disconnect()
  const current = () => document.querySelector(viewerSelector)?.getAttribute('data-state') ?? 'absent'
  const watch = { states: [current()], dataSeen: false, sentinelsSeen: [] }
  const inspect = () => {
    if (document.querySelector(dataSelector)) watch.dataSeen = true
    const pageText = document.body?.textContent ?? ''
    for (const sentinel of sentinels) {
      if (pageText.includes(sentinel) && !watch.sentinelsSeen.includes(sentinel)) watch.sentinelsSeen.push(sentinel)
    }
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof Element && record.target.matches(viewerSelector) &&
        record.oldValue !== null && watch.states.at(-1) !== record.oldValue) watch.states.push(record.oldValue)
    }
    const now = current()
    if (watch.states.at(-1) !== now) watch.states.push(now)
    inspect()
  })
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['data-state'],
    attributeOldValue: true,
  })
  inspect()
  window.__apolloW27Watch = { watch, observer }
}

function takeCriticViewerWatchInPage() {
  const handle = window.__apolloW27Watch
  if (!handle) return null
  handle.observer.disconnect()
  delete window.__apolloW27Watch
  return JSON.parse(JSON.stringify(handle.watch))
}

/**
 * Exercises the real authenticated editor surface against persisted phase
 * gates. It owns only its browser resources and never inserts or upgrades
 * proof: every controlled answer is produced by the browser transport and is
 * labelled as such in the step title and in the evidence file.
 */
export async function assertSyntheticPhaseGateBrowser(input) {
  assert.ok(input?.signal instanceof AbortSignal, 'signal is required')
  assert.equal(input.signal.aborted, false, 'signal must be active')
  const origin = new URL(input.baseUrl)
  assert.ok(['http:', 'https:'].includes(origin.protocol))
  assert.ok(input.projectId)
  assert.ok(input.login?.username)
  assert.ok(input.login?.password)
  assert.ok(input.evidence?.screenshotPath)
  const history = input.history
  assert.ok(Array.isArray(history?.canonicalGates) && history.canonicalGates.length >= 3,
    'the history proof needs at least three persisted evaluations')
  assert.ok(history.canonicalGates.length < HISTORY_LIMIT, 'the real history must leave room for one more evaluation')
  assert.equal(typeof history.readCanonicalGates, 'function')
  assert.ok(history.currentVersion?.id && SHA256.test(history.currentVersion.hash))
  assert.ok(history.canonicalGates.some(({ id }) => id === history.olderGateId), 'the older gate must be listed')
  assert.notEqual(history.canonicalGates[0].id, history.olderGateId, 'the older gate cannot be the newest')
  assert.ok(history.projectName)
  assert.ok(history.secondProject?.id && history.secondProject.name && history.secondProject.versionId)
  const criticViewer = input.criticViewer
  assert.equal(typeof criticViewer?.readReport, 'function', 'the W27 proof reads the report as the journey actor')
  assert.equal(typeof criticViewer?.readPersistedCounts, 'function', 'the W27 proof counts persisted critic reports and gates')
  const step = typeof input.step === 'function' ? input.step : async (_name, action) => action()

  const executablePath = browserExecutable()
  assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to run the synthetic phase gate browser E2E')
  const screenshotPath = resolve(input.evidence.screenshotPath)
  const evidenceRoot = resolve(input.evidence.root ?? dirname(screenshotPath))
  await mkdir(dirname(screenshotPath), { recursive: true })
  await mkdir(evidenceRoot, { recursive: true })
  const evidence = {
    note: 'mode=real steps read and write the canonical API; mode=controlled-transport steps answer from page.route in this browser only and never reach the server',
    real: {},
    controlled: [],
    screenshots: [],
  }
  const criticEvidencePath = join(evidenceRoot, 'transformation-critic-report-viewer-browser.json')
  const criticEvidence = {
    note: 'Wave 27 inline viewer of the transformation critic report referenced by the gate. mode=real steps open the persisted report through the editor session and compare every rendered field with the record the journey actor read from the public API; mode=controlled-transport steps answer only the report URL from page.route in this browser (fabricated ids prefixed controlled-w27-) and never reach the server, except where a step says it unroutes and retries for real. The block runs after the W25 401 step, whose 401 was a controlled answer that left the server session valid; it starts with a GET navigation back to the editor and must issue zero POST.',
    real: {},
    controlled: [],
    screenshots: [],
  }
  let w25EvidenceWritten = false
  let criticBlockStarted = false
  let w26CriticRead = null

  const { chromium } = await import('playwright-core')
  const pendingWaits = new Set()
  const trackWait = (promise) => {
    promise.catch(() => undefined)
    pendingWaits.add(promise)
    return promise
  }
  let launchPromise
  let browser
  let context
  let page
  let releaseHeldPost
  let releaseTimeoutPost
  let result
  let primaryError
  try {
    launchPromise = chromium.launch({ executablePath, headless: true })
    launchPromise.catch(() => undefined)
    browser = await bounded(launchPromise, input.signal, 'browser launch')
    context = await browser.newContext({ viewport: { width: 1440, height: 1600 } })
    context.setDefaultTimeout(20_000)
    context.setDefaultNavigationTimeout(20_000)
    page = await context.newPage()

    // Request ledger for the whole page: selection must add nothing to it.
    const ledger = []
    let lastRequestAt = Date.now()
    page.on('request', (request) => {
      lastRequestAt = Date.now()
      ledger.push({
        at: new Date(lastRequestAt).toISOString(),
        method: request.method(),
        url: request.url(),
        resourceType: request.resourceType(),
      })
    })

    const projectPath = `/projects/${encodeURIComponent(input.projectId)}`
    const gatePath = `/v1/projects/${encodeURIComponent(input.projectId)}/synthetic-phase-gates`
    const isGateRead = (response, path = gatePath) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === path
    const within = async (promise, timeoutMs, label) => {
      let timer
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: nothing observed within ${timeoutMs} ms`)), timeoutMs)
      })
      try {
        return await bounded(Promise.race([promise, timeout]), input.signal, label)
      } finally {
        clearTimeout(timer)
      }
    }
    const readPanel = () => page.evaluate(readPanelInPage)
    const waitForPanel = async (predicate, label, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs
      let last = null
      while (Date.now() < deadline) {
        last = await bounded(readPanel(), input.signal, label)
        if (last && predicate(last)) return last
        await bounded(delay(50), input.signal, label)
      }
      throw new Error(`${label}: panel did not reach the expected state; last=${boundedState(last)}`)
    }
    const quiesce = async (label) => {
      const deadline = Date.now() + 15_000
      while (Date.now() - lastRequestAt < QUIET_WINDOW_MS) {
        assert.ok(Date.now() < deadline, `${label}: the page never went quiet; recent=${JSON.stringify(ledger.slice(-5))}`)
        await bounded(delay(100), input.signal, label)
      }
    }
    const editorReadCounters = () => page.evaluate(() =>
      typeof window.__apolloEditorReads === 'function' ? window.__apolloEditorReads() : null)
    const localeText = async (iso) =>
      (await page.evaluate((value) => new Date(value).toLocaleString('pt-BR'), iso)).replace(/\s+/g, ' ').trim()
    const panel = page.getByTestId('synthetic-phase-gate-panel')
    const historySelect = page.getByTestId('synthetic-phase-gate-history')
    const runButton = page.getByTestId('synthetic-phase-gate-run')
    const capturePanel = async (path, label) => {
      await bounded(panel.evaluate((node) => node.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'instant',
      })), input.signal, `${label} scroll`)
      await bounded(panel.screenshot({ path }), input.signal, `${label} screenshot`)
      evidence.screenshots.push({ file: path, label })
      return path
    }

    const assertOptions = async (state, gates, label) => {
      const visible = gates.slice(0, HISTORY_LIMIT)
      assert.deepEqual(state.options.map(({ gateId }) => gateId), visible.map(({ id }) => id),
        `${label}: options must follow the received order`)
      assert.equal(state.gatesCount, String(visible.length), `${label}: data-gates-count`)
      assert.equal(state.countText, countText(visible.length), `${label}: history count line`)
      assert.equal(state.select?.ariaLabel, TEXT.selectLabel, `${label}: select accessible name`)
      for (const [index, gate] of visible.entries()) {
        const option = state.options[index]
        const verdict = gateVerdict(gate)
        assert.equal(option.value, gate.id, `${label}: option ${index} value`)
        assert.equal(option.version, gate.projectVersionId, `${label}: option ${index} version`)
        assert.equal(option.state, verdict, `${label}: option ${index} verdict`)
        assert.equal(
          option.text,
          `${await localeText(gate.createdAt)} · versão ${gate.projectVersionId} · ${VERDICT_LABELS[verdict]}`,
          `${label}: option ${index} text`,
        )
      }
    }

    const assertShowsGate = async (state, gate, gates, label) => {
      const expected = expectedGateView(gate)
      const divergent = gate.projectVersionId !== history.currentVersion.id ||
        gate.projectVersionHash !== history.currentVersion.hash
      const latest = gates[0]?.id === gate.id
      assert.equal(state.selectedGateId, gate.id, `${label}: data-selected-gate-id`)
      assert.equal(state.select?.value, gate.id, `${label}: select value`)
      assert.deepEqual(state.options.filter(({ selected }) => selected).map(({ gateId }) => gateId), [gate.id])
      assert.equal(state.summary, expected.summary, `${label}: summary`)
      assert.equal(state.verdict, expected.verdict, `${label}: verdict badge`)
      assert.deepEqual(
        state.checks.map(({ code, status }) => `${code}=${status}`),
        expected.checks.map(({ code, status }) => `${code}=${status}`),
        `${label}: the eight check statuses`,
      )
      for (const check of expected.checks) {
        const shown = state.checks.find(({ code }) => code === check.code)
        assert.deepEqual(shown.references.map(({ text }) => text).sort(), check.references,
          `${label}: ${check.code} references`)
        assert.deepEqual(shown.references.flatMap(({ titles }) => titles).sort(), check.hashes,
          `${label}: ${check.code} reference hashes`)
        for (const reference of shown.references) {
          if (reference.href !== null) {
            assert.ok(reference.href.startsWith('/v1/'), `gate reference must use a published local API address: ${reference.href}`)
          }
          // Wave 27: the identity text above is read without the viewer
          // controls, so the controls themselves are asserted exactly here:
          // an addressed critic reference holds "Abrir JSON" and "Ver
          // relatório" and nothing else; every other reference holds neither.
          const addressedCritic = reference.href !== null && reference.text.startsWith(`${CRITIC_REFERENCE_TYPE} `)
          if (!addressedCritic) {
            assert.equal(reference.critic, null, `${label}: ${check.code} ${reference.text} is not a critic viewer item`)
            assert.deepEqual(reference.controls, [], `${label}: ${check.code} ${reference.text} holds no viewer control`)
            continue
          }
          assert.ok(reference.critic, `${label}: ${check.code} addressed critic reference must be a viewer item`)
          const { referenceId, referenceHash } = reference.critic
          assert.ok(check.criticReferences.includes(`${referenceId}:${referenceHash}`),
            `${label}: ${check.code} critic item ${referenceId} must be a reference of this check`)
          assert.equal(reference.text, `${CRITIC_REFERENCE_TYPE} ${referenceId} · ${shortHash(referenceHash)}`,
            `${label}: ${check.code} critic item identity`)
          assert.deepEqual(reference.controls, [
            {
              testId: CRITIC_JSON_CONTROL,
              tag: 'a',
              text: CRITIC_TEXT.json,
              href: criticReportPath(input.projectId, referenceId),
              type: null,
              referenceId: null,
              referenceHash: null,
            },
            {
              testId: CRITIC_OPEN_CONTROL,
              tag: 'button',
              text: CRITIC_TEXT.open,
              href: null,
              type: 'button',
              referenceId,
              referenceHash,
            },
          ], `${label}: ${check.code} critic item controls`)
        }
      }
      assert.ok(state.identity, `${label}: identity block`)
      assert.ok(
        state.identity.text.includes(`Avaliado em ${await localeText(gate.report.evaluatedAt)} · versão ${gate.projectVersionId}`),
        `${label}: evaluated date and version; identity=${state.identity.text}`,
      )
      assert.ok(state.identity.text.includes(expected.identityHashes), `${label}: report/record hashes`)
      assert.ok(state.identity.titles.includes(gate.reportFingerprint), `${label}: full report fingerprint`)
      assert.equal(state.snapshotNote, TEXT.snapshotNote, `${label}: snapshot note`)
      assert.equal(state.runNote, runNoteText(history.currentVersion.id), `${label}: run note`)
      if (divergent) {
        assert.equal(state.stale, staleText(history.currentVersion.id), `${label}: divergent label`)
        assert.equal(state.historical, null, `${label}: a divergent gate is never historical`)
        assert.equal(state.identity.text.includes(TEXT.latest), false)
      } else if (latest) {
        assert.equal(state.stale, null, `${label}: latest gate is not divergent`)
        assert.equal(state.historical, null, `${label}: latest gate is not historical`)
        assert.ok(state.identity.text.includes(TEXT.latest), `${label}: latest snapshot line`)
      } else {
        assert.equal(state.historical, TEXT.historical, `${label}: historical label`)
        assert.equal(state.stale, null, `${label}: same-version history is never divergent`)
        assert.equal(state.identity.text.includes(TEXT.latest), false)
      }
    }

    // Selecting is a pure state change: the ledger and the editor read
    // counters must not move, and the new state must stay put afterwards.
    const selectWithoutRequests = async (gateId, label) => {
      await quiesce(label)
      const before = ledger.length
      const readsBefore = await bounded(editorReadCounters(), input.signal, `${label} counters`)
      await bounded(historySelect.selectOption(gateId), input.signal, label)
      const state = await waitForPanel((current) => current.selectedGateId === gateId, label)
      await bounded(delay(SELECTION_SETTLE_MS), input.signal, `${label} settle`)
      const settled = await bounded(readPanel(), input.signal, `${label} settled state`)
      const requests = ledger.slice(before)
      const readsAfter = await bounded(editorReadCounters(), input.signal, `${label} counters`)
      assert.deepEqual(requests, [], `${label}: selecting a gate issued requests ${JSON.stringify(requests).slice(0, 1_000)}`)
      assert.deepEqual(readsAfter, readsBefore, `${label}: editor read counters moved`)
      assert.deepEqual(comparableView(settled), comparableView(state), `${label}: selection did not stay stable`)
      return Object.freeze({ state, requests: requests.length, readsBefore, readsAfter, windowMs: SELECTION_SETTLE_MS })
    }

    const controlledRoute = async (handler, action) => {
      const matcher = (url) => url.pathname === gatePath
      await page.route(matcher, handler)
      try {
        return await action()
      } finally {
        await page.unroute(matcher, handler)
      }
    }
    const fulfillGateList = async (route, gates) => {
      const response = await route.fetch()
      assert.equal(response.status(), 200, 'controlled list must start from a real 200 read')
      const envelope = await response.json()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store' },
        body: JSON.stringify({ ...envelope, data: { ...envelope.data, gates: gates(envelope.data.gates) } }),
      })
    }
    const reloadWithGateRead = async (label) => {
      const read = trackWait(page.waitForResponse((response) => isGateRead(response)))
      await bounded(page.reload(), input.signal, `${label} reload`)
      return bounded(read, input.signal, `${label} gate read`)
    }

    // ---- Real: login, initial read and the canonical list ------------------
    await bounded(page.goto(`${origin.origin}/login?next=${encodeURIComponent(projectPath)}`), input.signal, 'login navigation')
    await bounded(page.locator('input[name="username"]').fill(input.login.username), input.signal, 'username')
    await bounded(page.locator('input[name="password"]').fill(input.login.password), input.signal, 'password')
    const sessionResponse = trackWait(page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/v1/session'))
    const initialGateResponse = trackWait(page.waitForResponse((response) => isGateRead(response)))
    const capabilitiesResponse = trackWait(page.waitForResponse((response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === '/v1/capabilities'))
    await bounded(page.getByRole('button', { name: 'Entrar no Apollo' }).click(), input.signal, 'sign in')
    assert.ok([200, 201, 303].includes((await bounded(sessionResponse, input.signal, 'session response')).status()))

    await bounded(page.waitForURL((url) => url.pathname === projectPath), input.signal, 'project redirect')
    const [gateResponse, capabilityResponse] = await bounded(
      Promise.all([initialGateResponse, capabilitiesResponse]), input.signal, 'initial phase gate reads',
    )
    assert.equal(gateResponse.status(), 200)
    assert.equal(capabilityResponse.status(), 200)
    const gateReadUrl = new URL(gateResponse.url())
    assert.deepEqual([...gateReadUrl.searchParams.entries()], [['limit', String(HISTORY_LIMIT)]],
      'the editor must read exactly the last twenty evaluations')
    const envelope = await gateResponse.json()
    const browserGates = envelope.data?.gates ?? []
    const latest = [...browserGates]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    assert.ok(latest, 'the project must have a persisted synthetic phase gate')
    assertGate(latest, input)
    const canonical = history.canonicalGates
    assert.deepEqual(browserGates.map(({ id }) => id), canonical.map(({ id }) => id),
      'the editor session and the journey actor must read the same canonical list')
    assert.deepEqual(browserGates.map(({ recordHash }) => recordHash), canonical.map(({ recordHash }) => recordHash))
    assert.equal(latest.id, canonical[0].id, 'the newest evaluation is the first of the server order')
    const olderGate = canonical.find(({ id }) => id === history.olderGateId)
    const newestCoverage = summarizeSyntheticPhaseGateCoverage(canonical[0].report).covered
    const sameCoverageGate = canonical.find((gate) =>
      gate.id !== canonical[0].id && gate.id !== history.olderGateId &&
      summarizeSyntheticPhaseGateCoverage(gate.report).covered === newestCoverage)
    assert.ok(sameCoverageGate, 'a second evaluation with the newest coverage must exist')

    await bounded(panel.waitFor({ state: 'visible' }), input.signal, 'phase gate panel')
    await assert.rejects(
      page.getByRole('status', { name: 'Lendo avaliação persistida…' }).waitFor({ state: 'visible', timeout: 250 }),
    )
    assert.equal(
      (await page.getByTestId('synthetic-phase-gate-summary').innerText()).trim(),
      `${input.expected.criteriaPassed}/${input.expected.criteriaTotal} critérios · ${input.expected.checksPassed}/${input.expected.checksTotal} checks com evidência`,
    )
    assert.equal(await panel.locator('[data-gate-verdict]').getAttribute('data-gate-verdict'), 'incomplete')
    const identityText = await page.getByTestId('synthetic-phase-gate-identity').innerText()
    assert.match(identityText, /Avaliado em/)
    assert.match(identityText, /Retrato imutável/)
    assert.match(identityText, new RegExp(latest.projectVersionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    assert.equal(await panel.locator('[data-criterion]').count(), input.expected.criteriaTotal)
    for (const code of input.expected.missingLiveChecks) {
      const check = panel.locator(`[data-check-code="${code}"]`)
      assert.equal(await check.getAttribute('data-check-status'), 'missing')
      assert.equal(await check.locator('a').count(), 0, `${code} must not link absent proof`)
    }
    for (const link of await panel.locator('a').all()) {
      const href = await link.getAttribute('href')
      assert.ok(href?.startsWith('/v1/'), `gate reference must use a published local API address: ${href}`)
    }

    await step('W25 real: editor history options equal the canonical API list in received order', async () => {
      const state = await waitForPanel((current) =>
        current.selectedGateId === canonical[0].id && current.options.length === canonical.length && !current.loading,
      'initial history')
      await assertOptions(state, canonical, 'initial history')
      await assertShowsGate(state, canonical[0], canonical, 'initial newest gate')
      assert.equal(state.select.disabled, false, 'the history select is usable once loaded')
      assert.equal(state.runButton?.text, TEXT.run)
      assert.equal(state.runButton?.disabled, false)
      evidence.real.canonical = {
        mode: 'real',
        browserReadUrl: `${gateReadUrl.pathname}${gateReadUrl.search}`,
        gateIds: canonical.map(({ id }) => id),
        options: state.options.map(({ gateId, text, state: verdict }) => ({ gateId, text, verdict })),
        selectedGateId: state.selectedGateId,
      }
      await capturePanel(join(evidenceRoot, 'synthetic-phase-gate-history.png'), 'real: history closed, newest selected')
      // A native <select> popup is not part of a headless page screenshot, so
      // the options are rendered in place (size attribute) for this capture
      // only and restored before anything else is asserted.
      // Focus keeps the selected row painted with the active highlight; an
      // unfocused listbox paints it with a colour the panel text can vanish into.
      await bounded(historySelect.evaluate((node, size) => {
        node.setAttribute('size', String(size))
        node.focus({ preventScroll: true })
      }, state.options.length + 1), input.signal, 'options capture layout')
      try {
        await capturePanel(join(evidenceRoot, 'synthetic-phase-gate-history-options.png'), 'real: history options expanded for capture')
      } finally {
        await bounded(historySelect.evaluate((node) => {
          node.removeAttribute('size')
          node.blur()
        }), input.signal, 'options capture restore')
      }
    })

    await step('W25 real: selecting older evaluations swaps every field with zero requests', async () => {
      const before = await bounded(readPanel(), input.signal, 'newest state')
      const sameCoverage = await selectWithoutRequests(sameCoverageGate.id, 'select same-coverage evaluation')
      await assertShowsGate(sameCoverage.state, sameCoverageGate, canonical, 'same-coverage evaluation')
      assert.notEqual(sameCoverage.state.identity.text, before.identity.text, 'a new record must change the identity')

      const older = await selectWithoutRequests(olderGate.id, 'select pre-render evaluation')
      await assertShowsGate(older.state, olderGate, canonical, 'pre-render evaluation')
      const olderView = comparableView(older.state)
      const newestView = comparableView(before)
      for (const field of ['summary', 'statuses', 'references', 'identity']) {
        assert.notDeepEqual(olderView[field], newestView[field], `the pre-render evaluation must differ in ${field}`)
      }
      evidence.real.selections = [
        { mode: 'real', gateId: sameCoverageGate.id, requests: sameCoverage.requests, windowMs: sameCoverage.windowMs, editorReads: sameCoverage.readsAfter, label: sameCoverage.state.historical },
        { mode: 'real', gateId: olderGate.id, requests: older.requests, windowMs: older.windowMs, editorReads: older.readsAfter, label: older.state.historical, summary: older.state.summary },
      ]
      await capturePanel(join(evidenceRoot, 'synthetic-phase-gate-historical.png'), 'real: pre-render evaluation selected (historical)')
    })

    await step('W25 real: reload selects the newest evaluation again', async () => {
      const read = await reloadWithGateRead('real reload')
      assert.equal(read.status(), 200)
      const state = await waitForPanel((current) =>
        current.options.length === canonical.length && current.selectedGateId !== '' && !current.loading,
      'reloaded history')
      await assertOptions(state, canonical, 'reloaded history')
      await assertShowsGate(state, canonical[0], canonical, 'reloaded newest gate')
      evidence.real.reload = { mode: 'real', selectedGateId: state.selectedGateId }
    })

    await step('W26 real: the gate link opens its persisted transformation critic report', async () => {
      const rejectedReportReference = canonical[0].report.evidence
        .flatMap((criterion) => criterion.checks)
        .flatMap((check) => check.references)
        .find((reference) => reference.type === 'transformation-critic-report')
      assert.ok(rejectedReportReference, 'the persisted gate must identify its rejected transformation report')
      const reportPath = `/v1/projects/${encodeURIComponent(input.projectId)}/transformation-critic-reports/${encodeURIComponent(rejectedReportReference.id)}`
      const reportLink = panel.locator(`a[href="${reportPath}"]`)
      assert.equal(await reportLink.count(), 1, 'the rejected report must have one exact public read link')
      const reportResponse = trackWait(page.waitForResponse((response) =>
        response.request().method() === 'GET' && new URL(response.url()).pathname === reportPath))
      await bounded(reportLink.click(), input.signal, 'open rejected transformation report')
      const openedReportResponse = await bounded(reportResponse, input.signal, 'rejected report response')
      assert.equal(openedReportResponse.status(), 200)
      const openedReport = (await openedReportResponse.json()).data.report
      assert.equal(openedReport.id, rejectedReportReference.id)
      assert.equal(openedReport.reportHash, rejectedReportReference.hash)
      assert.equal(openedReport.projectId, input.projectId)
      assert.equal(openedReport.decision, 'rejected')
      // Kept for the Wave 27 viewer proof, which compares the rendered report
      // with this same persisted record.
      w26CriticRead = Object.freeze({ gateId: canonical[0].id, reference: rejectedReportReference, reportPath, report: openedReport })

      const consumerReference = canonical[0].report.evidence
        .flatMap((criterion) => criterion.checks)
        .flatMap((check) => check.references)
        .find((reference) => reference.type === 'project' && reference.id !== input.projectId)
      assert.ok(consumerReference, 'the reuse gate must identify a different existing project')
      const otherProjectPath = `/v1/projects/${encodeURIComponent(consumerReference.id)}/transformation-critic-reports/${encodeURIComponent(rejectedReportReference.id)}`
      const [otherProjectResponse, unsupportedQueryResponse, anonymousResponse] = await bounded(Promise.all([
        context.request.get(`${origin.origin}${otherProjectPath}`),
        context.request.get(`${origin.origin}${reportPath}?unexpected=1`),
        fetch(`${origin.origin}${reportPath}`, { signal: input.signal }),
      ]), input.signal, 'rejected report access boundaries')
      const otherProjectError = await otherProjectResponse.json()
      const unsupportedQueryError = await unsupportedQueryResponse.json()
      assert.equal(otherProjectResponse.status(), 422, 'a report cannot be read through a different project')
      assert.equal(otherProjectError.error?.code, 'ASSET_NOT_FOUND')
      assert.equal(unsupportedQueryResponse.status(), 422, 'unsupported query parameters must be rejected')
      assert.equal(unsupportedQueryError.error?.code, 'INVALID_ARGUMENT')
      assert.equal(anonymousResponse.status, 401, 'a report must require authentication')
      const anonymousError = await anonymousResponse.json()
      assert.equal(anonymousError.error?.code, 'AUTH_INVALID')
      await writeFile(join(evidenceRoot, 'transformation-critic-read.json'), `${JSON.stringify({
        gateId: canonical[0].id,
        reference: rejectedReportReference,
        href: reportPath,
        report: openedReport,
        http: {
          authenticated: { status: openedReportResponse.status() },
          otherProject: { status: otherProjectResponse.status(), code: otherProjectError.error.code },
          unsupportedQuery: { status: unsupportedQueryResponse.status(), code: unsupportedQueryError.error.code },
          anonymous: { status: anonymousResponse.status, code: anonymousError.error.code },
        },
      }, null, 2)}\n`, 'utf8')
      await bounded(page.goBack(), input.signal, 'return to persisted gate')
      await bounded(panel.waitFor({ state: 'visible' }), input.signal, 'phase gate after report navigation')
      const returned = await waitForPanel((current) =>
        current.selectedGateId === canonical[0].id && current.options.length === canonical.length && !current.loading,
      'history after report navigation')
      await assertOptions(returned, canonical, 'history after report navigation')
      await assertShowsGate(returned, canonical[0], canonical, 'gate after report navigation')
    })

    let editorEvaluation
    await step('W25 real: re-evaluation with an older gate selected posts the editor version', async () => {
      await selectWithoutRequests(olderGate.id, 'select pre-render evaluation before run')
      let markPostHeld
      const postHeld = new Promise((resolveHeld) => { markPostHeld = resolveHeld })
      const postRelease = new Promise((resolveRelease) => { releaseHeldPost = resolveRelease })
      const heldPosts = []
      const holdRealPost = async (route) => {
        const request = route.request()
        if (request.method() !== 'POST' || new URL(request.url()).pathname !== gatePath) {
          await route.continue()
          return
        }
        heldPosts.push({
          body: request.postDataJSON(),
          idempotencyKey: request.headers()['idempotency-key'] ?? null,
        })
        markPostHeld()
        await postRelease
        await route.continue()
      }
      await page.route('**/*', holdRealPost)
      try {
        const postResponse = trackWait(page.waitForResponse((response) =>
          response.request().method() === 'POST' && new URL(response.url()).pathname === gatePath))
        const loadingState = trackWait(runButton.getByText(TEXT.running).waitFor({ state: 'visible' }))
        await bounded(runButton.click(), input.signal, 'run phase gate')
        await within(postHeld, 20_000, 'phase gate POST dispatch')
        await bounded(loadingState, input.signal, 'phase gate loading state')
        assert.equal(await runButton.isDisabled(), true, 'a pending evaluation must not dispatch twice')
        assert.equal(await historySelect.isDisabled(), true, 'the history cannot change while evaluating')
        assert.equal(heldPosts.length, 1)
        assert.deepEqual(heldPosts[0].body, {
          projectVersionId: history.currentVersion.id,
          projectVersionHash: history.currentVersion.hash,
        }, 'the editor must evaluate its current version, never the selected gate')
        assert.match(heldPosts[0].idempotencyKey ?? '', /^synthetic-phase-gate-ui-[0-9a-f-]{36}$/)
        const reloadAfterPost = trackWait(page.waitForResponse((response) => isGateRead(response)))
        releaseHeldPost()
        releaseHeldPost = undefined
        const evaluatedResponse = await bounded(postResponse, input.signal, 'phase gate POST')
        assert.ok([200, 201].includes(evaluatedResponse.status()))
        const evaluatedEnvelope = await evaluatedResponse.json()
        const evaluated = evaluatedEnvelope.data?.gate
        assertGate(evaluated, input)
        assert.equal(evaluatedEnvelope.data.replayed, false)
        assert.equal(evaluated.projectVersionId, history.currentVersion.id)
        assert.equal(evaluated.projectVersionHash, history.currentVersion.hash)
        assert.equal(canonical.some(({ id }) => id === evaluated.id), false, 'the editor evaluation is a new record')
        const reloaded = await bounded(reloadAfterPost, input.signal, 'canonical reload after evaluation')
        assert.equal(reloaded.status(), 200)
        const expectedAfter = await history.readCanonicalGates()
        assert.equal(expectedAfter[0].id, evaluated.id)
        assert.equal(expectedAfter.length, canonical.length + 1)
        assert.ok(expectedAfter.length <= HISTORY_LIMIT)
        const state = await waitForPanel((current) =>
          current.selectedGateId === evaluated.id &&
          current.options.length === expectedAfter.length &&
          !current.loading && current.runButton?.text === TEXT.run,
        'history after evaluation')
        await assertOptions(state, expectedAfter, 'history after evaluation')
        await assertShowsGate(state, evaluated, expectedAfter, 'editor evaluation')
        assert.equal(state.runButton.disabled, false)
        editorEvaluation = Object.freeze({
          gate: evaluated,
          idempotencyKey: heldPosts[0].idempotencyKey,
          canonicalAfter: expectedAfter,
        })
        evidence.real.editorEvaluation = {
          mode: 'real',
          selectedBeforeRun: olderGate.id,
          postBody: heldPosts[0].body,
          idempotencyKey: heldPosts[0].idempotencyKey,
          gateId: evaluated.id,
          optionsBefore: canonical.length,
          optionsAfter: state.options.length,
          selectedAfter: state.selectedGateId,
        }
      } finally {
        await page.unroute('**/*', holdRealPost)
      }
      await capturePanel(screenshotPath, 'real: editor evaluation selected')
      const globalAlerts = page.getByRole('alert')
      const [globalAlertCount, globalAlertDescriptors, panelAlertCount] = await bounded(Promise.all([
        globalAlerts.count(),
        globalAlerts.evaluateAll((nodes) => nodes.map((node) => ({
          id: node.id || null,
          tag: node.tagName.toLowerCase(),
          text: (node.textContent ?? '').trim().slice(0, 300),
        }))),
        panel.getByRole('alert').count(),
      ]), input.signal, 'phase gate alert diagnostics')
      const boundedGlobalAlertDiagnostic = JSON.stringify(globalAlertDescriptors).slice(0, 1_000)
      assert.equal(
        panelAlertCount,
        0,
        `phase gate panel retained an alert; globalAlerts=${globalAlertCount} descriptors=${boundedGlobalAlertDiagnostic}`,
      )
    })
    const gateText = await panel.innerText()
    const realHistory = editorEvaluation.canonicalAfter

    // ---- Controlled transport cases (page.route on this same session) -----
    await step('W25 controlled transport (ordenação da UI): identical createdAt keeps the received order', async () => {
      const tieAt = new Date(Date.parse(realHistory[0].createdAt) + 60_000).toISOString()
      const tieA = controlledGate(realHistory[0], { id: `${CONTROLLED_PREFIX}tie-a`, createdAt: tieAt })
      const tieB = controlledGate(realHistory[0], { id: `${CONTROLLED_PREFIX}tie-b`, createdAt: tieAt })
      const orders = []
      for (const ties of [[tieA, tieB], [tieB, tieA]]) {
        let answered = null
        await controlledRoute(async (route) => {
          if (route.request().method() !== 'GET') {
            await route.fallback()
            return
          }
          await fulfillGateList(route, (gates) => {
            answered = [...ties, ...gates]
            return answered
          })
        }, async () => {
          await reloadWithGateRead('ordering')
          const state = await waitForPanel((current) =>
            current.selectedGateId === ties[0].id && current.options.length === realHistory.length + 2 && !current.loading,
          'ordering')
          assert.deepEqual(state.options.map(({ gateId }) => gateId), answered.map(({ id }) => id),
            'the UI must keep the transport order for identical createdAt')
          await assertShowsGate(state, ties[0], answered, 'ordering newest')
          orders.push(state.options.slice(0, 2).map(({ gateId }) => gateId))
        })
      }
      evidence.controlled.push({
        mode: 'controlled-transport',
        title: 'ordenação da UI: identical createdAt answered in both orders',
        createdAt: tieAt,
        renderedOrders: orders,
        note: 'proves the UI does not re-sort; it says nothing about PostgreSQL ordering',
      })
    })

    await step('W25 controlled transport: a 25-gate answer renders exactly 20 options', async () => {
      const base = Date.parse(realHistory[0].createdAt)
      const overflow = Array.from({ length: 25 }, (_, index) => controlledGate(realHistory[0], {
        id: `${CONTROLLED_PREFIX}overflow-${String(index + 1).padStart(2, '0')}`,
        createdAt: new Date(base + (25 - index) * 1_000).toISOString(),
      }))
      await controlledRoute(async (route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback()
          return
        }
        await fulfillGateList(route, () => overflow)
      }, async () => {
        await reloadWithGateRead('overflow')
        const state = await waitForPanel((current) =>
          current.selectedGateId === overflow[0].id && current.options.length > 0 && !current.loading,
        'overflow')
        assert.equal(state.options.length, HISTORY_LIMIT)
        await assertOptions(state, overflow, 'overflow')
        await assertShowsGate(state, overflow[0], overflow.slice(0, HISTORY_LIMIT), 'overflow newest')
        evidence.controlled.push({
          mode: 'controlled-transport',
          title: '25 gates answered, 20 rendered',
          answered: overflow.length,
          rendered: state.options.length,
          first: state.options[0].gateId,
          last: state.options.at(-1).gateId,
        })
      })
    })

    await step('W25 controlled transport: divergent version shows stale and the run posts the editor version after a timeout', async () => {
      const divergent = controlledGate(realHistory[0], {
        id: `${CONTROLLED_PREFIX}divergent-version`,
        projectVersionId: `${CONTROLLED_PREFIX}other-version`,
        projectVersionHash: sha256Hex(`${CONTROLLED_PREFIX}other-version`),
      })
      const prepended = []
      const posts = []
      const successGates = []
      let markFirstPost
      const firstPost = new Promise((resolveFirst) => { markFirstPost = resolveFirst })
      const firstPostRelease = new Promise((resolveRelease) => { releaseTimeoutPost = resolveRelease })
      const answeredResolvers = []
      const postsAnswered = [0, 1].map(() => new Promise((resolveAnswered) => { answeredResolvers.push(resolveAnswered) }))
      await controlledRoute(async (route) => {
        const request = route.request()
        if (request.method() === 'GET') {
          await fulfillGateList(route, (gates) => [...prepended, divergent, ...gates])
          return
        }
        if (request.method() !== 'POST') {
          await route.fallback()
          return
        }
        posts.push({
          body: request.postDataJSON(),
          idempotencyKey: request.headers()['idempotency-key'] ?? null,
          at: new Date().toISOString(),
        })
        if (posts.length === 1) {
          markFirstPost()
          // Never answered: the editor's own 10 s timeout makes the result uncertain.
          await firstPostRelease
          await route.abort('timedout').catch(() => undefined)
          return
        }
        const successGate = controlledGate(realHistory[0], {
          id: `${CONTROLLED_PREFIX}${posts.length === 2 ? 'timeout-retry' : 'after-success'}`,
          createdAt: new Date(Date.now() + posts.length).toISOString(),
        })
        successGates.push(successGate)
        prepended.unshift(successGate)
        answeredResolvers[posts.length - 2]?.()
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          headers: { 'cache-control': 'no-store' },
          body: JSON.stringify({ data: { gate: successGate, replayed: false }, meta: { apiVersion: 'v1' } }),
        })
      }, async () => {
        await reloadWithGateRead('divergent')
        const divergentList = [divergent, ...realHistory]
        const divergentState = await waitForPanel((current) =>
          current.selectedGateId === divergent.id && current.options.length === divergentList.length && !current.loading,
        'divergent newest')
        await assertOptions(divergentState, divergentList, 'divergent list')
        await assertShowsGate(divergentState, divergent, divergentList, 'divergent newest')
        await capturePanel(join(evidenceRoot, 'synthetic-phase-gate-controlled-divergent.png'), 'controlled transport: divergent version selected')
        const sameVersion = await selectWithoutRequests(realHistory[0].id, 'controlled: select same-version gate below a divergent one')
        await assertShowsGate(sameVersion.state, realHistory[0], divergentList, 'same version below divergent')
        await selectWithoutRequests(divergent.id, 'controlled: select divergent gate before run')

        await bounded(runButton.click(), input.signal, 'controlled run with divergent gate selected')
        await within(firstPost, 20_000, 'controlled first POST')
        const timedOut = await waitForPanel((current) =>
          current.alerts.some((alert) => alert.includes(TEXT.timeout)) && current.runButton?.disabled === false,
        'controlled POST timeout', 25_000)
        assert.equal(timedOut.selectedGateId, divergent.id, 'an uncertain result keeps the selection')
        releaseTimeoutPost()
        releaseTimeoutPost = undefined

        await bounded(runButton.click(), input.signal, 'controlled retry after timeout')
        await within(postsAnswered[0], 20_000, 'controlled retry POST')
        const [retryGate] = successGates
        const retried = await waitForPanel((current) =>
          current.selectedGateId === retryGate.id && current.options[0]?.gateId === retryGate.id &&
          !current.loading && current.runButton?.disabled === false,
        'controlled retry success')
        assert.equal(posts.length, 2)
        assert.ok(posts[0].idempotencyKey, 'the uncertain POST carried an idempotency key')
        assert.equal(posts[1].idempotencyKey, posts[0].idempotencyKey, 'the retry must reuse the same idempotency-key')
        await assertShowsGate(retried, retryGate, [retryGate, divergent, ...realHistory], 'controlled retry result')

        // Same page lifetime and same editor identity: only the confirmed
        // success can explain a new key on the next intention.
        await bounded(runButton.click(), input.signal, 'controlled run after confirmed success')
        await within(postsAnswered[1], 20_000, 'controlled POST after success')
        const nextGate = successGates[1]
        const afterSuccess = await waitForPanel((current) =>
          current.selectedGateId === nextGate.id && current.options[0]?.gateId === nextGate.id && !current.loading,
        'controlled run after success')
        assert.equal(posts.length, 3)
        assert.ok(posts[2].idempotencyKey)
        assert.notEqual(posts[2].idempotencyKey, posts[0].idempotencyKey, 'a confirmed success must reset the idempotency key')
        for (const post of posts) {
          assert.deepEqual(post.body, {
            projectVersionId: history.currentVersion.id,
            projectVersionHash: history.currentVersion.hash,
          }, 'the run must post the editor version, never the selected divergent gate')
          assert.notEqual(post.body.projectVersionId, divergent.projectVersionId)
        }
        await assertShowsGate(afterSuccess, nextGate, [nextGate, retryGate, divergent, ...realHistory], 'controlled next result')
        evidence.controlled.push({
          mode: 'controlled-transport',
          title: 'divergent version/hash (not an E2E of a real version change), POST timeout retry and key reset',
          divergentGateId: divergent.id,
          staleLabel: divergentState.stale,
          historicalWithDivergentSelected: divergentState.historical,
          sameVersionBelowDivergentLabel: sameVersion.state.historical,
          posts,
          sameIdempotencyKeyOnRetry: posts[1].idempotencyKey === posts[0].idempotencyKey,
          newIdempotencyKeyAfterSuccess: posts[2].idempotencyKey !== posts[0].idempotencyKey,
          selectedAfterRetry: retried.selectedGateId,
          selectedAfterNextRun: afterSuccess.selectedGateId,
        })
      })
    })

    await step('W25 controlled transport: A→B→A switch with a delayed B answer never shows B data under A', async () => {
      const second = history.secondProject
      const secondGatePath = `/v1/projects/${encodeURIComponent(second.id)}/synthetic-phase-gates`
      const sentinel = controlledGate(realHistory[0], {
        id: `${CONTROLLED_PREFIX}project-b-sentinel`,
        projectId: second.id,
        projectVersionId: second.versionId,
        ...(second.versionHash ? { projectVersionHash: second.versionHash } : {}),
      })
      let heldRoute = null
      let markHeld
      const held = new Promise((resolveHeld) => { markHeld = resolveHeld })
      let heldRequestFailure = null
      const onRequestFailed = (request) => {
        if (new URL(request.url()).pathname === secondGatePath) heldRequestFailure = request.failure()?.errorText ?? 'failed'
      }
      page.on('requestfailed', onRequestFailed)
      const matcher = (url) => url.pathname === secondGatePath
      const holdSecond = async (route) => {
        if (route.request().method() !== 'GET' || heldRoute) {
          await route.fallback()
          return
        }
        heldRoute = route
        markHeld()
      }
      await page.route(matcher, holdSecond)
      let delivery = 'not-attempted'
      try {
        const cardFor = (name) => page.locator('article')
          .filter({ has: page.getByRole('heading', { name, exact: true }) })
        await bounded(page.getByRole('button', { name: 'Voltar aos projetos' }).click(), input.signal, 'A to dashboard')
        await bounded(page.waitForURL((url) => url.pathname === '/'), input.signal, 'dashboard')
        await bounded(cardFor(second.name).getByRole('button', { name: 'Abrir', exact: true }).click(), input.signal, 'open B')
        await bounded(page.waitForURL((url) => url.pathname === `/projects/${encodeURIComponent(second.id)}`), input.signal, 'B editor')
        await within(held, 20_000, 'B gate read held')
        await bounded(page.getByRole('button', { name: 'Voltar aos projetos' }).click(), input.signal, 'B to dashboard')
        await bounded(page.waitForURL((url) => url.pathname === '/'), input.signal, 'dashboard again')
        const aRead = trackWait(page.waitForResponse((response) => isGateRead(response)))
        await bounded(cardFor(history.projectName).getByRole('button', { name: 'Abrir', exact: true }).click(), input.signal, 'open A again')
        await bounded(page.waitForURL((url) => url.pathname === projectPath), input.signal, 'A editor again')
        assert.equal((await bounded(aRead, input.signal, 'A gate read')).status(), 200)
        await waitForPanel((current) =>
          current.selectedGateId === realHistory[0].id && current.options.length === realHistory.length && !current.loading,
        'A after switch')
        try {
          await heldRoute.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'cache-control': 'no-store' },
            body: JSON.stringify({ data: { gates: [sentinel] }, meta: { apiVersion: 'v1' } }),
          })
          delivery = heldRequestFailure ? `fulfilled after the page aborted it (${heldRequestFailure})` : 'delivered after A rendered'
        } catch (error) {
          delivery = `not delivered: ${heldRequestFailure ?? (error instanceof Error ? error.message.slice(0, 200) : String(error))}`
        }
        await bounded(delay(SELECTION_SETTLE_MS), input.signal, 'late B settle')
        const state = await bounded(readPanel(), input.signal, 'A after late B')
        assert.equal(new URL(page.url()).pathname, projectPath)
        await assertOptions(state, realHistory, 'A after late B')
        await assertShowsGate(state, realHistory[0], realHistory, 'A after late B')
        assert.equal(state.html.includes(sentinel.id), false, 'B data rendered under A')
        assert.equal((await page.content()).includes(sentinel.id), false, 'B data reached the A page')
      } finally {
        page.off('requestfailed', onRequestFailed)
        await page.unroute(matcher, holdSecond)
      }
      evidence.controlled.push({
        mode: 'controlled-transport',
        title: 'A→B→A client navigation with the B gate read held until A rendered',
        secondProjectId: second.id,
        lateAnswer: delivery,
        sentinelRendered: false,
      })
    })

    await step('W25 controlled transport: GET 403 and 429 show failure and retry without data', async () => {
      for (const failure of [
        { status: 403, code: 'FORBIDDEN', text: TEXT.forbidden, headers: {} },
        { status: 429, code: 'RATE_LIMITED', text: TEXT.rateLimited, headers: { 'retry-after': '1' } },
      ]) {
        const label = `controlled GET ${failure.status}`
        const failing = async (route) => {
          if (route.request().method() !== 'GET') {
            await route.fallback()
            return
          }
          await route.fulfill({
            status: failure.status,
            contentType: 'application/json',
            headers: failure.headers,
            body: JSON.stringify({ error: { code: failure.code, message: 'controlled refusal', requestId: `${CONTROLLED_PREFIX}${failure.status}` } }),
          })
        }
        let failedState
        await controlledRoute(failing, async () => {
          const read = await reloadWithGateRead(label)
          assert.equal(read.status(), failure.status)
          failedState = await waitForPanel((current) =>
            current.alerts.some((alert) => alert.includes(failure.text)) && !current.loading, label)
        })
        assert.equal(failedState.select, null, `${label}: no history select`)
        assert.equal(failedState.options.length, 0, `${label}: no options`)
        assert.equal(failedState.selectedGateId, '', `${label}: nothing selected`)
        assert.equal(failedState.gatesCount, '0')
        assert.equal(failedState.identity, null, `${label}: no gate identity`)
        assert.ok(failedState.checks.length === CHECK_CODES.length &&
          failedState.checks.every(({ status, references }) => status === 'missing' && references.length === 0),
        `${label}: no previous check data`)
        for (const gate of realHistory) {
          assert.equal(failedState.html.includes(gate.id), false, `${label}: previous gate ${gate.id} still rendered`)
        }
        const retry = panel.getByRole('button', { name: TEXT.retry })
        assert.equal(await retry.isVisible(), true, `${label}: retry control`)
        if (failure.headers['retry-after']) await bounded(delay(1_200), input.signal, `${label} retry-after`)
        const retried = trackWait(page.waitForResponse((response) => isGateRead(response)))
        await bounded(retry.click(), input.signal, `${label} retry`)
        assert.equal((await bounded(retried, input.signal, `${label} retry read`)).status(), 200)
        const recovered = await waitForPanel((current) =>
          current.selectedGateId === realHistory[0].id && current.options.length === realHistory.length &&
          current.alerts.length === 0 && !current.loading,
        `${label} recovered`)
        await assertOptions(recovered, realHistory, `${label} recovered`)
        evidence.controlled.push({
          mode: 'controlled-transport',
          title: `GET ${failure.status} then explicit retry`,
          failureText: failure.text,
          optionsWhileFailed: failedState.options.length,
          recoveredSelectedGateId: recovered.selectedGateId,
        })
      }
    })

    await step('W25 controlled transport: GET 401 redirects to login', async () => {
      const unauthorized = async (route) => {
        if (route.request().method() !== 'GET') {
          await route.fallback()
          return
        }
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'controlled refusal', requestId: `${CONTROLLED_PREFIX}401` } }),
        })
      }
      await controlledRoute(unauthorized, async () => {
        const login = trackWait(page.waitForURL((url) => url.pathname === '/login'))
        const read = await reloadWithGateRead('controlled GET 401')
        assert.equal(read.status(), 401)
        await bounded(login, input.signal, 'login redirect after 401')
      })
      evidence.controlled.push({ mode: 'controlled-transport', title: 'GET 401 redirects to /login', redirectedTo: '/login' })
    })

    await writeFile(join(evidenceRoot, 'synthetic-phase-gate-history-browser.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    w25EvidenceWritten = true

    // ---- Wave 27: inline viewer of the critic report referenced by the gate --
    // The W25 401 above was a controlled answer, so the server session is
    // intact: the editor is opened again with a GET navigation. From here on
    // the ledger must not see a single POST, and the persisted critic reports
    // and gates must stay exactly as this block found them.
    criticBlockStarted = true
    assert.ok(w26CriticRead, 'the W26 proof must have read the rejected transformation report')
    const criticLedgerStart = ledger.length
    const criticRecord = await bounded(criticViewer.readReport(w26CriticRead.reference.id), input.signal, 'W27 journey actor report read')
    assert.deepEqual(criticRecord, w26CriticRead.report, 'the journey actor and the W26 browser session must read the same persisted record')
    assert.equal(criticRecord.projectId, input.projectId)
    assert.equal(criticRecord.decision, 'rejected', 'the gate references the rejected transformation report')
    const criticPath = criticReportPath(input.projectId, criticRecord.id)
    assert.equal(criticPath, w26CriticRead.reportPath, 'the canonical address is the one the W26 link opened')
    const countsBefore = Object.freeze(await bounded(criticViewer.readPersistedCounts(), input.signal, 'W27 persisted counts before'))
    const criticGates = await bounded(history.readCanonicalGates(), input.signal, 'W27 canonical history')
    assert.deepEqual(criticGates.map(({ id }) => id), realHistory.map(({ id }) => id),
      'W27 starts from the real history the W25 steps left behind')
    const criticNewest = criticGates[0]
    const criticOlder = criticGates.find(({ id }) => id === history.olderGateId)
    assert.ok(criticOlder, 'the older evaluation is still listed')
    for (const gate of [criticNewest, criticOlder]) {
      assert.deepEqual(criticReferencesOf(gate).map(({ id, hash }) => ({ id, hash })), [{ id: criticRecord.id, hash: criticRecord.reportHash }],
        `gate ${gate.id} must reference exactly the persisted rejected report`)
    }
    criticEvidence.record = {
      mode: 'real',
      source: 'GET /v1/projects/{projectId}/transformation-critic-reports/{reportId} as the journey API client (bearer); deep-equal to the W26 browser read',
      id: criticRecord.id,
      reportHash: criticRecord.reportHash,
      projectId: criticRecord.projectId,
      decision: criticRecord.decision,
      action: criticRecord.action,
      href: criticPath,
      w26Evidence: 'transformation-critic-read.json',
    }

    const readCriticView = () => bounded(page.evaluate(readCriticViewerInPage), input.signal, 'critic viewer read')
    const waitForCriticView = async (predicate, label, timeoutMs = 20_000) => {
      const deadline = Date.now() + timeoutMs
      let last = null
      while (Date.now() < deadline) {
        last = await readCriticView()
        if (predicate(last)) return last
        await bounded(delay(50), input.signal, label)
      }
      const lastState = last ? { ...last, viewer: last.viewer ? { ...last.viewer, text: last.viewer.text?.slice(0, 600) } : null } : null
      throw new Error(`${label}: the critic viewer did not reach the expected state; last=${JSON.stringify(lastState).slice(0, 3_000)}`)
    }
    const requestsSince = (mark) => ledger.slice(mark).map(({ at, method, url, resourceType }) => {
      const parsed = new URL(url)
      return { at, method, path: `${parsed.pathname}${parsed.search}`, resourceType }
    })
    const reportReads = (requests) => requests.filter(({ method, path }) => method === 'GET' && path === criticPath)
    const postsIn = (requests) => requests.filter(({ method }) => method === 'POST')
    const ledgerSummary = (requests) => ({
      total: requests.length,
      postCount: postsIn(requests).length,
      reportReads: reportReads(requests).length,
      api: requests.filter(({ path }) => path.startsWith('/v1/')),
    })
    const counterDelta = (before, after) => {
      const zero = { issued: 0, deduplicated: 0, dropped: 0 }
      const delta = {}
      for (const name of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
        const from = before?.[name] ?? zero
        const to = after?.[name] ?? zero
        const change = {
          issued: to.issued - from.issued,
          deduplicated: to.deduplicated - from.deduplicated,
          dropped: to.dropped - from.dropped,
        }
        if (change.issued || change.deduplicated || change.dropped) delta[name] = change
      }
      return delta
    }
    const oneCriticRead = Object.freeze({ [CRITIC_READ_NAME]: Object.freeze({ issued: 1, deduplicated: 0, dropped: 0 }) })
    const criticOpen = page.getByTestId(CRITIC_OPEN_CONTROL)
    const criticClose = page.getByTestId('transformation-critic-report-close')
    const criticRetry = page.getByTestId('transformation-critic-report-retry')
    const criticViewerNode = page.getByTestId('transformation-critic-report-viewer')
    const evaluatedAtText = async (iso) => collapse(await page.evaluate((value) =>
      new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)), iso))
    const captureCriticViewer = async (path, label) => {
      await bounded(criticViewerNode.evaluate((node) => node.scrollIntoView({
        block: 'start',
        inline: 'nearest',
        behavior: 'instant',
      })), input.signal, `${label} scroll`)
      await bounded(criticViewerNode.screenshot({ path }), input.signal, `${label} screenshot`)
      criticEvidence.screenshots.push({ file: path, label })
      return path
    }
    // The one critic item of the visible gate, as the record says it must be.
    const assertCriticItem = (view, gate, expected, label) => {
      assert.equal(view.selectedGateId, gate.id, `${label}: visible gate`)
      assert.deepEqual(
        view.references.map(({ checkCode, referenceId, referenceHash }) => ({ checkCode, id: referenceId, hash: referenceHash })),
        criticReferencesOf(gate),
        `${label}: one critic item per critic reference of the visible gate`,
      )
      const [item] = view.references
      assert.deepEqual(item.identity, {
        text: `${CRITIC_REFERENCE_TYPE} ${criticRecord.id} · ${shortHash(criticRecord.reportHash)}`,
        titles: [criticRecord.reportHash],
      }, `${label}: identity text and full hash`)
      assert.deepEqual(item.json, { count: 1, tag: 'a', text: CRITIC_TEXT.json, href: criticPath },
        `${label}: "Abrir JSON" keeps the canonical address`)
      assert.deepEqual(item.open, {
        count: 1,
        tag: 'button',
        type: 'button',
        text: CRITIC_TEXT.open,
        ariaExpanded: expected.ariaExpanded,
        disabled: expected.disabled,
        referenceId: criticRecord.id,
        referenceHash: criticRecord.reportHash,
      }, `${label}: "Ver relatório"`)
      return item
    }
    // An error state: the failure, no report data anywhere, the retry control
    // and the JSON link still in place.
    const assertCriticFailure = (view, expected, label) => {
      assert.equal(view.viewerCount, 1, `${label}: one viewer`)
      const { viewer } = view
      assert.equal(viewer.state, 'error', `${label}: data-state`)
      assert.equal(viewer.referenceId, criticRecord.id, `${label}: data-reference-id`)
      assert.equal(viewer.referenceHash, criticRecord.reportHash, `${label}: data-reference-hash`)
      assert.equal(viewer.reportId, '', `${label}: no data-report-id`)
      assert.equal(viewer.reportHash, '', `${label}: no data-report-hash`)
      assert.equal(viewer.error?.kind, expected.kind, `${label}: data-failure-kind`)
      assert.equal(viewer.error.code, expected.code, `${label}: data-failure-code`)
      assert.equal(viewer.error.message, expected.text, `${label}: failure text`)
      assert.deepEqual({ count: viewer.error.retry.count, tag: viewer.error.retry.tag }, { count: 1, tag: 'button' },
        `${label}: one retry control`)
      assert.equal(viewer.retryCount, 1, `${label}: one retry control in the viewer`)
      assert.equal(viewer.loading, null, `${label}: not loading`)
      assert.equal(view.reportDataAnywhere, 0, `${label}: no report data anywhere`)
      assert.equal(viewer.addresses, 0, `${label}: no address derived from the answer`)
      assert.deepEqual(view.references.map(({ json }) => json),
        [{ count: 1, tag: 'a', text: CRITIC_TEXT.json, href: criticPath }], `${label}: the JSON link stays available`)
    }
    const openCriticViewer = async (label) => {
      await quiesce(label)
      const mark = ledger.length
      const countersBefore = await bounded(editorReadCounters(), input.signal, `${label} counters`)
      const urlBefore = page.url()
      await bounded(criticOpen.click(), input.signal, label)
      const view = await waitForCriticView((current) => current.viewer?.state === 'ready', label)
      await quiesce(`${label} settled`)
      const requests = requestsSince(mark)
      const countersAfter = await bounded(editorReadCounters(), input.signal, `${label} counters`)
      assert.deepEqual(requests.map(({ method, path }) => `${method} ${path}`), [`GET ${criticPath}`],
        `${label}: exactly one GET of the report and nothing else`)
      assert.deepEqual(counterDelta(countersBefore, countersAfter), oneCriticRead, `${label}: one editor read issued`)
      assert.equal(page.url(), urlBefore, `${label}: no navigation`)
      assert.equal(view.viewer.reportId, criticRecord.id, `${label}: data-report-id`)
      assert.equal(view.viewer.reportHash, criticRecord.reportHash, `${label}: data-report-hash`)
      assert.equal(view.references[0]?.open.ariaExpanded, 'true', `${label}: aria-expanded`)
      return Object.freeze({ view, requests, editorReads: counterDelta(countersBefore, countersAfter), urlBefore, urlAfter: page.url() })
    }
    const closeCriticViewer = async (control, label) => {
      await quiesce(label)
      const mark = ledger.length
      await bounded(control.click(), input.signal, label)
      const view = await waitForCriticView((current) => current.viewerCount === 0, label)
      await quiesce(`${label} settled`)
      const requests = requestsSince(mark)
      assert.deepEqual(requests, [], `${label}: closing issues no request`)
      assert.equal(view.reportDataAnywhere, 0, `${label}: no report data left`)
      assert.equal(view.errorsAnywhere, 0, `${label}: no error left`)
      assert.ok(view.references.every(({ open }) => open.ariaExpanded === 'false'), `${label}: aria-expanded back to false`)
      return view
    }
    const criticRoute = async (handler, action) => {
      const matcher = (url) => url.pathname === criticPath
      await page.route(matcher, handler)
      try {
        return await action()
      } finally {
        await page.unroute(matcher, handler)
      }
    }
    const refuseWith = (status, code, headers, answered) => async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback()
        return
      }
      answered.push({ status, code, at: new Date().toISOString() })
      await route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'cache-control': 'no-store', ...headers },
        body: controlledCriticRefusal(code, status),
      })
    }
    const sentinelIssue = (description) => ({
      dimension: criticRecord.issues[0]?.dimension ?? criticRecord.measurements[0].dimension,
      severity: 'minor',
      frameRange: { startFrame: 0, endFrame: 1 },
      region: null,
      description,
    })
    const holdCriticRead = () => {
      let heldRoute = null
      let markHeld
      const held = new Promise((resolveHeld) => { markHeld = resolveHeld })
      const handler = async (route) => {
        if (route.request().method() !== 'GET' || heldRoute) {
          await route.fallback()
          return
        }
        heldRoute = route
        markHeld()
      }
      return {
        handler,
        held,
        release: async (body) => {
          try {
            await heldRoute.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body })
            return 'delivered'
          } catch (error) {
            return `not delivered: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`
          }
        },
      }
    }

    await step('W27 real: the newest gate lists the persisted critic report with "Abrir JSON" and "Ver relatório"', async () => {
      await quiesce('W27 before navigation')
      const read = trackWait(page.waitForResponse((response) => isGateRead(response)))
      await bounded(page.goto(`${origin.origin}${projectPath}`), input.signal, 'W27 editor navigation')
      assert.equal(new URL(page.url()).pathname, projectPath, 'the server session survived the controlled W25 401')
      assert.equal((await bounded(read, input.signal, 'W27 gate read')).status(), 200)
      const state = await waitForPanel((current) =>
        current.selectedGateId === criticNewest.id && current.options.length === criticGates.length && !current.loading,
      'W27 editor history')
      await assertOptions(state, criticGates, 'W27 editor history')
      await assertShowsGate(state, criticNewest, criticGates, 'W27 newest gate')
      const view = await readCriticView()
      assert.equal(view.viewerCount, 0, 'the viewer starts closed')
      assert.equal(view.reportDataAnywhere, 0, 'no report data before opening')
      const item = assertCriticItem(view, criticNewest, { ariaExpanded: 'false', disabled: false }, 'W27 newest gate')
      // W26 is unchanged: one exact public read link, now labelled "Abrir JSON".
      const w26Link = panel.locator(`a[href="${criticPath}"]`)
      assert.equal(await w26Link.count(), 1, 'the rejected report keeps one exact public read link')
      assert.equal(await w26Link.getAttribute('data-testid'), CRITIC_JSON_CONTROL)
      const requests = requestsSince(criticLedgerStart)
      assert.deepEqual(postsIn(requests), [], 'the navigation back to the editor posts nothing')
      criticEvidence.real.reference = {
        mode: 'real',
        gateId: criticNewest.id,
        checkCode: item.checkCode,
        referenceId: item.referenceId,
        referenceHash: item.referenceHash,
        identityText: item.identity.text,
        json: item.json,
        open: item.open,
        navigation: ledgerSummary(requests),
      }
    })

    await step('W27 real: "Ver relatório" opens the viewer with exactly one GET, no POST and no navigation', async () => {
      const opened = await openCriticViewer('W27 open')
      assert.equal(opened.view.viewer.referenceId, criticRecord.id)
      assert.equal(opened.view.viewer.referenceHash, criticRecord.reportHash)
      assert.equal(opened.view.references[0].open.disabled, false, 'the open control is usable once the report is ready')
      criticEvidence.real.open = {
        mode: 'real',
        requests: opened.requests,
        editorReads: opened.editorReads,
        urlBefore: opened.urlBefore,
        urlAfter: opened.urlAfter,
        state: opened.view.viewer.state,
      }
    })

    await step('W27 real: every rendered field equals the persisted record read by the journey actor', async () => {
      const mark = ledger.length
      const view = await readCriticView()
      const compared = assertCriticViewerShowsRecord(view, criticRecord, {
        label: 'W27 real viewer',
        evaluatedAtText: await evaluatedAtText(criticRecord.evaluatedAt),
      })
      await captureCriticViewer(join(evidenceRoot, 'transformation-critic-report-viewer.png'),
        'real: persisted rejected transformation critic report open in the gate panel')
      assert.deepEqual(requestsSince(mark), [], 'reading and capturing the viewer issues nothing')
      criticEvidence.real.fields = {
        mode: 'real',
        comparedWith: 'journey actor API record',
        ...compared,
        decision: view.viewer.decision,
        action: view.viewer.action.value,
        evaluatedAt: view.viewer.evaluatedAt,
        hardGates: view.viewer.hardGates.items.map(({ dimension }) => dimension),
        measurements: view.viewer.measurements.items.map(({ dimension, status, evaluatorId, evaluatorKind }) =>
          ({ dimension, status, evaluatorId, evaluatorKind })),
        issues: view.viewer.issues.items.map(({ dimension, severity, startFrame, endFrame }) =>
          ({ dimension, severity, startFrame, endFrame })),
        scores: view.viewer.scores,
      }
    })

    await step('W27 real: "Fechar" closes; opening again issues a second GET with the same hash; the open button toggles it closed', async () => {
      const closed = await closeCriticViewer(criticClose, 'W27 close')
      assertCriticItem(closed, criticNewest, { ariaExpanded: 'false', disabled: false }, 'W27 after close')
      const reopened = await openCriticViewer('W27 reopen')
      assertCriticViewerShowsRecord(reopened.view, criticRecord, {
        label: 'W27 reopened viewer',
        evaluatedAtText: await evaluatedAtText(criticRecord.evaluatedAt),
      })
      const toggled = await closeCriticViewer(criticOpen, 'W27 toggle closed')
      assertCriticItem(toggled, criticNewest, { ariaExpanded: 'false', disabled: false }, 'W27 after toggle')
      criticEvidence.real.reopen = {
        mode: 'real',
        closedWith: CRITIC_TEXT.close,
        secondRead: reopened.requests,
        secondReadEditorReads: reopened.editorReads,
        reportHash: reopened.view.viewer.reportHash,
        toggledClosedWith: CRITIC_TEXT.open,
      }
    })

    await step('W27 real: choosing another evaluation closes the viewer with zero requests and it does not reopen', async () => {
      await openCriticViewer('W27 open before selection')
      const older = await selectWithoutRequests(criticOlder.id, 'W27 select older evaluation with the viewer open')
      await assertShowsGate(older.state, criticOlder, criticGates, 'W27 older evaluation')
      const underOlder = await readCriticView()
      assert.equal(underOlder.viewerCount, 0, 'selecting another evaluation closes the viewer')
      assert.equal(underOlder.reportDataAnywhere, 0)
      assertCriticItem(underOlder, criticOlder, { ariaExpanded: 'false', disabled: false }, 'W27 older evaluation')
      const newest = await selectWithoutRequests(criticNewest.id, 'W27 select newest evaluation again')
      await assertShowsGate(newest.state, criticNewest, criticGates, 'W27 newest evaluation again')
      const underNewest = await readCriticView()
      assert.equal(underNewest.viewerCount, 0, 'the viewer does not reopen by itself')
      assert.equal(underNewest.reportDataAnywhere, 0)
      assertCriticItem(underNewest, criticNewest, { ariaExpanded: 'false', disabled: false }, 'W27 newest evaluation again')
      criticEvidence.real.selection = [
        { mode: 'real', selectedGateId: criticOlder.id, requests: older.requests, windowMs: older.windowMs, editorReads: older.readsAfter, viewerAfter: 'absent' },
        { mode: 'real', selectedGateId: criticNewest.id, requests: newest.requests, windowMs: newest.windowMs, editorReads: newest.readsAfter, viewerAfter: 'absent' },
      ]
    })

    await step('W27 controlled transport: 403 shows the forbidden state without data; unroute and explicit retry read the real report', async () => {
      await quiesce('W27 403')
      const mark = ledger.length
      const answered = []
      let failed
      await criticRoute(refuseWith(403, CRITIC_FORBIDDEN_CODE, {}, answered), async () => {
        await bounded(criticOpen.click(), input.signal, 'W27 403 open')
        failed = await waitForCriticView((current) => current.viewer?.state === 'error', 'W27 403 error')
      })
      assertCriticFailure(failed, { kind: 'forbidden', code: CRITIC_FORBIDDEN_CODE, text: CRITIC_TEXT.forbidden }, 'W27 403')
      // The route is gone; only the explicit retry may clear the remembered refusal.
      await quiesce('W27 403 retry')
      const retryMark = ledger.length
      await bounded(criticRetry.click(), input.signal, 'W27 403 retry')
      const recovered = await waitForCriticView((current) => current.viewer?.state === 'ready', 'W27 403 recovered')
      await quiesce('W27 403 recovered settled')
      const retryRequests = requestsSince(retryMark)
      assert.deepEqual(retryRequests.map(({ method, path }) => `${method} ${path}`), [`GET ${criticPath}`],
        'the explicit retry issues one real read')
      assert.equal(recovered.viewer.reportId, criticRecord.id)
      assert.equal(recovered.viewer.reportHash, criticRecord.reportHash)
      await closeCriticViewer(criticClose, 'W27 403 close')
      const requests = requestsSince(mark)
      assert.deepEqual(postsIn(requests), [], 'W27 403: zero POST')
      criticEvidence.controlled.push({
        mode: 'controlled-transport',
        title: 'report GET 403, then unroute and explicit retry (real read)',
        answered,
        failure: failed.viewer.error,
        reportIdWhileFailed: failed.viewer.reportId,
        recovery: { mode: 'real', requests: retryRequests, reportHash: recovered.viewer.reportHash },
        ledger: ledgerSummary(requests),
        postCount: 0,
      })
    })

    await step('W27 controlled transport: 429 with Retry-After 2 shows the wait; an immediate retry is refused locally; after the wait a retry reads the real report', async () => {
      await quiesce('W27 429')
      const mark = ledger.length
      const answered = []
      let limitedAt = 0
      let limited
      let immediate
      const limitHandler = refuseWith(429, CRITIC_RATE_LIMIT_CODE, { 'retry-after': '2' }, answered)
      await criticRoute(async (route) => {
        await limitHandler(route)
        limitedAt = Date.now()
      }, async () => {
        await bounded(criticOpen.click(), input.signal, 'W27 429 open')
        limited = await waitForCriticView((current) => current.viewer?.state === 'error', 'W27 429 error')
        assertCriticFailure(limited, { kind: 'rate-limited', code: CRITIC_RATE_LIMIT_CODE, text: criticRateLimitedText(2) }, 'W27 429')
        // Immediate retry, still inside the server's wait.
        const immediateMark = ledger.length
        const countersBefore = await bounded(editorReadCounters(), input.signal, 'W27 429 counters')
        await bounded(page.evaluate(installCriticViewerWatchInPage, []), input.signal, 'W27 429 watch')
        const clickedAt = Date.now()
        await bounded(criticRetry.click(), input.signal, 'W27 429 immediate retry')
        await bounded(delay(QUIET_WINDOW_MS), input.signal, 'W27 429 immediate retry settle')
        const watch = await bounded(page.evaluate(takeCriticViewerWatchInPage), input.signal, 'W27 429 watch read')
        const after = await readCriticView()
        const countersAfter = await bounded(editorReadCounters(), input.signal, 'W27 429 counters')
        const requests = requestsSince(immediateMark)
        const shownSeconds = Number(after.viewer?.error?.message?.match(/pausa de (\d+) s/)?.[1])
        assert.ok(clickedAt - limitedAt < 2_000, 'the immediate retry happened inside the 2 s wait')
        assert.ok([1, 2].includes(shownSeconds), `W27 429 immediate retry shows the remaining wait: ${after.viewer?.error?.message}`)
        assertCriticFailure(after, { kind: 'rate-limited', code: CRITIC_RATE_LIMIT_CODE, text: criticRateLimitedText(shownSeconds) }, 'W27 429 immediate retry')
        assert.deepEqual(reportReads(requests), [], 'the coordinator refuses locally inside the wait: nothing reaches the report URL')
        assert.deepEqual(counterDelta(countersBefore, countersAfter), {}, 'no editor read was issued by the immediate retry')
        immediate = {
          clickedAfterMs: clickedAt - limitedAt,
          requests,
          editorReads: counterDelta(countersBefore, countersAfter),
          statesObserved: watch?.states ?? null,
          shownSeconds,
          text: after.viewer.error.message,
          outcome: 'refused locally by the read coordinator (remaining Retry-After), no request issued',
        }
      })
      // The route is gone: wait out the server's 2 s, then retry for real.
      await bounded(delay(Math.max(0, limitedAt + 2_000 + 400 - Date.now())), input.signal, 'W27 429 wait')
      const retryMark = ledger.length
      await bounded(criticRetry.click(), input.signal, 'W27 429 retry after the wait')
      const recovered = await waitForCriticView((current) => current.viewer?.state === 'ready', 'W27 429 recovered')
      await quiesce('W27 429 recovered settled')
      const retryRequests = requestsSince(retryMark)
      assert.deepEqual(retryRequests.map(({ method, path }) => `${method} ${path}`), [`GET ${criticPath}`],
        'the retry after the wait issues one real read')
      assert.equal(recovered.viewer.reportHash, criticRecord.reportHash)
      await closeCriticViewer(criticClose, 'W27 429 close')
      const requests = requestsSince(mark)
      assert.deepEqual(postsIn(requests), [], 'W27 429: zero POST')
      assert.equal(answered.length, 1, 'only the first read reached the controlled 429 route')
      criticEvidence.controlled.push({
        mode: 'controlled-transport',
        title: 'report GET 429 Retry-After 2: wait text, immediate retry refused locally, real read after the wait',
        answered,
        failure: limited.viewer.error,
        immediateRetry: immediate,
        recovery: { mode: 'real', waitedMs: Date.parse(retryRequests[0].at) - limitedAt, requests: retryRequests, reportHash: recovered.viewer.reportHash },
        ledger: ledgerSummary(requests),
        postCount: 0,
      })
    })

    await step('W27 controlled transport: 422 ASSET_NOT_FOUND shows "not found" without data', async () => {
      await quiesce('W27 422')
      const mark = ledger.length
      const answered = []
      let failed
      await criticRoute(refuseWith(422, 'ASSET_NOT_FOUND', {}, answered), async () => {
        await bounded(criticOpen.click(), input.signal, 'W27 422 open')
        failed = await waitForCriticView((current) => current.viewer?.state === 'error', 'W27 422 error')
        assertCriticFailure(failed, { kind: 'error', code: 'ASSET_NOT_FOUND', text: CRITIC_TEXT.notFound }, 'W27 422')
        await captureCriticViewer(join(evidenceRoot, 'transformation-critic-report-error.png'),
          'controlled transport: report GET answered 422 ASSET_NOT_FOUND')
      })
      await closeCriticViewer(criticClose, 'W27 422 close')
      const requests = requestsSince(mark)
      assert.deepEqual(postsIn(requests), [], 'W27 422: zero POST')
      criticEvidence.controlled.push({
        mode: 'controlled-transport',
        title: 'report GET 422 ASSET_NOT_FOUND envelope',
        answered,
        failure: failed.viewer.error,
        reportIdWhileFailed: failed.viewer.reportId,
        ledger: ledgerSummary(requests),
        postCount: 0,
      })
    })

    await step('W27 controlled transport: an answer for another project, id or hash is refused as an identity divergence with no data', async () => {
      const variants = [
        { field: 'projectId', value: `${W27_CONTROLLED_PREFIX}other-project` },
        { field: 'id', value: `${W27_CONTROLLED_PREFIX}other-report` },
        { field: 'reportHash', value: sha256Hex(`${W27_CONTROLLED_PREFIX}other-report-hash`) },
      ]
      const outcomes = []
      for (const variant of variants) {
        const label = `W27 identity ${variant.field}`
        await quiesce(label)
        const mark = ledger.length
        const answered = []
        let failed
        let watch
        await criticRoute(async (route) => {
          if (route.request().method() !== 'GET') {
            await route.fallback()
            return
          }
          answered.push({ status: 200, divergentField: variant.field, at: new Date().toISOString() })
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'cache-control': 'no-store' },
            body: controlledCriticEnvelope(criticRecord, { [variant.field]: variant.value }),
          })
        }, async () => {
          await bounded(page.evaluate(installCriticViewerWatchInPage, [variant.value]), input.signal, `${label} watch`)
          await bounded(criticOpen.click(), input.signal, `${label} open`)
          failed = await waitForCriticView((current) => current.viewer?.state === 'error', label)
          await bounded(delay(QUIET_WINDOW_MS), input.signal, `${label} settle`)
          watch = await bounded(page.evaluate(takeCriticViewerWatchInPage), input.signal, `${label} watch read`)
        })
        assertCriticFailure(failed, { kind: 'identity', code: '', text: CRITIC_TEXT.identity }, label)
        assert.equal(watch.dataSeen, false, `${label}: no decision, measurement or issue was ever rendered`)
        assert.deepEqual(watch.sentinelsSeen, [], `${label}: the divergent value never reached the page`)
        assert.equal((await page.content()).includes(variant.value), false, `${label}: the divergent value is not in the page`)
        await closeCriticViewer(criticClose, `${label} close`)
        const requests = requestsSince(mark)
        assert.deepEqual(postsIn(requests), [], `${label}: zero POST`)
        outcomes.push({
          divergentField: variant.field,
          divergentValue: variant.value,
          answered,
          failure: failed.viewer.error,
          statesObserved: watch.states,
          dataSeen: watch.dataSeen,
          ledger: ledgerSummary(requests),
          postCount: 0,
        })
      }
      criticEvidence.controlled.push({
        mode: 'controlled-transport',
        title: 'identity divergence: the same record answered with projectId, id or reportHash changed',
        outcomes,
      })
    })

    await step('W27 controlled transport: an answer released after "Fechar" renders nothing', async () => {
      await quiesce('W27 late answer')
      const mark = ledger.length
      const sentinel = `${W27_CONTROLLED_PREFIX}late-answer-after-close`
      const hold = holdCriticRead()
      let delivery = 'not-attempted'
      let watch
      let loading
      let after
      const countersBefore = await bounded(editorReadCounters(), input.signal, 'W27 late answer counters')
      await criticRoute(hold.handler, async () => {
        await bounded(criticOpen.click(), input.signal, 'W27 late answer open')
        await within(hold.held, 20_000, 'W27 report read held')
        loading = await waitForCriticView((current) => current.viewer?.state === 'loading', 'W27 loading while held')
        assert.equal(loading.viewer.loading, CRITIC_TEXT.loading, 'loading line')
        assert.equal(loading.viewer.reportId, '')
        assert.equal(loading.reportDataAnywhere, 0)
        assertCriticItem(loading, criticNewest, { ariaExpanded: 'true', disabled: true }, 'W27 open control while loading')
        await bounded(criticClose.click(), input.signal, 'W27 close while held')
        await waitForCriticView((current) => current.viewerCount === 0, 'W27 closed while held')
        await bounded(page.evaluate(installCriticViewerWatchInPage, [sentinel]), input.signal, 'W27 late answer watch')
        delivery = await hold.release(controlledCriticEnvelope(criticRecord, {
          issues: [...criticRecord.issues, sentinelIssue(sentinel)],
        }))
        await bounded(delay(SELECTION_SETTLE_MS), input.signal, 'W27 late answer settle')
        watch = await bounded(page.evaluate(takeCriticViewerWatchInPage), input.signal, 'W27 late answer watch read')
        after = await readCriticView()
      })
      await quiesce('W27 late answer settled')
      const countersAfter = await bounded(editorReadCounters(), input.signal, 'W27 late answer counters')
      assert.equal(delivery, 'delivered', 'the held answer reached the page after the viewer closed')
      assert.equal(after.viewerCount, 0, 'no viewer after the late answer')
      assert.equal(after.errorsAnywhere, 0, 'no error after the late answer')
      assert.equal(after.reportDataAnywhere, 0, 'no report data after the late answer')
      assert.deepEqual(watch.states, ['absent'], 'the viewer never came back')
      assert.equal(watch.dataSeen, false)
      assert.deepEqual(watch.sentinelsSeen, [], 'the late answer never reached the page text')
      assert.equal((await page.content()).includes(sentinel), false)
      assertCriticItem(after, criticNewest, { ariaExpanded: 'false', disabled: false }, 'W27 after late answer')
      assert.deepEqual(counterDelta(countersBefore, countersAfter), oneCriticRead, 'one held read, nothing else')
      const requests = requestsSince(mark)
      assert.equal(reportReads(requests).length, 1)
      assert.deepEqual(postsIn(requests), [], 'W27 late answer: zero POST')
      criticEvidence.controlled.push({
        mode: 'controlled-transport',
        title: 'report answer held, "Fechar" clicked, then the answer released',
        lateAnswer: delivery,
        sentinel,
        loadingState: { state: loading.viewer.state, text: loading.viewer.loading, openDisabled: loading.references[0].open.disabled },
        statesObservedAfterClose: watch.states,
        dataSeen: watch.dataSeen,
        editorReads: counterDelta(countersBefore, countersAfter),
        ledger: ledgerSummary(requests),
        postCount: 0,
      })
    })

    await step('W27 controlled transport: A→B→A across history entries with B\'s report answer held never shows B data under A', async () => {
      const sentinel = `${W27_CONTROLLED_PREFIX}gate-b-late-answer`
      const mark = ledger.length
      const toB = await selectWithoutRequests(criticOlder.id, 'W27 A→B: select the older evaluation')
      await assertShowsGate(toB.state, criticOlder, criticGates, 'W27 B evaluation')
      const hold = holdCriticRead()
      let delivery = 'not-attempted'
      let loadingUnderB
      let backToA
      let watch
      let after
      await criticRoute(hold.handler, async () => {
        await bounded(criticOpen.click(), input.signal, 'W27 open under B')
        await within(hold.held, 20_000, 'W27 B report read held')
        loadingUnderB = await waitForCriticView((current) => current.viewer?.state === 'loading', 'W27 loading under B')
        assert.equal(loadingUnderB.selectedGateId, criticOlder.id)
        backToA = await selectWithoutRequests(criticNewest.id, 'W27 B→A: select the newest evaluation while B is held')
        await assertShowsGate(backToA.state, criticNewest, criticGates, 'W27 A while B is held')
        const underA = await readCriticView()
        assert.equal(underA.viewerCount, 0, 'the change of gate unmounted the viewer')
        await bounded(page.evaluate(installCriticViewerWatchInPage, [sentinel]), input.signal, 'W27 A→B→A watch')
        delivery = await hold.release(controlledCriticEnvelope(criticRecord, {
          issues: [...criticRecord.issues, sentinelIssue(sentinel)],
        }))
        await bounded(delay(SELECTION_SETTLE_MS), input.signal, 'W27 late B settle')
        watch = await bounded(page.evaluate(takeCriticViewerWatchInPage), input.signal, 'W27 A→B→A watch read')
        after = await readCriticView()
      })
      assert.equal(delivery, 'delivered', 'the held B answer reached the page after A was selected')
      assert.equal(after.viewerCount, 0, 'no viewer under A after the late B answer')
      assert.equal(after.reportDataAnywhere, 0, 'no report data under A')
      assert.equal(after.errorsAnywhere, 0)
      assert.deepEqual(watch.states, ['absent'])
      assert.equal(watch.dataSeen, false)
      assert.deepEqual(watch.sentinelsSeen, [], 'B data never reached the page under A')
      const panelAfter = await bounded(readPanel(), input.signal, 'W27 A after late B')
      await assertShowsGate(panelAfter, criticNewest, criticGates, 'W27 A after late B')
      assert.equal(panelAfter.html.includes(sentinel), false)
      // A's own report afterwards is a fresh real read, never the held B answer.
      const openedA = await openCriticViewer('W27 open under A after late B')
      assertCriticViewerShowsRecord(openedA.view, criticRecord, {
        label: 'W27 A after late B',
        evaluatedAtText: await evaluatedAtText(criticRecord.evaluatedAt),
      })
      assert.equal((await page.content()).includes(sentinel), false, 'B data rendered under A')
      await closeCriticViewer(criticClose, 'W27 A close')
      const requests = requestsSince(mark)
      assert.deepEqual(postsIn(requests), [], 'W27 A→B→A: zero POST')
      criticEvidence.controlled.push({
        mode: 'controlled-transport',
        title: 'A→B→A across history entries (newest→older→newest) with the older entry\'s report answer held',
        variant: 'history entries of the same project: the fixture\'s second project has no persisted gate, so it has no critic reference to open, and the controlled W27 cases route only the report URL',
        state: 'as W25: a change of visible gate unmounts the viewer (keyed by project, gate and reference); the late answer is discarded and never reopens it',
        gateA: criticNewest.id,
        gateB: criticOlder.id,
        lateAnswer: delivery,
        sentinel,
        selections: [toB.requests, backToA.requests],
        statesObservedAfterUnmount: watch.states,
        sentinelRendered: false,
        afterwardsUnderA: { mode: 'real', requests: openedA.requests, reportHash: openedA.view.viewer.reportHash },
        ledger: ledgerSummary(requests),
        postCount: 0,
      })
    })

    await step('W27 controlled transport: 401 on the report read redirects to /login (last: it closes the editor reads)', async () => {
      await quiesce('W27 401')
      const mark = ledger.length
      const answered = []
      await criticRoute(refuseWith(401, 'AUTH_INVALID', {}, answered), async () => {
        const login = trackWait(page.waitForURL((url) => url.pathname === '/login'))
        await bounded(criticOpen.click(), input.signal, 'W27 401 open')
        await bounded(login, input.signal, 'W27 login redirect after 401')
      })
      await quiesce('W27 after 401')
      const requests = requestsSince(mark)
      assert.equal(answered.length, 1, 'one report read answered 401')
      assert.deepEqual(postsIn(requests), [], 'W27 401: zero POST')
      criticEvidence.controlled.push({
        mode: 'controlled-transport',
        title: 'report GET 401 redirects to /login',
        answered,
        redirectedTo: '/login',
        ledger: ledgerSummary(requests),
        postCount: 0,
      })
    })

    let countsAfter
    await step('W27 real: the viewer block issued zero POST and left critic reports and gates unchanged', async () => {
      const requests = requestsSince(criticLedgerStart)
      assert.deepEqual(postsIn(requests), [], 'the whole W27 block issued zero POST')
      countsAfter = Object.freeze(await bounded(criticViewer.readPersistedCounts(), input.signal, 'W27 persisted counts after'))
      assert.deepEqual(countsAfter, countsBefore, 'the W27 block persisted nothing')
      criticEvidence.real.persistence = { mode: 'real', countsBefore, countsAfter }
      criticEvidence.ledger = {
        total: requests.length,
        postCount: 0,
        reportReads: reportReads(requests).length,
        reportReadsByMethod: Object.fromEntries(['GET', 'POST'].map((method) =>
          [method, requests.filter((request) => request.method === method && request.path === criticPath).length])),
      }
    })
    await writeFile(criticEvidencePath, `${JSON.stringify(criticEvidence, null, 2)}\n`, 'utf8')

    result = Object.freeze({
      gateText,
      screenshotPath,
      history: Object.freeze({
        editorEvaluationId: editorEvaluation.gate.id,
        evidencePath: join(evidenceRoot, 'synthetic-phase-gate-history-browser.json'),
      }),
      criticViewer: Object.freeze({
        reportId: criticRecord.id,
        reportHash: criticRecord.reportHash,
        countsBefore,
        countsAfter,
        evidencePath: criticEvidencePath,
      }),
    })
  } catch (error) {
    const details = await diagnostic(input.readServerLogs, page)
    // A failure after the W25 section leaves its completed evidence intact.
    if (!w25EvidenceWritten) {
      await writeFile(join(evidenceRoot, 'synthetic-phase-gate-history-browser.json'),
        `${JSON.stringify({ ...evidence, failed: true }, null, 2)}\n`, 'utf8').catch(() => undefined)
    }
    if (criticBlockStarted) {
      await writeFile(criticEvidencePath, `${JSON.stringify({
        ...criticEvidence,
        failed: true,
        error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
      }, null, 2)}\n`, 'utf8').catch(() => undefined)
    }
    const cause = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
    primaryError = new AggregateError([error], `Synthetic phase gate browser assertion failed: ${cause.slice(0, 2_000)}${details}`)
  } finally {
    releaseHeldPost?.()
    releaseTimeoutPost?.()
    const cleanupErrors = []
    if (context) {
      try {
        await context.close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    let ownedBrowser = browser
    if (!ownedBrowser && launchPromise) {
      try {
        ownedBrowser = await launchPromise
      } catch (error) {
        if (!primaryError) cleanupErrors.push(error)
      }
    }
    if (ownedBrowser) {
      try {
        await ownedBrowser.close()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    await Promise.allSettled([...pendingWaits])
    if (cleanupErrors.length > 0) {
      primaryError = new AggregateError(
        primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
        'Synthetic phase gate browser cleanup did not complete',
      )
    }
  }
  if (primaryError) throw primaryError
  return result
}
