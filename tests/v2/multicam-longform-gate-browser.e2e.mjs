import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import net from 'node:net'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * E2E — the F4.016 phase gate page in a real browser against a production build.
 *
 * The API is asserted first, then the same facts are looked for on screen, so a
 * failure below is a rendering failure rather than an ambiguous one. The three
 * things asserted are the three an operator would be hurt by, and each one was
 * available to get wrong:
 *
 * 1. **A gate nobody has passed must never render as approved.** Ten criteria,
 *    all of them listed, none of them silently dropped for having no rows.
 * 2. **"Never evaluated" must not read as "failed".** The empty evaluation is
 *    the one a fresh project gets, and every criterion on it has to say nobody
 *    answered rather than that something was refused.
 * 3. **A tampered digest must not look like a missing one.** The seeded older
 *    evaluation carries a colour verdict whose hash does not recompute and a
 *    media artifact whose table stores no hash at all; the page has to call the
 *    first tampering and the second "sem hash próprio", and it has to offer the
 *    artifact as a link rather than as a string.
 *
 * Needs PostgreSQL, a production build and Chrome, so it is opt-in.
 */

const RUN = process.env.APOLLO_MULTICAM_GATE_BROWSER_E2E === '1'
const SKIP = RUN
  ? false
  : 'set APOLLO_MULTICAM_GATE_BROWSER_E2E=1, build the app and use an isolated V2 database'

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/v1/health`)).ok) return } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('E2E-F4.016 the phase gate page shows ten conditions, each answered on its own', {
  skip: SKIP,
}, async () => {
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { calculateMulticamLongformGateRecordHash } = await import(
    '../../src/v2/application/multicam-longform-gate.ts'
  )
  const { createApiAccessAuditContext } = await import('../../src/v2/domain/api-access-control.ts')
  const {
    buildLegacyRuntimeCriterion,
    calculateLegacyRuntimeAuditHash,
    evaluateMulticamLongformGate,
    MULTICAM_LONGFORM_CRITERIA,
    MULTICAM_LONGFORM_CRITERION_CHECKS,
  } = await import('../../src/v2/domain/multicam-longform-gate.ts')
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { PrismaMulticamLongformGateRepository } = await import(
    '../../src/v2/infrastructure/prisma/multicam-longform-gate-repository.ts'
  )
  const { nodeApiCredentialCrypto } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )
  const { createUiPasswordHash } = await import(
    '../../src/v2/infrastructure/security/ui-session.ts'
  )

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `f4016-browser-${suffix}`
  // Deliberately near the 128-character bound the public id schema allows. The
  // page used to build its Idempotency-Key as `gate-${projectId}-${minute}`,
  // which for an id this long is 132 characters against a server pattern that
  // stops at 128: "Avaliar agora" answered 422 and the operator read it as the
  // gate refusing the project. A short fixture id could never have shown it.
  const projectId = `f4016-project-${suffix}`.padEnd(110, 'p')
  const uiUsername = `f4016-user-${suffix}`
  const uiPassword = `Multicam-Longform-${suffix}-secure`
  const createdAt = new Date('2029-05-01T09:00:00.000Z')
  // An hour ago, on the real clock, not a fixed literal. The evaluation this
  // test POSTs is stamped by the server's own clock, and `readLatest` orders by
  // `evaluatedAt desc`: a seeded record dated 2029 — the year the other capture
  // fixtures use — came back as the newest one and the page rendered the seeded
  // history entry as the current gate.
  const seededAt = new Date(Date.now() - 3_600_000)
  const h = (n) => String(n).repeat(64).slice(0, 64)
  const artifactId = `artifact-final-master-${suffix}`
  const criticReportId = `color-critic-report-${suffix}`
  let server
  let browser

  const cleanup = async () => {
    await client.v2MulticamLongformGate.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2WorkspaceUiPrincipal.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }

  try {
    await cleanup()
    await client.v2Workspace.create({
      data: {
        id: workspaceId, slug: workspaceId, name: 'F4.016 browser E2E',
        status: 'active', createdAt, updatedAt: createdAt,
      },
    })
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `f4016-client-${suffix}`,
      workspaceId,
      name: 'F4.016 browser E2E',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    await client.v2Project.create({
      data: {
        id: projectId, workspaceId, name: 'F4.016 browser E2E',
        status: 'reviewing-proxy', objective: 'discovery', format: '16:9', locale: 'pt-BR',
        createdByType: 'api-client', createdById: issued.client.id,
        createdAt, updatedAt: createdAt,
      },
    })

    // ---- an older evaluation with all three evidence states in it ----------
    //
    // Persisted through the same repository the service writes with, so the
    // migration's CHECK constraints and the hash-on-read verification apply to
    // it exactly as they would to a real run.
    const auditContent = {
      schemaVersion: 'legacy-runtime-audit/v1',
      entryModules: ['src/v2/application/multicam-longform-gate.ts'],
      unreadableEntryModules: [],
      scannedModuleCount: 118,
      violations: [],
      scannedAt: seededAt.toISOString(),
    }
    const legacyAudit = {
      ...auditContent,
      auditHash: calculateLegacyRuntimeAuditHash(auditContent),
    }
    const seededReport = evaluateMulticamLongformGate({
      workspaceId,
      projectId,
      sessionId: null,
      evaluatedAt: seededAt.toISOString(),
      evidence: [
        {
          criterion: 'final-mp4-inspectable',
          checks: [
            {
              code: 'final-export-promoted',
              passed: true,
              failureReason: null,
              detail: 'a tentativa 2 promoveu o master entregue',
              references: [{ type: 'final-export', id: `operation-final-${suffix}`, hash: h(1), verified: true }],
            },
            {
              code: 'output-codec-recorded',
              passed: true,
              failureReason: null,
              detail: 'h264 / aac a 1920x1080',
              references: [{ type: 'media-manifest', id: `manifest-${suffix}`, hash: h(2), verified: true }],
            },
            {
              code: 'output-probe-measured',
              passed: true,
              failureReason: null,
              detail: 'ffprobe contou 3600 quadros em 120,000 s',
              // No digest of its own: nothing to recompute. A check may pass
              // beside this, and the page must not call it suspicious.
              references: [{ type: 'media-artifact', id: artifactId, hash: null, verified: false }],
            },
            {
              code: 'artifact-hash-matches-attempt',
              passed: true,
              failureReason: null,
              detail: 'o sha256 do manifesto é o sha256 que a tentativa gravou',
              references: [{ type: 'media-manifest', id: `manifest-${suffix}`, hash: h(2), verified: true }],
            },
          ],
        },
        {
          criterion: 'colour-critic-resolved',
          checks: MULTICAM_LONGFORM_CRITERION_CHECKS['colour-critic-resolved'].map((code) => ({
            code,
            passed: false,
            failureReason: 'evidence-unverified',
            detail: 'o parecer de cor gravado não confere com o próprio conteúdo',
            references: [{ type: 'colour-critic-report', id: criticReportId, hash: h(3), verified: false }],
          })),
        },
        buildLegacyRuntimeCriterion(legacyAudit),
      ],
    })
    const seededContent = {
      schemaVersion: 'multicam-longform-gate/v1',
      id: `mlg-seeded-${suffix}`,
      workspaceId,
      projectId,
      sessionId: null,
      projectVersionId: null,
      projectVersionHash: null,
      report: seededReport,
      reportFingerprint: seededReport.fingerprint,
      idempotencyKey: `seeded-${suffix}`,
      requestFingerprint: h(4),
      createdBy: { type: 'api-client', id: issued.client.id },
      createdAt: seededAt.toISOString(),
    }
    const seededGate = {
      ...seededContent,
      recordHash: calculateMulticamLongformGateRecordHash(seededContent),
    }
    await new PrismaMulticamLongformGateRepository(client).persist(
      seededGate,
      createApiAccessAuditContext({
        clientId: issued.client.id,
        credentialId: issued.credential.id,
        workspaceId,
        environment: 'production',
        authenticationKind: 'bearer',
      }),
    )

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    let serverLogs = ''
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        __NEXT_PROCESSED_ENV: 'true',
        APOLLO_API_ENVIRONMENT: 'production',
        APOLLO_AUTH_MODE: 'bootstrap',
        APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true',
        APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
        APOLLO_UI_USERNAME: uiUsername,
        APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `f4016-salt-${suffix}`),
        APOLLO_UI_SESSION_SECRET: `f4016-session-secret-${suffix}-at-least-32`,
        APOLLO_UI_API_CLIENT_ID: issued.client.id,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)

    // ---- the API, stated plainly before the browser is involved ------------
    const authorization = `Bearer ${issued.token}`
    const json = { authorization, 'content-type': 'application/json' }

    const catalogue = await fetch(`${baseUrl}/v1/multicam-longform-gate/criteria`, {
      headers: { authorization },
    })
    const cataloguePayload = await catalogue.json()
    assert.equal(catalogue.status, 200, `${JSON.stringify(cataloguePayload)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(cataloguePayload.data.total, MULTICAM_LONGFORM_CRITERIA.length)
    assert.equal(cataloguePayload.data.criteria.length, MULTICAM_LONGFORM_CRITERIA.length)

    const idempotencyKey = `browser-${suffix}`
    const run = await fetch(
      `${baseUrl}/v1/projects/${projectId}/multicam-longform-gate/evaluations`,
      { method: 'POST', headers: { ...json, 'idempotency-key': idempotencyKey }, body: '{}' },
    )
    const runPayload = await run.json()
    assert.equal(run.status, 201, `${JSON.stringify(runPayload)}\n${serverLogs.slice(-4_000)}`)
    assert.equal(runPayload.data.replayed, false)
    assert.equal(runPayload.data.gate.report.approved, false)
    assert.equal(runPayload.data.gate.report.total, 10)
    assert.equal(runPayload.data.gate.report.criteria.length, 10)
    // The project has no capture sessions, no synthesis and no colour work, so
    // the nine database-backed criteria have nothing to answer with. The tenth
    // is the module-graph scan, and whether it can read the source tree from
    // inside a bundled production server is not something to assume: the
    // expected screen below is derived from what the API actually returned,
    // criterion by criterion, rather than from a number written here.
    const emptyMissing = runPayload.data.gate.report.criteria
      .filter((criterion) => criterion.missingCheckCount === criterion.checkCount)
    assert.ok(
      emptyMissing.length >= 9,
      `a project with no evidence must leave at least nine criteria unanswered, got ${emptyMissing.length}`,
    )
    assert.ok(runPayload.data.gate.report.satisfied <= 1)
    assert.equal('idempotencyKey' in runPayload.data.gate, false)

    const replay = await fetch(
      `${baseUrl}/v1/projects/${projectId}/multicam-longform-gate/evaluations`,
      { method: 'POST', headers: { ...json, 'idempotency-key': idempotencyKey }, body: '{}' },
    )
    const replayPayload = await replay.json()
    assert.equal(replay.status, 200, JSON.stringify(replayPayload))
    assert.equal(replayPayload.data.replayed, true)
    assert.equal(replayPayload.data.gate.recordHash, runPayload.data.gate.recordHash)

    const latest = await fetch(
      `${baseUrl}/v1/projects/${projectId}/multicam-longform-gate`,
      { headers: { authorization } },
    )
    const latestPayload = await latest.json()
    assert.equal(latest.status, 200, JSON.stringify(latestPayload))
    assert.equal(latestPayload.data.gate.id, runPayload.data.gate.id)

    const history = await fetch(
      `${baseUrl}/v1/projects/${projectId}/multicam-longform-gate/evaluations?limit=20`,
      { headers: { authorization } },
    )
    const historyPayload = await history.json()
    assert.equal(history.status, 200, JSON.stringify(historyPayload))
    assert.equal(historyPayload.data.gates.length, 2)
    assert.deepEqual(
      historyPayload.data.gates.map((entry) => entry.id),
      [runPayload.data.gate.id, seededGate.id],
      'the history is newest first',
    )

    const outstanding = await fetch(
      `${baseUrl}/v1/projects/${projectId}/multicam-longform-gate/outstanding`,
      { headers: { authorization } },
    )
    const outstandingPayload = await outstanding.json()
    assert.equal(outstanding.status, 200, JSON.stringify(outstandingPayload))
    assert.equal(
      outstandingPayload.data.outstanding.length,
      10 - runPayload.data.gate.report.satisfied,
    )
    // Criteria nobody answered come first, whatever the scanner managed.
    assert.equal(outstandingPayload.data.outstanding[0].neverEvaluated, true)

    const seededArtifacts = await fetch(
      `${baseUrl}/v1/projects/${projectId}/multicam-longform-gate/evaluations/${seededGate.id}/artifacts`,
      { headers: { authorization } },
    )
    const artifactPayload = await seededArtifacts.json()
    assert.equal(seededArtifacts.status, 200, JSON.stringify(artifactPayload))
    assert.equal(artifactPayload.data.unverifiedCount, 1)
    assert.equal(artifactPayload.data.unhashedCount, 1)
    const manifest = artifactPayload.data.artifacts
      .find((entry) => entry.type === 'media-manifest')
    assert.equal(manifest.citedBy.length, 2, 'one row read by two checks is one row')

    // ---- the browser ------------------------------------------------------
    const executablePath = [
      process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((candidate) => candidate && existsSync(candidate))
    assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to run the phase gate browser E2E')

    const { chromium } = await import('playwright-core')
    browser = await chromium.launch({ executablePath, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1400 } })
    const page = await context.newPage()

    // Reached the way an operator reaches it: from the captures screen. The
    // gate is not a shell destination, so if this link ever disappears the page
    // becomes unreachable and this click is what says so.
    await page.goto(`${baseUrl}/login?next=${encodeURIComponent('/capture-sessions')}`)
    await page.locator('input[name="username"]').fill(uiUsername)
    await page.locator('input[name="password"]').fill(uiPassword)
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    await page.waitForURL('**/capture-sessions**')
    await page.goto(`${baseUrl}/capture-sessions?projectId=${encodeURIComponent(projectId)}`)
    await page.getByTestId('capture-sessions-page').waitFor({ state: 'visible' })
    await page.getByTestId('open-multicam-longform-gate').locator('a').click()
    await page.waitForURL('**/multicam-longform-gate**')

    await page.getByTestId('multicam-longform-gate-page').waitFor({ state: 'visible' })
    await page.getByTestId('gate-summary').waitFor({ state: 'visible' })

    // 1. Not approved, and all ten conditions on screen.
    assert.equal(await page.getByTestId('gate-summary').getAttribute('data-approved'), 'false')
    const listed = await page.getByTestId('criteria-list').locator('> li').count()
    assert.equal(listed, 10, 'a criterion with no rows was dropped from the screen')
    for (const criterion of MULTICAM_LONGFORM_CRITERIA) {
      await page.getByTestId(`criterion-${criterion}`).waitFor({ state: 'visible' })
      const statement = await page.getByTestId(`criterion-statement-${criterion}`).textContent()
      assert.ok((statement ?? '').trim().length > 20, `${criterion} was listed without its sentence`)
    }

    // 2. Every criterion says on screen exactly what the API said about it —
    //    and above all, a criterion nobody answered says so instead of reading
    //    as one that ran and refused.
    const expectedStatus = (criterion) => {
      const answer = runPayload.data.gate.report.criteria
        .find((entry) => entry.criterion === criterion)
      if (answer.passed) return 'aprovado'
      return answer.missingCheckCount === answer.checkCount ? 'não avaliado' : 'reprovado'
    }
    const statuses = await Promise.all(MULTICAM_LONGFORM_CRITERIA.map(async (criterion) =>
      (await page.getByTestId(`criterion-status-${criterion}`).textContent())?.trim()))
    assert.deepEqual(
      statuses,
      MULTICAM_LONGFORM_CRITERIA.map(expectedStatus),
      'the screen and the API disagree about a criterion',
    )
    assert.ok(
      statuses.filter((status) => status === 'não avaliado').length >= 9,
      'a criterion with no rows was rendered as something other than unanswered',
    )
    const outstandingShown = await page.getByTestId('outstanding-list').locator('> li').count()
    assert.equal(outstandingShown, outstandingPayload.data.outstanding.length)
    assert.equal(
      (await page.getByTestId('outstanding-kind-contextual-multi-range-synthesis').textContent())?.trim(),
      'nunca avaliada',
      'a criterion nobody ran was rendered as one that ran and refused',
    )

    // 3. The older evaluation, opened from the history, tells the three
    //    evidence states apart.
    await page.getByTestId('history-list').waitFor({ state: 'visible' })
    await page.getByTestId(`open-evaluation-${seededGate.id}`).click()
    await page.getByTestId('criterion-artifacts-final-mp4-inspectable').waitFor({ state: 'visible' })
    assert.equal(
      (await page.getByTestId('criterion-status-final-mp4-inspectable').textContent())?.trim(),
      'aprovado',
    )
    assert.equal(
      (await page.getByTestId('criterion-status-colour-critic-resolved').textContent())?.trim(),
      'reprovado',
    )
    assert.equal(
      (await page.getByTestId('artifact-hash-final-mp4-inspectable-media-artifact').textContent())?.trim(),
      'sem hash próprio',
      'an artifact with no digest of its own was rendered as a failed check',
    )
    assert.equal(
      (await page.getByTestId('artifact-hash-colour-critic-resolved-colour-critic-report').textContent())?.trim(),
      'hash NÃO confere',
      'a tampered row was not called tampering',
    )
    // And the artifact is a place to go, not a string.
    const href = await page
      .getByTestId('artifact-final-mp4-inspectable-media-artifact')
      .locator('a')
      .getAttribute('href')
    assert.equal(href, `/v1/artifacts/${artifactId}`)

    // 4. The criteria are readable before any project has been evaluated.
    //    `loadCatalogue` used to have one call site, inside `loadGate`, after
    //    the early return for an empty project, so arriving here with no
    //    `projeto` — which the link on the captures screen does whenever
    //    nothing has been typed yet — rendered "As dez condições" above an
    //    empty list. A screen headed "ten conditions" showing zero is the
    //    aggregated nothing this page exists to refuse.
    await page.goto(`${baseUrl}/multicam-longform-gate`)
    await page.getByTestId('multicam-longform-gate-page').waitFor({ state: 'visible' })
    await page.getByTestId('state-idle').waitFor({ state: 'visible' })
    // The catalogue arrives from its own request, so the tenth row is waited
    // for rather than counted the instant the page paints. A page that never
    // loads the catalogue — the defect this covers — never produces it and
    // fails here on the timeout.
    await page.getByTestId('criteria-list').locator('> li').nth(9).waitFor({ state: 'visible' })
    const listedWithoutProject = await page.getByTestId('criteria-list').locator('> li').count()
    assert.equal(
      listedWithoutProject,
      MULTICAM_LONGFORM_CRITERIA.length,
      'the ten conditions are unreadable until a project is supplied',
    )
    const idleStatuses = await Promise.all(MULTICAM_LONGFORM_CRITERIA.map(async (criterion) =>
      (await page.getByTestId(`criterion-status-${criterion}`).textContent())?.trim()))
    assert.deepEqual(
      idleStatuses,
      MULTICAM_LONGFORM_CRITERIA.map(() => 'não avaliado'),
      'a criterion nobody asked about was shown as answered',
    )

    // 5. The page's own command path. The browser drove six of the seven
    //    capabilities and POSTed the evaluation itself, so the one button that
    //    writes was never pressed - and the key it builds is exactly what was
    //    wrong with it.
    await page.goto(`${baseUrl}/multicam-longform-gate?projeto=${encodeURIComponent(projectId)}`)
    await page.getByTestId('gate-summary').waitFor({ state: 'visible' })
    await page.getByTestId('evaluate-gate').click()
    await page.getByTestId('message').waitFor({ state: 'visible' })
    assert.equal(
      (await page.getByTestId('message').textContent())?.trim(),
      'Avaliação registrada.',
      'the evaluation the page itself asked for came back refused',
    )
    const written = await client.v2MulticamLongformGate.findMany({
      where: { workspaceId, projectId },
      orderBy: { createdAt: 'desc' },
    })
    assert.equal(written.length, 3, 'the button did not write a third evaluation')
    // The server's own bound, asserted against the key the page built for a
    // 110-character project id.
    assert.match(written[0].idempotencyKey, /^[\x21-\x7E]{8,128}$/)

    // 6. A network failure while opening a historical evaluation says so.
    //    `openEvaluation` was the one fetch on the page with no catch: the
    //    promise `void openEvaluation(...)` created rejected unhandled, `busy`
    //    cleared, and the screen simply stopped answering the click. The read
    //    is aborted at the network, which is the failure the missing catch
    //    swallowed — the POST and the artifact listing are left alone so only
    //    the handler under test is exercised.
    await page.route('**/multicam-longform-gate/evaluations/**', (route) => {
      const request = route.request()
      const isEvaluationRead = request.method() === 'GET' &&
        !request.url().includes('/artifacts')
      return isEvaluationRead ? route.abort('failed') : route.continue()
    })
    await page.getByTestId(`open-evaluation-${seededGate.id}`).click()
    // Wait for the message to CHANGE, not to become visible: it is already
    // visible, carrying the confirmation the evaluate button left behind, so
    // `waitFor({ state: 'visible' })` returns at once and the assertion below
    // samples the stale text. On this author's machine the handler happened to
    // win that race; on a GitHub runner it did not, and the suite reported the
    // previous message as though the screen had stayed silent. If the handler
    // never answers — the defect this step exists for — the wait times out and
    // the step still fails.
    await page.waitForFunction(
      (stale) => {
        const node = document.querySelector('[data-testid="message"]')
        return node !== null && (node.textContent ?? '').trim() !== stale
      },
      'Avaliação registrada.',
    )
    assert.equal(
      (await page.getByTestId('message').textContent())?.trim(),
      'A rede falhou ao abrir esta avaliação.',
      'a failed read of a historical evaluation left the screen silent',
    )
    await page.unroute('**/multicam-longform-gate/evaluations/**')

    const body = (await page.locator('body').textContent()) ?? ''
    assert.doesNotMatch(body, /\b\d{1,3}%/, 'the gate was summarised as a percentage')

    console.log(
      `browser: ${listed} criteria listed, ${statuses.filter((s) => s === 'não avaliado').length} unanswered, `
      + `${statuses.filter((s) => s === 'aprovado').length} approved, ${outstandingShown} outstanding; `
      + `the fresh evaluation satisfied ${runPayload.data.gate.report.satisfied} of 10; `
      + `the seeded evaluation shows 1 approved, 1 refused, `
      + `${artifactPayload.data.unverifiedCount} tampered and ${artifactPayload.data.unhashedCount} unhashed reference; `
      + `with no project in the URL the same screen still lists ${listedWithoutProject} conditions, `
      + `and the page's own command button wrote a third record under a `
      + `${written[0].idempotencyKey.length}-character key for a ${projectId.length}-character project`,
    )
  } finally {
    if (browser) await browser.close()
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    // Reported, not rethrown: a cleanup failure that masks the real assertion
    // turns one clear defect into two confusing ones.
    try {
      await cleanup()
    } catch (error) {
      console.error('cleanup failed:', error?.message ?? error)
    } finally {
      await client.$disconnect()
    }
  }
})
