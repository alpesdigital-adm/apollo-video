import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const SCREENSHOTS = ['w35-desktop-states.png', 'w35-mobile-states.png', 'w35-desktop-empty.png', 'w35-mobile-empty.png']
const ORIGINS = new Set(['real-api', 'controlled-pg-seed', 'absent'])

// Pinned independently of the component: label, tone, primary action, button text.
const PINNED = {
  'w35-draft': { status: 'draft', badge: 'Configuração', tone: 'neutral', action: 'open-result', button: 'Abrir workspace →', statusOrigin: 'real-api', operation: null },
  'w35-queued': { status: 'rendering-proxy', badge: 'Renderizando proxy', tone: 'info', action: 'view-progress', button: 'Acompanhar →', statusOrigin: 'controlled-pg-seed', operation: { phase: 'Na fila', percent: 0 } },
  'w35-processing-25': { status: 'rendering-proxy', badge: 'Renderizando proxy', tone: 'info', action: 'view-progress', button: 'Acompanhar →', statusOrigin: 'controlled-pg-seed', operation: { phase: 'Renderizando', percent: 25 } },
  'w35-processing-75': { status: 'rendering-final', badge: 'Exportando final', tone: 'info', action: 'view-progress', button: 'Acompanhar →', statusOrigin: 'controlled-pg-seed', operation: { phase: 'Salvando resultado', percent: 75 } },
  'w35-unmeasured': { status: 'rendering-proxy', badge: 'Renderizando proxy', tone: 'info', action: 'view-progress', button: 'Acompanhar →', statusOrigin: 'controlled-pg-seed', operation: { phase: 'Renderizando', percent: null } },
  'w35-review': { status: 'reviewing-proxy', badge: 'Revisar proxy', tone: 'warning', action: 'review-output', button: 'Revisar agora →', statusOrigin: 'controlled-pg-seed', operation: { phase: 'Etapa concluída', percent: 100 } },
  'w35-failed': { status: 'failed', badge: 'Requer atenção', tone: 'danger', action: 'inspect-error', button: 'Ver erro →', statusOrigin: 'controlled-pg-seed', operation: { phase: 'Etapa com falha', percent: 50 } },
  'w35-completed': { status: 'completed', badge: 'Concluído', tone: 'success', action: 'open-result', button: 'Abrir workspace →', statusOrigin: 'controlled-pg-seed', operation: { phase: 'Etapa concluída', percent: 100 } },
  'w35-archived': { status: 'archived', badge: 'Arquivado', tone: 'neutral', action: 'inspect-history', button: 'Ver histórico →', statusOrigin: 'real-api', operation: null },
}

export function verifyW35Evidence(directory, { sourceCommit, ciRunId, applicationName }) {
  assert.match(sourceCommit, /^[a-f0-9]{40}$/)
  assert.match(ciRunId, /^\d+$/)
  assert.match(applicationName, /^apollo-video-e2e-[A-Za-z0-9-]+$/)
  const manifest = JSON.parse(readFileSync(join(directory, 'w35-manifest.json'), 'utf8'))
  assert.equal(manifest.schemaVersion, 'w35-dashboard-states/v1')
  assert.equal(manifest.outcome, 'passed')
  assert.equal(manifest.sourceCommit, sourceCommit)
  assert.equal(manifest.ciRunId, ciRunId)
  assert.equal(manifest.database?.applicationName, applicationName)
  assert.match(manifest.runId, /^[a-f0-9-]{36}$/)
  assert.equal(manifest.browser?.pid > 0, true)
  assert.equal(manifest.postflight?.browserProcessTerminal, true)
  assert.deepEqual(manifest.postflight?.cleanupErrors, [])
  assert.equal(manifest.browser?.mutatingRequests, 0)
  assert.equal(manifest.browser?.mobileOverflowPx <= 1, true)
  assert.equal(manifest.browser?.desktopOverflowPx <= 1, true)
  assert.deepEqual(manifest.filter, { text: 'w35-' })
  for (const viewport of ['desktop', 'mobile']) {
    assert.equal(manifest.requests?.[viewport]?.mutating, 0)
    assert.ok(manifest.requests?.[viewport]?.projectGets >= 1)
  }
  assert.deepEqual(manifest.counts?.after, manifest.counts?.before)
  assert.ok(Array.isArray(manifest.gaps) && manifest.gaps.length >= 1, 'the manifest must keep its documented gaps')
  assert.deepEqual(manifest.states?.map((item) => item.name).sort(), Object.keys(PINNED).sort())
  assert.deepEqual(manifest.tiles?.map((tile) => tile.value), [1, 4, 1, 1])
  assert.deepEqual(manifest.expectedOrder?.slice().sort(), manifest.states.map((item) => item.projectId).sort())

  const realStates = new Set()
  for (const state of manifest.states) {
    const pinned = PINNED[state.name]
    assert.equal(state.status, pinned.status)
    assert.deepEqual(state.api, state.persisted, `${state.name}: API projection must equal the PostgreSQL rows`)
    assert.equal(state.visibleState.schemaVersion, 'visible-state/v1')
    assert.equal(state.visibleState.tone, pinned.tone)
    assert.equal(state.visibleState.primaryAction, pinned.action)
    assert.equal(state.expectedCard.badgeText, pinned.badge)
    assert.equal(state.expectedCard.primaryButton, pinned.button)
    assert.ok(ORIGINS.has(state.origins?.status?.origin), `${state.name}: status origin must be labelled`)
    assert.ok(ORIGINS.has(state.origins?.latestOperation?.origin), `${state.name}: operation origin must be labelled`)
    assert.equal(state.origins.worker.origin, 'absent')
    assert.equal(state.origins.status.origin, pinned.statusOrigin)
    if (state.origins.status.origin === 'real-api') realStates.add(state.name)
    for (const viewport of ['desktop', 'mobile']) {
      const card = state.card?.[viewport]
      assert.equal(card?.id, state.projectId)
      assert.equal(card.state, state.visibleState.label)
      assert.equal(card.badgeText, pinned.badge)
      assert.ok(card.buttons.some((button) => button.text === pinned.button && button.disabled === false))
      assert.equal(card.phase, pinned.operation ? pinned.operation.phase : 'Nenhuma operação iniciada')
      if (pinned.operation === null) {
        assert.equal(card.measure, null)
        assert.equal(card.bar, null)
        assert.deepEqual(card.percentTexts, [])
      } else if (pinned.operation.percent === null) {
        assert.equal(card.measure, 'sem total medido')
        assert.equal(card.bar, null)
        assert.deepEqual(card.percentTexts, [])
      } else {
        assert.equal(card.measure, `${pinned.operation.percent}%`)
        assert.equal(card.bar?.now, String(pinned.operation.percent))
        assert.equal(card.bar?.width, `width: ${pinned.operation.percent}%;`)
        assert.deepEqual(card.percentTexts, [`${pinned.operation.percent}%`])
      }
    }
    assert.equal(state.destination?.primary?.pathname, `/projects/${state.projectId}`)
    assert.equal(state.destination.primary.search, '')
    assert.equal(state.destination.primary.button, pinned.button)
  }
  assert.deepEqual([...realStates].sort(), ['w35-archived', 'w35-draft'])
  const byName = Object.fromEntries(manifest.states.map((item) => [item.name, item]))
  assert.deepEqual(byName['w35-review'].destination.review, { button: 'Revisar', pathname: `/projects/${byName['w35-review'].projectId}`, search: '?mode=review' })
  assert.equal(byName['w35-review'].persisted.openReviewIssueCount, 1)
  assert.deepEqual(byName['w35-failed'].persisted.latestOperation.error, { code: 'render-failed', retryable: true })
  assert.equal(byName['w35-failed'].card.desktop.error, 'render-failed · recuperável')
  assert.equal(byName['w35-completed'].persisted.outputCount, 1)
  assert.equal(byName['w35-archived'].persisted.archivedFromStatus, 'draft')
  assert.equal(byName['w35-archived'].persisted.administrationRevision, 2)
  assert.deepEqual(byName['w35-unmeasured'].persisted.latestOperation.progress, { completed: 1 })
  assert.deepEqual(byName['w35-processing-25'].persisted.latestOperation.progress, { completed: 1, total: 4, unit: 'render' })
  assert.deepEqual(byName['w35-processing-75'].persisted.latestOperation.progress, { completed: 3, total: 4, unit: 'render' })

  assert.equal(manifest.empty?.persistedProjects, 0)
  assert.equal(manifest.empty?.apiProjects, 0)
  assert.equal(manifest.empty?.origin?.origin, 'real-api')
  for (const viewport of ['desktop', 'mobile']) {
    assert.ok(manifest.empty?.[viewport]?.overflowPx <= 1)
    assert.deepEqual(manifest.empty[viewport].tiles, [0, 0, 0, 0])
  }
  assert.deepEqual(manifest.screenshots?.map((item) => item.name), SCREENSHOTS)
  for (const shot of manifest.screenshots) {
    assert.match(shot.sha256, /^[a-f0-9]{64}$/)
    const bytes = readFileSync(join(directory, shot.name))
    assert.ok(bytes.length > 100)
    assert.equal(bytes.length, shot.bytes)
    assert.equal(hash(bytes), shot.sha256)
  }
  return { sourceCommit, ciRunId, applicationName, runId: manifest.runId }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    verifyW35Evidence(process.argv[2], {
      sourceCommit: process.env.GITHUB_SHA,
      ciRunId: process.env.GITHUB_RUN_ID,
      applicationName: process.env.APOLLO_PUBLIC_API_APP_NAME,
    })
  } catch (error) {
    process.stderr.write(`W35 evidence rejected: ${error?.name ?? 'Error'}\n`)
    process.exitCode = 1
  }
}
