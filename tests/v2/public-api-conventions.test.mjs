import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  PUBLIC_API_CONVENTIONS,
  PUBLIC_API_VERSION,
  PUBLIC_DATE_TIME_SCHEMA,
  PUBLIC_FRAME_SCHEMA,
  PUBLIC_ID_SCHEMA,
  assertAllowlistedPublicQuery,
  assertPublicJsonValue,
  publicDateTime,
  publicFrame,
  publicIdentifier,
} from '../../src/v2/public-api/conventions.ts'
import { presentSuccess } from '../../src/v2/public-api/presenters.ts'

function rejects(callback) {
  assert.throws(callback, (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT')
}

test('T-FR-241 /v1 JSON, identifier, UTC and frame conventions are canonical', () => {
  assert.equal(PUBLIC_API_VERSION, 'v1')
  assert.equal(PUBLIC_API_CONVENTIONS.basePath, '/v1')
  assert.equal(PUBLIC_API_CONVENTIONS.json.mediaType, 'application/json')
  assert.equal(PUBLIC_API_CONVENTIONS.json.charset, 'utf-8')
  assert.equal(PUBLIC_API_CONVENTIONS.frame.interval, 'half-open')
  assert.equal(PUBLIC_API_CONVENTIONS.frame.secondsForEditorialTiming, false)
  assert.deepEqual(PUBLIC_ID_SCHEMA, { type: 'string', minLength: 3, maxLength: 128 })
  assert.deepEqual(PUBLIC_DATE_TIME_SCHEMA, { type: 'string', format: 'date-time' })
  assert.deepEqual(PUBLIC_FRAME_SCHEMA, { type: 'integer', minimum: 0 })
  assert.equal(presentSuccess({ ok: true }).meta.apiVersion, 'v1')

  assert.equal(publicIdentifier('project-123'), 'project-123')
  for (const value of ['', ' id', 'id', 'id/unsafe', 'x'.repeat(129)]) rejects(() => publicIdentifier(value))

  assert.equal(publicDateTime('2026-08-03T12:34:56.789Z'), '2026-08-03T12:34:56.789Z')
  for (const value of ['2026-08-03', '2026-08-03T12:34:56+00:00', 'not-a-date']) {
    rejects(() => publicDateTime(value))
  }

  assert.equal(publicFrame(0), 0)
  assert.equal(publicFrame(30), 30)
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '30']) rejects(() => publicFrame(value))
})

test('T-FR-241 public JSON and query filters fail closed', () => {
  assert.doesNotThrow(() => assertPublicJsonValue({ id: 'project-1', frames: [0, 30], value: null }))
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date()]) {
    rejects(() => assertPublicJsonValue(value))
  }
  rejects(() => assertPublicJsonValue({ hidden: undefined }))

  const query = assertAllowlistedPublicQuery(
    new URLSearchParams('limit=20&after=opaque-cursor'),
    new Set(['limit', 'after']),
  )
  assert.deepEqual({ ...query }, { limit: '20', after: 'opaque-cursor' })
  rejects(() => assertAllowlistedPublicQuery(new URLSearchParams('sql=drop'), new Set(['limit'])))
  rejects(() => assertAllowlistedPublicQuery(new URLSearchParams('limit=1&limit=2'), new Set(['limit'])))
})
