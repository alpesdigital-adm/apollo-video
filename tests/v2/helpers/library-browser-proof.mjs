import assert from 'node:assert/strict'
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { errorMonitor } from 'node:events'
import net from 'node:net'
import { promisify } from 'node:util'
import { parseLinuxProcessStat } from '../../../scripts/validation/run-perception-ci.mjs'

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const browserLifecycles = new WeakMap()
export function linuxBrowserIdentityTerminal(expected, current) {
  assert.ok(Number.isSafeInteger(expected?.pid) && expected.pid > 0 && /^[0-9]+$/.test(expected.starttime))
  if (current === null) return true
  assert.ok(current && Number.isSafeInteger(current.pid) && /^[0-9]+$/.test(current.starttime))
  assert.equal(current.pid, expected.pid)
  return current.starttime !== expected.starttime || ['Z', 'X', 'x'].includes(current.state)
}
export function assertLinuxBrowserBirth(before, after, ownerPid) {
  assert.ok(Number.isSafeInteger(ownerPid) && ownerPid > 0)
  assert.ok(Number.isSafeInteger(before?.pid) && before.pid > 0 && /^[0-9]+$/.test(before.starttime))
  assert.equal(before.ppid, ownerPid, 'Public browser process must be the direct live child of this owner')
  assert.match(before.state, /^[RSDZTtWXxIKP]$/); assert.match(after.state, /^[RSDZTtWXxIKP]$/)
  assert.ok(!['Z', 'X', 'x'].includes(before.state), 'Browser birth must be live')
  assert.equal(after.pid, before.pid); assert.equal(after.starttime, before.starttime); assert.equal(after.ppid, before.ppid)
  assert.ok(!['Z', 'X', 'x'].includes(after.state), 'Browser birth changed to terminal during capture')
}
function linuxBrowserIdentity(pid, expected) {
  let before
  try { before = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT' && expected) return null; throw error }
  assert.equal(before.pid, pid)
  if (expected && linuxBrowserIdentityTerminal(expected, before)) return before
  if (!expected) { assert.equal(before.ppid, process.pid); assert.ok(!['Z', 'X', 'x'].includes(before.state)) }
  else assert.equal(before.ppid, expected.ppid)
  const executable = readlinkSync(`/proc/${pid}/exe`)
  const after = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  assert.equal(after.pid, pid); assert.equal(after.starttime, before.starttime)
  assert.equal(after.ppid, before.ppid)
  if (!expected) assertLinuxBrowserBirth(before, after, process.pid)
  if (expected) assert.equal(executable, expected.executable)
  return { ...after, executable }
}
export function observeOwnedBrowserLifecycle(server, child, capturePhase = 'after-launchServer-process') {
  if (child && browserLifecycles.has(child)) return browserLifecycles.get(child)
  const events = [], errors = [], listeners = [], streams = new Map()
  const startedAt = Date.now()
  let processCloseObserved = !child, serverCloseObserved = !server, stopped = false, stoppedAt = null
  const diagnostic = (error) => ({ code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : null,
    messageSha256: digest(Buffer.from(String(error?.message ?? error))), messageBytes: Buffer.byteLength(String(error?.message ?? error)) })
  const record = (kind, fields = {}) => {
    if (stopped) return
    if (events.length >= 64) { if (!errors.length) errors.push({ code: 'LIFECYCLE_OVERFLOW' }); return }
    events.push({ kind, at: Date.now(), ...fields })
  }
  const listen = (target, event, handler) => {
    if (!target?.on) return
    const ours = (...args) => { try { handler(...args) } catch (error) { if (errors.length < 8) errors.push(diagnostic(error)) } }
    target.on(event, ours); listeners.push([target, event, ours])
  }
  const observedError = (kind, error, fields = {}) => {
    const fact = { ...fields, ...diagnostic(error) }
    record(kind, fact); if (errors.length < 8) errors.push({ kind, ...fact })
  }
  let linuxBirth = null
  if (process.platform === 'linux' && Number.isSafeInteger(child?.pid)) {
    // First synchronous identity capture after the public process() call;
    // never adopt a replacement PID later if this observation fails.
    try { linuxBirth = linuxBrowserIdentity(child.pid) }
    catch (error) { observedError('linux-browser-birth', error) }
  }
  listen(child, 'exit', (code, signal) => record('process-exit', { code, signal }))
  listen(child, 'close', (code, signal) => { processCloseObserved = true; record('process-close', { code, signal }) })
  listen(server, 'close', (code, signal) => { serverCloseObserved = true; record('server-close', { code, signal }) })
  for (const [name, target] of [['process', child], ['server', server]]) {
    listen(target, errorMonitor, (error) => observedError(`${name}-error`, error))
  }
  for (const [index, stream] of (child?.stdio ?? []).entries()) {
    if (!stream) continue
    if (streams.has(stream)) { streams.get(stream).push(index); continue }
    const indices = [index]; streams.set(stream, indices)
    for (const event of ['end', 'finish', 'close']) listen(stream, event, () => record(`stdio-${event}`, { indices: [...indices] }))
    listen(stream, errorMonitor, (error) => observedError('stdio-error', error, { indices: [...indices] }))
  }
  const observer = {
    snapshot: () => ({ capturePhase, startedAt, observedThrough: stoppedAt ?? Date.now(), stopped, processCloseObserved, serverCloseObserved, linuxBirth,
      events: [...events], errors: [...errors],
      stdio: [...streams].map(([stream, indices]) => ({ indices: [...indices], destroyed: stream.destroyed ?? null,
        closed: stream.closed ?? null, readableEnded: stream.readableEnded ?? null, writableFinished: stream.writableFinished ?? null })) }),
    dispose: () => { if (stopped) return; stopped = true; stoppedAt = Date.now(); for (const [target, event, ours] of listeners) target.removeListener(event, ours) },
  }
  if (child) browserLifecycles.set(child, observer)
  return observer
}
export async function boundedOwnedBrowserCleanup(name, action, steps, clock = {
  now: () => performance.now(), arm: (callback, milliseconds) => setTimeout(callback, milliseconds), disarm: clearTimeout,
  resources: () => process.getActiveResourcesInfo(),
}) {
  const started = clock.now(), deadline = started + 5000
  const step = { name, startedAt: new Date().toISOString(), timeoutMs: 5000, deadline, resourcesBefore: clock.resources() }
  steps.push(step)
  let timer
  const timeout = () => new Error(`${name} cleanup timeout`)
  try {
    // Arm before action: synchronous spawnSync cannot be interrupted, and a
    // late return must still fail the original absolute five-second deadline.
    step.actionStatus = 'pending'
    await new Promise((resolve, reject) => {
      const remaining = deadline - clock.now()
      if (remaining <= 0) { step.actionStatus = 'not-started'; reject(timeout()); return }
      timer = clock.arm(() => reject(timeout()), remaining)
      let pending
      try { pending = action() } catch (error) { step.actionStatus = 'rejected'; reject(error); return }
      Promise.resolve(pending).then((value) => { step.actionStatus = 'fulfilled'; resolve(value) },
        (error) => { step.actionStatus = 'rejected'; reject(error) })
    })
    if (clock.now() >= deadline) throw timeout()
    step.status = 'completed'
  } catch (error) { step.status = 'failed'; step.error = error.message; throw error }
  finally {
    clock.disarm(timer); step.elapsedMs = clock.now() - started; step.deadlineExceeded = clock.now() >= deadline
    step.resourcesAfter = clock.resources(); step.completedAt = new Date().toISOString()
  }
}
export async function closeOwnedBrowserResources({ context, browser, server }, bounded, warnings) {
  let serverCleanup
  for (const [name, target] of [['context', context], ['browser', browser], ['browser-server', server]]) {
    if (!target) continue
    try { await bounded(name, () => { const action = target.close(); if (name === 'browser-server') serverCleanup = action; return action }) }
    catch (error) { warnings.push(error.message) }
  }
  return { serverCleanup }
}
export function ownedBrowserCleanupAccepted({ remaining, warnings, browserServerTerminal, processCloseObserved, serverCloseObserved, lifecycleErrors }) {
  return Array.isArray(remaining) && remaining.length === 0 && Array.isArray(warnings) && warnings.length === 0 &&
    browserServerTerminal === true && processCloseObserved === true && serverCloseObserved === true &&
    Array.isArray(lifecycleErrors) && lifecycleErrors.length === 0
}
export async function ownedBrowserProcesses(pid, expected) {
  if (!pid) return []
  if (process.platform === 'linux') {
    assert.ok(expected, 'Linux browser check requires the original observed identity')
    const current = linuxBrowserIdentity(pid, expected)
    return linuxBrowserIdentityTerminal(expected, current) ? [] : [current]
  }
  assert.equal(process.platform, 'win32', 'Unsupported browser identity authority')
  const script = `$all = @(Get-CimInstance Win32_Process); $owned = @(${Number(pid)}); do { $next = @($all | Where-Object { $owned -contains $_.ParentProcessId -and $owned -notcontains $_.ProcessId } | ForEach-Object ProcessId); $owned += $next } while ($next.Count); ConvertTo-Json -Compress -InputObject @($all | Where-Object { $owned -contains $_.ProcessId } | ForEach-Object { $entry=$_; $live=Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue; if ($live -and -not $live.HasExited -and ($live.ProcessName + '.exe') -eq $entry.Name -and [Math]::Abs(($live.StartTime.ToUniversalTime() - $entry.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 100) { @{ pid=$entry.ProcessId; created=$live.StartTime.ToUniversalTime().ToString('o') } } })`
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000 })
  return JSON.parse(stdout)
}
export async function closeOwnedBrowser({ context, browser, server, child }) {
  const lifecycle = observeOwnedBrowserLifecycle(server, child, 'cleanup-late')
  try {
  const originalWsEndpoint = server?.wsEndpoint()
  const warnings = []
  const steps = []
  const birth = lifecycle.snapshot().linuxBirth
  const observed = process.platform === 'linux' ? (birth ? [birth] : []) : await ownedBrowserProcesses(child?.pid)
  if (process.platform === 'linux' && child && !birth) warnings.push('Linux browser original identity was not observed; no PID adoption or signal fallback')
  const bounded = (name, action) => boundedOwnedBrowserCleanup(name, action, steps)
  const { serverCleanup } = await closeOwnedBrowserResources({ context, browser, server }, bounded, warnings)
  let remaining = []
  for (const identity of observed) {
    const current = await ownedBrowserProcesses(identity.pid, identity)
    if (process.platform === 'linux') {
      if (current.length) warnings.push('Live Linux browser remains; containment belongs exclusively to the external cgroup owner')
      continue
    }
    if (!current.some((item) => item.pid === identity.pid && item.created === identity.created)) continue
    if (process.platform === 'win32') await promisify(execFile)('taskkill.exe', ['/PID', String(identity.pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }).catch((error) => warnings.push(error.message))
  }
  for (const identity of observed) {
    const current = await ownedBrowserProcesses(identity.pid, identity)
    remaining.push(...current.filter((item) => item.pid === identity.pid &&
      (process.platform === 'linux' ? item.starttime === identity.starttime : item.created === identity.created)))
  }
  // Playwright waits for ChildProcess 'close' before releasing launchServer's
  // WebSocket listener. On Windows a dead Chromium can leave its stdio pipes
  // open. Release those handles only after OS PID/creation-time checks prove
  // every observed owned process terminal; never destroy a live browser's IO.
  let browserServerTerminal = !server
  if (remaining.length === 0 && child && (observed.length > 0 || child.exitCode !== null || child.signalCode !== null)) {
    try {
      await bounded('terminal-browser-stdio', async () => {
        for (const stream of child.stdio ?? []) stream?.destroy?.()
        if (serverCleanup) await serverCleanup
      })
      if (server) {
        await bounded('browser-websocket-listener', async () => {
          const endpoint = new URL(originalWsEndpoint)
          assert.ok(['ws:', 'wss:'].includes(endpoint.protocol), 'Owned browser endpoint must use WebSocket')
          assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname), 'Owned browser endpoint must be local')
          assert.ok(endpoint.port && Number(endpoint.port) > 0, 'Owned browser endpoint must declare its port')
          const host = endpoint.hostname === '[::1]' ? '::1' : endpoint.hostname
          const deadline = Date.now() + 4500
          for (;;) {
            const listening = await new Promise((resolve, reject) => {
              const socket = net.connect({ host, port: Number(endpoint.port) })
              socket.once('connect', () => { socket.destroy(); resolve(true) })
              socket.once('error', (error) => {
                socket.destroy()
                if (error.code === 'ECONNREFUSED') resolve(false)
                else reject(error)
              })
              socket.setTimeout(500, () => { socket.destroy(); reject(new Error('Browser WebSocket listener probe timeout')) })
            })
            if (!listening) break
            if (Date.now() >= deadline) throw new Error('Owned browser WebSocket listener is still open')
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        })
        browserServerTerminal = true
      }
    } catch (error) { warnings.push(error.message) }
  }
  lifecycle.dispose()
  const observation = lifecycle.snapshot()
  const accepted = ownedBrowserCleanupAccepted({ remaining, warnings, browserServerTerminal,
    processCloseObserved: observation.processCloseObserved, serverCloseObserved: observation.serverCloseObserved, lifecycleErrors: observation.errors })
  return { browserTerminal: process.platform === 'linux' ? null : accepted,
    localBrowserLifecycleTerminal: accepted, runCgroupTerminal: null,
    terminalProofScope: process.platform === 'linux' ? 'original-browser-root-identity-and-public-close-only' : 'observed-windows-browser-tree-and-public-close',
    browserServerTerminal, observed, remaining, warnings, steps,
    lifecycle: observation,
    process: child ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, closeObserved: observation.processCloseObserved } : null }
  } finally { lifecycle.dispose() }
}
export async function proveLibraryBrowser({ baseUrl, cookie, prisma, workspaceId, projectId, sourceArtifactId, evidenceDir }) {
  const { chromium } = await import('playwright-core')
  const executablePath = [process.env.PLAYWRIGHT_CHROME_EXECUTABLE, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => path && existsSync(path))
  assert.ok(executablePath, 'Library proof requires real Chromium')
  const evidence = { schemaVersion: 'library-browser-proof/v1', sourceCommit: process.env.GITHUB_SHA, ciRunId: process.env.GITHUB_RUN_ID ?? null, outcome: 'started', screenshots: [], checks: [], postflight: {} }
  let server, browser, context, child, primaryError
  try {
    server = await chromium.launchServer({ executablePath, headless: true }); child = server.process()
    observeOwnedBrowserLifecycle(server, child); assert.ok(child?.pid)
    browser = await chromium.connect(server.wsEndpoint()); context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); context.setDefaultTimeout(20_000)
    await context.addCookies([{ name: 'apollo_session', value: cookie, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    const ids = () => page.locator('article[data-library-id]').evaluateAll((cards) => cards.map((card) => card.getAttribute('data-library-id')))
    const api = async (query = '') => { const response = await context.request.get(`${baseUrl}/v1/media/library?limit=24${query}`); const payload = await response.json(); assert.equal(response.status(), 200, `Library oracle: ${JSON.stringify(payload.error ?? {})}`); return payload.data }
    const waitIds = async (expected) => {
      await page.waitForFunction((expectedIds) => JSON.stringify([...document.querySelectorAll('article[data-library-id]')].map((card) => card.getAttribute('data-library-id'))) === JSON.stringify(expectedIds), expected)
      assert.deepEqual(await ids(), expected)
    }
    const snap = async (name) => { await page.screenshot({ path: join(evidenceDir, name), fullPage: true }); const bytes = await readFile(join(evidenceDir, name)); evidence.screenshots.push({ name, bytes: bytes.length, sha256: digest(bytes) }) }
    const first = await api(); assert.equal(first.items.length, 24); assert.ok(first.nextCursor)
    await page.goto(`${baseUrl}/library`, { waitUntil: 'domcontentloaded' }); await waitIds(first.items.map((item) => item.id))
    const second = await api(`&after=${encodeURIComponent(first.nextCursor)}`)
    await page.getByRole('button', { name: 'Carregar mais' }).click(); await waitIds([...first.items, ...second.items].map((item) => item.id))
    assert.equal(new Set(await ids()).size, (await ids()).length)
    evidence.checks.push({ strength: 'http-real+browser-real', name: 'mixed-pagination', ids: await ids() }); await snap('library-paginated.png')
    await page.setViewportSize({ width: 390, height: 844 }); await snap('library-mobile.png'); await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByLabel('Tipo', { exact: true }).selectOption('video')
    await page.getByLabel('Pessoa', { exact: true }).fill('ÁGATA'); await page.getByLabel('Tema', { exact: true }).fill('IMERSÃO')
    await page.getByLabel('Direitos', { exact: true }).selectOption('eligible'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    const conjunction = await api('&kind=video&person=%C3%81GATA&topic=IMERS%C3%83O&rightsStatus=eligible')
    assert.ok(conjunction.items.some((item) => item.id === sourceArtifactId)); await waitIds(conjunction.items.map((item) => item.id))
    evidence.checks.push({ strength: 'http-real+browser-real', name: 'filter-conjunction', ids: await ids(), query: { person: 'ÁGATA', topic: 'IMERSÃO', rightsStatus: 'eligible' } })
    await page.getByLabel('Pessoa', { exact: true }).fill(''); await page.getByLabel('Tema', { exact: true }).fill('')
    await page.getByLabel('Tipo', { exact: true }).selectOption('')
    for (const rightsStatus of ['expired', 'restricted', 'review']) {
      await page.getByLabel('Direitos', { exact: true }).selectOption(rightsStatus); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
      const expected = await api(`&rightsStatus=${rightsStatus}`); await waitIds(expected.items.map((item) => item.id))
      assert.ok(expected.items.length)
      assert.equal(await page.getByRole('button', { name: 'Inserir no projeto', exact: true }).count(), 0)
      evidence.checks.push({ strength: 'http-real+browser-real', name: `rights-${rightsStatus}`, ids: await ids(), reasons: expected.items.map((item) => item.rights.reasonCodes) })
    }
    await page.getByLabel('Direitos', { exact: true }).selectOption('')
    await page.getByLabel('Tipo', { exact: true }).selectOption('video'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    const videos = await api('&kind=video'); await waitIds(videos.items.map((item) => item.id))
    const source = videos.items.find((item) => item.id === sourceArtifactId); assert.ok(source)
    await page.getByRole('button', { name: `Ver detalhes de ${source.label}`, exact: true }).click()
    const details = page.getByRole('region', { name: 'Detalhes da mídia' }); await details.waitFor()
    await page.getByAltText('Miniatura da mídia').waitFor(); await page.getByAltText('Forma de onda da mídia').waitFor()
    assert.equal(await page.getByAltText('Miniatura da mídia').evaluate((image) => image.naturalWidth), 320)
    assert.equal(await page.getByAltText('Forma de onda da mídia').evaluate((image) => image.naturalWidth), 640)
    await snap('library-real-previews.png')
    const countBefore = await prisma.v2MediaArtifact.count({ where: { workspaceId } })
    await details.getByLabel('Nome', { exact: true }).fill('Segmento criado no navegador')
    await details.getByLabel('Início (ms)', { exact: true }).fill('500'); await details.getByLabel('Fim (ms)', { exact: true }).fill('1500')
    await details.getByRole('button', { name: 'Criar sem recortar o original' }).click()
    await page.getByText('Segmento virtual criado. O arquivo original permanece intacto.', { exact: true }).waitFor()
    const segment = await prisma.v2MediaSegment.findFirstOrThrow({ where: { workspaceId, label: 'Segmento criado no navegador' } })
    assert.equal(segment.startMs, 500); assert.equal(segment.endMs, 1500); assert.equal(segment.physicalObjectKey, null)
    assert.equal(await prisma.v2MediaArtifact.count({ where: { workspaceId } }), countBefore)
    await page.getByLabel('Tipo', { exact: true }).selectOption('segment'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    const segments = await api('&kind=segment'); await waitIds(segments.items.map((item) => item.id))
    const card = page.locator(`article[data-library-id="${segment.id}"]`)
    // This item may be on page two under a tied timestamp; use the real cursor.
    if (!(await card.count())) { await page.getByRole('button', { name: 'Carregar mais' }).click(); await card.waitFor() }
    await page.getByRole('combobox', { name: /Projeto de destino/ }).selectOption(projectId)
    const beforeVersion = (await prisma.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId
    const attachResponse = page.waitForResponse((response) => response.url().includes('/media-library-attachments') && response.request().method() === 'POST')
    await card.getByRole('button', { name: 'Inserir no projeto', exact: true }).click()
    const attached = await attachResponse
    const attachmentPayload = await attached.json()
    assert.equal(attached.status(), 201, JSON.stringify(attachmentPayload))
    assert.deepEqual(attachmentPayload.data.selection, { kind: 'segment', segmentId: segment.id })
    assert.equal(attachmentPayload.data.segmentHash, segment.segmentHash)
    assert.deepEqual(attachmentPayload.data.semanticRange, { startMs: 500, endMs: 1500 })
    assert.ok(attachmentPayload.data.sourceTimeMapping)
    assert.equal(attachmentPayload.data.bytesDuplicated, false)
    await page.getByText('Mídia inserida no projeto por referência, sem copiar o arquivo.', { exact: true }).waitFor()
    assert.notEqual((await prisma.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId, beforeVersion)
    evidence.checks.push({ strength: 'pg-real+browser-real', name: 'create-and-attach-virtual-segment', segmentId: segment.id }); await snap('library-segment-selected.png')
    // Controlled transport only: delay an older response across a newer filter.
    await page.route('**/v1/media/library?*', async (route) => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('kind') === 'image') { const response = await route.fetch(); await new Promise((done) => setTimeout(done, 800)); await route.fulfill({ response }).catch(() => undefined) }
      else await route.continue()
    })
    await page.getByLabel('Tipo', { exact: true }).selectOption('image'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    await page.getByLabel('Tipo', { exact: true }).selectOption('video'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    await waitIds(videos.items.map((item) => item.id)); await page.waitForTimeout(1000); await waitIds(videos.items.map((item) => item.id))
    await page.unroute('**/v1/media/library?*')
    evidence.checks.push({ strength: 'controlled-transport', name: 'stale-response-refused' })
    let failOnce = true
    await page.route('**/v1/media/library?*', async (route) => { if (failOnce) { failOnce = false; await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Limite controlado do teste' } }) }) } else await route.continue() })
    await page.getByLabel('Tipo', { exact: true }).selectOption('audio'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click()
    const audio = await api('&kind=audio'); await waitIds(audio.items.map((item) => item.id)); await page.unroute('**/v1/media/library?*')
    evidence.checks.push({ strength: 'controlled-transport', name: '429-and-retry' })
    // This expanded journey sends an artificial burst. Let its real 60-second
    // governance window drain before the independent authorization cases.
    const cooldownStarted = Date.now()
    await new Promise((done) => setTimeout(done, 61_000))
    evidence.governanceCooldownMs = Date.now() - cooldownStarted
    await page.route('**/v1/media/library/*/previews/*', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Preview sem autorização controlada' } }) }))
    await page.getByLabel('Tipo', { exact: true }).selectOption('video'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    await waitIds(videos.items.map((item) => item.id))
    await page.getByRole('button', { name: `Ver detalhes de ${source.label}`, exact: true }).click()
    await page.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor()
    assert.deepEqual(await ids(), []); assert.equal(await page.getByRole('region', { name: 'Detalhes da mídia' }).count(), 0)
    assert.equal(await page.getByRole('combobox', { name: /Projeto de destino/ }).locator('option').count(), 1)
    await page.unroute('**/v1/media/library/*/previews/*')
    evidence.checks.push({ strength: 'controlled-transport', name: 'preview-403-clears-all-private-state' })
    // A private read begun before an auth failure must never restore its data.
    await page.route('**/v1/projects?*', async (route) => { const response = await route.fetch(); await new Promise((done) => setTimeout(done, 600)); await route.fulfill({ response }).catch(() => undefined) })
    await page.route('**/v1/media/library?*', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Sessão controlada' } }) }))
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor()
    await page.waitForTimeout(900); assert.deepEqual(await ids(), [])
    assert.equal(await page.getByRole('combobox', { name: /Projeto de destino/ }).locator('option').count(), 1)
    await page.unroute('**/v1/projects?*'); await page.unroute('**/v1/media/library?*')
    evidence.checks.push({ strength: 'controlled-transport', name: 'delayed-projects-cannot-survive-library-401' })
    await page.route('**/v1/projects?*', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Sessão controlada' } }) }))
    await page.route('**/v1/media/library?*', async (route) => { const response = await route.fetch(); await new Promise((done) => setTimeout(done, 600)); await route.fulfill({ response }).catch(() => undefined) })
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor()
    await page.waitForTimeout(900); assert.deepEqual(await ids(), [])
    await page.unroute('**/v1/projects?*'); await page.unroute('**/v1/media/library?*')
    evidence.checks.push({ strength: 'controlled-transport', name: 'delayed-library-cannot-survive-projects-401' })
    await page.reload({ waitUntil: 'domcontentloaded' }); await waitIds((await api()).items.map((item) => item.id))
    // Revocation at the source closes both preview routes, including direct IDs.
    await prisma.v2MediaArtifact.update({ where: { id: sourceArtifactId }, data: { currentRightsSnapshotId: null } })
    for (const path of [`/v1/media/library/${sourceArtifactId}/previews/thumbnail`, `/v1/artifacts/${source.preview.thumbnail.artifactId}/content`]) {
      const denied = await context.request.get(`${baseUrl}${path}`)
      assert.equal(denied.status(), 422); assert.equal((await denied.json()).error.code, 'ASSET_RIGHTS_BLOCKED')
    }
    evidence.checks.push({ strength: 'controlled-pg-revocation+http-real', name: 'preview-and-direct-content-revalidate-source-rights' })
    // Revocation is real PostgreSQL; the response comes from the real server.
    await prisma.v2UiSession.updateMany({ where: { workspaceId }, data: { revokedAt: new Date() } })
    await page.getByLabel('Tipo', { exact: true }).selectOption('video'); await page.getByRole('button', { name: 'Filtrar', exact: true }).click()
    await page.getByRole('button', { name: 'Tentar novamente', exact: true }).waitFor(); assert.deepEqual(await ids(), [])
    assert.equal((await context.request.get(`${baseUrl}/v1/media/library`)).status(), 401)
    evidence.checks.push({ strength: 'pg-real+http-real+browser-real', name: 'revoked-session-clears-library' })
    evidence.outcome = 'passed'; return evidence
  } catch (error) {
    primaryError = error
    evidence.outcome = 'failed'
    evidence.failure = { name: error.name, message: error.message }
    throw error
  } finally {
    evidence.postflight = await closeOwnedBrowser({ context, browser, server, child })
    await writeFile(join(evidenceDir, 'library-browser.json'), JSON.stringify(evidence, null, 2))
    if (!(process.platform === 'linux' ? evidence.postflight.localBrowserLifecycleTerminal : evidence.postflight.browserTerminal)) throw new AggregateError([...(primaryError ? [primaryError] : []), new Error('Owned Chromium lifecycle is not terminal')], 'Library browser proof or cleanup failed')
  }
}
