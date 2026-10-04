import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  apiCall, assertRefusal, cardIds, cardSnapshot, commandSummary, createProjectViaApi,
  dashboardUrl, listPathMatches, oracleDigest, plain, projectOracle, projectRowSummary,
  pushCase, recordApplicationName, runWaveProof, sanitizedRequest, screenshot,
  summaryCounters, trackBrowserTraffic, waitForCardName, waitForCardSet, waitForCardState,
  waitForSettled,
} from './dashboard-w37-39-shared.mjs'

/**
 * W38 — archive and restore from the dashboard card with a non-trivial previous
 * status, through the real UI, API and PostgreSQL. Fixture prefix: w38-<run tag>.
 *
 * Fixtures (all created after the baseline assertions; statuses other than the
 * creation default are written by a fixture update, because no public command
 * moves a draft project to completed/failed/canceled without a real render):
 *   completed (cycled twice), failed, canceled, and one historical archived row
 *   whose `archivedFromStatus` is NULL.
 */
export async function proveW38ArchiveRestore({
  baseUrl, client, workspaceId, apiClientId, authorization,
  readOnlyAuthorization, otherWorkspaceAuthorization,
  sessionCookieName, sessionCookieValue, username,
}) {
  const tag = randomUUID().slice(0, 8)
  const prefix = `w38-${tag}`
  const cookie = `${sessionCookieName}=${sessionCookieValue}`
  return runWaveProof({
    wave: 38, schemaVersion: 'w38-archive-restore/v1', baseUrl, sessionCookieName, sessionCookieValue,
    initial: { prefix },
    async execute({ evidence, evidenceDir, launch, newSessionPage }) {
      const session = await apiCall(baseUrl, { path: '/v1/session', cookie })
      assert.equal(session.status, 200, 'original human POST /v1/session cookie must remain active')
      assert.equal(session.json.data.workspaceId, workspaceId)
      assert.equal(session.json.data.subject, username)
      const memberId = session.json.data.memberId
      await recordApplicationName(client, evidence)

      // --- fixtures ---------------------------------------------------------------
      const make = async (key, status, name, extra = {}) => {
        const created = await createProjectViaApi({ baseUrl, authorization, name, key: `${prefix}-create-${key}` })
        if (status !== 'draft') {
          await client.v2Project.update({ where: { id: created.project.id }, data: { status, ...extra } })
        }
        return { key, id: created.project.id, name, status, versionId: created.version.id }
      }
      const completed = await make('completed', 'completed', `${prefix}-concluido`)
      const failed = await make('failed', 'failed', `${prefix}-requer-atencao`)
      const canceled = await make('canceled', 'canceled', `${prefix}-cancelado`)
      const legacy = await make('legacy', 'archived', `${prefix}-legado-sem-origem`, { archivedFromStatus: null })
      const fixtures = [completed, failed, canceled, legacy]
      const fixtureIds = fixtures.map((item) => item.id)
      const scopeRows = await client.v2Project.findMany({ where: { workspaceId, name: { contains: prefix, mode: 'insensitive' } }, select: { id: true } })
      assert.deepEqual(new Set(scopeRows.map((row) => row.id)), new Set(fixtureIds), 'PostgreSQL oracle: the prefix scopes exactly the four fixtures')
      const initialOracles = Object.fromEntries(await Promise.all(fixtures.map(async (item) => [item.key, await projectOracle(client, workspaceId, item.id)])))
      for (const item of [completed, failed, canceled]) {
        const oracle = initialOracles[item.key]
        assert.equal(oracle.project.status, item.status)
        assert.equal(oracle.project.archivedFromStatus, null)
        assert.equal(oracle.project.administrationRevision, 1)
        assert.equal(oracle.administrationCommands.length, 0)
        assert.equal(oracle.versions.length, 1)
      }
      assert.equal(initialOracles.legacy.project.status, 'archived')
      assert.equal(initialOracles.legacy.project.archivedFromStatus, null)
      evidence.fixtures = fixtures.map((item) => ({
        key: item.key, projectId: item.id, previousStatus: item.status,
        versionId: item.versionId, versionBaseHash: initialOracles[item.key].versions[0].baseHash,
      }))
      const apiRows = async () => {
        const result = await apiCall(baseUrl, { path: `/v1/projects?limit=24&text=${encodeURIComponent(prefix)}`, authorization })
        assert.equal(result.status, 200)
        return Object.fromEntries(result.json.data.projects.map((item) => [item.id, {
          name: item.name, status: item.status, revision: item.dashboard.administrationRevision,
          archivedFromStatus: item.dashboard.archivedFromStatus, state: item.visibleState.label,
        }]))
      }
      const initialApi = await apiRows()
      assert.deepEqual(new Set(Object.keys(initialApi)), new Set(fixtureIds))
      assert.equal(initialApi[completed.id].status, 'completed')
      assert.equal(initialApi[failed.id].status, 'failed')
      assert.equal(initialApi[canceled.id].status, 'canceled')
      assert.equal(initialApi[legacy.id].status, 'archived')
      assert.equal(initialApi[legacy.id].archivedFromStatus, null)

      // --- browser ------------------------------------------------------------------
      await launch()
      const { page } = await newSessionPage()
      const traffic = trackBrowserTraffic(page, baseUrl)
      const initialList = page.waitForResponse((response) => listPathMatches(response, prefix))
      await page.goto(dashboardUrl(baseUrl, prefix), { waitUntil: 'domcontentloaded' })
      const initialBody = await (await initialList).json()
      assert.deepEqual(new Set(initialBody.data.projects.map((item) => item.id)), new Set(fixtureIds))
      await waitForCardSet(page, fixtureIds)
      await waitForSettled(page)
      const dialog = page.getByRole('dialog')
      const cardOf = (item) => page.locator(`article[data-project-id="${item.id}"]`)
      const refetchWith = (predicate) => page.waitForResponse(async (response) => {
        if (!listPathMatches(response, prefix)) return false
        const body = await response.json()
        return predicate(Object.fromEntries(body.data.projects.map((item) => [item.id, item])))
      })
      const counters = async () => (await summaryCounters(page))
      const countersBefore = await counters()
      assert.equal(countersBefore['Concluídos'], 1, 'only the completed fixture is counted as completed')
      evidence.screenshots.push(await screenshot(page, evidenceDir, 'w38-desktop-before.png'))
      const cycles = []
      const capturedKeys = {}

      async function archiveAndRestore(item, { first, screenshots }) {
        const before = await projectOracle(client, workspaceId, item.id)
        const cardBefore = await cardSnapshot(page, item.id)
        assert.equal(cardBefore.enabledButtons.Arquivar, true)
        assert.equal(cardBefore.enabledButtons.Restaurar, false)
        const stepStart = traffic.mutating().length

        // Archive, then cancel: zero POST, zero commands, zero revisions.
        await cardOf(item).getByRole('button', { name: 'Arquivar', exact: true }).click()
        await dialog.waitFor()
        assert.match(await dialog.innerText(), /Arquivar projeto/)
        if (screenshots) evidence.screenshots.push(await screenshot(page, evidenceDir, 'w38-desktop-archive-dialog.png'))
        await dialog.getByRole('button', { name: 'Cancelar' }).click()
        await dialog.waitFor({ state: 'hidden' })
        assert.equal(traffic.mutating().length, stepStart, 'cancelling the archive confirmation sends no POST')
        const afterCancel = await projectOracle(client, workspaceId, item.id)
        assert.equal(afterCancel.administrationCommands.length, 0)
        assert.equal(afterCancel.project.administrationRevision, 1)
        assert.deepEqual(afterCancel.project, before.project)
        assert.deepEqual(afterCancel.events, before.events)
        assert.deepEqual((await cardSnapshot(page, item.id)).state, cardBefore.state)
        if (screenshots) evidence.screenshots.push(await screenshot(page, evidenceDir, 'w38-desktop-after-cancel.png'))

        // Second attempt: confirm.
        const archiveRefetch = refetchWith((rows) => rows[item.id]?.status === 'archived' && rows[item.id].dashboard.archivedFromStatus === item.status)
        const archiveResponse = page.waitForResponse((response) => response.url().endsWith(`/v1/projects/${item.id}/archive`) && response.request().method() === 'POST')
        await cardOf(item).getByRole('button', { name: 'Arquivar', exact: true }).click()
        await dialog.waitFor()
        await dialog.getByRole('button', { name: 'Confirmar arquivamento' }).click()
        const archived = await archiveResponse
        assert.equal(archived.status(), 200)
        const archivedBody = await archived.json()
        await dialog.waitFor({ state: 'hidden' })
        await archiveRefetch
        await waitForCardState(page, item.id, 'archived')
        await waitForSettled(page)
        const archivePost = traffic.mutating().at(stepStart)
        assert.equal(traffic.mutating().length, stepStart + 1, 'one POST for the confirmed archive')
        assert.equal(archivePost.path, `/v1/projects/${item.id}/archive`)
        const archiveRevision = before.project.administrationRevision
        assert.deepEqual(JSON.parse(archivePost.postData), { baseRevision: archiveRevision, confirmed: true })
        assert.equal(archivedBody.data.project.status, 'archived')
        assert.equal(archivedBody.data.administration.archivedFromStatus, item.status)
        assert.equal(archivedBody.data.administration.revision, archiveRevision + 1)
        assert.equal(archivedBody.data.command.action, 'archive')
        assert.equal(archivedBody.data.replayed, false)
        const afterArchive = await projectOracle(client, workspaceId, item.id)
        assert.equal(afterArchive.administrationCommands.length, before.administrationCommands.length + 1, 'one atomic command')
        const archiveCommand = afterArchive.administrationCommands.at(-1)
        assert.equal(archiveCommand.id, archivedBody.data.command.id)
        assert.equal(archiveCommand.action, 'archive')
        assert.equal(archiveCommand.baseRevision, archiveRevision)
        assert.equal(archiveCommand.resultRevision, archiveRevision + 1)
        assert.equal(archiveCommand.beforeStatus, item.status)
        assert.equal(archiveCommand.afterStatus, 'archived')
        assert.equal(archiveCommand.beforeArchivedFromStatus, null)
        assert.equal(archiveCommand.afterArchivedFromStatus, item.status)
        assert.equal(archiveCommand.confirmation, 'explicit')
        assert.equal(archiveCommand.actorAuthenticationKind, 'ui-session')
        assert.equal(archiveCommand.delegatedUserId, memberId)
        assert.equal(archiveCommand.idempotencyKey, archivePost.idempotencyKey)
        assert.equal(afterArchive.project.status, 'archived')
        assert.equal(afterArchive.project.archivedFromStatus, item.status)
        assert.equal(afterArchive.project.administrationRevision, archiveRevision + 1)
        assert.equal(afterArchive.project.name, before.project.name)
        assert.equal(afterArchive.project.currentVersionId, before.project.currentVersionId)
        assert.deepEqual(afterArchive.versions, before.versions)
        assert.deepEqual(afterArchive.snapshots, before.snapshots)
        assert.equal(afterArchive.events.length, before.events.length + 1)
        const archiveEvent = afterArchive.events.at(-1)
        assert.equal(archiveEvent.type, 'project.status.changed')
        assert.deepEqual(JSON.parse(archiveEvent.dataJson), {
          action: 'archive', baseRevision: archiveRevision, resultRevision: archiveRevision + 1,
          previousStatus: item.status, status: 'archived',
        })
        const cardArchived = await cardSnapshot(page, item.id)
        assert.equal(cardArchived.state, 'archived')
        assert.equal(cardArchived.enabledButtons.Restaurar, true, 'Restaurar is offered for the archived card')
        assert.equal(cardArchived.enabledButtons.Arquivar, false)
        if (first) {
          assert.equal((await counters())['Concluídos'], 0, 'the archived card left the completed group')
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w38-desktop-archived.png'))
          // The archived group, through the real status filter: the new archive and the historical row.
          const statusFilter = page.getByRole('combobox', { name: 'Filtrar por status' })
          const archivedRows = await client.v2Project.findMany({ where: { workspaceId, status: 'archived', name: { contains: prefix, mode: 'insensitive' } }, select: { id: true } })
          const filtered = page.waitForResponse((response) => {
            const url = new URL(response.url())
            return url.pathname === '/v1/projects' && url.searchParams.get('status') === 'archived' && url.searchParams.get('text') === prefix && response.status() === 200
          })
          await statusFilter.selectOption('archived')
          const filteredBody = await (await filtered).json()
          assert.deepEqual(new Set(filteredBody.data.projects.map((row) => row.id)), new Set(archivedRows.map((row) => row.id)))
          assert.ok(archivedRows.some((row) => row.id === item.id))
          await waitForCardSet(page, archivedRows.map((row) => row.id))
          evidence.screenshots.push(await screenshot(page, evidenceDir, 'w38-desktop-archived-filter.png'))
          const cleared = refetchWith((rows) => fixtureIds.every((id) => rows[id]))
          await statusFilter.selectOption('')
          await cleared
          await waitForCardSet(page, fixtureIds)
          await waitForSettled(page)
        }
        capturedKeys[`${item.key}-${archiveRevision}`] = { archive: archivePost.idempotencyKey, archiveRevision }

        // Restore: exact previous status.
        const restoreRefetch = refetchWith((rows) => rows[item.id]?.status === item.status && rows[item.id].dashboard.archivedFromStatus === null)
        const restoreResponse = page.waitForResponse((response) => response.url().endsWith(`/v1/projects/${item.id}/restore`) && response.request().method() === 'POST')
        await cardOf(item).getByRole('button', { name: 'Restaurar', exact: true }).click()
        const restored = await restoreResponse
        assert.equal(restored.status(), 200)
        const restoredBody = await restored.json()
        await restoreRefetch
        await waitForCardState(page, item.id, cardBefore.state)
        await waitForSettled(page)
        const restorePost = traffic.mutating().at(stepStart + 1)
        assert.equal(traffic.mutating().length, stepStart + 2)
        assert.equal(restorePost.path, `/v1/projects/${item.id}/restore`)
        assert.deepEqual(JSON.parse(restorePost.postData), { baseRevision: archiveRevision + 1 })
        assert.equal(restoredBody.data.project.status, item.status)
        assert.equal(restoredBody.data.administration.archivedFromStatus, null)
        assert.equal(restoredBody.data.administration.revision, archiveRevision + 2)
        assert.equal(restoredBody.data.command.action, 'restore')
        const afterRestore = await projectOracle(client, workspaceId, item.id)
        assert.equal(afterRestore.administrationCommands.length, before.administrationCommands.length + 2)
        const restoreCommand = afterRestore.administrationCommands.at(-1)
        assert.equal(restoreCommand.id, restoredBody.data.command.id)
        assert.equal(restoreCommand.action, 'restore')
        assert.equal(restoreCommand.baseRevision, archiveRevision + 1)
        assert.equal(restoreCommand.resultRevision, archiveRevision + 2)
        assert.equal(restoreCommand.beforeStatus, 'archived')
        assert.equal(restoreCommand.beforeArchivedFromStatus, item.status)
        assert.equal(restoreCommand.afterStatus, item.status, 'exact previous status, never a default')
        assert.equal(restoreCommand.afterArchivedFromStatus, null)
        assert.equal(restoreCommand.confirmation, 'not-required')
        assert.equal(restoreCommand.actorAuthenticationKind, 'ui-session')
        assert.equal(restoreCommand.idempotencyKey, restorePost.idempotencyKey)
        assert.equal(afterRestore.project.status, item.status)
        assert.equal(afterRestore.project.archivedFromStatus, null)
        assert.equal(afterRestore.project.administrationRevision, archiveRevision + 2)
        assert.deepEqual(afterRestore.administrationCommands.slice(0, -1), afterArchive.administrationCommands, 'earlier command history is untouched')
        assert.deepEqual(afterRestore.versions, before.versions, 'ProjectVersion identity is intact')
        assert.deepEqual(afterRestore.snapshots, before.snapshots)
        assert.deepEqual(afterRestore.mediaAssets, before.mediaAssets)
        assert.deepEqual(afterRestore.creationCommand, before.creationCommand)
        assert.equal(afterRestore.editCommandCount, before.editCommandCount)
        assert.deepEqual(afterRestore.administrationCommands.map((row) => row.resultRevision), [...Array(afterRestore.administrationCommands.length).keys()].map((index) => index + 2), 'revision is monotonic')
        const cardRestored = await cardSnapshot(page, item.id)
        assert.equal(cardRestored.state, cardBefore.state)
        assert.equal(cardRestored.enabledButtons.Arquivar, true)
        assert.equal(cardRestored.enabledButtons.Restaurar, false)
        capturedKeys[`${item.key}-${archiveRevision}`].restore = restorePost.idempotencyKey
        capturedKeys[`${item.key}-${archiveRevision}`].archiveCommandId = archiveCommand.id
        capturedKeys[`${item.key}-${archiveRevision}`].restoreCommandId = restoreCommand.id
        return {
          previousStatus: item.status, cancelledSteps: { mutatingRequests: 0, commands: 0, revisions: 0 },
          archive: { request: sanitizedRequest(archivePost), command: commandSummary(archiveCommand), event: JSON.parse(archiveEvent.dataJson), cardState: cardArchived.state },
          restore: { request: sanitizedRequest(restorePost), command: commandSummary(restoreCommand), cardState: cardRestored.state },
          versionsIdentical: true, snapshotsIdentical: true, finalProject: projectRowSummary(afterRestore.project),
        }
      }

      cycles.push(await archiveAndRestore(completed, { first: true, screenshots: true }))
      evidence.screenshots.push(await screenshot(page, evidenceDir, 'w38-desktop-restored.png'))

      // Stale revision from another client, with the archive confirmation open.
      {
        const item = completed
        const before = await projectOracle(client, workspaceId, item.id)
        const revision = before.project.administrationRevision
        assert.equal(revision, 3)
        await cardOf(item).getByRole('button', { name: 'Arquivar', exact: true }).click()
        await dialog.waitFor()
        assert.match(await dialog.innerText(), /revisão administrativa 3/)
        const renamedByOther = `${prefix}-concluido-renomeado-por-outro-cliente`
        const other = await apiCall(baseUrl, {
          method: 'POST', path: `/v1/projects/${item.id}/rename`, authorization,
          headers: { 'idempotency-key': `${prefix}-other-client-rename` }, body: { baseRevision: 3, name: renamedByOther },
        })
        assert.equal(other.status, 200, other.text)
        const staleResponse = page.waitForResponse((response) => response.url().endsWith(`/v1/projects/${item.id}/archive`) && response.request().method() === 'POST')
        const mutationsBefore = traffic.mutating().length
        await dialog.getByRole('button', { name: 'Confirmar arquivamento' }).click()
        const stale = await staleResponse
        assert.equal(stale.status(), 409)
        const staleBody = await stale.json()
        assert.equal(staleBody.error.code, 'VERSION_CONFLICT')
        await dialog.getByRole('alert').waitFor()
        const afterStale = await projectOracle(client, workspaceId, item.id)
        assert.equal(afterStale.project.status, 'completed', 'the refused archive did not archive')
        assert.equal(afterStale.project.archivedFromStatus, null)
        assert.equal(afterStale.project.administrationRevision, 4)
        assert.equal(afterStale.administrationCommands.filter((row) => row.action === 'archive').length, 1, 'only the first archive exists')
        assert.equal(afterStale.administrationCommands.length, before.administrationCommands.length + 1, 'only the other client wrote a command')
        await dialog.getByText(/revisão administrativa 4/).waitFor()
        await waitForCardName(page, item.id, renamedByOther)
        evidence.screenshots.push(await screenshot(page, evidenceDir, 'w38-desktop-conflict-error.png'))
        assert.equal(traffic.mutating().length, mutationsBefore + 1)
        pushCase(evidence, {
          id: 'stale-base-revision-archive', expected: { status: 409, code: 'VERSION_CONFLICT', statusAfter: 'completed' },
          observed: { status: stale.status(), code: staleBody.error.code, statusAfter: afterStale.project.status, errorVisibleInDialog: true, dialogRevisionAfterRefetch: 4, extraBrowserCommands: 0 },
        })
        // Recovery: confirm again on the live revision, then restore again (revisions keep growing).
        const reArchive = page.waitForResponse((response) => response.url().endsWith(`/v1/projects/${item.id}/archive`) && response.request().method() === 'POST')
        await dialog.getByRole('button', { name: 'Confirmar arquivamento' }).click()
        assert.equal((await reArchive).status(), 200)
        await dialog.waitFor({ state: 'hidden' })
        await waitForCardState(page, item.id, 'archived')
        await waitForSettled(page)
        const afterReArchive = await projectOracle(client, workspaceId, item.id)
        assert.equal(afterReArchive.project.administrationRevision, 5)
        assert.equal(afterReArchive.project.archivedFromStatus, 'completed')
        const reRestore = page.waitForResponse((response) => response.url().endsWith(`/v1/projects/${item.id}/restore`) && response.request().method() === 'POST')
        await cardOf(item).getByRole('button', { name: 'Restaurar', exact: true }).click()
        assert.equal((await reRestore).status(), 200)
        await waitForCardState(page, item.id, cycles[0].restore.cardState)
        await waitForSettled(page)
        const afterReRestore = await projectOracle(client, workspaceId, item.id)
        assert.equal(afterReRestore.project.status, 'completed')
        assert.equal(afterReRestore.project.administrationRevision, 6)
        assert.deepEqual(afterReRestore.administrationCommands.map((row) => [row.action, row.baseRevision, row.resultRevision]), [
          ['archive', 1, 2], ['restore', 2, 3], ['rename', 3, 4], ['archive', 4, 5], ['restore', 5, 6],
        ])
        assert.deepEqual(afterReRestore.versions, before.versions)
        pushCase(evidence, { id: 'recovery-second-cycle', expected: { revisions: [2, 3, 4, 5, 6], finalStatus: 'completed' }, observed: { revisions: afterReRestore.administrationCommands.map((row) => row.resultRevision), finalStatus: afterReRestore.project.status } })
      }

      cycles.push(await archiveAndRestore(failed, { first: false, screenshots: false }))
      cycles.push(await archiveAndRestore(canceled, { first: false, screenshots: false }))
      evidence.cycles = cycles
      assert.deepEqual(cycles.map((item) => item.previousStatus), ['completed', 'failed', 'canceled'])

      // --- historical archived row without archivedFromStatus fails closed ----------
      {
        const before = await projectOracle(client, workspaceId, legacy.id)
        const cardLegacy = await cardSnapshot(page, legacy.id)
        assert.equal(cardLegacy.state, 'archived')
        assert.equal(cardLegacy.enabledButtons.Restaurar, false, 'no restore is offered without archivedFromStatus')
        assert.equal(cardLegacy.enabledButtons.Arquivar, false)
        const mutationsBefore = traffic.mutating().length
        await cardOf(legacy).getByRole('button', { name: 'Restaurar', exact: true }).click({ force: true })
        await page.waitForTimeout(400)
        assert.equal(traffic.mutating().length, mutationsBefore, 'a click on the disabled Restaurar sends nothing')
        const projectCountBefore = await client.v2Project.count({ where: { workspaceId, name: { contains: prefix, mode: 'insensitive' } } })
        const restoreLegacy = await apiCall(baseUrl, {
          method: 'POST', path: `/v1/projects/${legacy.id}/restore`, authorization,
          headers: { 'idempotency-key': `${prefix}-legacy-restore` }, body: { baseRevision: 1 },
        })
        const archiveLegacy = await apiCall(baseUrl, {
          method: 'POST', path: `/v1/projects/${legacy.id}/archive`, authorization,
          headers: { 'idempotency-key': `${prefix}-legacy-archive` }, body: { baseRevision: 1, confirmed: true },
        })
        const restoreObserved = assertRefusal(restoreLegacy, { status: 422, code: 'INVALID_PROJECT' })
        const archiveObserved = assertRefusal(archiveLegacy, { status: 422, code: 'INVALID_PROJECT' })
        const after = await projectOracle(client, workspaceId, legacy.id)
        assert.equal(after.project.status, 'archived', 'no silent switch to draft')
        assert.equal(after.project.archivedFromStatus, null)
        assert.equal(after.project.administrationRevision, 1)
        assert.equal(after.administrationCommands.length, 0)
        assert.deepEqual(after.project, before.project)
        assert.deepEqual(after.versions, before.versions)
        assert.equal(await client.v2Project.count({ where: { workspaceId, name: { contains: prefix, mode: 'insensitive' } } }), projectCountBefore, 'no DELETE')
        evidence.legacy = { projectId: legacy.id, uiRestoreEnabled: false, uiClickSentRequests: 0, project: projectRowSummary(after.project), commands: 0, projectsBefore: projectCountBefore, projectsAfter: projectCountBefore }
        pushCase(evidence, { id: 'legacy-restore-fails-closed', request: { method: 'POST', path: '/v1/projects/{projectId}/restore', auth: 'bearer projects:write' }, expected: { status: 422, code: 'INVALID_PROJECT' }, observed: restoreObserved, persistedUnchanged: true })
        pushCase(evidence, { id: 'legacy-archive-refused', request: { method: 'POST', path: '/v1/projects/{projectId}/archive', auth: 'bearer projects:write' }, expected: { status: 422, code: 'INVALID_PROJECT' }, observed: archiveObserved, persistedUnchanged: true })
      }

      // --- browser mutation accounting -------------------------------------------------
      const expectedPaths = [
        ...['archive', 'restore'].map((action) => `POST /v1/projects/${completed.id}/${action}`),
        `POST /v1/projects/${completed.id}/archive`,
        `POST /v1/projects/${completed.id}/archive`,
        `POST /v1/projects/${completed.id}/restore`,
        ...['archive', 'restore'].map((action) => `POST /v1/projects/${failed.id}/${action}`),
        ...['archive', 'restore'].map((action) => `POST /v1/projects/${canceled.id}/${action}`),
      ]
      const mutations = traffic.mutating()
      assert.deepEqual(mutations.map((item) => `${item.method} ${item.path}`), expectedPaths, 'every browser mutation is a confirmed (or refused) archive/restore, none for a cancel')
      evidence.browser.mutatingRequests = mutations.length
      evidence.browser.requests = mutations.map(sanitizedRequest)
      await page.setViewportSize({ width: 390, height: 844 })
      await waitForCardSet(page, fixtureIds)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      evidence.browser.mobileOverflowPx = overflow
      assert.ok(overflow <= 1, `W38 mobile overflows by ${overflow}px`)
      evidence.screenshots.push(await screenshot(page, evidenceDir, 'w38-mobile-restored.png'))
      assert.deepEqual(await cardIds(page).then((ids) => new Set(ids)), new Set(fixtureIds))

      // --- replay, mismatch, scope, isolation, authentication ----------------------------
      const first = capturedKeys[`completed-1`]
      const replayArchive = await apiCall(baseUrl, {
        method: 'POST', path: `/v1/projects/${completed.id}/archive`, cookie, origin: true,
        headers: { 'idempotency-key': first.archive }, body: { baseRevision: first.archiveRevision, confirmed: true },
      })
      assert.equal(replayArchive.status, 200)
      assert.equal(replayArchive.json.data.replayed, true)
      assert.equal(replayArchive.json.data.command.id, first.archiveCommandId)
      const replayRestore = await apiCall(baseUrl, {
        method: 'POST', path: `/v1/projects/${completed.id}/restore`, cookie, origin: true,
        headers: { 'idempotency-key': first.restore }, body: { baseRevision: first.archiveRevision + 1 },
      })
      assert.equal(replayRestore.status, 200)
      assert.equal(replayRestore.json.data.replayed, true)
      assert.equal(replayRestore.json.data.command.id, first.restoreCommandId)
      const afterReplay = await projectOracle(client, workspaceId, completed.id)
      assert.equal(afterReplay.administrationCommands.length, 5, 'idempotent replay does not duplicate commands')
      assert.equal(afterReplay.project.status, 'completed')
      assert.equal(afterReplay.project.administrationRevision, 6)
      pushCase(evidence, { id: 'idempotent-replay-archive-and-restore', expected: { status: 200, replayed: true, commands: 5 }, observed: { status: 200, replayed: true, commands: afterReplay.administrationCommands.length, sameCommandIds: true } })
      const mismatch = await apiCall(baseUrl, {
        method: 'POST', path: `/v1/projects/${completed.id}/archive`, cookie, origin: true,
        headers: { 'idempotency-key': first.archive }, body: { baseRevision: 99, confirmed: true },
      })
      pushCase(evidence, { id: 'idempotency-payload-mismatch', expected: { status: 409, code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' }, observed: assertRefusal(mismatch, { status: 409, code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' }), persistedUnchanged: true })

      const stateOf = async (item) => {
        const oracle = await projectOracle(client, workspaceId, item.id)
        return { digest: oracleDigest(oracle, ['project']), commands: oracle.administrationCommands.length, events: oracle.events.length }
      }
      const baselineFailed = await stateOf(failed)
      const baselineCompleted = await stateOf(completed)
      const rev = (await projectOracle(client, workspaceId, failed.id)).project.administrationRevision
      const refusals = [
        { id: 'archive-insufficient-scope', action: 'archive', target: failed, call: { authorization: readOnlyAuthorization }, body: { baseRevision: rev, confirmed: true }, expect: { status: 403, code: 'AUTH_SCOPE_REQUIRED', category: 'auth' } },
        { id: 'restore-insufficient-scope', action: 'restore', target: failed, call: { authorization: readOnlyAuthorization }, body: { baseRevision: rev }, expect: { status: 403, code: 'AUTH_SCOPE_REQUIRED', category: 'auth' } },
        { id: 'archive-other-workspace', action: 'archive', target: failed, call: { authorization: otherWorkspaceAuthorization }, body: { baseRevision: rev, confirmed: true }, expect: { status: 404, code: 'PROJECT_NOT_FOUND' } },
        { id: 'restore-other-workspace', action: 'restore', target: failed, call: { authorization: otherWorkspaceAuthorization }, body: { baseRevision: rev }, expect: { status: 404, code: 'PROJECT_NOT_FOUND' } },
        { id: 'archive-anonymous', action: 'archive', target: failed, call: {}, body: { baseRevision: rev, confirmed: true }, expect: { status: 401, code: 'AUTH_INVALID', category: 'auth' } },
        { id: 'archive-session-without-origin', action: 'archive', target: failed, call: { cookie }, body: { baseRevision: rev, confirmed: true }, expect: { status: 401, code: 'AUTH_INVALID', category: 'auth' } },
        { id: 'archive-unconfirmed', action: 'archive', target: failed, call: { authorization }, body: { baseRevision: rev, confirmed: false }, expect: { status: 422, code: 'INVALID_ARGUMENT' } },
        { id: 'archive-confirmation-missing', action: 'archive', target: failed, call: { authorization }, body: { baseRevision: rev }, expect: { status: 422, code: 'INVALID_ARGUMENT' } },
        { id: 'archive-stale-base-revision', action: 'archive', target: failed, call: { authorization }, body: { baseRevision: rev - 1, confirmed: true }, expect: { status: 409, code: 'VERSION_CONFLICT', category: 'conflict' } },
        { id: 'restore-not-archived', action: 'restore', target: failed, call: { authorization }, body: { baseRevision: rev }, expect: { status: 422, code: 'INVALID_PROJECT' } },
      ]
      for (const item of refusals) {
        const result = await apiCall(baseUrl, {
          method: 'POST', path: `/v1/projects/${item.target.id}/${item.action}`, ...item.call,
          headers: { 'idempotency-key': `${prefix}-refusal-${item.id}` },
          body: item.body,
        })
        const observed = assertRefusal(result, item.expect)
        assert.deepEqual(await stateOf(failed), baselineFailed, `${item.id} must not change the project`)
        pushCase(evidence, { id: item.id, request: { method: 'POST', path: `/v1/projects/{projectId}/${item.action}` }, expected: item.expect, observed, persistedUnchanged: true })
      }
      assert.deepEqual(await stateOf(completed), baselineCompleted)
      evidence.final = {
        projects: plain(await Promise.all(fixtures.map(async (item) => {
          const oracle = await projectOracle(client, workspaceId, item.id)
          return { key: item.key, project: projectRowSummary(oracle.project), commands: oracle.administrationCommands.map(commandSummary), versions: oracle.versions.length }
        }))),
        api: await apiRows(),
      }
    },
  })
}
