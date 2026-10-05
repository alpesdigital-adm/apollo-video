import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMPTY_PROJECT_DASHBOARD_FILTERS,
  hasProjectDashboardFilters,
  normalizeProjectDashboardFilters,
  projectDashboardApiSearch,
  projectDashboardUrlSearch,
  resolveProjectDashboardFilters,
} from '../../src/v2/ui/project-dashboard-filters.ts'

const complete = {
  text: 'Campanha agosto',
  status: 'reviewing-proxy',
  objective: 'lead-generation',
  format: '9:16',
  locale: 'pt-BR',
  createdFrom: '2026-08-01',
  createdTo: '2026-08-31',
  ownerId: 'owner-filter-001',
}

test('F1.002 dashboard filter codec canonicalizes every public facet', () => {
  const normalized = normalizeProjectDashboardFilters({
    ...complete,
    text: '  Campanha agosto  ',
  })
  assert.deepEqual(normalized, complete)
  assert.equal(Object.isFrozen(normalized), true)
  assert.equal(hasProjectDashboardFilters(normalized), true)
  assert.equal(hasProjectDashboardFilters(EMPTY_PROJECT_DASHBOARD_FILTERS), false)

  assert.deepEqual(normalizeProjectDashboardFilters({
    status: 'processing', objective: 'invented', format: '3:2', locale: 'pt_BR',
    createdFrom: '2026-02-31', createdTo: 'not-a-date', ownerId: '../owner',
    text: 'x'.repeat(121),
  }), EMPTY_PROJECT_DASHBOARD_FILTERS)
  assert.equal(normalizeProjectDashboardFilters({
    createdFrom: '2026-08-10', createdTo: '2026-08-09',
  }).createdTo, '')
})

test('F1.002 explicit URL filters take precedence while session is fallback only', () => {
  const stored = JSON.stringify(complete)
  assert.deepEqual(resolveProjectDashboardFilters({
    urlSearch: '', sessionValue: stored,
  }), complete)
  assert.deepEqual(resolveProjectDashboardFilters({
    urlSearch: '?status=completed', sessionValue: stored,
  }), { ...EMPTY_PROJECT_DASHBOARD_FILTERS, status: 'completed' })
  assert.deepEqual(resolveProjectDashboardFilters({
    urlSearch: '?status=', sessionValue: stored,
  }), EMPTY_PROJECT_DASHBOARD_FILTERS)
  assert.deepEqual(resolveProjectDashboardFilters({
    urlSearch: '', sessionValue: '{broken',
  }), EMPTY_PROJECT_DASHBOARD_FILTERS)
})

test('F1.002 URL and API serializers are stable and keep cursor bound to exact filters', () => {
  const urlSearch = projectDashboardUrlSearch(complete)
  assert.equal(
    urlSearch,
    '?text=Campanha+agosto&status=reviewing-proxy&objective=lead-generation&format=9%3A16&locale=pt-BR&createdFrom=2026-08-01&createdTo=2026-08-31&ownerId=owner-filter-001',
  )
  assert.deepEqual(resolveProjectDashboardFilters({ urlSearch }), complete)

  const api = new URLSearchParams(projectDashboardApiSearch(complete, {
    limit: 24,
    after: 'opaque-cursor-001',
  }))
  assert.equal(api.get('limit'), '24')
  assert.equal(api.get('createdFrom'), '2026-08-01T00:00:00.000Z')
  assert.equal(api.get('createdTo'), '2026-08-31T23:59:59.999Z')
  assert.equal(api.get('after'), 'opaque-cursor-001')
  assert.deepEqual(
    [...api.keys()],
    ['limit', 'text', 'status', 'objective', 'format', 'locale',
      'createdFrom', 'createdTo', 'ownerId', 'after'],
  )
})

const FACETS = ['text', 'status', 'objective', 'format', 'locale', 'createdFrom', 'createdTo', 'ownerId']

test('W31 each of the eight facets round-trips alone through URL, API and the session fallback', () => {
  for (const facet of FACETS) {
    const single = { ...EMPTY_PROJECT_DASHBOARD_FILTERS, [facet]: complete[facet] }
    const urlSearch = projectDashboardUrlSearch(single)
    assert.deepEqual([...new URLSearchParams(urlSearch).keys()], [facet], facet)
    assert.deepEqual(resolveProjectDashboardFilters({ urlSearch }), single, facet)
    assert.deepEqual(resolveProjectDashboardFilters({ urlSearch: '', sessionValue: JSON.stringify(single) }), single, facet)
    const api = new URLSearchParams(projectDashboardApiSearch(single, { limit: 24 }))
    assert.deepEqual([...api.keys()], ['limit', facet], facet)
    assert.equal(hasProjectDashboardFilters(single), true, facet)
  }
})

test('W31 date range is inclusive in UTC and the API request carries the normalized day limits', () => {
  const sameDay = { ...EMPTY_PROJECT_DASHBOARD_FILTERS, createdFrom: '2026-02-10', createdTo: '2026-02-10' }
  assert.deepEqual(normalizeProjectDashboardFilters(sameDay), sameDay)
  const api = new URLSearchParams(projectDashboardApiSearch(sameDay, { limit: 24 }))
  assert.equal(api.get('createdFrom'), '2026-02-10T00:00:00.000Z')
  assert.equal(api.get('createdTo'), '2026-02-10T23:59:59.999Z')
  assert.equal(Date.parse(api.get('createdTo')) - Date.parse(api.get('createdFrom')), 24 * 60 * 60 * 1000 - 1)
  // A date-time pasted in the URL is reduced to its leading calendar day, never shifted.
  assert.equal(normalizeProjectDashboardFilters({ createdFrom: '2026-02-10T23:30:00-03:00' }).createdFrom, '2026-02-10')
  assert.equal(normalizeProjectDashboardFilters({ createdTo: '2026-02-29' }).createdTo, '')
  assert.equal(normalizeProjectDashboardFilters({ createdFrom: '2028-02-29' }).createdFrom, '2028-02-29')
})

test('W31 an invalid facet is dropped without discarding the other valid facets', () => {
  const mixed = normalizeProjectDashboardFilters({
    ...complete, status: 'processing', format: '3:2', createdTo: '2026-07-31',
  })
  assert.deepEqual(mixed, { ...complete, status: '', format: '', createdTo: '' })
  assert.equal(
    projectDashboardUrlSearch(mixed),
    '?text=Campanha+agosto&objective=lead-generation&locale=pt-BR&createdFrom=2026-08-01&ownerId=owner-filter-001',
  )
  // The explicit URL carries a divergent invalid value: it still wins over the session fallback.
  assert.deepEqual(resolveProjectDashboardFilters({
    urlSearch: '?status=bogus&locale=en-US', sessionValue: JSON.stringify(complete),
  }), { ...EMPTY_PROJECT_DASHBOARD_FILTERS, locale: 'en-US' })
})
