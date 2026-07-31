import type {
  ColorMetadata,
  ColorTransform,
} from '../domain/color-and-export.ts'
import type {
  PersistedColorPipelineCompilation,
} from '../application/ports/color-pipeline-compilation-repository.ts'
import { DomainError } from '../domain/errors.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, allowed: readonly string[], field: string) {
  const fields = Object.keys(value).filter((key) => !allowed.includes(key))
  if (fields.length) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields })
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value.trim()
}

function metadata(value: unknown, field: string): ColorMetadata {
  const item = record(value, field)
  exact(item, ['colorSpace', 'transfer', 'primaries', 'matrix', 'range', 'bitDepth'], field)
  return {
    colorSpace: string(item.colorSpace, `${field}.colorSpace`),
    transfer: string(item.transfer, `${field}.transfer`),
    primaries: string(item.primaries, `${field}.primaries`),
    matrix: string(item.matrix, `${field}.matrix`),
    range: item.range as 'full' | 'limited',
    bitDepth: item.bitDepth as number,
  }
}

function transform(
  value: unknown,
  index: number,
): Omit<ColorTransform, 'input'> {
  const field = `stages[${index}]`
  const item = record(value, field)
  exact(item, ['id', 'kind', 'version', 'enabled', 'output', 'implementation', 'lut'], field)
  const implementation = record(item.implementation, `${field}.implementation`)
  exact(implementation, ['provider', 'version', 'parameters', 'parametersHash'], `${field}.implementation`)
  const parameters = record(implementation.parameters, `${field}.implementation.parameters`)
  if (!Object.values(parameters).every((nested) =>
    typeof nested === 'string' || typeof nested === 'boolean' ||
      typeof nested === 'number' && Number.isFinite(nested))) {
    throw new DomainError('INVALID_ARGUMENT', `${field}.implementation.parameters is invalid`)
  }
  let lut: ColorTransform['lut']
  if (item.lut !== undefined) {
    const rawLut = record(item.lut, `${field}.lut`)
    exact(rawLut, ['artifactId', 'sha256'], `${field}.lut`)
    lut = { artifactId: string(rawLut.artifactId, `${field}.lut.artifactId`), sha256: string(rawLut.sha256, `${field}.lut.sha256`) }
  }
  return {
    id: string(item.id, `${field}.id`),
    kind: item.kind as ColorTransform['kind'],
    version: string(item.version, `${field}.version`),
    enabled: item.enabled as boolean,
    output: metadata(item.output, `${field}.output`),
    implementation: {
      provider: string(implementation.provider, `${field}.implementation.provider`),
      version: string(implementation.version, `${field}.implementation.version`),
      parameters: parameters as Record<string, string | number | boolean>,
      parametersHash: string(implementation.parametersHash, `${field}.implementation.parametersHash`),
    },
    ...(lut ? { lut } : {}),
  }
}

export function parseCreateColorPipelineCompilationBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, ['sourceArtifactId', 'sourceManifestId', 'outputMetadata', 'stages'], 'body')
  if (!Array.isArray(body.stages) || body.stages.length !== 4) {
    throw new DomainError('INVALID_ARGUMENT', 'stages must contain exactly four transforms')
  }
  return Object.freeze({
    sourceArtifactId: string(body.sourceArtifactId, 'sourceArtifactId'),
    sourceManifestId: string(body.sourceManifestId, 'sourceManifestId'),
    outputMetadata: metadata(body.outputMetadata, 'outputMetadata'),
    stages: Object.freeze(body.stages.map(transform)),
  })
}

export function presentColorPipelineCompilation(
  value: Readonly<PersistedColorPipelineCompilation>,
) {
  return value.compilation
}
