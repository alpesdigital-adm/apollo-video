import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import {
  FEED_TIMING_AID, apiCall, assertRefusal, cardIds, cardSnapshot, commandSummary, createProjectViaApi,
  dashboardUrl, holdFeedPoll, holdRequest, listPathMatches, oracleDigest, projectOracle,
  projectRowSummary, pushCase, recordApplicationName, runWaveProof, sanitizedRequest,
  screenshot, trackBrowserTraffic, waitForCardName,
} from './dashboard-w37-39-shared.mjs'

function changedKeys(left, right) {
  return Object.keys(left).filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key])).sort()
}

/**
 * W37 — rename from the dashboard card, UI -> API -> PostgreSQL, with the real
 * human session cookie created earlier in the journey by POST /v1/session.
 * Fixture prefix: w37-<run tag>. Every assertion is scoped to that prefix.
 */
export async function proveW37RenameFromCard({
  baseUrl, client, workspaceId, apiClientId, authorization,
  readOnlyAuthorization, otherWorkspaceAuthorization,
  sessionCookieName, sessionCookieValue, username,
}) {
  const tag = randomUUID().slice(0, 8)
  const prefix = `w37-${tag}`
  const names = {
    original: `${prefix}-original`, renamed: `${prefix}-renomeado`, abandoned: `${prefix}-abandonado`,
    stale: `${prefix}-obsoleto`, other: `${prefix}-outro-cliente`, recovered: `${prefix}-recuperado`,
  }
  const cookie = `${sessionCookieName}=${sessionCookieValue}`
  return runWaveProof({
    wave: 37, schemaVersion: 'w37-rename-from-card/v1', baseUrl, sessionCookieName, sessionCookieValue,
    initial: { prefix },
    async execute({ evidence, evidenceDir, launch, newSessionPage }) {
      const session = await apiCall(baseUrl, { path: '/v1/session', cookie })
      assert.equal(session.status, 200, 'original human POST /v1/session cookie must remain active')
      assert.equal(session.json.data.workspaceId, workspaceId)
      assert.equal(session.json.data.subject, username)
      const memberId = session.json.data.memberId
      assert.ok(memberId)
      await recordApplicationName(client, evidence)

      // --- fixture (after the baseline assertions) -------------------------------
      const created = await createProjectViaApi({ baseUrl, authorization, name: names.original, key: `${prefix}-create` })
      const projectId = created.project.id
      const before = await projectOracle(client, workspaceId, projectId)
      assert.equal(before.project.name, names.original)
      assert.equal(before.project.status, 'draft')
      assert.equal(before.project.administrationRevision, 1)
      assert.equal(before.project.archivedFromStatus, null)
      assert.equal(before.versions.length, 1)
      assert.ok(before.snapshots.length >= 3)
      assert.equal(before.administrationCommands.length, 0)
      assert.equal(before.events.length, 0)
      assert.equal(before.editCommandCount, 0)
      evidence.fixture = {
        projectId, versionId: before.versions[0].id, versionBaseHash: before.versions[0].baseHash,
        snapshots: before.snapshots.map((row) => ({ id: row.id, kind: row.kind, contentHash: row.contentHash })),
        project: projectRowSummary(before.project),
      }
      const apiList = async () => {
        const result = await apiCall(baseUrl, { path: `/v1/projects?limit=24&text=${encodeURIComponent(prefix)}`, authorization })
        assert.equal(result.status, 200)
        return result.json.data.projects.map((item) => ({
          id: item.id, name: item.name, status: item.status,
          revision: item.dashboard.administrationRevision, archivedFromStatus: item.dashboard.archivedFromStatus,
        }))
      }
      const prefixRows = await client.v2Project.findMany({ where: { workspaceId, name: { contains: prefix, mode: 'insensitive' } }, select: { id: true } })
      assert.deepEqual(prefixRows.map((row) => row.id), [projectId], 'PostgreSQL oracle: the prefix scopes exactly one fixture')
      assert.deepEqual(await apiList(), [{ id: projectId, name: names.original, status: 'draft', revision: 1, archivedFromStatus: null }])

      // --- browser: the card ----------------------------------------------------
      await launch()
      const { page } = await newSessionPage()
      const traffic = trackBrowserTraffic(page, baseUrl)
      const initialList = page.waitForResponse((response) => listPathMatches(response, prefix))
      await page.goto(dashboardUrl(baseUrl, prefix), { waitUntil: 'domcontentloaded' })
      const initialBody = await (await initialList).json()
      assert.deepEqual(initialBody.data.projects.map((item) => item.id), [projectId])
      await waitForCardName(page, projectId, names.original)
      assert.deepEqual(await cardIds(page), [projectId])
      const cardBefore = await cardSnapshot(page, projectId)
      assert.equal(cardBefore.name, names.original)
      evidence.screenshots.push(await screenshot(page, evidenceDir, 'w37-desktop-before.png'))
      const card = page.locator(`article[data-project-id="${projectId}"]`)
      const dialog = page.getByRole('dialog')
    
      // Abandoning the dialog is not a command.
      await card.getByRole('button', { name: 'Renomear', exact: true }).click()
      await dialog.waitFor()
      await dialog.getByLabel('Nome').fill(names.abandoned)
      await dialog.getByRole('button', { name: 'Cancelar' }).click()
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(traffic.mutating().length, 0, 'abandoning the rename dialog must not POST')
      assert.equal((await cardSnapshot(page, projectId)).name, names.original)
      assert.equal(oracleDigest(await projectOracle(client, workspaceId, projectId), ['project', 'versions', 'snapshots']), oracleDigest(before, ['project', 'versions', 'snapshots']))
      pushCase(evidence, { id: 'abandoned-dialog', expected: { mutatingRequests: 0, name: names.original }, observed: { mutatingRequests: 0, name: names.original } })

      // --- confirmed rename; the request is held so any card change would be optimistic ---
      const hold = await holdRequest(page, /\/v1\/projects\/[^/]+\/rename$/)
      await card.getByRole('button', { name: 'Renomear', exact: true }).click()
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /revisão administrativa 1/)
      await dialog.getByLabel('Nome').fill(names.renamed)
      await dialog.getByRole('button', { name: 'Salvar nome' }).click()
      assert.equal(await hold.held, 'POST')
      const duringHold = await projectOracle(client, workspaceId, projectId)
      assert.equal(duringHold.project.name, names.original, 'nothing is persisted while the request is held')
      assert.equal(duringHold.project.administrationRevision, 1)
      assert.equal(duringHold.administrationCommands.length, 0)
      assert.equal((await cardSnapshot(page, projectId)).name, names.original, 'no optimistic update before the confirmation arrives')
      await dialog.getByRole('button', { name: /Aplicando/ }).waitFor()
      assert.equal((await cardSnapshot(page, projectId)).name, names.original)
      evidence.screenshots.push(await screenshot(page, evidenceDir, 'w37-desktop-pending.png'))
      const refetch = page.waitForResponse(async (response) => {
        if (!listPathMatches(response, prefix)) return false
        const body = await response.json()
        return body.data.projects.some((item) => item.id === projectId && item.name === names.renamed)
      })
      hold.release()
      await dialog.waitFor({ state: 'hidden' })
      await refetch
      await hold.dispose()
      await waitForCardName(page, projectId, names.renamed)
      const cardAfter = await cardSnapshot(page, projectId)
      assert.equal(cardAfter.name, names.renamed)
      assert.equal(cardAfter.state, cardBefore.state, 'rename does not change the visible state')
      evidence.screenshots.push(await screenshot(page, evidenceDir, 'w37-desktop-after.png'))

      const renamePosts = traffic.mutating()
      assert.equal(renamePosts.length, 1, 'exactly one mutating request for the confirmed rename')
      const posted = renamePosts[0]
      assert.equal(posted.method, 'POST')
      assert.equal(posted.path, `/v1/projects/${projectId}/rename`)
      assert.deepEqual(JSON.parse(posted.postData), { baseRevision: 1, name: names.renamed })
      assert.match(posted.idempotencyKey, /^[\x21-\x7E]{8,128}$/)
      const postedResponse = traffic.responses.find((item) => item.method === 'POST' && item.path === posted.path)
      assert.equal(postedResponse.status, 200)
      const postedBody = await postedResponse.body
      assert.equal(postedBody.data.command.action, 'rename')
      assert.equal(postedBody.data.command.baseRevision, 1)
      assert.equal(postedBody.data.command.resultRevision, 2)
      assert.equal(postedBody.data.administration.revision, 2)
      assert.equal(postedBody.data.project.name, names.renamed)
      assert.equal(postedBody.data.replayed, false)

      const afterRename = await projectOracle(client, workspaceId, projectId)
      assert.equal(afterRename.administrationCommands.length, 1)
      const command = afterRename.administrationCommands[0]
      assert.equal(command.id, postedBody.data.command.id)
      assert.equal(command.action, 'rename')
      assert.equal(command.baseRevision, 1)
      assert.equal(command.resultRevision, 2)
      assert.equal(command.beforeName, names.original)
      assert.equal(command.afterName, names.renamed)
      assert.equal(command.beforeStatus, 'draft')
      assert.equal(command.afterStatus, 'draft')
      assert.equal(command.confirmation, 'not-required')
      assert.equal(command.actorClientId, apiClientId)
      assert.equal(command.actorAuthenticationKind, 'ui-session')
      assert.equal(command.delegatedUserId, memberId)
      assert.equal(command.workspaceRole, 'administrator')
      assert.equal(command.idempotencyKey, posted.idempotencyKey, 'the key the browser sent is the persisted key')
      assert.deepEqual(changedKeys(before.project, afterRename.project), ['administrationRevision', 'name', 'updatedAt'], 'a single change in the project row (name, its fence, and the updatedAt bookkeeping column)')
      assert.deepEqual(afterRename.versions, before.versions)
      assert.deepEqual(afterRename.snapshots, before.snapshots)
      assert.deepEqual(afterRename.mediaAssets, before.mediaAssets)
      assert.equal(afterRename.editCommandCount, before.editCommandCount)
      assert.equal(afterRename.events.length, 1)
      assert.equal(afterRename.events[0].type, 'project.name.changed')
      assert.equal(afterRename.events[0].id, command.eventId)
      assert.equal(afterRename.events[0].actorClientId, apiClientId)
      assert.equal(afterRename.events[0].actorUserId, memberId)
      assert.deepEqual(JSON.parse(afterRename.events[0].dataJson), { action: 'rename', baseRevision: 1, resultRevision: 2 })
      assert.deepEqual(await apiList(), [{ id: projectId, name: names.renamed, status: 'draft', revision: 2, archivedFromStatus: null }])
      const workspaceRead = await apiCall(baseUrl, { path: `/v1/projects/${projectId}/workspace`, authorization })
      assert.equal(workspaceRead.status, 200)
      assert.equal(workspaceRead.json.data.project.name, names.renamed)
      assert.equal(workspaceRead.json.data.version.id, before.versions[0].id)
      evidence.rename = {
        request: sanitizedRequest(posted), responseStatus: 200, command: commandSummary(command),
        projectChangedKeys: ['administrationRevision', 'name', 'updatedAt'], versionsUnchanged: true, snapshotsUnchanged: true,
        eventTypes: afterRename.events.map((item) => item.type), pendingCardName: names.original, confirmedCardName: names.renamed,
        refetchObserved: true,
      }

      // --- idempotent replay of the browser's own key ---------------------------
      const replayRequest = { method: 'POST', path: posted.path, cookie, origin: true, headers: { 'idempotency-key': posted.idempotencyKey }, body: { baseRevision: 1, name: names.renamed } }
      const replay = await apiCall(baseUrl, replayRequest)
      assert.equal(replay.status, 200)
      assert.equal(replay.json.data.replayed, true)
      assert.equal(replay.json.data.command.id, command.id)
      assert.equal(replay.json.data.command.commandHash, command.commandHash)
      const mismatch = await apiCall(baseUrl, { ...replayRequest, body: { baseRevision: 1, name: names.other } })
      const mismatchObserved = assertRefusal(mismatch, { status: 409, code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' })
      const afterReplay = await projectOracle(client, workspaceId, projectId)
      assert.equal(afterReplay.administrationCommands.length, 1, 'replay does not duplicate the command')
      assert.equal(afterReplay.events.length, 1)
      assert.deepEqual(afterReplay.project, afterRename.project)
      pushCase(evidence, { id: 'idempotent-replay', expected: { status: 200, replayed: true, commands: 1 }, observed: { status: replay.status, replayed: true, commands: afterReplay.administrationCommands.length, sameCommandId: true } })
      pushCase(evidence, { id: 'idempotency-payload-mismatch', expected: { status: 409, code: 'IDEMPOTENCY_PAYLOAD_MISMATCH' }, observed: mismatchObserved })

      await page.setViewportSize({ width: 390, height: 844 })
      await waitForCardName(page, projectId, names.renamed)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      evidence.browser.mobileOverflowPx = overflow
      assert.ok(overflow <= 1, `W37 mobile overflows by ${overflow}px`)
      evidence.screenshots.push(await screenshot(page, evidenceDir, 'w37-mobile-after.png'))
      await page.setViewportSize({ width: 1440, height: 1000 })

      // --- stale baseRevision from another client -----------------------------------
      const feedHold = await holdFeedPoll(page)
      await feedHold.held
      await card.getByRole('button', { name: 'Renomear', exact: true }).click()
      await dialog.waitFor()
      assert.match(await dialog.innerText(), /revisão administrativa 2\b/)
      await dialog.getByLabel('Nome').fill(names.stale)
      const otherClient = await apiCall(baseUrl, {
        method: 'POST', path: posted.path, authorization, headers: { 'idempotency-key': `${prefix}-other-client` },
        body: { baseRevision: 2, name: names.other },
      })
      assert.equal(otherClient.status, 200, otherClient.text)
      assert.equal(otherClient.json.data.administration.revision, 3)
      const staleResponse = page.waitForResponse((response) => response.url().endsWith(posted.path) && response.request().method() === 'POST')
      await dialog.getByRole('button', { name: 'Salvar nome' }).click()
      const stale = await staleResponse
      feedHold.release()
      await feedHold.dispose()
      assert.equal(stale.status(), 409)
      const staleBody = await stale.json()
      assert.equal(staleBody.error.code, 'VERSION_CONFLICT')
      assert.equal(staleBody.error.category, 'conflict')
      const alert = dialog.getByRole('alert')
      await alert.waitFor()
      const alertText = (await alert.innerText()).trim()
      assert.ok(alertText.length > 0)
      const afterStale = await projectOracle(client, workspaceId, projectId)
      assert.equal(afterStale.project.name, names.other, 'the stale attempt did not overwrite the other client')
      assert.equal(afterStale.project.administrationRevision, 3)
      assert.equal(afterStale.administrationCommands.length, 2, 'the browser stale attempt wrote no command')
      assert.ok(afterStale.administrationCommands.every((item) => item.afterName !== names.stale))
      assert.equal(afterStale.events.length, 2)
      assert.notEqual((await cardSnapshot(page, projectId)).name, names.stale, 'the card never showed the refused name')
      await dialog.getByText(/revisão administrativa 3\b/).waitFor()
      await waitForCardName(page, projectId, names.other)
      evidence.screenshots.push(await screenshot(page, evidenceDir, 'w37-desktop-conflict-error.png'))
      pushCase(evidence, {
        id: 'stale-base-revision-other-client', timingAid: FEED_TIMING_AID,
        expected: { status: 409, code: 'VERSION_CONFLICT', persistedName: names.other, extraCommands: 0, errorVisibleInDialog: true },
        observed: { status: stale.status(), code: staleBody.error.code, category: staleBody.error.category, persistedName: afterStale.project.name, extraCommands: 0, errorVisibleInDialog: true, dialogRevisionAfterRefetch: 3 },
      })

      // Recovery: the same dialog now carries the live revision and succeeds.
      await dialog.getByLabel('Nome').fill(names.recovered)
      await dialog.getByRole('button', { name: 'Salvar nome' }).click()
      await dialog.waitFor({ state: 'hidden' })
      await waitForCardName(page, projectId, names.recovered)
      const afterRecovery = await projectOracle(client, workspaceId, projectId)
      assert.equal(afterRecovery.administrationCommands.length, 3)
      const recovered = afterRecovery.administrationCommands[2]
      assert.equal(recovered.baseRevision, 3)
      assert.equal(recovered.resultRevision, 4)
      assert.equal(recovered.afterName, names.recovered)
      assert.equal(recovered.actorAuthenticationKind, 'ui-session')
      assert.deepEqual(afterRecovery.administrationCommands.slice(0, 2), afterStale.administrationCommands, 'earlier command history is untouched')
      assert.deepEqual(afterRecovery.versions, before.versions)
      pushCase(evidence, { id: 'recovery-after-conflict', expected: { status: 200, baseRevision: 3, resultRevision: 4 }, observed: { status: 200, baseRevision: recovered.baseRevision, resultRevision: recovered.resultRevision, cardName: names.recovered } })

      const browserMutations = traffic.mutating()
      assert.deepEqual(
        browserMutations.map((item) => `${item.method} ${item.path}`),
        [`POST ${posted.path}`, `POST ${posted.path}`, `POST ${posted.path}`],
        'only the confirmed, the refused and the recovered rename were sent by the browser',
      )
      evidence.browser.mutatingRequests = browserMutations.length
      evidence.browser.requests = browserMutations.map(sanitizedRequest)

      // --- authentication, scope and isolation with this route's contract ----------
      const stateNow = async () => {
        const oracle = await projectOracle(client, workspaceId, projectId)
        return {
          digest: oracleDigest(oracle, ['project']), commands: oracle.administrationCommands.length,
          events: oracle.events.length, name: oracle.project.name, revision: oracle.project.administrationRevision,
        }
      }
      const baseline = await stateNow()
      const attempt = `${prefix}-nao-deve-gravar`
      const route = `/v1/projects/${projectId}/rename`
      const refusalCases = [
        { id: 'anonymous', request: { auth: 'none' }, call: {}, key: true, expect: { status: 401, code: 'AUTH_INVALID', category: 'auth' } },
        { id: 'invalid-bearer', request: { auth: 'invalid-bearer' }, call: { authorization: 'Bearer apollo_v2.not-a-real-credential' }, key: true, expect: { status: 401, code: 'AUTH_INVALID', category: 'auth' } },
        { id: 'session-without-origin', request: { auth: 'session-cookie-no-origin' }, call: { cookie }, key: true, expect: { status: 401, code: 'AUTH_INVALID', category: 'auth' } },
        { id: 'session-foreign-origin', request: { auth: 'session-cookie-foreign-origin' }, call: { cookie, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }, key: true, expect: { status: 401, code: 'AUTH_INVALID', category: 'auth' } },
        { id: 'insufficient-scope-read-only', request: { auth: 'bearer projects:read' }, call: { authorization: readOnlyAuthorization }, key: true, expect: { status: 403, code: 'AUTH_SCOPE_REQUIRED', category: 'auth' } },
        { id: 'other-workspace-isolation', request: { auth: 'bearer other workspace projects:write' }, call: { authorization: otherWorkspaceAuthorization }, key: true, expect: { status: 404, code: 'PROJECT_NOT_FOUND' } },
        { id: 'missing-idempotency-key', request: { auth: 'bearer projects:write' }, call: { authorization }, key: false, expect: { status: 422, code: 'INVALID_ARGUMENT' } },
        { id: 'unsupported-field', request: { auth: 'bearer projects:write' }, call: { authorization }, key: true, bodyExtra: { confirmed: true }, expect: { status: 422, code: 'INVALID_ARGUMENT' } },
        { id: 'unchanged-name', request: { auth: 'bearer projects:write' }, call: { authorization }, key: true, name: baseline.name, expect: { status: 422, code: 'INVALID_PROJECT' } },
      ]
      for (const item of refusalCases) {
        const body = { baseRevision: baseline.revision, name: item.name ?? attempt, ...(item.bodyExtra ?? {}) }
        const result = await apiCall(baseUrl, {
          method: 'POST', path: route, ...item.call,
          headers: { ...(item.key ? { 'idempotency-key': `${prefix}-refusal-${item.id}` } : {}), ...(item.call.headers ?? {}) },
          body,
        })
        const observed = assertRefusal(result, item.expect)
        assert.equal(result.text.includes(names.recovered), false, 'a refusal never discloses the project name')
        assert.deepEqual(await stateNow(), baseline, `${item.id} must not change the project`)
        pushCase(evidence, { id: item.id, request: { method: 'POST', path: '/v1/projects/{projectId}/rename', ...item.request }, expected: item.expect, observed, persistedUnchanged: true })
      }
      const unknown = await apiCall(baseUrl, {
        method: 'POST', path: `/v1/projects/w37-${tag}-does-not-exist/rename`, authorization,
        headers: { 'idempotency-key': `${prefix}-refusal-unknown` }, body: { baseRevision: 1, name: attempt },
      })
      pushCase(evidence, { id: 'unknown-project', request: { method: 'POST', path: '/v1/projects/{unknown}/rename', auth: 'bearer projects:write' }, expected: { status: 404, code: 'PROJECT_NOT_FOUND' }, observed: assertRefusal(unknown, { status: 404, code: 'PROJECT_NOT_FOUND' }), persistedUnchanged: true })
      assert.deepEqual(await stateNow(), baseline)
      evidence.final = {
        projectId, project: projectRowSummary((await projectOracle(client, workspaceId, projectId)).project),
        commands: (await projectOracle(client, workspaceId, projectId)).administrationCommands.map(commandSummary),
      }
    },
  })
}
