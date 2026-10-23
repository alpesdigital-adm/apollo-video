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
import { startBriefInterpreterStandIn } from './helpers/brief-interpreter-stand-in.mjs'

/**
 * ADR-160 F7/F8, in a real browser against the production build. The two screens that take the request of a video ask for a briefing and pre-fill
 * nothing: no objective, no language, no format, no recipe, no formats on the batch, no cost; the guidance is topics only. After the project is saved,
 * the Apollo shows how it read the briefing, and a question left open says the Director is blocked until it is answered. The interpreter is the
 * local stand-in of the provider (never the real Codex). Screenshots go to APOLLO_E2E_SCREENSHOT_DIR when it is set.
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

const PROJECT_BRIEFING = 'texto do pedido do projeto de teste'
const BATCH_BRIEFING = 'texto do pedido do lote de teste'

const enabled = process.env.APOLLO_BRIEFING_SCREENS_E2E === '1'

test('project creation and Lotes ask for a briefing and pre-fill nothing; the reading is shown and an open question blocks the Director', { skip: !enabled && 'set APOLLO_BRIEFING_SCREENS_E2E=1 and use an isolated V2 database', timeout: 280_000 }, async () => {
  assertIsolatedDatabase()
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-briefing-screens-'))
  const shots = process.env.APOLLO_E2E_SCREENSHOT_DIR
  if (shots) mkdirSync(shots, { recursive: true })
  // The provider of the interpreter is a local stand-in (the real OpenAI adapter, no network, no credential, no Codex).
  const fake = await startBriefInterpreterStandIn()
  const answers = {
    ...{
      [PROJECT_BRIEFING]: {
        directives: [{ kind: 'layout', value: 'source-native', param: null, quote: 'pedido' }],
        unsupported: [],
        questions: [{ question: 'O vídeo deve manter o enquadramento da gravação ou usar um fundo?', quote: 'projeto' }],
        coverage: [{ topic: 'audience', quote: 'teste' }],
      },
      [BATCH_BRIEFING]: {
        directives: [{ kind: 'movement', value: 'zoom-in', param: null, quote: 'lote' }],
        unsupported: [],
        questions: [{ question: 'Qual é o idioma da fala?', quote: 'pedido' }],
        coverage: [{ topic: 'audience', quote: 'teste' }],
      },
    },
  }
  for (const [briefing, answer] of Object.entries(answers)) fake.script.set(briefing, answer)
  let fixture, browser, server, page
  const exchanges = []
  let serverLogs = ''
  try {
    // A clean workspace with an API client, and in it a project that has a briefing and a montage (the Version a briefing is read on).
    const { createWorkspaceRow, issueApiClient } = await import('./helpers/capture-journey.mjs')
    const { seedSealedProject, testActor } = await import('./helpers/pg-output-world.mjs')
    const { seedDirectedProject } = await import('./helpers/dashboard-w34-35-fixtures.mjs')
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const workspaceId = `screens-${suffix}-ws`
    const clientId = `screens-${suffix}-client`
    const now = new Date()
    await createWorkspaceRow({ prisma, workspaceId, name: 'Workspace do teste de tela', createdAt: now })
    const issued = await issueApiClient({
      prisma, workspaceId, clientId, name: 'Teste de tela', createdAt: now,
      scopes: ['projects:read', 'projects:write', 'projects:approve'],
    })
    const credentialId = `${clientId}-screens`
    const worldActor = testActor({ workspaceId, clientId, credentialId, environment: 'production', scopes: ['projects:write', 'projects:read', 'media:write'] })
    const world = await seedSealedProject(prisma, { workspaceId, actor: worldActor, prefix: 'screens', name: 'Projeto com montagem', briefing: PROJECT_BRIEFING })
    const directed = await seedDirectedProject(prisma, {
      workspaceId, clientId, credentialId, environment: 'production', projectId: world.projectId, suffix: `screens${suffix.slice(0, 8)}`, directed: false,
      words: [{ word: 'Primeira', start: 0.2, end: 0.7 }, { word: 'frase', start: 0.7, end: 1.1 }, { word: 'termina', start: 1.1, end: 1.6 }, { word: 'aqui.', start: 1.6, end: 2.0 }],
    })
    fixture = { suffix, workspaceId, clientId, issued, projectId: world.projectId, artifactId: directed.source.artifactId }
    const username = `briefing-ui-${fixture.suffix}`
    const password = `Briefing-${fixture.suffix}-secure`
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
        APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(password, `briefing-salt-${fixture.suffix}`),
        APOLLO_UI_SESSION_SECRET: `briefing-session-${fixture.suffix}-at-least-32-bytes`,
        APOLLO_UI_API_CLIENT_ID: fixture.issued.client.id,
        APOLLO_V2_ARTIFACT_ROOT: root,
        APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        // The briefing is read through the local stand-in of the provider, never the real Codex or a real account.
        ...fake.environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)

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
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
    context.setDefaultTimeout(20_000)
    context.setDefaultNavigationTimeout(30_000)
    page = await context.newPage()
    const posts = []
    page.on('response', (response) => {
      const url = new URL(response.url())
      if (url.origin === baseUrl && url.pathname.startsWith('/v1/')) exchanges.push(response.request().method() + ' ' + url.pathname + ' ' + response.status())
    })
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.origin === baseUrl && request.method() === 'POST' && url.pathname.startsWith('/v1/')) posts.push(url.pathname)
    })
    const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, name), fullPage: false }) }
    const authorization = `Bearer ${fixture.issued.token}`

    await page.goto(`${baseUrl}/login?next=${encodeURIComponent('/')}`)
    await page.locator('input[name="username"]').fill(username)
    await page.locator('input[name="password"]').fill(password)
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    await page.waitForURL((url) => url.pathname === '/')

    // ---- 1. project creation: nothing is pre-filled ----
    await page.getByRole('button', { name: /Novo projeto/ }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await dialog.locator('button[aria-pressed="true"]').count(), 0, 'no objective is pre-selected')
    assert.equal(await dialog.locator('select').inputValue(), '', 'the language is empty by default')
    assert.match(await dialog.textContent(), /Se você não informar, o Apollo detecta o idioma pela fala/)
    assert.equal(await dialog.getByText(/Formato de saída/).count(), 0, 'no format is chosen here')
    assert.equal(await dialog.getByText(/9:16/).count(), 0)
    const briefingField = dialog.locator('#project-briefing')
    assert.equal(await briefingField.inputValue(), '')
    assert.equal(await briefingField.getAttribute('placeholder'), null, 'the briefing field has no placeholder')
    assert.equal(await briefingField.getAttribute('aria-required'), 'true')
    const guidance = dialog.getByTestId('briefing-guidance')
    for (const topic of ['Público', 'Objetivo', 'O que manter ou remover', 'Idioma', 'Formato', 'Ritmo']) assert.match(await guidance.textContent(), new RegExp(topic))
    assert.equal(await dialog.locator('input[placeholder^="Ex."]').count(), 0, 'no example placeholder')
    await shot('01-projeto-novo-vazio.png')

    // The briefing is required and any text is valid: the objective too is the owner's choice, and nothing is sent before both exist.
    await dialog.getByLabel('Nome da produção').fill('Projeto do teste de tela')
    await dialog.getByRole('button', { name: 'Criar e continuar' }).click()
    await dialog.getByTestId('project-composer-notice').waitFor()
    assert.match(await dialog.getByTestId('project-composer-notice').textContent(), /Escolha o que este vídeo precisa provocar/)
    await dialog.locator('fieldset button[aria-pressed]').first().click()
    await dialog.getByRole('button', { name: 'Criar e continuar' }).click()
    await dialog.locator('#project-briefing-error').waitFor()
    assert.match(await dialog.locator('#project-briefing-error').textContent(), /Escreva o briefing/)
    assert.equal(await briefingField.getAttribute('aria-invalid'), 'true')
    assert.equal(posts.filter((path) => path === '/v1/projects').length, 0, 'nothing was sent without a briefing')
    await shot('02-projeto-briefing-obrigatorio.png')

    // A one-line briefing is a briefing. Saving the project shows the screen that reads it. A project that was just created has no output and no
    // montage yet, and the reading of a briefing is a Command on a Version that has both: the screen says so and keeps the text, and the Director stays blocked.
    const unreadBriefing = 'um briefing de uma linha'
    await briefingField.fill(unreadBriefing)
    await dialog.getByRole('button', { name: 'Criar e continuar' }).click()
    await dialog.getByTestId('project-created-step').waitFor()
    const freshBlock = dialog.getByTestId('editorial-request-block')
    await dialog.getByTestId('editorial-request-error').waitFor({ timeout: 60_000 })
    assert.match(await dialog.getByTestId('editorial-request-error').textContent(), /ainda não tem um vídeo e uma saída/)
    assert.equal(await freshBlock.getAttribute('data-blocks-director'), 'true')
    assert.match(await freshBlock.textContent(), /O Diretor está bloqueado: o Apollo ainda não leu o seu briefing/)
    assert.match(await dialog.getByTestId('editorial-request-briefing').textContent(), /um briefing de uma linha/)
    assert.equal(fake.calls.length, 0, 'nothing was read yet')
    await shot('03-projeto-criado-briefing-ainda-nao-lido.png')
    const projects = await (await fetch(`${baseUrl}/v1/projects?text=${encodeURIComponent('Projeto do teste de tela')}`, { headers: { authorization } })).json()
    const created = projects.data.projects.find((project) => project.name === 'Projeto do teste de tela')
    assert.ok(created, 'the project exists')
    assert.equal(created.locale, undefined, 'the project states no language: none was chosen')
    const stored = await (await fetch(`${baseUrl}/v1/projects/${created.id}/editorial-request`, { headers: { authorization } })).json()
    assert.equal(stored.data.state, 'awaiting-interpretation')
    assert.equal(stored.data.request.briefing.text, unreadBriefing, 'the text is saved exactly as written')
    await dialog.getByRole('button', { name: 'Abrir o projeto' }).click()
    await page.waitForURL(`**/projects/${created.id}`)

    // A project that has a montage: the owner reads the briefing from its page, answers the question, and the Director is released.
    await page.goto(`${baseUrl}/projects/${world.projectId}`)
    const requestPanel = page.getByTestId('project-editorial-request')
    await requestPanel.waitFor()
    const block = requestPanel.getByTestId('editorial-request-block')
    assert.match(await block.textContent(), /O Diretor está bloqueado: o Apollo ainda não leu o seu briefing/)
    await shot('04-projeto-pagina-briefing-nao-lido.png')
    await requestPanel.getByRole('button', { name: 'Ler o briefing agora' }).click()
    await requestPanel.getByTestId('editorial-request-questions').waitFor({ timeout: 60_000 })
    assert.equal(await block.getAttribute('data-blocks-director'), 'true')
    assert.match(await block.textContent(), /O Diretor está bloqueado até você responder a pergunta/)
    assert.match(await requestPanel.getByTestId('editorial-request-directives').textContent(), /Enquadramento: formato da gravação/)
    assert.match(await requestPanel.getByTestId('editorial-request-directives').textContent(), /Trecho do briefing: “pedido”/)
    assert.equal(fake.calls.length, 1, 'the briefing was read once')
    await requestPanel.getByTestId('editorial-request-questions').scrollIntoViewIfNeeded()
    await shot('05-projeto-leitura-com-pergunta.png')
    const before = await (await fetch(`${baseUrl}/v1/projects/${world.projectId}/editorial-request`, { headers: { authorization } })).json()
    assert.equal(before.data.blocksDirector, true)
    assert.equal(before.data.openQuestions.length, 1)

    await requestPanel.getByLabel(/O vídeo deve manter o enquadramento/).fill('Manter o enquadramento da gravação.')
    await requestPanel.getByRole('button', { name: 'Enviar respostas' }).click()
    await block.filter({ hasText: 'o Diretor está liberado' }).waitFor()
    assert.equal(await block.getAttribute('data-blocks-director'), 'false')
    assert.match(await requestPanel.getByTestId('editorial-request-answered').textContent(), /Sua resposta: Manter o enquadramento da gravação\./)
    await shot('06-projeto-pergunta-respondida.png')
    const after = await (await fetch(`${baseUrl}/v1/projects/${world.projectId}/editorial-request`, { headers: { authorization } })).json()
    assert.equal(after.data.blocksDirector, false)
    assert.equal(after.data.interpretation.questions[0].answer, 'Manter o enquadramento da gravação.')
    assert.equal(fake.calls.length, 1, 'answering never reads the briefing again')

    // ---- 2. Lotes: nothing is pre-filled either ----
    await page.goto(`${baseUrl}/batches`)
    await page.getByRole('button', { name: /Planejar lote/ }).first().click()
    const composer = page.getByRole('dialog')
    await composer.waitFor({ state: 'visible' })
    assert.equal(await composer.locator('#batch-briefing').inputValue(), '')
    assert.equal(await composer.locator('#batch-briefing').getAttribute('placeholder'), null)
    assert.equal(await composer.getByTestId('briefing-guidance').count(), 1)
    assert.equal(await composer.locator('button[aria-pressed="true"]').count(), 0, 'no format is chosen')
    assert.equal(await composer.locator('select').nth(1).inputValue(), '', 'the language of the outputs is empty')
    assert.equal(await composer.locator('input[type="number"]').inputValue(), '', 'the cost cap is empty')
    assert.equal(await composer.locator('textarea').nth(1).inputValue(), '', 'there is no recipe')
    assert.equal(await composer.locator('input[placeholder^="Ex."], textarea[placeholder]').count(), 0, 'no placeholder with a sentence')
    await shot('07-lotes-novo-vazio.png')
    await composer.locator('select').first().selectOption(fixture.projectId)
    await composer.getByLabel('Nome do lote').fill('Lote do teste de tela')
    await composer.getByRole('button', { name: /^Criar \d+ saída/ }).click()
    await composer.locator('#batch-briefing-error').waitFor()
    assert.match(await composer.locator('#batch-briefing-error').textContent(), /Escreva o briefing/)
    assert.match(await composer.getByTestId('batch-composer-notice').textContent(), /Escreva o briefing/)
    assert.equal(posts.filter((path) => path === '/v1/batches').length, 0, 'nothing was sent without a briefing')
    await shot('08-lotes-briefing-obrigatorio.png')
    await page.keyboard.press('Escape')

    // A batch made through the API (the briefing is read once, at creation) shows its request on the screen.
    const listBefore = await fetch(`${baseUrl}/v1/batches`, { headers: { authorization } })
    exchanges.push(`api list before ${listBefore.status} ${(await listBefore.text()).slice(0, 300)}`)
    assert.equal(listBefore.status, 200, 'the workspace lists its batches before this one exists')
    const batchResponse = await fetch(`${baseUrl}/v1/batches`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `batch-screens-${fixture.suffix}` },
      body: JSON.stringify({
        projectId: fixture.projectId, name: 'Lote do teste de tela', objective: 'content-distribution', briefing: BATCH_BRIEFING,
        sourceGroups: [{ id: 'group-a', name: 'Grupo A', sourceArtifactIds: [fixture.artifactId] }],
        recipes: [{ id: 'recipe-a', name: 'Receita A', sourceGroupIds: ['group-a'] }],
        variants: [{ id: 'variant-a', name: 'Variante A', outputSpecId: 'spec-a', locale: 'pt-BR' }],
        budget: { currency: 'USD', maxCostMinorUnits: 1000, reservedCostMinorUnits: 0 },
        items: [{ key: 'item-a', sourceGroupId: 'group-a', recipeId: 'recipe-a', variantId: 'variant-a' }],
      }),
    })
    const batchPayload = await batchResponse.json()
    assert.equal(batchResponse.status, 201, JSON.stringify(batchPayload))
    assert.equal('editorialRequest' in batchPayload.data.batch, false, 'the batch document does not carry its request')
    const batchRequest = await (await fetch(`${baseUrl}/v1/batches/${batchPayload.data.batch.id}/editorial-request`, { headers: { authorization } })).json()
    assert.equal(batchRequest.data.state, 'interpreted')
    assert.equal(batchRequest.data.request.briefing.text, BATCH_BRIEFING)
    await page.goto(`${baseUrl}/batches`)
    await page.getByText('Lote do teste de tela').first().click()
    const section = page.getByTestId('batch-request-section')
    await section.waitFor()
    await page.getByTestId('batch-request-panel').waitFor()
    assert.match(await section.textContent(), /1 ponto em dúvida/)
    assert.match(await page.getByTestId('batch-request-briefing').textContent(), /texto do pedido do lote de teste/)
    assert.match(await page.getByTestId('batch-request-questions').textContent(), /Qual é o idioma da fala\?/)
    assert.match(await page.getByTestId('batch-request-unsupported').textContent(), /O Apollo entendeu, mas ainda não consegue executar este pedido/)
    await section.scrollIntoViewIfNeeded()
    await shot('09-lotes-pedido-do-lote.png')
  } catch (error) {
    if (shots) {
      const visible = await page?.locator('body').innerText().catch(() => '(page text unavailable)')
      await page?.screenshot({ path: join(shots, 'failure.png') }).catch(() => undefined)
      writeFileSync(join(shots, 'failure.txt'), ['page text', String(visible).slice(0, 3000), 'interpreter calls ' + fake.calls.length, 'exchanges', ...exchanges.slice(-30), 'server log tail', serverLogs.slice(-3000), 'error', String(error?.stack ?? error)].join(String.fromCharCode(10)))
    }
    throw error
  } finally {
    if (browser) await browser.close()
    await stop(server)
    await fake.close()
    await rm(root, { recursive: true, force: true })
    await prisma.$disconnect()
  }
})
