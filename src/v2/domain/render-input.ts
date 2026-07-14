import { Buffer } from 'node:buffer'

import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  createOutputSpec,
  type OutputSpec,
  type OutputSpecInput,
} from './output-spec.ts'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/
const PROPS_SCHEMA_REF_PATTERN = /^apollo:\/\/render-props\/[a-z0-9][a-z0-9-]*\/v[1-9]\d*$/
const MAX_PROPS_BYTES = 512 * 1024
const MAX_ASSETS = 4096
const MAX_DURATION_IN_FRAMES = 12 * 60 * 60 * 120

export const RENDER_INPUT_ASSET_KINDS = [
  'video',
  'audio',
  'image',
  'font',
  'lut',
  'data',
] as const

export type RenderInputAssetKind = (typeof RENDER_INPUT_ASSET_KINDS)[number]
export type CanonicalJsonPrimitive = null | boolean | number | string
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | Readonly<{ [key: string]: CanonicalJsonValue }>

export interface RenderInputAsset {
  id: string
  artifactId: string
  artifactKey: string
  kind: RenderInputAssetKind
  role: string
  ordinal: number
  sha256: string
  byteSize: number
}

export interface RenderInputSpecV1 {
  schemaVersion: 'render-input/v1'
  renderer: {
    id: string
    version: string
    digest: string
  }
  composition: {
    id: string
    version: string
    propsSchemaRef: string
    propsHash: string
  }
  plan: {
    id: string
    versionId: string
    hash: string
  }
  output: OutputSpec & {
    durationInFrames: number
  }
  assets: readonly RenderInputAsset[]
  props: Readonly<{ [key: string]: CanonicalJsonValue }>
  inputHash: string
}

export interface CreateRenderInputSpecInput {
  schemaVersion: 'render-input/v1'
  renderer: RenderInputSpecV1['renderer']
  composition: Omit<RenderInputSpecV1['composition'], 'propsHash'>
  plan: RenderInputSpecV1['plan']
  output: OutputSpecInput & { durationInFrames: number }
  assets: readonly RenderInputAsset[]
  props: Readonly<Record<string, unknown>>
}

export interface MaterializedRenderInputAsset extends RenderInputAsset {
  uri: string
}

export interface MaterializedRenderInputV1
  extends Omit<RenderInputSpecV1, 'assets'> {
  assets: readonly MaterializedRenderInputAsset[]
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_RENDER_INPUT',
    `${field} must be an object`,
  )
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys)
  assertDomain(
    Object.keys(value).every((key) => allowed.has(key)),
    'INVALID_RENDER_INPUT',
    `${field} contains unsupported properties`,
  )
}

function normalizeToken(value: unknown, field: string): string {
  assertDomain(typeof value === 'string', 'INVALID_RENDER_INPUT', `${field} must be a string`)
  const normalized = value.trim().toLowerCase()
  assertDomain(
    TOKEN_PATTERN.test(normalized),
    'INVALID_RENDER_INPUT',
    `${field} must be a portable token`,
  )
  return normalized
}

function normalizeSha256(value: unknown, field: string): string {
  assertDomain(typeof value === 'string', 'INVALID_RENDER_INPUT', `${field} must be a string`)
  const normalized = value.trim().toLowerCase()
  assertDomain(
    SHA256_PATTERN.test(normalized),
    'INVALID_RENDER_INPUT',
    `${field} must be a SHA-256 hex digest`,
  )
  return normalized
}

function normalizePortableKey(value: unknown, field: string): string {
  assertDomain(typeof value === 'string', 'INVALID_RENDER_INPUT', `${field} must be a string`)
  const normalized = value.trim()
  const segments = normalized.split('/')
  assertDomain(
    normalized.length > 0 &&
      normalized.length <= 512 &&
      !normalized.startsWith('/') &&
      !normalized.includes('\\') &&
      !/^[a-zA-Z]:/.test(normalized) &&
      segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    'INVALID_RENDER_INPUT',
    `${field} must be a portable relative key`,
  )
  return normalized
}

function normalizeCanonicalJson(
  value: unknown,
  field: string,
  active: WeakSet<object>,
  depth = 0,
): CanonicalJsonValue {
  assertDomain(depth <= 64, 'INVALID_RENDER_INPUT', `${field} exceeds maximum nesting`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    assertDomain(Number.isFinite(value), 'INVALID_RENDER_INPUT', `${field} contains a non-finite number`)
    return value
  }
  assertDomain(
    typeof value === 'object' && value !== null,
    'INVALID_RENDER_INPUT',
    `${field} contains a non-JSON value`,
  )
  assertDomain(!active.has(value), 'INVALID_RENDER_INPUT', `${field} contains a cycle`)
  active.add(value)
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((item, index) =>
          normalizeCanonicalJson(item, `${field}[${index}]`, active, depth + 1),
        ),
      )
    }
    const prototype = Object.getPrototypeOf(value)
    assertDomain(
      prototype === Object.prototype || prototype === null,
      'INVALID_RENDER_INPUT',
      `${field} must contain plain JSON objects`,
    )
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => {
        assertDomain(
          key.length > 0 &&
            key.length <= 128 &&
            !['__proto__', 'prototype', 'constructor'].includes(key),
          'INVALID_RENDER_INPUT',
          `${field} contains an unsafe property name`,
        )
        return [
          key,
          normalizeCanonicalJson(nested, `${field}.${key}`, active, depth + 1),
        ] as const
      })
    return Object.freeze(Object.fromEntries(entries))
  } finally {
    active.delete(value)
  }
}

function normalizeAsset(value: unknown, expectedOrdinal: number): RenderInputAsset {
  assertRecord(value, `assets[${expectedOrdinal}]`)
  assertExactKeys(
    value,
    ['id', 'artifactId', 'artifactKey', 'kind', 'role', 'ordinal', 'sha256', 'byteSize'],
    `assets[${expectedOrdinal}]`,
  )
  assertDomain(
    typeof value.kind === 'string' &&
      RENDER_INPUT_ASSET_KINDS.includes(value.kind as RenderInputAssetKind),
    'INVALID_RENDER_INPUT',
    `assets[${expectedOrdinal}].kind is invalid`,
  )
  assertDomain(
    value.ordinal === expectedOrdinal,
    'INVALID_RENDER_INPUT',
    'Render input asset ordinals must be contiguous and ordered',
  )
  assertDomain(
    Number.isSafeInteger(value.byteSize) && Number(value.byteSize) > 0,
    'INVALID_RENDER_INPUT',
    `assets[${expectedOrdinal}].byteSize must be a positive safe integer`,
  )
  return Object.freeze({
    id: normalizeToken(value.id, `assets[${expectedOrdinal}].id`),
    artifactId: normalizeToken(value.artifactId, `assets[${expectedOrdinal}].artifactId`),
    artifactKey: normalizePortableKey(value.artifactKey, `assets[${expectedOrdinal}].artifactKey`),
    kind: value.kind as RenderInputAssetKind,
    role: normalizeToken(value.role, `assets[${expectedOrdinal}].role`),
    ordinal: expectedOrdinal,
    sha256: normalizeSha256(value.sha256, `assets[${expectedOrdinal}].sha256`),
    byteSize: Number(value.byteSize),
  })
}

export function createRenderInputSpec(input: CreateRenderInputSpecInput): RenderInputSpecV1 {
  assertRecord(input, 'renderInput')
  assertExactKeys(
    input,
    ['schemaVersion', 'renderer', 'composition', 'plan', 'output', 'assets', 'props'],
    'renderInput',
  )
  assertDomain(
    input.schemaVersion === 'render-input/v1',
    'INVALID_RENDER_INPUT',
    'renderInput.schemaVersion is invalid',
  )

  assertRecord(input.renderer, 'renderer')
  assertExactKeys(input.renderer, ['id', 'version', 'digest'], 'renderer')
  assertRecord(input.composition, 'composition')
  assertExactKeys(input.composition, ['id', 'version', 'propsSchemaRef'], 'composition')
  assertRecord(input.plan, 'plan')
  assertExactKeys(input.plan, ['id', 'versionId', 'hash'], 'plan')
  assertRecord(input.output, 'output')
  assertExactKeys(
    input.output,
    [
      'id', 'locale', 'aspectRatio', 'width', 'height', 'fps', 'safeArea',
      'deliveryProfileId', 'durationInFrames',
    ],
    'output',
  )
  assertRecord(input.output.safeArea, 'output.safeArea')
  assertExactKeys(input.output.safeArea, ['top', 'right', 'bottom', 'left'], 'output.safeArea')
  assertDomain(Array.isArray(input.assets), 'INVALID_RENDER_INPUT', 'assets must be an array')
  assertDomain(
    input.assets.length <= MAX_ASSETS,
    'INVALID_RENDER_INPUT',
    `assets cannot exceed ${MAX_ASSETS} items`,
  )
  assertRecord(input.props, 'props')

  const props = normalizeCanonicalJson(input.props, 'props', new WeakSet())
  assertRecord(props, 'props')
  const canonicalProps = stableSerialize(props)
  assertDomain(
    Buffer.byteLength(canonicalProps, 'utf8') <= MAX_PROPS_BYTES,
    'INVALID_RENDER_INPUT',
    `props cannot exceed ${MAX_PROPS_BYTES} canonical bytes`,
  )
  assertDomain(
    typeof input.composition.propsSchemaRef === 'string' &&
      PROPS_SCHEMA_REF_PATTERN.test(input.composition.propsSchemaRef),
    'INVALID_RENDER_INPUT',
    'composition.propsSchemaRef is invalid',
  )
  assertDomain(
    typeof input.output.locale === 'string' && LOCALE_PATTERN.test(input.output.locale),
    'INVALID_RENDER_INPUT',
    'output.locale is invalid',
  )
  if ('deliveryProfileId' in input.output) {
    assertDomain(
      typeof input.output.deliveryProfileId === 'string' &&
        input.output.deliveryProfileId.trim() === input.output.deliveryProfileId &&
        input.output.deliveryProfileId.length > 0 &&
        input.output.deliveryProfileId.length <= 128,
      'INVALID_RENDER_INPUT',
      'output.deliveryProfileId is invalid',
    )
  }
  assertDomain(
    typeof input.output.id === 'string' &&
      input.output.id.trim() === input.output.id,
    'INVALID_RENDER_INPUT',
    'output.id must be normalized',
  )
  assertDomain(
    Number.isInteger(input.output.durationInFrames) &&
      input.output.durationInFrames > 0 &&
      input.output.durationInFrames <= MAX_DURATION_IN_FRAMES,
    'INVALID_RENDER_INPUT',
    'output.durationInFrames is invalid',
  )

  const output = createOutputSpec({
    id: input.output.id,
    locale: input.output.locale,
    aspectRatio: input.output.aspectRatio,
    width: input.output.width,
    height: input.output.height,
    fps: input.output.fps,
    safeArea: input.output.safeArea,
    ...(input.output.deliveryProfileId
      ? { deliveryProfileId: input.output.deliveryProfileId }
      : {}),
  })
  const assets = Object.freeze(input.assets.map(normalizeAsset))
  assertDomain(
    new Set(assets.map((asset) => asset.id)).size === assets.length &&
      new Set(assets.map((asset) => asset.artifactId)).size === assets.length &&
      new Set(assets.map((asset) => asset.artifactKey)).size === assets.length,
    'INVALID_RENDER_INPUT',
    'Render input assets must have unique ids, artifact ids and keys',
  )

  const body = Object.freeze({
    schemaVersion: 'render-input/v1' as const,
    renderer: Object.freeze({
      id: normalizeToken(input.renderer.id, 'renderer.id'),
      version: normalizeToken(input.renderer.version, 'renderer.version'),
      digest: normalizeSha256(input.renderer.digest, 'renderer.digest'),
    }),
    composition: Object.freeze({
      id: normalizeToken(input.composition.id, 'composition.id'),
      version: normalizeToken(input.composition.version, 'composition.version'),
      propsSchemaRef: input.composition.propsSchemaRef,
      propsHash: calculateCanonicalHash(props),
    }),
    plan: Object.freeze({
      id: normalizeToken(input.plan.id, 'plan.id'),
      versionId: normalizeToken(input.plan.versionId, 'plan.versionId'),
      hash: normalizeSha256(input.plan.hash, 'plan.hash'),
    }),
    output: Object.freeze({
      ...output,
      durationInFrames: input.output.durationInFrames,
    }),
    assets,
    props,
  })

  return Object.freeze({
    ...body,
    inputHash: calculateCanonicalHash(body),
  })
}

export function assertRenderInputSpec(spec: RenderInputSpecV1): void {
  assertRecord(spec, 'renderInput')
  assertExactKeys(
    spec,
    [
      'schemaVersion', 'renderer', 'composition', 'plan', 'output',
      'assets', 'props', 'inputHash',
    ],
    'renderInput',
  )
  assertRecord(spec.composition, 'composition')
  assertExactKeys(
    spec.composition,
    ['id', 'version', 'propsSchemaRef', 'propsHash'],
    'composition',
  )
  const recreated = createRenderInputSpec({
    schemaVersion: spec.schemaVersion,
    renderer: spec.renderer,
    composition: {
      id: spec.composition.id,
      version: spec.composition.version,
      propsSchemaRef: spec.composition.propsSchemaRef,
    },
    plan: spec.plan,
    output: {
      id: spec.output.id,
      locale: spec.output.locale,
      aspectRatio: spec.output.aspectRatio,
      width: spec.output.width,
      height: spec.output.height,
      fps: spec.output.fps,
      safeArea: spec.output.safeArea,
      ...(spec.output.deliveryProfileId
        ? { deliveryProfileId: spec.output.deliveryProfileId }
        : {}),
      durationInFrames: spec.output.durationInFrames,
    },
    assets: spec.assets,
    props: spec.props,
  })
  assertDomain(
    stableSerialize(recreated) === stableSerialize(spec),
    'INVALID_RENDER_INPUT',
    'Render input hashes or normalized fields are invalid',
  )
}
