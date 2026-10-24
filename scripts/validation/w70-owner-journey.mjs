#!/usr/bin/env node
// The owner's journey (W70) through the PUBLIC /v1 API, the way a user or an integrator would drive it, against a server that is already
// running (see docs/runbooks/W70-OWNER-JOURNEY.md). It carries NO editorial content: the briefing, the objective, the outputs, the master,
// and every human decision (revising the request, which phrases to cut, approving a proxy, the owner's correction and acceptance) arrive
// as files and variables. It applies exactly what the files say, records every request and response (sanitised) as evidence, and stops,
// fail closed, on any answer it does not expect.
//
//   APOLLO_API_BASE_URL=http://127.0.0.1:3000 APOLLO_API_TOKEN=... \
//   node scripts/validation/w70-owner-journey.mjs --briefing /abs/briefing.txt --outputs 9:16,16:9 --master /abs/master.mov \
//     --master-sha256 <hex> --master-size <bytes> --rights-confirmed --evidence /abs/evidence --decisions /abs/decisions [--resume]
//
// Phases (each ends with a `phase-complete` line in journey-log.jsonl; --resume skips the completed ones):
//   p1-create-project   project from the briefing; the reading the configured interpreter made of it
//   p2-outputs-ingest   the outputs, the master upload, the transcription, the source rights and colour pipeline, --setup requests
//   p3-director-first   the Director; a refusal waits for decisions/revise-editorial-request[-n].json
//   p4-spoken-cuts      decisions/remove-spoken-content.json -> remove-spoken-content per output
//   p5-director-review  the Director again, the proxy of each output, the review; decisions/proxy-review[-n].json
//   p6-final-inspection the final of each output, download, SHA-256, ffprobe, full decode, w70-manifest.json
//   p7-owner-correction decisions/owner-correction.json -> new final of the affected outputs, w70-manifest.v2.json
//   p8-owner-acceptance decisions/owner-acceptance.json recorded in the manifest
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import {
  EXIT, JourneyError, decisionFileName, detectContainer, buildVariantBody, mentionsHead, parseArguments, parseDecision, parseOutputSpecFile,
  parseRequests, sanitize, sha256Hex, substitute, substitutePath, usage,
} from './w70-journey-lib.mjs'

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TERMINAL = new Set(['succeeded', 'failed', 'canceled'])
/** PRECONDITION_REQUIRED reasons that mean "a human has to change the request", not "something broke". */
const DECISION_REASONS = new Set(['editorial-request-blocked', 'brief-interpretation-required', 'director-objective-required', 'objective-required'])
const PHASES = Object.freeze(['p1-create-project', 'p2-outputs-ingest', 'p3-director-first', 'p4-spoken-cuts', 'p5-director-review', 'p6-final-inspection', 'p7-owner-correction', 'p8-owner-acceptance'])

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const iso = () => new Date().toISOString()

async function fileSha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function runProcess(command, args, { timeoutMs, captureLimit = 262_144 } = {}) {
  return new Promise((resolveRun) => {
    let child
    try { child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) } catch (error) { resolveRun({ code: null, stdout: '', stderr: String(error), error }); return }
    let stdout = ''
    let stderr = ''
    let stderrBytes = 0
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null
    child.stdout.on('data', (chunk) => { if (stdout.length < captureLimit) stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; if (stderr.length < captureLimit) stderr += String(chunk) })
    child.once('error', (error) => { clearTimeout(timer); resolveRun({ code: null, stdout, stderr: stderr || String(error), stderrBytes, error }) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolveRun({ code, signal, stdout, stderr, stderrBytes }) })
  })
}

function findKey(value, name, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return undefined
  if (Object.hasOwn(value, name)) return value[name]
  for (const child of Object.values(value)) {
    const found = findKey(child, name, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

// ====================================================================================================================
export async function runJourney(config) {
  const secrets = [config.apiToken]
  await mkdir(config.evidence, { recursive: true })
  await mkdir(config.decisions, { recursive: true })
  const logPath = join(config.evidence, 'journey-log.jsonl')

  // ---- one driver per evidence directory
  const lockPath = join(config.evidence, 'journey.lock')
  try {
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: iso() }), { flag: 'wx' })
  } catch {
    let owner = null
    try { owner = JSON.parse(await readFile(lockPath, 'utf8')) } catch { /* unreadable lock: treated as stale */ }
    let alive = false
    if (owner && Number.isInteger(owner.pid)) { try { process.kill(owner.pid, 0); alive = true } catch { alive = false } }
    if (alive) throw new JourneyError('LOCKED', `another journey driver (pid ${owner.pid}) is running on ${config.evidence}`)
    await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: iso() }))
  }
  const releaseLock = () => rm(lockPath, { force: true })

  try {
    return await runLocked(config, { secrets, logPath })
  } finally {
    await releaseLock()
  }
}

async function runLocked(config, { secrets, logPath }) {
  // ---- resume or start
  let logged = []
  try { logged = (await readFile(logPath, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const briefingText = await readFile(config.briefing, 'utf8')
  if (briefingText.trim() === '') throw new JourneyError('USAGE', '--briefing file is empty', {}, EXIT.usage)
  const configDigest = sha256Hex(JSON.stringify({
    briefing: sha256Hex(briefingText), objective: config.objective ?? null, outputs: config.outputKeys, master: config['master-sha256'], locale: config.locale ?? null,
    projectName: config['project-name'] ?? null,
  }))
  let state
  const completed = new Set()
  if (logged.length > 0) {
    if (!config.resume) throw new JourneyError('USAGE', `${logPath} already holds a journey: pass --resume to continue it, or use another --evidence`, {}, EXIT.usage)
    const start = logged.find((entry) => entry.event === 'journey-start')
    if (!start) throw new JourneyError('USAGE', 'journey-log.jsonl has no journey-start line', {}, EXIT.usage)
    if (start.configDigest !== configDigest) throw new JourneyError('USAGE', 'the briefing, outputs, master, objective, locale or project name differ from the journey being resumed', {}, EXIT.usage)
    for (const entry of logged) if (entry.event === 'phase-complete') { completed.add(entry.phase); state = entry.state }
    state ??= { runId: start.runId }
    state.runId = start.runId
  } else {
    if (config.resume) throw new JourneyError('USAGE', '--resume was given but there is no journey-log.jsonl to resume', {}, EXIT.usage)
    state = { runId: config['run-id'] ?? randomUUID().slice(0, 12) }
  }
  state.variants ??= {}
  state.directorRuns ??= []
  state.commands ??= []
  state.operations ??= []
  state.pendingOperations ??= []
  state.revisions ??= []
  state.finals ??= []
  state.timings ??= {}
  state.approvals ??= {}
  state.reviewRounds ??= []
  const runId = state.runId
  const outputKeys = config.outputKeys

  // ---- evidence and log
  let phase = 'init'
  let sequence = 0
  const log = async (event, fields = {}) => {
    const line = sanitize({ at: iso(), phase, event, ...fields }, secrets)
    await appendFile(logPath, `${JSON.stringify(line)}\n`)
    const brief = Object.entries(fields).filter(([, value]) => typeof value !== 'object' || value === null).map(([key, value]) => `${key}=${value}`).join(' ')
    console.log(`[${line.at}] ${phase} ${event}${brief ? ` ${brief}` : ''}`)
  }
  const writeEvidence = async (relativePath, data) => {
    const path = join(config.evidence, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(sanitize(data, secrets), null, 2)}\n`)
    return path
  }
  const stamp = () => `${iso().replace(/[-:]/g, '').replace('.', '')}-${String(++sequence).padStart(4, '0')}`

  if (logged.length === 0) {
    await log('journey-start', { runId, configDigest, apiOrigin: new URL(config.apiBaseUrl).origin, outputs: outputKeys, startedAt: iso() })
  } else {
    await log('journey-resume', { runId, completedPhases: [...completed].join(',') || 'none' })
  }

  // ---- the HTTP client of the public API
  const authHeaders = { authorization: `Bearer ${config.apiToken}` }
  async function call({ method = 'GET', path, body, key, headers = {}, expect = [200, 201, 202], allowError = false, record = true, label }) {
    const url = `${config.apiBaseUrl}${path}`
    let response
    let text
    for (let attempt = 0; ; attempt += 1) {
      response = await fetch(url, {
        method,
        headers: { ...authHeaders, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { 'idempotency-key': key } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120_000),
      })
      text = await response.text()
      let parsed
      try { parsed = JSON.parse(text) } catch { parsed = undefined }
      // Governance admission answers a burst with a retryable 429 that executes nothing: wait for the window to move and send the same request.
      if (response.status === 429 && parsed?.error?.code === 'GOVERNANCE_LIMIT_EXCEEDED' && parsed.error.retryable === true && attempt < 18) { await delay(5_000); continue }
      break
    }
    let payload
    try { payload = JSON.parse(text) } catch { payload = { unparsed: text.slice(0, 2000) } }
    const result = { status: response.status, headers: { etag: response.headers.get('etag') ?? undefined, requestId: response.headers.get('x-request-id') ?? undefined }, payload, data: payload?.data }
    if (record) {
      await writeEvidence(join('requests', phase, `${stamp()}-${method}-${path.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60)}.json`), {
        at: iso(), label, method, path, idempotencyKey: key, requestBody: body, status: response.status, responseHeaders: result.headers, response: payload,
      })
    }
    const ok = response.status >= 200 && response.status < 300 && expect.includes(response.status)
    result.ok = ok
    result.error = payload?.error
    if (!ok && !allowError) {
      const error = payload?.error
      throw new JourneyError('UNEXPECTED_RESPONSE', `${method} ${path} answered ${response.status}${error ? ` ${error.code}: ${error.message}` : ''}${error?.details?.reason ? ` (${error.details.reason})` : ''}`, { status: response.status, error })
    }
    return result
  }
  const keyFor = (...parts) => `w70-${runId.slice(0, 12)}-${sha256Hex(JSON.stringify(parts)).slice(0, 32)}`

  // ---- helpers over the project
  const projectPath = () => `/v1/projects/${encodeURIComponent(state.project.id)}`
  const readProject = async (record = false, label = 'project') => (await call({ path: projectPath(), record, label })).data
  async function head() {
    const workspace = await readProject()
    if (!workspace.version) throw new JourneyError('UNEXPECTED_RESPONSE', 'the project has no head Version')
    return { versionId: workspace.version.id, baseHash: workspace.version.baseHash, workspace }
  }
  const track = (data, source) => {
    if (!isRecord(data)) return
    if (isRecord(data.operation) && typeof data.operation.id === 'string' && !state.pendingOperations.some((item) => item.id === data.operation.id)) {
      state.pendingOperations.push({ id: data.operation.id, type: data.operation.type, source })
    }
    if (isRecord(data.command) && typeof data.command.id === 'string' && !state.commands.some((item) => item.id === data.command.id)) {
      state.commands.push({ id: data.command.id, type: data.command.type, baseVersionId: data.command.baseVersionId, resultVersionId: data.command.resultVersionId ?? data.version?.id, source, at: iso() })
    }
  }
  async function waitOperation(id, label) {
    const deadline = Date.now() + config['operation-timeout-ms']
    const startedAt = Date.now()
    let operation
    for (;;) {
      const response = await call({ path: `/v1/operations/${encodeURIComponent(id)}`, record: false, label })
      operation = response.data?.operation
      if (!operation) throw new JourneyError('UNEXPECTED_RESPONSE', `operation ${id} answered without an operation`)
      if (TERMINAL.has(operation.status)) break
      if (Date.now() > deadline) throw new JourneyError('OPERATION_TIMEOUT', `operation ${id} (${operation.type}) is still ${operation.status}/${operation.phase} after ${config['operation-timeout-ms']} ms`, { operation })
      await delay(config['operation-poll-ms'])
    }
    await writeEvidence(join('operations', `${operation.type}-${id}.json`), { label, waitedMs: Date.now() - startedAt, operation })
    if (operation.status !== 'succeeded') throw new JourneyError('OPERATION_FAILED', `operation ${id} (${operation.type}) ended ${operation.status}${operation.error ? `: ${operation.error.code ?? ''} ${operation.error.message ?? ''}` : ''}`, { operation })
    const known = state.operations.find((item) => item.id === id)
    const entry = { id, type: operation.type, status: operation.status, createdAt: operation.createdAt, completedAt: operation.completedAt, targetId: operation.target?.id, attempt: operation.attempt }
    if (known) Object.assign(known, entry); else state.operations.push(entry)
    return operation
  }
  async function settlePending(label) {
    const pending = [...state.pendingOperations]
    for (const item of pending) {
      await waitOperation(item.id, `${label}:${item.type ?? 'operation'}`)
      state.pendingOperations = state.pendingOperations.filter((other) => other.id !== item.id)
    }
  }

  // ---- human decisions
  async function awaitDecision(kind, attempt, context) {
    const name = decisionFileName(kind, attempt)
    const path = join(config.decisions, name)
    await log('awaiting-decision', { decision: name, path, ...(context ? { context } : {}) })
    const waitStarted = Date.now()
    const deadline = waitStarted + config['decision-timeout-ms']
    let lastProblem = null
    for (;;) {
      let text = null
      try { text = await readFile(path, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (text !== null) {
        try {
          const decision = parseDecision(kind, text, { outputKeys })
          const waitedMs = Date.now() - waitStarted
          state.timings[phase] = { ...state.timings[phase], decisionWaitMs: (state.timings[phase]?.decisionWaitMs ?? 0) + waitedMs }
          const decisionSha256 = sha256Hex(text)
          await writeEvidence(join('decisions-applied', name), { decision: name, sha256: decisionSha256, receivedAfterMs: waitedMs, content: JSON.parse(text) })
          await log('decision-received', { decision: name, sha256: decisionSha256, waitedMs })
          return { name, sha256: decisionSha256, ...decision }
        } catch (error) {
          // A file still being written is not valid JSON yet; a file that is complete and wrong stops the run at the deadline with the reason.
          if (!(error instanceof JourneyError) || error.code !== 'INVALID_DECISION') throw error
          lastProblem = error.message
        }
      }
      if (Date.now() > deadline) {
        throw new JourneyError('DECISION_TIMEOUT', `no usable decision ${path} after ${config['decision-timeout-ms']} ms${lastProblem ? ` (last problem: ${lastProblem})` : ''}`, {}, EXIT.decisionTimeout)
      }
      await delay(config['poll-ms'])
    }
  }

  // ---- request templates of the decisions
  async function applyRequests({ label, requests, scope }) {
    const responses = []
    let current = null
    for (const [index, request] of requests.entries()) {
      if (mentionsHead(request)) current = await head()
      const resolver = (name) => {
        if (name === 'projectId') return state.project.id
        if (name === 'head.versionId') return current?.versionId
        if (name === 'head.baseHash') return current?.baseHash
        if (name === 'transcript.id') return state.transcript?.id
        if (name === 'sourceArtifact.id') return state.master?.artifactId
        const variant = /^variant:(.+)$/.exec(name)
        if (variant) return state.variants[variant[1]]?.id
        const proxy = /^proxyArtifact:(.+)$/.exec(name)
        if (proxy) return state.latestProxies?.[proxy[1]]?.artifactId
        const review = /^review:(.+)\.(id|hash|revision)$/.exec(name)
        if (review) return { id: state.latestProxies?.[review[1]]?.reviewId, hash: state.latestProxies?.[review[1]]?.reviewHash, revision: state.latestProxies?.[review[1]]?.revision }[review[2]]
        return undefined
      }
      const path = substitutePath(request.path, { resolver, responses })
      const body = request.body === undefined ? undefined : substitute(request.body, { resolver, responses })
      const ifMatch = request.ifMatch === undefined ? undefined : substitute(request.ifMatch, { resolver, responses })
      const before = (await head()).versionId
      let response = await call({
        method: request.method, path, body, headers: ifMatch ? { 'if-match': String(ifMatch) } : {},
        key: request.method === 'POST' ? keyFor(scope, index, path, body) : undefined, expect: request.expect ?? [200, 201, 202], allowError: true, label: `${label}[${index}]`,
      })
      if (!response.ok) {
        // A Command the Commands route committed and then could not ask the proxy of (several outputs) is applied; anything else is a failure.
        const committed = await committedDespiteProxyRefusal(response, before)
        if (!committed) throw new JourneyError('UNEXPECTED_RESPONSE', `${request.method} ${path} answered ${response.status}${response.error ? ` ${response.error.code}: ${response.error.message}` : ''}${response.error?.details?.reason ? ` (${response.error.details.reason})` : ''}`, { status: response.status, error: response.error })
        response = { ...response, data: { version: { id: committed.versionId, baseHash: committed.baseHash } } }
      }
      responses.push({ status: response.status, headers: response.headers, data: response.data })
      track(response.data, `${label}[${index}]`)
      await log('request-applied', { label, index, method: request.method, path, status: response.status })
    }
    return responses
  }

  // ---- Director, revisions, proxies, reviews
  const summarizeRequestView = (view) => ({
    state: view.state, blocksDirector: view.blocksDirector, requestHash: view.request?.requestHash, objective: view.request?.objective,
    structuredDirectives: view.request?.directives,
    directives: (view.interpretation?.directives ?? []).map((item) => ({ id: item.id, kind: item.kind, value: item.value, param: item.param, excerpt: item.excerpt?.text })),
    unsupported: view.unsupported, openQuestions: view.openQuestions,
    coverage: (view.interpretation?.coverage ?? []).map((item) => ({ topic: item.topic, excerpt: item.excerpt?.text })),
    interpreter: view.interpretation?.interpreter, audit: view.interpretationAudit, hashes: view.hashes,
  })
  async function readRequestView(label) {
    const response = await call({ path: `${projectPath()}/editorial-request`, label })
    return response.data
  }

  async function reviseRequest(view, why) {
    if (state.revisions.length >= config['max-revisions']) {
      throw new JourneyError('TOO_MANY_REVISIONS', `the Director is still refused after ${config['max-revisions']} revise-editorial-request rounds`, { why })
    }
    const attempt = state.revisions.length + 1
    const decision = await awaitDecision('revise-editorial-request', attempt, { why, unsupported: view.unsupported, openQuestions: view.openQuestions })
    const response = await call({
      method: 'POST', path: `${projectPath()}/editorial-request`, key: keyFor('revise', attempt, decision.sha256, view.version.id),
      body: { baseVersionId: view.version.id, baseHash: view.version.baseHash, ...decision.body, reason: decision.reason }, label: `revise-editorial-request#${attempt}`,
    })
    track(response.data, `revise#${attempt}`)
    const after = summarizeRequestView(response.data)
    state.revisions.push({ attempt, decision: decision.name, decisionSha256: decision.sha256, commandId: response.data.command?.id, versionId: response.data.version?.id, change: response.data.change, interpreted: response.data.interpreted, impact: response.data.impact, requestHash: after.requestHash })
    await log('request-revised', { attempt, commandId: response.data.command?.id, blocksDirector: after.blocksDirector, unsupported: after.unsupported.length, openQuestions: after.openQuestions.length })
    await writeEvidence(join('interpretation', `after-revision-${attempt}.json`), after)
  }

  /** The colour pipeline every video source needs before it renders (identity: the technical conversion only, nothing creative); one per project. */
  async function compileColorPipeline() {
    const probeResponse = await call({ path: `/v1/artifacts/${encodeURIComponent(state.master.artifactId)}/color-probe`, label: 'color-probe' })
    const probe = probeResponse.data.probe
    if (probe?.detection?.state !== 'ready') throw new JourneyError('COLOR_PROBE', `the source colour probe is ${probe?.detection?.state}: the pipeline would be a guess`, { probe })
    const metadata = probe.detection.metadata
    const stage = (id, kind, enabled, provider, parameters) => ({ id, kind, version: 'v1', enabled, output: metadata, implementation: { provider, version: 'v1', parameters, parametersHash: sha256Hex(JSON.stringify(parameters)) } })
    const compiled = await call({
      method: 'POST', path: `${projectPath()}/color-pipeline-compilations`, key: keyFor('color', state.master.artifactId, probe.manifestId), expect: [200, 201], label: 'color-pipeline',
      body: {
        sourceArtifactId: state.master.artifactId, sourceManifestId: probe.manifestId, outputMetadata: metadata,
        stages: [stage('technical-rec709', 'technical', true, 'ffmpeg-zscale', { mode: 'identity' }), stage('match-source', 'match', false, 'apollo-match', { mode: 'bypass' }),
          stage('creative-none', 'creative-lut', false, 'apollo-lut', { mode: 'none' }), stage('output-rec709', 'output', true, 'ffmpeg-zscale', { dither: true })],
      },
    })
    state.master.manifestId = probe.manifestId
    state.colorCompilationId = compiled.data?.compilation?.id
  }

  /** The owner's statement of the rights to the source (PUT rights), from decisions/source-rights[-n].json. */
  async function stateRights(context) {
    state.rightsDecisions ??= []
    const attempt = state.rightsDecisions.length + 1
    const decision = await awaitDecision('source-rights', attempt, context)
    const path = `/v1/artifacts/${encodeURIComponent(state.master.artifactId)}/rights`
    const current = await call({ path, label: 'rights-read-for-put' })
    await call({ method: 'PUT', path, headers: { 'if-match': current.headers.etag ?? '' }, body: decision.body, expect: [200], label: `rights-put#${attempt}` })
    state.rightsDecisions.push({ attempt, decision: decision.name, decisionSha256: decision.sha256, reason: decision.reason })
    await log('rights-stated', { attempt, decision: decision.name })
  }

  /**
   * A Command that commits and then asks for the proxy of "the" output (the Commands route does this for run-director and
   * remove-spoken-content) is refused with `output-variant-required` when the project has several outputs: the Command is already
   * committed. The driver recognises exactly that answer, proves the commit by the head Version having moved, and asks for the proxy of
   * each output itself (proxy-renders names the variant). Any other answer, or an unmoved head, is a failure.
   */
  async function committedDespiteProxyRefusal(response, previousVersionId) {
    if (response.error?.code !== 'PRECONDITION_REQUIRED' || response.error?.details?.reason !== 'output-variant-required') return null
    const after = await head()
    if (after.versionId === previousVersionId) return null
    await log('warning', { message: 'the Command committed; its own proxy request was refused for a project with several outputs (output-variant-required): proxies are requested per output', versionId: after.versionId })
    return after
  }

  /**
   * A project whose finals are delivered is `completed`, and a completed project accepts no further proxy render (it can only be archived).
   * The owner's correction therefore goes on a copy-on-write duplicate of the delivered Version: the same source bytes, a project of its own.
   */
  async function duplicateForCorrection(current) {
    const original = state.project
    const duplicateRequest = {
      method: 'POST', path: `${projectPath()}/duplicates`, key: keyFor('duplicate', current.versionId), expect: [200, 201], allowError: true,
      body: { expectedVersionId: current.versionId, expectedVersionHash: current.baseHash, name: `${original.name}-correction`.slice(0, 120) }, label: 'duplicate-for-correction',
    }
    // The product commits a duplication in one 30 s transaction; an INTERNAL_ERROR answer means it rolled back, and the same idempotency key
    // asks again safely (replay or create). Three tries, then the failure stands.
    const askDuplicate = async () => {
      let answer = await call(duplicateRequest)
      for (let retry = 1; !answer.ok && answer.status >= 500 && retry <= 2; retry += 1) {
        await log('retry', { what: 'duplicate-for-correction', status: answer.status, code: answer.error?.code, retry })
        await delay(5_000)
        answer = await call(duplicateRequest)
      }
      return answer
    }
    let duplicated = await askDuplicate()
    if (!duplicated.ok && duplicated.error?.code === 'ASSET_RIGHTS_BLOCKED') {
      // The copy shares the project's media by reference, and the proxies and finals the project produced carry no rights of their own.
      const lacking = (current.workspace.media ?? []).filter((item) => item.rightsStatus !== 'approved')
      await log('rights-blocked', { message: 'the duplication was refused for the rights of derived media: the owner states them', artifacts: lacking.map((item) => `${item.role}:${item.artifactId}`).join(',') })
      const decision = await awaitDecision('derived-rights', 1, { artifacts: lacking.map((item) => ({ role: item.role, artifactId: item.artifactId })) })
      for (const item of lacking) {
        const path = `/v1/artifacts/${encodeURIComponent(item.artifactId)}/rights`
        const read = await call({ path, label: `rights-read:${item.role}` })
        await call({ method: 'PUT', path, headers: { 'if-match': read.headers.etag ?? '' }, body: decision.body, expect: [200], label: `rights-put:${item.role}` })
      }
      state.derivedRights = { decision: decision.name, decisionSha256: decision.sha256, artifacts: lacking.map((item) => item.artifactId) }
      duplicated = await askDuplicate()
    }
    if (!duplicated.ok) throw new JourneyError('UNEXPECTED_RESPONSE', `duplicating the delivered project answered ${duplicated.status} ${duplicated.error?.code}: ${duplicated.error?.message}`, { status: duplicated.status, error: duplicated.error })
    state.originalProject = original
    state.project = { id: duplicated.data.project.id, name: duplicated.data.project.name, duplicatedFromProjectId: original.id, forkedFromVersionId: duplicated.data.version?.forkedFromVersionId }
    const workspace = await readProject(true, 'duplicate')
    for (const output of workspace.outputs ?? []) {
      if (state.variants[output.aspectRatio]) state.variants[output.aspectRatio] = { ...state.variants[output.aspectRatio], id: output.variantId, previousId: state.variants[output.aspectRatio].id }
    }
    if ((workspace.transcripts ?? []).length > 0) state.transcript = { ...state.transcript, id: [...workspace.transcripts].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0].id }
    await log('duplicated-for-correction', { projectId: state.project.id, from: original.id, reason: 'the delivered project is completed and accepts no further proxy render' })
    await compileColorPipeline()
    state.pendingOperations = []
  }

  /**
   * The request asks to take a subject out of the speech: the Director refuses with the stretches of the transcript that would go. Only the owner
   * confirms them (apollo.projects.speech-removals.confirm, a capability of its own): the driver lists the candidates and applies exactly the
   * confirmations of decisions/speech-removal-confirm[-n].json, naming the subject, never the words.
   */
  async function confirmSpeechRemovals(removals, label) {
    state.speechRemovalDecisions ??= []
    const attempt = state.speechRemovalDecisions.length + 1
    const candidates = removals.map((item) => ({ questionId: item.id, text: item.text, subject: item.removal.subject, ruleId: item.removal.ruleId, label: item.removal.label, alternatives: item.removal.alternatives, matches: item.removal.matches }))
    await writeEvidence(join('speech-removal', `candidates-${attempt}.json`), { label, candidates })
    await log('speech-removal-proposed', { label, subjects: candidates.map((item) => item.subject).join(' | '), stretches: candidates.map((item) => item.matches.length).join(',') })
    const decision = await awaitDecision('speech-removal-confirm', attempt, { candidates: candidates.map((item) => ({ subject: item.subject, stretches: item.matches.map((match) => `${match.startSeconds}-${match.endSeconds}`) })) })
    for (const confirmation of decision.confirmations) {
      const current = await head()
      const body = {
        baseVersionId: current.versionId, baseHash: current.baseHash, sourceTranscriptId: state.transcript.id, variantId: state.variants[confirmation.variant].id,
        subject: confirmation.subject, ...(confirmation.reason ? { reason: confirmation.reason } : {}),
      }
      const response = await call({ method: 'POST', path: `${projectPath()}/speech-removals`, key: keyFor('confirm-removal', confirmation.subject, current.versionId, decision.sha256), body, expect: [200, 201], allowError: true, label: `speech-removal-confirm:${confirmation.variant}` })
      let entry
      if (response.ok) {
        track(response.data, 'speech-removal-confirm')
        const editorial = response.data.editorial
        if (!editorial || (editorial.exclusions ?? []).length === 0) throw new JourneyError('CUT_EMPTY', 'the confirmed removal took nothing out', { editorial })
        entry = { subject: confirmation.subject, key: confirmation.variant, commandId: response.data.command.id, versionId: response.data.version.id, exclusions: editorial.exclusions, retainedSourceRanges: editorial.retainedSourceRanges, outputDurationFrames: editorial.outputDurationFrames, fps: editorial.fps }
      } else {
        const committed = await committedDespiteProxyRefusal(response, current.versionId)
        if (!committed) throw new JourneyError('UNEXPECTED_RESPONSE', `confirming the removal of "${confirmation.subject}" answered ${response.status} ${response.error?.code}: ${response.error?.message}${response.error?.details?.reason ? ` (${response.error.details.reason})` : ''}`, { status: response.status, error: response.error })
        entry = { subject: confirmation.subject, key: confirmation.variant, commandId: committed.workspace.commands.find((item) => item.resultVersionId === committed.versionId)?.id, versionId: committed.versionId, exclusions: null }
      }
      state.confirmedCuts ??= []
      state.confirmedCuts.push(entry)
      await log('cut-confirmed', { subject: confirmation.subject, commandId: entry.commandId, exclusions: entry.exclusions ? entry.exclusions.length : 'not-returned' })
    }
    state.speechRemovalDecisions.push({ attempt, decision: decision.name, decisionSha256: decision.sha256 })
  }

  /** The outputs whose request fills the frame following the face: the render of those refuses (reframe-plan-required) without a reframe plan of the Version. */
  async function fillOutputKeys() {
    const view = await readRequestView('reframe-scope')
    const directives = [
      ...(view.request?.directives ?? []), ...(view.interpretation?.directives ?? []),
      ...Object.entries(view.request?.variantOverrides ?? {}).flatMap(([variantId, list]) => list.map((item) => ({ ...item, variantId }))),
    ].filter((item) => item.kind === 'output-layout' && item.value === 'fill-following-face')
    const keys = new Set()
    for (const directive of directives) {
      for (const key of outputKeys) {
        const { width, height, id } = state.variants[key]
        const about = String(directive.param)
        if (directive.variantId === id || about === 'all' || about === key || (about === 'vertical' && height > width) || (about === 'horizontal' && width > height) || (about === 'square' && width === height)) keys.add(key)
      }
    }
    return outputKeys.filter((key) => keys.has(key))
  }

  /** A reframe plan of the head Version for every output that fills the frame (apollo.projects.reframe-plans.create), before its proxy is asked. */
  async function ensureReframePlans(current) {
    const keys = await fillOutputKeys()
    state.reframePlans ??= {}
    for (const key of keys) {
      const variantId = state.variants[key].id
      const existing = await call({ path: `${projectPath()}/reframe-plans?variantId=${encodeURIComponent(variantId)}&projectVersionId=${encodeURIComponent(current.versionId)}`, allowError: true, label: `reframe-plan-read:${key}` })
      const planned = existing.ok ? existing : await call({ method: 'POST', path: `${projectPath()}/reframe-plans`, key: keyFor('reframe', key, current.versionId), body: { baseVersionId: current.versionId, variantId }, expect: [200, 201], label: `reframe-plan:${key}` })
      state.reframePlans[key] = { versionId: current.versionId, variantId, reused: existing.ok }
      await log('reframe-plan', { key, versionId: current.versionId, reused: existing.ok, status: planned.status })
    }
    return keys
  }

  /** Runs the Director; while it refuses for a reason a person can fix, waits for the revision decision and tries again. */
  async function directDirector(label) {
    for (let guard = 0; guard < config['max-revisions'] + 2; guard += 1) {
      const current = await head()
      const response = await call({
        method: 'POST', path: `${projectPath()}/commands`, key: keyFor('director', label, current.versionId, state.revisions.length),
        body: { type: 'run-director', baseVersionId: current.versionId, baseHash: current.baseHash, reason: `w70 journey ${runId}: ${label}` },
        allowError: true, label: `run-director:${label}`,
      })
      if (response.ok) {
        track(response.data, `director:${label}`)
        const run = response.data.directorRun
        const report = run?.qualityReport?.report
        const entry = {
          label, id: run?.id, status: run?.status, commandId: response.data.command?.id, baseVersionId: run?.baseVersionId, resultVersionId: run?.resultVersionId,
          plannerVersion: run?.plannerVersion, criticVersion: run?.criticVersion, objective: run?.objective,
          qualitySnapshotId: run?.qualityReport?.snapshotId, qualityReportId: report?.id, qualityStatus: report?.status, score: report?.score,
          requestHash: report?.requestHash, policyResolutionHash: report?.policyResolutionHash,
          hardChecks: (report?.hardChecks ?? []).map((check) => ({ id: check.id, kind: check.kind, passed: check.passed })), issueCount: (report?.issues ?? []).length,
          decisionCount: (run?.decisions ?? []).length, assumptionCount: (run?.assumptions ?? []).length,
        }
        state.directorRuns.push(entry)
        await writeEvidence(join('director', `${label}-${run?.id}.json`), { entry, decisions: run?.decisions, assumptions: run?.assumptions, qualityReport: report, editPlan: run?.editPlan })
        await log('director-planned', { label, directorRunId: entry.id, qualityStatus: entry.qualityStatus, failedChecks: entry.hardChecks.filter((check) => !check.passed).map((check) => check.id).join(',') || 'none' })
        return entry
      }
      const reason = response.error?.details?.reason
      const committed = await committedDespiteProxyRefusal(response, current.versionId)
      if (committed) {
        const run = committed.workspace.directorRuns.find((item) => item.resultVersionId === committed.versionId)
        if (!run) throw new JourneyError('UNEXPECTED_RESPONSE', 'the Director Command committed but the project lists no DirectorRun for the new head Version')
        const qualityResponse = await call({ path: `${projectPath()}/director-runs/${encodeURIComponent(run.id)}/quality-report`, allowError: true, label: `quality-report:${label}` })
        const report = qualityResponse.ok ? (findKey(qualityResponse.data, 'hardChecks') ? qualityResponse.data.qualityReport?.report ?? qualityResponse.data.qualityReport : undefined) : undefined
        const entry = {
          label, id: run.id, status: run.status, commandId: committed.workspace.commands.find((item) => item.resultVersionId === committed.versionId)?.id, baseVersionId: run.baseVersionId, resultVersionId: run.resultVersionId,
          plannerVersion: run.plannerVersion, criticVersion: run.criticVersion, qualitySnapshotId: run.qualitySnapshotId, qualityReportId: report?.id, qualityStatus: run.qualityStatus, score: run.qualityScore,
          requestHash: report?.requestHash, policyResolutionHash: report?.policyResolutionHash,
          hardChecks: (report?.hardChecks ?? []).map((check) => ({ id: check.id, kind: check.kind, passed: check.passed })), issueCount: (report?.issues ?? []).length,
          decisionCount: run.decisionCount, assumptionCount: run.assumptionCount, embeddedProxyRequest: 'refused-output-variant-required',
        }
        state.directorRuns.push(entry)
        await writeEvidence(join('director', `${label}-${run.id}.json`), { entry, workspaceRun: run, qualityReport: report })
        await log('director-planned', { label, directorRunId: entry.id, qualityStatus: entry.qualityStatus, failedChecks: entry.hardChecks.filter((check) => !check.passed).map((check) => check.id).join(',') || 'none', via: 'workspace-read' })
        return entry
      }
      const blockers = Array.isArray(response.error?.details?.blockers) ? response.error.details.blockers : []
      const removals = blockers.filter((item) => item.removal)
      if (response.error?.code === 'PRECONDITION_REQUIRED' && reason === 'editorial-request-blocked' && removals.length > 0 && removals.length === blockers.length) {
        await confirmSpeechRemovals(removals, label)
        continue
      }
      if (response.error?.code === 'PRECONDITION_REQUIRED' && DECISION_REASONS.has(reason)) {
        const view = await readRequestView(`blocked:${label}`)
        const summary = summarizeRequestView(view)
        await writeEvidence(join('interpretation', `blocked-${label}-${state.revisions.length + 1}.json`), { reason, error: response.error, view: summary })
        await log('director-blocked', { label, reason, unsupported: summary.unsupported.length, openQuestions: summary.openQuestions.length })
        await reviseRequest(view, { reason, details: response.error.details })
        continue
      }
      throw new JourneyError('UNEXPECTED_RESPONSE', `run-director answered ${response.status} ${response.error?.code}: ${response.error?.message}${reason ? ` (${reason})` : ''}`, { status: response.status, error: response.error })
    }
    throw new JourneyError('TOO_MANY_REVISIONS', 'the Director kept being refused')
  }

  async function downloadArtifact(artifactId, destination, label) {
    const grant = await call({
      method: 'POST', path: `/v1/artifacts/${encodeURIComponent(artifactId)}/download-grants`, key: keyFor('grant', artifactId, destination),
      body: config['grant-ttl-seconds'] ? { ttlSeconds: config['grant-ttl-seconds'] } : {}, label: `grant:${label}`,
    })
    const downloadUrl = grant.data?.downloadUrl
    if (typeof downloadUrl !== 'string') throw new JourneyError('UNEXPECTED_RESPONSE', 'the download grant has no downloadUrl')
    const parsed = new URL(downloadUrl)
    const base = new URL(config.apiBaseUrl)
    const url = `${base.origin}${parsed.pathname}${parsed.search}`
    const response = await fetch(url, { signal: AbortSignal.timeout(config['operation-timeout-ms']) })
    if (!response.ok || !response.body) throw new JourneyError('UNEXPECTED_RESPONSE', `downloading ${label} answered ${response.status}`)
    await mkdir(dirname(destination), { recursive: true })
    const hash = createHash('sha256')
    let bytes = 0
    const handle = await open(destination, 'w')
    try {
      for await (const chunk of response.body) { hash.update(chunk); bytes += chunk.length; await handle.write(chunk) }
    } finally { await handle.close() }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > 0 && declared !== bytes) throw new JourneyError('DOWNLOAD_MISMATCH', `${label}: received ${bytes} bytes, the server declared ${declared}`)
    return { sha256: hash.digest('hex'), byteSize: bytes, grantId: grant.data?.grant?.id, contentType: response.headers.get('content-type') }
  }

  async function tryReadReview(versionId, variantId) {
    const response = await call({ path: `${projectPath()}/proxy-reviews?projectVersionId=${encodeURIComponent(versionId)}&variantId=${encodeURIComponent(variantId)}`, allowError: true, label: 'proxy-review' })
    if (response.ok) return response.data.review
    if (response.status >= 500) throw new JourneyError('UNEXPECTED_RESPONSE', `proxy review answered ${response.status}`, { error: response.error })
    return null
  }

  /** The proxy and its review of every output at the head Version: waits for what the Commands started, asks for what is missing. */
  async function ensureReviews(round, keys = outputKeys) {
    await ensureReframePlans(await head())
    await settlePending(`proxy-round-${round}`)
    const current = await head()
    const reviews = {}
    for (const key of keys) {
      const variantId = state.variants[key].id
      let review = await tryReadReview(current.versionId, variantId)
      if (!review) {
        const enqueued = await call({ method: 'POST', path: `${projectPath()}/proxy-renders`, key: keyFor('proxy', current.versionId, variantId), body: { variantId }, label: `proxy-render:${key}` })
        track(enqueued.data, `proxy:${key}`)
        await settlePending(`proxy-round-${round}:${key}`)
        review = await tryReadReview(current.versionId, variantId)
      }
      if (!review) throw new JourneyError('UNEXPECTED_RESPONSE', `output ${key} has no proxy review at version ${current.versionId} after its proxy rendered`)
      reviews[key] = review
    }
    return { head: current, reviews }
  }

  const summarizeReview = (review) => ({
    reviewId: review.id, reviewHash: review.reviewHash, revision: review.revision, status: review.status, finalAllowed: review.finalAllowed, warningsAcknowledged: review.warningsAcknowledged,
    proxyArtifactId: review.proxyArtifactId, technicalIssues: review.technicalIssues, criticIssues: review.criticIssues, formatQuality: review.formatQuality, spec: review.spec,
    projectVersionId: review.projectVersionId, timeToFirstProxyMs: review.timeToFirstProxyMs,
  })

  async function downloadProxies(reviews, tag, keys = outputKeys) {
    state.latestProxies = {}
    for (const key of keys) {
      const review = reviews[key]
      const file = join(config.evidence, 'proxies', `${key.replace(':', 'x')}-${tag}.mp4`)
      const downloaded = await downloadArtifact(review.proxyArtifactId, file, `proxy ${key}`)
      state.latestProxies[key] = { artifactId: review.proxyArtifactId, reviewId: review.id, reviewHash: review.reviewHash, revision: review.revision, file, sha256: downloaded.sha256, byteSize: downloaded.byteSize }
    }
  }

  async function acknowledgeIfAsked(key, review, choice) {
    if (review.status === 'blocked') {
      throw new JourneyError('REVIEW_BLOCKED', `output ${key}: the proxy review is blocked, it cannot be approved (issues in evidence). Ask for a correction in the next proxy-review decision`, { key, review: summarizeReview(review) })
    }
    if (review.status === 'warning-ack-required') {
      if (!choice.acknowledgeWarnings) {
        throw new JourneyError('REVIEW_WARNINGS', `output ${key}: the proxy review has warnings and the decision approves without acknowledgeWarnings: true`, { key, review: summarizeReview(review) })
      }
      const current = await head()
      const acknowledged = await call({
        method: 'POST', path: `${projectPath()}/proxy-reviews`, key: keyFor('ack', review.id, review.reviewHash),
        body: { action: 'acknowledge-warnings', proxyReviewId: review.id, projectVersionId: current.versionId, baseRevision: review.reviewHash, expectedRevision: review.revision }, label: `acknowledge:${key}`,
      })
      return acknowledged.data.review
    }
    return review
  }

  // ===================================================================================================================
  // Phases
  // ===================================================================================================================
  async function p1CreateProject() {
    const body = {
      name: config['project-name'] ?? `w70-${runId}`,
      ...(config.objective ? { objective: config.objective } : {}),
      ...(config.locale ? { locale: config.locale } : {}),
      briefing: briefingText,
      ...(config['desired-action'] ? { desiredAction: JSON.parse(await readFile(config['desired-action'], 'utf8')) } : {}),
    }
    const created = await call({ method: 'POST', path: '/v1/projects', key: keyFor('project'), body, expect: [200, 201], label: 'create-project' })
    state.project = { id: created.data.projectAtCreation.id, name: created.data.projectAtCreation.name }
    state.creationVersion = { id: created.data.creationVersion.id, baseHash: created.data.creationVersion.baseHash }
    state.briefing = { sha256: sha256Hex(briefingText), characters: briefingText.length, file: basename(config.briefing) }
    const view = await readRequestView('interpretation-at-creation')
    state.interpretation = summarizeRequestView(view)
    await writeEvidence(join('interpretation', 'at-creation.json'), { briefing: state.briefing, interpretation: state.interpretation })
    await log('interpretation', {
      state: state.interpretation.state, directives: state.interpretation.directives.length, unsupported: state.interpretation.unsupported.length,
      questions: state.interpretation.openQuestions.length, blocksDirector: state.interpretation.blocksDirector, provider: state.interpretation.interpreter?.provider, model: state.interpretation.interpreter?.model,
    })
    if (state.interpretation.state === 'awaiting-interpretation') await log('warning', { message: 'the briefing was not read at creation (interpreter unavailable?); the Director will refuse until a revise-editorial-request reads it' })
  }

  async function p2OutputsIngest() {
    // ---- outputs
    const specOverrides = config['output-spec'] ? parseOutputSpecFile(JSON.parse(await readFile(config['output-spec'], 'utf8')), outputKeys) : {}
    let base = { id: state.creationVersion.id, baseHash: state.creationVersion.baseHash }
    for (const key of outputKeys) {
      let preset
      if (!(specOverrides[key]?.width && specOverrides[key]?.height && specOverrides[key]?.fps && specOverrides[key]?.safeArea)) {
        const registry = await import(pathToFileURL(join(REPOSITORY_ROOT, 'src/v2/domain/output-format-registry.ts')).href)
        preset = registry.readOutputFormatPreset(key).spec
      }
      const body = buildVariantBody({ ratio: key, preset, override: specOverrides[key] ?? {}, locale: config.locale, baseVersionId: base.id, baseHash: base.baseHash, reason: `w70 journey ${runId}: output ${key}` })
      const made = await call({ method: 'POST', path: `${projectPath()}/output-variants`, key: keyFor('variant', key, body), body, expect: [200, 201], label: `output-variant:${key}` })
      state.variants[key] = { id: made.data.variant.id, specHash: made.data.variant.specHash, versionId: made.data.version.id, width: body.output.width, height: body.output.height, fps: body.output.fps, subtitlesMode: body.profile.subtitles.mode, locale: body.output.locale }
      base = { id: made.data.version.id, baseHash: made.data.version.baseHash }
      await log('output-created', { key, variantId: made.data.variant.id, width: body.output.width, height: body.output.height, fps: body.output.fps, subtitles: body.profile.subtitles.mode })
    }
    if (outputKeys.some((key) => state.variants[key].subtitlesMode === 'none')) {
      await log('note', { message: 'an output has subtitles.mode none: no caption is drawn unless the output spec (--output-spec) or the --setup requests ask for one' })
    }

    // ---- the master
    const info = await stat(config.master)
    if (info.size !== config['master-size']) throw new JourneyError('MASTER_MISMATCH', `the master has ${info.size} bytes, --master-size says ${config['master-size']}`)
    const sha256 = await fileSha256(config.master)
    if (sha256 !== config['master-sha256']) throw new JourneyError('MASTER_MISMATCH', 'the master SHA-256 differs from --master-sha256')
    const handle = await open(config.master, 'r')
    let head12
    try { head12 = Buffer.alloc(12); await handle.read(head12, 0, 12, 0) } finally { await handle.close() }
    const container = detectContainer(head12)
    const mimeType = config['master-mime'] ?? container?.mimeType
    if (!mimeType) throw new JourneyError('MASTER_CONTAINER', 'the master is not an ISO base-media file: pass --master-mime (and --master-file-name)')
    const fileName = config['master-file-name'] ?? `master.${container?.extension ?? (extname(config.master).slice(1) || 'bin')}`
    state.master = { sha256, byteSize: info.size, mimeType, fileName, containerBrand: container?.brand, mimeOrigin: config['master-mime'] ? 'flag' : 'detected-from-ftyp' }
    await log('master-checked', { byteSize: info.size, sha256, mimeType, fileName })

    const begun = await call({
      method: 'POST', path: '/v1/media/uploads', key: keyFor('upload-begin', sha256), expect: [200, 201], label: 'upload-begin',
      body: { projectId: state.project.id, fileName, rightsConfirmed: true, kind: 'video', size: String(info.size), mimeType, checksum: sha256 },
    })
    const uploadId = begun.data.upload.id
    const sessionResponse = await call({ method: 'POST', path: `/v1/media/uploads/${encodeURIComponent(uploadId)}/session`, key: keyFor('upload-session', uploadId), body: {}, expect: [200, 201], label: 'upload-session' })
    const session = sessionResponse.data.session
    const base0 = new URL(config.apiBaseUrl)
    const local = (text) => { const url = new URL(text); url.protocol = base0.protocol; url.host = base0.host; return url.toString() }
    const source = await open(config.master, 'r')
    try {
      const total = session.mode === 'single' ? 1 : session.maxParts
      for (let part = 1; part <= total; part += 1) {
        const size = session.mode === 'single' ? info.size : Math.min(Number(session.partSize), info.size - (part - 1) * Number(session.partSize))
        const offset = session.mode === 'single' ? 0 : (part - 1) * Number(session.partSize)
        const buffer = Buffer.allocUnsafe(size)
        const { bytesRead } = await source.read(buffer, 0, size, offset)
        if (bytesRead !== size) throw new JourneyError('MASTER_READ', `short read of the master at ${offset}`)
        const target = session.mode === 'single' ? session.uploadUrl : session.partUrlTemplate.replace('{partNumber}', String(part))
        const put = await fetch(local(target), { method: 'PUT', headers: session.requiredHeaders, body: buffer, signal: AbortSignal.timeout(600_000) })
        if (![200, 201, 204].includes(put.status)) throw new JourneyError('UPLOAD_FAILED', `master part ${part}/${total} answered ${put.status}`)
        await log('upload-part', { part, total, bytes: size })
      }
    } finally { await source.close() }
    const completed = await call({ method: 'POST', path: `/v1/media/uploads/${encodeURIComponent(uploadId)}/complete`, key: keyFor('upload-complete', uploadId), body: {}, expect: [200, 201, 202], label: 'upload-complete' })
    state.master.uploadId = uploadId
    state.master.ingestOperationId = completed.data.operation.id
    await waitOperation(completed.data.operation.id, 'ingest')

    // ---- the transcription, as the product made it
    const transcriptDeadline = Date.now() + 120_000
    let workspace
    for (;;) {
      workspace = await readProject(true, 'after-ingest')
      if ((workspace.transcripts ?? []).length > 0) break
      if (Date.now() > transcriptDeadline) throw new JourneyError('NO_TRANSCRIPT', 'the ingest finished but the project has no transcript')
      await delay(config['operation-poll-ms'])
    }
    const sources = [...new Set(workspace.transcripts.map((item) => item.sourceArtifactId))]
    if (sources.length !== 1) throw new JourneyError('AMBIGUOUS_SOURCE', `the project has transcripts of ${sources.length} source artifacts`, { sources })
    const transcript = [...workspace.transcripts].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0]
    state.master.artifactId = transcript.sourceArtifactId
    state.transcript = {
      id: transcript.id, language: transcript.language, provider: transcript.provider, model: transcript.model, transcriptHash: transcript.transcriptHash,
      wordCount: transcript.wordCount, segmentCount: transcript.segmentCount, languageBasis: transcript.languageBasis ?? undefined,
      languageDeclared: Boolean(config.locale),
      languageOrigin: transcript.languageBasis ?? (config.locale ? 'declared-not-verified (inferred: the journey declared a locale)' : 'detected-from-media (inferred: the journey declared no locale)'),
    }
    await writeEvidence(join('transcription', 'transcript.json'), { ...state.transcript, text: transcript.text })
    await log('transcribed', { transcriptId: transcript.id, language: transcript.language, origin: state.transcript.languageOrigin, provider: transcript.provider, model: transcript.model, words: transcript.wordCount })

    // ---- the rights of the source: the upload recorded the owner's confirmation; whether that is enough is judged by the consumers (an export
    // that is refused for rights waits for decisions/source-rights.json), and a snapshot that is not approved waits for it here.
    const rights = await call({ path: `/v1/artifacts/${encodeURIComponent(state.master.artifactId)}/rights`, label: 'rights-read' })
    const rightsStatus = rights.data?.rights?.status ?? findKey(rights.data, 'status')
    await log('rights', { status: rightsStatus, allowedUses: (rights.data?.rights?.allowedUses ?? []).join(',') })
    if (rightsStatus !== 'approved') await stateRights({ rightsStatus })

    await compileColorPipeline()

    // ---- requests the operator asked for before the Director (captions, LUT, ...)
    let lutChosen = false
    if (config.setup) {
      const requests = parseRequests('--setup', JSON.parse(await readFile(config.setup, 'utf8')))
      await applyRequests({ label: 'setup', requests, scope: 'setup' })
      await settlePending('setup')
      lutChosen = requests.some((request) => /\/lut-selection(\?|$)/.test(request.path))
    }
    // A render needs an explicit LUT selection on the Version. Nobody asked for a look, so the minimal-intervention answer is recorded as
    // such (mode none: the source colours are left alone); a --setup request to /lut-selection replaces it.
    if (!lutChosen) {
      const current = await head()
      const lut = await call({
        method: 'POST', path: `${projectPath()}/lut-selection`, key: keyFor('lut-none', current.versionId), expect: [200, 201], allowError: true, label: 'lut-selection-none',
        body: { baseVersionId: current.versionId, baseHash: current.baseHash, selection: { mode: 'none' }, reason: `w70 journey ${runId}: no LUT was requested` },
      })
      if (!lut.ok && !(await committedDespiteProxyRefusal(lut, current.versionId))) {
        throw new JourneyError('UNEXPECTED_RESPONSE', `lut-selection answered ${lut.status} ${lut.error?.code}: ${lut.error?.message}${lut.error?.details?.reason ? ` (${lut.error.details.reason})` : ''}`, { status: lut.status, error: lut.error })
      }
      track(lut.data, 'lut-selection')
      await log('lut-selection', { mode: 'none', origin: 'minimal-intervention: no look was requested' })
    }
  }

  async function p3DirectorFirst() {
    await directDirector('first')
  }

  async function p4SpokenCuts() {
    if ((state.confirmedCuts ?? []).length > 0) {
      state.cuts = { skipped: true, reason: 'the cut was made through the owner confirmation of the speech removal', confirmedCuts: state.confirmedCuts }
      await log('cuts-skipped', { reason: 'confirmed through speech-removals.confirm' })
      return
    }
    const decision = await awaitDecision('remove-spoken-content', 1, { transcriptId: state.transcript.id, note: 'the closed vocabulary of the request has no removal directive: the phrases always come from this file' })
    if (decision.skip) {
      state.cuts = { skipped: true, reason: decision.reason, decision: decision.name, decisionSha256: decision.sha256 }
      await log('cuts-skipped', { reason: decision.reason })
      return
    }
    state.cuts = { decision: decision.name, decisionSha256: decision.sha256, commands: [] }
    // One Command: the cut is made on the project's single EditPlan, which every output re-materialises from; `variantId` names the output it goes through.
    const key = decision.variant
    const current = await head()
    const body = {
      type: 'remove-spoken-content', baseVersionId: current.versionId, baseHash: current.baseHash, sourceTranscriptId: state.transcript.id, variantId: state.variants[key].id,
      rules: decision.rules, ...(decision.exclusionOverrides ? { exclusionOverrides: decision.exclusionOverrides } : {}), ...(decision.reason ? { reason: decision.reason } : {}),
    }
    const response = await call({ method: 'POST', path: `${projectPath()}/commands`, key: keyFor('cut', key, current.versionId, decision.sha256), body, expect: [200, 201], allowError: true, label: `remove-spoken-content:${key}` })
    if (!response.ok) {
      const committed = await committedDespiteProxyRefusal(response, current.versionId)
      if (!committed) throw new JourneyError('UNEXPECTED_RESPONSE', `remove-spoken-content answered ${response.status} ${response.error?.code}: ${response.error?.message}${response.error?.details?.reason ? ` (${response.error.details.reason})` : ''}`, { status: response.status, error: response.error })
      const command = committed.workspace.commands.find((item) => item.resultVersionId === committed.versionId)
      state.cuts.commands.push({ key, commandId: command?.id, versionId: committed.versionId, exclusions: null, note: 'the response with the removed ranges was not returned (proxy request refused after the commit); the cut is verified by the forbiddenSpeechAbsent check of the next Director run' })
      await log('cut-applied', { key, commandId: command?.id, exclusions: 'not-returned' })
      return
    }
    track(response.data, `cut:${key}`)
    const editorial = response.data.editorial
    if (!editorial || (editorial.exclusions ?? []).length === 0) throw new JourneyError('CUT_EMPTY', 'remove-spoken-content removed nothing: the phrases were not found in the transcript', { editorial })
    state.cuts.commands.push({ key, commandId: response.data.command.id, versionId: response.data.version.id, exclusions: editorial.exclusions, retainedSourceRanges: editorial.retainedSourceRanges, outputDurationFrames: editorial.outputDurationFrames, fps: editorial.fps })
    await log('cut-applied', { key, commandId: response.data.command.id, exclusions: editorial.exclusions.length, outputDurationFrames: editorial.outputDurationFrames })
  }

  async function p5DirectorReview() {
    await directDirector('after-cuts')
    for (let round = 1; round <= config['max-review-rounds']; round += 1) {
      const { head: current, reviews } = await ensureReviews(round)
      await downloadProxies(reviews, `round${round}`)
      const summary = Object.fromEntries(outputKeys.map((key) => [key, summarizeReview(reviews[key])]))
      await writeEvidence(join('reviews', `round-${round}.json`), { versionId: current.versionId, reviews: summary, proxies: state.latestProxies })
      await log('proxy-review', { round, versionId: current.versionId, ...Object.fromEntries(outputKeys.map((key) => [`status_${key}`, reviews[key].status])) })
      const decision = await awaitDecision('proxy-review', round, { versionId: current.versionId, reviews: Object.fromEntries(outputKeys.map((key) => [key, { status: reviews[key].status, finalAllowed: reviews[key].finalAllowed, technicalIssues: (reviews[key].technicalIssues ?? []).length, criticIssues: (reviews[key].criticIssues ?? []).length }])) })
      const corrections = outputKeys.filter((key) => decision.outputs[key].decision === 'correct')
      if (corrections.length > 0) {
        for (const key of corrections) {
          await log('correction', { key, reason: decision.outputs[key].reason, requests: decision.outputs[key].requests.length })
          await applyRequests({ label: `correction-r${round}-${key}`, requests: decision.outputs[key].requests, scope: `correction-r${round}-${key}-${decision.sha256}` })
        }
        state.reviewRounds.push({ round, versionId: current.versionId, decision: decision.name, decisionSha256: decision.sha256, outcome: 'corrected', corrected: corrections })
        continue
      }
      for (const key of outputKeys) {
        const acknowledged = await acknowledgeIfAsked(key, reviews[key], decision.outputs[key])
        if (!acknowledged.finalAllowed) throw new JourneyError('REVIEW_NOT_FINAL', `output ${key}: the review does not allow a final after the decision`, { key, review: summarizeReview(acknowledged) })
        state.approvals[key] = { round, reviewId: acknowledged.id, reviewHash: acknowledged.reviewHash, versionId: current.versionId, acknowledgedWarnings: decision.outputs[key].acknowledgeWarnings, note: decision.outputs[key].note, decision: decision.name, decisionSha256: decision.sha256 }
      }
      state.reviewRounds.push({ round, versionId: current.versionId, decision: decision.name, decisionSha256: decision.sha256, outcome: 'approved' })
      return
    }
    throw new JourneyError('TOO_MANY_REVIEW_ROUNDS', `the outputs were not approved within ${config['max-review-rounds']} proxy review rounds`)
  }

  // ---- finals, download, inspection, manifest
  async function inspectFile(file, key, serverSha256) {
    const variant = state.variants[key]
    const probeRun = await runProcess(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 120_000 })
    if (probeRun.code !== 0) throw new JourneyError('FFPROBE_FAILED', `ffprobe failed on ${key}: ${probeRun.stderr.slice(0, 300)}`)
    const probed = JSON.parse(probeRun.stdout)
    const video = (probed.streams ?? []).find((stream) => stream.codec_type === 'video')
    const audio = (probed.streams ?? []).find((stream) => stream.codec_type === 'audio')
    const rate = (text) => { const [n, d] = String(text ?? '0/1').split('/').map(Number); return d ? n / d : Number(n) }
    const summary = {
      container: probed.format?.format_name, durationSeconds: Number(probed.format?.duration), sizeBytes: Number(probed.format?.size), bitRate: Number(probed.format?.bit_rate),
      video: video ? { codec: video.codec_name, profile: video.profile, width: video.width, height: video.height, fps: rate(video.avg_frame_rate), rFrameRate: rate(video.r_frame_rate), pixelFormat: video.pix_fmt, frames: Number(video.nb_frames) || undefined } : null,
      audio: audio ? { codec: audio.codec_name, channels: audio.channels, sampleRateHz: Number(audio.sample_rate), durationSeconds: Number(audio.duration) || undefined } : null,
    }
    const decodeStarted = Date.now()
    const decode = await runProcess(config.ffmpeg, ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'], { timeoutMs: 1_800_000, captureLimit: 8192 })
    const decodeResult = { exitCode: decode.code, stderrBytes: decode.stderrBytes ?? 0, stderr: decode.stderr.slice(0, 2000), durationMs: Date.now() - decodeStarted }
    const checks = [
      { id: 'video-codec-h264', ok: summary.video?.codec === 'h264', detail: summary.video?.codec },
      { id: 'container-mp4', ok: /mp4/.test(summary.container ?? ''), detail: summary.container },
      { id: 'dimensions-match-output-spec', ok: summary.video?.width === variant.width && summary.video?.height === variant.height, detail: `${summary.video?.width}x${summary.video?.height} vs ${variant.width}x${variant.height}` },
      { id: 'fps-matches-output-spec', ok: Math.abs((summary.video?.fps ?? 0) - variant.fps) <= 0.01, detail: `${summary.video?.fps} vs ${variant.fps}` },
      { id: 'duration-positive', ok: summary.durationSeconds > 0, detail: summary.durationSeconds },
      { id: 'full-decode-clean', ok: decodeResult.exitCode === 0 && decodeResult.stderrBytes === 0, detail: `exit ${decodeResult.exitCode}, stderr ${decodeResult.stderrBytes} bytes` },
      ...(serverSha256 ? [{ id: 'sha256-matches-server-artifact', ok: false, detail: 'set below' }] : []),
    ]
    return { summary, decode: decodeResult, checks, ffprobeRaw: probed }
  }

  async function finalizeOutputs(keys, round, approvals) {
    const current = await head()
    const operations = {}
    for (const key of keys) {
      const variantId = state.variants[key].id
      const exportRequest = {
        method: 'POST', path: `${projectPath()}/exports`, key: keyFor('export', key, current.versionId, round), expect: [200, 201, 202], label: `export:${key}`,
        body: { projectVersionId: current.versionId, projectVersionHash: current.baseHash, format: key, variantId, approval: { approved: true, ...(approvals[key]?.note ? { note: approvals[key].note } : {}) } },
      }
      let exported = await call({ ...exportRequest, allowError: true })
      if (!exported.ok && exported.error?.code === 'ASSET_RIGHTS_BLOCKED') {
        await log('rights-blocked', { key, message: 'the export was refused for the rights of the source: the owner states them' })
        await stateRights({ blockedBy: 'export', key })
        exported = await call({ ...exportRequest, allowError: true })
      }
      if (!exported.ok) throw new JourneyError('UNEXPECTED_RESPONSE', `export of ${key} answered ${exported.status} ${exported.error?.code}: ${exported.error?.message}${exported.error?.details?.reason ? ` (${exported.error.details.reason})` : ''}`, { status: exported.status, error: exported.error })
      operations[key] = exported.data.operation.id
      await log('final-requested', { key, operationId: operations[key], round })
    }
    const results = []
    for (const key of keys) {
      const operation = await waitOperation(operations[key], `final:${key}`)
      if (operation.target?.type !== 'media-artifact') throw new JourneyError('UNEXPECTED_RESPONSE', `the final export operation of ${key} has no media artifact target`, { target: operation.target })
      const artifactId = operation.target.id
      const file = join(config.evidence, 'outputs', key.replace(':', 'x'), `round${round}-${basename(artifactId)}.mp4`)
      const downloaded = await downloadArtifact(artifactId, file, `final ${key}`)
      const artifact = await call({ path: `/v1/artifacts/${encodeURIComponent(artifactId)}`, label: `artifact:${key}` })
      const serverSha256 = findKey(artifact.data, 'sha256')
      const inspected = await inspectFile(file, key, typeof serverSha256 === 'string' ? serverSha256 : undefined)
      const shaCheck = inspected.checks.find((check) => check.id === 'sha256-matches-server-artifact')
      if (shaCheck) { shaCheck.ok = serverSha256 === downloaded.sha256; shaCheck.detail = `${downloaded.sha256} vs ${serverSha256}` }
      await writeEvidence(join('inspection', `${key.replace(':', 'x')}-round${round}.json`), { key, artifactId, file, ...downloaded, serverSha256, ffprobe: inspected.ffprobeRaw, summary: inspected.summary, decode: inspected.decode, checks: inspected.checks })
      const failed = inspected.checks.filter((check) => !check.ok)
      const lastRun = state.directorRuns.at(-1)
      const record = {
        key, round, variantId: state.variants[key].id, versionId: current.versionId, versionHash: current.baseHash, exportOperationId: operations[key], artifactId, manifestId: operation.target.manifestId,
        file, sha256: downloaded.sha256, byteSize: downloaded.byteSize, serverSha256: typeof serverSha256 === 'string' ? serverSha256 : null, grantId: downloaded.grantId,
        ffprobe: inspected.summary, decode: inspected.decode, checks: inspected.checks, directorRunId: lastRun?.id, qualityReportId: lastRun?.qualityReportId, qualitySnapshotId: lastRun?.qualitySnapshotId,
        approval: approvals[key], operation: { createdAt: operation.createdAt, completedAt: operation.completedAt },
      }
      state.finals = state.finals.filter((item) => !(item.key === key && item.round === round))
      state.finals.push(record)
      await log('final-inspected', { key, round, sha256: downloaded.sha256, bytes: downloaded.byteSize, failedChecks: failed.map((check) => check.id).join(',') || 'none' })
      results.push({ record, failed })
    }
    return results
  }

  function manifest(version, extra = {}) {
    return {
      schemaVersion: `w70-journey-manifest/${version}`, runId, generatedAt: iso(),
      project: state.project, originalProject: state.originalProject, creationVersion: state.creationVersion, briefing: state.briefing, outputs: state.variants,
      master: state.master, transcript: state.transcript, interpretation: state.interpretation, revisions: state.revisions, cuts: state.cuts,
      directorRuns: state.directorRuns, commands: state.commands, operations: state.operations, reviewRounds: state.reviewRounds, approvals: state.approvals,
      finals: state.finals, timings: state.timings, ...extra,
    }
  }
  const writeManifest = async (name, version, extra) => {
    const path = join(config.evidence, name)
    const temp = `${path}.tmp`
    await writeFile(temp, `${JSON.stringify(sanitize(manifest(version, extra), secrets), null, 2)}\n`)
    await rename(temp, path)
    await log('manifest-written', { file: path })
  }
  const assertInspection = (results) => {
    const failures = results.flatMap(({ record, failed }) => failed.map((check) => `${record.key}:${check.id} (${check.detail})`))
    if (failures.length > 0) throw new JourneyError('INSPECTION_FAILED', `a delivered MP4 failed inspection: ${failures.join('; ')}`, { failures })
  }

  async function p6FinalInspection() {
    const results = await finalizeOutputs(outputKeys, 1, state.approvals)
    await writeManifest('w70-manifest.json', 1, { outcome: results.every(({ failed }) => failed.length === 0) ? 'inspected' : 'inspection-failed' })
    assertInspection(results)
    await log('owner-review-requested', { message: 'the finals are downloaded, hashed and decoded: send them to the owner for review', files: results.map(({ record }) => record.file).join(' ') })
  }

  async function p7OwnerCorrection() {
    const decision = await awaitDecision('owner-correction', 1, { finals: state.finals.map((item) => ({ key: item.key, sha256: item.sha256 })) })
    state.ownerCorrection = { decision: decision.name, decisionSha256: decision.sha256, reason: decision.reason, outputs: Object.keys(decision.outputs), runDirector: decision.runDirector }
    const delivered = await head()
    if (delivered.workspace.project.status === 'completed' && !state.originalProject) await duplicateForCorrection(delivered)
    if (decision.requests.length > 0) await applyRequests({ label: 'owner-correction', requests: decision.requests, scope: `owner-correction-${decision.sha256}` })
    if (decision.runDirector) await directDirector('owner-correction')
    const keys = Object.keys(decision.outputs)
    const { head: current, reviews } = await ensureReviews('owner-correction', keys)
    await downloadProxies(reviews, 'owner-correction', keys)
    const approvals = {}
    for (const key of keys) {
      const acknowledged = await acknowledgeIfAsked(key, reviews[key], decision.outputs[key])
      if (!acknowledged.finalAllowed) throw new JourneyError('REVIEW_NOT_FINAL', `output ${key}: after the owner's correction the review does not allow a final`, { key, review: summarizeReview(acknowledged) })
      approvals[key] = { round: 2, reviewId: acknowledged.id, reviewHash: acknowledged.reviewHash, versionId: current.versionId, acknowledgedWarnings: decision.outputs[key].acknowledgeWarnings, note: decision.outputs[key].note, decision: decision.name, decisionSha256: decision.sha256 }
    }
    state.correctionApprovals = approvals
    const results = await finalizeOutputs(keys, 2, approvals)
    await writeManifest('w70-manifest.v2.json', 2, { outcome: results.every(({ failed }) => failed.length === 0) ? 'inspected' : 'inspection-failed', ownerCorrection: state.ownerCorrection })
    assertInspection(results)
    await log('owner-review-requested', { message: 'the corrected finals are downloaded, hashed and decoded: send them to the owner for review', files: results.map(({ record }) => record.file).join(' ') })
  }

  async function p8OwnerAcceptance() {
    const decision = await awaitDecision('owner-acceptance', 1, { latestFinals: state.finals.filter((item) => item.round === Math.max(...state.finals.map((other) => other.round))).map((item) => ({ key: item.key, sha256: item.sha256 })) })
    state.acceptance = { accepted: decision.accepted, by: decision.by, note: decision.note, recordedAt: decision.recordedAt ?? iso(), decision: decision.name, decisionSha256: decision.sha256 }
    await writeManifest('w70-manifest.v2.json', 2, { outcome: decision.accepted ? 'accepted-by-owner' : 'rejected-by-owner', ownerCorrection: state.ownerCorrection, acceptance: state.acceptance })
    await log('owner-acceptance', { accepted: decision.accepted, by: decision.by })
    if (!decision.accepted) throw new JourneyError('OWNER_REJECTED', 'the owner did not accept the result (recorded in the manifest)', {}, EXIT.ownerRejected)
  }

  // ---- run the phases
  const implementations = {
    'p1-create-project': p1CreateProject, 'p2-outputs-ingest': p2OutputsIngest, 'p3-director-first': p3DirectorFirst, 'p4-spoken-cuts': p4SpokenCuts,
    'p5-director-review': p5DirectorReview, 'p6-final-inspection': p6FinalInspection, 'p7-owner-correction': p7OwnerCorrection, 'p8-owner-acceptance': p8OwnerAcceptance,
  }
  // The server must be reachable before anything is attempted.
  const health = await fetch(`${config.apiBaseUrl}/v1/health`, { signal: AbortSignal.timeout(10_000) }).catch((error) => ({ ok: false, status: String(error?.cause?.code ?? error?.message) }))
  if (!health.ok) throw new JourneyError('SERVER_UNREACHABLE', `${config.apiBaseUrl}/v1/health did not answer ok (${health.status})`)
  for (const tool of [config.ffmpeg, config.ffprobe]) {
    const probe = await runProcess(tool, ['-version'], { timeoutMs: 15_000 })
    if (probe.code !== 0) throw new JourneyError('TOOL_MISSING', `${tool} cannot run (${String(probe.stderr).slice(0, 200)}): pass --ffmpeg/--ffprobe or set FFMPEG_PATH/FFPROBE_PATH`)
  }

  let outcome = 'completed'
  try {
    for (const id of PHASES) {
      if (completed.has(id)) { phase = id; await log('phase-skipped', { reason: 'already completed' }); continue }
      phase = id
      const startedAt = iso()
      const started = Date.now()
      await log('phase-start', { startedAt })
      state.timings[id] = { ...state.timings[id], startedAt }
      await implementations[id]()
      const durationMs = Date.now() - started
      state.timings[id] = { ...state.timings[id], endedAt: iso(), durationMs }
      await log('phase-complete', { durationMs, decisionWaitMs: state.timings[id].decisionWaitMs ?? 0, state: JSON.parse(JSON.stringify(state)) })
      completed.add(id)
    }
  } catch (error) {
    outcome = error instanceof JourneyError ? error.code : 'ERROR'
    await log('journey-failed', { code: error instanceof JourneyError ? error.code : 'ERROR', message: error.message, ...(error instanceof JourneyError ? { details: error.details } : { stack: String(error.stack).split('\n').slice(0, 6).join(' | ') }) }).catch(() => undefined)
    throw error
  } finally {
    await writeFile(join(config.evidence, 'journey-state.json'), `${JSON.stringify(sanitize({ runId, outcome, completedPhases: [...completed], state }, secrets), null, 2)}\n`).catch(() => undefined)
  }
  await log('journey-complete', { runId })
  return { runId, completedPhases: [...completed] }
}

// ====================================================================================================================
async function main() {
  let config
  try {
    config = parseArguments(process.argv.slice(2), process.env, { repositoryRoot: REPOSITORY_ROOT })
    if (config.help) { console.log(usage()); return 0 }
    await runJourney(config)
    return 0
  } catch (error) {
    if (error instanceof JourneyError) {
      console.error(`w70-owner-journey: ${error.code}: ${error.message}`)
      if (error.code === 'USAGE') console.error('run with --help for the options')
      return error.exitCode
    }
    console.error(`w70-owner-journey: unexpected error: ${error?.stack ?? error}`)
    return EXIT.failure
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
