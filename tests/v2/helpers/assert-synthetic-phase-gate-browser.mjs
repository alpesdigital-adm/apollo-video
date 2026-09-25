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
      references: [...check.querySelectorAll('li')].map((reference) => ({
        text: text(reference),
        titles: [...reference.querySelectorAll('[title]')].map((element) => element.getAttribute('title')),
        href: reference.querySelector('a')?.getAttribute('href') ?? null,
      })),
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
      await bounded(historySelect.evaluate((node, size) => { node.setAttribute('size', String(size)) },
        state.options.length + 1), input.signal, 'options capture layout')
      try {
        await capturePanel(join(evidenceRoot, 'synthetic-phase-gate-history-options.png'), 'real: history options expanded for capture')
      } finally {
        await bounded(historySelect.evaluate((node) => { node.removeAttribute('size') }), input.signal, 'options capture restore')
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
    result = Object.freeze({
      gateText,
      screenshotPath,
      history: Object.freeze({
        editorEvaluationId: editorEvaluation.gate.id,
        evidencePath: join(evidenceRoot, 'synthetic-phase-gate-history-browser.json'),
      }),
    })
  } catch (error) {
    const details = await diagnostic(input.readServerLogs, page)
    await writeFile(join(evidenceRoot, 'synthetic-phase-gate-history-browser.json'),
      `${JSON.stringify({ ...evidence, failed: true }, null, 2)}\n`, 'utf8').catch(() => undefined)
    primaryError = new AggregateError([error], `Synthetic phase gate browser assertion failed${details}`)
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
