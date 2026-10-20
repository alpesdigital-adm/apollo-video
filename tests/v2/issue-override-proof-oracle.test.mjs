import assert from 'node:assert/strict'
import test from 'node:test'

import { ANCHORS, bandRows, changedClusters, occupiedBands, PIXEL_TOLERANCE } from './helpers/issue-override-proof.mjs'

/** The W68 pixel oracle is itself tested before it judges a render: it must be silent when nothing changed and exact when something did. */
const frame = (width, height, paint = () => null) => {
  const data = Buffer.alloc(width * height * 3, 30)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const color = paint(x, y)
    if (color) { const offset = (y * width + x) * 3; data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2] }
  }
  return { width, height, data }
}

test('identical frames, and encoder-sized noise, have no changed cluster', () => {
  const base = frame(200, 400)
  assert.deepEqual(changedClusters(base, frame(200, 400)), [])
  assert.deepEqual(changedClusters(base, frame(200, 400, (x, y) => (x % 7 === 0 && y % 5 === 0 ? [30 + PIXEL_TOLERANCE.channelDelta - 1, 30, 30] : null))), [])
})

test('a caption moved from one band to another is exactly two clusters, one in each band; a caption that vanished is one', () => {
  const bottom = bandRows('9:16', 'bottom'), top = bandRows('9:16', 'top')
  const { width, height } = bottom.canvas
  const caption = (rows) => frame(width, height, (x, y) => (x > 60 && x < width - 60 && y >= rows[0] && y <= rows[1] ? [250, 250, 250] : null))
  const inBottom = caption([bottom.top + 10, bottom.top + 60]), inTop = caption([top.top + 10, top.top + 60]), none = caption([-1, -2])
  const moved = changedClusters(inBottom, inTop)
  assert.equal(moved.length, 2)
  assert.ok(moved[0][0] >= top.top && moved[0][1] <= top.bottom + PIXEL_TOLERANCE.bandSlackRows, JSON.stringify([moved, top]))
  assert.ok(moved[1][0] >= bottom.top - PIXEL_TOLERANCE.bandSlackRows && moved[1][1] <= bottom.bottom + PIXEL_TOLERANCE.bandSlackRows)
  assert.equal(changedClusters(inBottom, none).length, 1)
  assert.deepEqual(changedClusters(inBottom, inBottom), [])
  assert.throws(() => changedClusters(inBottom, frame(10, 10)), /different sizes/)
})

test('the bands are ordered top to bottom on both canvases; the generator face occupies the bands its DILATED box reaches, only while it is shown', () => {
  for (const format of ['9:16', '16:9']) {
    const tops = ANCHORS.map((anchor) => bandRows(format, anchor).top)
    assert.deepEqual([...tops].sort((a, b) => a - b), tops, `${format}: top, upper-third, center, lower-third, bottom`)
  }
  const scene = { subjectsAtSource: () => [{ kind: 'face', box: [0.2, 0.2, 0.3, 0.5] }] }
  const occupied = occupiedBands({ scene, format: '16:9', frames: [0, 1, 2] })
  assert.ok(occupied.length >= 1 && !occupied.includes('bottom'), occupied.join(','))
  // restated by hand: the box is 128 x 216 source pixels, so each side grows by 0.35 x 216 = 75.6 px (0.105 of the height): rows 0.095..0.605
  for (const anchor of ANCHORS) {
    const rows = bandRows('16:9', anchor)
    const reaches = 0.605 * rows.canvas.height >= rows.top && 0.095 * rows.canvas.height <= rows.bottom
    assert.equal(occupied.includes(anchor), reaches, anchor)
  }
  // the dilation matters: the raw box (rows 0.2..0.5) reaches only upper-third and center, the dilated one also reaches top and lower-third
  const raw = ANCHORS.filter((anchor) => { const rows = bandRows('16:9', anchor); return 0.5 * rows.canvas.height >= rows.top && 0.2 * rows.canvas.height <= rows.bottom })
  assert.ok(occupied.length > raw.length && raw.every((anchor) => occupied.includes(anchor)), `${raw} within ${occupied}`)
  const top = { subjectsAtSource: () => [{ kind: 'face', box: [0.2, 0.02, 0.3, 0.32] }] }
  assert.deepEqual(occupiedBands({ scene: top, format: '16:9', frames: [0] }), ['top', 'upper-third'], 'the face of the proof occupies the top two bands and leaves the rest free')
  assert.deepEqual(occupiedBands({ scene, format: '16:9', frames: [0], window: { x: 0.6, width: 0.3 } }), [], 'a face outside the shown columns occupies nothing')
  assert.deepEqual(occupiedBands({ scene: { subjectsAtSource: () => [] }, format: '16:9', frames: [0] }), [])
})
