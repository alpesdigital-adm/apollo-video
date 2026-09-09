import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createSyncMarker } from '../../src/v2/domain/sync-marker.ts'
import {
  encodePayloadGrid,
  FfmpegSyncMarkerRenderer,
} from '../../src/v2/infrastructure/media/ffmpeg-sync-marker-renderer.ts'

/**
 * F4.010 — the marker rendered as real media and read back by ffprobe.
 *
 * A marker specification that has never been rendered has never been shown to
 * be detectable. This produces the actual MP4 and verifies it with the same
 * tool the pipeline uses everywhere else.
 */

test('T-FR-148 a marker renders to a real MP4 whose streams match what it declared', async (t) => {
  const workRoot = await mkdtemp(join(tmpdir(), 'apollo-marker-'))
  // Cleanup in a hook rather than a finally, so it runs even if an assertion
  // throws — AGENTS.md is explicit that every ephemeral process and directory
  // gets an owner and a cleanup.
  t.after(async () => { await rm(workRoot, { recursive: true, force: true }) })

  const marker = createSyncMarker({
    markerId: 'marker-render-1',
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-render',
    kind: 'audiovisual',
    position: 'start',
    sequence: 1,
    emittedAt: '2029-04-01T09:00:00.000Z',
  })

  const renderer = new FfmpegSyncMarkerRenderer({
    workRoot,
  })
  const artifact = await renderer.render(marker)

  // ffprobe read these back off the file; they are not what we asked for.
  assert.equal(artifact.videoCodec, 'h264')
  assert.equal(artifact.audioCodec, 'aac')
  assert.equal(artifact.frameRate, '30/1')
  assert.equal(artifact.sampleRate, 48_000)
  assert.equal(artifact.width, 640)
  assert.equal(artifact.height, 360)
  // Five frames at 30 fps.
  assert.equal(artifact.durationMs, 167)

  const onDisk = await stat(artifact.filePath)
  assert.equal(onDisk.size, artifact.byteSize)
  assert.ok(artifact.byteSize > 0, 'the rendered marker has no bytes')
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/)

  console.log(
    `marker artifact: ${artifact.byteSize} bytes, sha256 ${artifact.sha256}, `
    + `${artifact.width}x${artifact.height} ${artifact.frameRate} ${artifact.videoCodec}/${artifact.audioCodec} `
    + `@${artifact.sampleRate} Hz, ${artifact.durationMs} ms`,
  )
})

test('T-FR-148 the same marker renders to the same bytes', async (t) => {
  const workRoot = await mkdtemp(join(tmpdir(), 'apollo-marker-det-'))
  t.after(async () => { await rm(workRoot, { recursive: true, force: true }) })

  const marker = createSyncMarker({
    markerId: 'marker-deterministic',
    workspaceId: 'workspace-1',
    sessionId: 'capture-session-render',
    kind: 'audiovisual',
    position: 'end',
    sequence: 2,
    emittedAt: '2029-04-01T10:00:00.000Z',
  })
  const renderer = new FfmpegSyncMarkerRenderer({
    workRoot,
  })

  const first = await renderer.render(marker)
  const second = await renderer.render(marker)
  // Content-addressed like everything else: a re-render is a replay, not a new
  // asset, and the artifact store can key on the hash.
  assert.equal(second.sha256, first.sha256)
  assert.equal(second.byteSize, first.byteSize)
})

test('T-FR-148 the payload grid is deterministic and carries the payload bits', () => {
  const payload = 'APOLLO1|ABC234|001|start|2029-04-01T09:00:00.000Z'
  const grid = encodePayloadGrid(payload, 24)
  assert.equal(grid.length, 24)
  assert.ok(grid.every((row) => row.length === 24))
  assert.deepEqual(encodePayloadGrid(payload, 24), grid)

  // The first bits are the payload itself, most significant bit first, so a
  // decoder reading the top-left corner is reading real data rather than
  // padding.
  const firstByte = payload.charCodeAt(0)
  const expected = []
  for (let bit = 7; bit >= 0; bit -= 1) expected.push(((firstByte >> bit) & 1) === 1)
  assert.deepEqual(grid[0].slice(0, 8), expected)

  // A different payload gives a different grid; the padding is derived from a
  // digest of the payload, so nothing collides by being mostly filler.
  assert.notDeepEqual(encodePayloadGrid(`${payload}x`, 24), grid)
})
