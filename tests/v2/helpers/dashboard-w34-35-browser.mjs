import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Browser plumbing shared by the W34 aggregate proof and the W35 state proof.
 * Everything here observes: it reads the DOM and the network, it never
 * dispatches synthetic events and never fabricates a response.
 */

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function evidenceDirectory(envName, label) {
  const configured = process.env[envName]
  assert.ok(configured || !process.env.CI, `CI must set ${envName}`)
  const directory = resolve(configured || join(tmpdir(), `apollo-${label}-${process.pid}-${randomUUID()}`))
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const fromRepo = relative(root, directory)
  assert.ok(fromRepo && (fromRepo.startsWith('..') || isAbsolute(fromRepo)), `${label} evidence must be outside the repository`)
  return directory
}

export function chromePath(label) {
  const executable = [process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find((path) => path && existsSync(path))
  assert.ok(executable, `${label} requires Chromium; no skip is allowed`)
  return executable
}

export async function boundedClose(label, action, errors) {
  if (!action) return
  let timer
  try {
    await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), 60_000)
    })])
  } catch (error) { errors.push(`${label}:${error?.name ?? 'Error'}:${String(error?.message ?? '').slice(0, 120)}`) }
  finally { clearTimeout(timer) }
}

export async function launchBrowser(label) {
  const { chromium } = await import('playwright-core')
  const browserServer = await chromium.launchServer({ executablePath: chromePath(label), headless: true })
  const browserProcess = browserServer.process()
  assert.ok(browserProcess?.pid, `${label} browser must have an owned PID`)
  const browser = await chromium.connect(browserServer.wsEndpoint())
  return { browserServer, browser, browserProcess }
}

/** Closes every browser resource and reports whether the owned process is terminal. */
export async function closeBrowser({ page, contexts = [], browser, browserServer, browserProcess }, cleanupErrors) {
  await boundedClose('page', page && (() => page.close()), cleanupErrors)
  for (const [index, context] of contexts.entries()) {
    await boundedClose(`context-${index}`, context && (() => context.close()), cleanupErrors)
  }
  await boundedClose('browser', browser && (() => browser.close()), cleanupErrors)
  await boundedClose('browser-server', browserServer && (() => browserServer.close()), cleanupErrors)
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    try { browserProcess.kill('SIGKILL') } catch (error) { cleanupErrors.push(`browser-kill:${error?.name ?? 'Error'}`) }
  }
  if (browserProcess && browserProcess.exitCode === null && browserProcess.signalCode === null) {
    await Promise.race([new Promise((done) => browserProcess.once('exit', done)), new Promise((done) => setTimeout(done, 60_000))])
  }
  const terminal = !browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode !== null
  if (!terminal) cleanupErrors.push('browser-process-not-terminal')
  return terminal
}

export async function newHumanContext(browser, { baseUrl, cookieName, cookieValue, viewport }) {
  // UTC makes the card date text deterministic against the oracle.
  const context = await browser.newContext({ viewport, timezoneId: 'UTC', locale: 'pt-BR' })
  context.setDefaultTimeout(25_000)
  context.setDefaultNavigationTimeout(30_000)
  await context.addCookies([{ name: cookieName, value: cookieValue, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
  return context
}

/** Records same-origin requests; the cookie and any header are never stored. */
export function trackRequests(page, baseUrl) {
  const entries = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.origin !== baseUrl) return
    entries.push({
      method: request.method(), path: url.pathname,
      ...(url.pathname === '/v1/projects'
        ? { text: url.searchParams.get('text'), status: url.searchParams.get('status') }
        : {}),
    })
  })
  return {
    entries,
    mutating: () => entries.filter((entry) => !['GET', 'HEAD'].includes(entry.method)),
    projectGets: () => entries.filter((entry) => entry.method === 'GET' && entry.path === '/v1/projects'),
  }
}

export function awaitProjectList(page, text) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === '/v1/projects' && url.searchParams.get('text') === (text || null) &&
      response.request().method() === 'GET'
  }).then(async (response) => {
    assert.equal(response.status(), 200, 'dashboard project list must answer 200')
    return response.json()
  })
}

export async function readCards(page) {
  return page.locator('article[data-project-id]').evaluateAll((articles) => articles.map((article) => {
    const text = (node) => node?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
    const badge = article.querySelector('[data-state]')
    const facts = Object.fromEntries([...article.querySelectorAll('dl > div')]
      .map((item) => [text(item.querySelector('dt')), text(item.querySelector('dd'))]))
    const operationBox = article.querySelector('dl')?.nextElementSibling ?? null
    const headline = operationBox?.firstElementChild ?? null
    const spans = headline ? [...headline.querySelectorAll(':scope > span')] : []
    const bar = article.querySelector('[role="progressbar"]')
    const percentTexts = [...article.querySelectorAll('span')]
      .map((span) => text(span)).filter((value) => /^\d+%$/.test(value))
    const error = operationBox?.querySelector(':scope > p') ?? null
    const activity = [...article.querySelectorAll('p')].map((node) => text(node))
      .find((value) => value.startsWith('Atividade em')) ?? null
    const buttons = [...article.querySelectorAll('button')].map((button) => ({
      text: text(button), disabled: button.disabled, title: button.getAttribute('title'),
    }))
    return {
      id: article.getAttribute('data-project-id'),
      name: text(article.querySelector('h3')),
      objective: text(article.querySelector('h3')?.nextElementSibling),
      state: badge?.getAttribute('data-state') ?? null,
      badgeText: text(badge), badgeClass: badge?.className ?? '',
      facts, phase: text(spans[0]), measure: spans[1] ? text(spans[1]) : null,
      percentTexts,
      bar: bar
        ? {
            now: bar.getAttribute('aria-valuenow'),
            min: bar.getAttribute('aria-valuemin'), max: bar.getAttribute('aria-valuemax'),
            width: bar.firstElementChild?.getAttribute('style') ?? null,
            label: bar.getAttribute('aria-label'),
          }
        : null,
      error: error ? text(error) : null, activity, buttons,
    }
  }))
}

export async function readTiles(page) {
  return page.locator('section[aria-label="Resumo dos projetos"] > article').evaluateAll((tiles) => tiles.map((tile) => ({
    label: [...tile.querySelectorAll('p')].at(-1)?.textContent?.trim() ?? '',
    value: Number(tile.querySelector('p')?.textContent?.trim()),
  })))
}

/** Layout probe: nothing may leave its card or the viewport, and no label may be cut. */
export async function layoutReport(page) {
  return page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth
    const findings = []
    const cards = [...document.querySelectorAll('article[data-project-id]')]
    for (const card of cards) {
      const box = card.getBoundingClientRect()
      const id = card.getAttribute('data-project-id')
      if (box.left < -1 || box.right > viewportWidth + 1) findings.push({ id, kind: 'card-outside-viewport', left: box.left, right: box.right })
      for (const node of card.querySelectorAll('h3, span, p, dt, dd, button')) {
        const rect = node.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) continue
        if (rect.left < box.left - 1 || rect.right > box.right + 1) {
          findings.push({ id, kind: 'outside-card', tag: node.tagName, text: node.textContent.trim().slice(0, 40) })
        }
        const style = getComputedStyle(node)
        const clips = style.overflow !== 'visible' || style.textOverflow === 'ellipsis'
        if (clips && node.scrollWidth > node.clientWidth + 1) {
          findings.push({ id, kind: 'text-clipped', tag: node.tagName, text: node.textContent.trim().slice(0, 40) })
        }
      }
    }
    return {
      viewportWidth,
      overflowPx: document.documentElement.scrollWidth - innerWidth,
      cardCount: cards.length,
      findings,
    }
  })
}

export async function screenshot(page, directory, name) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(() => window.scrollY === 0)
  await page.screenshot({ path: join(directory, name), fullPage: true })
  const bytes = await readFile(join(directory, name))
  assert.ok(bytes.length > 100, `${name} is empty`)
  return { name, sha256: sha256(bytes), bytes: bytes.length }
}

export async function writeManifest(directory, name, evidence) {
  await writeFile(join(directory, name), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'w' })
}

// -- Independent expectations (pinned, never imported from the component) ----

export const STATE_EXPECTATIONS = Object.freeze({
  draft: { label: 'draft', badge: 'Configuração', tone: 'neutral', action: 'open-result', button: 'Abrir workspace →', bucket: 'draft' },
  ingesting: { label: 'ingesting', badge: 'Ingestão', tone: 'info', action: 'view-progress', button: 'Acompanhar →', bucket: 'processing' },
  'rendering-proxy': { label: 'rendering-proxy', badge: 'Renderizando proxy', tone: 'info', action: 'view-progress', button: 'Acompanhar →', bucket: 'processing' },
  'rendering-final': { label: 'rendering-final', badge: 'Exportando final', tone: 'info', action: 'view-progress', button: 'Acompanhar →', bucket: 'processing' },
  'reviewing-proxy': { label: 'reviewing-proxy', badge: 'Revisar proxy', tone: 'warning', action: 'review-output', button: 'Revisar agora →', bucket: 'review' },
  failed: { label: 'failed', badge: 'Requer atenção', tone: 'danger', action: 'inspect-error', button: 'Ver erro →', bucket: 'failed' },
  completed: { label: 'completed', badge: 'Concluído', tone: 'success', action: 'open-result', button: 'Abrir workspace →', bucket: 'completed' },
  archived: { label: 'archived', badge: 'Arquivado', tone: 'neutral', action: 'inspect-history', button: 'Ver histórico →', bucket: 'history' },
})

export const TONE_CLASS = Object.freeze({
  neutral: 'text-[#aaa49a]', info: 'text-[#79a5da]', warning: 'text-[#ca92d4]',
  danger: 'text-[#e08b8b]', success: 'text-[#7ec397]',
})

export const PHASE_LABEL = Object.freeze({
  queued: 'Na fila', materializing: 'Preparando mídia', rendering: 'Renderizando',
  verifying: 'Verificando', persisting: 'Salvando resultado',
  completed: 'Etapa concluída', failed: 'Etapa com falha',
})

export const ARCHIVABLE = new Set(['draft', 'completed', 'failed', 'canceled'])

/** What a card must show for one oracle record; the strings are pinned here. */
export function expectedCard({ project, expected, apiProject }) {
  const state = STATE_EXPECTATIONS[project.status]
  assert.ok(state, `no pinned expectation for status ${project.status}`)
  const operation = expected.latestOperation
  const total = operation?.progress?.total
  const percent = total ? Math.min(100, Math.floor(operation.progress.completed * 100 / total)) : null
  return {
    id: project.id,
    name: project.name,
    state: state.label,
    badgeText: state.badge,
    tone: state.tone,
    apiTone: apiProject.visibleState.tone,
    apiPrimaryAction: apiProject.visibleState.primaryAction,
    primaryAction: state.action,
    primaryButton: state.button,
    facts: {
      Versão: expected.currentVersion ? `v${expected.currentVersion.sequence}` : '—',
      Pendências: String(expected.openReviewIssueCount),
      Outputs: String(expected.outputCount),
    },
    phase: operation ? PHASE_LABEL[operation.phase] : 'Nenhuma operação iniciada',
    measure: operation ? (percent === null ? 'sem total medido' : `${percent}%`) : null,
    percent,
    bar: percent === null ? null : { now: String(percent), width: `width: ${percent}%;` },
    error: operation?.error
      ? `${operation.error.code}${operation.error.retryable ? ' · recuperável' : ''}`
      : null,
    activity: `Atividade em ${new Date(expected.lastActivityAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}`,
    bucket: state.bucket,
  }
}

/** Compares one observed card with its expectation; returns nothing, throws on drift. */
export function assertCard(card, want) {
  const where = `card ${want.name}`
  assert.equal(card.id, want.id, `${where}: id`)
  assert.equal(card.name, want.name, `${where}: name`)
  assert.equal(card.state, want.state, `${where}: data-state`)
  assert.equal(card.badgeText, want.badgeText, `${where}: state label`)
  assert.ok(card.badgeClass.includes(TONE_CLASS[want.tone]), `${where}: tone class ${TONE_CLASS[want.tone]} in "${card.badgeClass}"`)
  assert.equal(want.apiTone, want.tone, `${where}: API tone`)
  assert.equal(want.apiPrimaryAction, want.primaryAction, `${where}: API primary action`)
  assert.deepEqual(card.facts, want.facts, `${where}: facts`)
  assert.equal(card.phase, want.phase, `${where}: phase`)
  assert.equal(card.measure, want.measure, `${where}: measure`)
  assert.deepEqual(card.percentTexts, want.percent === null ? [] : [`${want.percent}%`], `${where}: percent texts`)
  if (want.bar === null) assert.equal(card.bar, null, `${where}: no progress bar without a total`)
  else {
    assert.equal(card.bar?.now, want.bar.now, `${where}: aria-valuenow`)
    assert.equal(card.bar?.width, want.bar.width, `${where}: bar width`)
    assert.equal(card.bar?.label, `Progresso medido de ${want.name}`, `${where}: bar label`)
  }
  assert.equal(card.error, want.error, `${where}: error`)
  assert.equal(card.activity, want.activity, `${where}: activity`)
  assert.ok(card.buttons.some((button) => button.text === want.primaryButton && !button.disabled), `${where}: primary action ${want.primaryButton}`)
}
