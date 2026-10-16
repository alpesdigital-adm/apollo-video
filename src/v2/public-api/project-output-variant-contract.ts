export { parseCreateProjectOutputVariantBody } from '../application/create-project.ts'
import type { ProjectVersionV2, ProjectVersionV3 } from '../domain/project-version.ts'

export function presentOutputBoundVersion(version: ProjectVersionV2 | ProjectVersionV3) {
  return { id: version.id, sequence: version.sequence, baseHash: version.baseHash,
    snapshotRefs: version.snapshotRefs, createdAt: version.createdAt,
    ...('parentVersionId' in version ? { parentVersionId: version.parentVersionId } : {}),
    outputContractVersion: version.outputContractVersion, outputStateId: version.outputStateId,
    outputStateHash: version.outputStateHash }
}

const id = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$' } as const
const hash = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const
const positive = { type: 'integer', minimum: 1 } as const
const sealedSchema = { type: 'object', additionalProperties: false, required: ['schemaVersion', 'document', 'hash'],
  properties: { schemaVersion: { type: 'string' }, document: { type: 'object' }, hash } } as const
const encoding = (final: boolean) => ({ type: 'object', additionalProperties: false,
  required: ['codec', 'encoder', 'pixelFormat', 'container', 'faststart', 'width', 'height', 'fps', 'quality', 'audio'],
  properties: { codec: { const: 'h264' }, encoder: { const: 'libx264' }, pixelFormat: { const: 'yuv420p' },
    container: { const: 'mp4' }, faststart: { const: true }, width: positive, height: positive,
    fps: { type: 'integer', minimum: 1, maximum: 120 },
    quality: { type: 'object', additionalProperties: false, required: ['mode', 'value', 'preset'],
      properties: { mode: { const: 'crf' }, value: { const: final ? 18 : 23 }, preset: { const: final ? 'medium' : 'veryfast' } } },
    audio: { type: 'object', additionalProperties: false, required: ['codec', 'bitrateKbps', 'sampleRateHz', 'channels'],
      properties: { codec: { const: 'aac' }, bitrateKbps: { const: final ? 192 : 160 }, sampleRateHz: { const: 48000 },
        channels: { type: 'integer', minimum: 1, maximum: 8 } } },
  } })
export const createProjectOutputVariantRequestSchema = { type: 'object', additionalProperties: false,
  required: ['baseVersionId', 'baseHash', 'output', 'profile', 'preset'], properties: {
    baseVersionId: id, baseHash: hash, reason: { type: 'string', minLength: 1, maxLength: 1000 },
    output: { type: 'object', additionalProperties: false,
      required: ['locale', 'aspectRatio', 'width', 'height', 'fps', 'safeArea', 'deliveryProfileId'],
      properties: { locale: { type: 'string', minLength: 2, maxLength: 35 }, aspectRatio: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
        width: positive, height: positive, fps: { type: 'integer', minimum: 1, maximum: 120 }, deliveryProfileId: id,
        safeArea: { type: 'object', additionalProperties: false, required: ['top', 'right', 'bottom', 'left'],
          properties: Object.fromEntries(['top', 'right', 'bottom', 'left'].map(k => [k, { type: 'number', minimum: 0, exclusiveMaximum: 0.5 }])) } } },
    profile: { type: 'object', additionalProperties: false,
      required: ['schemaVersion', 'id', 'version', 'rendererContractVersion', 'final', 'proxy', 'proxyToFinal', 'subtitles'],
      properties: { schemaVersion: { const: 'materialized-delivery-profile/v1' }, id, version: positive,
        rendererContractVersion: { const: 'ffmpeg-editorial-output/v1' }, final: encoding(true), proxy: encoding(false),
        proxyToFinal: { type: 'object', additionalProperties: false, required: ['schemaVersion', 'scaleX', 'scaleY'],
          properties: { schemaVersion: { const: 'output-canvas-transform/v1' }, scaleX: { type: 'number', exclusiveMinimum: 0 },
            scaleY: { type: 'number', exclusiveMinimum: 0 } } },
        subtitles: { type: 'object', additionalProperties: false, required: ['mode', 'configuration', 'fontAssets'],
          properties: { mode: { enum: ['none', 'burn-in', 'sidecar'] }, configuration: { anyOf: [{ type: 'null' }, sealedSchema] },
            fontAssets: { type: 'array', maxItems: 128, items: { type: 'object', additionalProperties: false,
              required: ['artifactId', 'sha256'], properties: { artifactId: id, sha256: hash } } } } } } },
    preset: { anyOf: [{ type: 'null' }, sealedSchema] },
  } } as const
export const outputBoundVersionSchemaFields = {
  id, sequence: positive, baseHash: hash, createdAt: { type: 'string', format: 'date-time' }, parentVersionId: id,
  outputContractVersion: { enum: [2, 3] }, outputStateId: id, outputStateHash: hash,
  snapshotRefs: { type: 'object', additionalProperties: false, required: ['brief', 'editPlan', 'policies'],
    properties: { brief: id, editPlan: id, policies: id, treatment: id, story: id } },
} as const
export const outputConsumptionSummarySchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['status', 'reasons'], properties: {
    status: { const: 'blocked' }, reasons: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } } } },
  { type: 'object', additionalProperties: false, required: ['status', 'materializationHash'], properties: {
    status: { const: 'materialized' }, materializationHash: hash } },
] } as const
