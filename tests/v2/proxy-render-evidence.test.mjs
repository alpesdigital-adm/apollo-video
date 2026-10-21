import assert from 'node:assert/strict'
import test from 'node:test'

import {
  proxyDirectorCriticIssuesDigest, proxyFaceEvidenceDigest, recordingFaceEvidenceReader,
} from '../../src/v2/application/proxy-render-evidence.ts'

/**
 * W70 readiness (R2). The digests of what a proxy's content address cannot see: the face windows its caption placement read (with the ones
 * it still needs) and the Director's issues its review is built over. A carry is refused when either is not the one the render was made with,
 * so each must move with the evidence and with nothing else.
 */
const h = (character) => character.repeat(64)
const window = (id, start, end, patch = {}) => ({ id, envelopeHash: h(id.at(-1)), startSourceFrame: start, endSourceFrame: end, authenticated: true, reasons: [], ...patch })
const read = (windows, patch = {}) => ({ sourceArtifactId: 'artifact-source', fromSourceFrame: 0, toSourceFrame: 150, windows, ...patch })
const required = [{ sourceArtifactId: 'artifact-source', windows: [{ startSourceFrame: 0, endSourceFrame: 100 }, { startSourceFrame: 100, endSourceFrame: 150 }] }]
const digest = (reads, patch = {}) => proxyFaceEvidenceDigest({ wired: true, reads, requiredFaceWindows: required, ...patch })

test('the face digest is a function of the windows read and the windows still needed, never of the order they came in', () => {
  const base = digest([read([window('window-1', 0, 100), window('window-2', 100, 150)])])
  assert.match(base, /^[a-f0-9]{64}$/)
  assert.equal(digest([read([window('window-2', 100, 150), window('window-1', 0, 100)])]), base, 'the order of the windows does not matter')
  const second = read([window('window-3', 0, 50)], { sourceArtifactId: 'artifact-insert', toSourceFrame: 50 })
  assert.equal(digest([read([window('window-1', 0, 100), window('window-2', 100, 150)]), second]), digest([second, read([window('window-1', 0, 100), window('window-2', 100, 150)])]),
    'nor the order of the sources')
  assert.equal(digest([read([window('window-1', 0, 100), window('window-2', 100, 150)])], { requiredFaceWindows: [{ ...required[0], windows: [...required[0].windows].reverse() }] }), base)
})

test('every change of the evidence moves the face digest', () => {
  const windows = [window('window-1', 0, 100)]
  const base = digest([read(windows)])
  const moved = {
    'a window published later (the pending one)': digest([read([...windows, window('window-2', 100, 150)])]),
    'a window re-sealed (another envelope)': digest([read([window('window-1', 0, 100, { envelopeHash: h('f') })])]),
    'the producer verdict': digest([read([window('window-1', 0, 100, { authenticated: false, reasons: ['RUNTIME_VERSION_MISMATCH'] })])]),
    'the verdict reasons': digest([read([window('window-1', 0, 100, { reasons: ['RUNTIME_PLATFORM_NOT_PARITIED'] })])]),
    'a window gone': digest([read([])]),
    'the range read': digest([read(windows, { toSourceFrame: 120 })]),
    'the windows still needed': digest([read(windows)], { requiredFaceWindows: [{ ...required[0], windows: [required[0].windows[0]] }] }),
    'no reader wired': proxyFaceEvidenceDigest({ wired: false, reads: [], requiredFaceWindows: required }),
  }
  for (const [label, value] of Object.entries(moved)) assert.notEqual(value, base, `${label} moves the digest`)
  assert.equal(new Set(Object.values(moved)).size, Object.keys(moved).length, 'and no two of them collide')
})

test('the recorder passes every answer through and records exactly what was answered', async () => {
  const envelope = { id: 'envelope-1', envelopeHash: h('1'), window: { startSourceFrame: 0, endSourceFrame: 100 } }
  const stored = [{ envelope, authentication: { authenticated: true, reasons: ['B', 'A'] } }]
  const recorder = recordingFaceEvidenceReader({ async listSourceWindows() { return stored } })
  assert.equal(recorder.wired, true)
  const answered = await recorder.reader.listSourceWindows({ workspaceId: 'w', projectId: 'p', sourceArtifactId: 'artifact-source', fromSourceFrame: 0, toSourceFrame: 150, now: new Date(), limit: 200 })
  assert.equal(answered, stored, 'the planner reads the very answer of the store')
  assert.deepEqual(recorder.reads(), [{ sourceArtifactId: 'artifact-source', fromSourceFrame: 0, toSourceFrame: 150,
    windows: [{ id: 'envelope-1', envelopeHash: h('1'), startSourceFrame: 0, endSourceFrame: 100, authenticated: true, reasons: ['A', 'B'] }] }])
  const none = recordingFaceEvidenceReader(undefined)
  assert.equal(none.reader, undefined)
  assert.equal(none.wired, false)
  assert.deepEqual(none.reads(), [])
})

test('the critic digest is the digest of the Director issues and moves with any of them', () => {
  const issue = { code: 'DIRECTOR_PACING_WARNING', severity: 'warning', category: 'editorial', message: 'Pacing needs review.', correctable: true }
  const base = proxyDirectorCriticIssuesDigest([issue])
  assert.equal(proxyDirectorCriticIssuesDigest(undefined), proxyDirectorCriticIssuesDigest([]), 'no Director run is the empty list')
  assert.notEqual(proxyDirectorCriticIssuesDigest([]), base)
  assert.notEqual(proxyDirectorCriticIssuesDigest([{ ...issue, severity: 'hard' }]), base)
  assert.notEqual(proxyDirectorCriticIssuesDigest([issue, { ...issue, code: 'DIRECTOR_HOOK_WARNING' }]), base)
  assert.equal(proxyDirectorCriticIssuesDigest([{ ...issue }]), base, 'equal issues, equal digest')
})
