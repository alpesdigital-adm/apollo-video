import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, createReadStream, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { closeOwnedBrowser, observeOwnedBrowserLifecycle } from './library-browser-proof.mjs'
import { createDashboardPipelineObserver } from './dashboard-w36-pipeline-proof.mjs'
import { seedDashboardControlledExportFixture } from './dashboard-controlled-export-fixture.mjs'
import { installDashboardCancelDiagnostics, joinDashboardCancelEvents, validateDashboardCancelSnapshot } from './dashboard-cancel-diagnostics.mjs'

const exec = promisify(execFile)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export function assertDashboardLinuxCftBindings(manifest, owner, actor, sourcePin, sourceHead) {
  assert.equal(manifest.schemaVersion, 'dashboard-cft157-linux-acquisition/v1')
  assert.equal(manifest.outcome, 'files-verified-awaiting-owner'); assert.deepEqual(manifest.errors, [])
  assert.equal(manifest.sourceHead, sourceHead); assert.equal(manifest.sourceSha256, sourcePin)
  assert.equal(manifest.version, '157.0.8090.0'); assert.equal(manifest.revision, '@2ea1b71af70d7fc5d41325dda8df37c1f98ac531')
  assert.equal(manifest.nativeBrowserExecuted, false)
  assert.equal(owner.schemaVersion, 'perception-cgroup-owner-close/v1'); assert.equal(owner.mode, 'acquisition')
  assert.equal(owner.success, true); assert.deepEqual(owner.errors, []); assert.equal(owner.containmentRequired, false)
  assert.equal(owner.carrierCloseObserved, true); assert.equal(owner.guardianCloseObserved, true)
  assert.equal(owner.childCloseObserved, true); assert.equal(owner.empty.populated, 0); assert.equal(owner.empty.liveMembershipEmpty, true)
  assert.ok(owner.observed.length > 0 && owner.terminality.length === owner.observed.length && owner.terminality.every((row) => row.terminal))
  assert.ok(owner.actors.length >= 3 && owner.actors.every((row) => row.closeObserved))
  assert.equal(owner.sourceCommit, sourceHead); assert.equal(owner.acquisition.actorRunId, manifest.runId)
  assert.equal(actor.schemaVersion, 'dashboard-cft157-linux-child-close/v1'); assert.equal(actor.runId, manifest.runId)
  assert.equal(actor.birth.pid, manifest.pid); assert.equal(actor.closeObserved, true); assert.equal(actor.code, 0); assert.equal(actor.signal, null)
  assert.equal(manifest.requests.length, 2)
  assert.equal(manifest.requests[0].url, 'https://storage.googleapis.com/storage/v1/b/chrome-for-testing-public/o/157.0.8090.0%2Flinux64%2Fchrome-linux64.zip')
  assert.equal(manifest.requests[1].url, 'https://storage.googleapis.com/chrome-for-testing-public/157.0.8090.0/linux64/chrome-linux64.zip')
  for (const row of manifest.requests) {
    assert.equal(row.finalUrl, row.url); assert.equal(row.httpStatus, 200); assert.deepEqual(row.redirects, [])
    assert.equal(row.connectionFinallyClosed, true); assert.match(row.sha256, /^[a-f0-9]{64}$/)
  }
  assert.equal(manifest.requests[1].bytes, 201551103); assert.equal(manifest.requests[1].md5Measured, 'BvMevHF6ZEenSob5RNSB4g==')
  assert.equal(manifest.requests[1].crc32cOfficial, 'SFhLhQ=='); assert.equal(manifest.requests[1].crc32cCalculated, false)
}
async function admitDashboardLinuxCft() {
  assert.equal(process.platform, 'linux')
  const end = performance.now() + 60000
  const remaining = () => { const value = Math.floor(end - performance.now()); assert.ok(value > 0, 'Linux CfT admission deadline'); return value }
  const root = process.env.APOLLO_DASHBOARD_CFT157_LINUX_ROOT
  assert.equal(root, `${process.env.RUNNER_TEMP}/apollo-dashboard-cft157-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`)
  assert.ok(root.startsWith('/') && !root.includes('..') && !root.includes('\\'))
  assert.equal(await realpath(root), root); remaining()
  const rootFacts = await lstat(root); assert.ok(rootFacts.isDirectory() && !rootFacts.isSymbolicLink()); remaining()
  const read = async (path, maximum, expected) => {
    remaining(); assert.ok(path.startsWith(root + '/') || path.startsWith(process.env.APOLLO_PERCEPTION_PIDFD_ROOT + '/') || path === fileURLToPath(import.meta.url) || playwrightPaths.has(path))
    const before = await lstat(path); remaining(); assert.ok(before.isFile() && !before.isSymbolicLink() && before.size > 0 && before.size <= maximum)
    assert.equal(await realpath(path), path); remaining()
    const stream = createReadStream(path, { highWaterMark: 65536, signal: AbortSignal.timeout(remaining()) })
    const close = new Promise((done) => stream.once('close', done)), hash = createHash('sha256'), chunks = []
    let bytes = 0, primary
    try {
      for await (const chunk of stream) { remaining(); bytes += chunk.length; assert.ok(bytes <= maximum); hash.update(chunk); if (maximum <= 1048576) chunks.push(chunk) }
    } catch (error) { primary = error }
    finally { stream.destroy(); try { await close; remaining() } catch (error) { primary ??= error } }
    if (primary) throw primary
    const after = await lstat(path); remaining()
    assert.deepEqual([after.dev, after.ino, after.size, after.mtimeMs], [before.dev, before.ino, before.size, before.mtimeMs])
    assert.equal(bytes, before.size); const digest = hash.digest('hex'); if (expected) assert.equal(digest, expected)
    return { bytes, sha256: digest, raw: maximum <= 1048576 ? Buffer.concat(chunks) : null }
  }
  const playwrightPaths = new Set()
  const { readRegistry, jsonDigest, assertDashboardPlaywrightFacts } = await import('../../../scripts/validation/perception-addon-registry.mjs'); remaining()
  const registry = readRegistry(process.env.APOLLO_PERCEPTION_PIDFD_ROOT, process.env)
  assert.equal(process.env.APOLLO_PERCEPTION_PIDFD_PROVENANCE, process.env.APOLLO_PERCEPTION_PIDFD_ROOT + '/provenance.json')
  const provenance = JSON.parse((await read(process.env.APOLLO_PERCEPTION_PIDFD_PROVENANCE, 1048576, registry.provenanceSha256)).raw)
  assert.equal(provenance.success, true); assert.equal(provenance.childCloseObserved, true)
  assert.equal(provenance.runId, registry.runId); assert.equal(provenance.sourceCommit, process.env.GITHUB_SHA)
  assert.deepEqual(provenance.dashboardPlaywright, registry.dashboardPlaywright)
  const playwright = assertDashboardPlaywrightFacts(registry.dashboardPlaywright)
  for (const row of playwright.files) { playwrightPaths.add(row.path); const actual = await read(row.path, 16 * 1024 * 1024, row.sha256); assert.equal(actual.bytes, row.bytes) }
  const helperPath = fileURLToPath(import.meta.url), helperPin = registry.sourceFiles.find((row) => row.path === 'tests/v2/helpers/dashboard-runtime-journey.mjs')
  assert.ok(helperPin); await read(helperPath, 1048576, helperPin.sha256)
  const actorPin = registry.sourceFiles.find((row) => row.path === 'scripts/validation/acquire-dashboard-cft157-linux.py'); assert.ok(actorPin)
  assert.deepEqual(provenance.sourceFiles, registry.sourceFiles)
  const receiptDirectory = process.env.APOLLO_PERCEPTION_PIDFD_ROOT + '/receipts'
  const names = await readdir(receiptDirectory); remaining(); assert.ok(names.length <= 256)
  const owners = []
  for (const name of names.filter((name) => /^pidfd-consumer-cgroup-[a-f0-9-]+\.json$/.test(name))) {
    const packet = await read(receiptDirectory + '/' + name, 1048576)
    const row = JSON.parse(packet.raw)
    if (row.mode !== 'acquisition') continue
    const seal = await read(receiptDirectory + '/' + name.replace(/\.json$/, '.sha256'), 64)
    assert.equal(seal.raw.toString('utf8'), jsonDigest(row)); owners.push(row)
  }
  assert.equal(owners.length, 1, 'Exactly one closed acquisition owner is required before Chrome')
  const owner = owners[0]
  assert.equal(owner.acquisition.path, root + '/manifest.json')
  const manifestBytes = await read(root + '/manifest.json', 1048576, owner.acquisition.sha256)
  const manifest = JSON.parse(manifestBytes.raw); assert.equal(manifest.root, root)
  assert.equal(owner.acquisition.actorClose.path, root + '/actor-process.json')
  const actor = JSON.parse((await read(root + '/actor-process.json', 65536, owner.acquisition.actorClose.sha256)).raw)
  assertDashboardLinuxCftBindings(manifest, owner, actor, actorPin.sha256, process.env.GITHUB_SHA)
  assert.equal(manifest.inventory.path, root + '/inventory.json')
  const inventory = JSON.parse((await read(root + '/inventory.json', 1048576, manifest.inventory.sha256)).raw)
  assert.equal(inventory.schemaVersion, 'dashboard-cft157-linux-inventory/v1')
  assert.equal(inventory.fileCount, inventory.files.length); assert.ok(inventory.files.length > 0 && inventory.files.length <= 2000)
  const expected = new Set(), seen = new Set(); let total = 0
  for (const row of inventory.files) {
    assert.match(row.path, /^chrome-linux64\/[A-Za-z0-9_.+/-]+$/); assert.ok(!row.path.split('/').some((part) => !part || ['.', '..'].includes(part)))
    assert.ok(!seen.has(row.path.toLowerCase())); seen.add(row.path.toLowerCase()); expected.add(row.path)
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= 512 * 1024 * 1024)
    assert.ok([0o600, 0o700].includes(row.mode)); assert.match(row.sha256, /^[a-f0-9]{64}$/)
    if (row.bytes === 0) {
      const metadata = await lstat(root + '/' + row.path); remaining()
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size === 0)
      assert.equal(await realpath(root + '/' + row.path), root + '/' + row.path); assert.equal(row.sha256, sha256(Buffer.alloc(0)))
    } else await read(root + '/' + row.path, Math.max(1048577, row.bytes), row.sha256)
    const metadata = await lstat(root + '/' + row.path); remaining(); assert.equal(metadata.mode & 0o7777, row.mode)
    total += row.bytes; assert.ok(total <= 1200 * 1024 * 1024)
  }
  const actual = new Set()
  const walk = async (path) => {
    for (const name of await readdir(root + '/' + path, { withFileTypes: true })) {
      remaining(); assert.ok(!name.isSymbolicLink())
      const childPath = path + '/' + name.name
      if (name.isDirectory()) { assert.ok([...expected].some((item) => item.startsWith(childPath + '/'))); await walk(childPath) }
      else { assert.ok(name.isFile() && expected.has(childPath)); actual.add(childPath) }
    }
  }
  await walk('chrome-linux64'); assert.deepEqual(actual, expected); assert.equal(total, inventory.totalBytes)
  const rootNames = await readdir(root); remaining()
  assert.deepEqual(rootNames.sort(), ['actor-process.json', 'chrome-linux64', 'chrome-linux64.zip', 'inventory.json', 'manifest.json', 'metadata-gcs.json'].sort())
  await read(root + '/chrome-linux64.zip', 201551103, manifest.requests[1].sha256)
  await read(root + '/metadata-gcs.json', 65536, manifest.requests[0].sha256)
  const executable = inventory.files.find((row) => row.path === 'chrome-linux64/chrome'); assert.ok(executable && executable.mode === 0o700)
  remaining()
  return { browserExecutable: root + '/chrome-linux64/chrome', expectedRevision: manifest.revision,
    evidence: { proofScope: 'normal-dashboard-journey-with-pinned-linux-browser', causalityEstablished: false,
      sourceHead: manifest.sourceHead, manifestSha256: manifestBytes.sha256, inventorySha256: manifest.inventory.sha256,
      executable, playwright, acquisitionOwnerRunId: owner.runId, acquisitionCgroupTerminal: true,
      browserVersionObserved: false, versionSessionDetached: false } }
}
const CARD_EXPECTATIONS = {
  draft: { tone: 'neutral', color: 'text-[#aaa49a]', badge: 'Configuração', action: 'open-result', button: 'Abrir workspace →' },
  'rendering-proxy': { tone: 'info', color: 'text-[#79a5da]', badge: 'Renderizando proxy', action: 'view-progress', button: 'Acompanhar →' },
  'reviewing-proxy': { tone: 'warning', color: 'text-[#ca92d4]', badge: 'Revisar proxy', action: 'review-output', button: 'Revisar agora →' },
  revising: { tone: 'info', color: 'text-[#79a5da]', badge: 'Aplicando revisão', action: 'view-progress', button: 'Acompanhar →' },
  failed: { tone: 'danger', color: 'text-[#e08b8b]', badge: 'Requer atenção', action: 'inspect-error', button: 'Ver erro →' },
}

// W65b (final-caption-certification/v1, docs/quality/w65b-final-caption-certification.md section 3). The Director's report reaches the
// review as the warning it really is (face safety unknown), and a caption that cannot be certified is OMITTED and LISTED instead of
// being a hard stop: the review of a real render asks the operator to acknowledge the warnings (`warning-ack-required`) and the project
// waits in `reviewing-proxy`. It is no longer `blocked`, and the project no longer goes to `revising`: only a hard issue does that, and
// these runs have none. The final stays refused (`finalAllowed` false) until the warnings are acknowledged. What a review of a real
// render says is asserted whole, so a review that is blocked again, that carries a hard issue, that is already acknowledged, or that has
// lost a reason the run is known to produce, fails here.
const LISTED_REVIEW_STATUS = 'warning-ack-required'
const LISTED_PROJECT_STATUS = 'reviewing-proxy'
function assertListedReview(review, label, { requiredWarnings = [] } = {}) {
  assert.equal(review.status, LISTED_REVIEW_STATUS, `${label}: the review of an uncertified face claim asks for an acknowledgement`)
  assert.equal(review.finalAllowed, false, `${label}: the final stays refused until the warnings are acknowledged`)
  assert.equal(review.warningsAcknowledged, false, `${label}: nobody acknowledged them`)
  const issues = [...JSON.parse(review.technicalIssuesJson), ...JSON.parse(review.criticIssuesJson)]
  const seen = JSON.stringify(issues.map((issue) => [issue.code, issue.severity]))
  assert.deepEqual(issues.filter((issue) => issue.severity === 'hard'), [], `${label}: no hard issue: ${seen}`)
  for (const code of requiredWarnings) {
    assert.ok(issues.some((issue) => issue.code === code && issue.severity === 'warning'), `${label}: ${code} is listed as a warning: ${seen}`)
  }
}

// Fixed existing imports only; preparation never calls a repository, provider or worker factory.
const RUNTIME_IMPORTS = [
  ['public-operation', '../../../src/v2/infrastructure/prisma/public-operation-repository.ts', ['PrismaPublicOperationRepository']],
  ['repository-factory', '../../../src/v2/infrastructure/repository-factory.ts', ['createProjectProxyRenderWorker', 'createColorPipelineCompilationRepository']],
  ['proxy-repository', '../../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts', ['PrismaProjectProxyRenderRepository']],
  ['final-repository', '../../../src/v2/infrastructure/prisma/project-final-export-repository.ts', ['PrismaProjectFinalExportRepository']],
  ['rights-repository', '../../../src/v2/infrastructure/prisma/asset-rights-repository.ts', ['PrismaAssetRightsRepository']],
  ['final-admission', '../../../src/v2/application/enqueue-project-final-export.ts', ['enqueueProjectFinalExportService']],
  ['version-hash', '../../../src/v2/application/version-hash.ts', ['calculateVersionHash', 'stableSerialize']],
  ['payload-cipher', '../../../src/v2/infrastructure/security/recipe-parameter-cipher.ts', ['createProtectedPayloadCipherFromEnvironment']],
  ['video-probe', '../../../src/v2/infrastructure/media/video-probe.ts', ['probeVideo']],
  ['ffmpeg-resolution', '../../../src/v2/infrastructure/media/ffmpeg-binary.ts', ['resolveFfmpegBinary']],
  ['playwright', 'playwright-core', ['chromium']],
  ['color-contract', '../../../src/v2/public-api/color-pipeline-compilation-contract.ts', ['parseCreateColorPipelineCompilationBody']],
  ['lut-service', '../../../src/v2/application/project-lut-selections.ts', ['setProjectLutSelectionService']],
  ['lut-repository', '../../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts', ['PrismaProjectLutSelectionRepository']],
]
function createRuntimePreparation(importModule) {
  let pending
  return async ({ signal }) => {
    assert.ok(signal instanceof AbortSignal, 'Runtime preparation requires the owned test signal')
    signal.throwIfAborted()
    if (!pending) pending = (async () => {
      const startedAt = Date.now(), started = performance.now(), modules = [], bindings = {}
      let stage = 'preparation-start', moduleId = null
      try {
        for (const [id, specifier, names] of RUNTIME_IMPORTS) {
          signal.throwIfAborted(); stage = 'import-start'; moduleId = id
          const importStartedAt = Date.now(), importStarted = performance.now()
          const loaded = await importModule(specifier)
          // Native import is not cancellable; a late result never admits resources or publishes readiness.
          stage = 'import-return'; signal.throwIfAborted()
          for (const name of names) {
            const value = loaded[name]
            if (name === 'chromium') assert.equal(typeof value?.launchServer, 'function', 'Prepared Chromium binding is incomplete')
            else assert.equal(typeof value, 'function', `Prepared ${name} binding is incomplete`)
            bindings[name] = value
          }
          modules.push(Object.freeze({ id, startedAt: importStartedAt, completedAt: Date.now(), elapsedMs: performance.now() - importStarted }))
        }
        signal.throwIfAborted()
        return Object.freeze({ bindings: Object.freeze(bindings), evidence: Object.freeze({
          schemaVersion: 'dashboard-runtime-preparation/v1', status: 'ready', ownerPid: process.pid,
          startedAt, readyAt: Date.now(), elapsedMs: performance.now() - started, modules: Object.freeze(modules),
          nativeImportCancellationClaimed: false, resetCauseEstablished: false }) })
      } catch (error) {
        try { error.dashboardRuntimePreparation = { schemaVersion: 'dashboard-runtime-preparation/v1', status: 'failed',
          ownerPid: process.pid, startedAt, failedAt: Date.now(), elapsedMs: performance.now() - started,
          stage, moduleId, modules, nativeImportCancellationClaimed: false, resetCauseEstablished: false } } catch { /* Preserve the exact original failure. */ }
        throw error
      }
    })()
    const prepared = await pending
    signal.throwIfAborted()
    return prepared
  }
}
const prepareRuntime = createRuntimePreparation((specifier) => import(specifier))
const preparedRuntimeTokens = new WeakSet()
export async function prepareDashboardRuntimeJourney(input) {
  const prepared = await prepareRuntime(input)
  preparedRuntimeTokens.add(prepared)
  return prepared
}
// Isolated pure tests exercise the same loader contract; their tokens cannot admit the real journey.
export function createDashboardRuntimePreparationForTest(importModule) {
  assert.equal(typeof importModule, 'function')
  return createRuntimePreparation(importModule)
}

// Semantic check of pin-verified IO facts. The caller authenticates the raw
// config/freeze/bundle/helper bytes; supplied metadata alone never admits a browser.
export function assertDashboardCftBuildBindings({ config, sourceHead, bundlePath, bundlePin, bundle, cdpManifest, freeze, helper }) {
  assert.match(sourceHead ?? '', /^[a-f0-9]{40}$/)
  assert.match(config.sourceHead ?? '', /^[a-f0-9]{40}$/); assert.equal(config.sourceHead, sourceHead)
  assert.match(config.buildSourceCommit ?? '', /^[a-f0-9]{40}$/)
  assert.match(config.bundleManifestPath ?? '', /^C:\/Users\/leand\/Documents\/Apollo\/w61-70-20261008\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/bundle-manifest\.json$/)
  assert.equal(config.bundleManifestPath, bundlePath)
  assert.match(bundlePin ?? '', /^[a-f0-9]{64}$/); assert.equal(config.bundleManifestSha256, bundlePin)
  assert.equal(bundle.schemaVersion, 1)
  assert.equal(bundle.root, 'C:/Users/leand/.codex/worktrees/w61-70-integration/apollo-video')
  assert.match(bundle.buildRunId ?? '', /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
  assert.equal(config.bundleManifestPath, `C:/Users/leand/Documents/Apollo/w61-70-20261008/${bundle.buildRunId}/bundle-manifest.json`)
  assert.equal(bundle.sourceCommit, config.buildSourceCommit)
  assert.equal(cdpManifest?.sourceCommit, config.buildSourceCommit)
  assert.deepEqual(bundle, cdpManifest, 'CfT and CDP must consume the same authenticated build manifest')
  assert.equal(freeze.schemaVersion, 'dashboard-cft157-freeze/v1'); assert.equal(freeze.sourceHead, config.sourceHead)
  assert.deepEqual(Object.keys(freeze).sort(), ['schemaVersion', 'sourceHead', 'files'].sort())
  assert.ok(Array.isArray(freeze.files) && freeze.files.length > 0 && freeze.files.length <= 32)
  assert.ok(freeze.files.every((row) => typeof row.path === 'string' && !/[\\\x00-\x1f\x7f]/.test(row.path) &&
    row.path.split('/').every((part) => part !== '.' && part !== '..') && Number.isSafeInteger(row.bytes) && row.bytes > 0 && /^[a-f0-9]{64}$/.test(row.sha256 ?? '')))
  assert.equal(new Set(freeze.files.map((row) => row.path.toLowerCase())).size, freeze.files.length)
  const rows = freeze.files.filter((row) => row.path === helper.path)
  assert.equal(rows.length, 1, 'External source freeze must contain this exact helper once')
  assert.equal(rows[0].sha256, helper.sha256); assert.equal(rows[0].bytes, helper.bytes)
}

/** Real proxy workers and negative final admission; seeded review GUI is explicit. */
export async function runDashboardRuntimeJourney(input) {
  assert.ok(preparedRuntimeTokens.has(input.runtimePreparation), 'Runtime dependencies must be prepared before owned server/network admission')
  input.signal.throwIfAborted()
  const { PrismaPublicOperationRepository, createProjectProxyRenderWorker, createColorPipelineCompilationRepository, PrismaProjectProxyRenderRepository,
    PrismaProjectFinalExportRepository, PrismaAssetRightsRepository, enqueueProjectFinalExportService,
    calculateVersionHash, stableSerialize, createProtectedPayloadCipherFromEnvironment, probeVideo, resolveFfmpegBinary,
    chromium, parseCreateColorPipelineCompilationBody, setProjectLutSelectionService, PrismaProjectLutSelectionRepository } = input.runtimePreparation.bindings
  const { client, baseUrl, authorization, workspaceId, projectId, projectVersionId,
    projectVersionHash, directed, actor, sourceArtifactId, sourceManifestId, sourceSha256,
    sourceByteSize, sourceManifest, sourcePath, sourceColorProbe, artifactRoot, uiUsername, uiPassword, suffix, signal, mechanicalSeed,
    ingestOperationId, observeOwnedServer, observeHttpConnections, selectHttpWorkspacePath } = input
  assert.equal(typeof observeOwnedServer, 'function', 'Owned test server lifecycle observer is required')
  const directory = process.env.APOLLO_DASHBOARD_RUNTIME_EVIDENCE_ROOT
  assert.ok(directory && isAbsolute(directory), 'Runtime evidence requires an absolute external directory')
  await mkdir(directory, { recursive: true })
  const evidence = { schemaVersion: 'dashboard-real-runtime/v2', runId: suffix, ownerPid: process.pid,
    runtimePreparation: input.runtimePreparation.evidence,
    sourceCommit: process.env.GITHUB_SHA ?? null, states: [], outputs: [], screenshots: [], httpResponses: [],
    browserErrors: [], browserResponses: [],
    proofScope: 'runtime-proxy-and-negative-final-admission', editorialAcceptance: false, faceSafety: 'unknown',
    storedQualityStatus: 'review-required',
    controlledInputs: ['FFmpeg synthetic source bytes', 'aligned transcript', 'initial compiled timeline',
      'source rights', 'source color probe', 'separate seeded blocked review project', 'test-only rejected final approval claim',
      'separate seeded editorial source project (ingest-compiled plan, no Director)', 'separate seeded isolated Director project for failure/recovery'],
    runtimeProduced: ['public project and proxy admission', 'Director service snapshots/Command/impact/decision log',
      'real main-project proxy worker review', 'public final rejection and PostgreSQL rejection of a controlled approval claim',
      'PostgreSQL states/events/artifacts', 'public retry and version fences',
      'public copy refusal (428 copy-requires-editorial-cut) and configuration Commands on copies',
      'public editorial cut of a copy, its queued proxy render, worker review and annotation'],
    pendingProofs: ['W35 positive final admission with authoritative approved DirectorRun and ready proxy review',
      'W35 real final worker, rendering-final/completed GUI, final MP4 and final replay'],
    governancePolicy: { anomalyRequestMinimum: 400, scope: 'owned E2E server only', productionDefaultChanged: false },
    unmeasuredProgress: { runtimeReachable: false, reason: 'All public operations use a known canonical phase count; historical no-total proof is controlled.' },
    deployed: false, ownerAccepted: false, postflight: {} }
  const httpDiagnosticsEnabled = process.env.APOLLO_DASHBOARD_HTTP_CONNECTION_DIAGNOSTICS === '1'
  if (httpDiagnosticsEnabled) {
    assert.equal(typeof observeHttpConnections, 'function'); assert.equal(typeof selectHttpWorkspacePath, 'function')
    evidence.proofScope = 'native-http-diagnostic-not-normal-journey-or-performance'
    evidence.httpConnections = observeHttpConnections()
  }
  const prototype = PrismaPublicOperationRepository.prototype
  const originals = { claimNext: prototype.claimNext, advancePhase: prototype.advancePhase }
  let server, browser, context, child, primaryError, pipeline, activeObserver, observationError
  const observeWorker = async (...args) => {
    try { await activeObserver(...args) } catch (error) { observationError = error; throw error }
  }
  const runObservedWorker = async (action) => {
    const result = await action()
    if (observationError) throw observationError
    return result
  }
  const environment = { ...process.env, APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
    APOLLO_V2_RENDER_LEASE_MS: '120000', APOLLO_V2_RENDER_HEARTBEAT_MS: '5000',
    APOLLO_V2_WORKER_RETRY_BASE_MS: '1', APOLLO_V2_WORKER_RETRY_MAX_MS: '1',
    APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'dashboard-runtime-e2e',
    APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64url') }
  const ffmpeg = resolveFfmpegBinary(undefined, environment)
  assert.equal(isAbsolute(ffmpeg), true, 'Resolved FFmpeg binary must be absolute')
  const safeError = (error) => {
    const message = String(error?.message ?? error ?? '')
    const errorKind = /No resource with given identifier|body.*evicted/i.test(message) ? 'BODY_RESOURCE_GONE'
      : /Target page, context or browser has been closed/i.test(message) ? 'TARGET_CLOSED'
        : /Response body is unavailable/i.test(message) ? 'BODY_UNAVAILABLE'
          : /Dashboard response evidence deadline exceeded/i.test(message) ? 'EVIDENCE_DEADLINE' : 'UNKNOWN'
    return { name: /^[A-Za-z0-9_]{1,80}$/.test(error?.name ?? '') ? error.name : null,
      errorKind, messageSha256: sha256(message), messageBytes: Buffer.byteLength(message) }
  }
  const bounded = async (action, timeoutMs) => {
    let timer
    try {
      return await Promise.race([action, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Dashboard response evidence deadline exceeded')), timeoutMs)
      })])
    } finally { clearTimeout(timer) }
  }
  const responseDiagnostic = (text) => {
    let payload
    try { payload = JSON.parse(text) } catch { /* Non-JSON remains identifiable by its byte hash. */ }
    const message = typeof payload?.error?.message === 'string' ? payload.error.message : ''
    return { bodySha256: sha256(text), bodyBytes: Buffer.byteLength(text),
      bodyKind: payload === undefined ? 'non-json' : 'json',
      apiErrorCode: /^[A-Z][A-Z0-9_]+$/.test(payload?.error?.code ?? '') ? payload.error.code : null,
      apiErrorMessageSha256: sha256(message), apiErrorMessageBytes: Buffer.byteLength(message) }
  }
  const readPublicWorkspace = async (id, stage) => {
    const path = `/v1/projects/${id}/workspace`
    if (httpDiagnosticsEnabled) selectHttpWorkspacePath(path)
    const started = performance.now()
    const diagnostic = { stage, method: 'GET', path, startedAt: Date.now(), startedMonotonicMs: started,
      phase: 'headers', status: null, serverBefore: observeOwnedServer() }
    evidence.httpResponses.push(diagnostic)
    if (httpDiagnosticsEnabled) diagnostic.httpConnectionsBefore = observeHttpConnections()
    try {
      const response = await fetch(`${baseUrl}${path}`, { headers: { authorization }, signal: AbortSignal.timeout(30000) })
      diagnostic.status = response.status; diagnostic.headersElapsedMs = performance.now() - started
      diagnostic.phase = 'body'
      const text = await response.text()
      diagnostic.bodyElapsedMs = performance.now() - started
      Object.assign(diagnostic, responseDiagnostic(text)); diagnostic.phase = 'validation'
      assert.equal(response.status, 200, `Public workspace hydration must succeed: ${JSON.stringify(diagnostic)}`)
      assert.equal(diagnostic.bodyKind, 'json', JSON.stringify(diagnostic))
      const payload = JSON.parse(text)
      assert.equal(payload.data.project.id, id)
      diagnostic.phase = 'completed'
      return payload.data
    } catch (error) {
      const networkError = (value) => {
        const message = String(value?.message ?? '')
        return { name: /^[A-Za-z0-9_]{1,80}$/.test(value?.name ?? '') ? value.name : null,
          code: /^[A-Z][A-Z0-9_]{0,79}$/.test(value?.code ?? '') ? value.code : null,
          errno: Number.isSafeInteger(value?.errno) ? value.errno : null,
          syscall: ['read', 'write', 'connect', 'getaddrinfo', 'recv', 'send'].includes(value?.syscall) ? value.syscall : null,
          messageSha256: sha256(message), messageBytes: Buffer.byteLength(message) }
      }
      diagnostic.failedPhase = diagnostic.phase; diagnostic.phase = 'failed'
      diagnostic.error = networkError(error)
      diagnostic.cause = error?.cause ? networkError(error.cause) : null
      throw error
    } finally {
      diagnostic.elapsedMs = performance.now() - started; diagnostic.finishedAt = Date.now()
      diagnostic.serverAfter = observeOwnedServer()
      if (httpDiagnosticsEnabled) diagnostic.httpConnectionsAfter = observeHttpConnections()
    }
  }
  const browserResponseTasks = new Set()
  const browserRequests = new WeakMap()
  // A transport failure belongs to this exact Playwright Request, even when
  // response.finished() never settles after a cancelled RSC transfer.
  const browserRequestFailures = new WeakMap()
  const headerDiagnostics = (headers, names) => Object.fromEntries(names.map((name) => {
    const value = headers[name]
    return [name, value === undefined ? { present: false } : { present: true,
      token: value === '0' || value === '1' ? value : null,
      sha256: sha256(value), bytes: Buffer.byteLength(value) }]
  }))
  const responseOrRequestFailure = (request, action) => bounded(Promise.race([
    action.then((value) => ({ via: 'response', value })),
    browserRequestFailures.get(request).promise,
  ]), 5000)
  const activeBrowserRequests = new Set()
  const browserPages = new WeakMap()
  const browserResponseListeners = []
  const browserOrigin = new URL(baseUrl).origin
  const cdpPaths = new Set(['/', '/batches', '/localization', '/library', '/presenters', '/capture-sessions', '/brand', '/workspace-settings', `/projects/${projectId}`])
  const cdpSessions = [], cdpScriptHashes = new Map()
  const cancelEnabled = process.env.APOLLO_DASHBOARD_CANCEL_DIAGNOSTICS === '1'
  assert.ok(process.env.APOLLO_DASHBOARD_CANCEL_DIAGNOSTICS === undefined || cancelEnabled,
    'Cancel diagnostics require an explicit opt-in value of 1')
  const cancelPages = []
  if (cancelEnabled) evidence.cancelDiagnostics = { proofScope: 'observed-javascript-api-calls-only',
    cancelCausalityEstablished: false, responseFetchIdentityEstablished: false,
    bounds: { eventsPerPage: 1024, stackFrames: 16, stackBytes: 4096 }, pages: [] }
  evidence.cdp = { proofScope: 'passive-transport-diagnostics', canceledDoesNotIdentifyAuthor: true,
    bounds: { requestsPerPage: 256, eventsPerPage: 2048, stackFrames: 8, joinWindowMs: 50 }, pages: [],
    scriptManifest: { state: 'not-provided', buildSourceCommit: null, testSourceCommit: process.env.GITHUB_SHA ?? null } }
  const loadCdpScriptManifest = () => {
    const path = process.env.APOLLO_DASHBOARD_RUNTIME_BUNDLE_MANIFEST
    const pin = process.env.APOLLO_DASHBOARD_RUNTIME_BUNDLE_MANIFEST_SHA256
    if (path === undefined && pin === undefined) return
    assert.ok(path && isAbsolute(path)); assert.match(pin ?? '', /^[a-f0-9]{64}$/)
    const deadline = performance.now() + 10000, limit = 1024 * 1024, bytes = Buffer.alloc(limit + 1)
    let fd, size = 0
    try {
      fd = openSync(path, 'r')
      const stat = fstatSync(fd)
      assert.ok(stat.isFile() && stat.size > 0 && stat.size <= limit, 'Frozen CDP manifest must be a bounded regular file')
      while (size <= limit) {
        assert.ok(performance.now() < deadline, 'Frozen CDP manifest read deadline')
        const count = readSync(fd, bytes, size, Math.min(65536, bytes.length - size), null)
        if (!count) break
        size += count
      }
      assert.ok(size > 0 && size <= limit)
    } finally { if (fd !== undefined) closeSync(fd) }
    const raw = bytes.subarray(0, size)
    assert.equal(sha256(raw), pin, 'Frozen CDP manifest external pin mismatch')
    const manifest = JSON.parse(raw.toString('utf8'))
    assert.equal(manifest.schemaVersion, 1); assert.match(manifest.sourceCommit ?? '', /^[a-f0-9]{40}$/)
    assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 4096)
    assert.equal(manifest.fileCount, manifest.files.length)
    const paths = new Set(); let totalBytes = 0
    for (const row of manifest.files) {
      assert.ok(performance.now() < deadline, 'Frozen CDP manifest validation deadline')
      assert.ok(typeof row.path === 'string' && row.path.startsWith('.next/') && !/[\\\0?#]/.test(row.path) &&
        row.path.split('/').every((part) => part && part !== '.' && part !== '..') && !paths.has(row.path))
      assert.match(row.sha256 ?? '', /^[a-f0-9]{64}$/); assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0)
      paths.add(row.path); totalBytes += row.bytes
      if (row.path.startsWith('.next/static/') && row.path.endsWith('.js')) {
        cdpScriptHashes.set('/_next/static/' + row.path.slice('.next/static/'.length), row.sha256)
      }
    }
    assert.equal(manifest.totalBytes, totalBytes)
    // Build provenance is distinct from this diagnostic test's source SHA.
    // No script URL is converted to a filesystem path or opened.
    evidence.cdp.scriptManifest = { state: 'externally-pinned', sha256: pin, buildSourceCommit: manifest.sourceCommit,
      testSourceCommit: process.env.GITHUB_SHA ?? null, fileCount: manifest.fileCount, scriptCount: cdpScriptHashes.size }
    return manifest
  }
  const attachCdp = async (opened, deadline = performance.now() + 10000) => {
    const state = browserPages.get(opened), started = performance.now()
    const send = async (session, method, params) => {
      const remaining = deadline - performance.now()
      assert.ok(remaining > 0, 'Passive CDP setup deadline')
      return bounded(session.send(method, params), remaining)
    }
    const session = await bounded(context.newCDPSession(opened), deadline - performance.now())
    const page = { pageId: state.pageId, requests: [], events: [], setupStartedAt: Date.now(), closedObserved: false }
    const owned = { session, page, handlers: new Map(), requests: new Map(), failed: false }
    cdpSessions.push(owned); evidence.cdp.pages.push(page)
    const fail = (error) => {
      if (!owned.failed) {
        owned.failed = true; page.failure = safeError(error)
        evidence.browserErrors.push({ kind: 'cdp-diagnostic-failed', pageId: page.pageId, ...page.failure })
      }
    }
    const pathOf = (value) => {
      const url = new URL(value)
      return url.origin === browserOrigin && cdpPaths.has(url.pathname) ? url.pathname : null
    }
    const event = (kind, details) => {
      assert.ok(page.events.length < 2048, 'Passive CDP event bound exceeded')
      assert.ok(Object.values(details).every((value) => typeof value !== 'string' || value.length <= 1024), 'Passive CDP metadata bound exceeded')
      page.events.push({ seq: page.events.length + 1, kind, at: Date.now(), observedMonotonicMs: performance.now(),
        stage: state.stage, layout: state.layout, navigationId: state.navigationId, ...details })
    }
    const listen = (name, action) => {
      const handler = (payload) => { if (!owned.failed) { try { action(payload) } catch (error) { fail(error) } } }
      owned.handlers.set(name, handler); session.on(name, handler)
    }
    const stackFrames = (stack) => {
      const frames = []
      for (let depth = 0; stack && depth < 3 && frames.length < 8; depth += 1, stack = stack.parent) {
        for (const frame of stack.callFrames ?? []) {
          if (frames.length === 8) break
          let scriptPath = null
          try {
            const url = new URL(frame.url)
            if (url.origin === browserOrigin && url.pathname.length <= 1024) scriptPath = url.pathname
          } catch { /* No raw URL is retained. */ }
          frames.push({ functionName: /^[A-Za-z_$][A-Za-z0-9_$ .<>-]{0,100}$/.test(frame.functionName ?? '') ? frame.functionName : null,
            scriptPath, lineNumber: Number.isSafeInteger(frame.lineNumber) && frame.lineNumber >= 0 ? frame.lineNumber : null,
            columnNumber: Number.isSafeInteger(frame.columnNumber) && frame.columnNumber >= 0 ? frame.columnNumber : null,
            scriptSha256: scriptPath ? cdpScriptHashes.get(scriptPath) ?? null : null,
            sourceBinding: scriptPath && cdpScriptHashes.has(scriptPath) ? 'exact-frozen-manifest-path' : 'unmapped' })
        }
      }
      return frames
    }
    listen('Network.requestWillBeSent', (payload) => {
      const path = pathOf(payload.request.url)
      if (!path) return
      assert.ok(page.requests.length < 256, 'Passive CDP request bound exceeded')
      assert.ok(typeof payload.requestId === 'string' && payload.requestId.length <= 128)
      assert.ok(typeof payload.loaderId === 'string' && payload.loaderId.length <= 128 &&
        (payload.frameId === undefined || (typeof payload.frameId === 'string' && payload.frameId.length <= 128)))
      assert.ok(['GET', 'POST', 'HEAD', 'OPTIONS'].includes(payload.request.method))
      assert.ok(['script', 'parser', 'preload', 'preflight', 'SignedExchange', 'FedCM', 'other'].includes(payload.initiator.type))
      assert.ok(Number.isFinite(payload.timestamp) && Number.isFinite(payload.wallTime))
      const record = { cdpRequestId: payload.requestId, loaderId: payload.loaderId, frameId: payload.frameId ?? null,
        path, method: payload.request.method, timestamp: payload.timestamp, wallTimeMs: payload.wallTime * 1000,
        initiatorType: payload.initiator.type, callerFrames: stackFrames(payload.initiator.stack),
        state: 'pending', encodedDataBytes: 0, decodedDataBytes: 0 }
      // Redirect hops share the browser's real CDP request ID. Keep every hop;
      // correlation cannot silently select among them.
      page.requests.push(record); owned.requests.set(payload.requestId, record)
      event('request', { cdpRequestId: payload.requestId, loaderId: record.loaderId, frameId: record.frameId, path })
    })
    listen('Network.responseReceived', (payload) => {
      const record = owned.requests.get(payload.requestId); if (!record) return
      assert.ok(Number.isSafeInteger(payload.response.status) && payload.response.status >= 100 && payload.response.status <= 599)
      assert.ok(typeof payload.response.mimeType === 'string' && payload.response.mimeType.length <= 128)
      record.status = payload.response.status; record.mimeType = payload.response.mimeType
      event('response', { cdpRequestId: payload.requestId, timestamp: payload.timestamp, status: record.status })
    })
    listen('Network.dataReceived', (payload) => {
      const record = owned.requests.get(payload.requestId); if (!record) return
      assert.ok(Number.isSafeInteger(payload.dataLength) && payload.dataLength >= 0 &&
        Number.isSafeInteger(payload.encodedDataLength) && payload.encodedDataLength >= 0)
      record.decodedDataBytes += payload.dataLength; record.encodedDataBytes += payload.encodedDataLength
      assert.ok(Number.isSafeInteger(record.decodedDataBytes) && Number.isSafeInteger(record.encodedDataBytes))
      event('data', { cdpRequestId: payload.requestId, timestamp: payload.timestamp,
        decodedBytes: payload.dataLength, encodedBytes: payload.encodedDataLength })
    })
    listen('Network.loadingFinished', (payload) => {
      const record = owned.requests.get(payload.requestId); if (!record) return
      assert.ok(Number.isFinite(payload.timestamp) && Number.isFinite(payload.encodedDataLength) && payload.encodedDataLength >= 0)
      record.state = 'finished'; record.finishedTimestamp = payload.timestamp; record.totalEncodedBytes = payload.encodedDataLength
      event('finished', { cdpRequestId: payload.requestId, timestamp: payload.timestamp, totalEncodedBytes: payload.encodedDataLength })
    })
    listen('Network.loadingFailed', (payload) => {
      const record = owned.requests.get(payload.requestId); if (!record) return
      assert.ok(Number.isFinite(payload.timestamp) && (payload.canceled === undefined || typeof payload.canceled === 'boolean'))
      const message = String(payload.errorText ?? '')
      record.state = 'failed'; record.failedTimestamp = payload.timestamp
      record.failure = { canceled: payload.canceled ?? null,
        errorCode: /^net::ERR_[A-Z0-9_]{1,80}$/.test(message) ? message : 'UNKNOWN',
        messageSha256: sha256(message), messageBytes: Buffer.byteLength(message),
        blockedReason: /^[a-z-]{1,80}$/.test(payload.blockedReason ?? '') ? payload.blockedReason : null }
      event('failed', { cdpRequestId: payload.requestId, timestamp: payload.timestamp, ...record.failure })
    })
    listen('Page.frameNavigated', ({ frame }) => {
      if (frame.parentId) return
      const path = pathOf(frame.url); if (path) event('document-navigation', { frameId: frame.id, loaderId: frame.loaderId, path })
    })
    listen('Page.navigatedWithinDocument', (payload) => {
      const path = pathOf(payload.url); if (path) event('same-document-navigation', { frameId: payload.frameId, path,
        navigationType: ['fragment', 'historyApi', 'other'].includes(payload.navigationType) ? payload.navigationType : null })
    })
    listen('Page.lifecycleEvent', (payload) => {
      if (['init', 'DOMContentLoaded', 'load'].includes(payload.name)) event('document-lifecycle', {
        frameId: payload.frameId, loaderId: payload.loaderId, name: payload.name, timestamp: payload.timestamp })
    })
    const closed = () => { page.closedObserved = true; page.closedAt = Date.now() }
    owned.handlers.set('close', closed); session.once('close', closed)
    await send(session, 'Page.enable'); await send(session, 'Page.setLifecycleEventsEnabled', { enabled: true })
    await send(session, 'Network.enable')
    page.setupCompletedAt = Date.now(); page.setupElapsedMs = performance.now() - started
  }
  const attachCancelDiagnostics = async (opened, deadline) => {
    if (!cancelEnabled) return
    const state = browserPages.get(opened)
    const page = { pageId: state.pageId, events: [], documents: [], collections: [], failures: [] }
    const owned = { opened, state, page, seen: new Set(), restored: false }
    cancelPages.push(owned); evidence.cancelDiagnostics.pages.push(page)
    const remaining = deadline - performance.now()
    assert.ok(remaining > 0, 'Cancel diagnostic setup deadline exhausted')
    await bounded(opened.addInitScript(installDashboardCancelDiagnostics, { origin: browserOrigin,
      pageId: state.pageId, paths: [...cdpPaths], scripts: [...cdpScriptHashes] }), remaining)
  }
  const collectCancelDiagnostics = async (opened, deadline, restore = false) => {
    if (!cancelEnabled) return
    let firstError
    for (const owned of cancelPages) {
      if ((opened && opened !== owned.opened) || owned.restored) continue
      // The pipeline page navigates during its own bootstrap, outside the main
      // harness navigation counter. Only the actual initial blank document skips.
      if (owned.opened.url() === 'about:blank') continue
      try {
        const remaining = deadline - performance.now()
        assert.ok(remaining > 0, 'Cancel diagnostic collection deadline exhausted')
        const snapshot = await bounded(owned.opened.evaluate(({ paths, restore }) => {
          const control = globalThis.__apolloDashboardCancelDiagnostics
          if (!control) throw new Error('Cancel diagnostic control missing')
          return restore ? control.restore() : control.drain(paths)
        }, { paths: [...cdpPaths], restore }), remaining)
        validateDashboardCancelSnapshot(snapshot, owned.state.pageId, cdpPaths, cdpScriptHashes)
        assert.ok(owned.page.events.length + snapshot.events.length <= 1024, 'Cancel diagnostic page event bound')
        for (const event of snapshot.events) {
          const key = `${event.documentTimeOrigin}:${event.seq}`
          assert.ok(!owned.seen.has(key), 'Cancel diagnostic event must be collected once')
          owned.seen.add(key); owned.page.events.push(event)
        }
        const facts = { documentTimeOrigin: snapshot.documentTimeOrigin, restored: snapshot.restored,
          installedDescriptors: snapshot.installedDescriptors, restoredDescriptors: snapshot.restoredDescriptors,
          unmapped: snapshot.unmapped, unmappedStackFrames: snapshot.unmappedStackFrames,
          overflow: snapshot.overflow, errors: snapshot.errors, limitations: snapshot.limitations }
        const previous = owned.page.documents.find((value) => value.documentTimeOrigin === snapshot.documentTimeOrigin)
        if (previous) Object.assign(previous, facts)
        else { assert.ok(owned.page.documents.length < 32, 'Cancel diagnostic document bound'); owned.page.documents.push(facts) }
        assert.ok(owned.page.collections.length < 1024, 'Cancel diagnostic collection bound')
        owned.page.collections.push({ at: Date.now(), documentTimeOrigin: snapshot.documentTimeOrigin,
          stageAtCollection: owned.state.stage, layoutAtCollection: owned.state.layout,
          navigationIdAtCollection: owned.state.navigationId, eventCount: snapshot.events.length, restore })
        if (restore && snapshot.restored && snapshot.restoredDescriptors === snapshot.installedDescriptors) owned.restored = true
        assert.equal(snapshot.overflow, false, 'Cancel diagnostic overflow is a failure')
        assert.deepEqual(snapshot.errors, [], 'Cancel diagnostic errors are a failure')
        assert.equal(snapshot.installedDescriptors, 9, 'Every diagnostic descriptor must be installed')
        if (restore) {
          assert.equal(snapshot.restored, true); assert.equal(snapshot.restoredDescriptors, snapshot.installedDescriptors)
        }
      } catch (error) {
        const failure = { kind: 'cancel-diagnostic-failed', pageId: owned.state.pageId,
          restore, at: Date.now(), ...safeError(error) }
        if (owned.page.failures.length < 16) owned.page.failures.push(failure)
        evidence.browserErrors.push(failure); firstError ??= error
      }
    }
    if (firstError) throw firstError
  }
  const correlateCancelDiagnostics = () => {
    if (!cancelEnabled) return
    evidence.cancelDiagnostics.scriptManifest = evidence.cdp.scriptManifest
    const networks = cdpSessions.flatMap(({ page }) => page.requests.map((network) => {
      const response = page.events.find((event) => event.kind === 'response' && event.cdpRequestId === network.cdpRequestId &&
        event.timestamp >= network.timestamp)
      return { ...network, pageId: page.pageId, responseWallTimeMs: response
        ? network.wallTimeMs + (response.timestamp - network.timestamp) * 1000 : null }
    }))
    for (const { page } of cancelPages) page.events = joinDashboardCancelEvents(page.events, networks)
  }
  const correlateCdp = () => {
    for (const { page } of cdpSessions) {
      const browserRecords = evidence.browserRequests.filter((record) => record.pageId === page.pageId && record.origin === browserOrigin)
      const candidates = new Map(), reciprocalCounts = new Map()
      for (const network of page.requests) {
        const found = browserRecords.filter((record) => record.path === network.path && record.method === network.method &&
          Number.isFinite(record.networkStartTimeMs) && Math.abs(record.networkStartTimeMs - network.wallTimeMs) <= 50)
        candidates.set(network, found)
        for (const record of found) reciprocalCounts.set(record.requestId, (reciprocalCounts.get(record.requestId) ?? 0) + 1)
      }
      for (const network of page.requests) {
        const found = candidates.get(network)
        const unique = found.length === 1 && reciprocalCounts.get(found[0].requestId) === 1
        network.join = { policy: 'same-page-path-method-public-timing-candidates/v1', windowMs: 50,
          state: unique ? 'unique-candidate' : found.length ? 'ambiguous' : 'unmatched',
          requestId: unique ? found[0].requestId : null,
          candidateRequestIds: found.slice(0, 8).map((record) => record.requestId), candidateCount: found.length }
      }
    }
  }
  let browserSequence = 0, browserRequestSequence = 0, browserPageSequence = 0, browserActivityAt = performance.now()
  evidence.browserRequests = []; evidence.browserTimeline = []; evidence.browserBarriers = []
  const browserEvent = (event, pageState, record, extra = {}) => {
    browserActivityAt = performance.now()
    const item = { seq: ++browserSequence, at: Date.now(), monotonicMs: browserActivityAt, event,
      pageId: pageState.pageId, navigationId: record?.navigationId ?? pageState.navigationId,
      stage: record?.stage ?? pageState.stage, layout: record?.layout ?? pageState.layout,
      ...(record ? { requestId: record.requestId } : {}), ...extra }
    evidence.browserTimeline.push(item)
    return item.seq
  }
  const markBrowserPage = (opened, stage, layout) => {
    const state = browserPages.get(opened)
    assert.ok(state, 'Browser page must be tracked before an observation')
    state.stage = stage; state.layout = layout
    return state
  }
  const beginBrowserNavigation = (opened, stage, layout, targetPath) => {
    cdpPaths.add(targetPath)
    const state = markBrowserPage(opened, stage, layout)
    state.navigationId = `${state.pageId}:navigation-${++state.navigationCount}`
    browserEvent('navigation-intent', state, null, { targetPath })
    return state.navigationId
  }
  const drainBrowserResponses = async ({ opened, navigationId, requiredPaths = [], label = 'finite-browser-barrier', deadline: existingDeadline } = {}) => {
    const started = performance.now(), deadline = existingDeadline ?? started + 10000
    const barrier = { label, pageId: opened ? browserPages.get(opened).pageId : null, navigationId: navigationId ?? null,
      startedAt: Date.now(), budgetMs: 10000, requiredPaths: [], status: 'pending' }
    evidence.browserBarriers.push(barrier)
    try {
      while (performance.now() < deadline) {
        const records = evidence.browserRequests.filter((record) => !opened ||
          (record.pageId === barrier.pageId && record.navigationId === navigationId))
        barrier.requiredPaths = typeof requiredPaths === 'function' ? requiredPaths(records) : requiredPaths
        const missing = barrier.requiredPaths.filter((path) => !records.some((record) => record.method === 'GET' &&
          record.origin === browserOrigin && record.path === path && record.transportState === 'finished' && record.bodyState === 'captured'))
        barrier.pendingRequestIds = [...activeBrowserRequests].map((request) => browserRequests.get(request).requestId)
        barrier.pendingBodies = browserResponseTasks.size; barrier.missingPaths = missing
        if (!barrier.pendingRequestIds.length && !barrier.pendingBodies && !missing.length &&
          performance.now() - browserActivityAt >= 350) {
          if (cancelEnabled) await collectCancelDiagnostics(opened, deadline)
          barrier.status = 'completed'; barrier.completedAt = Date.now(); barrier.completedAtSeq = browserSequence
          return
        }
        const remaining = deadline - performance.now()
        assert.ok(remaining > 0, 'Browser request lifecycle barrier deadline exhausted')
        await delay(Math.min(25, remaining))
      }
      assert.fail(`Browser finite requests/bootstrap did not settle: ${JSON.stringify(barrier)}`)
    } catch (error) {
      barrier.status = 'failed'; barrier.error = safeError(error)
      // Capture while the old document still exists; a failed barrier remains
      // the primary error even if the remaining diagnostic budget is exhausted.
      if (cancelEnabled) {
        try { await collectCancelDiagnostics(opened, deadline) } catch { /* Already recorded; preserve the barrier failure. */ }
      }
      throw error
    }
  }
  // The document that a FULL navigation is about to replace stops polling first, the way it does when a user leaves the tab: the event feed
  // poller (useProjectEventFeed) only polls while its document is visible. A poll still in flight when the new document commits is
  // cancelled by the browser together with the old document, and Chromium does not always tell the page object about it, which leaves that
  // request pending for good and fails every later barrier (a ghost that no barrier may excuse: ERR_ABORTED stays a failure). Nothing is
  // excused here. The barrier is drained before this, it still fails on anything pending, and the old document merely cannot START a
  // request in the 100 ms between that drain and the commit. A document restored from the back/forward cache is visible again.
  const leaveDocument = async (opened) => {
    if (opened.url() === 'about:blank') return
    await opened.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
      window.addEventListener('pageshow', (event) => {
        if (!event.persisted) return
        delete document.visibilityState; delete document.hidden
        document.dispatchEvent(new Event('visibilitychange'))
      }, { once: true })
    })
  }
  const drainWorkspaceBootstrap = async (opened, navigationId, id) => {
    const prefix = `/v1/projects/${id}`
    const requiredPaths = ['/workspace', '/policy-overrides', '/proof-needs', '/proof-integrity-runs', '/proof-mode-runs']
      .map((path) => prefix + path)
    // These three proof reads mount unconditionally. SyntheticPhaseGatePanel
    // only mounts after the real workspace hydration supplies a version.
    await drainBrowserResponses({ opened, navigationId, label: 'workspace-bootstrap', requiredPaths: (records) => {
      const workspace = records.find((record) => record.path === prefix + '/workspace' && record.bodyState === 'captured')
      return workspace?.workspaceVersionPresent ? [...requiredPaths, prefix + '/synthetic-phase-gates', '/v1/capabilities'] : requiredPaths
    } })
  }
  // The whole envelope: `data` on success, `error` on a refusal the caller expects (post keeps returning only `data`).
  const postEnvelope = async (path, body, key, expected) => {
    const response = await fetch(`${baseUrl}${path}`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) })
    const text = await response.text()
    // A missing public route returns Next HTML. Preserve enough evidence to
    // identify it without recording response bodies, credentials or cookies.
    const contentType = (response.headers.get('content-type') ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 128)
    const diagnostic = { method: 'POST', path: new URL(path, baseUrl).pathname,
      responsePath: response.url ? new URL(response.url).pathname : null, status: response.status,
      contentType, redirected: response.redirected, bodyBytes: Buffer.byteLength(text), bodyHash: sha256(text),
      bodyKind: /^\s*<(?:!doctype\s+html|html\b)/i.test(text) ? 'html' : 'other' }
    evidence.httpResponses.push(diagnostic)
    assert.match(contentType, /^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i,
      `Public API returned a non-JSON response: ${JSON.stringify(diagnostic)}`)
    let payload
    try { payload = JSON.parse(text) } catch {
      diagnostic.jsonParseFailed = true
      throw new Error(`Public API returned invalid JSON: ${JSON.stringify(diagnostic)}`)
    }
    diagnostic.bodyKind = 'json'
    assert.equal(response.status, expected, JSON.stringify({ ...diagnostic, expected,
      apiErrorCode: /^[A-Z][A-Z0-9_]+$/.test(payload?.error?.code ?? '') ? payload.error.code : null }))
    return payload
  }
  const post = async (...args) => (await postEnvelope(...args)).data
  const annotationScreenshot = async (artifact, name) => {
    const path = join(artifactRoot, ...artifact.artifactKey.split('/'))
    const framePath = join(directory, `${name}.png`)
    await exec(ffmpeg, ['-v', 'error', '-y', '-i', path, '-frames:v', '1', framePath], { windowsHide: true, timeout: 30000 })
    const bytes = await readFile(framePath)
    evidence.screenshots.push({ name: `${name}.png`, origin: 'real-proxy-ffmpeg-frame-0', artifactId: artifact.id, sha256: sha256(bytes) })
    return `data:image/png;base64,${bytes.toString('base64')}`
  }
  try {
    const workspacePayload = await readPublicWorkspace(projectId, 'main-upstream-before-browser')
    evidence.workspacePreflight = { status: 200, projectId,
      currentVersionId: workspacePayload.project.currentVersionId }
    const login = await fetch(`${baseUrl}/v1/session`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: uiUsername, password: uiPassword }), signal: AbortSignal.timeout(30000) })
    assert.equal(login.status, 200, await login.text())
    const cookie = /apollo_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]
    assert.ok(cookie)
    const cdpManifest = loadCdpScriptManifest()
    const cftNames = ['APOLLO_DASHBOARD_CFT157_CONFIG_PATH', 'APOLLO_DASHBOARD_CFT157_CONFIG_SHA256',
      'APOLLO_DASHBOARD_CFT157_MANIFEST_PATH', 'APOLLO_DASHBOARD_CFT157_MANIFEST_SHA256',
      'APOLLO_DASHBOARD_CFT157_INVENTORY_PATH', 'APOLLO_DASHBOARD_CFT157_INVENTORY_SHA256',
      'APOLLO_DASHBOARD_CFT157_EXECUTABLE_SHA256']
    const cftEnabled = cftNames.some((name) => process.env[name] !== undefined)
    const linuxCftEnabled = process.env.APOLLO_DASHBOARD_CFT157_LINUX_ROOT !== undefined
    assert.ok(!(cftEnabled && linuxCftEnabled), 'CfT platform authorities cannot be mixed')
    let cftConfig
    if (linuxCftEnabled) {
      assert.equal(cancelEnabled, false, 'CfT journey must preserve the native consumer')
      assert.equal(process.env.APOLLO_DASHBOARD_HTTP_CONNECTION_DIAGNOSTICS, undefined)
      cftConfig = await admitDashboardLinuxCft(); evidence.cft157 = cftConfig.evidence
    }
    if (cftEnabled) {
      assert.ok(cftNames.every((name) => typeof process.env[name] === 'string' && process.env[name].length > 0))
      assert.equal(cancelEnabled, false, 'CfT journey must preserve the native consumer without cancel instrumentation')
      const deadline = performance.now() + 10000
      const saldo = () => { const value = Math.floor(deadline - performance.now()); assert.ok(value > 0, 'CfT file preflight deadline exhausted'); return value }
      const pinned = async (path, pin, maximum, collect = false) => {
        assert.match(pin, /^[a-f0-9]{64}$/); saldo()
        const before = await lstat(path); saldo()
        assert.equal(before.isFile(), true); assert.equal(before.isSymbolicLink(), false)
        assert.ok(before.size > 0 && before.size <= maximum)
        assert.equal((await realpath(path)).replaceAll('\\', '/'), path); saldo()
        const stream = createReadStream(path, { signal: AbortSignal.timeout(saldo()), highWaterMark: 65536 })
        const closed = new Promise((resolve) => stream.once('close', resolve)), chunks = [], hash = createHash('sha256')
        let bytes = 0, primary
        try {
          for await (const chunk of stream) { saldo(); bytes += chunk.length; assert.ok(bytes <= before.size); hash.update(chunk); if (collect) chunks.push(chunk) }
        } catch (error) { primary = error }
        finally {
          stream.destroy()
          try { await closed; saldo() } catch (error) { primary ??= error }
        }
        if (primary) throw primary
        const after = await lstat(path); saldo()
        assert.deepEqual([after.dev, after.ino, after.size, after.mtimeMs], [before.dev, before.ino, before.size, before.mtimeMs])
        assert.equal(bytes, before.size); assert.equal(hash.digest('hex'), pin)
        return collect ? Buffer.concat(chunks) : { path, bytes, sha256: pin }
      }
      const configPath = process.env.APOLLO_DASHBOARD_CFT157_CONFIG_PATH
      assert.equal(configPath, directory.replaceAll('\\', '/') + '/dashboard-cft157-config.json')
      cftConfig = JSON.parse(await pinned(configPath, process.env.APOLLO_DASHBOARD_CFT157_CONFIG_SHA256, 1048576, true))
      assert.deepEqual(Object.keys(cftConfig).sort(), ['schemaVersion', 'runId', 'evidenceRoot', 'sourceHead', 'buildSourceCommit',
        'freezePath', 'freezeSha256', 'acquisitionResultPath', 'acquisitionResultSha256', 'manifestPath', 'manifestSha256',
        'inventoryPath', 'inventorySha256', 'browserExecutable', 'browserExecutableBytes', 'browserExecutableSha256',
        'bundleManifestPath', 'bundleManifestSha256', 'expectedProductVersion', 'expectedRevision'].sort())
      assert.equal(cftConfig.schemaVersion, 'dashboard-cft157-browser/v1')
      assert.match(cftConfig.runId, /^dashboard-cft157-v1-[a-f0-9]{8}$/)
      assert.equal(cftConfig.evidenceRoot, directory.replaceAll('\\', '/'))
      assert.match(cftConfig.sourceHead, /^[a-f0-9]{40}$/); assert.equal(cftConfig.sourceHead, process.env.GITHUB_SHA)
      assert.match(cftConfig.freezePath, /^C:\/Users\/leand\/Documents\/Apollo\/w61-70-20261008\/dashboard-cft157-freeze-[A-Za-z0-9-]+\.json$/)
      assert.match(cftConfig.freezeSha256, /^[a-f0-9]{64}$/)
      assert.match(cftConfig.buildSourceCommit, /^[a-f0-9]{40}$/)
      const root = 'C:/Users/leand/Documents/Apollo/w61-70-20261008/cft157-acquisition-v1-5b77fe0f/cft'
      assert.equal(cftConfig.acquisitionResultPath, root.slice(0, -4) + '/result.json')
      assert.equal(cftConfig.acquisitionResultSha256, 'c18eeab24b3237913e5e1da9430daf8b3773477b0214a0be2d64bec07c1e1910')
      assert.equal(cftConfig.browserExecutable, root + '/chrome-win64/chrome.exe')
      assert.equal(cftConfig.browserExecutableBytes, 4434432)
      assert.equal(cftConfig.browserExecutableSha256, '5c6d8b95a1d37eaaa206213fed158d31c08a17ac19ee29cf5f9e9f518571c9f1')
      assert.equal(process.env.PLAYWRIGHT_CHROME_EXECUTABLE, cftConfig.browserExecutable)
      assert.equal(process.env.APOLLO_DASHBOARD_CFT157_EXECUTABLE_SHA256, cftConfig.browserExecutableSha256)
      assert.equal(cftConfig.manifestPath, root + '/manifest.json')
      assert.equal(cftConfig.manifestSha256, 'c09ff542594e774ac36efc6c0c7edb3c49733c2a718ef2285bea5580d6fa6303')
      assert.equal(cftConfig.inventoryPath, root + '/inventory.json')
      assert.equal(cftConfig.inventorySha256, '5095ce835e5925c581dc94877a8bcd2b0d366bc9462899d59b29cc35abb83698')
      assert.equal(process.env.APOLLO_DASHBOARD_CFT157_MANIFEST_PATH, cftConfig.manifestPath)
      assert.equal(process.env.APOLLO_DASHBOARD_CFT157_MANIFEST_SHA256, cftConfig.manifestSha256)
      assert.equal(process.env.APOLLO_DASHBOARD_CFT157_INVENTORY_PATH, cftConfig.inventoryPath)
      assert.equal(process.env.APOLLO_DASHBOARD_CFT157_INVENTORY_SHA256, cftConfig.inventorySha256)
      assert.equal(cftConfig.bundleManifestPath, process.env.APOLLO_DASHBOARD_RUNTIME_BUNDLE_MANIFEST)
      assert.equal(cftConfig.bundleManifestSha256, process.env.APOLLO_DASHBOARD_RUNTIME_BUNDLE_MANIFEST_SHA256)
      assert.match(cftConfig.bundleManifestPath, /^C:\/Users\/leand\/Documents\/Apollo\/w61-70-20261008\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/bundle-manifest\.json$/)
      const bundle = JSON.parse(await pinned(cftConfig.bundleManifestPath, cftConfig.bundleManifestSha256, 1048576, true))
      const freeze = JSON.parse(await pinned(cftConfig.freezePath, cftConfig.freezeSha256, 1048576, true))
      const helperPath = fileURLToPath(import.meta.url).replaceAll('\\', '/')
      assert.ok(Array.isArray(freeze.files) && freeze.files.length > 0 && freeze.files.length <= 32)
      const helperRows = freeze.files.filter((row) => row.path === helperPath)
      assert.equal(helperRows.length, 1, 'External source freeze must contain this exact helper once')
      const helper = await pinned(helperPath, helperRows[0].sha256, 1048576)
      assertDashboardCftBuildBindings({ config: cftConfig, sourceHead: process.env.GITHUB_SHA,
        bundlePath: process.env.APOLLO_DASHBOARD_RUNTIME_BUNDLE_MANIFEST,
        bundlePin: process.env.APOLLO_DASHBOARD_RUNTIME_BUNDLE_MANIFEST_SHA256,
        bundle, cdpManifest, freeze, helper }); saldo()
      assert.equal(cftConfig.expectedProductVersion, '157.0.8090.0')
      assert.equal(cftConfig.expectedRevision, '@2ea1b71af70d7fc5d41325dda8df37c1f98ac531')
      const manifest = JSON.parse(await pinned(cftConfig.manifestPath, cftConfig.manifestSha256, 1048576, true))
      assert.equal(manifest.outcome, 'files-verified-awaiting-owner'); assert.equal(manifest.version, cftConfig.expectedProductVersion)
      const inventory = JSON.parse(await pinned(cftConfig.inventoryPath, cftConfig.inventorySha256, 1048576, true))
      assert.equal(inventory.schemaVersion, 'cft157-inventory/v1'); assert.equal(inventory.files.length, 310)
      const executable = await pinned(cftConfig.browserExecutable, cftConfig.browserExecutableSha256, 4434432)
      const row = inventory.files.find((entry) => entry.path === 'chrome-win64/chrome.exe')
      assert.equal(row.bytes, executable.bytes); assert.equal(row.sha256, executable.sha256)
      evidence.cft157 = { proofScope: 'normal-dashboard-journey-with-pinned-browser', causalityEstablished: false,
        priorRscFailuresPreserved: true, configurationSha256: process.env.APOLLO_DASHBOARD_CFT157_CONFIG_SHA256,
        sourceHead: cftConfig.sourceHead, buildSourceCommit: cftConfig.buildSourceCommit,
        freezePath: cftConfig.freezePath, freezeSha256: cftConfig.freezeSha256, executable,
        helperSource: helper, bundleManifestSha256: cftConfig.bundleManifestSha256,
        manifestSha256: cftConfig.manifestSha256, inventorySha256: cftConfig.inventorySha256,
        browserVersionObserved: false, versionSessionDetached: false }
    }
    const executablePath = cftEnabled || linuxCftEnabled ? cftConfig.browserExecutable :
      [process.env.PLAYWRIGHT_CHROME_EXECUTABLE, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((path) => path && existsSync(path))
    assert.ok(executablePath)
    server = await chromium.launchServer({ executablePath, headless: true, timeout: 20000 })
    child = server.process(); observeOwnedBrowserLifecycle(server, child); evidence.browserPid = child.pid
    browser = await chromium.connect(server.wsEndpoint(), { timeout: 20000 })
    if (cftEnabled || linuxCftEnabled) {
      const deadline = performance.now() + 5000
      const saldo = () => { const value = Math.floor(deadline - performance.now()); assert.ok(value > 0, 'CfT Browser.getVersion deadline exhausted'); return value }
      let versionSession, versionError
      try {
        const createRemaining = saldo()
        versionSession = await bounded(browser.newBrowserCDPSession(), createRemaining)
        const sendRemaining = saldo()
        const version = await bounded(versionSession.send('Browser.getVersion'), sendRemaining)
        assert.deepEqual(Object.keys(version).sort(), ['protocolVersion', 'product', 'revision', 'userAgent', 'jsVersion'].sort())
        assert.ok(Object.values(version).every((value) => typeof value === 'string' && value.length <= 1024))
        evidence.cft157.browserGetVersion = version; evidence.cft157.browserVersionObserved = true
        assert.match(version.product, /^(Chrome|HeadlessChrome)\/157\.0\.8090\.0$/)
        assert.equal(version.revision, cftConfig.expectedRevision)
      } catch (error) { versionError = error; evidence.cft157.versionError = safeError(error) }
      finally {
        if (versionSession) {
          try { const detachRemaining = saldo(); await bounded(versionSession.detach(), detachRemaining); evidence.cft157.versionSessionDetached = true }
          catch (error) { evidence.cft157.versionSessionCleanupError = safeError(error); versionError ??= error }
        }
      }
      if (versionError) throw versionError
      assert.equal(evidence.cft157.versionSessionDetached, true)
    }
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    context.on('page', (opened) => {
      const state = { pageId: `page-${++browserPageSequence}`, navigationId: null, navigationCount: 0,
        stage: 'page-created', layout: 'unassigned' }
      browserPages.set(opened, state)
      opened.on('pageerror', (error) => evidence.browserErrors.push({ kind: 'pageerror', ...safeError(error) }))
      opened.on('console', (message) => {
        if (message.type() === 'error') evidence.browserErrors.push({ kind: 'console-error', ...safeError(message.text()) })
      })
      const onRequest = (request) => {
        const url = new URL(request.url())
        if (request.isNavigationRequest() && state.navigationId === null) {
          state.navigationId = `${state.pageId}:navigation-${++state.navigationCount}`
          browserEvent('automatic-navigation-start', state, null, { path: url.pathname })
        }
        const record = { requestId: `request-${++browserRequestSequence}`, pageId: state.pageId,
          navigationId: state.navigationId, stage: state.stage, layout: state.layout,
          method: request.method(), origin: url.origin,
          path: ['http:', 'https:'].includes(url.protocol) ? url.pathname : 'non-http',
          resourceType: request.resourceType(), isNavigationRequest: request.isNavigationRequest(),
          redirectedFromId: browserRequests.get(request.redirectedFrom())?.requestId ?? null,
          queryClassification: { rscPresent: url.searchParams.has('_rsc') },
          requestHeaderDiagnostics: headerDiagnostics(request.headers(),
            ['rsc', 'next-router-prefetch', 'next-router-segment-prefetch']),
          startedAt: Date.now(), transportState: 'pending', bodyState: 'no-response' }
        let settleFailure
        const failurePromise = new Promise((resolve) => { settleFailure = resolve })
        browserRequestFailures.set(request, { promise: failurePromise, settle: settleFailure })
        browserRequests.set(request, record); activeBrowserRequests.add(request)
        evidence.browserRequests.push(record)
        record.requestAtSeq = browserEvent('request', state, record)
      }
      const onFinished = (request) => {
        const record = browserRequests.get(request)
        if (!record) { evidence.browserErrors.push({ kind: 'untracked-requestfinished', pageId: state.pageId }); return }
        record.transportState = 'finished'; record.finishedAt = Date.now()
        record.finishedAtSeq = browserEvent('requestfinished', state, record,
          { observedNavigationId: state.navigationId })
        activeBrowserRequests.delete(request)
      }
      const onFailed = (request) => {
        const record = browserRequests.get(request)
        if (!record) { evidence.browserErrors.push({ kind: 'untracked-requestfailed', pageId: state.pageId }); return }
        const errorText = request.failure()?.errorText ?? ''
        record.transportState = 'failed'; record.failedAt = Date.now()
        record.networkFailure = { errorCode: /^net::ERR_[A-Z0-9_]{1,80}$/.test(errorText) ? errorText : 'UNKNOWN', ...safeError(errorText) }
        record.failedAtSeq = browserEvent('requestfailed', state, record,
          { observedNavigationId: state.navigationId, errorCode: record.networkFailure.errorCode })
        activeBrowserRequests.delete(request)
        browserRequestFailures.get(request).settle({ via: 'requestfailed',
          diagnostic: record.networkFailure, failedAtSeq: record.failedAtSeq })
        // ERR_ABORTED is diagnostic, never an automatic exemption.
        evidence.browserErrors.push({ kind: 'request-failed', request: record })
      }
      const onResponse = (response) => {
        const request = response.request()
        let record = browserRequests.get(request)
        if (!record) {
          evidence.browserErrors.push({ kind: 'response-without-request', pageId: state.pageId })
          onRequest(request); record = browserRequests.get(request)
        }
        record.status = response.status()
        const networkStart = request.timing().startTime
        record.networkStartTimeMs = Number.isFinite(networkStart) && networkStart >= 0 ? networkStart : null
        const responseHeaders = response.headers()
        record.contentType = (responseHeaders['content-type'] ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, 128)
        record.responseHeaderDiagnostics = headerDiagnostics(responseHeaders,
          ['x-nextjs-postponed', 'x-nextjs-prerender'])
        record.headersAtSeq = browserEvent('response', state, record, { observedNavigationId: state.navigationId })
        const inspect = response.status() >= 400 || (record.origin === browserOrigin && record.path.startsWith('/v1/'))
        if (inspect) evidence.browserResponses.push(record)
        if (response.status() >= 400) evidence.browserErrors.push({ kind: 'http-error', response: record })
        // The event feed in this UI is finite JSON polling. No SSE contract is
        // mounted here; a new eventsource cannot silently bypass the barrier.
        if (record.resourceType === 'eventsource' || /^text\/event-stream(?:;|$)/i.test(record.contentType)) {
          evidence.browserErrors.push({ kind: 'unexpected-stream-contract', request: record })
        }
        const readBody = inspect && (response.status() >= 400 ||
          /^application\/(?:json|[a-z0-9.+-]+\+json)(?:;|$)/i.test(record.contentType))
        record.bodyState = readBody ? 'pending' : 'non-json-success-not-read'
        const pending = (async () => {
          try {
            const finished = await responseOrRequestFailure(request, response.finished())
            record.responseFinishedVia = finished.via
            if (finished.via === 'requestfailed') {
              record.responseFinishedState = 'failed'; record.responseFinishedError = finished.diagnostic
              record.responseFinishedRequestFailureSeq = finished.failedAtSeq
              record.responseFinishedErrorAtNavigation = state.navigationId
              record.responseFinishedErrorAtSeq = browserEvent('response-finished-requestfailed', state, record,
                { observedNavigationId: state.navigationId, failedAtSeq: finished.failedAtSeq,
                  errorCode: finished.diagnostic.errorCode })
              if (readBody) record.bodyState = 'transport-failed'
              // onFailed already recorded the real gate failure. This correlation
              // prevents a second, artificial response-finished deadline error.
              return
            }
            record.responseFinishedAtSeq = browserEvent('response-finished', state, record,
              { observedNavigationId: state.navigationId, result: finished.value ? 'error' : 'completed' })
            if (finished.value) throw finished.value
            record.responseFinishedState = 'completed'
          } catch (error) {
            record.responseFinishedState = 'failed'; record.responseFinishedError = safeError(error)
            record.responseFinishedErrorAtNavigation = state.navigationId
            record.responseFinishedErrorAtSeq = browserEvent('response-finished-error', state, record,
              { observedNavigationId: state.navigationId, errorKind: record.responseFinishedError.errorKind })
            evidence.browserErrors.push({ kind: 'response-finished-error', response: record })
            return
          }
          if (!readBody) return
          try {
            record.bodyCaptureAtSeq = browserEvent('body-capture-start', state, record,
              { observedNavigationId: state.navigationId })
            const body = await responseOrRequestFailure(request, response.text())
            record.bodySettledVia = body.via
            if (body.via === 'requestfailed') {
              record.bodyState = 'transport-failed'; record.bodyError = body.diagnostic
              record.bodyRequestFailureSeq = body.failedAtSeq
              record.bodyErrorAtNavigation = state.navigationId
              record.bodyErrorAfterNavigationChange = record.navigationId !== state.navigationId
              record.bodyErrorAtSeq = browserEvent('body-requestfailed', state, record,
                { observedNavigationId: state.navigationId, failedAtSeq: body.failedAtSeq,
                  errorCode: body.diagnostic.errorCode })
              return
            }
            const text = body.value
            Object.assign(record, responseDiagnostic(text), { bodyState: 'captured' })
            if (record.path.endsWith('/workspace')) {
              const payload = JSON.parse(text)
              record.workspaceVersionPresent = Boolean(payload.data?.version)
            }
            record.bodyCapturedAtSeq = browserEvent('body-captured', state, record,
              { observedNavigationId: state.navigationId })
          } catch (error) {
            record.bodyState = 'failed'; record.bodyError = safeError(error)
            record.bodyErrorAtNavigation = state.navigationId
            record.bodyErrorAfterNavigationChange = record.navigationId !== state.navigationId
            record.bodyErrorAtSeq = browserEvent('body-failed', state, record,
              { observedNavigationId: state.navigationId, errorKind: record.bodyError.errorKind })
            evidence.browserErrors.push({ kind: 'response-evidence-error', response: record })
          }
        })()
        browserResponseTasks.add(pending)
        void pending.finally(() => browserResponseTasks.delete(pending))
      }
      const onNavigation = (frame) => {
        if (frame !== opened.mainFrame()) return
        browserEvent('navigation-commit', state, null, { path: new URL(frame.url()).pathname })
      }
      const onClose = () => { browserEvent('page-close', state, null) }
      opened.on('request', onRequest)
      opened.on('response', onResponse)
      opened.on('requestfinished', onFinished); opened.on('requestfailed', onFailed)
      opened.on('framenavigated', onNavigation); opened.on('close', onClose)
      browserResponseListeners.push({ opened, handlers: { request: onRequest, response: onResponse,
        requestfinished: onFinished, requestfailed: onFailed, framenavigated: onNavigation, close: onClose } })
    })
    context.setDefaultTimeout(30000); context.setDefaultNavigationTimeout(30000)
    await context.addCookies([{ name: 'apollo_session', value: cookie, url: baseUrl, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    if (cancelEnabled) {
      const deadline = performance.now() + 10000
      await attachCdp(page, deadline); await attachCancelDiagnostics(page, deadline)
    } else await attachCdp(page)
    const navigatedStates = new Set()
    const pipelinePage = await context.newPage()
    if (cancelEnabled) {
      const deadline = performance.now() + 10000
      await attachCdp(pipelinePage, deadline); await attachCancelDiagnostics(pipelinePage, deadline)
    } else await attachCdp(pipelinePage)
    markBrowserPage(pipelinePage, 'pipeline-bootstrap', 'pipeline')
    pipeline = await createDashboardPipelineObserver({ page: pipelinePage, client, baseUrl, workspaceId, evidenceDir: directory })
    const observe = async ({ stage, id = projectId, operationId, ingestOperationId: observedIngestId, operationStatus, status, phase, completed, eventTypes = [],
      origin = 'public-api+postgres+factory-worker', seededStatus = false }) => {
      const row = await client.v2Project.findUniqueOrThrow({ where: { id } })
      assert.equal(row.status, status, `${stage}: authoritative project status`)
      const response = await fetch(`${baseUrl}/v1/projects?limit=24`, { headers: { authorization }, signal: AbortSignal.timeout(30000) })
      assert.equal(response.status, 200)
      const payload = await response.json(); const projected = payload.data.projects.find((candidate) => candidate.id === id)
      assert.ok(projected); assert.equal(projected.status, status); assert.equal(projected.visibleState.label, status)
      const expected = CARD_EXPECTATIONS[status]
      assert.ok(expected, `${stage}: independent card expectation exists`)
      assert.equal(projected.visibleState.tone, expected.tone)
      assert.equal(projected.visibleState.primaryAction, expected.action)
      const operation = operationId ? await client.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } }) : null
      if (operation) {
        if (operationStatus !== undefined) assert.equal(operation.status, operationStatus)
        assert.equal(operation.phase, phase); assert.equal(operation.progressCompleted, completed)
        assert.equal(operation.progressTotal, 4); assert.equal(operation.progressUnit, 'render')
        assert.equal(projected.dashboard.latestOperation.id, operationId)
        assert.equal(projected.dashboard.latestOperation.status, operation.status)
        assert.equal(projected.dashboard.latestOperation.phase, phase)
        assert.deepEqual(projected.dashboard.latestOperation.progress, { completed, total: 4, unit: 'render' })
      } else if (observedIngestId) {
        // A source-only project is one whose ingest finished: the media-ingest operation that left its receipt is its latest.
        const ingest = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: observedIngestId } })
        assert.equal(ingest.type, 'media-ingest'); assert.equal(ingest.status, 'succeeded')
        assert.equal(projected.dashboard.latestOperation.id, observedIngestId)
        assert.equal(projected.dashboard.latestOperation.type, 'media-ingest')
        assert.equal(projected.dashboard.latestOperation.status, 'succeeded')
      }
      if (eventTypes.length) {
        markBrowserPage(pipelinePage, stage, 'pipeline')
        await pipeline.observe({ stage, projectId: id, operationId, expectedEventTypes: eventTypes, expectedState: status })
      }
      for (const [layout, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
        markBrowserPage(page, stage, layout)
        // A viewport change makes the dashboard poll the event feed at once (about 30 ms later; the evidence of a CI run shows a fetch 20 to
        // 40 ms after the intent in several navigations), so it is applied here, before the barriers below, and not between the navigation intent and the `goto`: there that
        // poll was still in flight when the new document committed and was cancelled with the old one.
        await page.setViewportSize(viewport)
        await drainBrowserResponses({ label: 'before-main-foreground' })
        const visibilityBefore = await page.evaluate(() => document.visibilityState)
        await page.bringToFront()
        await page.waitForFunction(() => document.visibilityState === 'visible')
        evidence.foregroundObservations ??= []
        evidence.foregroundObservations.push({ stage, layout, before: visibilityBefore, after: await page.evaluate(() => document.visibilityState) })
        await drainBrowserResponses({ label: 'before-dashboard-navigation' })
        await leaveDocument(page)
        const dashboardNavigation = beginBrowserNavigation(page, stage, layout, '/')
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
        const card = page.locator(`article[data-project-id="${id}"]`)
        try { await card.waitFor({ state: 'visible' }) } catch (error) {
          evidence.domFailure = { stage, layout, url: page.url(), visibility: await page.evaluate(() => document.visibilityState), text: await page.locator('body').innerText() }
          await page.screenshot({ path: join(directory, 'w35-dom-failure.png'), fullPage: true })
          throw error
        }
        await drainBrowserResponses({ opened: page, navigationId: dashboardNavigation,
          requiredPaths: ['/v1/projects', '/v1/events/feed'], label: 'dashboard-bootstrap' })
        assert.equal(await card.locator('[data-state]').getAttribute('data-state'), status)
        assert.equal(await card.locator('[data-state]').innerText(), expected.badge)
        assert.ok((await card.locator('[data-state]').getAttribute('class')).split(' ').includes(expected.color))
        const action = card.getByRole('button', { name: expected.button, exact: true })
        assert.equal(await action.isEnabled(), true)
        const bar = card.getByRole('progressbar')
        if (operation) assert.equal(await bar.getAttribute('aria-valuenow'), String(completed * 25))
        else if (observedIngestId) {
          const ingestProgress = projected.dashboard.latestOperation.progress
          assert.equal(await bar.getAttribute('aria-valuenow'), String(Math.round(100 * ingestProgress.completed / ingestProgress.total)))
        } else assert.equal(await bar.count(), 0)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
        const name = `w35-${stage}-${layout}.png`; await page.screenshot({ path: join(directory, name), fullPage: true })
        evidence.screenshots.push({ name, sha256: sha256(await readFile(join(directory, name))) })
        if (layout === 'desktop' && !navigatedStates.has(status)) {
          const destination = `/projects/${id}${status === 'reviewing-proxy' ? '?mode=review' : ''}`
          await drainBrowserResponses({ label: 'before-workspace-navigation' })
          const workspaceNavigation = beginBrowserNavigation(page, stage, layout, `/projects/${id}`)
          const workspaceResponse = page.waitForResponse((candidate) => {
            const url = new URL(candidate.url())
            return candidate.request().method() === 'GET' && url.origin === new URL(baseUrl).origin &&
              url.pathname === `/v1/projects/${id}/workspace` &&
              browserRequests.get(candidate.request())?.navigationId === workspaceNavigation
          }, { timeout: 30000 }).then((response) => ({ response }), (error) => ({ error }))
          await action.click()
          await page.waitForURL(`${baseUrl}${destination}`)
          const hydrated = await workspaceResponse
          assert.ifError(hydrated.error)
          assert.equal(hydrated.response.status(), 200, `${stage}: browser workspace hydration must succeed`)
          await drainWorkspaceBootstrap(page, workspaceNavigation, id)
          navigatedStates.add(status)
        }
        await drainBrowserResponses()
        assert.deepEqual(evidence.browserErrors, [], `${stage}: browser errors are not acceptable`)
      }
      evidence.states.push({ stage, projectId: id, status, operationId, phase, completed,
        total: operation ? 4 : undefined, operationStatus: operation?.status,
        origin, seededStatus, visibleState: projected.visibleState,
        presentation: expected, actionDestination: `/projects/${id}${status === 'reviewing-proxy' ? '?mode=review' : ''}` })
    }
    const proveShellNavigation = async () => {
      const pageId = browserPages.get(page).pageId
      const destinations = [['Projetos', '/'], ['Lotes', '/batches'], ['Localização', '/localization'],
        ['Biblioteca', '/library'], ['Apresentadores', '/presenters'], ['Capturas', '/capture-sessions'],
        ['Marca', '/brand'], ['Configurações', '/workspace-settings']]
      const shellPaths = new Set(destinations.map(([, path]) => path))
      const proof = evidence.shellNavigationProof = { pageId, projectId, status: 'pending',
        scope: 'observed-shell-actions-and-render-hover-prefetch-only', hover: [], transitions: [],
        prefetchRequestIds: [], noChromiumCauseClaim: true }
      const remaining = (deadline) => { const value = Math.floor(deadline - performance.now()); assert.ok(value > 0, 'Shell action uses the existing finite browser barrier deadline'); return value }
      const draftOnly = async () => {
        assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).status, 'draft')
        assert.equal(await client.v2ProjectMediaAsset.count({ where: { projectId, role: 'editorial-proxy' } }), 0)
      }
      try {
        await draftOnly()
        const hoverDeadline = performance.now() + 10000
        markBrowserPage(page, 'shell-render-and-hover', 'desktop')
        await drainBrowserResponses({ label: 'before-shell-hover', deadline: hoverDeadline })
        await page.setViewportSize({ width: 1440, height: 1000 }); remaining(hoverDeadline)
        assert.equal(new URL(page.url()).pathname, '/')
        const navigation = page.getByTestId('app-shell-navigation')
        await navigation.waitFor({ state: 'visible', timeout: remaining(hoverDeadline) })
        for (const [label, path] of destinations) {
          const link = navigation.getByRole('link', { name: label, exact: true })
          assert.equal(await link.getAttribute('href', { timeout: remaining(hoverDeadline) }), path)
          await link.hover({ timeout: remaining(hoverDeadline) })
          proof.hover.push({ label, path, at: Date.now(), seq: browserSequence })
        }
        await drainBrowserResponses({ opened: page, navigationId: browserPages.get(page).navigationId,
          label: 'shell-render-and-hover', deadline: hoverDeadline })
        proof.renderHoverThroughSeq = browserSequence
        const prefetched = evidence.browserRequests.filter((record) => record.pageId === pageId &&
          record.origin === browserOrigin && shellPaths.has(record.path) && record.requestAtSeq <= proof.renderHoverThroughSeq &&
          (record.requestHeaderDiagnostics.rsc.token === '1' || record.queryClassification.rscPresent) &&
          (record.requestHeaderDiagnostics['next-router-prefetch'].present || record.requestHeaderDiagnostics['next-router-segment-prefetch'].present))
        proof.prefetchRequestIds = prefetched.map((record) => record.requestId)
        assert.deepEqual(proof.prefetchRequestIds, [], 'Rendering and hovering the shell must not request destination RSC prefetches')
        assert.deepEqual(evidence.browserErrors, [], 'Shell hover preserves every browser error gate')
        for (const [action, path, active] of [['click', '/brand', 'Marca'], ['keyboard-enter', '/', 'Projetos'],
          ['back', '/brand', 'Marca'], ['forward', '/', 'Projetos']]) {
          const deadline = performance.now() + 10000
          const observation = { action, path, active, status: 'pending', startedAt: Date.now(), requestIds: [] }
          proof.transitions.push(observation)
          await drainBrowserResponses({ label: `before-shell-${action}`, deadline })
          const navigationId = beginBrowserNavigation(page, `shell-${action}`, 'desktop', path)
          observation.navigationId = navigationId
          const shell = page.getByTestId('app-shell-navigation')
          if (action === 'click') await shell.getByRole('link', { name: 'Marca', exact: true }).click({ timeout: remaining(deadline) })
          else if (action === 'keyboard-enter') {
            const link = shell.getByRole('link', { name: 'Projetos', exact: true })
            await link.focus({ timeout: remaining(deadline) })
            assert.equal(await link.evaluate((element) => element === document.activeElement), true)
            remaining(deadline); await link.press('Enter', { timeout: remaining(deadline) })
          } else if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: remaining(deadline) })
          else await page.goForward({ waitUntil: 'domcontentloaded', timeout: remaining(deadline) })
          await page.waitForURL(`${baseUrl}${path}`, { waitUntil: 'domcontentloaded', timeout: remaining(deadline) })
          const heading = path === '/brand' ? page.getByRole('heading', { name: 'Marca', level: 1, exact: true })
            : page.getByRole('heading', { name: /Um projeto começa pela direção/, level: 1 })
          await heading.waitFor({ state: 'visible', timeout: remaining(deadline) })
          const ariaCurrent = await shell.getByRole('link', { name: active, exact: true }).getAttribute('aria-current', { timeout: remaining(deadline) })
          assert.equal(ariaCurrent, 'page')
          assert.equal(await shell.locator('a[aria-current="page"]').count(), 1); remaining(deadline)
          if (path === '/') {
            const card = page.locator(`article[data-project-id="${projectId}"]`)
            await card.waitFor({ state: 'visible', timeout: remaining(deadline) })
            assert.equal(await card.locator('[data-state]').getAttribute('data-state', { timeout: remaining(deadline) }), 'draft')
          }
          // First Marca mount has these real effects. History may restore cached UI;
          // its request ledger remains strict without inventing another response.
          const requiredPaths = action === 'click' ? ['/v1/capabilities', '/v1/session',
            `/v1/workspaces/${encodeURIComponent(workspaceId)}/luts`, `/v1/workspaces/${encodeURIComponent(workspaceId)}/lut-default`] : []
          await drainBrowserResponses({ opened: page, navigationId, requiredPaths, label: `shell-${action}`, deadline })
          assert.deepEqual(evidence.browserErrors, [], `Shell ${action} preserves every browser error gate`)
          observation.observedPath = new URL(page.url()).pathname
          observation.ariaCurrent = ariaCurrent; observation.headingVisible = await heading.isVisible(); remaining(deadline)
          assert.equal(observation.headingVisible, true)
          observation.requestIds = evidence.browserRequests.filter((record) => record.pageId === pageId && record.navigationId === navigationId).map((record) => record.requestId)
          observation.status = 'completed'; observation.completedAt = Date.now(); observation.completedAtSeq = browserSequence
        }
        await draftOnly(); proof.status = 'completed'
      } catch (error) {
        proof.status = 'failed'; proof.error = safeError(error)
        const pending = proof.transitions.find((record) => record.status === 'pending')
        if (pending) { pending.status = 'failed'; pending.error = safeError(error) }
        throw error
      }
    }
    await observe({ stage: 'draft', status: 'draft', ingestOperationId })
    const draftReviewRequests = evidence.browserRequests.filter((record) => record.method === 'GET' &&
      [`/v1/projects/${projectId}/annotations`, `/v1/projects/${projectId}/proxy-reviews`].includes(record.path))
    // An ingested source always carries its editing proxy, which is what the annotation session previews; no proxy report exists
    // until a proxy render is reviewed. The page asks for exactly what the published availability says is there, and for nothing else.
    const draftWorkspace = await readPublicWorkspace(projectId, 'draft-review-availability')
    assert.equal(draftWorkspace.reviewAvailability.proxyReview.state, 'unavailable')
    assert.equal(draftWorkspace.reviewAvailability.annotations.state, 'available')
    assert.deepEqual(draftReviewRequests.map((record) => record.path).sort(), [`/v1/projects/${projectId}/annotations`],
      'The ingested draft requests the annotation session its editing proxy makes available, and no unavailable proxy report')
    evidence.reviewAvailabilityProof = { projectId, draftRequests: draftReviewRequests.length, origin: 'browser-request-ledger', afterWorker: 'pending' }
    await proveShellNavigation()
    const created = await post('/v1/projects', { name: 'Runtime event creation', objective: 'discovery' }, `runtime-event-create-${suffix}`, 201)
    await pipeline.observe({ stage: 'created', projectId: created.projectAtCreation.id, expectedEventTypes: ['project.created'], expectedState: 'draft' })
    prototype.claimNext = async function (...args) {
      const result = await originals.claimNext.apply(this, args)
      if (result && activeObserver) {
        const before = await client.v2Project.findUniqueOrThrow({ where: { id: result.operation.projectId } })
        const stale = await this.failOrRetry({ operationId: result.operation.id, leaseOwner: 'stale-runtime-worker',
          attempt: result.lease.attempt, now: new Date().toISOString(),
          error: { code: 'controlled_stale_failure', message: 'Rejected stale owner', retryable: false } })
        assert.equal(stale, null)
        const expiredAt = new Date(new Date(result.lease.expiresAt).getTime() + 1)
        assert.equal(await this.heartbeat({ operationId: result.operation.id, leaseOwner: result.lease.owner,
          attempt: result.lease.attempt, now: expiredAt.toISOString(), leaseUntil: new Date(expiredAt.getTime() + 60000).toISOString() }), false)
        const after = await client.v2Project.findUniqueOrThrow({ where: { id: result.operation.projectId } })
        assert.equal(after.status, before.status); assert.equal(after.currentVersionId, before.currentVersionId)
        evidence.states.push({ stage: 'stale-owner-and-expired-lease-rejected', projectId: before.id, operationId: result.operation.id,
          origin: 'real-fenced-repository', status: after.status })
        await observeWorker(result.operation, 'claimed')
      }
      return result
    }
    prototype.advancePhase = async function (command) {
      const result = await originals.advancePhase.call(this, command)
      if (result && activeObserver) {
        const row = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: command.operationId } })
        await observeWorker({ id: row.id, projectId: row.projectId, phase: row.phase, progress: { completed: row.progressCompleted } }, 'advanced')
      }
      return result
    }
    activeObserver = async (operation, kind) => observe({ stage: `proxy-${operation.phase}`, operationId: operation.id,
      status: 'rendering-proxy', phase: operation.phase, completed: operation.progress.completed,
      eventTypes: [kind === 'claimed' ? 'operation.status.changed' : 'operation.progress.changed'] })
    const proxy = await post(`/v1/projects/${projectId}/proxy-renders`, undefined, `runtime-proxy-${suffix}`, 202)
    const proxyId = proxy.operation.id
    await observe({ stage: 'proxy-queued', status: 'rendering-proxy', operationId: proxyId, phase: 'queued', completed: 0, eventTypes: ['operation.status.changed'] })
    const portableDiagnostic = (value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : null
    const proxyWorker = createProjectProxyRenderWorker(environment, undefined, ({ operationId, error }) => {
      const message = typeof error?.message === 'string' ? error.message : ''
      const syscall = typeof error?.syscall === 'string' ? error.syscall.split(' ')[0] : null
      evidence.proxyWorkerFailures ??= []
      evidence.proxyWorkerFailures.push({ operationId, name: portableDiagnostic(error?.name),
        code: portableDiagnostic(error?.code), errno: Number.isSafeInteger(error?.errno) ? error.errno : portableDiagnostic(error?.errno),
        syscall: ['spawn', 'open', 'stat', 'lstat', 'read', 'write', 'access', 'rename', 'unlink', 'connect'].includes(syscall) ? syscall : null,
        messageSha256: sha256(message), messageBytes: Buffer.byteLength(message) })
    })
    const firstProxyOutcome = await runObservedWorker(() => proxyWorker(`runtime-proxy-worker-${suffix}`, { workspaceId, operationId: proxyId, signal }))
    const firstProxyRow = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: proxyId },
      select: { id: true, projectId: true, attempt: true, status: true, phase: true,
        errorCode: true, errorMessage: true, errorRetryable: true } })
    evidence.firstProxyWorkerDiagnostic = { operationId: firstProxyRow.id, projectId: firstProxyRow.projectId,
      attempt: firstProxyRow.attempt, operationAttemptKey: `${firstProxyRow.id}:${firstProxyRow.attempt}`,
      status: firstProxyRow.status, phase: firstProxyRow.phase, outcome: firstProxyOutcome,
      error: { code: firstProxyRow.errorCode, retryable: firstProxyRow.errorRetryable,
        messageSha256: firstProxyRow.errorMessage === null ? null : sha256(firstProxyRow.errorMessage),
        messageBytes: firstProxyRow.errorMessage === null ? 0 : Buffer.byteLength(firstProxyRow.errorMessage) } }
    assert.deepEqual(firstProxyOutcome, { operationId: proxyId, status: 'succeeded' },
      JSON.stringify(evidence.firstProxyWorkerDiagnostic))
    await observe({ stage: 'review', status: LISTED_PROJECT_STATUS, operationId: proxyId, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    for (const path of [`/v1/projects/${projectId}/annotations`, `/v1/projects/${projectId}/proxy-reviews`]) {
      assert.ok(evidence.browserRequests.some((record) => record.method === 'GET' && record.path === path &&
        record.stage === 'review' && record.status === 200 && record.bodyState === 'captured' && record.transportState === 'finished'),
      `Published real proxy must expose a completed browser review read: ${path}`)
    }
    evidence.reviewAvailabilityProof.afterWorker = { operationId: proxyId, annotationsStatus: 200, proxyReviewStatus: 200,
      scope: 'availability-only; stored face safety remains unknown and final export blocked' }
    const replay = await post(`/v1/projects/${projectId}/proxy-renders`, undefined, `runtime-proxy-${suffix}`, 202)
    assert.equal(replay.replayed, true); assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).status, LISTED_PROJECT_STATUS)
    const review = await client.v2ProxyReview.findFirstOrThrow({ where: { workspaceId, projectId, operationId: proxyId } })
    // The burned captions were measured on the delivered pixels, and no independent veto detector is wired: the review says so.
    assertListedReview(review, 'main proxy review', { requiredWarnings: ['FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED', 'FACE_PIXEL_CHECK_UNAVAILABLE'] })
    evidence.proxyEditorialState = { projectStatus: LISTED_PROJECT_STATUS, reviewStatus: review.status,
      finalAllowed: review.finalAllowed, faceSafety: 'unknown', origin: 'postgres+production-proxy-review-repository' }
    const proxyArtifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: review.proxyArtifactId } })
    const annotation = await post(`/v1/projects/${projectId}/annotations`, { projectVersionId, proxyArtifactId: proxyArtifact.id,
      proxyHash: proxyArtifact.sha256, frame: 0, timeRangeMs: [0, 100], scope: 'point', targetIds: [],
      screenshotRef: await annotationScreenshot(proxyArtifact, 'annotation-main-frame-0'), text: 'Controlled runtime inspection; preserve framing.' }, `runtime-annotation-${suffix}`, 201)
    await pipeline.observe({ stage: 'annotation', projectId, annotationId: annotation.annotation.id, expectedEventTypes: ['annotation.created'], expectedState: LISTED_PROJECT_STATUS })
    // A copy (fork) of the project references every artifact it links, the rendered proxy included, and each needs current rights that
    // allow the editing use: the proxy render stores its output without a grant, so the owner grants it, exactly as for the master.
    {
      const { setAssetRightsService } = await import('../../../src/v2/application/set-asset-rights.ts')
      const { assetRightsRevision } = await import('../../../src/v2/domain/asset-rights.ts')
      await setAssetRightsService({ repository: new PrismaAssetRightsRepository(client), clock: () => new Date(), createId: () => `runtime-proxy-rights-${suffix}` })({
        workspaceId, artifactId: proxyArtifact.id, baseRevision: assetRightsRevision(proxyArtifact.id, 0),
        draft: { status: 'approved', allowedUses: ['editing', 'rendering', 'editorial-reuse'], prohibitedUses: [], allowedLocales: ['pt-BR'],
          consent: { status: 'not-required', allowedUses: [] }, sourceNote: 'Controlled rendered proxy of the runtime journey' },
        actor: { type: 'api-client', id: actor.clientId } })
    }
    const copy = await post(`/v1/projects/${projectId}/duplicates`, { expectedVersionId: projectVersionId,
      expectedVersionHash: projectVersionHash, name: 'Runtime isolated failure' }, `runtime-copy-${suffix}`, 201)
    await pipeline.observe({ stage: 'copy', projectId: copy.project.id, expectedEventTypes: ['project.created'], expectedState: 'draft' })
    const exportBody = { projectVersionId, projectVersionHash, format: '9:16', approval: { approved: true, note: 'Controlled W35 runtime inspection.' } }
    const artifactCount = await client.v2MediaArtifact.count({ where: { workspaceId } })
    const publicRejected = await fetch(`${baseUrl}/v1/projects/${projectId}/exports`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `runtime-public-final-${suffix}` },
      body: JSON.stringify(exportBody), signal: AbortSignal.timeout(30000) })
    const publicRejection = await publicRejected.json()
    assert.equal(publicRejected.status, 422, JSON.stringify(publicRejection))
    assert.equal(publicRejection.error.code, 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.equal(await client.v2PublicOperation.count({ where: { workspaceId, type: 'project-final-export' } }), 0)
    assert.equal(await client.v2ProjectFinalExportOperation.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2ProjectFinalExportAttempt.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2AutomaticCatalogRecord.count({ where: { workspaceId } }), 0)
    assert.equal(await client.v2MediaArtifact.count({ where: { workspaceId } }), artifactCount)
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).status, LISTED_PROJECT_STATUS)
    evidence.publicFinalAdmission = { status: 422, code: publicRejection.error.code,
      projectId, projectStatus: LISTED_PROJECT_STATUS, finalOperations: 0, attempts: 0, catalogRecords: 0, artifactsCreated: 0 }

    const reviewSeal = (row) => stableSerialize({ projectVersionId: row.projectVersionId,
      operationId: row.operationId, proxyArtifactId: row.proxyArtifactId, proxyManifestId: row.proxyManifestId,
      inputHash: row.inputHash, reviewHash: row.reviewHash, status: row.status,
      finalAllowed: row.finalAllowed, warningsAcknowledged: row.warningsAcknowledged,
      technicalIssuesJson: row.technicalIssuesJson, criticIssuesJson: row.criticIssuesJson,
      formatQualityJson: row.formatQualityJson })
    const principal = { projectId, projectVersionId, exportBody, qualityId: directed.command.payload.snapshotRefs.quality,
      qualityJson: stableSerialize(directed.run.qualityReport), reviewId: review.id, reviewSeal: reviewSeal(review) }
    evidence.mainUpstream = { projectId, resultVersionId: directed.version.id, resultVersionHash: directed.version.baseHash,
      directorRunId: directed.run.id, directorBaseVersionId: directed.run.baseVersionId,
      perceptionInputVersionId: directed.run.perception.inputVersionId, perceptionHash: calculateVersionHash(directed.run.perception),
      transcriptId: directed.command.payload.sourceTranscriptId, editPlanHash: calculateVersionHash(directed.run.editPlan),
      qualitySnapshotId: principal.qualityId, qualitySnapshotHash: calculateVersionHash(directed.run.qualityReport),
      sourceArtifactId, sourceManifestId, sourceManifestHash: sourceManifest.manifestHash, sourceSha256, sourceByteSize,
      observedSourceColorProbe: { id: sourceColorProbe.id, hash: sourceColorProbe.probeHash,
        detection: sourceColorProbe.detection, producer: sourceColorProbe.producer },
      sourceObservationScope: 'synthetic media and caller-aligned transcript; no face detector authority' }
    const principalCompilation = JSON.parse((await client.v2ColorPipelineCompilation.findFirstOrThrow({ where: { workspaceId, projectId } })).compilationJson)
    const mechanical = await seedDashboardControlledExportFixture({ client, workspaceId, actor, artifactRoot, suffix,
      sourceArtifactId, sourceManifestId, sourcePath, sourceManifest, proxyArtifact, proxyManifestId: review.proxyManifestId,
      signal, ...mechanicalSeed,
      // Same public compilation as before, now completed before the seed INSERT.
      compileColorPipeline: ({ projectId: seedProjectId, sourceArtifactId: seedArtifactId, sourceManifestId: seedManifestId }) =>
        post(`/v1/projects/${seedProjectId}/color-pipeline-compilations`, {
          sourceArtifactId: seedArtifactId, sourceManifestId: seedManifestId,
          outputMetadata: principalCompilation.pipeline.outputMetadata,
          stages: principalCompilation.pipeline.stages.map(({ id, kind, version, enabled, output, implementation, lut }) =>
            ({ id, kind, version, enabled, output, implementation, ...(lut ? { lut } : {}) })),
        }, `runtime-mechanical-color-${suffix}`, 201),
    })
    assert.notEqual(mechanical.projectId, projectId)
    assert.notEqual(mechanical.projectVersionId, projectVersionId)
    assert.notEqual(mechanical.directed.command.id, directed.command.id)
    assert.notEqual(mechanical.directed.command.payload.snapshotRefs.quality, principal.qualityId)
    evidence.mechanicalFixture = mechanical.receipt
    const seededWorkspace = await readPublicWorkspace(mechanical.projectId, 'seeded-blocked-review-before-browser')
    assert.equal(seededWorkspace.project.currentVersionId, mechanical.projectVersionId)

    {
    const { projectId, projectVersionId, projectVersionHash, directed, sourceArtifactId, sourceManifestId,
      sourceSha256, sourceByteSize, sourceManifest, proxyArtifact, review } = mechanical
    const exportBody = { projectVersionId, projectVersionHash, format: '9:16',
      approval: { approved: true, note: 'Negative admission proof only; stored quality remains unknown.' } }
    const seededOperation = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: review.operationId } })
    assert.equal(seededOperation.workspaceId, workspaceId)
    assert.equal(seededOperation.projectId, projectId)
    assert.equal(seededOperation.type, 'project-proxy-render')
    assert.equal(seededOperation.status, 'succeeded')
    assert.equal(seededOperation.phase, 'completed')
    assert.equal(seededOperation.progressCompleted, 4)
    assert.equal(seededOperation.progressTotal, 4)
    assert.equal(seededOperation.progressUnit, 'render')
    await observe({ stage: 'seeded-blocked-review', id: projectId, status: 'reviewing-proxy',
      operationId: seededOperation.id, operationStatus: 'succeeded', phase: 'completed', completed: 4,
      origin: 'controlled-pg-seed+real-api-projection+native-browser', seededStatus: true })
    const projectBefore = await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })
    const runBefore = await client.v2DirectorRun.findUniqueOrThrow({ where: { id: directed.run.id } })
    assert.equal(runBefore.status, 'planned')
    const effects = async () => ({
      finalOperations: await client.v2PublicOperation.count({ where: { workspaceId, type: 'project-final-export' } }),
      finalDetails: await client.v2ProjectFinalExportOperation.count({ where: { workspaceId } }),
      finalAttempts: await client.v2ProjectFinalExportAttempt.count({ where: { workspaceId } }),
      catalogRecords: await client.v2AutomaticCatalogRecord.count({ where: { workspaceId } }),
      artifacts: await client.v2MediaArtifact.count({ where: { workspaceId } }),
      outboxEvents: await client.v2PublicEventOutbox.count({ where: { workspaceId } }),
    })
    const effectsBefore = await effects()
    assert.equal(effectsBefore.finalOperations, 0)
    assert.equal(effectsBefore.finalDetails, 0)
    assert.equal(effectsBefore.finalAttempts, 0)
    const mechanicalPublic = await fetch(`${baseUrl}/v1/projects/${projectId}/exports`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `runtime-mechanical-public-final-${suffix}` },
      body: JSON.stringify(exportBody), signal: AbortSignal.timeout(30000) })
    const mechanicalPublicBody = await mechanicalPublic.json()
    assert.equal(mechanicalPublic.status, 422, JSON.stringify(mechanicalPublicBody))
    assert.equal(mechanicalPublicBody.error.code, 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.deepEqual(await effects(), effectsBefore)
    assert.deepEqual(await client.v2Project.findUniqueOrThrow({ where: { id: projectId } }), projectBefore)
    evidence.mechanicalPublicFinalAdmission = { projectId, status: 422,
      code: mechanicalPublicBody.error.code, finalOperations: 0, finalDetails: 0, finalAttempts: 0,
      additionalCatalogRecords: 0, additionalArtifacts: 0, additionalOutboxEvents: 0,
      initialStatus: 'reviewing-proxy', seededStatus: true,
      storedQualityStatus: 'review-required', faceSafety: 'unknown', seededProxyReviewStatus: 'blocked' }

    // This port changes only the approval claim in its return value. All identity,
    // lineage, source bytes and persisted UNKNOWN quality/review are checked on
    // each current/immutable read; no API or stored report receives approval.
    const identity = Object.freeze({ workspaceId, projectId, projectVersionId, projectVersionHash,
      editPlanSnapshotId: directed.version.snapshotRefs.editPlan, directorRunId: directed.run.id,
      qualitySnapshotId: directed.command.payload.snapshotRefs.quality,
      qualitySnapshotHash: calculateVersionHash(directed.run.qualityReport),
      proxyReviewId: review.id, proxyReviewHash: review.reviewHash, proxyArtifactId: review.proxyArtifactId,
      sourceArtifactId, sourceManifestId })
    assert.ok(identity.qualitySnapshotId)
    const sourceReader = new PrismaProjectProxyRenderRepository(client)
    const finalRepository = new PrismaProjectFinalExportRepository(client)
    const qualityJson = stableSerialize(directed.run.qualityReport)
    evidence.controlledUpstream = { projectId, directorRunId: directed.run.id, directorBaseVersionId: directed.run.baseVersionId,
      resultVersionId: directed.version.id, resultVersionHash: directed.version.baseHash,
      perceptionInputVersionId: directed.run.perception.inputVersionId,
      perceptionHash: calculateVersionHash(directed.run.perception),
      transcriptId: directed.command.payload.sourceTranscriptId,
      editPlanHash: calculateVersionHash(directed.run.editPlan), qualitySnapshotHash: identity.qualitySnapshotHash,
      sourceArtifactId, sourceManifestId, sourceManifestHash: sourceManifest.manifestHash, sourceSha256, sourceByteSize,
      sourceObservationScope: 'separately seeded copied media and aligned transcript; no face detector authority' }
    const sealedReview = reviewSeal(review)
    async function readControlledSource(request, immutable) {
      const required = immutable ? Object.keys(identity) : ['workspaceId', 'projectId', 'projectVersionId', 'projectVersionHash']
      if (required.some((key) => request[key] !== identity[key])) return null
      const source = immutable ? await sourceReader.readImmutableSource(request)
        : await sourceReader.readCurrentSource({ workspaceId, projectId })
      if (!source || source.projectVersionId !== projectVersionId ||
          source.editPlanSnapshotId !== identity.editPlanSnapshotId ||
          source.editPlanHash !== calculateVersionHash(directed.run.editPlan) ||
          source.sourceArtifactId !== sourceArtifactId || source.sourceManifestId !== sourceManifestId ||
          source.sourceSha256 !== sourceSha256 || source.renderSources.length !== 1 ||
          source.renderSources[0].artifactId !== sourceArtifactId ||
          source.renderSources[0].manifestId !== sourceManifestId ||
          source.renderSources[0].sha256 !== sourceSha256 ||
          source.renderSources[0].byteSize !== sourceByteSize) return null
      const [project, version, run, quality, storedReview, artifact, manifest, storedProxy] = await Promise.all([
        client.v2Project.findFirst({ where: { id: projectId, workspaceId } }),
        client.v2ProjectVersion.findFirst({ where: { id: projectVersionId, workspaceId, projectId, baseHash: projectVersionHash } }),
        client.v2DirectorRun.findFirst({ where: { id: identity.directorRunId, workspaceId, projectId,
          resultVersionId: projectVersionId, qualitySnapshotId: identity.qualitySnapshotId, status: 'planned' } }),
        client.v2ProjectSnapshot.findFirst({ where: { id: identity.qualitySnapshotId, workspaceId, projectId, kind: 'quality-report' } }),
        client.v2ProxyReview.findFirst({ where: { id: review.id, workspaceId, projectId, projectVersionId } }),
        client.v2MediaArtifact.findFirst({ where: { id: sourceArtifactId, workspaceId, sha256: sourceSha256, status: 'available' } }),
        client.v2MediaArtifactManifest.findFirst({ where: { id: sourceManifestId, workspaceId, artifactId: sourceArtifactId } }),
        client.v2MediaArtifact.findFirst({ where: { id: proxyArtifact.id, workspaceId, sha256: proxyArtifact.sha256, status: 'available' } }),
      ])
      if (!project || (!immutable && project.currentVersionId !== projectVersionId) ||
          !version || version.editPlanSnapshotId !== identity.editPlanSnapshotId || !run || !quality ||
          quality.schemaVersion !== 5 || quality.contentHash !== identity.qualitySnapshotHash ||
          quality.contentJson !== qualityJson || !storedReview || reviewSeal(storedReview) !== sealedReview ||
          !artifact || Number(artifact.byteSize) !== sourceByteSize || !manifest ||
          manifest.manifestHash !== sourceManifest.manifestHash ||
          manifest.manifestJson !== stableSerialize(sourceManifest) || !storedProxy) return null
      return Object.freeze({ ...source, projectVersionHash, locale: project.locale,
        directorRunId: identity.directorRunId, qualitySnapshotId: identity.qualitySnapshotId,
        qualitySnapshotHash: identity.qualitySnapshotHash, qualityStatus: 'approved',
        qualityScore: directed.run.qualityReport.score, proxyReviewId: review.id,
        proxyReviewHash: review.reviewHash, proxyArtifactId: review.proxyArtifactId })
    }
    const controlledProjects = Object.freeze({
      readApprovedCurrentSource: (request) => readControlledSource(request, false),
      readImmutableApprovedSource: (request) => readControlledSource(request, true),
      convergeOutputIdentity: (request) => finalRepository.convergeOutputIdentity(request),
      attachCompletedOutput: (request) => finalRepository.attachCompletedOutput(request),
      markExportFailed: (request) => finalRepository.markExportFailed(request),
      recordAttempt: (request) => finalRepository.recordAttempt(request),
      readAttemptHistory: (request) => finalRepository.readAttemptHistory(request),
    })
    const operations = new PrismaPublicOperationRepository(client, randomUUID,
      () => createProtectedPayloadCipherFromEnvironment(environment))
    let persistenceAdmissionAttempts = 0
    let persistenceRejectedApprovalClaim = false
    const observedOperations = {
      findReplay: (request) => operations.findReplay(request),
      createOrReplay: async (request) => {
        persistenceAdmissionAttempts += 1
        try { return await operations.createOrReplay(request) } catch (error) {
          assert.equal(error.code, 'EDITORIAL_ACCEPTANCE_FAILED', 'Real PostgreSQL admission must reject the controlled approval claim')
          persistenceRejectedApprovalClaim = true
          throw error
        }
      },
    }
    const rights = new PrismaAssetRightsRepository(client)
    const enqueueFinal = enqueueProjectFinalExportService({ projects: controlledProjects, rights, operations: observedOperations,
      colorPipelines: createColorPipelineCompilationRepository(), clock: () => new Date(),
      createId: (kind) => `runtime-final-${kind}-${suffix}` })
    const finalRequest = { workspaceId, projectId, ...exportBody, actor, idempotencyKey: `runtime-final-${suffix}` }
    await assert.rejects(enqueueFinal(finalRequest), (error) => error.code === 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.equal(persistenceAdmissionAttempts, 1, 'The negative must reach the real persistence admission gate')
    assert.equal(persistenceRejectedApprovalClaim, true)
    await assert.rejects(enqueueFinal({ ...finalRequest, projectVersionHash: '0'.repeat(64),
      idempotencyKey: `runtime-final-wrong-version-${suffix}` }), (error) => error.code === 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.equal(persistenceAdmissionAttempts, 1, 'Wrong-version rejection must happen before persistence admission')
    assert.deepEqual(await effects(), effectsBefore)
    assert.deepEqual(await client.v2Project.findUniqueOrThrow({ where: { id: projectId } }), projectBefore)
    const storedRun = await client.v2DirectorRun.findUniqueOrThrow({ where: { id: identity.directorRunId } })
    assert.deepEqual(storedRun, runBefore)
    evidence.controlledApprovalClaimRejectedByPersistence = {
      proofScope: 'negative-real-postgresql-admission', approvalClaim: 'test-only repository return value',
      errorCode: 'EDITORIAL_ACCEPTANCE_FAILED', persistenceAdmissionAttempts,
      identity, persistedProxyReview: { status: review.status, finalAllowed: review.finalAllowed },
      persistedDirectorStatus: storedRun.status, unchangedProjectStatus: projectBefore.status,
      persistedQuality: { status: directed.run.qualityReport.status, faceSafety: directed.run.qualityReport.faceSafety.status },
      finalOperations: 0, finalDetails: 0, finalAttempts: 0, additionalCatalogRecords: 0,
      additionalArtifacts: 0, additionalOutboxEvents: 0 }
    assert.equal((await client.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: identity.qualitySnapshotId } })).contentJson, qualityJson)
    assert.equal(reviewSeal(await client.v2ProxyReview.findUniqueOrThrow({ where: { id: review.id } })), sealedReview)
    const rejectedAgain = await fetch(`${baseUrl}/v1/projects/${principal.projectId}/exports`, { method: 'POST',
      headers: { authorization, 'content-type': 'application/json', 'idempotency-key': `runtime-public-final-after-${suffix}` },
      body: JSON.stringify(principal.exportBody), signal: AbortSignal.timeout(30000) })
    const rejectedAgainBody = await rejectedAgain.json()
    assert.equal(rejectedAgain.status, 422, JSON.stringify(rejectedAgainBody))
    assert.equal(rejectedAgainBody.error.code, 'EDITORIAL_ACCEPTANCE_FAILED')
    assert.deepEqual(await effects(), effectsBefore)
    assert.deepEqual(await client.v2Project.findUniqueOrThrow({ where: { id: projectId } }), projectBefore)
    assert.deepEqual(await client.v2DirectorRun.findUniqueOrThrow({ where: { id: identity.directorRunId } }), runBefore)
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: principal.projectId } })).status, LISTED_PROJECT_STATUS)
    assert.equal(await client.v2PublicOperation.count({ where: { workspaceId, projectId: principal.projectId, type: 'project-final-export' } }), 0)
    assert.equal(await client.v2ProjectFinalExportOperation.count({ where: { workspaceId, projectId: principal.projectId } }), 0)
    assert.equal(await client.v2ProjectFinalExportAttempt.count({ where: { workspaceId, operation: { projectId: principal.projectId } } }), 0)
    assert.equal((await client.v2ProjectSnapshot.findUniqueOrThrow({ where: { id: principal.qualityId } })).contentJson, principal.qualityJson)
    assert.equal(reviewSeal(await client.v2ProxyReview.findUniqueOrThrow({ where: { id: principal.reviewId } })), principal.reviewSeal)
    evidence.publicFinalAdmissionAfterRejectedClaim = { status: 422, code: rejectedAgainBody.error.code,
      projectId: principal.projectId, projectStatus: LISTED_PROJECT_STATUS, finalOperationsForMain: 0,
      additionalOperations: 0, additionalArtifacts: 0, storedQualityStatus: 'review-required', faceSafety: 'unknown' }
    }
    for (const operationId of [proxyId]) {
      const operation = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })
      const outputId = JSON.parse(operation.resultJson).resource.id
      const artifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: outputId } })
      const path = join(artifactRoot, ...artifact.artifactKey.split('/')); const bytes = await readFile(path)
      assert.equal(sha256(bytes), artifact.sha256); assert.equal(BigInt(bytes.length), artifact.byteSize)
      await exec(ffmpeg, ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], { windowsHide: true, timeout: 60000 })
      const probe = await probeVideo(path); const name = `${operation.type}.mp4`; await copyFile(path, join(directory, name))
      await exec(ffmpeg, ['-v', 'error', '-y', '-ss', '1', '-i', path, '-frames:v', '1', join(directory, `${operation.type}-frame.png`)], { windowsHide: true, timeout: 30000 })
      evidence.outputs.push({ operationId, projectId: operation.projectId, artifactId: artifact.id,
        proofScope: 'main-project-runtime-proxy',
        sha256: artifact.sha256, byteSize: bytes.length, name, probe, fullDecode: true })
    }
    activeObserver = null
    // A copy of a project with content is a Creation fork. It takes the configuration Commands (they commit and render nothing) but
    // has no authority to render until an editorial cut binds the fork's observations to it; every render is refused with the reason.
    const colorBodyFor = (artifactId, manifestId) => ({
      sourceArtifactId: artifactId, sourceManifestId: manifestId,
      outputMetadata: principalCompilation.pipeline.outputMetadata,
      stages: principalCompilation.pipeline.stages.map(({ id, kind, version, enabled, output, implementation, lut }) =>
        ({ id, kind, version, enabled, output, implementation, ...(lut ? { lut } : {}) })),
    })
    const proxyRenderOperations = async (id) => ({
      public: await client.v2PublicOperation.count({ where: { workspaceId, projectId: id, type: 'project-proxy-render' } }),
      details: await client.v2ProjectProxyRenderOperation.count({ where: { workspaceId, projectId: id } }),
    })
    const refuseCopyRender = async (stageName, copyProjectId, key) => {
      const refused = await postEnvelope(`/v1/projects/${copyProjectId}/proxy-renders`, undefined, key, 428)
      assert.equal(refused.error.code, 'PRECONDITION_REQUIRED')
      assert.deepEqual(refused.error.details, { reason: 'copy-requires-editorial-cut' })
      assert.deepEqual(await proxyRenderOperations(copyProjectId), { public: 0, details: 0 }, `${stageName}: the refusal left no render operation behind`)
      assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: copyProjectId } })).status, 'draft')
      evidence.states.push({ stage: stageName, projectId: copyProjectId, status: 'draft', httpStatus: 428, errorCode: refused.error.code,
        reason: refused.error.details.reason, proxyRenderOperations: 0, origin: 'public-api+postgres' })
    }
    const configureCopy = async (label, copyProjectId, copyVersion, colorBody, keys) => {
      assert.deepEqual(parseCreateColorPipelineCompilationBody(colorBody), colorBody)
      await refuseCopyRender(`${label}-render-refused`, copyProjectId, keys.refusal)
      await post(`/v1/projects/${copyProjectId}/color-pipeline-compilations`, colorBody, keys.color, 201)
      const configured = await post(`/v1/projects/${copyProjectId}/lut-selection`, {
        baseVersionId: copyVersion.id, baseHash: copyVersion.baseHash, selection: { mode: 'none' },
        reason: 'Configuration of a copy before its editorial cut.',
      }, keys.lut, 201)
      assert.equal(configured.version.sequence, 2)
      assert.equal(configured.version.parentVersionId, copyVersion.id)
      assert.equal(Object.hasOwn(configured, 'operation'), false, 'A copy without an editorial cut answers the LUT selection without a render operation')
      assert.deepEqual(await proxyRenderOperations(copyProjectId), { public: 0, details: 0 }, `${label}: configuring the copy enqueued no render`)
      const configuredRow = await client.v2Project.findUniqueOrThrow({ where: { id: copyProjectId } })
      assert.equal(configuredRow.status, 'draft'); assert.equal(configuredRow.currentVersionId, configured.version.id)
      evidence.states.push({ stage: `${label}-configured`, projectId: copyProjectId, status: configuredRow.status, versionId: configured.version.id,
        versionSequence: configured.version.sequence, operation: null, proxyRenderOperations: 0, origin: 'public-api+postgres' })
      // Configured is still a copy: the render stays refused for the same reason.
      await refuseCopyRender(`${label}-render-refused-after-configuration`, copyProjectId, keys.refusalAfter)
      return configured
    }

    // 1. The copy of the MAIN project: its plan came from the Director, so it can be configured but never cut or rendered.
    const copyConfigured = await configureCopy('copy', copy.project.id, copy.version, colorBodyFor(sourceArtifactId, sourceManifestId), {
      refusal: `runtime-copy-render-refused-${suffix}`, color: `runtime-copy-color-${suffix}`, lut: `runtime-copy-lut-${suffix}`,
      refusalAfter: `runtime-copy-render-refused-after-${suffix}` })
    assert.equal(copyConfigured.version.parentVersionId, copy.version.id)

    // 2. The honest path: an ingest-compiled project (no Director) is copied, configured, and then cut. The cut gives the copy its authority.
    const editorial = await seedDashboardControlledExportFixture({ client, workspaceId, actor, artifactRoot, suffix: `${suffix}-edit`,
      sourceArtifactId, sourceManifestId, sourcePath, sourceManifest, signal, ...mechanicalSeed,
      editorialSource: true, projectName: 'Runtime editorial source' })
    evidence.editorialSourceFixture = editorial.receipt
    const editorialCopy = await post(`/v1/projects/${editorial.projectId}/duplicates`, { expectedVersionId: editorial.projectVersionId,
      expectedVersionHash: editorial.projectVersionHash, name: 'Runtime editorial copy' }, `runtime-edit-copy-${suffix}`, 201)
    assert.equal(editorialCopy.project.duplicatedFromProjectId, editorial.projectId)
    assert.equal(editorialCopy.version.sequence, 1)
    await pipeline.observe({ stage: 'edit-copy', projectId: editorialCopy.project.id, expectedEventTypes: ['project.created'], expectedState: 'draft' })
    const editorialConfigured = await configureCopy('edit-copy', editorialCopy.project.id, editorialCopy.version,
      colorBodyFor(editorial.sourceArtifactId, editorial.sourceManifestId), {
        refusal: `runtime-edit-render-refused-${suffix}`, color: `runtime-edit-color-${suffix}`, lut: `runtime-edit-lut-${suffix}`,
        refusalAfter: `runtime-edit-render-refused-after-${suffix}` })
    const editorialStates = await client.v2ProjectOutputState.findMany({
      where: { workspaceId, projectId: editorialCopy.project.id, resultVersionId: editorialCopy.version.id }, include: { entries: true } })
    assert.equal(editorialStates.length, 1); assert.equal(editorialStates[0].entries.length, 1)
    const cutVariantId = editorialStates[0].entries[0].variantId
    assert.notEqual(cutVariantId, editorial.variantId, 'The copy has its own stable variant identity')
    const cut = await post(`/v1/projects/${editorialCopy.project.id}/commands`, { type: 'remove-spoken-content',
      baseVersionId: editorialConfigured.version.id, baseHash: editorialConfigured.version.baseHash,
      sourceTranscriptId: editorial.transcriptId, variantId: cutVariantId,
      rules: [{ id: 'ao', label: 'ao', alternatives: ['ao'] }], reason: 'Editorial cut of a configured copy.' }, `runtime-edit-cut-${suffix}`, 201)
    assert.equal(cut.command.type, 'remove-spoken-content')
    assert.equal(cut.command.baseVersionId, editorialConfigured.version.id)
    assert.equal(cut.version.sequence, 3); assert.equal(cut.version.parentVersionId, editorialConfigured.version.id)
    assert.equal(cut.editorial.sourceTranscriptId, editorial.transcriptId)
    assert.deepEqual(cut.editorial.exclusions.map((range) => range.ruleIds), [['ao']])
    assert.equal(cut.editorial.retainedSourceRanges.length, 2)
    assert.equal(cut.operation.status, 'queued', 'The cut admits the render the copy could not have before it')
    const cutOperation = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: cut.operation.id } })
    assert.equal(cutOperation.type, 'project-proxy-render'); assert.equal(cutOperation.projectId, editorialCopy.project.id)
    assert.equal(cutOperation.status, 'queued')
    assert.equal((await client.v2ProjectProxyRenderOperation.findUniqueOrThrow({ where: { operationId: cut.operation.id } })).projectVersionId, cut.version.id)
    const cutProject = await client.v2Project.findUniqueOrThrow({ where: { id: editorialCopy.project.id } })
    assert.equal(cutProject.currentVersionId, cut.version.id); assert.equal(cutProject.status, 'rendering-proxy')
    // The source project is not touched by what happens to its copy.
    const editorialSourceRow = await client.v2Project.findUniqueOrThrow({ where: { id: editorial.projectId } })
    assert.equal(editorialSourceRow.currentVersionId, editorial.projectVersionId)
    evidence.states.push({ stage: 'edit-cut-queued', projectId: editorialCopy.project.id, status: cutProject.status, operationId: cut.operation.id,
      versionId: cut.version.id, versionSequence: cut.version.sequence, retainedSourceRanges: cut.editorial.retainedSourceRanges,
      exclusionRuleIds: cut.editorial.exclusions.map((range) => range.ruleIds), origin: 'public-api+postgres' })
    const cutWorker = await proxyWorker(`runtime-edit-cut-worker-${suffix}`, { workspaceId, operationId: cut.operation.id, signal })
    const cutRow = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: cut.operation.id },
      select: { status: true, phase: true, attempt: true, errorCode: true, errorMessage: true } })
    assert.deepEqual(cutWorker, { operationId: cut.operation.id, status: 'succeeded' },
      JSON.stringify({ ...cutRow, errorMessage: cutRow.errorMessage?.slice(0, 800) ?? null }))
    const cutReview = await client.v2ProxyReview.findUniqueOrThrow({ where: { operationId: cut.operation.id } })
    assert.equal(cutReview.projectId, editorialCopy.project.id); assert.equal(cutReview.projectVersionId, cut.version.id)
    // The product rule (proxy-review-repository): a blocked review sends the project to revising; any other review waits for the
    // operator in reviewing-proxy. The cut copy has no Director quality report, so which one it gets is read, not assumed.
    const cutStatus = cutReview.status === 'blocked' ? 'revising' : 'reviewing-proxy'
    await observe({ stage: 'edit-cut-review', id: editorialCopy.project.id, status: cutStatus, operationId: cut.operation.id,
      phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    evidence.editorialCut = { sourceProjectId: editorial.projectId, copyProjectId: editorialCopy.project.id, cutVersionId: cut.version.id,
      operationId: cut.operation.id, reviewId: cutReview.id, reviewStatus: cutReview.status, finalAllowed: cutReview.finalAllowed,
      warningsAcknowledged: cutReview.warningsAcknowledged,
      technicalIssueCodes: JSON.parse(cutReview.technicalIssuesJson).map((issue) => issue.code),
      criticIssueCodes: JSON.parse(cutReview.criticIssuesJson).map((issue) => issue.code),
      projectStatus: cutStatus, origin: 'public-api+postgres+factory-worker' }
    const cutArtifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: cutReview.proxyArtifactId } })
    const cutAnnotation = await post(`/v1/projects/${editorialCopy.project.id}/annotations`, {
      projectVersionId: cut.version.id, proxyArtifactId: cutArtifact.id, proxyHash: cutArtifact.sha256,
      frame: 0, timeRangeMs: [0, 100], scope: 'point', targetIds: [],
      screenshotRef: await annotationScreenshot(cutArtifact, 'annotation-edit-cut-frame-0'), text: 'Conferir o corte editorial da cópia.',
    }, `runtime-edit-annotation-${suffix}`, 201)
    await pipeline.observe({ stage: 'edit-cut-annotation', projectId: editorialCopy.project.id, annotationId: cutAnnotation.annotation.id,
      expectedEventTypes: ['annotation.created'], expectedState: cutStatus })

    // 3. The failure/recovery/patch/stale-version proof needs a project that takes patches and renders: an isolated Director project.
    const iso = await seedDashboardControlledExportFixture({ client, workspaceId, actor, artifactRoot, suffix: `${suffix}-iso`,
      sourceArtifactId, sourceManifestId, sourcePath, sourceManifest, proxyArtifact, proxyManifestId: review.proxyManifestId,
      signal, ...mechanicalSeed, projectName: 'Runtime isolated failure',
      compileColorPipeline: ({ projectId: seedProjectId, sourceArtifactId: seedArtifactId, sourceManifestId: seedManifestId }) =>
        post(`/v1/projects/${seedProjectId}/color-pipeline-compilations`, colorBodyFor(seedArtifactId, seedManifestId), `runtime-iso-color-${suffix}`, 201),
    })
    const isoId = iso.projectId
    assert.notEqual(isoId, projectId); assert.notEqual(isoId, mechanical.projectId)
    evidence.isolatedFixture = iso.receipt
    const selected = await post(`/v1/projects/${isoId}/lut-selection`, {
      baseVersionId: iso.projectVersionId, baseHash: iso.projectVersionHash, selection: { mode: 'none' },
      reason: 'Controlled neutral rendering for independent runtime fence proof.',
    }, `runtime-iso-lut-${suffix}`, 201)
    const failedProxy = selected
    assert.equal(failedProxy.operation.status, 'queued', 'LUT selection admits a physical render for the new version')
    const duplicateProxy = await fetch(`${baseUrl}/v1/projects/${isoId}/proxy-renders`, { method: 'POST',
      headers: { authorization, 'idempotency-key': `runtime-duplicate-input-${suffix}` }, signal: AbortSignal.timeout(30000) })
    const duplicateBody = await duplicateProxy.json()
    assert.equal(duplicateProxy.status, 409); assert.equal(duplicateBody.error.code, 'PERSISTENCE_CONFLICT')
    assert.equal(await client.v2ProjectProxyRenderOperation.count({ where: { workspaceId, projectVersionId: selected.version.id } }), 1)
    assert.equal((await client.v2PublicOperation.findUniqueOrThrow({ where: { id: selected.operation.id } })).status, 'queued')
    evidence.duplicateAdmission = { status: duplicateProxy.status, errorCode: duplicateBody.error.code,
      projectVersionId: selected.version.id, unchangedOperationId: selected.operation.id }
    const hidden = `${iso.sourcePath}.owned-unavailable`
    await rename(iso.sourcePath, hidden)
    try {
      const outcome = await proxyWorker(`runtime-failure-worker-${suffix}`, { workspaceId, operationId: failedProxy.operation.id, signal })
      assert.equal(outcome.operationId, failedProxy.operation.id)
      assert.equal(outcome.status, 'failed')
    } finally { await rename(hidden, iso.sourcePath) }
    const failedRow = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: failedProxy.operation.id } })
    assert.equal(failedRow.status, 'failed')
    assert.equal(failedRow.attempt, 1)
    assert.equal(failedRow.errorCode, 'persistence_conflict')
    assert.equal(failedRow.errorRetryable, false)
    evidence.workerFailure = { operationId: failedRow.id, attempt: failedRow.attempt, code: failedRow.errorCode,
      retryable: failedRow.errorRetryable, origin: 'production-source-materializer' }
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: isoId } })).status, 'failed')
    await observe({ stage: 'worker-failed', id: isoId, status: 'failed', operationId: failedRow.id, phase: 'failed', completed: failedRow.progressCompleted, eventTypes: ['operation.status.changed'] })
    await post(`/v1/operations/${failedRow.id}/retry`, undefined, `runtime-worker-retry-${suffix}`, 200)
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: isoId } })).status, 'rendering-proxy')
    await delay(1100)
    assert.deepEqual(await proxyWorker(`runtime-recovered-worker-${suffix}`, { workspaceId, operationId: failedRow.id, signal }), { operationId: failedRow.id, status: 'succeeded' })
    await observe({ stage: 'isolated-review', id: isoId, status: LISTED_PROJECT_STATUS, operationId: failedRow.id, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    const isolatedReview = await client.v2ProxyReview.findUniqueOrThrow({ where: { operationId: failedRow.id } })
    assertListedReview(isolatedReview, 'isolated proxy review', { requiredWarnings: ['FACE_PIXEL_CHECK_UNAVAILABLE'] })
    const isolatedArtifact = await client.v2MediaArtifact.findUniqueOrThrow({ where: { id: isolatedReview.proxyArtifactId } })
    const isolatedAnnotation = await post(`/v1/projects/${isoId}/annotations`, {
      projectVersionId: selected.version.id, proxyArtifactId: isolatedArtifact.id, proxyHash: isolatedArtifact.sha256,
      frame: 0, timeRangeMs: [0, 100], scope: 'point', targetIds: [],
      screenshotRef: await annotationScreenshot(isolatedArtifact, 'annotation-isolated-frame-0'), text: 'Ajustar enquadramento central.',
    }, `runtime-iso-annotation-${suffix}`, 201)
    await pipeline.observe({ stage: 'isolated-annotation', projectId: isoId, annotationId: isolatedAnnotation.annotation.id,
      expectedEventTypes: ['annotation.created'], expectedState: LISTED_PROJECT_STATUS })
    const proposal =await post(`/v1/projects/${isoId}/patch-proposals`, { annotationId: isolatedAnnotation.annotation.id }, `runtime-proposal-${suffix}`, 201)
    assert.equal(proposal.proposal.status, 'ready')
    const applied = await post(`/v1/projects/${isoId}/patch-proposals/${proposal.proposal.id}/apply`, { confirmed: true }, `runtime-patch-${suffix}`, 201)
    assert.equal((await client.v2ReviewAnnotation.findUniqueOrThrow({ where: { id: isolatedAnnotation.annotation.id } })).status, 'applied')
    await pipeline.observe({ stage: 'annotation-resolved', projectId: isoId, annotationId: isolatedAnnotation.annotation.id,
      expectedEventTypes: ['annotation.resolved'], expectedState: 'rendering-proxy' })
    assert.deepEqual(await proxyWorker(`runtime-patch-worker-${suffix}`, { workspaceId, operationId: applied.operation.id, signal }), { operationId: applied.operation.id, status: 'succeeded' })
    const patchedReview = await client.v2ProxyReview.findUniqueOrThrow({ where: { operationId: applied.operation.id } })
    assertListedReview(patchedReview, 'patched proxy review', { requiredWarnings: ['FACE_PIXEL_CHECK_UNAVAILABLE'] })
    await observe({ stage: 'patched-review', id: isoId, status: LISTED_PROJECT_STATUS, operationId: applied.operation.id, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    // Exhaust actual durable claims without any status seed or mutation. Each
    // abandoned claim owns a short lease; the next runtime claim settles it.
    const abandoned = await post(`/v1/projects/${isoId}/lut-selection`, {
      baseVersionId: applied.version.id, baseHash: applied.version.baseHash, selection: { mode: 'none' },
      reason: 'Admit a new immutable version for expired lease recovery proof.',
    }, `runtime-abandoned-${suffix}`, 201)
    assert.equal(abandoned.operation.status, 'queued')
    assert.notEqual(abandoned.version.id, applied.version.id)
    const repository = new PrismaPublicOperationRepository(client)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const now = new Date()
      const claim = await repository.claimNext({ type: 'project-proxy-render', workspaceId, operationId: abandoned.operation.id,
        leaseOwner: `abandoned-owned-${suffix}-${attempt}`, now: now.toISOString(), leaseUntil: new Date(now.getTime() + 50).toISOString() })
      assert.equal(claim.lease.attempt, attempt); await delay(70)
    }
    const afterLease = new Date()
    assert.equal(await repository.claimNext({ type: 'project-proxy-render', workspaceId, operationId: abandoned.operation.id,
      leaseOwner: `exhaustion-observer-${suffix}`, now: afterLease.toISOString(), leaseUntil: new Date(afterLease.getTime() + 120000).toISOString() }), null)
    const exhausted = await client.v2PublicOperation.findUniqueOrThrow({ where: { id: abandoned.operation.id } })
    assert.equal(exhausted.errorCode, 'worker_lease_expired')
    await observe({ stage: 'failed', id: isoId, status: 'failed', operationId: exhausted.id, phase: 'failed', completed: exhausted.progressCompleted, eventTypes: ['operation.status.changed'] })
    await post(`/v1/operations/${exhausted.id}/retry`, undefined, `runtime-retry-${suffix}`, 200)
    assert.equal((await client.v2Project.findUniqueOrThrow({ where: { id: isoId } })).status, 'rendering-proxy')
    await delay(1100)
    assert.deepEqual(await proxyWorker(`runtime-retry-worker-${suffix}`, { workspaceId, operationId: exhausted.id, signal }), { operationId: exhausted.id, status: 'succeeded' })
    const retriedReview = await client.v2ProxyReview.findUniqueOrThrow({ where: { operationId: exhausted.id } })
    assertListedReview(retriedReview, 'retried proxy review', { requiredWarnings: ['FACE_PIXEL_CHECK_UNAVAILABLE'] })
    await observe({ stage: 'retried-review', id: isoId, status: LISTED_PROJECT_STATUS, operationId: exhausted.id, phase: 'completed', completed: 4, eventTypes: ['operation.status.changed'] })
    // Advance the version through the real Command service while an older
    // admitted task still owns a lease. No newer admission masks this CAS test.
    const staleVersionJob = await post(`/v1/projects/${isoId}/lut-selection`, {
      baseVersionId: abandoned.version.id, baseHash: abandoned.version.baseHash, selection: { mode: 'none' },
      reason: 'Admit a physical render before an independently committed newer Command.',
    }, `runtime-stale-version-${suffix}`, 201)
    assert.equal(staleVersionJob.operation.status, 'queued')
    assert.notEqual(staleVersionJob.version.id, abandoned.version.id)
    const claimAt = new Date()
    const staleClaim = await repository.claimNext({ type: 'project-proxy-render', workspaceId, operationId: staleVersionJob.operation.id,
      leaseOwner: `version-fence-worker-${suffix}`, now: claimAt.toISOString(), leaseUntil: new Date(claimAt.getTime() + 120000).toISOString() })
    const versionBeforeEdit = await client.v2ProjectVersion.findUniqueOrThrow({ where: { id: staleVersionJob.version.id } })
    const changed = await setProjectLutSelectionService({ repository: new PrismaProjectLutSelectionRepository(client),
      createId: (kind) => `runtime-version-${kind}-${randomUUID()}`, createEventId: randomUUID })({
      workspaceId, projectId: isoId, baseVersionId: versionBeforeEdit.id, baseHash: versionBeforeEdit.baseHash,
      selection: { mode: 'none' }, actor: { type: 'system', id: 'controlled-version-fence-command' },
      idempotencyKey: `runtime-version-edit-${suffix}`, reason: 'Verify an older task cannot change the current version status.' })
    assert.notEqual(changed.version.id, staleClaim.context.projectVersionId)
    await repository.failOrRetry({ operationId: staleClaim.operation.id, leaseOwner: staleClaim.lease.owner, attempt: staleClaim.lease.attempt,
      now: new Date().toISOString(), error: { code: 'controlled_version_changed', message: 'Original version superseded by a real Command', retryable: false } })
    const afterVersionFailure = await client.v2Project.findUniqueOrThrow({ where: { id: isoId } })
    assert.equal(afterVersionFailure.currentVersionId, changed.version.id)
    assert.equal(afterVersionFailure.status, 'rendering-proxy', 'older version failure does not change current project status')
    const versionRetryResponse = await fetch(`${baseUrl}/v1/operations/${staleClaim.operation.id}/retry`, { method: 'POST', headers: { authorization }, signal: AbortSignal.timeout(30000) })
    assert.equal(versionRetryResponse.status, 409)
    evidence.states.push({ stage: 'current-version-cas-rejected', projectId: isoId, operationId: staleClaim.operation.id,
      currentVersionId: changed.version.id, operationVersionId: staleClaim.context.projectVersionId,
      status: afterVersionFailure.status, origin: 'real-command-service+fenced-repository' })
    await drainBrowserResponses()
    assert.deepEqual(evidence.browserErrors, [], 'No page errors, HTTP errors or unexplained browser conflicts are accepted')
    evidence.pipeline = await pipeline.finish(); evidence.outcome = 'passed'
  } catch (error) { primaryError = error; evidence.outcome = 'failed'; evidence.failure = { name: error.name, message: error.message }; throw error }
  finally {
    prototype.claimNext = originals.claimNext; prototype.advancePhase = originals.advancePhase
    let postflightError
    const cdpCleanupDeadline = performance.now() + 10000
    // Restore first, before closure or a pending transport consumes the finite
    // cleanup budget. Failed restoration cannot forgive a transport failure.
    if (cancelEnabled) {
      try { await collectCancelDiagnostics(undefined, cdpCleanupDeadline, true) }
      catch (error) { postflightError ??= error }
    }
    try { await drainBrowserResponses(cancelEnabled ? { deadline: cdpCleanupDeadline } : undefined) }
    catch (error) { evidence.browserEvidencePostflightError = safeError(error); postflightError ??= error }
    if (!primaryError && evidence.browserErrors.length) {
      postflightError ??= new Error('Browser error ledger is nonempty at postflight')
      evidence.outcome = 'failed'
    }
    try { evidence.postflight = await closeOwnedBrowser({ context, browser, server, child }); assert.equal(process.platform === 'linux' ? evidence.postflight.localBrowserLifecycleTerminal : evidence.postflight.browserTerminal, true) }
    catch (error) { evidence.postflight.cleanupError = safeError(error); postflightError ??= error }
    // Keep lifecycle and error observers active through closure. An unfinished
    // request or a late body failure cannot become terminal by closing a page.
    try { await drainBrowserResponses({ label: 'after-browser-close' }) }
    catch (error) { evidence.browserEvidenceAfterCloseError = safeError(error); postflightError ??= error }
    for (const { opened, handlers } of browserResponseListeners) {
      for (const [event, listener] of Object.entries(handlers)) opened.off(event, listener)
    }
    try { correlateCdp() }
    catch (error) { evidence.cdp.correlationError = safeError(error); postflightError ??= error }
    if (cancelEnabled) {
      try { correlateCancelDiagnostics() }
      catch (error) {
        evidence.cancelDiagnostics.correlationError = safeError(error); postflightError ??= error
      }
    }
    for (const owned of cdpSessions) {
      try {
        if (!owned.page.closedObserved) {
          const remaining = cdpCleanupDeadline - performance.now()
          assert.ok(remaining > 0, 'Passive CDP cleanup deadline exhausted')
          await bounded(owned.session.detach(), remaining)
          assert.equal(owned.page.closedObserved, true, 'CDP session close must be observed')
        }
      } catch (error) { owned.page.cleanupError = safeError(error); postflightError ??= error }
      finally { for (const [event, listener] of owned.handlers) owned.session.off(event, listener) }
    }
    if (process.env.APOLLO_DASHBOARD_CFT157_LINUX_ROOT && evidence.cft157) {
      try {
        const post = await admitDashboardLinuxCft()
        assert.equal(post.evidence.inventorySha256, evidence.cft157.inventorySha256)
        assert.deepEqual(post.evidence.executable, evidence.cft157.executable)
        evidence.cft157.postInventoryAuthenticated = true
      } catch (error) { evidence.cft157.postAuthenticationError = safeError(error); postflightError ??= error }
    }
    // pageerror/console observers remain active through close. A late error must
    // turn the persisted outcome into FAIL while preserving an earlier failure.
    if (evidence.browserErrors.length) postflightError ??= new Error('Browser error ledger is nonempty after browser close')
    if (postflightError) evidence.outcome = 'failed'
    evidence.ownedServerAtHelperPostflight = observeOwnedServer()
    if (httpDiagnosticsEnabled) evidence.httpConnections = observeHttpConnections()
    try { await writeFile(join(directory, 'w35-runtime.json'), JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)) }
    catch (error) { postflightError ??= error }
    if (!primaryError && postflightError) throw postflightError
  }
}
