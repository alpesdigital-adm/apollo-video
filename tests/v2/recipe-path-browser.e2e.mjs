import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { assertIsolatedDatabase } from './helpers/capture-journey.mjs'
import { createTakeLibraryThroughApi, seedCompatBatch } from './helpers/compat-batch-world.mjs'

/**
 * ADR-160 F8, in a real browser against the production build: the path selector of the recipe. The owner states no context, so the compatibility
 * map cannot decide any link: it leaves each one to the owner (borderline, "faltou contexto: ..."), never approving nor blocking on duration alone.
 * The screen names the missing context, asks for the confirmation of each link, and only then compiles; the server refuses the same path without
 * the confirmation. A batch whose objective requires a proof says so BEFORE the owner can choose "no proof". No interpreter is involved.
 * Screenshots go to APOLLO_E2E_SCREENSHOT_DIR when it is set.
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}
async function waitForServer(url, child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next production server exited with ${child.exitCode}`)
    try {
      if ((await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(1_000) })).ok) return
    } catch { /* not ready yet */ }
    await delay(250)
  }
  throw new Error('Next production server did not become ready within 60 seconds')
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited.then(() => true), delay(5_000).then(() => false)])
  if (!graceful && child.exitCode === null) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(2_000)])
  }
}

const enabled = process.env.APOLLO_RECIPE_PATH_E2E === '1'

test('the path selector of the recipe: links left to the owner are confirmed on the screen, the server refuses them without it, and a required proof is announced first', { skip: !enabled && 'set APOLLO_RECIPE_PATH_E2E=1 and use an isolated database', timeout: 600_000 }, async () => {
  assertIsolatedDatabase()
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-recipe-path-'))
  const shots = process.env.APOLLO_E2E_SCREENSHOT_DIR
  if (shots) mkdirSync(shots, { recursive: true })
  let browser, server, page
  const exchanges = []
  let serverLogs = ''
  try {
    const { createWorkspaceRow, issueApiClient } = await import('./helpers/capture-journey.mjs')
    const { seedSealedProject, testActor } = await import('./helpers/pg-output-world.mjs')
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10)
    const workspaceId = `path-${suffix}-ws`
    const clientId = `path-${suffix}-client`
    const now = new Date()
    await createWorkspaceRow({ prisma, workspaceId, name: 'Workspace do teste do caminho', createdAt: now })
    const issued = await issueApiClient({
      prisma, workspaceId, clientId, name: 'Teste do caminho', createdAt: now,
      scopes: ['projects:read', 'projects:write', 'projects:approve'],
    })
    const worldActor = testActor({ workspaceId, clientId, credentialId: issued.credential.id, environment: 'production', scopes: ['projects:write', 'projects:read', 'media:write'] })
    const world = await seedSealedProject(prisma, { workspaceId, actor: worldActor, prefix: 'path', name: 'Projeto do caminho', briefing: 'texto do pedido' })
    const authorization = `Bearer ${issued.token}`

    const username = `path-ui-${suffix}`
    const password = `Path-${suffix}-secure`
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        __NEXT_PROCESSED_ENV: 'true',
        APOLLO_API_ENVIRONMENT: 'production',
        APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '1000000',
        APOLLO_AUTH_MODE: 'bootstrap',
        APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true',
        APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
        APOLLO_UI_USERNAME: username,
        APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(password, `path-salt-${suffix}`),
        APOLLO_UI_SESSION_SECRET: `path-session-${suffix}-at-least-32-bytes-long`,
        APOLLO_UI_API_CLIENT_ID: issued.client.id,
        APOLLO_V2_ARTIFACT_ROOT: root,
        APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)

    // Two batches over the same project: a lead-generation one (the proof is optional) and a sale one (the objective requires a proof).
    const common = { workspaceId, clientId, credentialId: issued.credential.id, projectId: world.projectId }
    const optional = { ...common, batchId: `path-batch-optional-${suffix}`, objective: 'lead-generation', suffix: `${suffix}a`, name: 'Lote com prova opcional' }
    const required = { ...common, batchId: `path-batch-required-${suffix}`, objective: 'sale', suffix: `${suffix}b`, name: 'Lote que exige prova' }
    const seededOptional = await seedCompatBatch(prisma, optional)
    const seededRequired = await seedCompatBatch(prisma, required)
    const libraryOptional = await createTakeLibraryThroughApi({ baseUrl, authorization, batchId: optional.batchId, alignment: seededOptional.alignment, suffix: optional.suffix })
    await createTakeLibraryThroughApi({ baseUrl, authorization, batchId: required.batchId, alignment: seededRequired.alignment, suffix: required.suffix })
    assert.deepEqual([...new Set(libraryOptional.takes.map((take) => take.assignment.role))].sort(), ['body', 'cta', 'hook', 'proof'])

    const executablePath = [
      process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ].find((candidate) => candidate && existsSync(candidate))
    assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to a Chromium executable')
    const { chromium } = await import('playwright-core')
    browser = await chromium.launch({ executablePath, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1500 } })
    context.setDefaultTimeout(20_000)
    context.setDefaultNavigationTimeout(30_000)
    page = await context.newPage()
    const recipePosts = []
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (url.origin === baseUrl && url.pathname.startsWith('/v1/')) exchanges.push(`${response.request().method()} ${url.pathname} ${response.status()}`)
    })
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.origin === baseUrl && request.method() === 'POST' && url.pathname.endsWith('/variant-recipes')) recipePosts.push(request.postDataJSON())
    })
    const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, name), fullPage: false }) }

    await page.goto(`${baseUrl}/login?next=${encodeURIComponent('/')}`)
    await page.locator('input[name="username"]').fill(username)
    await page.locator('input[name="password"]').fill(password)
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    await page.waitForURL((url) => url.pathname === '/')

    // ---- 1. a batch whose proof is optional, with no context stated ----
    await page.goto(`${baseUrl}/batches`)
    await page.getByText('Lote com prova opcional').first().click()
    const graphPanel = page.getByTestId('compatibility-graph-panel')
    await graphPanel.waitFor()
    await page.getByTestId('create-compatibility-graph').click()
    await page.getByTestId('compatibility-not-evaluable').waitFor({ timeout: 60_000 })
    const graphs = await (await fetch(`${baseUrl}/v1/batches/${optional.batchId}/compatibility-graphs`, { headers: { authorization } })).json()
    const graph = graphs.data.graphs[0]
    assert.ok(graph.edges.length >= 3)
    for (const edge of graph.edges) {
      assert.equal(edge.decision, 'borderline', 'with nothing stated the Apollo neither approves nor blocks a link')
      assert.ok(edge.reasonCodes.includes('CONTEXT_REQUIRED_FOR_DECISION'))
    }
    await shot('10-lotes-mapa-sem-contexto.png')

    const picker = page.getByTestId('recipe-path-picker')
    await picker.scrollIntoViewIfNeeded()
    assert.equal(await page.getByTestId('recipe-proof-required').count(), 0, 'the objective does not require a proof')
    await page.getByTestId('recipe-proof-choice').selectOption('without-proof')
    for (const role of ['hook', 'body', 'cta']) await page.getByTestId(`recipe-pick-${role}`).selectOption({ index: 1 })
    for (const role of ['body', 'cta']) {
      const link = page.getByTestId(`recipe-link-${role}`)
      await link.waitFor()
      assert.equal(await link.getAttribute('data-verdict'), 'borderline')
      assert.match(await link.textContent(), /O Apollo não decide esta ligação sozinho \(faltou contexto: .*temas da narrativa.*\)/)
    }
    const compile = page.getByTestId('create-variant-recipe')
    assert.equal(await compile.isDisabled(), true, 'the recipe is not compiled while a link waits for the owner')
    assert.equal(await page.getByTestId('recipe-confirm-body').isChecked(), false, 'nothing is confirmed for the owner')
    await shot('11-lotes-caminho-ligacoes-pendentes.png')

    // The server says the same without the screen: the same path, no confirmation.
    const refused = await fetch(`${baseUrl}/v1/batches/${optional.batchId}/variant-recipes`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `path-refused-${suffix}` },
      body: JSON.stringify({
        compatibilityGraphId: graph.id, expectedCompatibilityGraphRunHash: graph.runHash,
        selection: await selectionOf(page),
        orderedNodeIds: await orderedOf(page), requireProof: false,
      }),
    })
    const refusedBody = await refused.json()
    assert.equal(refused.status, 428, JSON.stringify(refusedBody).slice(0, 400))
    assert.match(JSON.stringify(refusedBody), /borderline: the owner must confirm it/)

    await page.getByTestId('recipe-confirm-body').check()
    assert.equal(await compile.isDisabled(), true, 'one of the two links is still unconfirmed')
    await page.getByTestId('recipe-confirm-cta').check()
    assert.equal(await compile.isDisabled(), false)
    await compile.click()
    await page.locator('[data-testid^="variant-recipe-recipe"], [data-testid^="variant-recipe-variant"]').first().waitFor({ timeout: 60_000 })
    assert.equal(recipePosts.length >= 1, true)
    const posted = recipePosts.at(-1)
    assert.deepEqual(posted.assumptions.map((item) => item.code).sort(), ['OWNER_CONFIRMED_LINK_BODY_CTA', 'OWNER_CONFIRMED_LINK_HOOK_BODY'].sort())
    const recipes = await (await fetch(`${baseUrl}/v1/batches/${optional.batchId}/variant-recipes`, { headers: { authorization } })).json()
    const recipe = recipes.data.recipes[0]
    assert.equal(recipe.summary.includesProof, false)
    assert.equal(recipe.assumptions.filter((item) => item.code.startsWith('OWNER_CONFIRMED_LINK_')).length, 2, 'the confirmation is sealed in the recipe')
    await shot('12-lotes-receita-compilada-com-confirmacao.png')

    // ---- 2. a batch whose objective requires a proof ----
    await page.goto(`${baseUrl}/batches`)
    await page.getByText('Lote que exige prova').first().click()
    await page.getByTestId('compatibility-graph-panel').waitFor()
    await page.getByTestId('create-compatibility-graph').click()
    await page.getByTestId('compatibility-not-evaluable').waitFor({ timeout: 60_000 })
    await page.getByTestId('recipe-path-picker').scrollIntoViewIfNeeded()
    await page.getByTestId('recipe-proof-required').waitFor()
    assert.match(await page.getByTestId('recipe-proof-required').textContent(), /Este objetivo exige uma prova/)
    const withoutProof = page.getByTestId('recipe-proof-choice').locator('option[value="without-proof"]')
    assert.equal(await withoutProof.isDisabled(), true, '"no proof" cannot be picked and then refused in silence')
    assert.match(await withoutProof.textContent(), /este objetivo exige uma prova/)
    await shot('13-lotes-objetivo-exige-prova.png')
    await page.getByTestId('recipe-proof-choice').selectOption('with-proof')
    for (const role of ['hook', 'body', 'proof', 'cta']) await page.getByTestId(`recipe-pick-${role}`).selectOption({ index: 1 })
    for (const role of ['body', 'proof', 'cta']) await page.getByTestId(`recipe-confirm-${role}`).check()
    await page.getByTestId('create-variant-recipe').click()
    await page.locator('[data-testid^="variant-recipe-recipe"], [data-testid^="variant-recipe-variant"]').first().waitFor({ timeout: 60_000 })
    const requiredRecipes = await (await fetch(`${baseUrl}/v1/batches/${required.batchId}/variant-recipes`, { headers: { authorization } })).json()
    assert.equal(requiredRecipes.data.recipes[0].summary.includesProof, true)
    assert.equal(requiredRecipes.data.recipes[0].proofPolicy.effectiveRequirement, 'required')
    assert.equal(requiredRecipes.data.recipes[0].proofPolicy.reasonCode, 'PROOF_REQUIRED_BY_OBJECTIVE')
    await shot('14-lotes-receita-com-prova-obrigatoria.png')
  } catch (error) {
    if (shots) {
      const visible = await page?.locator('body').innerText().catch(() => '(page text unavailable)')
      await page?.screenshot({ path: join(shots, 'failure-recipe-path.png') }).catch(() => undefined)
      writeFileSync(join(shots, 'failure-recipe-path.txt'), ['page text', String(visible).slice(0, 3000), 'exchanges', ...exchanges.slice(-30), 'server log tail', serverLogs.slice(-3000), 'error', String(error?.stack ?? error)].join('\n'))
    }
    throw error
  } finally {
    if (browser) await browser.close()
    await stop(server)
    await rm(root, { recursive: true, force: true })
    await prisma.$disconnect()
  }
})

/** The node ids the three selects of the page hold, read from the page. */
async function nodeIds(page, roles) {
  return Object.fromEntries(await Promise.all(roles.map(async (role) => [role, await page.getByTestId(`recipe-pick-${role}`).inputValue()])))
}
async function selectionOf(page) {
  const ids = await nodeIds(page, ['hook', 'body', 'cta'])
  return { hookNodeId: ids.hook, bodyNodeId: ids.body, ctaNodeId: ids.cta }
}
async function orderedOf(page) {
  const ids = await nodeIds(page, ['hook', 'body', 'cta'])
  return [ids.hook, ids.body, ids.cta]
}
