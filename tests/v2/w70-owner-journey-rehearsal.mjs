// Rehearsal of scripts/validation/w70-owner-journey.mjs against a real local server, real PostgreSQL, real FFmpeg and a SYNTHETIC master.
//
// Not a CI suite (no .test/.e2e suffix): it is run by the supervised local harness, which owns the PostgreSQL cluster and the workload lock:
//
//   cd <checkout>; APOLLO_S2D_CHECKOUT=<checkout> node <harness>/run-local-pg-s2d.mjs w70-rehearsal [--build] --plan <plan.json> --
//   plan.json: [{ "name": "journey", "appName": "apollo-video-e2e-w70-rehearsal", "urlParams": { "connection_limit": 4 },
//                 "args": ["node_modules/tsx/dist/cli.mjs", "tests/v2/w70-owner-journey-rehearsal.mjs"], "timeoutMs": 2400000 }]
// (tsx, like the production workers: the product's TypeScript uses syntax that Node's strip-only mode refuses)
//
// What is real: the server (`next start`), the PostgreSQL schema, the public /v1 API, the ingest/proxy/final workers, FFmpeg/FFprobe, the
// brief-interpreter adapter (against the repository's local stand-in of the provider). What is stood in, and why: the speech provider
// (Groq: no secret in a rehearsal, so the ingest worker's `fetch` of that one host answers a synthetic verbose_json), the interpreter
// model (the stand-in answers a scripted reading), the MP4 pixel critic (no private OpenVINO runtime here: the final worker runs under a
// recorded sandbox acknowledgement, which is refused in production), and the human decisions (this file writes them, as the owner would).
// Every string of content below is a placeholder; the master is a generated test pattern and a tone.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { startBriefInterpreterStandIn } from './helpers/brief-interpreter-stand-in.mjs'

const execute = promisify(execFile)
const cwd = process.cwd()
const url = new URL(process.env.V2_DATABASE_URL ?? 'postgresql://invalid')
assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname), 'the rehearsal only runs against a local PostgreSQL')
assert.match(url.pathname, /e2e/, 'the database name says e2e')
assert.match(url.searchParams.get('application_name') ?? '', /^apollo-video-e2e-/)
assert.ok(existsSync(join(cwd, '.next', 'BUILD_ID')), 'a production build is required: run the harness with --build')
const evidenceBase = process.env.APOLLO_S2D_EVIDENCE_DIR
assert.ok(evidenceBase, 'APOLLO_S2D_EVIDENCE_DIR (the harness evidence directory) is required: the rehearsal writes outside the repository')
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg'
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe'

const suffix = randomUUID().slice(0, 8)
const rehearsal = join(evidenceBase, 'w70-rehearsal')
const evidence = join(rehearsal, 'evidence')
const decisions = join(rehearsal, 'decisions')
const inputs = join(rehearsal, 'inputs')
const scratch = join(rehearsal, 'scratch')
for (const directory of [evidence, decisions, inputs, scratch]) await mkdir(directory, { recursive: true })
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const freePort = () => new Promise((done, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const { port } = socket.address(); socket.close(() => done(port)) }) })
const result = { schemaVersion: 'w70-rehearsal/v1', suffix, startedAt: new Date().toISOString(), master: 'synthetic test pattern and tone (generated here)', stoodIn: ['speech provider (Groq)', 'interpreter model (local stand-in)', 'MP4 pixel critic (sandbox acknowledgement)', 'human decisions (written by this rehearsal)'], runs: [], checks: [] }
const save = () => writeFile(join(rehearsal, 'rehearsal-result.json'), JSON.stringify(result, null, 2))
const check = async (id, ok, detail) => { result.checks.push({ id, ok: Boolean(ok), detail }); await save(); assert.ok(ok, `${id}: ${detail}`) }

// ---- the synthetic master: a test pattern and a tone, tagged BT.709 so the colour probe is ready
const masterPath = join(inputs, 'master.mp4')
await execute(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-c:a', 'aac', '-shortest', masterPath], { windowsHide: true, timeout: 120_000 })
const masterBytes = await readFile(masterPath)
const masterSha = hash(masterBytes)

// ---- placeholders of the scripted world
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar']
const briefingFirst = 'Rehearsal briefing over synthetic media. Zoom in slowly at the start. Remove the part about the placeholder topic.'
const briefingSecond = 'Rehearsal briefing over synthetic media. Remove the part about the placeholder topic.'
await writeFile(join(inputs, 'briefing.txt'), briefingFirst)
// The final export delivers the product's format preset geometry (a custom width/height in the variant is not what comes out: the journey's inspection catches that), so the rehearsal asks for none.
await writeFile(join(inputs, 'output-spec.json'), JSON.stringify({ '9:16': { subtitles: { mode: 'none' } } }))

const factory = await import('../../src/v2/infrastructure/repository-factory.ts')
const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
const { FOUNDATION_CAPABILITIES } = await import('../../src/v2/public-api/capability-registry.ts')
const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')

const standIn = await startBriefInterpreterStandIn()
// The model answers with the words it quotes; the Apollo finds them in the briefing and computes the offsets itself.
standIn.script.set(briefingFirst, {
  directives: [{ kind: 'movement', value: 'zoom-in', param: null, quote: 'Zoom in slowly at the start' }],
  unsupported: [], questions: [], coverage: [],
})

const workspaceId = `w70-rehearsal-${suffix}`
await factory.createWorkspaceRepository().create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'W70 journey rehearsal', status: 'active', createdAt: new Date().toISOString() }))
const scopes = [...new Set(FOUNDATION_CAPABILITIES.flatMap((capability) => [...capability.requiredScopes]))].sort()
const issued = await createApiClientService({ repository: factory.createApiClientRepository(), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date() })({ id: `w70-rehearsal-client-${suffix}`, workspaceId, name: 'W70 rehearsal actor', environment: 'production', scopes })

const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}`
const artifactRoot = join(scratch, 'artifacts')
await mkdir(artifactRoot, { recursive: true })
const environment = {
  ...process.env, ...standIn.environment, NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true', APOLLO_API_ENVIRONMENT: 'production',
  APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local', APOLLO_V2_RENDER_WORK_ROOT: join(scratch, 'work'),
  APOLLO_MEDIA_UPLOAD_BASE_URL: `${baseUrl}/`, APOLLO_MEDIA_UPLOAD_SIGNING_SECRET: `rehearsal-upload-${suffix}-with-at-least-32-bytes`,
  APOLLO_MEDIA_DOWNLOAD_BASE_URL: `${baseUrl}/`, APOLLO_MEDIA_DOWNLOAD_SIGNING_SECRET: `rehearsal-download-${suffix}-with-at-least-32-bytes`,
  GROQ_API_KEY: `synthetic-groq-key-${suffix}-not-a-real-credential`, GROQ_TRANSCRIBE_MODEL: 'whisper-large-v3-turbo', GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR: '4',
}
let serverLogs = ''
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
const collect = (chunk) => { serverLogs = (serverLogs + String(chunk)).slice(-20_000) }
server.stdout.on('data', collect)
server.stderr.on('data', collect)

// ---- workers in this process: the speech provider is the one stood-in host
const realFetch = globalThis.fetch
const speechCalls = []
globalThis.fetch = async (input, init) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!target.startsWith('https://api.groq.com/')) return realFetch(input, init)
  speechCalls.push({ at: new Date().toISOString(), language: init?.body?.get?.('language') ?? null })
  const words = WORDS.map((word, index) => ({ word, start: index * 0.8, end: index * 0.8 + 0.6 }))
  const segments = [0, 5, 10].map((from, id) => ({ id, text: WORDS.slice(from, from + 5).join(' '), start: from * 0.8, end: (from + 4) * 0.8 + 0.6, avg_logprob: -0.1 }))
  return new Response(JSON.stringify({ text: WORDS.join(' '), language: 'english', duration: 12, words, segments }), { status: 200, headers: { 'content-type': 'application/json' } })
}
const finalEnvironment = { ...environment, APOLLO_API_ENVIRONMENT: 'sandbox', APOLLO_V2_MP4_CRITIC_ACK_ACTOR: 'w70-rehearsal', APOLLO_V2_MP4_CRITIC_ACK_AT: new Date().toISOString(), APOLLO_V2_MP4_CRITIC_ACK_REASON: 'rehearsal runs no private pixel oracle; the real journey wires the seven APOLLO_V2_PIXEL_ORACLE variables' }
const workerLog = []
const runners = {
  ingest: factory.createMediaIngestWorker(environment),
  proxy: factory.createProjectProxyRenderWorker(environment, () => new Date(), ({ operationId, error }) => workerLog.push({ at: new Date().toISOString(), worker: 'proxy', operationId, code: error.code, message: error.message, details: error.details })),
  final: factory.createProjectFinalExportWorker(finalEnvironment),
}
let stopping = false
const workerLoop = (async () => {
  while (!stopping) {
    let worked = false
    for (const [name, run] of Object.entries(runners)) {
      try {
        const outcome = name === 'proxy' ? await run(`rehearsal-${name}-${suffix}`, { signal: AbortSignal.timeout(600_000) }) : await run(`rehearsal-${name}-${suffix}`, AbortSignal.timeout(600_000))
        if (outcome) { worked = true; workerLog.push({ at: new Date().toISOString(), worker: name, outcome }) }
      } catch (error) { workerLog.push({ at: new Date().toISOString(), worker: name, error: String(error?.stack ?? error).slice(0, 1500) }) }
    }
    if (!worked) await delay(500)
  }
})()

// ---- the human: writes the decision files when the journey asks for them
const rules = [{ id: 'placeholder-topic', label: 'placeholder topic', alternatives: [WORDS.slice(6, 9).join(' ')] }]
const requestsForCorrection = [{ method: 'POST', path: '/v1/projects/{{projectId}}/commands', body: { type: 'run-director', baseVersionId: '{{head.versionId}}', baseHash: '{{head.baseHash}}', reason: 'rehearsal owner correction' } }]
const decisionContent = {
  'revise-editorial-request.json': { reason: 'The renderer executes no movement: the zoom is taken out of the request (rehearsal).', briefing: briefingSecond },
  'source-rights.json': { reason: 'rehearsal', body: { status: 'approved', allowedUses: ['editorial-reuse', 'rendering', 'editing', 'distribution', 'transcription'], prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] }, sourceNote: 'synthetic rehearsal master' } },
  'derived-rights.json': { reason: 'rehearsal: the owner states the rights of the proxies and finals', body: { status: 'approved', allowedUses: ['editorial-reuse', 'rendering', 'editing', 'distribution', 'transcription'], prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] }, sourceNote: 'derived from the synthetic rehearsal master' } },
  'remove-spoken-content.json': { variant: '9:16', rules, reason: 'Remove the placeholder topic (rehearsal).' },
  'proxy-review.json': { outputs: { '9:16': { decision: 'approve', acknowledgeWarnings: true, note: 'approved in the rehearsal' }, '16:9': { decision: 'approve', acknowledgeWarnings: true } } },
  'owner-correction.json': { reason: 'The owner asks for a new pass of the Director (rehearsal).', requests: requestsForCorrection, outputs: { '9:16': { approve: true, acknowledgeWarnings: true, note: 'owner correction approved in the rehearsal' } } },
  'owner-acceptance.json': { accepted: true, by: 'rehearsal owner', note: 'accepted in the rehearsal' },
}
const written = new Set()
let humanStopped = false
let humanActive = false
const human = (async () => {
  let offset = 0
  while (!humanStopped) {
    if (!humanActive) { await delay(200); continue }
    const log = await readFile(join(evidence, 'journey-log.jsonl'), 'utf8').catch(() => '')
    const lines = log.split('\n').filter(Boolean)
    for (const line of lines.slice(offset)) {
      const entry = JSON.parse(line)
      if (entry.event === 'awaiting-decision' && !written.has(entry.decision)) {
        const content = decisionContent[entry.decision]
        if (!content) { result.unplannedDecision = entry.decision; await save(); continue }
        written.add(entry.decision)
        // The first file arrives half written, then complete: the driver must wait for valid JSON, not fail on the partial one.
        if (written.size === 1) { await writeFile(join(decisions, entry.decision), '{"reason":'); await delay(2500) }
        await writeFile(join(decisions, entry.decision), JSON.stringify(content, null, 2))
      }
    }
    offset = lines.length
    await delay(400)
  }
})()

const runJourney = async (label, extra, { timeoutMs }) => {
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/validation/w70-owner-journey.mjs',
    '--briefing', join(inputs, 'briefing.txt'), '--objective', 'awareness', '--outputs', '9:16,16:9', '--output-spec', join(inputs, 'output-spec.json'),
    '--master', masterPath, '--master-sha256', masterSha, '--master-size', String(masterBytes.length), '--rights-confirmed',
    '--evidence', evidence, '--decisions', decisions, '--poll-ms', '300', '--operation-poll-ms', '500', '--ffmpeg', ffmpeg, '--ffprobe', ffprobe, ...extra],
  { cwd, env: { ...process.env, APOLLO_API_BASE_URL: baseUrl, APOLLO_API_TOKEN: issued.token }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
  const code = await new Promise((done) => child.once('close', done))
  clearTimeout(timer)
  await writeFile(join(rehearsal, `journey-run-${label}.log`), output.replaceAll(issued.token, '[REDACTED]'))
  result.runs.push({ label, exitCode: code, endedAt: new Date().toISOString() })
  await save()
  return { code, output }
}

try {
  const deadline = Date.now() + 120_000
  for (;;) {
    try { if ((await realFetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(1000) })).ok) break } catch { /* not up yet */ }
    assert.equal(server.exitCode, null, `the server exited: ${serverLogs.slice(-2000)}`)
    assert.ok(Date.now() < deadline, `the server did not start: ${serverLogs.slice(-2000)}`)
    await delay(300)
  }

  // Run 1: nobody answers. The journey must stop closed (exit 3) at the first decision it needs, with phases 1 and 2 complete.
  const stopped = await runJourney('1-no-decisions', ['--decision-timeout-ms', '6000'], { timeoutMs: 900_000 })
  const log1 = (await readFile(join(evidence, 'journey-log.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  await check('first-run-stops-closed-awaiting-a-decision', stopped.code === 3, `exit ${stopped.code}`)
  {
    await check('first-run-completed-phases-1-and-2', ['p1-create-project', 'p2-outputs-ingest'].every((id) => log1.some((entry) => entry.event === 'phase-complete' && entry.phase === id)), 'p1/p2 phase-complete lines')
    await check('first-run-names-the-decision-it-awaits', log1.some((entry) => entry.event === 'awaiting-decision'), log1.filter((entry) => entry.event === 'awaiting-decision').map((entry) => entry.decision).join(','))
  }
  // Run 2: --resume, with the human answering as the journey asks.
  humanActive = true
  const resumed = await runJourney('2-resume', ['--resume', '--decision-timeout-ms', '600000'], { timeoutMs: 2_100_000 })
  await check('resumed-run-completes', resumed.code === 0, `exit ${resumed.code}`)
} catch (error) {
  result.failure = String(error?.stack ?? error)
  throw error
} finally {
  humanStopped = true
  stopping = true
  await Promise.race([Promise.all([human, workerLoop]), delay(30_000)])
  globalThis.fetch = realFetch
  result.endedAt = new Date().toISOString()
  result.speechCalls = speechCalls
  result.interpreterCalls = standIn.calls.map((call) => ({ authorized: call.authorized, briefingSha256: hash(call.briefing) }))
  result.workerLog = workerLog.slice(-60)
  // Diagnostic only: the rights each artifact of the workspace carries (a refusal for rights does not say which artifact or why).
  try {
    const { PrismaClient } = await import('../../generated/prisma-v2/index.js')
    const prisma = new PrismaClient()
    const artifacts = await prisma.v2MediaArtifact.findMany({ where: { workspaceId }, include: { currentRightsSnapshot: true } })
    result.rightsDiagnostic = artifacts.map((artifact) => ({ id: artifact.id, mediaType: artifact.mediaType, kind: artifact.kind ?? null, snapshot: artifact.currentRightsSnapshot ? { status: artifact.currentRightsSnapshot.status, allowedUses: artifact.currentRightsSnapshot.allowedUsesJson ?? artifact.currentRightsSnapshot.allowedUses, locales: artifact.currentRightsSnapshot.allowedLocalesJson ?? null } : null }))
    await prisma.$disconnect()
  } catch (error) { result.rightsDiagnostic = String(error?.message ?? error).slice(0, 300) }
  result.serverLogTail = serverLogs.replaceAll(issued.token, '[REDACTED]').slice(-6000)
  await writeFile(join(rehearsal, 'workers.json'), JSON.stringify(workerLog, null, 2)).catch(() => undefined)
  await save()
  if (server.exitCode === null) {
    server.kill('SIGTERM')
    for (let attempt = 0; attempt < 40 && server.exitCode === null; attempt += 1) await delay(250)
    if (server.exitCode === null) server.kill('SIGKILL')
  }
  await standIn.close().catch(() => undefined)
  await disconnectV2PostgresClient().catch(() => undefined)
}

// ---- what the journey left behind
const manifest = JSON.parse(await readFile(join(evidence, 'w70-manifest.v2.json'), 'utf8'))
await check('manifest-v2-records-the-acceptance', manifest.acceptance?.accepted === true && manifest.outcome === 'accepted-by-owner', manifest.outcome)
const firstManifest = JSON.parse(await readFile(join(evidence, 'w70-manifest.json'), 'utf8'))
await check('manifest-v1-has-both-outputs-inspected', firstManifest.finals.length === 2 && firstManifest.finals.every((item) => item.checks.every((entry) => entry.ok)), JSON.stringify(firstManifest.finals.map((item) => ({ key: item.key, sha256: item.sha256 }))))
await check('manifest-v2-has-the-corrected-final', manifest.finals.some((item) => item.round === 2 && item.key === '9:16'), 'round 2 for 9:16')
for (const item of manifest.finals) {
  const bytes = await readFile(item.file)
  await check(`downloaded-${item.key}-round${item.round}-hash-matches-manifest`, hash(bytes) === item.sha256 && bytes.length === item.byteSize, item.sha256)
  await check(`decode-${item.key}-round${item.round}-is-clean`, item.decode.exitCode === 0 && item.decode.stderrBytes === 0, JSON.stringify(item.decode))
}
await check('transcript-language-recorded-with-origin', manifest.transcript?.language && manifest.transcript?.languageOrigin, JSON.stringify(manifest.transcript))
await check('director-blocked-then-revised', manifest.revisions.length >= 1, JSON.stringify(manifest.revisions.map((item) => item.decision)))
await check('interpreter-read-both-briefings', standIn.calls.length >= 2, `${standIn.calls.length} interpreter calls`)
const files = async (directory) => (await readdir(directory, { withFileTypes: true, recursive: true })).filter((entry) => entry.isFile())
let leaked = 0
for (const entry of await files(evidence)) {
  const path = join(entry.parentPath ?? entry.path, entry.name)
  if ((await stat(path)).size < 5_000_000 && (await readFile(path, 'utf8').catch(() => '')).includes(issued.token)) leaked += 1
}
await check('evidence-never-contains-the-credential', leaked === 0, `${leaked} files`)
result.outcome = 'passed'
await save()
console.log(JSON.stringify({ event: 'w70-rehearsal-passed', rehearsal }))
