import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { parseCube3d } from './workspace-lut.ts'

export const OUTPUT_FORMATS = ['9:16', '16:9', '4:5', '1:1', '21:9'] as const;
export type OutputFormat = typeof OUTPUT_FORMATS[number];

export const COLOR_TRANSFORM_ORDER = [
  'technical',
  'match',
  'creative-lut',
  'output',
] as const
export type ColorTransformKind = typeof COLOR_TRANSFORM_ORDER[number]

export type ColorMetadata = {
  colorSpace: string
  transfer: string
  primaries: string
  matrix: string
  range: 'full' | 'limited'
  bitDepth: number
}

export type ColorTransform = {
  id: string
  kind: ColorTransformKind
  version: string
  enabled: boolean
  input: ColorMetadata
  output: ColorMetadata
  implementation: {
    provider: string
    version: string
    parameters: Readonly<Record<string, string | number | boolean>>
    parametersHash: string
  }
  lut?: {
    artifactId: string
    sha256: string
  }
}

export type ColorPlan = {
  schemaVersion: 'color-plan/v1'
  metadata: ColorMetadata
  outputMetadata: ColorMetadata
  global: readonly Readonly<ColorTransform>[]
  sourceMetadata?: Readonly<Record<string, Readonly<ColorMetadata>>>
  sources?: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
  cameras?: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
  segments?: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
}

export type CanonicalColorPlan = Readonly<{
  schemaVersion: 'color-plan/v1'
  metadata: Readonly<ColorMetadata>
  outputMetadata: Readonly<ColorMetadata>
  global: readonly Readonly<ColorTransform>[]
  sourceMetadata: Readonly<Record<string, Readonly<ColorMetadata>>>
  sources: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
  cameras: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
  segments: Readonly<Record<string, readonly Readonly<ColorTransform>[]>>
  planHash: string
}>

export type ColorPlanTarget = Readonly<{
  sourceId: string
  cameraId?: string
  segmentId?: string
}>

export type CompiledColorPlan = Readonly<{
  schemaVersion: 'compiled-color-plan/v1'
  colorPlanHash: string
  targets: readonly Readonly<ReturnType<typeof resolveColorPlan>>[]
  manifestHash: string
}>

const TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/
const SHA_256 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

export type DetectedMediaColor =
  | Readonly<{
      state: 'ready'
      metadata: Readonly<ColorMetadata>
      pixelFormat: string
      hdrMode: 'sdr' | 'hlg' | 'pq'
    }>
  | Readonly<{
      state: 'unavailable'
      pixelFormat?: string
      reasons: readonly string[]
    }>

export interface MediaColorProbe {
  schemaVersion: 'media-color-probe/v1'
  id: string
  workspaceId: string
  artifactId: string
  manifestId: string
  detection: DetectedMediaColor
  producer: Readonly<{
    provider: 'ffprobe'
    version: string
    binaryDigest: string
  }>
  createdAt: string
  probeHash: string
}

function normalizedToken(value: unknown, field: string) {
  assertDomain(
    typeof value === 'string' && TOKEN.test(value.trim().toLowerCase()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim().toLowerCase()
}

function normalizedMetadata(
  value: Readonly<ColorMetadata>,
  field: string,
): Readonly<ColorMetadata> {
  assertDomain(
    value && typeof value === 'object',
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  assertDomain(
    value.range === 'full' || value.range === 'limited',
    'INVALID_ARGUMENT',
    `${field}.range is invalid`,
  )
  assertDomain(
    Number.isSafeInteger(value.bitDepth) &&
      value.bitDepth >= 8 &&
      value.bitDepth <= 32,
    'INVALID_ARGUMENT',
    `${field}.bitDepth is invalid`,
  )
  return Object.freeze({
    colorSpace: normalizedToken(value.colorSpace, `${field}.colorSpace`),
    transfer: normalizedToken(value.transfer, `${field}.transfer`),
    primaries: normalizedToken(value.primaries, `${field}.primaries`),
    matrix: normalizedToken(value.matrix, `${field}.matrix`),
    range: value.range,
    bitDepth: value.bitDepth,
  })
}

function normalizedId(value: unknown, field: string) {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function normalizedDetection(
  value: Readonly<DetectedMediaColor>,
): DetectedMediaColor {
  assertDomain(
    value && typeof value === 'object' &&
      (value.state === 'ready' || value.state === 'unavailable'),
    'INVALID_ARGUMENT',
    'color detection is invalid',
  )
  if (value.state === 'ready') {
    assertDomain(
      ['sdr', 'hlg', 'pq'].includes(value.hdrMode),
      'INVALID_ARGUMENT',
      'color detection HDR mode is invalid',
    )
    return Object.freeze({
      state: 'ready' as const,
      metadata: normalizedMetadata(
        value.metadata,
        'detection.metadata',
      ),
      pixelFormat: normalizedToken(
        value.pixelFormat,
        'detection.pixelFormat',
      ),
      hdrMode: value.hdrMode,
    })
  }
  assertDomain(
    Array.isArray(value.reasons) &&
      value.reasons.length >= 1 &&
      value.reasons.length <= 16,
    'INVALID_ARGUMENT',
    'unavailable color detection requires reasons',
  )
  const reasons = value.reasons.map((reason, index) =>
    normalizedToken(reason, `detection.reasons[${index}]`))
  assertDomain(
    new Set(reasons).size === reasons.length,
    'INVALID_ARGUMENT',
    'color detection reasons must be unique',
  )
  return Object.freeze({
    state: 'unavailable' as const,
    ...(value.pixelFormat
      ? {
          pixelFormat: normalizedToken(
            value.pixelFormat,
            'detection.pixelFormat',
          ),
        }
      : {}),
    reasons: Object.freeze([...reasons].sort()),
  })
}

export function createMediaColorProbe(input: {
  id: string
  workspaceId: string
  artifactId: string
  manifestId: string
  detection: Readonly<DetectedMediaColor>
  producer: Readonly<{
    provider: 'ffprobe'
    version: string
    binaryDigest: string
  }>
  createdAt: string
}): Readonly<MediaColorProbe> {
  const binaryDigest = String(
    input.producer?.binaryDigest ?? '',
  ).trim().toLowerCase()
  assertDomain(
    input.producer?.provider === 'ffprobe' &&
      SHA_256.test(binaryDigest),
    'INVALID_ARGUMENT',
    'color probe producer is invalid',
  )
  const createdAt = new Date(input.createdAt)
  assertDomain(
    !Number.isNaN(createdAt.getTime()) &&
      createdAt.toISOString() === input.createdAt,
    'INVALID_ARGUMENT',
    'color probe createdAt is invalid',
  )
  const content = Object.freeze({
    schemaVersion: 'media-color-probe/v1' as const,
    id: normalizedId(input.id, 'id'),
    workspaceId: normalizedId(input.workspaceId, 'workspaceId'),
    artifactId: normalizedId(input.artifactId, 'artifactId'),
    manifestId: normalizedId(input.manifestId, 'manifestId'),
    detection: normalizedDetection(input.detection),
    producer: Object.freeze({
      provider: 'ffprobe' as const,
      version: normalizedToken(
        input.producer.version,
        'producer.version',
      ),
      binaryDigest,
    }),
    createdAt: input.createdAt,
  })
  return Object.freeze({
    ...content,
    probeHash: calculateCanonicalHash(content),
  })
}

function sameMetadata(
  left: Readonly<ColorMetadata>,
  right: Readonly<ColorMetadata>,
) {
  return calculateCanonicalHash(left) === calculateCanonicalHash(right)
}

function normalizedTransform(
  value: Readonly<ColorTransform>,
  field: string,
): Readonly<ColorTransform> {
  assertDomain(
    value && typeof value === 'object' &&
      COLOR_TRANSFORM_ORDER.includes(value.kind),
    'INVALID_ARGUMENT',
    `${field}.kind is invalid`,
  )
  assertDomain(
    typeof value.enabled === 'boolean',
    'INVALID_ARGUMENT',
    `${field}.enabled is invalid`,
  )
  const parameters = value.implementation?.parameters
  assertDomain(
    parameters &&
      typeof parameters === 'object' &&
      !Array.isArray(parameters) &&
      Object.entries(parameters).every(([key, nested]) =>
        TOKEN.test(key) &&
        (
          typeof nested === 'string' ||
          typeof nested === 'boolean' ||
          (typeof nested === 'number' && Number.isFinite(nested))
        )),
    'INVALID_ARGUMENT',
    `${field}.implementation.parameters is invalid`,
  )
  const normalizedParameters = Object.freeze(
    Object.fromEntries(
      Object.entries(parameters).sort(([left], [right]) =>
        left.localeCompare(right)),
    ),
  )
  const parametersHash = String(
    value.implementation?.parametersHash ?? '',
  ).trim().toLowerCase()
  assertDomain(
    SHA_256.test(parametersHash) &&
      parametersHash === calculateCanonicalHash(normalizedParameters),
    'INVALID_ARGUMENT',
    `${field}.implementation.parametersHash does not match parameters`,
  )
  const input = normalizedMetadata(value.input, `${field}.input`)
  const output = normalizedMetadata(value.output, `${field}.output`)
  assertDomain(
    value.enabled || sameMetadata(input, output),
    'INVALID_ARGUMENT',
    `${field} disabled stage must be an explicit colorimetric bypass`,
  )
  if (value.kind === 'creative-lut' && value.enabled) {
    assertDomain(
      value.lut &&
        TOKEN.test(value.lut.artifactId) &&
        SHA_256.test(value.lut.sha256),
      'INVALID_ARGUMENT',
      `${field}.lut must bind an immutable artifact`,
    )
  } else {
    assertDomain(
      value.lut === undefined,
      'INVALID_ARGUMENT',
      `${field}.lut is allowed only for an enabled creative LUT`,
    )
  }
  return Object.freeze({
    id: normalizedToken(value.id, `${field}.id`),
    kind: value.kind,
    version: normalizedToken(value.version, `${field}.version`),
    enabled: value.enabled,
    input,
    output,
    implementation: Object.freeze({
      provider: normalizedToken(
        value.implementation?.provider,
        `${field}.implementation.provider`,
      ),
      version: normalizedToken(
        value.implementation?.version,
        `${field}.implementation.version`,
      ),
      parameters: normalizedParameters,
      parametersHash,
    }),
    ...(value.lut
      ? {
          lut: Object.freeze({
            artifactId: normalizedToken(
              value.lut.artifactId,
              `${field}.lut.artifactId`,
            ),
            sha256: value.lut.sha256,
          }),
        }
      : {}),
  })
}

function normalizeLayer(
  value: readonly Readonly<ColorTransform>[] | undefined,
  field: string,
) {
  const transforms = (value ?? []).map((transform, index) =>
    normalizedTransform(transform, `${field}[${index}]`))
  assertDomain(
    new Set(transforms.map((transform) => transform.kind)).size ===
      transforms.length,
    'INVALID_ARGUMENT',
    `${field} cannot apply a color stage twice`,
  )
  return transforms
}

function normalizeLayerMap(
  value: Readonly<Record<string, readonly Readonly<ColorTransform>[]>> | undefined,
  field: 'sources' | 'cameras' | 'segments',
): Readonly<Record<string, readonly Readonly<ColorTransform>[]>> {
  if (value === undefined) return Object.freeze({})
  assertDomain(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be an object`,
  )
  const entries = Object.entries(value)
  assertDomain(
    entries.length <= 128,
    'INVALID_ARGUMENT',
    `${field} exceeds the maximum number of overrides`,
  )
  const normalized = entries.map(([rawKey, transforms]) => {
    const key = normalizedToken(rawKey, `${field} key`)
    assertDomain(
      key !== '__proto__' && key !== 'constructor' && key !== 'prototype',
      'INVALID_ARGUMENT',
      `${field} key is reserved`,
    )
    return [key, Object.freeze(normalizeLayer(transforms, `${field}.${key}`))] as const
  }).sort(([left], [right]) => left.localeCompare(right))
  assertDomain(
    new Set(normalized.map(([key]) => key)).size === normalized.length,
    'INVALID_ARGUMENT',
    `${field} keys must be unique after normalization`,
  )
  return Object.freeze(Object.fromEntries(normalized))
}

function normalizeSourceMetadataMap(
  value: Readonly<Record<string, Readonly<ColorMetadata>>> | undefined,
): Readonly<Record<string, Readonly<ColorMetadata>>> {
  if (value === undefined) return Object.freeze({})
  assertDomain(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'INVALID_ARGUMENT',
    'sourceMetadata must be an object',
  )
  const entries = Object.entries(value)
  assertDomain(
    entries.length <= 128,
    'INVALID_ARGUMENT',
    'sourceMetadata exceeds the maximum number of sources',
  )
  const normalized = entries.map(([rawKey, metadata]) => {
    const key = normalizedToken(rawKey, 'sourceMetadata key')
    return [key, normalizedMetadata(metadata, `sourceMetadata.${key}`)] as const
  }).sort(([left], [right]) => left.localeCompare(right))
  assertDomain(
    new Set(normalized.map(([key]) => key)).size === normalized.length,
    'INVALID_ARGUMENT',
    'sourceMetadata keys must be unique after normalization',
  )
  return Object.freeze(Object.fromEntries(normalized))
}

export function createColorPlan(
  plan: Readonly<ColorPlan>,
): Readonly<CanonicalColorPlan> {
  assertDomain(
    plan && plan.schemaVersion === 'color-plan/v1',
    'INVALID_ARGUMENT',
    'ColorPlan schemaVersion is invalid',
  )
  const content = Object.freeze({
    schemaVersion: 'color-plan/v1' as const,
    metadata: normalizedMetadata(plan.metadata, 'metadata'),
    outputMetadata: normalizedMetadata(plan.outputMetadata, 'outputMetadata'),
    global: Object.freeze(normalizeLayer(plan.global, 'global')),
    sourceMetadata: normalizeSourceMetadataMap(plan.sourceMetadata),
    sources: normalizeLayerMap(plan.sources, 'sources'),
    cameras: normalizeLayerMap(plan.cameras, 'cameras'),
    segments: normalizeLayerMap(plan.segments, 'segments'),
  })
  assertDomain(
    COLOR_TRANSFORM_ORDER.every((kind) =>
      content.global.some((transform) => transform.kind === kind)),
    'INVALID_ARGUMENT',
    'ColorPlan global layer must define every color stage explicitly',
  )
  return Object.freeze({
    ...content,
    planHash: calculateCanonicalHash(content),
  })
}

export function resolveColorPlan(
  plan: Readonly<ColorPlan>,
  ref: Readonly<{
    sourceId?: string
    cameraId?: string
    segmentId?: string
  }>,
) {
  const canonical = createColorPlan(plan)
  const sourceId = ref.sourceId
    ? normalizedToken(ref.sourceId, 'sourceId')
    : undefined
  const cameraId = ref.cameraId
    ? normalizedToken(ref.cameraId, 'cameraId')
    : undefined
  const segmentId = ref.segmentId
    ? normalizedToken(ref.segmentId, 'segmentId')
    : undefined
  const sourceMetadata = sourceId
    ? canonical.sourceMetadata[sourceId] ?? canonical.metadata
    : canonical.metadata
  const outputMetadata = canonical.outputMetadata
  const layers = [
    canonical.global,
    ...(sourceId
      ? [canonical.sources[sourceId] ?? []]
      : []),
    ...(cameraId
      ? [canonical.cameras[cameraId] ?? []]
      : []),
    ...(segmentId
      ? [canonical.segments[segmentId] ?? []]
      : []),
  ]
  const selected = new Map<ColorTransformKind, Readonly<ColorTransform>>()
  for (const layer of layers) {
    for (const transform of layer) selected.set(transform.kind, transform)
  }
  assertDomain(
    COLOR_TRANSFORM_ORDER.every((kind) => selected.has(kind)),
    'INVALID_ARGUMENT',
    'ColorPlan must resolve every color stage explicitly',
  )
  const transforms = Object.freeze(
    COLOR_TRANSFORM_ORDER.map((kind) => selected.get(kind)!),
  )
  let current = sourceMetadata
  for (const transform of transforms) {
    assertDomain(
      sameMetadata(current, transform.input),
      'INVALID_ARGUMENT',
      `Color stage ${transform.kind} input does not match prior output`,
    )
    current = transform.output
  }
  assertDomain(
    sameMetadata(current, outputMetadata),
    'INVALID_ARGUMENT',
    'Color pipeline output does not match ColorPlan output metadata',
  )
  const content = Object.freeze({
    schemaVersion: 'resolved-color-pipeline/v1' as const,
    sourceMetadata,
    outputMetadata,
    stages: transforms,
    target: Object.freeze({
      ...(sourceId ? { sourceId } : {}),
      ...(cameraId ? { cameraId } : {}),
      ...(segmentId ? { segmentId } : {}),
    }),
  })
  return Object.freeze({
    ...content,
    manifestKey: transforms
      .map((item) =>
        `${item.kind}:${item.id}@${item.version}:${item.implementation.parametersHash}`)
      .join('>'),
    pipelineHash: calculateCanonicalHash(content),
  })
}

export function compileColorPlanTargets(input: {
  plan: Readonly<ColorPlan>
  targets: readonly Readonly<ColorPlanTarget>[]
}): Readonly<CompiledColorPlan> {
  const canonical = createColorPlan(input.plan)
  assertDomain(
    Array.isArray(input.targets) &&
      input.targets.length >= 1 &&
      input.targets.length <= 512,
    'INVALID_ARGUMENT',
    'ColorPlan compilation target count is invalid',
  )
  const targets = input.targets.map((target) => {
    assertDomain(
      target && typeof target === 'object' && !Array.isArray(target),
      'INVALID_ARGUMENT',
      'ColorPlan compilation target is invalid',
    )
    return resolveColorPlan(canonical, target)
  }).sort((left, right) =>
    calculateCanonicalHash(left.target).localeCompare(
      calculateCanonicalHash(right.target),
    ))
  const targetKeys = targets.map((target) =>
    calculateCanonicalHash(target.target))
  assertDomain(
    new Set(targetKeys).size === targetKeys.length,
    'INVALID_ARGUMENT',
    'ColorPlan compilation targets must be unique',
  )
  const content = Object.freeze({
    schemaVersion: 'compiled-color-plan/v1' as const,
    colorPlanHash: canonical.planHash,
    targets: Object.freeze(targets),
  })
  return Object.freeze({
    ...content,
    manifestHash: calculateCanonicalHash(content),
  })
}

export type LutRecord = { id: string; name: string; owner: string; license: string; tags: string[]; version: number; active: boolean; cube: string }
export function parseCube(input: { id: string; name: string; owner: string; license: string; tags?: string[]; cube: string }): LutRecord {
  const parsed = parseCube3d(input.cube)
  return { id: input.id, name: input.name.normalize('NFC'), owner: input.owner, license: input.license, tags: input.tags ?? [], version: 1, active: true, cube: parsed.canonicalContent }
}
export function selectWorkspaceLut(input: { projectChoice?: string | 'none'; workspaceDefault?: string; library: LutRecord[] }) {
  if (input.projectChoice === 'none') return undefined
  const id = input.projectChoice ?? input.workspaceDefault
  return input.library.find((item) => item.id === id && item.active)
}

export type ExportCell = { id: string; recipeId: string; format: OutputFormat; locale: string; status: 'queued' | 'rendering' | 'ready' | 'failed'; artifact?: string; attempts: number };
export function createExportMatrix(recipeIds: string[], formats: OutputFormat[], locales: string[]) {
  const cells: ExportCell[] = [];
  for (const recipeId of recipeIds) for (const format of formats) for (const locale of locales) cells.push({ id: `${recipeId}__${format.replace(':', 'x')}__${locale}`, recipeId, format, locale, status: 'queued', attempts: 0 });
  return cells;
}

export function preflightExports(cells: ExportCell[], input: { rights: boolean; ready: boolean; budget: number; storageMb: number; costPerCell?: number; mbPerCell?: number }) {
  const cost = cells.length * (input.costPerCell ?? 1);
  const storageMb = cells.length * (input.mbPerCell ?? 50);
  const blockers = [...(!input.rights ? ['rights'] : []), ...(!input.ready ? ['readiness'] : []), ...(cost > input.budget ? ['budget'] : []), ...(storageMb > input.storageMb ? ['storage'] : [])];
  return { allowed: blockers.length === 0, blockers, quantity: cells.length, cost, storageMb };
}

export function renderExportCell(cells: ExportCell[], id: string, success: boolean) {
  return cells.map(cell => cell.id !== id ? cell : { ...cell, status: success ? 'ready' as const : 'failed' as const, attempts: cell.attempts + 1, artifact: success ? `${cell.id}.mp4` : undefined });
}

export const SDR_COLOR_FIXTURES = [
  { source: 'rec709-camera-a', generator: 'testsrc2', expected: 'distinct-output-with-rec709-metadata' },
  { source: 'rec709-camera-b', generator: 'smptebars', expected: 'distinct-output-with-rec709-metadata' },
  { source: 'rec709-clipping-ramp', generator: 'limited-range-gradient', expected: 'at-least-40-preserved-levels' },
];
