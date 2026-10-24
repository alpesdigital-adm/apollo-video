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
const CREATED_BRIEFING = 'briefing de uma linha do projeto novo'
const BATCH_BRIEFING = 'texto do pedido do lote de teste'
const BATCH_BRIEFING_CHANGED = 'novo texto do lote depois da resposta'

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
      // The briefing says two things about the frame: the Apollo asks which one, with both as choices. It also asks one question of its own.
      [PROJECT_BRIEFING]: {
        directives: [{ kind: 'layout', value: 'source-native', param: null, quote: 'pedido' }, { kind: 'layout', value: 'fit-with-backdrop', param: null, quote: 'projeto' }],
        unsupported: [],
        questions: [{ question: 'Qual é o idioma da fala?', quote: 'teste' }],
        coverage: [{ topic: 'audience', quote: 'teste' }],
      },
      [CREATED_BRIEFING]: {
        directives: [],
        unsupported: [],
        questions: [{ question: 'Qual é o idioma da fala?', quote: 'linha' }],
        coverage: [{ topic: 'audience', quote: 'projeto' }],
      },
      [BATCH_BRIEFING_CHANGED]: { directives: [], unsupported: [], questions: [], coverage: [{ topic: 'audience', quote: 'texto' }] },
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
    const { STRATEGIC_OBJECTIVES } = await import('../../src/v2/domain/strategic-objective.ts')
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
    assert.match(await dialog.getByTestId('project-objective-none').textContent(), /o Apollo não presume um/)
    assert.match(await dialog.textContent(), /Se não escolher, o Apollo não presume um objetivo/)
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

    // Every field that is wrong is told at once, the first one gets the focus, and nothing is sent. The objective is optional: nothing asks for it.
    await dialog.getByRole('button', { name: 'Criar e continuar' }).click()
    await dialog.locator('#project-name-error').waitFor()
    await dialog.locator('#project-briefing-error').waitFor()
    assert.match(await dialog.locator('#project-name-error').textContent(), /pelo menos 2 caracteres/)
    assert.match(await dialog.locator('#project-briefing-error').textContent(), /Escreva o briefing/)
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'project-name', 'the first invalid field has the focus')
    assert.equal(await dialog.getByTestId('project-composer-notice').count(), 0, 'no generic notice: the errors are on the fields')
    await dialog.getByLabel('Nome da produção').fill('Projeto do teste de tela')
    await dialog.getByRole('button', { name: 'Criar e continuar' }).click()
    await dialog.locator('#project-briefing-error').waitFor()
    assert.equal(await dialog.locator('#project-name-error').count(), 0)
    assert.equal(await briefingField.getAttribute('aria-invalid'), 'true')
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'project-briefing')
    assert.equal(posts.filter((path) => path === '/v1/projects').length, 0, 'nothing was sent without a briefing')
    await shot('02-projeto-briefing-obrigatorio.png')

    // A one-line briefing is a briefing. The briefing is read when the project is saved: the screen that follows shows what the Apollo understood, what it
    // does not do and the question, and says the Director is blocked. The question is answered on the page of the project, once it has an output.
    await briefingField.fill(CREATED_BRIEFING)
    await dialog.getByRole('button', { name: 'Criar e continuar' }).click()
    await dialog.getByTestId('project-created-step').waitFor()
    const freshBlock = dialog.getByTestId('editorial-request-block')
    await dialog.getByTestId('editorial-request-questions').waitFor({ timeout: 60_000 })
    // The project has no output yet: the briefing cannot be read again or changed from here, and the screen says why.
    assert.match(await dialog.getByTestId('editorial-request-needs-output-note').textContent(), /ainda não tem um vídeo e uma saída/)
    assert.equal(await dialog.getByRole('button', { name: 'Mudar o briefing' }).isDisabled(), true)
    assert.equal(await freshBlock.getAttribute('data-blocks-director'), 'true')
    assert.match(await freshBlock.textContent(), /O Diretor está bloqueado até você responder a pergunta/)
    assert.match(await dialog.getByTestId('editorial-request-briefing').textContent(), /briefing de uma linha do projeto novo/)
    assert.match(await dialog.getByTestId('editorial-request-answers-later').textContent(), /na página do projeto/)
    assert.match(await dialog.getByTestId('editorial-request-coverage').textContent(), /Público: “projeto”/)
    assert.equal(await dialog.getByTestId('editorial-request-error').count(), 0, 'nothing failed: the briefing was read')
    assert.equal(fake.calls.length, 1, 'the briefing was read once, when the project was saved')
    await shot('03-projeto-criado-leitura-logo-apos-salvar.png')
    const projects = await (await fetch(`${baseUrl}/v1/projects?text=${encodeURIComponent('Projeto do teste de tela')}`, { headers: { authorization } })).json()
    const created = projects.data.projects.find((project) => project.name === 'Projeto do teste de tela')
    assert.ok(created, 'the project exists')
    assert.equal(created.locale, undefined, 'the project states no language: none was chosen')
    assert.equal(created.objective, undefined, 'the project states no objective: none was chosen, and the Apollo presumes none')
    const stored = await (await fetch(`${baseUrl}/v1/projects/${created.id}/editorial-request`, { headers: { authorization } })).json()
    assert.equal(stored.data.state, 'interpreted')
    assert.equal(stored.data.request.briefing.text, CREATED_BRIEFING, 'the text is saved exactly as written')
    assert.equal(stored.data.blocksDirector, true)
    await dialog.getByRole('button', { name: 'Abrir o projeto' }).click()
    await page.waitForURL(`**/projects/${created.id}`)

    // A project that has a montage and an unread briefing: the owner reads it from its page, answers a closed question by choosing and an open one in
    // words, and the Director is released.
    await page.goto(`${baseUrl}/projects/${world.projectId}`)
    const requestPanel = page.getByTestId('project-editorial-request')
    await requestPanel.waitFor()
    const block = requestPanel.getByTestId('editorial-request-block')
    assert.match(await block.textContent(), /O Diretor está bloqueado: o Apollo ainda não leu o seu briefing/)
    await shot('04-projeto-pagina-briefing-nao-lido.png')
    await requestPanel.getByRole('button', { name: 'Ler o briefing agora' }).click()
    await requestPanel.getByTestId('editorial-request-questions').waitFor({ timeout: 60_000 })
    assert.equal(await block.getAttribute('data-blocks-director'), 'true')
    assert.match(await block.textContent(), /O Diretor está bloqueado até você responder as 2 perguntas/)
    assert.equal(fake.calls.length, 2, 'the briefing was read once more, on request')
    const closed = requestPanel.locator('fieldset[data-testid^="question-choices-"]')
    assert.equal(await closed.count(), 1, 'the question with closed answers offers them as choices')
    assert.equal(await closed.getByRole('radio').count(), 2)
    assert.equal(await requestPanel.locator('textarea[id^="answer-"]').count(), 1, 'the open question is answered in words')
    await requestPanel.getByTestId('editorial-request-questions').scrollIntoViewIfNeeded()
    // The choices follow the width of their own column (about 200 px here), never the window: each is whole, one under the other, and readable.
    for (const label of await closed.locator('label').all()) {
      const box = await label.boundingBox()
      assert.ok(box.width >= 150, `a choice is squeezed to ${box.width}px`)
      assert.equal(await label.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'the text of a choice is cut')
      assert.equal(await label.locator('span').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true)
    }
    await shot('05-projeto-leitura-escolha-e-texto.png')
    const before = await (await fetch(`${baseUrl}/v1/projects/${world.projectId}/editorial-request`, { headers: { authorization } })).json()
    assert.equal(before.data.blocksDirector, true)
    assert.equal(before.data.openQuestions.length, 2)
    assert.equal(before.data.request.directives.length, 0, 'neither conflicting directive was picked for the owner')

    await closed.getByRole('radio').nth(1).check()
    await requestPanel.locator('textarea[id^="answer-"]').fill('Português do Brasil.')
    await requestPanel.getByRole('button', { name: 'Enviar respostas' }).click()
    await block.filter({ hasText: 'o Diretor está liberado' }).waitFor()
    assert.equal(await block.getAttribute('data-blocks-director'), 'false')
    assert.match(await requestPanel.getByTestId('editorial-request-answered').textContent(), /Sua resposta: Português do Brasil\./)
    await shot('06-projeto-perguntas-respondidas.png')
    const after = await (await fetch(`${baseUrl}/v1/projects/${world.projectId}/editorial-request`, { headers: { authorization } })).json()
    assert.equal(after.data.blocksDirector, false)
    assert.match(after.data.request.directives[0].id, /^answer-q\d+$/, 'the choice became the directive of the revision')
    assert.equal(after.data.interpretation.questions.every((question) => question.status === 'answered'), true)
    assert.equal(fake.calls.length, 2, 'answering never reads the briefing again')

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
        projectId: fixture.projectId, name: 'Lote do teste de tela', objective: 'discovery', briefing: BATCH_BRIEFING,
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

    // The request of the batch blocks its generation, and the owner answers it and changes its briefing on this screen.
    const batchId = batchPayload.data.batch.id
    const requestBlock = page.getByTestId('batch-request-block')
    assert.equal(await requestBlock.getAttribute('data-blocks-generation'), 'true')
    assert.match(await requestBlock.textContent(), /O lote não será gerado enquanto isto não for resolvido/)
    const startItem = (key) => fetch(`${baseUrl}/v1/batches/${batchId}/items/${batchPayload.data.batch.items[0].id}/actions`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ action: 'start-step', step: 'planning', expectedBatchRevision: batchPayload.data.batch.revision, expectedItemRevision: batchPayload.data.batch.items[0].revision }),
    })
    const refusedStart = await startItem(`batch-start-refused-${fixture.suffix}`)
    assert.equal(refusedStart.status, 428)
    assert.equal((await refusedStart.json()).error.details.reason, 'editorial-request-blocked')
    await shot('15-lotes-pedido-bloqueia-a-geracao.png')
    await page.locator('#answer-q1').fill('Português do Brasil.')
    await page.getByTestId('batch-request-send-answers').click()
    await page.getByTestId('batch-request-answered').waitFor()
    assert.match(await page.getByTestId('batch-request-answered').textContent(), /Sua resposta: Português do Brasil./)
    assert.equal(await requestBlock.getAttribute('data-blocks-generation'), 'true', 'the zoom is still something the Apollo does not do')
    assert.ok((await page.getByTestId("batch-request-unsupported").textContent()).includes("Zoom (o Apollo ainda não aplica zoom)"))
    await shot('16-lotes-pedido-respondido-ainda-bloqueado.png')
    await page.getByTestId('batch-request-change').click()
    await page.getByTestId('batch-request-draft').fill(BATCH_BRIEFING_CHANGED)
    await page.getByTestId('batch-request-save').click()
    await page.locator('[data-testid="batch-request-block"][data-blocks-generation="false"]').waitFor({ timeout: 60_000 })
    assert.match(await page.getByTestId('batch-request-briefing').textContent(), /novo texto do lote depois da resposta/)
    assert.match(await page.getByTestId('batch-request-revision').textContent(), /2 vezes/)
    assert.equal(fake.calls.filter((call) => call.briefing === BATCH_BRIEFING_CHANGED).length, 1, 'the new briefing was read once')
    await shot('17-lotes-pedido-liberado.png')
    const released = await startItem(`batch-start-released-${fixture.suffix}`)
    assert.equal(released.status, 201, JSON.stringify(await released.json()))

    // ---- 3. A project made without an objective: the page says the Director waits for one, and the selector DEFINES it (the same revision the API
    // and the MCP use); once defined, the page shows it in words and the Director is no longer waiting. ----
    const bare = await seedSealedProject(prisma, { workspaceId, actor: worldActor, prefix: 'bare', name: 'Projeto sem objetivo', objective: null })
    await page.goto(`${baseUrl}/projects/${bare.projectId}`)
    const governance = page.getByTestId('director-objective-governance')
    await governance.waitFor()
    const define = page.getByTestId('project-objective-define')
    assert.match(await define.textContent(), /O Diretor espera por ele/)
    assert.equal(await page.getByTestId('project-objective-define-button').isDisabled(), true, 'nothing to define until the owner chooses')
    assert.match(await page.locator('dl').first().textContent(), /Ainda não definido/)
    await shot('18-projeto-sem-objetivo-diretor-espera.png')
    await governance.locator('select').selectOption({ label: STRATEGIC_OBJECTIVES.find((item) => item.id === 'awareness').label })
    await page.getByTestId('project-objective-define-button').click()
    await define.waitFor({ state: 'detached', timeout: 60_000 })
    const defined = await (await fetch(`${baseUrl}/v1/projects/${bare.projectId}/editorial-request`, { headers: { authorization } })).json()
    assert.equal(defined.data.request.objective, 'awareness')
    assert.match(await page.locator('dl').first().textContent(), new RegExp(STRATEGIC_OBJECTIVES.find((item) => item.id === 'awareness').label))
    assert.doesNotMatch(await page.locator('dl').first().textContent(), /awareness/, 'the objective is shown in words, never as its id')
    await shot('19-projeto-objetivo-definido.png')

    // ---- 4. The cut as a PASSAGE (ADR-160): the Director asks to confirm the whole stretch of speech that talks about the subject, the owner reads it whole with the
    // mentions marked, moves where it starts and ends among the places the Apollo offers, and what is shown is EXACTLY what will be cut (extended or shortened);
    // what the screen sends is the subject, the seal of what was shown and that adjustment, never the words. ----
    const CUT_BRIEFING = 'tire o trecho sobre vender'
    fake.script.set(CUT_BRIEFING, { directives: [{ kind: 'remove-speech', value: 'about', param: 'vender', quote: 'tire o trecho sobre vender' }], unsupported: [], questions: [], coverage: [] })
    const cutSentences = [
      [0, 2, 'Bem-vindos ao curso.'], [2, 3, 'Hoje falamos de tudo,'], [3, 4, 'e de como vender melhor.'], [4, 6, 'Vender bem exige confiança.'],
      [6, 8, 'O produto foi vendido'], [8, 9, 'ontem.'], [9, 11, 'Agora vamos ao conteúdo.'],
    ]
    const cutWords = cutSentences.flatMap(([start, end, text]) => {
      const spoken = text.replace(/[.,]/gu, '').split(' ')
      const step = (end - start) / spoken.length
      return spoken.map((word, index) => ({ word, start: Math.round((start + index * step) * 1000) / 1000, end: Math.round((start + (index + 1) * step - 0.02) * 1000) / 1000 }))
    })
    const cutWorld = await seedSealedProject(prisma, { workspaceId, actor: worldActor, prefix: 'cut', name: 'Projeto com um trecho a cortar', briefing: CUT_BRIEFING })
    await seedDirectedProject(prisma, {
      workspaceId, clientId, credentialId, environment: 'production', projectId: cutWorld.projectId, suffix: `cut${suffix.slice(0, 8)}`, directed: false,
      words: cutWords, segments: cutSentences.map(([start, end, text], id) => ({ id, start, end, text })),
    })
    const cutHeadRow = await prisma.v2ProjectVersion.findUniqueOrThrow({ where: { id: (await prisma.v2Project.findUniqueOrThrow({ where: { id: cutWorld.projectId } })).currentVersionId } })
    const cutRead = await fetch(`${baseUrl}/v1/projects/${cutWorld.projectId}/editorial-request`, {
      method: 'POST', headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `cut-read-${fixture.suffix}` },
      body: JSON.stringify({ baseVersionId: cutHeadRow.id, baseHash: cutHeadRow.baseHash, briefing: CUT_BRIEFING, reason: 'Ler o briefing.' }),
    })
    assert.equal(cutRead.status, 201, JSON.stringify(await cutRead.json()))
    let sentToConfirm = null
    await page.route('**/v1/projects/*/speech-removals', async (route) => {
      sentToConfirm = route.request().postDataJSON()
      // The real confirmation is proved against PostgreSQL elsewhere; here the screen is what is under test, so nothing is cut.
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'VERSION_CONFLICT', message: 'A confirmação não foi enviada de verdade neste teste.' } }) })
    })
    await page.goto(`${baseUrl}/projects/${cutWorld.projectId}`)
    await page.getByRole('button', { name: /Executar Diretor V2/ }).click()
    const confirmation = page.getByTestId('speech-cut-confirmation')
    await confirmation.waitFor({ timeout: 60_000 })
    const passageBox = confirmation.getByTestId('speech-cut-passage')
    assert.equal(await passageBox.count(), 1, 'the sentences that say the subject, and the ones between them, are ONE passage')
    const shownText = async () => (await passageBox.getByTestId('speech-cut-passage-text').textContent())
    const shownMarks = async () => passageBox.locator('mark').allTextContents()
    const PROPOSED = 'Hoje falamos de tudo, e de como vender melhor. Vender bem exige confiança. O produto foi vendido ontem.'
    assert.equal(await shownText(), PROPOSED)
    assert.deepEqual(await shownMarks(), ['vender', 'Vender', 'vendido'], 'the words of the subject are marked')
    assert.match(await passageBox.textContent(), /Trecho 1 de 1: 2,0 s a 9,0 s/)
    assert.match(await passageBox.getByTestId('speech-cut-passage-state').textContent(), /como o Apollo propôs/)
    assert.equal(await confirmation.getByTestId('speech-cut-notice').count(), 0, 'the language is known: nothing to warn about')
    // One passage: nothing to keep on purpose (the choice appears when there are several).
    assert.equal(await passageBox.getByTestId('speech-cut-keep').count(), 0)
    const startSelect = passageBox.getByTestId('speech-cut-start')
    const endSelect = passageBox.getByTestId('speech-cut-end')
    const startOptions = await startSelect.locator('option').allTextContents()
    assert.equal(startOptions.length, 3, startOptions.join(' | '))
    assert.match(startOptions[0], /Bem-vindos ao curso/)
    const endOptions = await endSelect.locator('option').allTextContents()
    assert.equal(endOptions.length, 3, endOptions.join(' | '))
    assert.match(endOptions[0], /O produto foi vendido/)
    assert.ok(await startSelect.evaluate((element) => element.offsetHeight >= 44), 'a touch-sized control')
    await shot('20-trecho-da-fala-proposto.png')
    // Confirming without moving anything sends the subject and the seal only.
    sentToConfirm = null
    await Promise.all([page.waitForResponse((response) => response.url().includes('/speech-removals')), confirmation.getByRole('button', { name: 'Confirmar corte' }).click()])
    assert.equal(sentToConfirm.subject, 'vender')
    assert.match(sentToConfirm.proposalHash, /^[a-f0-9]{64}$/, 'the seal of what was shown goes back with the confirmation')
    assert.equal('adjustments' in sentToConfirm, false, 'nothing was moved: the passage is the proposed one')
    assert.equal('rules' in sentToConfirm || 'alternatives' in sentToConfirm, false, 'the screen never sends the words of the cut')
    // EXTENDING: the text shown is the text of the bounds chosen - the sentence before is read now, and it is what is cut.
    await startSelect.selectOption({ index: 0 })
    assert.match(await passageBox.getByTestId('speech-cut-passage-state').textContent(), /Você mudou este trecho/)
    assert.match(await passageBox.textContent(), /Trecho 1 de 1: 0,0 s a 9,0 s/)
    assert.equal(await shownText(), `Bem-vindos ao curso. ${PROPOSED}`)
    assert.deepEqual(await shownMarks(), ['vender', 'Vender', 'vendido'])
    await shot('21-trecho-da-fala-ajustado.png')
    // SHORTENING at the start and at the end: what drops out of the bounds drops out of the text.
    await startSelect.selectOption('3')
    assert.equal(await shownText(), 'e de como vender melhor. Vender bem exige confiança. O produto foi vendido ontem.')
    await endSelect.selectOption('8')
    assert.equal(await shownText(), 'e de como vender melhor. Vender bem exige confiança. O produto foi vendido')
    assert.match(await passageBox.textContent(), /Trecho 1 de 1: 3,0 s a 8,0 s/)
    assert.deepEqual(await shownMarks(), ['vender', 'Vender', 'vendido'])
    // EXTENDING at the end.
    await endSelect.selectOption('11')
    assert.equal(await shownText(), 'e de como vender melhor. Vender bem exige confiança. O produto foi vendido ontem. Agora vamos ao conteúdo.')
    await endSelect.selectOption('8')
    sentToConfirm = null
    await Promise.all([page.waitForResponse((response) => response.url().includes('/speech-removals')), confirmation.getByRole('button', { name: 'Confirmar corte' }).click()])
    assert.equal(sentToConfirm.adjustments.length, 1)
    assert.deepEqual([sentToConfirm.adjustments[0].startSeconds, sentToConfirm.adjustments[0].endSeconds], [3, 8], 'what was sent is the bounds of the text that was shown')
    assert.match(sentToConfirm.adjustments[0].passageId, /^passage-[a-f0-9]{10}$/)
    await page.unroute('**/v1/projects/*/speech-removals')

    // ---- gateway of the cut confirmation (real HTTP, real authentication) ----
    // The UI client here has the scopes of a workspace that existed before the scope speech-removals:confirm: a person on the screen is admitted anyway.
    const cutPath = `/v1/projects/${world.projectId}/speech-removals`
    const cutBody = { baseVersionId: 'version-none', baseHash: 'a'.repeat(64), sourceTranscriptId: 'transcript-none', variantId: 'variant-none', subject: 'assunto que o pedido nao tem', proposalHash: 'a'.repeat(64) }
    const cutFromScreen = await page.evaluate(async ({ path, body }) => {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'gateway-screen-1' }, body: JSON.stringify(body) })
      return { status: response.status, payload: await response.json() }
    }, { path: cutPath, body: cutBody })
    assert.equal(cutFromScreen.status, 409, 'the screen session reaches the service (refused for the base version it does not have, not for the scope)')
    assert.equal(cutFromScreen.payload.error.code, 'VERSION_CONFLICT')
    const cutWithKey = async (token, key) => {
      const response = await fetch(`${baseUrl}${cutPath}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(cutBody) })
      return { status: response.status, payload: await response.json() }
    }
    // A key that may write but was never granted the confirmation is refused with the scope it lacks, before anything is read.
    const withoutScope = await cutWithKey(fixture.issued.token, 'gateway-key-without-scope')
    assert.equal(withoutScope.status, 403)
    assert.equal(withoutScope.payload.error.code, 'AUTH_SCOPE_REQUIRED')
    assert.equal(withoutScope.payload.error.details.requiredScope, 'speech-removals:confirm')
    // The same key with the scope the owner granted reaches the service.
    const granted = await issueApiClient({
      prisma, workspaceId: fixture.workspaceId, clientId: `${fixture.clientId}-granted`, name: 'Teste de tela com escopo', createdAt: new Date(),
      scopes: ['projects:read', 'projects:write', 'speech-removals:confirm'],
    })
    const withScope = await cutWithKey(granted.token, 'gateway-key-with-scope')
    assert.equal(withScope.status, 409)
    assert.equal(withScope.payload.error.code, 'VERSION_CONFLICT')
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
