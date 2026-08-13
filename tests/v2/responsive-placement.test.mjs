import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { OUTPUT_ASPECT_RATIOS } from '../../src/v2/domain/output-spec.ts'
import {
  RESPONSIVE_VISUAL_GOLDENS,
  solveResponsivePlacement,
  validateResponsivePlacement,
  VERSIONED_OUTPUT_PRESETS,
} from '../../src/v2/domain/responsive-output.ts'

const element = (id, kind, readingOrder, overrides = {}) => ({
  id, kind, readingOrder, anchor: 'auto', priority: 10,
  minWidth: 0.05, maxWidth: 0.92, minHeight: 0.05, maxHeight: 0.85,
  ...overrides,
})

test('T-FR-163 twenty format-specific goldens are content-addressed, safe and non-uniform', () => {
  assert.equal(RESPONSIVE_VISUAL_GOLDENS.length, 20)
  for (const golden of RESPONSIVE_VISUAL_GOLDENS) {
    assert.equal(golden.placement.elements.length, 1)
    assert.equal(golden.placement.reviewRequired, false)
    assert.equal(golden.placement.registryHash.length, 64)
    validateResponsivePlacement(golden.placement)
    const { placementHash: _hash, ...body } = golden.placement
    assert.equal(golden.placement.placementHash, calculateCanonicalHash(body))
  }
  const subtitleGeometry = OUTPUT_ASPECT_RATIOS.map((ratio) => {
    const placed = RESPONSIVE_VISUAL_GOLDENS.find((golden) => golden.ratio === ratio && golden.kind === 'subtitle').placement.elements[0]
    return [placed.x, placed.y, placed.width, placed.height]
  })
  assert.ok(new Set(subtitleGeometry.map(JSON.stringify)).size >= 4, 'formats must not share one uniformly scaled placement')
})

test('T-FR-163 face and ROI regions force deterministic anchor fallback with reasons', () => {
  const spec = VERSIONED_OUTPUT_PRESETS['16:9'].spec
  const result = solveResponsivePlacement({
    spec,
    elements: [element('logo', 'logo', 0, { anchor: 'top-left' }), element('insert', 'insert', 1, { priority: 5 })],
    protectedRegions: [
      { id: 'face-left', kind: 'face', x: spec.safeArea.left, y: spec.safeArea.top, width: 0.2, height: 0.13 },
      { id: 'roi-right', kind: 'roi', x: 0.55, y: 0.2, width: 0.4, height: 0.6 },
    ],
  })
  assert.equal(result.elements.find((item) => item.id === 'logo').anchor, 'top-right')
  assert.equal(result.elements.find((item) => item.id === 'insert').anchor, 'center-left')
  assert.deepEqual(new Set(result.issues.map((issue) => issue.code)), new Set(['ANCHOR_FALLBACK', 'FACE_COLLISION_AVOIDED', 'ROI_COLLISION_AVOIDED']))
  assert.equal(result.reviewRequired, false)
  validateResponsivePlacement(result)
})

test('T-FR-163 priority, collision avoidance and reading order remain deterministic', () => {
  const result = solveResponsivePlacement({
    spec: VERSIONED_OUTPUT_PRESETS['9:16'].spec,
    elements: [
      element('subtitle', 'subtitle', 2, { priority: 100 }),
      element('cta', 'cta', 3, { priority: 90 }),
      element('logo', 'logo', 0, { priority: 80 }),
      element('insert', 'insert', 1, { priority: 70 }),
    ],
  })
  assert.deepEqual(result.elements.map((item) => item.readingOrder), [0, 2, 3])
  assert.equal(result.reviewRequired, true)
  assert.equal(result.issues.some((issue) => issue.elementId === 'insert' && issue.code === 'IMPOSSIBLE_CONSTRAINTS'), true)
  for (let index = 0; index < result.elements.length; index += 1) for (let other = index + 1; other < result.elements.length; other += 1) {
    const left = result.elements[index]; const right = result.elements[other]
    assert.equal(left.x < right.x + right.width && left.x + left.width > right.x && left.y < right.y + right.height && left.y + left.height > right.y, false)
  }
  validateResponsivePlacement(result)
})

test('T-FR-163 impossible constraints require review and tampering fails closed', () => {
  const result = solveResponsivePlacement({
    spec: VERSIONED_OUTPUT_PRESETS['4:5'].spec,
    elements: [element('oversized', 'insert', 0, { minWidth: 0.99, maxWidth: 0.99, minHeight: 0.99, maxHeight: 0.99 })],
  })
  assert.deepEqual(result.elements, [])
  assert.equal(result.reviewRequired, true)
  assert.equal(result.issues[0].code, 'IMPOSSIBLE_CONSTRAINTS')
  assert.equal(result.issues[0].severity, 'review')
  assert.match(result.issues[0].reason, /No format-specific candidate/)
  validateResponsivePlacement(result)
  assert.throws(
    () => validateResponsivePlacement({ ...result, placementHash: '0'.repeat(64) }),
    (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT',
  )
})

test('T-FR-163 malformed constraints, duplicate reading order and unsafe ROI fail before solving', () => {
  const spec = VERSIONED_OUTPUT_PRESETS['1:1'].spec
  assert.throws(() => solveResponsivePlacement({ spec, elements: [element('bad', 'logo', 0, { minWidth: 0.8, maxWidth: 0.2 })] }), DomainError)
  assert.throws(() => solveResponsivePlacement({ spec, elements: [element('a', 'logo', 0), element('b', 'cta', 0)] }), DomainError)
  assert.throws(() => solveResponsivePlacement({ spec, elements: [element('a', 'logo', 0)], protectedRegions: [{ id: 'outside', kind: 'face', x: 0.9, y: 0.9, width: 0.2, height: 0.2 }] }), DomainError)
})
