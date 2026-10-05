import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

import { calculateVersionHash } from '../../../src/v2/application/version-hash.ts'
import { calculateCanonicalHash, stableSerialize } from '../../../src/v2/domain/canonical-hash.ts'
import {
  apiCall, assertRefusal, cardIds, cardSnapshot, createProjectViaApi, dashboardUrl,
  listPathMatches, plain, projectOracle, projectRowSummary, pushCase, recordApplicationName,
  runWaveProof, sanitizedRequest, screenshot, sha256, trackBrowserTraffic, waitForCardName,
  waitForCardSet, waitForSettled,
} from './dashboard-w37-39-shared.mjs'

const run = promisify(execFile)
const ROOT_PREFIX = 'apollo-w39-artifacts-'

/** Creates the artifact root the journey server is started with (local driver). */
export async function createW39ArtifactRoot() {
  const root = join(tmpdir(), `${ROOT_PREFIX}${randomUUID()}`)
  await mkdir(root, { recursive: true })
  return root
}

async function inventory(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        const bytes = await readFile(path)
        const info = await stat(path)
        files.push({ key: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: sha256(bytes), mtimeMs: info.mtimeMs })
      }
    }
  }
  await walk(root)
  return files.toSorted((left, right) => left.key.localeCompare(right.key))
}

async function readContent(baseUrl, authorization, artifactId) {
  const response = await fetch(`${baseUrl}/v1/artifacts/${artifactId}/content`, { headers: { authorization } })
  const bytes = Buffer.from(await response.arrayBuffer())
  return { status: response.status, bytes, etag: response.headers.get('etag'), contentType: response.headers.get('content-type'), text: response.status === 200 ? '' : bytes.toString('utf8') }
}

/**
 * W39 — duplicate from the dashboard card, copy-on-write. A real raw master
 * (an MPEG-4 produced by the repository's ffmpeg binary, hashed here with
 * node:crypto before the app ever sees it) is stored in the isolated local
 * artifact root the journey server serves. Fixture prefix: w39-<run tag>.
 */
export async function proveW39DuplicateCopyOnWrite({
  baseUrl, client, workspaceId, apiClientId, authorization,
  readOnlyAuthorization, otherWorkspaceAuthorization,
  sessionCookieName, sessionCookieValue, username,
  artifactRoot, ffmpegPath, artifacts, createMediaArtifactManifest,
}) {
  const tag = randomUUID().slice(0, 8)
  const prefix = `w39-${tag}`
  const cookie = `${sessionCookieName}=${sessionCookieValue}`
  const root = resolve(artifactRoot)
  assert.ok(basename(root).startsWith(ROOT_PREFIX) && relative(resolve(tmpdir()), root) && !relative(resolve(tmpdir()), root).startsWith('..'), 'the W39 artifact root must be the temporary root created for this journey')
  const names = { source: `${prefix}-origem`, copy: `${prefix}-origem — cópia`, other: `${prefix}-outro-nome` }
  const artifactId = `${prefix}-master`
  const artifactKey = `w39/${tag}/master-original.mp4`
  const masterPath = join(root, ...artifactKey.split('/'))
  return runWaveProof({
    wave: 39, schemaVersion: 'w39-duplicate-copy-on-write/v1', baseUrl, sessionCookieName, sessionCookieValue,
    initial: { prefix },
    async execute({ evidence, evidenceDir, launch, newSessionPage }) {
      try {
        const session = await apiCall(baseUrl, { path: '/v1/session', cookie })
        assert.equal(session.status, 200, 'original human POST /v1/session cookie must remain active')
        assert.equal(session.json.data.workspaceId, workspaceId)
        assert.equal(session.json.data.subject, username)
        const memberId = session.json.data.memberId
        await recordApplicationName(client, evidence)

        // --- the raw master: real bytes, hashed before the application sees them ----
        await mkdir(join(root, 'w39', tag), { recursive: true })
        await run(ffmpegPath, [
          '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=160x120:rate=12',
          '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p', '-an',
          '-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1', masterPath,
        ])
        const masterBytes = await readFile(masterPath)
        const masterSha256 = sha256(masterBytes)
        assert.ok(masterBytes.length > 1000, 'the master fixture must be real media, not a stub')
        assert.equal(masterBytes.subarray(4, 8).toString('latin1'), 'ftyp', 'the fixture is an ISO base media file')
        const manifest = createMediaArtifactManifest({
          artifactKey, artifactSha256: masterSha256, byteSize: masterBytes.length, mediaType: 'video', container: 'mp4',
          recipe: { id: 'ingest-source', version: 'v1', parameters: {} },
          probe: { width: 160, height: 120, duration: 1, fps: 12 },
        })
        const created = await createProjectViaApi({ baseUrl, authorization, name: names.source, key: `${prefix}-create` })
        const sourceId = created.project.id
        await artifacts.persistOrReplay({
          workspaceId, artifactId, manifestId: `${prefix}-master-manifest`, lineageIds: [], manifest,
          createdAt: new Date().toISOString(),
        })
        const sourceAssetId = randomUUID()
        await client.v2ProjectMediaAsset.create({ data: {
          id: sourceAssetId, workspaceId, projectId: sourceId, artifactId, role: 'source-master', originalFileName: 'master-original.mp4',
        } })

        // --- before: bytes, identities, lineage, objects and references -------------
        const storageBefore = (await inventory(root)).filter((file) => file.key.startsWith(`w39/${tag}/`))
        assert.deepEqual(storageBefore.map((file) => [file.key, file.bytes, file.sha256]), [[artifactKey, masterBytes.length, masterSha256]])
        const served = await readContent(baseUrl, authorization, artifactId)
        assert.equal(served.status, 200, served.text)
        assert.equal(sha256(served.bytes), masterSha256, 'the product serves the exact fixture bytes')
        assert.equal(served.etag, `"sha256-${masterSha256}"`)
        const artifactRow = await client.v2MediaArtifact.findUnique({ where: { id: artifactId } })
        assert.equal(artifactRow.sha256, masterSha256)
        assert.equal(Number(artifactRow.byteSize), masterBytes.length)
        const workspaceArtifactsBefore = await client.v2MediaArtifact.count({ where: { workspaceId } })
        const workspaceProjectsBefore = await client.v2Project.count({ where: { workspaceId } })
        const refsBefore = await client.v2ProjectMediaAsset.findMany({ where: { workspaceId, artifactId }, orderBy: { projectId: 'asc' } })
        assert.deepEqual(refsBefore.map((row) => row.projectId), [sourceId])
        const manifestsBefore = await client.v2MediaArtifactManifest.count({ where: { artifactId } })
        const sourceBefore = await projectOracle(client, workspaceId, sourceId)
        assert.equal(sourceBefore.versions.length, 1)
        assert.equal(sourceBefore.project.currentVersionId, sourceBefore.versions[0].id)
        assert.equal(sourceBefore.editCommandCount, 0)
        assert.ok(sourceBefore.snapshots.length >= 3)
        const sourceVersion = sourceBefore.versions[0]
        evidence.before = {
          master: { artifactId, artifactKey, bytes: masterBytes.length, sha256: masterSha256, servedSha256: sha256(served.bytes) },
          storage: storageBefore.map(({ key, bytes, sha256: hash }) => ({ key, bytes, sha256: hash })),
          objectCounts: { workspaceMediaArtifacts: workspaceArtifactsBefore, manifests: manifestsBefore, projectReferences: refsBefore.length, storageObjects: storageBefore.length },
          source: {
            project: projectRowSummary(sourceBefore.project), versionId: sourceVersion.id, versionBaseHash: sourceVersion.baseHash,
            snapshots: sourceBefore.snapshots.map((row) => ({ id: row.id, kind: row.kind, contentHash: row.contentHash })),
          },
        }

        // --- browser: Duplicar on the card, follow the destination --------------------
        await launch()
        const { page } = await newSessionPage()
        const traffic = trackBrowserTraffic(page, baseUrl)
        const initialList = page.waitForResponse((response) => listPathMatches(response, prefix))
        await page.goto(dashboardUrl(baseUrl, prefix), { waitUntil: 'domcontentloaded' })
        const initialBody = await (await initialList).json()
        assert.deepEqual(initialBody.data.projects.map((item) => item.id), [sourceId])
        await waitForCardName(page, sourceId, names.source)
        await waitForSettled(page)
        assert.deepEqual(await cardIds(page), [sourceId])
        const sourceCardBefore = await cardSnapshot(page, sourceId)
        assert.equal(sourceCardBefore.enabledButtons.Duplicar, true)
        evidence.screenshots.push(await screenshot(page, evidenceDir, 'w39-desktop-source-before.png'))
        const duplicateResponse = page.waitForResponse((response) => response.url().endsWith(`/v1/projects/${sourceId}/duplicates`) && response.request().method() === 'POST')
        await page.locator(`article[data-project-id="${sourceId}"]`).getByRole('button', { name: 'Duplicar', exact: true }).click()
        const duplicated = await duplicateResponse
        assert.equal(duplicated.status(), 201)
        const duplicatedBody = await duplicated.json()
        const copyId = duplicatedBody.data.project.id
        const copyVersionId = duplicatedBody.data.version.id
        assert.notEqual(copyId, sourceId)
        assert.notEqual(copyVersionId, sourceVersion.id)
        await page.waitForURL(`**/projects/${copyId}`)
        await page.getByText(names.copy, { exact: true }).first().waitFor()
        const workspaceProof = async () => {
          const match = traffic.responses.find((item) => item.method === 'GET' && item.path === `/v1/projects/${copyId}/workspace` && item.status === 200)
          return match ? match.body : null
        }
        await page.waitForFunction(() => document.body.innerText.length > 0)
        let destinationWorkspace = null
        for (let attempt = 0; attempt < 100 && !destinationWorkspace; attempt += 1) {
          destinationWorkspace = await workspaceProof()
          if (!destinationWorkspace) await page.waitForTimeout(100)
        }
        assert.ok(destinationWorkspace, `the destination page read the copy workspace over HTTP; saw ${JSON.stringify(traffic.responses.filter((item) => item.path.includes('/workspace')).map((item) => [item.method, item.path, item.status]))}; url ${page.url()}`)
        assert.equal(destinationWorkspace.data.project.id, copyId)
        assert.equal(destinationWorkspace.data.project.name, names.copy)
        assert.equal(destinationWorkspace.data.version.id, copyVersionId)
        assert.deepEqual(destinationWorkspace.data.media.map((item) => [item.artifactId, item.role, item.sha256]), [[artifactId, 'source-master', masterSha256]], 'the destination shows the same immutable master')
        evidence.screenshots.push(await screenshot(page, evidenceDir, 'w39-desktop-destination-copy.png'))

        const duplicatePosts = traffic.mutating()
        assert.equal(duplicatePosts.length, 1, 'exactly one mutating request for the click')
        const posted = duplicatePosts[0]
        assert.equal(posted.path, `/v1/projects/${sourceId}/duplicates`)
        assert.deepEqual(Object.keys(JSON.parse(posted.postData)).toSorted(), ['expectedVersionHash', 'expectedVersionId', 'name'])
        assert.deepEqual(JSON.parse(posted.postData), { expectedVersionId: sourceVersion.id, expectedVersionHash: sourceVersion.baseHash, name: names.copy })
        assert.deepEqual(duplicatedBody.data.sharedArtifactIds, [artifactId])
        assert.equal(duplicatedBody.data.copiedBytes, 0)
        assert.equal(duplicatedBody.data.replayed, false)
        assert.equal(duplicatedBody.data.project.duplicatedFromProjectId, sourceId)
        assert.equal(duplicatedBody.data.project.name, names.copy)
        assert.equal(duplicatedBody.data.version.forkedFromProjectId, sourceId)
        assert.equal(duplicatedBody.data.version.forkedFromVersionId, sourceVersion.id)

        await page.setViewportSize({ width: 390, height: 844 })
        evidence.screenshots.push(await screenshot(page, evidenceDir, 'w39-mobile-destination-copy.png'))
        await page.setViewportSize({ width: 1440, height: 1000 })

        // --- after: new identities, equivalent editorial content, shared immutable master ---
        const sourceAfter = await projectOracle(client, workspaceId, sourceId)
        const copyAfter = await projectOracle(client, workspaceId, copyId)
        assert.deepEqual(sourceAfter.project, sourceBefore.project, 'the source project row is untouched')
        assert.deepEqual(sourceAfter.versions, sourceBefore.versions)
        assert.deepEqual(sourceAfter.snapshots, sourceBefore.snapshots)
        assert.deepEqual(sourceAfter.mediaAssets, sourceBefore.mediaAssets)
        assert.equal(sourceAfter.editCommandCount, 0)
        assert.equal(copyAfter.project.name, names.copy)
        assert.equal(copyAfter.project.status, 'draft')
        assert.equal(copyAfter.project.duplicatedFromProjectId, sourceId)
        assert.equal(copyAfter.project.currentVersionId, copyVersionId)
        assert.equal(copyAfter.project.administrationRevision, 1)
        assert.equal(copyAfter.project.archivedFromStatus, null)
        for (const key of ['objective', 'format', 'locale']) assert.equal(copyAfter.project[key], sourceBefore.project[key])
        assert.equal(copyAfter.versions.length, 1)
        const copyVersion = copyAfter.versions[0]
        assert.equal(copyVersion.id, copyVersionId)
        assert.equal(copyVersion.sequence, 1)
        assert.equal(copyVersion.parentVersionId, null)
        assert.equal(copyVersion.forkedFromProjectId, sourceId)
        assert.equal(copyVersion.forkedFromVersionId, sourceVersion.id)
        const sourceRefs = {
          brief: sourceVersion.briefSnapshotId,
          ...(sourceVersion.treatmentSnapshotId ? { treatment: sourceVersion.treatmentSnapshotId } : {}),
          ...(sourceVersion.storySnapshotId ? { story: sourceVersion.storySnapshotId } : {}),
          editPlan: sourceVersion.editPlanSnapshotId, policies: sourceVersion.policiesSnapshotId,
        }
        // Contract rule: the version hash binds project/version identity, so it MUST differ; the
        // snapshot content hashes are content-addressed, so they MUST be equal.
        assert.notEqual(copyVersion.baseHash, sourceVersion.baseHash, 'the copy version binds its own identity')
        assert.equal(copyVersion.baseHash, calculateVersionHash({
          projectId: copyId, sequence: 1, forkedFromProjectId: sourceId, forkedFromVersionId: sourceVersion.id, snapshotRefs: sourceRefs,
        }), 'baseHash follows the existing duplication contract formula')
        const referenced = new Set([sourceVersion.briefSnapshotId, sourceVersion.treatmentSnapshotId, sourceVersion.storySnapshotId, sourceVersion.editPlanSnapshotId, sourceVersion.policiesSnapshotId].filter(Boolean))
        const sourceSnapshots = sourceBefore.snapshots.filter((row) => referenced.has(row.id))
        assert.equal(copyAfter.snapshots.length, sourceSnapshots.length)
        const snapshotPairs = []
        for (const original of sourceSnapshots) {
          const copySnapshot = copyAfter.snapshots.find((row) => row.kind === original.kind)
          assert.ok(copySnapshot, `copy has a ${original.kind} snapshot`)
          assert.notEqual(copySnapshot.id, original.id, 'the snapshot row has its own identity')
          assert.equal(copySnapshot.projectId, copyId)
          assert.equal(copySnapshot.schemaVersion, original.schemaVersion)
          const parsedCopy = JSON.parse(copySnapshot.contentJson)
          assert.equal(copySnapshot.contentJson, stableSerialize(parsedCopy), 'stored content is canonical')
          assert.equal(copySnapshot.contentHash, calculateCanonicalHash(parsedCopy), 'the stored hash is the canonical hash of the stored content')
          if (original.kind === 'edit-plan') {
            // Version-bound: the copy's EditPlan names the copy version; its hash differs by contract.
            const parsedOriginal = JSON.parse(original.contentJson)
            assert.equal(parsedOriginal.projectVersionId, sourceVersion.id)
            assert.equal(parsedCopy.projectVersionId, copyVersionId)
            assert.equal(parsedCopy.id, `edit-plan-${copyVersionId}`)
            const { projectVersionId: _copyVersion, id: _copyId, ...copyContent } = parsedCopy
            const { projectVersionId: _sourceVersion, id: _sourceId, ...sourceContent } = parsedOriginal
            assert.deepEqual(copyContent, sourceContent, 'only the version binding of the EditPlan changes')
            assert.notEqual(copySnapshot.contentHash, original.contentHash)
          } else {
            assert.equal(copySnapshot.contentJson, original.contentJson, 'editorial content is byte-identical')
            assert.equal(copySnapshot.contentHash, original.contentHash, 'content-addressed snapshot hash is equal')
          }
          snapshotPairs.push({ kind: original.kind, sourceId: original.id, copyId: copySnapshot.id, contentHash: original.contentHash, copyContentHash: copySnapshot.contentHash, rebound: original.kind === 'edit-plan', equalContent: original.kind !== 'edit-plan' })
        }
        const copyRefs = {
          brief: copyVersion.briefSnapshotId, ...(copyVersion.treatmentSnapshotId ? { treatment: copyVersion.treatmentSnapshotId } : {}),
          ...(copyVersion.storySnapshotId ? { story: copyVersion.storySnapshotId } : {}),
          editPlan: copyVersion.editPlanSnapshotId, policies: copyVersion.policiesSnapshotId,
        }
        assert.ok(Object.values(copyRefs).every((id) => copyAfter.snapshots.some((row) => row.id === id)), 'the copy version references its own snapshots')
        assert.deepEqual(duplicatedBody.data.version.snapshotRefs, copyRefs)
        assert.equal(copyAfter.creationCommand.action, 'duplicate')
        assert.equal(copyAfter.creationCommand.sourceProjectId, sourceId)
        assert.equal(copyAfter.creationCommand.sourceVersionId, sourceVersion.id)
        assert.equal(copyAfter.creationCommand.versionId, copyVersionId)
        assert.equal(copyAfter.creationCommand.actorAuthenticationKind, 'ui-session')
        assert.equal(copyAfter.creationCommand.actorDelegatedUserId, memberId)
        assert.equal(copyAfter.creationCommand.actorClientId, apiClientId)

        // The shared reference, not a second copy of the master.
        const refsAfter = await client.v2ProjectMediaAsset.findMany({ where: { workspaceId, artifactId }, orderBy: { projectId: 'asc' } })
        assert.equal(refsAfter.length, 2)
        assert.deepEqual(new Set(refsAfter.map((row) => row.projectId)), new Set([sourceId, copyId]))
        assert.equal(new Set(refsAfter.map((row) => row.id)).size, 2, 'each project has its own reference row')
        assert.ok(refsAfter.every((row) => row.role === 'source-master' && row.originalFileName === 'master-original.mp4'))
        assert.equal(await client.v2MediaArtifact.count({ where: { workspaceId } }), workspaceArtifactsBefore, 'no media artifact was created in the workspace')
        assert.equal(await client.v2MediaArtifactManifest.count({ where: { artifactId } }), manifestsBefore)
        const artifactAfter = await client.v2MediaArtifact.findUnique({ where: { id: artifactId } })
        assert.deepEqual(plain(artifactAfter), plain(artifactRow), 'the immutable artifact row is unchanged')
        const storageAfter = (await inventory(root)).filter((file) => file.key.startsWith(`w39/${tag}/`))
        assert.deepEqual(storageAfter, storageBefore, 'no object was written, rewritten or copied (count, bytes, sha256 and mtime)')
        const servedAfter = await readContent(baseUrl, authorization, artifactId)
        assert.equal(sha256(servedAfter.bytes), masterSha256)
        assert.equal(await client.v2Project.count({ where: { workspaceId } }), workspaceProjectsBefore + 1)
        evidence.duplicate = {
          request: sanitizedRequest(posted), responseStatus: 201,
          copy: { projectId: copyId, versionId: copyVersionId, project: projectRowSummary(copyAfter.project) },
          lineage: { duplicatedFromProjectId: sourceId, forkedFromProjectId: copyVersion.forkedFromProjectId, forkedFromVersionId: copyVersion.forkedFromVersionId, parentVersionId: copyVersion.parentVersionId },
          versionHash: { source: sourceVersion.baseHash, copy: copyVersion.baseHash, differs: true, followsContractFormula: true },
          snapshots: snapshotPairs, sharedArtifactIds: duplicatedBody.data.sharedArtifactIds, copiedBytes: duplicatedBody.data.copiedBytes,
          objectCounts: { workspaceMediaArtifacts: workspaceArtifactsBefore, manifests: manifestsBefore, projectReferences: refsAfter.length, storageObjects: storageAfter.length },
          storage: storageAfter.map(({ key, bytes, sha256: hash }) => ({ key, bytes, sha256: hash })),
          servedSha256After: sha256(servedAfter.bytes), artifactRowUnchanged: true, sourceUnchanged: true,
          destination: { urlPath: `/projects/${copyId}`, workspaceStatus: 200, mediaArtifactIds: destinationWorkspace.data.media.map((item) => item.artifactId) },
        }

        // --- idempotent replay while the copy is still at its first version ----------------
        const route = `/v1/projects/${sourceId}/duplicates`
        const sessionCall = { method: 'POST', path: route, cookie, origin: true }
        const body = { expectedVersionId: sourceVersion.id, expectedVersionHash: sourceVersion.baseHash, name: names.copy }
        const replay = await apiCall(baseUrl, { ...sessionCall, headers: { 'idempotency-key': posted.idempotencyKey }, body })
        assert.equal(replay.status, 200, replay.text)
        assert.equal(replay.json.data.replayed, true)
        assert.equal(replay.json.data.project.id, copyId)
        assert.equal(replay.json.data.version.id, copyVersionId)
        assert.deepEqual(replay.json.data.sharedArtifactIds, [artifactId])
        assert.equal(replay.json.data.copiedBytes, 0)
        const scopeState = async () => ({
          projects: await client.v2Project.count({ where: { workspaceId } }),
          references: await client.v2ProjectMediaAsset.count({ where: { workspaceId, artifactId } }),
          artifacts: await client.v2MediaArtifact.count({ where: { workspaceId } }),
          creationCommands: await client.v2ProjectCreationCommand.count({ where: { workspaceId, sourceProjectId: { in: [sourceId, copyId] } } }),
          storage: (await inventory(root)).filter((file) => file.key.startsWith(`w39/${tag}/`)),
        })
        const afterReplayState = await scopeState()
        assert.equal(afterReplayState.projects, workspaceProjectsBefore + 1, 'replay created no second copy')
        assert.equal(afterReplayState.references, 2)
        assert.equal(afterReplayState.creationCommands, 1)
        pushCase(evidence, { id: 'idempotent-replay', expected: { status: 200, replayed: true, copies: 1 }, observed: { status: replay.status, replayed: true, sameProjectId: true, sameVersionId: true, copies: afterReplayState.projects - workspaceProjectsBefore } })

        // --- dashboard: both cards -------------------------------------------------------
        const listAgain = page.waitForResponse((response) => listPathMatches(response, prefix))
        await page.goto(dashboardUrl(baseUrl, prefix), { waitUntil: 'domcontentloaded' })
        const listAgainBody = await (await listAgain).json()
        assert.deepEqual(new Set(listAgainBody.data.projects.map((item) => item.id)), new Set([sourceId, copyId]))
        await waitForCardSet(page, [sourceId, copyId])
        await waitForSettled(page)
        assert.equal((await cardSnapshot(page, sourceId)).name, names.source)
        assert.equal((await cardSnapshot(page, copyId)).name, names.copy)
        evidence.screenshots.push(await screenshot(page, evidenceDir, 'w39-desktop-source-and-copy.png'))

        // --- mutate the copy by Command; the original must not move -----------------------
        // set-project-lut-selection re-reads the copied EditPlan and requires it to name the copy version.
        const mutate = await apiCall(baseUrl, {
          method: 'POST', path: `/v1/projects/${copyId}/lut-selection`, authorization,
          headers: { 'idempotency-key': `${prefix}-copy-lut-none` },
          body: { baseVersionId: copyVersionId, baseHash: copyVersion.baseHash, selection: { mode: 'none' } },
        })
        assert.equal(mutate.status, 201, mutate.text)
        const copySequenceAfter = 2
        assert.equal(mutate.json.data.version.sequence, copySequenceAfter)
        const copyMutated = await projectOracle(client, workspaceId, copyId)
        const sourceMutated = await projectOracle(client, workspaceId, sourceId)
        assert.equal(copyMutated.versions.length, copySequenceAfter)
        assert.equal(copyMutated.editCommandCount, 1)
        assert.equal(copyMutated.project.currentVersionId, mutate.json.data.version.id)
        assert.equal(copyMutated.versions.at(-1).parentVersionId, copyVersionId)
        assert.deepEqual(copyMutated.versions[0], copyAfter.versions[0], 'the copy first version is itself immutable')
        assert.deepEqual(sourceMutated.project, sourceBefore.project, 'original project row unchanged')
        assert.deepEqual(sourceMutated.versions, sourceBefore.versions, 'original versions and hashes unchanged')
        assert.deepEqual(sourceMutated.snapshots, sourceBefore.snapshots, 'original snapshots and content hashes unchanged')
        assert.deepEqual(sourceMutated.mediaAssets, sourceBefore.mediaAssets)
        assert.equal(sourceMutated.editCommandCount, 0)
        assert.deepEqual((await inventory(root)).filter((file) => file.key.startsWith(`w39/${tag}/`)), storageBefore, 'a Command on the copy never touches the master')
        const sourceWorkspace = await apiCall(baseUrl, { path: `/v1/projects/${sourceId}/workspace`, authorization })
        assert.equal(sourceWorkspace.status, 200)
        assert.equal(sourceWorkspace.json.data.version.id, sourceVersion.id)
        assert.equal(sourceWorkspace.json.data.version.baseHash, sourceVersion.baseHash)
        const reload = page.waitForResponse((response) => listPathMatches(response, prefix))
        await page.reload({ waitUntil: 'domcontentloaded' })
        await reload
        await waitForCardSet(page, [sourceId, copyId])
        await waitForSettled(page)
        const sourceCardAfter = await cardSnapshot(page, sourceId)
        const copyCardAfter = await cardSnapshot(page, copyId)
        assert.equal(sourceCardAfter.version, 'v1')
        assert.equal(copyCardAfter.version, `v${copySequenceAfter}`)
        evidence.screenshots.push(await screenshot(page, evidenceDir, 'w39-desktop-after-command.png'))
        await page.setViewportSize({ width: 390, height: 844 })
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
        evidence.browser.mobileOverflowPx = overflow
        assert.ok(overflow <= 1, `W39 mobile dashboard overflows by ${overflow}px`)
        evidence.screenshots.push(await screenshot(page, evidenceDir, 'w39-mobile-source-and-copy.png'))
        evidence.command = {
          type: 'set-project-lut-selection', copyVersionSequenceAfter: copySequenceAfter, copyEditCommands: copyMutated.editCommandCount,
          sourceVersionId: sourceVersion.id, sourceVersionBaseHashBefore: sourceVersion.baseHash, sourceVersionBaseHashAfter: sourceMutated.versions[0].baseHash,
          sourceSnapshotHashesUnchanged: true, sourceEditCommands: sourceMutated.editCommandCount, cards: { source: sourceCardAfter.version, copy: copyCardAfter.version },
        }
        evidence.browser.mutatingRequests = traffic.mutating().length
        evidence.browser.requests = traffic.mutating().map(sanitizedRequest)
        assert.equal(traffic.mutating().length, 1)

        // --- replay, stale base, injected payload, foreign workspace, scope, authentication --
        const replayAfter = await apiCall(baseUrl, { ...sessionCall, headers: { 'idempotency-key': posted.idempotencyKey }, body })
        const baseline = await scopeState()
        assert.equal(baseline.projects, workspaceProjectsBefore + 1, 'replay created no second copy')
        assert.equal(baseline.references, 2)
        assert.equal(baseline.creationCommands, 1)
        assert.equal(replayAfter.status, 200, replayAfter.text)
        assert.equal(replayAfter.json.data.replayed, true)
        assert.equal(replayAfter.json.data.project.id, copyId)
        assert.equal(replayAfter.json.data.version.id, copyVersionId)
        assert.equal(replayAfter.json.data.version.sequence, 1)
        assert.equal(replayAfter.json.data.project.name, names.copy)
        assert.equal(replayAfter.json.data.project.status, 'draft')
        assert.deepEqual(replayAfter.json.data.sharedArtifactIds, [artifactId])
        assert.equal(replayAfter.json.data.copiedBytes, 0)
        assert.equal(replayAfter.json.data.version.baseHash, copyVersion.baseHash)
        pushCase(evidence, {
          id: 'idempotent-replay-after-copy-command', expected: { status: 200, replayed: true, sameProjectId: true, sameVersionId: true },
          observed: { status: replayAfter.status, replayed: true, sameProjectId: true, sameVersionId: true, versionSequence: 1, copyCurrentSequence: copySequenceAfter, copies: baseline.projects - workspaceProjectsBefore },
        })
        const refusal = async (id, request, expect, call) => {
          const result = await apiCall(baseUrl, { method: 'POST', path: route, ...call })
          const observed = assertRefusal(result, expect)
          assert.deepEqual(await scopeState(), baseline, `${id} must change nothing`)
          pushCase(evidence, { id, request, expected: expect, observed, persistedUnchanged: true })
        }
        await refusal('idempotency-payload-mismatch', { method: 'POST', path: '/v1/projects/{projectId}/duplicates', auth: 'session same key, other name' },
          { status: 409, code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' },
          { ...sessionCall, headers: { 'idempotency-key': posted.idempotencyKey }, body: { ...body, name: names.other } })
        await refusal('stale-version-hash', { method: 'POST', path: '/v1/projects/{projectId}/duplicates', auth: 'bearer projects:write' },
          { status: 409, code: 'VERSION_CONFLICT', category: 'conflict' },
          { authorization, headers: { 'idempotency-key': `${prefix}-stale-hash` }, body: { ...body, expectedVersionHash: '0'.repeat(64) } })
        {
          // A true stale base: the copy moved to version 2 through the Command above.
          const stale = await apiCall(baseUrl, {
            method: 'POST', path: `/v1/projects/${copyId}/duplicates`, authorization,
            headers: { 'idempotency-key': `${prefix}-stale-copy-v1` },
            body: { expectedVersionId: copyVersionId, expectedVersionHash: copyVersion.baseHash, name: names.other },
          })
          const observed = assertRefusal(stale, { status: 409, code: 'VERSION_CONFLICT', category: 'conflict' })
          assert.equal(stale.json.error.details?.currentVersionId, mutate.json.data.version.id, 'the refusal carries the version that is current')
          assert.deepEqual(await scopeState(), baseline)
          pushCase(evidence, { id: 'stale-version-after-command-on-copy', request: { method: 'POST', path: '/v1/projects/{copyId}/duplicates', auth: 'bearer projects:write' }, expected: { status: 409, code: 'VERSION_CONFLICT' }, observed: { ...observed, currentVersionCarried: true }, persistedUnchanged: true })
        }
        await refusal('injected-payload', { method: 'POST', path: '/v1/projects/{projectId}/duplicates', auth: 'bearer projects:write', extraFields: ['copiedBytes', 'sharedArtifactIds'] },
          { status: 422, code: 'INVALID_ARGUMENT' },
          { authorization, headers: { 'idempotency-key': `${prefix}-injection` }, body: { ...body, copiedBytes: 99, sharedArtifactIds: ['client-controlled-artifact'] } })
        await refusal('foreign-workspace', { method: 'POST', path: '/v1/projects/{projectId}/duplicates', auth: 'bearer other workspace projects:write' },
          { status: 404, code: 'PROJECT_NOT_FOUND' },
          { authorization: otherWorkspaceAuthorization, headers: { 'idempotency-key': `${prefix}-foreign` }, body })
        await refusal('insufficient-scope-read-only', { method: 'POST', path: '/v1/projects/{projectId}/duplicates', auth: 'bearer projects:read' },
          { status: 403, code: 'AUTH_SCOPE_REQUIRED', category: 'auth' },
          { authorization: readOnlyAuthorization, headers: { 'idempotency-key': `${prefix}-scope` }, body })
        await refusal('anonymous', { method: 'POST', path: '/v1/projects/{projectId}/duplicates', auth: 'none' },
          { status: 401, code: 'AUTH_INVALID', category: 'auth' },
          { headers: { 'idempotency-key': `${prefix}-anonymous` }, body })
        await refusal('session-without-origin', { method: 'POST', path: '/v1/projects/{projectId}/duplicates', auth: 'session cookie, no origin' },
          { status: 401, code: 'AUTH_INVALID', category: 'auth' },
          { cookie, headers: { 'idempotency-key': `${prefix}-no-origin` }, body })
        {
          const foreignContent = await readContent(baseUrl, otherWorkspaceAuthorization, artifactId)
          assert.equal(foreignContent.status, 404)
          assert.equal(JSON.parse(foreignContent.bytes.toString('utf8')).error.code, 'MEDIA_ARTIFACT_NOT_FOUND')
          assert.deepEqual(await scopeState(), baseline)
          pushCase(evidence, { id: 'foreign-workspace-cannot-read-shared-master', request: { method: 'GET', path: '/v1/artifacts/{artifactId}/content', auth: 'bearer other workspace' }, expected: { status: 404, code: 'MEDIA_ARTIFACT_NOT_FOUND' }, observed: { status: 404, code: 'MEDIA_ARTIFACT_NOT_FOUND' }, persistedUnchanged: true })
        }
        const finalStorage = await scopeState()
        evidence.final = { projects: finalStorage.projects - workspaceProjectsBefore, references: finalStorage.references, storageObjects: finalStorage.storage.length, masterSha256Unchanged: finalStorage.storage[0].sha256 === masterSha256 }
      } finally {
        await rm(join(root, 'w39', tag), { recursive: true, force: true })
        await rmdir(join(root, 'w39')).catch(() => {})
        const leftovers = await readdir(root).catch(() => [])
        if (leftovers.length === 0) await rm(root, { recursive: true, force: true })
        evidence.postflight.storageCleanup = leftovers.length === 0 ? 'artifact-root-removed' : 'fixture-directory-removed'
      }
    },
  })
}
