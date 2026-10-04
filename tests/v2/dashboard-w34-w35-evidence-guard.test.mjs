import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyW34Evidence } from './helpers/dashboard-w34-evidence-guard.mjs'
import { verifyW35Evidence } from './helpers/dashboard-w35-evidence-guard.mjs'

const commit = 'a'.repeat(40)
const context = { sourceCommit: commit, ciRunId: '1234', applicationName: 'apollo-video-e2e-w29-ci' }
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const clone = (value) => structuredClone(value)

function counts() {
  return {
    projects: 9, versions: 10, editCommands: 4, creationCommands: 9, administrationCommands: 1,
    publicOperations: 7, reviewAnnotations: 6, finalExportOperations: 4,
  }
}

function writeShots(directory, names) {
  const bytes = Buffer.alloc(160, 7)
  return names.map((name) => {
    writeFileSync(join(directory, name), bytes)
    return { name, sha256: sha(bytes), bytes: bytes.length }
  })
}

function operation(id, status, phase, progress, extra = {}) {
  return { id, type: 'project-proxy-render', status, phase, ...(progress ? { progress } : {}), updatedAt: '2026-10-04T12:00:00.000Z', ...extra }
}

function dashboard(overrides = {}) {
  return {
    schemaVersion: 'project-dashboard-summary/v2',
    currentVersion: { id: 'version-1', sequence: 1, createdAt: '2026-10-04T11:00:00.000Z' },
    latestOperation: null, openReviewIssueCount: 0, outputs: [], outputCount: 0,
    lastActivityAt: '2026-10-04T12:00:00.000Z', administrationRevision: 1, archivedFromStatus: null,
    ...overrides,
  }
}

const origins = (overrides = {}) => ({
  project: { origin: 'real-api' }, currentVersion: { origin: 'real-api' },
  latestOperation: { origin: 'absent' }, openReviewIssues: { origin: 'absent' },
  outputs: { origin: 'absent' }, administration: { origin: 'real-api' }, ...overrides,
})

function card(id, name, state, badgeText, facts, phase, measure, extra = {}) {
  return {
    id, name, state, badgeText, facts, phase, measure, error: null, bar: null,
    percentTexts: [], buttons: [], ...extra,
  }
}

// ---------------------------------------------------------------------------
// W34
// ---------------------------------------------------------------------------

function w34Manifest(directory) {
  const specs = [
    ['w34-bare', 'draft', 'Configuração', dashboard(), origins(), null],
    ['w34-versioned', 'rendering-proxy', 'Renderizando proxy', dashboard({
      currentVersion: { id: 'version-2', sequence: 2, createdAt: '2026-10-04T11:00:00.000Z' },
      latestOperation: operation('w34-versioned-op-new', 'running', 'rendering', { completed: 1, total: 4, unit: 'render' }),
      openReviewIssueCount: 2,
    }), origins({ latestOperation: { origin: 'controlled-pg-seed' }, openReviewIssues: { origin: 'controlled-pg-seed' } }), { phase: 'Renderizando', measure: '25%', percent: 25 }],
    ['w34-complete', 'completed', 'Concluído', dashboard({
      currentVersion: { id: 'version-2', sequence: 2, createdAt: '2026-10-04T11:00:00.000Z' },
      latestOperation: operation('w34-complete-v2-final-operation-3', 'succeeded', 'completed', { completed: 4, total: 4, unit: 'render' }, { type: 'project-final-export' }),
      outputs: [{ artifactId: 'artifact-a', aspectRatio: '16:9' }, { artifactId: 'artifact-b', aspectRatio: '9:16' }], outputCount: 2,
    }), origins({ latestOperation: { origin: 'controlled-pg-seed' }, outputs: { origin: 'controlled-pg-seed' } }), { phase: 'Etapa concluída', measure: '100%', percent: 100 }],
    ['w34-failed-op', 'failed', 'Requer atenção', dashboard({
      latestOperation: operation('w34-failed-op-op', 'failed', 'failed', { completed: 2, total: 4, unit: 'render' }, { error: { code: 'render-failed', retryable: true } }),
    }), origins({ latestOperation: { origin: 'controlled-pg-seed' } }), { phase: 'Etapa com falha', measure: '50%', percent: 50, error: 'render-failed · recuperável' }],
    ['w34-unmeasured', 'rendering-proxy', 'Renderizando proxy', dashboard({
      latestOperation: operation('w34-unmeasured-op', 'running', 'rendering', { completed: 1 }),
    }), origins({ latestOperation: { origin: 'controlled-pg-seed' } }), { phase: 'Renderizando', measure: 'sem total medido', percent: null }],
    ['w34-archived', 'archived', 'Arquivado', dashboard({ administrationRevision: 2, archivedFromStatus: 'draft' }),
      origins({ administration: { origin: 'real-api' } }), null],
  ]
  const fixtures = specs.map(([name, state, badgeText, persisted, fixtureOrigins, view], index) => {
    const projectId = `project-${index}`
    const facts = {
      Versão: `v${persisted.currentVersion.sequence}`,
      Pendências: String(persisted.openReviewIssueCount), Outputs: String(persisted.outputCount),
    }
    const phase = view?.phase ?? 'Nenhuma operação iniciada'
    const measure = view ? view.measure : null
    const extra = view?.percent == null
      ? {}
      : { percentTexts: [`${view.percent}%`], bar: { now: String(view.percent), width: `width: ${view.percent}%;` } }
    const observed = card(projectId, name, state, badgeText, facts, phase, measure, { ...extra, error: view?.error ?? null })
    return {
      name, projectId, origins: fixtureOrigins, persisted, api: clone(persisted),
      project: { id: projectId, name, status: state },
      card: { desktop: clone(observed), mobile: clone(observed) },
      expectedCard: { state, badgeText, facts, phase, measure, error: view?.error ?? null },
    }
  })
  const manifest = {
    schemaVersion: 'w34-dashboard-aggregate/v1', outcome: 'passed', sourceCommit: commit, ciRunId: '1234',
    runId: '11111111-1111-4111-8111-111111111111',
    database: { applicationName: context.applicationName },
    filter: { text: 'w34-' },
    browser: { pid: 321, mutatingRequests: 0, mobileOverflowPx: 0, desktopOverflowPx: 0 },
    postflight: { browserProcessTerminal: true, cleanupErrors: [] },
    counts: { before: counts(), after: counts() },
    requests: { desktop: { projectGets: 1, mutating: 0 }, mobile: { projectGets: 1, mutating: 0 } },
    tiles: [{ value: 1 }, { value: 2 }, { value: 0 }, { value: 1 }],
    expectedOrder: fixtures.map((item) => item.projectId).reverse(),
    fixtures,
    screenshots: writeShots(directory, ['w34-desktop-aggregate.png', 'w34-mobile-aggregate.png']),
  }
  return manifest
}

function saveW34(directory, manifest) {
  writeFileSync(join(directory, 'w34-manifest.json'), JSON.stringify(manifest))
}

test('W34 guard accepts a coherent manifest and binds it to the commit, run and application', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-w34-guard-'))
  const manifest = w34Manifest(directory)
  saveW34(directory, manifest)
  assert.equal(verifyW34Evidence(directory, context).sourceCommit, commit)
  for (const [key, bad] of [
    ['sourceCommit', 'b'.repeat(40)], ['ciRunId', '9999'], ['applicationName', 'apollo-video-e2e-other'],
  ]) {
    assert.throws(() => verifyW34Evidence(directory, { ...context, [key]: bad }), undefined, key)
  }
})

test('W34 guard rejects every drift between PostgreSQL rows, API projection, card and provenance', () => {
  const mutations = {
    'API differs from the persisted rows': (m) => { m.fixtures[2].api.outputCount = 3 },
    'bare version invented': (m) => { m.fixtures[0].persisted.currentVersion.sequence = 2; m.fixtures[0].api.currentVersion.sequence = 2 },
    'bare operation invented': (m) => { m.fixtures[0].persisted.latestOperation = operation('x', 'queued', 'queued', { completed: 0, total: 4 }); m.fixtures[0].api = clone(m.fixtures[0].persisted) },
    'older operation wins': (m) => { m.fixtures[1].persisted.latestOperation.id = 'w34-versioned-op-old'; m.fixtures[1].api = clone(m.fixtures[1].persisted) },
    'superseded annotation counted': (m) => { m.fixtures[1].persisted.openReviewIssueCount = 3; m.fixtures[1].api = clone(m.fixtures[1].persisted) },
    'failed export counted as output': (m) => { m.fixtures[2].persisted.outputs.push({ artifactId: 'artifact-c', aspectRatio: '1:1' }); m.fixtures[2].persisted.outputCount = 3; m.fixtures[2].api = clone(m.fixtures[2].persisted) },
    'error code lost': (m) => { m.fixtures[3].persisted.latestOperation.error = { code: 'other', retryable: true }; m.fixtures[3].api = clone(m.fixtures[3].persisted) },
    'unmeasured operation gains a total': (m) => { m.fixtures[4].persisted.latestOperation.progress = { completed: 1, total: 4, unit: 'render' }; m.fixtures[4].api = clone(m.fixtures[4].persisted) },
    'unmeasured card shows a bar': (m) => { m.fixtures[4].card.desktop.bar = { now: '25', width: 'width: 25%;' } },
    'archived fence lost': (m) => { m.fixtures[5].persisted.archivedFromStatus = null; m.fixtures[5].api = clone(m.fixtures[5].persisted) },
    'card facts drift': (m) => { m.fixtures[1].card.mobile.facts.Pendências = '9' },
    'card phase drift': (m) => { m.fixtures[1].card.desktop.phase = 'Na fila' },
    'unlabelled provenance': (m) => { delete m.fixtures[2].origins.outputs },
    'every relation is only seeded': (m) => { for (const fixture of m.fixtures) for (const key of Object.keys(fixture.origins)) fixture.origins[key] = { origin: 'controlled-pg-seed' } },
    'mutating requests': (m) => { m.requests.mobile.mutating = 1 },
    'database state changed': (m) => { m.counts.after.projects += 1 },
    'visible counters are not the loaded results': (m) => { m.tiles[0].value = 99 },
    'browser not terminal': (m) => { m.postflight.browserProcessTerminal = false },
    'mobile overflow': (m) => { m.browser.mobileOverflowPx = 12 },
    'missing fixture': (m) => { m.fixtures.pop() },
  }
  for (const [label, mutate] of Object.entries(mutations)) {
    const directory = mkdtempSync(join(tmpdir(), 'apollo-w34-guard-'))
    const manifest = w34Manifest(directory)
    mutate(manifest)
    saveW34(directory, manifest)
    assert.throws(() => verifyW34Evidence(directory, context), undefined, label)
  }
  const directory = mkdtempSync(join(tmpdir(), 'apollo-w34-guard-'))
  const manifest = w34Manifest(directory)
  saveW34(directory, manifest)
  writeFileSync(join(directory, 'w34-mobile-aggregate.png'), Buffer.alloc(160, 1))
  assert.throws(() => verifyW34Evidence(directory, context), undefined, 'a tampered screenshot hash')
})

// ---------------------------------------------------------------------------
// W35
// ---------------------------------------------------------------------------

const STATES = [
  ['w35-draft', 'draft', 'Configuração', 'neutral', 'open-result', 'Abrir workspace →', 'real-api', null],
  ['w35-queued', 'rendering-proxy', 'Renderizando proxy', 'info', 'view-progress', 'Acompanhar →', 'controlled-pg-seed', { phase: 'Na fila', percent: 0, op: { completed: 0, total: 4, unit: 'render' } }],
  ['w35-processing-25', 'rendering-proxy', 'Renderizando proxy', 'info', 'view-progress', 'Acompanhar →', 'controlled-pg-seed', { phase: 'Renderizando', percent: 25, op: { completed: 1, total: 4, unit: 'render' } }],
  ['w35-processing-75', 'rendering-final', 'Exportando final', 'info', 'view-progress', 'Acompanhar →', 'controlled-pg-seed', { phase: 'Salvando resultado', percent: 75, op: { completed: 3, total: 4, unit: 'render' } }],
  ['w35-unmeasured', 'rendering-proxy', 'Renderizando proxy', 'info', 'view-progress', 'Acompanhar →', 'controlled-pg-seed', { phase: 'Renderizando', percent: null, op: { completed: 1 } }],
  ['w35-review', 'reviewing-proxy', 'Revisar proxy', 'warning', 'review-output', 'Revisar agora →', 'controlled-pg-seed', { phase: 'Etapa concluída', percent: 100, op: { completed: 4, total: 4, unit: 'render' } }],
  ['w35-failed', 'failed', 'Requer atenção', 'danger', 'inspect-error', 'Ver erro →', 'controlled-pg-seed', { phase: 'Etapa com falha', percent: 50, op: { completed: 2, total: 4, unit: 'render' } }],
  ['w35-completed', 'completed', 'Concluído', 'success', 'open-result', 'Abrir workspace →', 'controlled-pg-seed', { phase: 'Etapa concluída', percent: 100, op: { completed: 4, total: 4, unit: 'render' } }],
  ['w35-archived', 'archived', 'Arquivado', 'neutral', 'inspect-history', 'Ver histórico →', 'real-api', null],
]

function w35Manifest(directory) {
  const states = STATES.map(([name, status, badge, tone, action, button, statusOrigin, view], index) => {
    const projectId = `project-${index}`
    const persisted = dashboard({
      ...(view ? { latestOperation: operation(`${name}-op`, view.phase === 'Etapa com falha' ? 'failed' : 'running', 'rendering', view.op, view.phase === 'Etapa com falha' ? { error: { code: 'render-failed', retryable: true } } : {}) } : {}),
      ...(name === 'w35-review' ? { openReviewIssueCount: 1 } : {}),
      ...(name === 'w35-completed' ? { outputs: [{ artifactId: 'artifact-a', aspectRatio: '9:16' }], outputCount: 1 } : {}),
      ...(name === 'w35-archived' ? { administrationRevision: 2, archivedFromStatus: 'draft' } : {}),
    })
    const measure = view ? (view.percent === null ? 'sem total medido' : `${view.percent}%`) : null
    const extra = view?.percent == null
      ? {}
      : { percentTexts: [`${view.percent}%`], bar: { now: String(view.percent), width: `width: ${view.percent}%;` } }
    const observed = card(projectId, name, status, badge, {}, view?.phase ?? 'Nenhuma operação iniciada', measure, {
      ...extra, buttons: [{ text: button, disabled: false }],
      error: name === 'w35-failed' ? 'render-failed · recuperável' : null,
    })
    return {
      name, projectId, status,
      origins: {
        project: { origin: 'real-api' }, status: { origin: statusOrigin },
        latestOperation: { origin: view ? 'controlled-pg-seed' : 'absent' }, worker: { origin: 'absent' },
      },
      persisted, api: clone(persisted),
      visibleState: { schemaVersion: 'visible-state/v1', label: status, tone, primaryAction: action },
      expectedCard: { badgeText: badge, primaryButton: button },
      destination: {
        primary: { button, pathname: `/projects/${projectId}`, search: '' },
        ...(name === 'w35-review' ? { review: { button: 'Revisar', pathname: `/projects/${projectId}`, search: '?mode=review' } } : {}),
      },
      card: { desktop: clone(observed), mobile: clone(observed) },
    }
  })
  states.find((item) => item.name === 'w35-processing-75').status = 'rendering-final'
  return {
    schemaVersion: 'w35-dashboard-states/v1', outcome: 'passed', sourceCommit: commit, ciRunId: '1234',
    runId: '22222222-2222-4222-8222-222222222222',
    database: { applicationName: context.applicationName },
    filter: { text: 'w35-' },
    browser: { pid: 654, mutatingRequests: 0, mobileOverflowPx: 0, desktopOverflowPx: 0 },
    postflight: { browserProcessTerminal: true, cleanupErrors: [] },
    counts: { before: counts(), after: counts() },
    requests: { desktop: { projectGets: 12, mutating: 0 }, mobile: { projectGets: 1, mutating: 0 } },
    tiles: [{ value: 1 }, { value: 4 }, { value: 1 }, { value: 1 }],
    expectedOrder: states.map((item) => item.projectId).reverse(),
    states,
    empty: {
      persistedProjects: 0, apiProjects: 0, origin: { origin: 'real-api' },
      desktop: { overflowPx: 0, tiles: [0, 0, 0, 0] }, mobile: { overflowPx: 0, tiles: [0, 0, 0, 0] },
    },
    gaps: ['no worker transition'],
    screenshots: writeShots(directory, ['w35-desktop-states.png', 'w35-mobile-states.png', 'w35-desktop-empty.png', 'w35-mobile-empty.png']),
  }
}

function saveW35(directory, manifest) {
  writeFileSync(join(directory, 'w35-manifest.json'), JSON.stringify(manifest))
}

test('W35 guard accepts a coherent manifest and binds it to the commit, run and application', () => {
  const directory = mkdtempSync(join(tmpdir(), 'apollo-w35-guard-'))
  saveW35(directory, w35Manifest(directory))
  assert.equal(verifyW35Evidence(directory, context).sourceCommit, commit)
  for (const [key, bad] of [
    ['sourceCommit', 'b'.repeat(40)], ['ciRunId', '9999'], ['applicationName', 'apollo-video-e2e-other'],
  ]) {
    assert.throws(() => verifyW35Evidence(directory, { ...context, [key]: bad }), undefined, key)
  }
})

test('W35 guard rejects wrong label, tone, action, destination, progress, provenance and empty state', () => {
  const state = (manifest, name) => manifest.states.find((item) => item.name === name)
  const mutations = {
    'wrong visible label': (m) => { state(m, 'w35-failed').visibleState.label = 'completed' },
    'wrong tone': (m) => { state(m, 'w35-review').visibleState.tone = 'info' },
    'wrong primary action': (m) => { state(m, 'w35-failed').visibleState.primaryAction = 'open-result' },
    'wrong button': (m) => { state(m, 'w35-completed').expectedCard.primaryButton = 'Acompanhar →' },
    'card badge drift': (m) => { state(m, 'w35-archived').card.mobile.badgeText = 'Concluído' },
    'primary destination drift': (m) => { state(m, 'w35-draft').destination.primary.pathname = '/projects/other' },
    'review destination lost': (m) => { delete state(m, 'w35-review').destination.review },
    'unmeasured shows a bar': (m) => { state(m, 'w35-unmeasured').card.desktop.bar = { now: '10', width: 'width: 10%;' } },
    'unmeasured shows a percentage': (m) => { state(m, 'w35-unmeasured').card.mobile.percentTexts = ['10%'] },
    'measured shows the wrong number': (m) => { state(m, 'w35-processing-25').card.desktop.bar.now = '40' },
    'measured shows no bar': (m) => { state(m, 'w35-processing-75').card.desktop.bar = null },
    'bar without an operation': (m) => { state(m, 'w35-draft').card.desktop.bar = { now: '0', width: 'width: 0%;' } },
    'API differs from the rows': (m) => { state(m, 'w35-failed').api.latestOperation.progress.completed = 3 },
    'status provenance claims a real transition': (m) => { state(m, 'w35-review').origins.status.origin = 'real-api' },
    'a worker is claimed': (m) => { state(m, 'w35-review').origins.worker.origin = 'real-api' },
    'archived is not a real API state': (m) => { state(m, 'w35-archived').origins.status.origin = 'controlled-pg-seed' },
    'gaps hidden': (m) => { m.gaps = [] },
    'empty workspace has projects': (m) => { m.empty.persistedProjects = 1 },
    'empty state overflows on mobile': (m) => { m.empty.mobile.overflowPx = 30 },
    'mutating requests': (m) => { m.requests.desktop.mutating = 1 },
    'database state changed': (m) => { m.counts.after.reviewAnnotations += 1 },
    'missing state': (m) => { m.states.pop() },
    'browser not terminal': (m) => { m.postflight.browserProcessTerminal = false },
  }
  for (const [label, mutate] of Object.entries(mutations)) {
    const directory = mkdtempSync(join(tmpdir(), 'apollo-w35-guard-'))
    const manifest = w35Manifest(directory)
    mutate(manifest)
    saveW35(directory, manifest)
    assert.throws(() => verifyW35Evidence(directory, context), undefined, label)
  }
  const directory = mkdtempSync(join(tmpdir(), 'apollo-w35-guard-'))
  saveW35(directory, w35Manifest(directory))
  writeFileSync(join(directory, 'w35-desktop-empty.png'), Buffer.alloc(160, 1))
  assert.throws(() => verifyW35Evidence(directory, context), undefined, 'a tampered screenshot hash')
})
