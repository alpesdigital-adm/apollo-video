import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const SHA256 = /^[a-f0-9]{64}$/

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

  const checks = gate.report.evidence.flatMap((criterion) => criterion.checks)
  assert.equal(checks.length, input.expected.checksTotal)
  const covered = checks.filter((check) => check.missingEvidenceTypes.length === 0)
  assert.equal(covered.length, input.expected.checksPassed)
  const missingCodes = checks
    .filter((check) => check.missingEvidenceTypes.length > 0)
    .map((check) => check.code)
    .sort()
  assert.deepEqual(missingCodes, [...input.expected.missingLiveChecks].sort())
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
    assert.equal(await page.getByRole('alert').count(), 0)

    await bounded(page.screenshot({ path: screenshotPath, fullPage: true }), input.signal, 'phase gate screenshot')
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
