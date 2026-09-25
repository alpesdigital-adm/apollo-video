import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

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

/**
 * Exercises the real authenticated editor surface against a persisted phase
 * gate. It owns only its browser resources and never inserts or upgrades proof.
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

  const executablePath = browserExecutable()
  assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to run the synthetic phase gate browser E2E')
  const screenshotPath = resolve(input.evidence.screenshotPath)
  await mkdir(dirname(screenshotPath), { recursive: true })

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

    const projectPath = `/projects/${encodeURIComponent(input.projectId)}`
    const gatePath = `/v1/projects/${encodeURIComponent(input.projectId)}/synthetic-phase-gates`
    await bounded(page.goto(`${origin.origin}/login?next=${encodeURIComponent(projectPath)}`), input.signal, 'login navigation')
    await bounded(page.locator('input[name="username"]').fill(input.login.username), input.signal, 'username')
    await bounded(page.locator('input[name="password"]').fill(input.login.password), input.signal, 'password')
    const sessionResponse = trackWait(page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/v1/session'))
    const initialGateResponse = trackWait(page.waitForResponse((response) =>
      response.request().method() === 'GET' && new URL(response.url()).pathname === gatePath))
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
    const envelope = await gateResponse.json()
    const latest = [...(envelope.data?.gates ?? [])]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
    assert.ok(latest, 'the project must have a persisted synthetic phase gate')
    assertGate(latest, input)

    const panel = page.getByTestId('synthetic-phase-gate-panel')
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

    const rejectedReportReference = latest.report.evidence
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

    const consumerReference = latest.report.evidence
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
    assert.equal(otherProjectResponse.status(), 404, 'a report cannot be read through a different project')
    assert.equal(unsupportedQueryResponse.status(), 400, 'unsupported query parameters must be rejected')
    assert.equal(anonymousResponse.status, 401, 'a report must require authentication')
    await anonymousResponse.arrayBuffer()
    await writeFile(resolve(dirname(screenshotPath), 'transformation-critic-read.json'), `${JSON.stringify({
      gateId: latest.id,
      reference: rejectedReportReference,
      href: reportPath,
      report: openedReport,
      http: { authenticated: 200, otherProject: 404, unsupportedQuery: 400, anonymous: 401 },
    }, null, 2)}\n`, 'utf8')
    await bounded(page.goBack(), input.signal, 'return to persisted gate')
    await bounded(panel.waitFor({ state: 'visible' }), input.signal, 'phase gate after report navigation')

    let markPostHeld
    const postHeld = new Promise((resolveHeld) => { markPostHeld = resolveHeld })
    const postRelease = new Promise((resolveRelease) => { releaseHeldPost = resolveRelease })
    const holdRealPost = async (route) => {
      const request = route.request()
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== gatePath) {
        await route.continue()
        return
      }
      markPostHeld()
      await postRelease
      await route.continue()
    }
    await page.route('**/*', holdRealPost)
    const postResponse = trackWait(page.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === gatePath))
    const runButton = page.getByTestId('synthetic-phase-gate-run')
    const loadingState = runButton.getByText('Avaliando evidências…').waitFor({ state: 'visible' })
    await bounded(runButton.click(), input.signal, 'run phase gate')
    await bounded(postHeld, input.signal, 'phase gate POST dispatch')
    await bounded(loadingState, input.signal, 'phase gate loading state')
    assert.equal(await runButton.isDisabled(), true, 'a pending evaluation must not dispatch twice')
    releaseHeldPost()
    releaseHeldPost = undefined
    const evaluatedResponse = await bounded(postResponse, input.signal, 'phase gate POST')
    assert.ok([200, 201].includes(evaluatedResponse.status()))
    const evaluatedEnvelope = await evaluatedResponse.json()
    assertGate(evaluatedEnvelope.data?.gate, input)
    await bounded(page.getByText('Executar nova avaliação', { exact: true }).waitFor({ state: 'visible' }), input.signal, 'phase gate terminal state')
    await bounded(panel.evaluate((node) => node.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: 'instant',
    })), input.signal, 'phase gate panel scroll')
    await bounded(panel.screenshot({ path: screenshotPath }), input.signal, 'phase gate panel screenshot')
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
    result = Object.freeze({ gateText: await panel.innerText(), screenshotPath })
  } catch (error) {
    const details = await diagnostic(input.readServerLogs, page)
    primaryError = new AggregateError([error], `Synthetic phase gate browser assertion failed${details}`)
  } finally {
    releaseHeldPost?.()
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
