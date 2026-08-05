import { DomainError, assertDomain } from '../domain/errors.ts'
import { PUBLIC_DATE_TIME_SCHEMA, PUBLIC_ID_SCHEMA } from './conventions.ts'
import { PUBLIC_EVENT_CATALOG } from '../domain/public-event.ts'
import { PUBLIC_ERROR_CODES } from './public-error-catalog.ts'
import {
  MVP_CORE_ACCEPTANCE_CRITERIA,
  MVP_CORE_CRITERION_CHECKS,
  MVP_CORE_EVIDENCE_RESOURCE_TYPES,
} from '../domain/mvp-core-gate.ts'

export type JsonSchema = Readonly<Record<string, unknown>>

export interface PublicSchemaDefinition {
  ref: string
  id: string
  version: number
  title: string
  schema: JsonSchema
}

const idSchema = PUBLIC_ID_SCHEMA
const dateTimeSchema = PUBLIC_DATE_TIME_SCHEMA
const sha256Schema = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const workspaceLutSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'workspaceId', 'status', 'currentVersion'],
  properties: {
    id: idSchema, workspaceId: idSchema, status: { enum: ['active', 'inactive'] },
    currentVersion: {
      type: 'object', additionalProperties: false,
      required: ['id', 'version', 'name', 'owner', 'license', 'tags', 'compatibility', 'intensity', 'cube', 'preview', 'createdByClientId', 'createdAt', 'recordHash'],
      properties: {
        id: idSchema, version: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1, maxLength: 160 }, owner: { type: 'string', minLength: 1, maxLength: 240 },
        license: { type: 'object', additionalProperties: false, required: ['policy', 'name'], properties: { policy: { enum: ['owned', 'licensed', 'restricted'] }, name: { type: 'string', minLength: 1, maxLength: 240 }, usageNotes: { type: 'string', minLength: 1, maxLength: 2000 } } },
        tags: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 48 } },
        compatibility: { type: 'object', additionalProperties: false, required: ['inputColorSpace', 'outputColorSpace'], properties: { inputColorSpace: { enum: ['rec709', 'display-p3', 'rec2020'] }, outputColorSpace: { enum: ['rec709', 'display-p3', 'rec2020'] } } },
        intensity: { type: 'object', additionalProperties: false, required: ['default', 'min', 'max'], properties: { default: { type: 'number', minimum: 0, maximum: 1 }, min: { const: 0 }, max: { const: 1 } } },
        cube: { type: 'object', additionalProperties: false, required: ['size', 'domainMin', 'domainMax', 'rows', 'contentHash'], properties: { title: { type: 'string', minLength: 1, maxLength: 240 }, size: { type: 'integer', minimum: 2, maximum: 65 }, domainMin: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } }, domainMax: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } }, rows: { type: 'integer', minimum: 8 }, contentHash: sha256Schema } },
        preview: { type: 'object', additionalProperties: false, required: ['mediaType', 'width', 'height', 'byteSize', 'sha256', 'path'], properties: { mediaType: { const: 'image/png' }, width: { const: 512 }, height: { const: 288 }, byteSize: { type: 'integer', minimum: 1 }, sha256: sha256Schema, path: { type: 'string', pattern: '^/v1/workspaces/[^/]+/luts/[^/]+/versions/[1-9][0-9]*/preview$' } } },
        createdByClientId: idSchema, createdAt: dateTimeSchema, recordHash: sha256Schema,
      },
    },
  },
} as const
const workspaceLutVersionSchema = workspaceLutSchema.properties.currentVersion
const workspaceLutLifecycleSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'workspaceId', 'status', 'revision', 'currentVersion'],
  properties: { id: idSchema, workspaceId: idSchema, status: { enum: ['active', 'inactive'] }, revision: { type: 'integer', minimum: 1 }, currentVersion: { type: 'integer', minimum: 1 } },
} as const
const workspaceLutStatusCommandSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'lutId', 'baseRevision', 'resultRevision', 'status', 'createdByClientId', 'createdAt'],
  properties: { id: idSchema, lutId: idSchema, baseRevision: { type: 'integer', minimum: 1 }, resultRevision: { type: 'integer', minimum: 2 }, status: { enum: ['active', 'inactive'] }, createdByClientId: idSchema, createdAt: dateTimeSchema },
} as const
const workspaceLutDefaultVersionSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'revision', 'mode', 'selectionHash', 'createdByClientId', 'createdAt'],
  properties: {
    id: idSchema, revision: { type: 'integer', minimum: 1 }, mode: { enum: ['none', 'lut-version'] }, selectionHash: sha256Schema,
    lut: { type: 'object', additionalProperties: false, required: ['id', 'versionId', 'version', 'name', 'recordHash'], properties: { id: idSchema, versionId: idSchema, version: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1, maxLength: 160 }, recordHash: sha256Schema } },
    createdByClientId: idSchema, createdAt: dateTimeSchema,
  },
} as const
const projectLutSelectionResultSchema = {
  type: 'object', additionalProperties: false, required: ['command', 'version', 'selection', 'replayed'],
  properties: {
    command: { type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'author', 'createdAt'], properties: { id: idSchema, type: { const: 'set-project-lut-selection' }, baseVersionId: idSchema, author: { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: { enum: ['user', 'director', 'system', 'api-client'] }, id: idSchema, delegatedUserId: idSchema } }, reason: { type: 'string', minLength: 1, maxLength: 1000 }, createdAt: dateTimeSchema } },
    version: { type: 'object', additionalProperties: false, required: ['id', 'sequence', 'parentVersionId', 'baseHash', 'createdAt'], properties: { id: idSchema, sequence: { type: 'integer', minimum: 2 }, parentVersionId: idSchema, baseHash: sha256Schema, createdAt: dateTimeSchema } },
    selection: {
      type: 'object', additionalProperties: false, required: ['id', 'requested', 'resolved', 'intensity', 'selectionHash', 'createdAt'],
      properties: {
        id: idSchema,
        requested: { oneOf: [
          { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'workspace-default' } } },
          { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'none' } } },
          { type: 'object', additionalProperties: false, required: ['mode', 'lutId', 'version'], properties: { mode: { const: 'lut-version' }, lutId: idSchema, version: { type: 'integer', minimum: 1 } } },
        ] },
        resolved: { oneOf: [
          { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'none' } } },
          { type: 'object', additionalProperties: false, required: ['mode', 'lut'], properties: { mode: { const: 'lut-version' }, lut: { type: 'object', additionalProperties: false, required: ['lutId', 'versionId', 'version', 'name', 'recordHash', 'cubeContentHash'], properties: { lutId: idSchema, versionId: idSchema, version: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1, maxLength: 160 }, recordHash: sha256Schema, cubeContentHash: sha256Schema } } } },
        ] },
        workspaceDefaultRevision: { type: 'integer', minimum: 0 }, intensity: { type: 'number', minimum: 0, maximum: 1 }, selectionHash: sha256Schema, createdAt: dateTimeSchema,
      },
    },
    replayed: { type: 'boolean' },
  },
} as const
const mvpCoreCheckCodes = Object.values(MVP_CORE_CRITERION_CHECKS).flat()
const mvpCoreEvidenceReferenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'id'],
  properties: {
    type: { enum: MVP_CORE_EVIDENCE_RESOURCE_TYPES },
    id: idSchema,
    hash: sha256Schema,
  },
}
const mvpCoreCriterionEvidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'criterion',
    'source',
    'automatic',
    'passed',
    'missingChecks',
    'checks',
  ],
  properties: {
    criterion: { enum: MVP_CORE_ACCEPTANCE_CRITERIA },
    source: { const: 'server' },
    automatic: { const: true },
    passed: { type: 'boolean' },
    missingChecks: {
      type: 'array',
      maxItems: 6,
      uniqueItems: true,
      items: { enum: mvpCoreCheckCodes },
    },
    checks: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'passed', 'references'],
        properties: {
          code: { enum: mvpCoreCheckCodes },
          passed: { type: 'boolean' },
          references: {
            type: 'array',
            minItems: 1,
            maxItems: 16,
            items: mvpCoreEvidenceReferenceSchema,
          },
        },
      },
    },
  },
}
const mvpCoreGateReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'gate',
    'workspaceId',
    'primaryProjectId',
    'companionProjectId',
    'approved',
    'covered',
    'passed',
    'total',
    'missing',
    'failed',
    'serverEvidenceOnly',
    'evidence',
    'evaluatedAt',
    'fingerprint',
  ],
  properties: {
    schemaVersion: { const: 'mvp-core-gate-report/v1' },
    gate: { const: 'mvp-core/v1' },
    workspaceId: idSchema,
    primaryProjectId: idSchema,
    companionProjectId: idSchema,
    approved: { type: 'boolean' },
    covered: { type: 'integer', minimum: 0, maximum: 16 },
    passed: { type: 'integer', minimum: 0, maximum: 16 },
    total: { const: 16 },
    missing: {
      type: 'array',
      maxItems: 16,
      uniqueItems: true,
      items: { enum: MVP_CORE_ACCEPTANCE_CRITERIA },
    },
    failed: {
      type: 'array',
      maxItems: 16,
      uniqueItems: true,
      items: { enum: MVP_CORE_ACCEPTANCE_CRITERIA },
    },
    serverEvidenceOnly: { const: true },
    evidence: {
      type: 'array',
      maxItems: 16,
      items: mvpCoreCriterionEvidenceSchema,
    },
    evaluatedAt: dateTimeSchema,
    fingerprint: sha256Schema,
  },
}
const mvpCoreGateSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'primaryProjectId',
    'companionProjectId',
    'primaryVersionId',
    'companionVersionId',
    'primaryVersionHash',
    'companionVersionHash',
    'report',
    'reportFingerprint',
    'createdBy',
    'createdAt',
    'recordHash',
  ],
  properties: {
    schemaVersion: { const: 'mvp-core-gate/v1' },
    id: idSchema,
    workspaceId: idSchema,
    primaryProjectId: idSchema,
    companionProjectId: idSchema,
    primaryVersionId: idSchema,
    companionVersionId: idSchema,
    primaryVersionHash: sha256Schema,
    companionVersionHash: sha256Schema,
    report: mvpCoreGateReportSchema,
    reportFingerprint: sha256Schema,
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'api-client' },
        id: idSchema,
      },
    },
    createdAt: dateTimeSchema,
    recordHash: sha256Schema,
  },
}
const speechCatalogProducerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'model', 'version', 'confidence'],
  properties: {
    provider: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
    model: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
    version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const speechObservedInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'confidence'],
  properties: {
    value: { type: 'string', minLength: 1, maxLength: 240 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const speechCatalogProvenanceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'source',
    'provider',
    'model',
    'version',
    'confidence',
    'observedAt',
  ],
  properties: {
    source: { enum: ['transcript', 'catalog-observation'] },
    provider: { type: 'string', minLength: 1, maxLength: 128 },
    model: { type: 'string', minLength: 1, maxLength: 128 },
    version: { type: 'string', minLength: 1, maxLength: 128 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    observedAt: dateTimeSchema,
  },
}
const speechCatalogObservationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'normalizedValue', 'provenance'],
  properties: {
    value: { type: 'string', minLength: 1, maxLength: 240 },
    normalizedValue: { type: 'string', minLength: 1, maxLength: 240 },
    provenance: speechCatalogProvenanceSchema,
  },
}
const speechSegmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'catalogRunId',
    'sourceTranscriptId',
    'sourceTranscriptHash',
    'sourceArtifactId',
    'sourceSegmentId',
    'exactText',
    'normalizedText',
    'words',
    'speaker',
    'speakerId',
    'rangeMs',
    'completeThoughtScore',
    'classification',
    'visual',
    'intentions',
    'extractionProvenance',
    'extractionPolicyVersion',
    'physicalMaterialized',
    'createdAt',
    'segmentHash',
  ],
  properties: {
    schemaVersion: { const: 'speech-segment/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    catalogRunId: idSchema,
    sourceTranscriptId: idSchema,
    sourceTranscriptHash: sha256Schema,
    sourceArtifactId: idSchema,
    sourceSegmentId: { type: 'integer', minimum: 0 },
    exactText: { type: 'string', minLength: 1, maxLength: 10000 },
    normalizedText: { type: 'string', minLength: 1, maxLength: 10000 },
    words: {
      type: 'array',
      minItems: 1,
      maxItems: 20000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['word', 'startMs', 'endMs', 'confidence'],
        properties: {
          word: { type: 'string', minLength: 1, maxLength: 240 },
          startMs: { type: 'integer', minimum: 0 },
          endMs: { type: 'integer', minimum: 0 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    speaker: speechCatalogObservationSchema,
    speakerId: { type: 'string', minLength: 1, maxLength: 240 },
    rangeMs: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'integer', minimum: 0 },
    },
    completeThoughtScore: { type: 'number', minimum: 0, maximum: 1 },
    classification: {
      enum: ['complete-thought', 'incomplete', 'interrupted'],
    },
    visual: {
      type: 'object',
      additionalProperties: false,
      required: ['colors'],
      properties: {
        emotion: speechCatalogObservationSchema,
        expression: speechCatalogObservationSchema,
        wardrobe: speechCatalogObservationSchema,
        setting: speechCatalogObservationSchema,
        colors: {
          type: 'array',
          maxItems: 32,
          items: speechCatalogObservationSchema,
        },
      },
    },
    intentions: {
      type: 'array',
      maxItems: 64,
      items: speechCatalogObservationSchema,
    },
    extractionProvenance: speechCatalogProvenanceSchema,
    extractionPolicyVersion: { const: 'speech-segment-extraction/v1' },
    physicalMaterialized: { const: false },
    createdAt: dateTimeSchema,
    segmentHash: sha256Schema,
  },
}
const speechCatalogRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'sourceTranscriptId',
    'sourceTranscriptHash',
    'sourceArtifactId',
    'extractionPolicyVersion',
    'producer',
    'annotationsHash',
    'segments',
    'segmentCount',
    'createdBy',
    'createdAt',
    'recordHash',
    'active',
  ],
  properties: {
    schemaVersion: { const: 'speech-segment-catalog-run/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    sourceTranscriptId: idSchema,
    sourceTranscriptHash: sha256Schema,
    sourceArtifactId: idSchema,
    extractionPolicyVersion: { const: 'speech-segment-extraction/v1' },
    producer: speechCatalogProducerSchema,
    annotationsHash: sha256Schema,
    segments: {
      type: 'array',
      minItems: 1,
      maxItems: 100000,
      items: speechSegmentSchema,
    },
    segmentCount: { type: 'integer', minimum: 1, maximum: 100000 },
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'api-client' },
        id: idSchema,
      },
    },
    createdAt: dateTimeSchema,
    recordHash: sha256Schema,
    active: { type: 'boolean' },
  },
}
const evidenceProducerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'model', 'version', 'confidence'],
  properties: {
    provider: { type: 'string', minLength: 1, maxLength: 128 },
    model: { type: 'string', minLength: 1, maxLength: 128 },
    version: { type: 'string', minLength: 1, maxLength: 128 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const evidenceObservedInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'confidence'],
  properties: {
    value: { type: 'string', minLength: 1, maxLength: 2000 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const evidenceIdentityObservedInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'confidence'],
  properties: {
    value: { type: 'string', minLength: 1, maxLength: 240 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const evidenceObservationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'normalizedValue', 'provenance'],
  properties: {
    value: { type: 'string', minLength: 1, maxLength: 2000 },
    normalizedValue: { type: 'string', minLength: 1, maxLength: 2000 },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: [
        'source',
        'provider',
        'model',
        'version',
        'confidence',
        'observedAt',
      ],
      properties: {
        source: { const: 'evidence-observation' },
        provider: { type: 'string', minLength: 1, maxLength: 128 },
        model: { type: 'string', minLength: 1, maxLength: 128 },
        version: { type: 'string', minLength: 1, maxLength: 128 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        observedAt: dateTimeSchema,
      },
    },
  },
}
const evidenceSegmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'sourceSpeechSegmentId',
    'sourceSpeechSegmentHash',
    'sourceTranscriptId',
    'sourceTranscriptHash',
    'sourceArtifactId',
    'rightsSnapshotId',
    'rightsStatus',
    'consentStatus',
    'category',
    'speaker',
    'speakerId',
    'claim',
    'context',
    'qualifiers',
    'subject',
    'attribution',
    'compatibleOfferIds',
    'compatibleAudienceTags',
    'compatibleObjections',
    'credibilityScore',
    'specificityScore',
    'authenticityScore',
    'sourceRangeMs',
    'contextRangeMs',
    'handlesMs',
    'exactTranscript',
    'frameRefs',
    'adjacentEvidenceIds',
    'requiresContext',
    'integrityStatus',
    'integrityReasons',
    'producer',
    'integrityPolicyVersion',
    'physicalMaterialized',
    'createdBy',
    'createdAt',
    'evidenceHash',
  ],
  properties: {
    schemaVersion: { const: 'evidence-segment/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    sourceSpeechSegmentId: idSchema,
    sourceSpeechSegmentHash: sha256Schema,
    sourceTranscriptId: idSchema,
    sourceTranscriptHash: sha256Schema,
    sourceArtifactId: idSchema,
    rightsSnapshotId: idSchema,
    rightsStatus: {
      enum: ['approved', 'restricted', 'unknown', 'expired', 'revoked'],
    },
    consentStatus: {
      enum: [
        'not-required',
        'approved',
        'restricted',
        'unknown',
        'expired',
        'revoked',
      ],
    },
    category: {
      enum: [
        'testimonial',
        'financial-result',
        'before-after',
        'hearsay',
        'authority',
        'case-study',
        'demonstration',
      ],
    },
    speaker: speechCatalogObservationSchema,
    speakerId: { type: 'string', minLength: 1, maxLength: 240 },
    claim: evidenceObservationSchema,
    result: evidenceObservationSchema,
    context: evidenceObservationSchema,
    qualifiers: {
      type: 'array',
      maxItems: 32,
      items: evidenceObservationSchema,
    },
    subject: evidenceObservationSchema,
    attribution: evidenceObservationSchema,
    compatibleOfferIds: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: idSchema,
    },
    compatibleAudienceTags: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
    compatibleObjections: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
    credibilityScore: { type: 'number', minimum: 0, maximum: 1 },
    specificityScore: { type: 'number', minimum: 0, maximum: 1 },
    authenticityScore: { type: 'number', minimum: 0, maximum: 1 },
    sourceRangeMs: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'integer', minimum: 0 },
    },
    contextRangeMs: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'integer', minimum: 0 },
    },
    handlesMs: {
      type: 'object',
      additionalProperties: false,
      required: ['before', 'after'],
      properties: {
        before: { type: 'integer', minimum: 0 },
        after: { type: 'integer', minimum: 0 },
      },
    },
    exactTranscript: { type: 'string', minLength: 1, maxLength: 10000 },
    frameRefs: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: idSchema,
    },
    adjacentEvidenceIds: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: idSchema,
    },
    requiresContext: { type: 'boolean' },
    integrityStatus: {
      enum: ['valid', 'context-required', 'blocked'],
    },
    integrityReasons: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
    producer: evidenceProducerSchema,
    integrityPolicyVersion: { const: 'evidence-integrity/v1' },
    physicalMaterialized: { const: false },
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'api-client' },
        id: idSchema,
      },
    },
    createdAt: dateTimeSchema,
    evidenceHash: sha256Schema,
  },
}
const evidenceReuseDecisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'allowed',
    'reasons',
    'requiredContextRangeMs',
    'requiredAdjacentEvidenceIds',
    'requiredQualifierValues',
    'rightsSnapshotId',
  ],
  properties: {
    allowed: { type: 'boolean' },
    reasons: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
    requiredContextRangeMs: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'integer', minimum: 0 },
    },
    requiredAdjacentEvidenceIds: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: idSchema,
    },
    requiredQualifierValues: {
      type: 'array',
      maxItems: 32,
      items: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    rightsSnapshotId: idSchema,
  },
}
const longFormProducerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'model', 'version', 'confidence'],
  properties: {
    provider: { type: 'string', minLength: 1, maxLength: 128 },
    model: { type: 'string', minLength: 1, maxLength: 128 },
    version: { type: 'string', minLength: 1, maxLength: 128 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const longFormObservationInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'confidence'],
  properties: {
    value: { type: 'string', minLength: 1, maxLength: 5000 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const longFormObservationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'normalizedValue', 'provenance'],
  properties: {
    value: { type: 'string', minLength: 1, maxLength: 5000 },
    normalizedValue: { type: 'string', minLength: 1, maxLength: 5000 },
    provenance: {
      type: 'object',
      additionalProperties: false,
      required: [
        'source',
        'provider',
        'model',
        'version',
        'confidence',
        'observedAt',
      ],
      properties: {
        source: { const: 'long-form-analysis' },
        provider: { type: 'string', minLength: 1, maxLength: 128 },
        model: { type: 'string', minLength: 1, maxLength: 128 },
        version: { type: 'string', minLength: 1, maxLength: 128 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        observedAt: dateTimeSchema,
      },
    },
  },
}
const longFormRangeSchema = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: { type: 'integer', minimum: 0 },
}
const longFormChapterSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'indexRunId',
    'sourceArtifactId',
    'sourceChapterId',
    'title',
    'topicPath',
    'rangeMs',
    'momentIds',
    'physicalMaterialized',
    'indexPolicyVersion',
    'createdAt',
    'chapterHash',
  ],
  properties: {
    schemaVersion: { const: 'long-form-chapter/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    indexRunId: idSchema,
    sourceArtifactId: idSchema,
    sourceChapterId: idSchema,
    title: longFormObservationSchema,
    topicPath: {
      type: 'array',
      maxItems: 16,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
    rangeMs: longFormRangeSchema,
    momentIds: {
      type: 'array',
      maxItems: 100000,
      uniqueItems: true,
      items: idSchema,
    },
    physicalMaterialized: { const: false },
    indexPolicyVersion: { const: 'long-form-index/v1' },
    createdAt: dateTimeSchema,
    chapterHash: sha256Schema,
  },
}
const longFormMomentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'indexRunId',
    'chapterId',
    'sourceArtifactId',
    'sourceMomentId',
    'topic',
    'summary',
    'speakerIds',
    'rangesMs',
    'recommendedRangeIndex',
    'recommendedRangeMs',
    'evidenceSpanIds',
    'salience',
    'hookPotential',
    'standaloneScore',
    'contextScore',
    'insightDensity',
    'roles',
    'tags',
    'physicalMaterialized',
    'indexPolicyVersion',
    'createdAt',
    'momentHash',
  ],
  properties: {
    schemaVersion: { const: 'long-form-moment/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    indexRunId: idSchema,
    chapterId: idSchema,
    sourceArtifactId: idSchema,
    sourceMomentId: idSchema,
    topic: longFormObservationSchema,
    summary: longFormObservationSchema,
    keyQuote: longFormObservationSchema,
    speakerIds: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: idSchema,
    },
    rangesMs: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: longFormRangeSchema,
    },
    recommendedRangeIndex: {
      type: 'integer',
      minimum: 0,
      maximum: 31,
    },
    recommendedRangeMs: longFormRangeSchema,
    evidenceSpanIds: {
      type: 'array',
      maxItems: 256,
      uniqueItems: true,
      items: idSchema,
    },
    salience: { type: 'number', minimum: 0, maximum: 1 },
    hookPotential: { type: 'number', minimum: 0, maximum: 1 },
    standaloneScore: { type: 'number', minimum: 0, maximum: 1 },
    contextScore: { type: 'number', minimum: 0, maximum: 1 },
    insightDensity: { type: 'number', minimum: 0, maximum: 1 },
    roles: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
    tags: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
    physicalMaterialized: { const: false },
    indexPolicyVersion: { const: 'long-form-index/v1' },
    createdAt: dateTimeSchema,
    momentHash: sha256Schema,
  },
}
const longFormIndexRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'sourceManifestId',
    'sourceManifestHash',
    'durationMs',
    'rightsSnapshotId',
    'rightsStatus',
    'consentStatus',
    'indexPolicyVersion',
    'producer',
    'chapters',
    'moments',
    'chapterCount',
    'momentCount',
    'hierarchyHash',
    'createdBy',
    'createdAt',
    'recordHash',
    'active',
  ],
  properties: {
    schemaVersion: { const: 'long-form-index-run/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    sourceManifestId: idSchema,
    sourceManifestHash: sha256Schema,
    durationMs: { type: 'integer', minimum: 1 },
    rightsSnapshotId: idSchema,
    rightsStatus: {
      enum: ['approved', 'restricted', 'unknown', 'expired', 'revoked'],
    },
    consentStatus: {
      enum: [
        'not-required',
        'approved',
        'restricted',
        'unknown',
        'expired',
        'revoked',
      ],
    },
    indexPolicyVersion: { const: 'long-form-index/v1' },
    producer: longFormProducerSchema,
    chapters: {
      type: 'array',
      minItems: 1,
      maxItems: 10000,
      items: longFormChapterSchema,
    },
    moments: {
      type: 'array',
      minItems: 1,
      maxItems: 100000,
      items: longFormMomentSchema,
    },
    chapterCount: { type: 'integer', minimum: 1, maximum: 10000 },
    momentCount: { type: 'integer', minimum: 1, maximum: 100000 },
    hierarchyHash: sha256Schema,
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'api-client' },
        id: idSchema,
      },
    },
    createdAt: dateTimeSchema,
    recordHash: sha256Schema,
    active: { type: 'boolean' },
  },
}
const longFormPreviewRangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sourceRangeMs',
    'previewRangeMs',
    'clippedBefore',
    'clippedAfter',
  ],
  properties: {
    sourceRangeMs: longFormRangeSchema,
    previewRangeMs: longFormRangeSchema,
    clippedBefore: { type: 'boolean' },
    clippedAfter: { type: 'boolean' },
  },
}
const longFormPreviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sourceArtifactId',
    'masterDurationMs',
    'requestedContextMs',
    'primary',
    'ranges',
  ],
  properties: {
    sourceArtifactId: idSchema,
    masterDurationMs: { type: 'integer', minimum: 1 },
    requestedContextMs: {
      type: 'object',
      additionalProperties: false,
      required: ['before', 'after'],
      properties: {
        before: { type: 'integer', minimum: 0, maximum: 300000 },
        after: { type: 'integer', minimum: 0, maximum: 300000 },
      },
    },
    primary: longFormPreviewRangeSchema,
    ranges: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      items: longFormPreviewRangeSchema,
    },
  },
}
const validationScopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['unit', 'evidenceScope'],
  properties: {
    unit: { enum: ['hook', 'segment', 'whole-video'] },
    evidenceScope: {
      enum: ['copy', 'spoken-take', 'opening-edit'],
    },
  },
}
const validationSourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['platform', 'publicationRef', 'observedAt'],
  properties: {
    platform: { type: 'string', minLength: 1, maxLength: 128 },
    publicationRef: { type: 'string', minLength: 1, maxLength: 240 },
    accountRef: { type: 'string', minLength: 1, maxLength: 240 },
    url: { type: 'string', format: 'uri', maxLength: 2000 },
    observedAt: dateTimeSchema,
  },
}
const validationMetricUnitSchema = {
  enum: ['ratio', 'percent', 'seconds', 'count', 'currency', 'score'],
}
const validationPerformanceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['metric', 'value', 'unit', 'sampleSize', 'period'],
  properties: {
    metric: { type: 'string', minLength: 1, maxLength: 128 },
    value: { type: 'number', minimum: 0 },
    unit: validationMetricUnitSchema,
    sampleSize: {
      type: 'integer',
      minimum: 1,
      maximum: 10000000000,
    },
    period: {
      type: 'object',
      additionalProperties: false,
      required: ['start', 'end'],
      properties: {
        start: dateTimeSchema,
        end: dateTimeSchema,
      },
    },
    comparison: {
      type: 'object',
      additionalProperties: false,
      required: ['label', 'value', 'unit'],
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 240 },
        value: { type: 'number', minimum: 0 },
        unit: validationMetricUnitSchema,
      },
    },
  },
}
const protectedValidationEnvelopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'sourceRangeMs',
    'protectedAspects',
    'copyProtected',
    'takeProtected',
    'timingProtected',
    'openingProtected',
    'envelopeHash',
  ],
  properties: {
    schemaVersion: { const: 'protected-validation-envelope/v1' },
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    sourceRangeMs: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: { type: 'integer', minimum: 0 },
    },
    sourceSpeechSegmentId: idSchema,
    sourceSpeechSegmentHash: sha256Schema,
    exactCopy: { type: 'string', minLength: 1, maxLength: 20000 },
    speakerId: idSchema,
    protectedAspects: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: { enum: ['copy', 'take', 'timing', 'opening'] },
    },
    copyProtected: { type: 'boolean' },
    takeProtected: { type: 'boolean' },
    timingProtected: { type: 'boolean' },
    openingProtected: { type: 'boolean' },
    envelopeHash: sha256Schema,
  },
}
const validatedSegmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'sourceManifestId',
    'sourceManifestHash',
    'scope',
    'wholeVideoValidated',
    'source',
    'performance',
    'protectedEnvelope',
    'rightsSnapshotId',
    'rightsStatus',
    'consentStatus',
    'validatedAt',
    'claimPolicyVersion',
    'causalClaimAllowed',
    'policyVersion',
    'physicalMaterialized',
    'createdBy',
    'createdAt',
    'validatedSegmentHash',
  ],
  properties: {
    schemaVersion: { const: 'validated-segment/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    sourceManifestId: idSchema,
    sourceManifestHash: sha256Schema,
    sourceSpeechSegmentId: idSchema,
    sourceSpeechSegmentHash: sha256Schema,
    scope: validationScopeSchema,
    wholeVideoValidated: { type: 'boolean' },
    source: validationSourceSchema,
    performance: validationPerformanceSchema,
    protectedEnvelope: protectedValidationEnvelopeSchema,
    rightsSnapshotId: idSchema,
    rightsStatus: {
      enum: ['approved', 'restricted', 'unknown', 'expired', 'revoked'],
    },
    consentStatus: {
      enum: [
        'approved',
        'not-required',
        'restricted',
        'unknown',
        'expired',
        'revoked',
      ],
    },
    validatedAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
    claimPolicyVersion: { const: 'historical-association/v1' },
    causalClaimAllowed: { const: false },
    policyVersion: { const: 'validated-segment/v1' },
    physicalMaterialized: { const: false },
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'api-client' },
        id: idSchema,
      },
    },
    createdAt: dateTimeSchema,
    validatedSegmentHash: sha256Schema,
  },
}
const validatedSegmentTargetRecipeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'role', 'objective', 'format', 'locale'],
  properties: {
    id: idSchema,
    role: { enum: ['hook', 'body', 'cta', 'proof', 'whole-video'] },
    objective: { type: 'string', minLength: 1, maxLength: 128 },
    format: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
    locale: { type: 'string', pattern: '^[a-z]{2,3}(?:-[A-Z]{2})?$' },
  },
}
const validatedSegmentReuseDecisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'validatedSegmentId',
    'targetRecipe',
    'requestedChanges',
    'claim',
    'compatible',
    'reasons',
    'protectedAspects',
    'wholeVideoValidated',
    'causalClaimAllowed',
    'performanceInterpretation',
    'evaluatedAt',
  ],
  properties: {
    schemaVersion: { const: 'validated-segment-reuse-decision/v1' },
    validatedSegmentId: idSchema,
    targetRecipe: validatedSegmentTargetRecipeSchema,
    requestedChanges: {
      type: 'array',
      maxItems: 4,
      uniqueItems: true,
      items: { enum: ['copy', 'take', 'timing', 'opening'] },
    },
    claim: { enum: ['historical-association', 'causality'] },
    compatible: { type: 'boolean' },
    reasons: {
      type: 'array',
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
    protectedAspects: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: { enum: ['copy', 'take', 'timing', 'opening'] },
    },
    wholeVideoValidated: { type: 'boolean' },
    causalClaimAllowed: { const: false },
    performanceInterpretation: { const: 'historical-association' },
    evaluatedAt: dateTimeSchema,
  },
}
const hierarchicalTierNameSchema = {
  enum: ['cheap-signals', 'vision', 'language', 'aggregation'],
}
const hierarchicalTierVersionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'model', 'version'],
  properties: {
    provider: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
    model: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
    version: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
  },
}
const hierarchicalTierVersionsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'cheap-signals',
    'vision',
    'language',
    'aggregation',
  ],
  properties: {
    'cheap-signals': hierarchicalTierVersionSchema,
    vision: hierarchicalTierVersionSchema,
    language: hierarchicalTierVersionSchema,
    aggregation: hierarchicalTierVersionSchema,
  },
}
const hierarchicalRangeSchema = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  prefixItems: [
    { type: 'integer', minimum: 0 },
    { type: 'integer', minimum: 1 },
  ],
}
const hierarchicalBudgetSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'currency',
    'maxCostMinorUnits',
    'maxWorkingSetBytes',
    'maxElapsedMs',
  ],
  properties: {
    currency: { const: 'USD' },
    maxCostMinorUnits: {
      type: 'integer',
      minimum: 0,
      maximum: 10000000,
    },
    maxWorkingSetBytes: {
      type: 'integer',
      minimum: 1,
      maximum: 4294967296,
    },
    maxElapsedMs: {
      type: 'integer',
      minimum: 1,
      maximum: 86400000,
    },
  },
}
const hierarchicalChunkSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'artifactId',
    'sequence',
    'coreRangeMs',
    'sourceRangeMs',
    'overlapBeforeMs',
    'overlapAfterMs',
    'evidenceSpanIds',
    'wordCount',
    'segmentCount',
    'speechMs',
    'chunkHash',
  ],
  properties: {
    id: idSchema,
    artifactId: idSchema,
    sequence: { type: 'integer', minimum: 0, maximum: 719 },
    coreRangeMs: hierarchicalRangeSchema,
    sourceRangeMs: hierarchicalRangeSchema,
    overlapBeforeMs: {
      type: 'integer',
      minimum: 0,
      maximum: 60000,
    },
    overlapAfterMs: {
      type: 'integer',
      minimum: 0,
      maximum: 60000,
    },
    evidenceSpanIds: {
      type: 'array',
      maxItems: 100000,
      uniqueItems: true,
      items: idSchema,
    },
    wordCount: { type: 'integer', minimum: 0 },
    segmentCount: { type: 'integer', minimum: 0 },
    speechMs: { type: 'integer', minimum: 0 },
    chunkHash: sha256Schema,
  },
}
const hierarchicalEvidenceSpanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sourceSegmentId',
    'rangeMs',
    'textHash',
    'wordCount',
    'chunkIds',
    'spanHash',
  ],
  properties: {
    id: idSchema,
    sourceSegmentId: { type: 'integer', minimum: 0 },
    rangeMs: hierarchicalRangeSchema,
    textHash: sha256Schema,
    wordCount: { type: 'integer', minimum: 1 },
    chunkIds: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      items: idSchema,
    },
    spanHash: sha256Schema,
  },
}
const hierarchicalVisionObservationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'chunkId',
    'sourceRangeMs',
    'width',
    'height',
    'fps',
    'sampleCount',
    'catalogedObservationCount',
    'observationHash',
  ],
  properties: {
    chunkId: idSchema,
    sourceRangeMs: hierarchicalRangeSchema,
    width: { type: 'integer', minimum: 1, maximum: 32768 },
    height: { type: 'integer', minimum: 1, maximum: 32768 },
    fps: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
    sampleCount: { type: 'integer', minimum: 1 },
    catalogedObservationCount: { type: 'integer', minimum: 0 },
    observationHash: sha256Schema,
  },
}
const hierarchicalLanguageCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'chunkId',
    'topic',
    'summary',
    'rangeMs',
    'evidenceSpanIds',
    'salience',
    'candidateHash',
  ],
  properties: {
    id: idSchema,
    chunkId: idSchema,
    topic: { type: 'string', minLength: 1, maxLength: 160 },
    summary: { type: 'string', minLength: 1, maxLength: 1000 },
    rangeMs: hierarchicalRangeSchema,
    evidenceSpanIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100000,
      uniqueItems: true,
      items: idSchema,
    },
    salience: { type: 'number', minimum: 0, maximum: 1 },
    candidateHash: sha256Schema,
  },
}
const hierarchicalMomentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sourceChunkId',
    'chapterId',
    'ordinal',
    'topic',
    'summary',
    'rangesMs',
    'evidenceSpanIds',
    'salience',
    'momentHash',
  ],
  properties: {
    id: idSchema,
    sourceChunkId: idSchema,
    chapterId: idSchema,
    ordinal: { type: 'integer', minimum: 0 },
    topic: { type: 'string', minLength: 1, maxLength: 160 },
    summary: { type: 'string', minLength: 1, maxLength: 1000 },
    rangesMs: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: hierarchicalRangeSchema,
    },
    evidenceSpanIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100000,
      uniqueItems: true,
      items: idSchema,
    },
    salience: { type: 'number', minimum: 0, maximum: 1 },
    momentHash: sha256Schema,
  },
}
const hierarchicalChapterSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'ordinal',
    'title',
    'rangeMs',
    'momentIds',
    'evidenceSpanIds',
    'chapterHash',
  ],
  properties: {
    id: idSchema,
    ordinal: { type: 'integer', minimum: 0 },
    title: { type: 'string', minLength: 1, maxLength: 160 },
    rangeMs: hierarchicalRangeSchema,
    momentIds: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: idSchema,
    },
    evidenceSpanIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100000,
      uniqueItems: true,
      items: idSchema,
    },
    chapterHash: sha256Schema,
  },
}
const hierarchicalAggregationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'chapters',
    'moments',
    'evidencePreserved',
    'aggregationHash',
  ],
  properties: {
    chapters: {
      type: 'array',
      minItems: 1,
      maxItems: 10000,
      items: hierarchicalChapterSchema,
    },
    moments: {
      type: 'array',
      minItems: 1,
      maxItems: 100000,
      items: hierarchicalMomentSchema,
    },
    evidencePreserved: { const: true },
    aggregationHash: sha256Schema,
  },
}
const hierarchicalTierExecutionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'tier',
    'sequence',
    'version',
    'prerequisites',
    'status',
    'startedAt',
    'completedAt',
    'elapsedMs',
    'workingSetBytes',
    'costMinorUnits',
    'outputHash',
  ],
  properties: {
    tier: hierarchicalTierNameSchema,
    sequence: { type: 'integer', minimum: 0, maximum: 3 },
    version: hierarchicalTierVersionSchema,
    prerequisites: {
      type: 'array',
      maxItems: 2,
      uniqueItems: true,
      items: hierarchicalTierNameSchema,
    },
    status: { enum: ['processed', 'reused'] },
    reusedFromRunId: idSchema,
    startedAt: dateTimeSchema,
    completedAt: dateTimeSchema,
    elapsedMs: { type: 'integer', minimum: 0 },
    workingSetBytes: { type: 'integer', minimum: 0 },
    costMinorUnits: { type: 'integer', minimum: 0 },
    outputHash: sha256Schema,
  },
}
const hierarchicalProcessingPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'tiers',
    'executionOrder',
    'invalidatedTiers',
    'cheapSignalsFirst',
    'planHash',
  ],
  properties: {
    tiers: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'tier',
          'sequence',
          'version',
          'prerequisites',
          'status',
        ],
        properties: {
          tier: hierarchicalTierNameSchema,
          sequence: { type: 'integer', minimum: 0, maximum: 3 },
          version: hierarchicalTierVersionSchema,
          prerequisites: {
            type: 'array',
            maxItems: 2,
            uniqueItems: true,
            items: hierarchicalTierNameSchema,
          },
          status: { enum: ['process', 'reuse'] },
        },
      },
    },
    executionOrder: {
      type: 'array',
      maxItems: 4,
      uniqueItems: true,
      items: hierarchicalTierNameSchema,
    },
    invalidatedTiers: {
      type: 'array',
      maxItems: 4,
      uniqueItems: true,
      items: hierarchicalTierNameSchema,
    },
    cheapSignalsFirst: { const: true },
    planHash: sha256Schema,
  },
}
const hierarchicalMeasurementSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'durationMs',
    'chunkCount',
    'evidenceSpanCount',
    'processedTierCount',
    'reusedTierCount',
    'workingSetBytes',
    'cost',
    'elapsedMs',
    'bounded',
    'measurementHash',
  ],
  properties: {
    schemaVersion: {
      const: 'hierarchical-processing-measurement/v1',
    },
    durationMs: { type: 'integer', minimum: 1, maximum: 43200000 },
    chunkCount: { type: 'integer', minimum: 1, maximum: 720 },
    evidenceSpanCount: {
      type: 'integer',
      minimum: 1,
      maximum: 100000,
    },
    processedTierCount: {
      type: 'integer',
      minimum: 0,
      maximum: 4,
    },
    reusedTierCount: {
      type: 'integer',
      minimum: 0,
      maximum: 4,
    },
    workingSetBytes: { type: 'integer', minimum: 0 },
    cost: {
      type: 'object',
      additionalProperties: false,
      required: ['policyVersion', 'currency', 'minorUnits'],
      properties: {
        policyVersion: { const: 'hierarchical-cost-policy/v1' },
        currency: { const: 'USD' },
        minorUnits: { type: 'integer', minimum: 0 },
      },
    },
    elapsedMs: { type: 'integer', minimum: 0 },
    bounded: { type: 'boolean' },
    measurementHash: sha256Schema,
  },
}
const hierarchicalProcessingRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'sourceManifestId',
    'sourceManifestHash',
    'sourceTranscriptId',
    'sourceTranscriptHash',
    'durationMs',
    'rightsSnapshotId',
    'rightsStatus',
    'consentStatus',
    'processingPolicyVersion',
    'chunkPolicyVersion',
    'chunkDurationMs',
    'overlapMs',
    'tierVersions',
    'plan',
    'chunks',
    'evidenceSpans',
    'visionObservations',
    'languageCandidates',
    'aggregation',
    'tierExecutions',
    'budget',
    'measurement',
    'physicalMaterialized',
    'createdBy',
    'createdAt',
    'runHash',
    'active',
  ],
  properties: {
    schemaVersion: { const: 'hierarchical-processing-run/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    sourceManifestId: idSchema,
    sourceManifestHash: sha256Schema,
    sourceTranscriptId: idSchema,
    sourceTranscriptHash: sha256Schema,
    durationMs: { type: 'integer', minimum: 1, maximum: 43200000 },
    rightsSnapshotId: idSchema,
    rightsStatus: {
      enum: ['approved', 'restricted', 'unknown', 'expired', 'revoked'],
    },
    consentStatus: {
      enum: [
        'approved',
        'not-required',
        'restricted',
        'unknown',
        'expired',
        'revoked',
      ],
    },
    processingPolicyVersion: { const: 'hierarchical-processing/v1' },
    chunkPolicyVersion: { const: 'overlapping-time-chunks/v1' },
    chunkDurationMs: {
      type: 'integer',
      minimum: 60000,
      maximum: 900000,
    },
    overlapMs: { type: 'integer', minimum: 0, maximum: 60000 },
    tierVersions: hierarchicalTierVersionsSchema,
    previousRunId: idSchema,
    previousRunHash: sha256Schema,
    plan: hierarchicalProcessingPlanSchema,
    chunks: {
      type: 'array',
      minItems: 1,
      maxItems: 720,
      items: hierarchicalChunkSchema,
    },
    evidenceSpans: {
      type: 'array',
      minItems: 1,
      maxItems: 100000,
      items: hierarchicalEvidenceSpanSchema,
    },
    visionObservations: {
      type: 'array',
      minItems: 1,
      maxItems: 720,
      items: hierarchicalVisionObservationSchema,
    },
    languageCandidates: {
      type: 'array',
      minItems: 1,
      maxItems: 720,
      items: hierarchicalLanguageCandidateSchema,
    },
    aggregation: hierarchicalAggregationSchema,
    tierExecutions: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: hierarchicalTierExecutionSchema,
    },
    budget: hierarchicalBudgetSchema,
    measurement: hierarchicalMeasurementSchema,
    physicalMaterialized: { const: false },
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'api-client' },
        id: idSchema,
      },
    },
    createdAt: dateTimeSchema,
    runHash: sha256Schema,
    active: { type: 'boolean' },
  },
}
const productionBatchStatusSchema = {
  enum: [
    'queued',
    'running',
    'review',
    'partially-completed',
    'completed',
    'failed',
    'cancelled',
  ],
}
const productionBatchStepNameSchema = {
  enum: ['planning', 'materializing', 'rendering', 'reviewing'],
}
const productionBatchErrorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$',
    },
    message: { type: 'string', minLength: 1, maxLength: 500 },
  },
}
const productionBatchSourceGroupSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'sourceArtifactIds'],
  properties: {
    id: idSchema,
    name: { type: 'string', minLength: 1, maxLength: 160 },
    sourceArtifactIds: {
      type: 'array',
      minItems: 1,
      maxItems: 1000,
      uniqueItems: true,
      items: idSchema,
    },
  },
}
const productionBatchRecipeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'sourceGroupIds'],
  properties: {
    id: idSchema,
    name: { type: 'string', minLength: 1, maxLength: 160 },
    sourceGroupIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: idSchema,
    },
  },
}
const productionBatchVariantSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'outputSpecId', 'locale'],
  properties: {
    id: idSchema,
    name: { type: 'string', minLength: 1, maxLength: 160 },
    outputSpecId: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$',
    },
    locale: {
      type: 'string',
      pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$',
    },
  },
}
const productionBatchBudgetSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'currency',
    'maxCostMinorUnits',
    'reservedCostMinorUnits',
  ],
  properties: {
    currency: { const: 'USD' },
    maxCostMinorUnits: {
      type: 'integer',
      minimum: 0,
      maximum: 100000000,
    },
    reservedCostMinorUnits: {
      type: 'integer',
      minimum: 0,
      maximum: 100000000,
    },
  },
}
const productionBatchStepSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'step',
    'sequence',
    'state',
    'attempt',
    'costMinorUnits',
    'cacheHit',
    'stepHash',
  ],
  properties: {
    step: productionBatchStepNameSchema,
    sequence: { type: 'integer', minimum: 0, maximum: 3 },
    state: {
      enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    },
    attempt: { type: 'integer', minimum: 0, maximum: 10000 },
    costMinorUnits: {
      type: 'integer',
      minimum: 0,
      maximum: 100000000,
    },
    cacheHit: { type: 'boolean' },
    error: productionBatchErrorSchema,
    stepHash: sha256Schema,
  },
}
const productionBatchItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'key',
    'sourceGroupId',
    'recipeId',
    'variantId',
    'state',
    'revision',
    'steps',
    'artifactIds',
    'retryCount',
    'createdAt',
    'updatedAt',
    'itemHash',
  ],
  properties: {
    id: idSchema,
    key: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$',
    },
    sourceGroupId: idSchema,
    recipeId: idSchema,
    variantId: idSchema,
    state: {
      enum: [
        'queued',
        'planning',
        'materializing',
        'rendering',
        'reviewing',
        'completed',
        'failed',
        'cancelled',
        'superseded',
      ],
    },
    revision: { type: 'integer', minimum: 1, maximum: 1000000 },
    steps: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: productionBatchStepSchema,
    },
    artifactIds: {
      type: 'array',
      maxItems: 1000,
      uniqueItems: true,
      items: idSchema,
    },
    retryCount: { type: 'integer', minimum: 0, maximum: 10000 },
    error: productionBatchErrorSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    itemHash: sha256Schema,
  },
}
const productionBatchProgressSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'completedSteps',
    'failedSteps',
    'cancelledSteps',
    'runningSteps',
    'totalSteps',
    'percent',
    'completedItems',
    'failedItems',
    'cancelledItems',
    'activeItems',
    'queuedItems',
    'totalItems',
    'spentMinorUnits',
    'remainingMinorUnits',
  ],
  properties: {
    completedSteps: { type: 'integer', minimum: 0 },
    failedSteps: { type: 'integer', minimum: 0 },
    cancelledSteps: { type: 'integer', minimum: 0 },
    runningSteps: { type: 'integer', minimum: 0 },
    totalSteps: { type: 'integer', minimum: 0 },
    percent: { type: 'integer', minimum: 0, maximum: 100 },
    completedItems: { type: 'integer', minimum: 0 },
    failedItems: { type: 'integer', minimum: 0 },
    cancelledItems: { type: 'integer', minimum: 0 },
    activeItems: { type: 'integer', minimum: 0 },
    queuedItems: { type: 'integer', minimum: 0 },
    totalItems: { type: 'integer', minimum: 0 },
    spentMinorUnits: { type: 'integer', minimum: 0 },
    remainingMinorUnits: { type: 'integer', minimum: 0 },
  },
}
const productionBatchSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'name',
    'objective',
    'policyVersion',
    'revision',
    'sourceGroups',
    'recipes',
    'variants',
    'budget',
    'items',
    'createdBy',
    'createdAt',
    'updatedAt',
    'definitionHash',
    'status',
    'progress',
  ],
  properties: {
    schemaVersion: { const: 'production-batch/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    objective: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$',
    },
    policyVersion: { const: 'production-batch/v1' },
    revision: { type: 'integer', minimum: 1, maximum: 1000000 },
    sourceGroups: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: productionBatchSourceGroupSchema,
    },
    recipes: {
      type: 'array',
      minItems: 1,
      maxItems: 250,
      items: productionBatchRecipeSchema,
    },
    variants: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: productionBatchVariantSchema,
    },
    budget: productionBatchBudgetSchema,
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 1000,
      items: productionBatchItemSchema,
    },
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'api-client' },
        id: idSchema,
      },
    },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    definitionHash: sha256Schema,
    status: productionBatchStatusSchema,
    progress: productionBatchProgressSchema,
  },
}
const batchPartialRetryJobSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'retryId',
    'itemId',
    'step',
    'executorClass',
    'status',
    'lineageKey',
    'failedAttempt',
    'retryAttempt',
    'previousStepHash',
    'queuedStepHash',
    'failureCode',
    'failureMessage',
    'preservedArtifactIds',
    'preservedArtifactCount',
    'chargedMinorUnitsAtEnqueue',
    'createdAt',
    'jobHash',
  ],
  properties: {
    schemaVersion: { const: 'batch-partial-retry-job/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    retryId: idSchema,
    itemId: idSchema,
    step: productionBatchStepNameSchema,
    executorClass: {
      enum: ['director', 'provider', 'renderer', 'validator'],
    },
    status: { const: 'queued' },
    lineageKey: sha256Schema,
    failedAttempt: { type: 'integer', minimum: 1, maximum: 10000 },
    retryAttempt: { type: 'integer', minimum: 2, maximum: 10001 },
    previousStepHash: sha256Schema,
    queuedStepHash: sha256Schema,
    failureCode: { type: 'string', minLength: 1, maxLength: 128 },
    failureMessage: { type: 'string', minLength: 1, maxLength: 500 },
    preservedArtifactIds: {
      type: 'array',
      maxItems: 1000,
      uniqueItems: true,
      items: idSchema,
    },
    preservedArtifactCount: {
      type: 'integer',
      minimum: 0,
      maximum: 1000,
    },
    chargedMinorUnitsAtEnqueue: { const: 0 },
    createdAt: dateTimeSchema,
    jobHash: sha256Schema,
  },
}
const batchPartialRetrySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'batchDefinitionHash',
    'batchRevisionBefore',
    'batchRevisionAfter',
    'status',
    'jobs',
    'targetCount',
    'preservedCompletedItemIds',
    'preservedArtifactIds',
    'progressBefore',
    'progressAfter',
    'spentMinorUnitsBefore',
    'spentMinorUnitsAfter',
    'remainingMinorUnitsBefore',
    'remainingMinorUnitsAfter',
    'createdByClientId',
    'createdAt',
    'retryHash',
  ],
  properties: {
    schemaVersion: { const: 'batch-partial-retry/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    batchDefinitionHash: sha256Schema,
    batchRevisionBefore: {
      type: 'integer',
      minimum: 1,
      maximum: 1000000,
    },
    batchRevisionAfter: {
      type: 'integer',
      minimum: 2,
      maximum: 1000001,
    },
    status: { const: 'queued' },
    jobs: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: batchPartialRetryJobSchema,
    },
    targetCount: { type: 'integer', minimum: 1, maximum: 100 },
    preservedCompletedItemIds: {
      type: 'array',
      maxItems: 1000,
      uniqueItems: true,
      items: idSchema,
    },
    preservedArtifactIds: {
      type: 'array',
      maxItems: 1000,
      uniqueItems: true,
      items: idSchema,
    },
    progressBefore: productionBatchProgressSchema,
    progressAfter: productionBatchProgressSchema,
    spentMinorUnitsBefore: { type: 'integer', minimum: 0 },
    spentMinorUnitsAfter: { type: 'integer', minimum: 0 },
    remainingMinorUnitsBefore: { type: 'integer', minimum: 0 },
    remainingMinorUnitsAfter: { type: 'integer', minimum: 0 },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    retryHash: sha256Schema,
  },
}
const batchEditOperationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'valueRef'],
  properties: {
    type: { enum: ['replace-cta', 'subtitle-style', 'brand-kit'] },
    valueRef: idSchema,
  },
}
const batchEditScopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['recipeIds', 'outputSpecIds', 'itemIds', 'scopeHash'],
  properties: {
    recipeIds: {
      type: 'array', minItems: 1, maxItems: 1000,
      uniqueItems: true, items: idSchema,
    },
    outputSpecIds: {
      type: 'array', minItems: 1, maxItems: 1000,
      uniqueItems: true, items: idSchema,
    },
    itemIds: {
      type: 'array', minItems: 1, maxItems: 1000,
      uniqueItems: true, items: idSchema,
    },
    scopeHash: sha256Schema,
  },
}
const batchEditPolicySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'workspaceId', 'revision', 'defaultMode',
    'maxItemCount', 'diffSampleSize', 'replaceCtaCostMinorUnits',
    'subtitleStyleCostMinorUnits', 'brandKitCostMinorUnits',
    'confirmationTtlSeconds', 'updatedByClientId', 'updatedAt',
    'policyHash',
  ],
  properties: {
    schemaVersion: { const: 'batch-edit-policy/v1' },
    workspaceId: idSchema,
    revision: { type: 'integer', minimum: 1, maximum: 1000000 },
    defaultMode: { enum: ['all-or-nothing', 'skip-failures'] },
    maxItemCount: { type: 'integer', minimum: 1, maximum: 1000 },
    diffSampleSize: { type: 'integer', minimum: 1, maximum: 25 },
    replaceCtaCostMinorUnits: {
      type: 'integer', minimum: 0, maximum: 1000000,
    },
    subtitleStyleCostMinorUnits: {
      type: 'integer', minimum: 0, maximum: 1000000,
    },
    brandKitCostMinorUnits: {
      type: 'integer', minimum: 0, maximum: 1000000,
    },
    confirmationTtlSeconds: {
      type: 'integer', minimum: 60, maximum: 86400,
    },
    updatedByClientId: idSchema,
    updatedAt: dateTimeSchema,
    policyHash: sha256Schema,
  },
}
const batchEditItemStateSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'workspaceId', 'batchId', 'itemId', 'revision',
    'directives', 'protectedOperations', 'createdByClientId',
    'createdAt', 'stateHash',
  ],
  properties: {
    schemaVersion: { const: 'batch-edit-item-state/v1' },
    workspaceId: idSchema,
    batchId: idSchema,
    itemId: idSchema,
    revision: { type: 'integer', minimum: 1, maximum: 1000000 },
    directives: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ctaRef: idSchema,
        subtitleStyleId: idSchema,
        brandKitSnapshotId: idSchema,
      },
    },
    protectedOperations: {
      type: 'array',
      maxItems: 3,
      uniqueItems: true,
      items: {
        enum: ['replace-cta', 'subtitle-style', 'brand-kit'],
      },
    },
    previousStateHash: sha256Schema,
    sourceCommandId: idSchema,
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    stateHash: sha256Schema,
  },
}
const batchEditImpactSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'itemId', 'recipeId', 'variantId', 'outputSpecId', 'locale',
    'targetRef', 'disposition', 'afterValueRef', 'beforeStateRevision',
    'beforeStateHash', 'protectedConflict', 'conflictCodes',
    'invalidatedSteps', 'invalidatedTargetRefs',
    'estimatedCostMinorUnits', 'impactHash',
  ],
  properties: {
    itemId: idSchema,
    recipeId: idSchema,
    variantId: idSchema,
    outputSpecId: idSchema,
    locale: { type: 'string', pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$' },
    targetRef: { type: 'string', minLength: 3, maxLength: 260 },
    disposition: { enum: ['applicable', 'protected', 'unchanged'] },
    beforeValueRef: idSchema,
    afterValueRef: idSchema,
    beforeStateRevision: {
      type: 'integer', minimum: 1, maximum: 1000000,
    },
    beforeStateHash: sha256Schema,
    protectedConflict: { type: 'boolean' },
    conflictCodes: {
      type: 'array', maxItems: 8, uniqueItems: true,
      items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,127}$' },
    },
    invalidatedSteps: {
      type: 'array', maxItems: 4, uniqueItems: true,
      items: {
        enum: ['planning', 'materializing', 'rendering', 'reviewing'],
      },
    },
    invalidatedTargetRefs: {
      type: 'array', maxItems: 4, uniqueItems: true,
      items: { type: 'string', minLength: 3, maxLength: 300 },
    },
    estimatedCostMinorUnits: {
      type: 'integer', minimum: 0, maximum: 1000000,
    },
    impactHash: sha256Schema,
  },
}
const batchEditDiffValueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode'],
  properties: {
    mode: { enum: ['inherit', 'override'] },
    valueRef: idSchema,
  },
}
const batchEditSampleDiffSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'itemId', 'recipeId', 'outputSpecId', 'targetRef', 'before',
    'after', 'disposition', 'conflictCodes', 'diffHash',
  ],
  properties: {
    itemId: idSchema,
    recipeId: idSchema,
    outputSpecId: idSchema,
    targetRef: { type: 'string', minLength: 3, maxLength: 260 },
    before: batchEditDiffValueSchema,
    after: batchEditDiffValueSchema,
    disposition: { enum: ['applicable', 'protected', 'unchanged'] },
    conflictCodes: {
      type: 'array', maxItems: 8, uniqueItems: true,
      items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,127}$' },
    },
    diffHash: sha256Schema,
  },
}
const preflightResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'eligible', 'fingerprint', 'evaluatedAt',
    'targets', 'conflicts', 'invalidations', 'jobs', 'cost', 'quota',
    'warnings',
  ],
  properties: {
    schemaVersion: { const: 'preflight-result/v1' },
    eligible: { type: 'boolean' },
    fingerprint: sha256Schema,
    evaluatedAt: dateTimeSchema,
    targets: {
      type: 'array', maxItems: 1024,
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'id'],
        properties: {
          kind: { type: 'string', minLength: 1, maxLength: 64 },
          id: { type: 'string', minLength: 1, maxLength: 256 },
          version: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
    conflicts: {
      type: 'array', maxItems: 1024,
      items: {
        type: 'object', additionalProperties: false,
        required: ['code', 'target', 'message'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 80 },
          target: { type: 'string', minLength: 1, maxLength: 256 },
          message: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
    invalidations: {
      type: 'array', maxItems: 4096,
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'id', 'reason'],
        properties: {
          kind: { enum: ['artifact', 'analysis', 'proxy', 'render'] },
          id: { type: 'string', minLength: 1, maxLength: 256 },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
    jobs: {
      type: 'array', maxItems: 256,
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'count'],
        properties: {
          kind: { type: 'string', minLength: 1, maxLength: 80 },
          count: { type: 'integer', minimum: 1, maximum: 100000 },
          estimatedDurationMs: {
            type: 'integer', minimum: 0, maximum: 604800000,
          },
        },
      },
    },
    cost: {
      type: 'object', additionalProperties: false,
      required: ['currency', 'estimatedMinorUnits', 'maximumMinorUnits'],
      properties: {
        currency: { const: 'USD' },
        estimatedMinorUnits: {
          type: 'integer', minimum: 0, maximum: 100000000,
        },
        maximumMinorUnits: {
          type: 'integer', minimum: 0, maximum: 100000000,
        },
      },
    },
    quota: {
      type: 'object', additionalProperties: false,
      required: ['unit', 'required', 'remaining', 'allowed'],
      properties: {
        unit: { type: 'string', minLength: 1, maxLength: 64 },
        required: { type: 'integer', minimum: 0 },
        remaining: { type: 'integer', minimum: 0 },
        allowed: { type: 'boolean' },
        resetsAt: dateTimeSchema,
      },
    },
    warnings: {
      type: 'array', maxItems: 1024,
      items: {
        type: 'object', additionalProperties: false,
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', minLength: 1, maxLength: 80 },
          message: { type: 'string', minLength: 1, maxLength: 1000 },
          target: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
    },
  },
}
const batchEditPreflightSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'impactVersion', 'id', 'workspaceId', 'projectId',
    'batchId', 'batchRevision', 'batchDefinitionHash', 'policy',
    'mode', 'operation', 'scope', 'status',
    'budgetRemainingMinorUnits', 'affectedItemCount',
    'applicableItemCount', 'protectedConflictCount',
    'unchangedItemCount', 'invalidationCount',
    'estimatedCostMinorUnits', 'budgetExceeded', 'impacts',
    'sampleDiff', 'warningCodes', 'costFingerprint',
    'createdByClientId', 'createdAt', 'preflightHash',
  ],
  properties: {
    schemaVersion: { const: 'batch-edit-preflight/v1' },
    impactVersion: { const: 'batch-edit-impact/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    batchRevision: { type: 'integer', minimum: 1, maximum: 1000000 },
    batchDefinitionHash: sha256Schema,
    policy: batchEditPolicySchema,
    mode: { enum: ['all-or-nothing', 'skip-failures'] },
    operation: batchEditOperationSchema,
    scope: batchEditScopeSchema,
    status: { enum: ['ready', 'partial-ready', 'blocked', 'no-change'] },
    budgetRemainingMinorUnits: {
      type: 'integer', minimum: 0, maximum: 100000000,
    },
    affectedItemCount: { type: 'integer', minimum: 1, maximum: 1000 },
    applicableItemCount: { type: 'integer', minimum: 0, maximum: 1000 },
    protectedConflictCount: {
      type: 'integer', minimum: 0, maximum: 1000,
    },
    unchangedItemCount: { type: 'integer', minimum: 0, maximum: 1000 },
    invalidationCount: { type: 'integer', minimum: 0, maximum: 4000 },
    estimatedCostMinorUnits: {
      type: 'integer', minimum: 0, maximum: 100000000,
    },
    budgetExceeded: { type: 'boolean' },
    impacts: {
      type: 'array', minItems: 1, maxItems: 1000,
      items: batchEditImpactSchema,
    },
    sampleDiff: {
      type: 'array', minItems: 1, maxItems: 25,
      items: batchEditSampleDiffSchema,
    },
    warningCodes: {
      type: 'array', maxItems: 16, uniqueItems: true,
      items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,127}$' },
    },
    confirmationExpiresAt: dateTimeSchema,
    costFingerprint: sha256Schema,
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    preflightHash: sha256Schema,
  },
}
const batchEditItemResultSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'itemId', 'recipeId', 'variantId', 'outputSpecId', 'targetRef',
    'status', 'beforeStateRevision', 'beforeStateHash',
    'conflictCodes', 'invalidatedSteps', 'invalidatedTargetRefs',
    'costMinorUnits', 'resultHash',
  ],
  properties: {
    itemId: idSchema,
    recipeId: idSchema,
    variantId: idSchema,
    outputSpecId: idSchema,
    targetRef: { type: 'string', minLength: 3, maxLength: 260 },
    status: { enum: ['applied', 'skipped', 'unchanged'] },
    beforeStateRevision: {
      type: 'integer', minimum: 1, maximum: 1000000,
    },
    beforeStateHash: sha256Schema,
    afterStateRevision: {
      type: 'integer', minimum: 2, maximum: 1000000,
    },
    afterStateHash: sha256Schema,
    conflictCodes: {
      type: 'array', maxItems: 8, uniqueItems: true,
      items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,127}$' },
    },
    invalidatedSteps: {
      type: 'array', maxItems: 4, uniqueItems: true,
      items: {
        enum: ['planning', 'materializing', 'rendering', 'reviewing'],
      },
    },
    invalidatedTargetRefs: {
      type: 'array', maxItems: 4, uniqueItems: true,
      items: { type: 'string', minLength: 3, maxLength: 300 },
    },
    costMinorUnits: {
      type: 'integer', minimum: 0, maximum: 1000000,
    },
    resultHash: sha256Schema,
  },
}
const batchEditCommandSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'workspaceId', 'projectId', 'batchId',
    'preflightId', 'preflightHash', 'batchRevision',
    'batchDefinitionHash', 'policyHash', 'mode', 'operation', 'scope',
    'status', 'resultItems', 'newStates', 'affectedItemCount',
    'appliedItemCount', 'skippedItemCount', 'unchangedItemCount',
    'invalidationCount', 'costMinorUnits', 'createdByClientId',
    'createdAt', 'commandHash',
  ],
  properties: {
    schemaVersion: { const: 'batch-edit-command/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    preflightId: idSchema,
    preflightHash: sha256Schema,
    batchRevision: { type: 'integer', minimum: 1, maximum: 1000000 },
    batchDefinitionHash: sha256Schema,
    policyHash: sha256Schema,
    mode: { enum: ['all-or-nothing', 'skip-failures'] },
    operation: batchEditOperationSchema,
    scope: batchEditScopeSchema,
    status: { enum: ['committed', 'partial'] },
    resultItems: {
      type: 'array', minItems: 1, maxItems: 1000,
      items: batchEditItemResultSchema,
    },
    newStates: {
      type: 'array', minItems: 1, maxItems: 1000,
      items: batchEditItemStateSchema,
    },
    affectedItemCount: { type: 'integer', minimum: 1, maximum: 1000 },
    appliedItemCount: { type: 'integer', minimum: 1, maximum: 1000 },
    skippedItemCount: { type: 'integer', minimum: 0, maximum: 1000 },
    unchangedItemCount: { type: 'integer', minimum: 0, maximum: 1000 },
    invalidationCount: { type: 'integer', minimum: 1, maximum: 4000 },
    costMinorUnits: {
      type: 'integer', minimum: 0, maximum: 100000000,
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    commandHash: sha256Schema,
  },
}
const scriptBlockRoleSchema = {
  enum: [
    'hook',
    'body',
    'proof',
    'objection',
    'bridge',
    'offer',
    'cta',
  ],
}
const scriptRangeSchema = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  prefixItems: [
    { type: 'integer', minimum: 0 },
    { type: 'integer', minimum: 0 },
  ],
}
const scriptAlignmentMetricsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'semanticSimilarity',
    'lexicalCoverage',
    'expectedOrder',
    'boundaryCompleteness',
    'durationPlausibility',
    'labelSignal',
    'total',
  ],
  properties: {
    semanticSimilarity: { type: 'number', minimum: 0, maximum: 1 },
    lexicalCoverage: { type: 'number', minimum: 0, maximum: 1 },
    expectedOrder: { type: 'number', minimum: 0, maximum: 1 },
    boundaryCompleteness: { type: 'number', minimum: 0, maximum: 1 },
    durationPlausibility: { type: 'number', minimum: 0, maximum: 1 },
    labelSignal: { type: 'number', minimum: 0, maximum: 1 },
    total: { type: 'number', minimum: 0, maximum: 100 },
  },
}
const scriptDeviationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'plannedTokens', 'spokenTokens', 'reasonCode'],
  properties: {
    kind: {
      enum: [
        'omission',
        'insertion',
        'paraphrase',
        'number-claim-change',
        'qualifier-change',
        'incomplete-ending',
        'restart',
        'off-script',
      ],
    },
    plannedTokens: {
      type: 'array',
      maxItems: 50,
      items: { type: 'string' },
    },
    spokenTokens: {
      type: 'array',
      maxItems: 50,
      items: { type: 'string' },
    },
    reasonCode: {
      type: 'string',
      pattern: '^[A-Z][A-Z0-9_]{2,127}$',
    },
  },
}
const scriptAlignmentCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'transcriptId',
    'sourceArtifactId',
    'kind',
    'sourceRangeMs',
    'evidenceWordIndices',
    'spokenText',
    'normalizedSpokenText',
    'metrics',
    'deviations',
    'candidateHash',
  ],
  properties: {
    id: idSchema,
    transcriptId: idSchema,
    sourceArtifactId: idSchema,
    kind: { enum: ['exact', 'near', 'partial'] },
    sourceRangeMs: scriptRangeSchema,
    evidenceWordIndices: {
      type: 'array',
      minItems: 1,
      maxItems: 500000,
      items: { type: 'integer', minimum: 0 },
    },
    spokenText: { type: 'string', minLength: 1 },
    normalizedSpokenText: { type: 'string', minLength: 1 },
    metrics: scriptAlignmentMetricsSchema,
    deviations: {
      type: 'array',
      maxItems: 8,
      items: scriptDeviationSchema,
    },
    candidateHash: sha256Schema,
  },
}
const scriptAlignmentDecisionSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['targetKind', 'blockId', 'resolution'],
      properties: {
        targetKind: { const: 'block' },
        blockId: idSchema,
        resolution: {
          enum: ['accept', 'mark-missing', 'select-alternative'],
        },
        candidateId: idSchema,
        note: { type: 'string', minLength: 1, maxLength: 1000 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['targetKind', 'extraTakeId', 'resolution'],
      properties: {
        targetKind: { const: 'extra-take' },
        extraTakeId: idSchema,
        resolution: { enum: ['accept-extra', 'reject-extra'] },
        note: { type: 'string', minLength: 1, maxLength: 1000 },
      },
    },
  ],
}
const scriptAlignmentRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'schemaVersion',
    'algorithmVersion',
    'status',
    'revision',
    'document',
    'sourceRefs',
    'alignments',
    'extraTakes',
    'reviews',
    'summary',
    'createdByClientId',
    'createdAt',
    'updatedAt',
    'runHash',
  ],
  properties: {
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    schemaVersion: { const: 'script-alignment-run/v1' },
    algorithmVersion: { const: 'monotonic-lexical-sequence/v1' },
    status: { enum: ['completed', 'review-required', 'reviewed'] },
    revision: { type: 'integer', minimum: 1, maximum: 1000000 },
    document: {
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion',
        'title',
        'locale',
        'rawText',
        'normalizedText',
        'blocks',
        'documentHash',
      ],
      properties: {
        schemaVersion: { const: 'script-document/v1' },
        title: { type: 'string', minLength: 2, maxLength: 200 },
        locale: { type: 'string', minLength: 2, maxLength: 35 },
        rawText: { type: 'string', minLength: 3, maxLength: 500000 },
        normalizedText: { type: 'string', minLength: 1 },
        blocks: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id',
              'role',
              'originalLabel',
              'plannedText',
              'normalizedText',
              'documentOrder',
              'blockHash',
            ],
            properties: {
              id: idSchema,
              role: scriptBlockRoleSchema,
              originalLabel: {
                type: 'string',
                minLength: 1,
                maxLength: 120,
              },
              plannedText: {
                type: 'string',
                minLength: 1,
                maxLength: 20000,
              },
              normalizedText: { type: 'string', minLength: 1 },
              documentOrder: { type: 'integer', minimum: 0, maximum: 499 },
              blockHash: sha256Schema,
            },
          },
        },
        documentHash: sha256Schema,
      },
    },
    sourceRefs: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'transcriptId',
          'sourceArtifactId',
          'transcriptHash',
          'language',
        ],
        properties: {
          transcriptId: idSchema,
          sourceArtifactId: idSchema,
          transcriptHash: sha256Schema,
          language: { type: 'string', minLength: 2, maxLength: 35 },
          roleHint: scriptBlockRoleSchema,
        },
      },
    },
    alignments: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'blockId',
          'role',
          'documentOrder',
          'kind',
          'confidence',
          'reviewStatus',
          'ambiguous',
          'reasonCodes',
          'selectedCandidate',
          'alternatives',
          'alignmentHash',
        ],
        properties: {
          blockId: idSchema,
          role: scriptBlockRoleSchema,
          documentOrder: { type: 'integer', minimum: 0, maximum: 499 },
          kind: { enum: ['exact', 'near', 'partial', 'missing'] },
          confidence: { type: 'number', minimum: 0, maximum: 100 },
          reviewStatus: {
            enum: [
              'auto-linked',
              'review-required',
              'accepted',
              'marked-missing',
            ],
          },
          ambiguous: { type: 'boolean' },
          reasonCodes: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string' },
          },
          selectedCandidate: {
            oneOf: [
              scriptAlignmentCandidateSchema,
              { type: 'null' },
            ],
          },
          alternatives: {
            type: 'array',
            maxItems: 3,
            items: scriptAlignmentCandidateSchema,
          },
          reviewedCandidateId: idSchema,
          reviewNote: { type: 'string', minLength: 1, maxLength: 1000 },
          reviewedByClientId: idSchema,
          reviewedAt: dateTimeSchema,
          alignmentHash: sha256Schema,
        },
      },
    },
    extraTakes: {
      type: 'array',
      maxItems: 2000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'transcriptId',
          'sourceArtifactId',
          'sourceRangeMs',
          'evidenceWordIndices',
          'spokenText',
          'normalizedSpokenText',
          'reviewStatus',
          'extraHash',
        ],
        properties: {
          id: idSchema,
          transcriptId: idSchema,
          sourceArtifactId: idSchema,
          sourceRangeMs: scriptRangeSchema,
          evidenceWordIndices: {
            type: 'array',
            minItems: 1,
            maxItems: 500000,
            items: { type: 'integer', minimum: 0 },
          },
          spokenText: { type: 'string', minLength: 1 },
          normalizedSpokenText: { type: 'string', minLength: 1 },
          reviewStatus: {
            enum: ['review-required', 'accepted', 'rejected'],
          },
          reviewNote: { type: 'string', minLength: 1, maxLength: 1000 },
          reviewedByClientId: idSchema,
          reviewedAt: dateTimeSchema,
          extraHash: sha256Schema,
        },
      },
    },
    reviews: {
      type: 'array',
      maxItems: 1000000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'revision',
          'decisions',
          'actorClientId',
          'createdAt',
          'reviewHash',
        ],
        properties: {
          id: idSchema,
          revision: { type: 'integer', minimum: 2, maximum: 1000000 },
          decisions: {
            type: 'array',
            minItems: 1,
            maxItems: 500,
            items: scriptAlignmentDecisionSchema,
          },
          actorClientId: idSchema,
          createdAt: dateTimeSchema,
          reviewHash: sha256Schema,
        },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'blockCount',
        'exactCount',
        'nearCount',
        'partialCount',
        'missingCount',
        'extraTakeCount',
        'ambiguousCount',
        'reviewRequiredCount',
        'resolvedReviewCount',
        'averageConfidence',
      ],
      properties: {
        blockCount: { type: 'integer', minimum: 1, maximum: 500 },
        exactCount: { type: 'integer', minimum: 0, maximum: 500 },
        nearCount: { type: 'integer', minimum: 0, maximum: 500 },
        partialCount: { type: 'integer', minimum: 0, maximum: 500 },
        missingCount: { type: 'integer', minimum: 0, maximum: 500 },
        extraTakeCount: { type: 'integer', minimum: 0, maximum: 2000 },
        ambiguousCount: { type: 'integer', minimum: 0, maximum: 500 },
        reviewRequiredCount: {
          type: 'integer',
          minimum: 0,
          maximum: 2500,
        },
        resolvedReviewCount: {
          type: 'integer',
          minimum: 0,
          maximum: 2500,
        },
        averageConfidence: { type: 'number', minimum: 0, maximum: 100 },
      },
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    runHash: sha256Schema,
  },
}
const takeDimensionSchema = {
  enum: [
    'completeness',
    'performance',
    'audio',
    'video',
    'integrity',
  ],
}
const takeIntentionRoleSchema = {
  enum: [
    'hook',
    'body',
    'proof',
    'objection',
    'bridge',
    'offer',
    'cta',
    'other',
  ],
}
const takeEvaluationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'dimension',
    'score',
    'state',
    'evaluatorVersion',
    'evidenceRefs',
    'reasonCodes',
    'evaluationHash',
  ],
  properties: {
    dimension: takeDimensionSchema,
    score: {
      oneOf: [
        { type: 'number', minimum: 0, maximum: 1 },
        { type: 'null' },
      ],
    },
    state: { enum: ['measured', 'derived', 'unavailable'] },
    evaluatorVersion: idSchema,
    evidenceRefs: {
      type: 'array',
      maxItems: 50,
      uniqueItems: true,
      items: idSchema,
    },
    reasonCodes: {
      type: 'array',
      maxItems: 50,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9_]{2,79}$',
      },
    },
    evaluationHash: sha256Schema,
  },
}
const takeAssignmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'role',
    'label',
    'confidence',
    'evidenceRefs',
    'assignmentHash',
  ],
  properties: {
    kind: { enum: ['script-block', 'inferred-intention'] },
    role: takeIntentionRoleSchema,
    label: { type: 'string', minLength: 1, maxLength: 240 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidenceRefs: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      uniqueItems: true,
      items: idSchema,
    },
    scriptBlockId: idSchema,
    assignmentHash: sha256Schema,
  },
}
const takeRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'groupId',
    'retakeBoundaryId',
    'sourceKind',
    'sourceId',
    'sourceHash',
    'transcriptId',
    'sourceArtifactId',
    'sourceRangeMs',
    'evidenceWordIndices',
    'spokenText',
    'normalizedSpokenText',
    'assignment',
    'evaluations',
    'weightedScore',
    'status',
    'protected',
    'selectionSource',
    'reasonCodes',
    'takeHash',
  ],
  properties: {
    id: idSchema,
    groupId: idSchema,
    retakeBoundaryId: idSchema,
    sourceKind: { enum: ['alignment-candidate', 'extra-take'] },
    sourceId: idSchema,
    sourceHash: sha256Schema,
    transcriptId: idSchema,
    sourceArtifactId: idSchema,
    sourceRangeMs: scriptRangeSchema,
    evidenceWordIndices: {
      type: 'array',
      minItems: 1,
      maxItems: 500000,
      items: { type: 'integer', minimum: 0 },
    },
    spokenText: { type: 'string', minLength: 1, maxLength: 500000 },
    normalizedSpokenText: {
      type: 'string',
      minLength: 1,
      maxLength: 500000,
    },
    assignment: takeAssignmentSchema,
    evaluations: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: takeEvaluationSchema,
    },
    weightedScore: {
      oneOf: [
        { type: 'number', minimum: 0, maximum: 1 },
        { type: 'null' },
      ],
    },
    status: {
      enum: ['primary', 'alternate', 'rejected', 'needs-review'],
    },
    protected: { type: 'boolean' },
    selectionSource: { enum: ['automatic', 'manual'] },
    reasonCodes: {
      type: 'array',
      maxItems: 100,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9_]{2,79}$',
      },
    },
    takeHash: sha256Schema,
  },
}
const takeGroupSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'key',
    'assignmentKind',
    'role',
    'label',
    'takeIds',
    'groupHash',
  ],
  properties: {
    id: idSchema,
    key: { type: 'string', minLength: 3, maxLength: 260 },
    assignmentKind: {
      enum: ['script-block', 'inferred-intention'],
    },
    role: takeIntentionRoleSchema,
    label: { type: 'string', minLength: 1, maxLength: 240 },
    scriptBlockId: idSchema,
    takeIds: {
      type: 'array',
      minItems: 1,
      maxItems: 2000,
      uniqueItems: true,
      items: idSchema,
    },
    primaryTakeId: idSchema,
    protectedTakeId: idSchema,
    groupHash: sha256Schema,
  },
}
const takeSelectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'revision',
    'groupId',
    'takeId',
    'protect',
    'actorClientId',
    'createdAt',
    'selectionHash',
  ],
  properties: {
    id: idSchema,
    revision: { type: 'integer', minimum: 2, maximum: 1000000 },
    groupId: idSchema,
    takeId: idSchema,
    protect: { type: 'boolean' },
    replacedProtectedTakeId: idSchema,
    note: { type: 'string', minLength: 1, maxLength: 500 },
    actorClientId: idSchema,
    createdAt: dateTimeSchema,
    selectionHash: sha256Schema,
  },
}
const takeLibraryRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'alignmentId',
    'alignmentRunHash',
    'schemaVersion',
    'groupingPolicyVersion',
    'evaluationPolicyVersion',
    'status',
    'revision',
    'groups',
    'takes',
    'selections',
    'summary',
    'createdByClientId',
    'createdAt',
    'updatedAt',
    'runHash',
  ],
  properties: {
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    alignmentId: idSchema,
    alignmentRunHash: sha256Schema,
    schemaVersion: { const: 'take-library/v1' },
    groupingPolicyVersion: {
      const: 'script-block-or-intention/v1',
    },
    evaluationPolicyVersion: {
      const: 'five-dimension-take-quality/v1',
    },
    status: { enum: ['completed', 'review-required', 'reviewed'] },
    revision: { type: 'integer', minimum: 1, maximum: 1000000 },
    groups: {
      type: 'array',
      minItems: 1,
      maxItems: 2000,
      items: takeGroupSchema,
    },
    takes: {
      type: 'array',
      minItems: 1,
      maxItems: 2000,
      items: takeRecordSchema,
    },
    selections: {
      type: 'array',
      maxItems: 1000000,
      items: takeSelectionSchema,
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'groupCount',
        'takeCount',
        'primaryCount',
        'alternateCount',
        'rejectedCount',
        'needsReviewCount',
        'protectedCount',
        'measuredDimensionCount',
        'unavailableDimensionCount',
        'averageWeightedScore',
      ],
      properties: {
        groupCount: { type: 'integer', minimum: 1, maximum: 2000 },
        takeCount: { type: 'integer', minimum: 1, maximum: 2000 },
        primaryCount: { type: 'integer', minimum: 0, maximum: 2000 },
        alternateCount: { type: 'integer', minimum: 0, maximum: 2000 },
        rejectedCount: { type: 'integer', minimum: 0, maximum: 2000 },
        needsReviewCount: {
          type: 'integer',
          minimum: 0,
          maximum: 2000,
        },
        protectedCount: { type: 'integer', minimum: 0, maximum: 2000 },
        measuredDimensionCount: {
          type: 'integer',
          minimum: 0,
          maximum: 10000,
        },
        unavailableDimensionCount: {
          type: 'integer',
          minimum: 0,
          maximum: 10000,
        },
        averageWeightedScore: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
      },
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    runHash: sha256Schema,
  },
}
const compatibilityRoleSchema = {
  enum: ['hook', 'body', 'proof', 'cta'],
}
const compatibilityClaimSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'value'],
  properties: {
    key: idSchema,
    value: { type: 'string', minLength: 1, maxLength: 500 },
  },
}
const compatibilityContextProperties = {
  offerId: idSchema,
  audienceTags: {
    type: 'array',
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    items: idSchema,
  },
  claims: {
    type: 'array',
    maxItems: 100,
    items: compatibilityClaimSchema,
  },
  personaId: idSchema,
  locale: {
    type: 'string',
    minLength: 2,
    maxLength: 16,
    pattern: '^[a-z]{2,3}(?:-[A-Z][A-Za-z0-9]{1,7})?$',
  },
  desiredAction: idSchema,
  continuityProvides: {
    type: 'array',
    maxItems: 100,
    uniqueItems: true,
    items: idSchema,
  },
  continuityRequires: {
    type: 'array',
    maxItems: 100,
    uniqueItems: true,
    items: idSchema,
  },
  narrativeTags: {
    type: 'array',
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    items: idSchema,
  },
  tone: { type: 'number', minimum: 0, maximum: 1 },
  energy: { type: 'number', minimum: 0, maximum: 1 },
  visual: { type: 'number', minimum: 0, maximum: 1 },
  experiment: { type: 'number', minimum: 0, maximum: 1 },
  evidenceRefs: {
    type: 'array',
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    items: idSchema,
  },
}
const compatibilityNodeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'takeId',
    'takeHash',
    'groupId',
    'role',
    'sourceArtifactId',
    'sourceHash',
    'sourceRangeMs',
    'durationMs',
    'offerId',
    'audienceTags',
    'claims',
    'personaId',
    'locale',
    'continuityProvides',
    'continuityRequires',
    'narrativeTags',
    'tone',
    'energy',
    'visual',
    'experiment',
    'evidenceRefs',
    'contextHash',
    'nodeHash',
  ],
  properties: {
    id: idSchema,
    takeId: idSchema,
    takeHash: sha256Schema,
    groupId: idSchema,
    scriptBlockId: idSchema,
    role: compatibilityRoleSchema,
    sourceArtifactId: idSchema,
    sourceHash: sha256Schema,
    sourceRangeMs: scriptRangeSchema,
    durationMs: {
      type: 'integer',
      minimum: 1,
      maximum: 86400000,
    },
    ...compatibilityContextProperties,
    contextHash: sha256Schema,
    nodeHash: sha256Schema,
  },
}
const compatibilityHardFailureSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'code',
    'field',
    'message',
    'evidenceRefs',
    'failureHash',
  ],
  properties: {
    code: {
      enum: [
        'OFFER_MISMATCH',
        'AUDIENCE_CONFLICT',
        'CLAIM_CONTRADICTION',
        'PERSONA_MISMATCH',
        'LOCALE_MISMATCH',
        'CTA_ACTION_MISMATCH',
        'REQUIRED_CONTINUITY_MISSING',
      ],
    },
    field: { type: 'string', minLength: 1, maxLength: 128 },
    message: { type: 'string', minLength: 1, maxLength: 500 },
    evidenceRefs: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: sha256Schema,
    },
    failureHash: sha256Schema,
  },
}
const compatibilitySoftScoreSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'dimension',
    'score',
    'weight',
    'reasonCode',
    'evidenceRefs',
    'scoreHash',
  ],
  properties: {
    dimension: {
      enum: [
        'narrative',
        'tone',
        'energy',
        'duration',
        'visual',
        'experiment',
      ],
    },
    score: { type: 'number', minimum: 0, maximum: 1 },
    weight: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    reasonCode: {
      type: 'string',
      pattern: '^[A-Z][A-Z0-9_]{2,79}$',
    },
    evidenceRefs: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: sha256Schema,
    },
    scoreHash: sha256Schema,
  },
}
const compatibilityEdgeEvidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'fromTakeHash',
    'toTakeHash',
    'fromSourceHash',
    'toSourceHash',
    'fromContextHash',
    'toContextHash',
    'ruleVersion',
    'softScoreVersion',
    'evidenceHash',
  ],
  properties: {
    fromTakeHash: sha256Schema,
    toTakeHash: sha256Schema,
    fromSourceHash: sha256Schema,
    toSourceHash: sha256Schema,
    fromContextHash: sha256Schema,
    toContextHash: sha256Schema,
    ruleVersion: { const: 'compatibility-rules/v1' },
    softScoreVersion: { const: 'compatibility-soft-score/v1' },
    evidenceHash: sha256Schema,
  },
}
const compatibilityEdgeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'fromNodeId',
    'toNodeId',
    'relation',
    'decision',
    'eligible',
    'hardFailures',
    'softScores',
    'softScore',
    'reasonCodes',
    'evidence',
    'edgeHash',
  ],
  properties: {
    id: idSchema,
    fromNodeId: idSchema,
    toNodeId: idSchema,
    relation: {
      enum: ['hook-body', 'body-proof', 'body-cta', 'proof-cta'],
    },
    decision: { enum: ['accepted', 'borderline', 'blocked'] },
    eligible: { type: 'boolean' },
    hardFailures: {
      type: 'array',
      maxItems: 7,
      items: compatibilityHardFailureSchema,
    },
    softScores: {
      type: 'array',
      minItems: 6,
      maxItems: 6,
      items: compatibilitySoftScoreSchema,
    },
    softScore: { type: 'number', minimum: 0, maximum: 100 },
    reasonCodes: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9_]{2,79}$',
      },
    },
    evidence: compatibilityEdgeEvidenceSchema,
    edgeHash: sha256Schema,
  },
}
const compatibilityGraphRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'takeLibraryId',
    'takeLibraryRunHash',
    'schemaVersion',
    'ruleVersion',
    'softScoreVersion',
    'acceptThreshold',
    'reviewThreshold',
    'nodes',
    'edges',
    'summary',
    'createdByClientId',
    'createdAt',
    'runHash',
  ],
  properties: {
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    takeLibraryId: idSchema,
    takeLibraryRunHash: sha256Schema,
    schemaVersion: { const: 'compatibility-graph/v1' },
    ruleVersion: { const: 'compatibility-rules/v1' },
    softScoreVersion: { const: 'compatibility-soft-score/v1' },
    acceptThreshold: { type: 'number', minimum: 0, maximum: 100 },
    reviewThreshold: { type: 'number', minimum: 0, maximum: 100 },
    nodes: {
      type: 'array',
      minItems: 2,
      maxItems: 2000,
      items: compatibilityNodeSchema,
    },
    edges: {
      type: 'array',
      minItems: 1,
      maxItems: 4000000,
      items: compatibilityEdgeSchema,
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'nodeCount',
        'edgeCount',
        'acceptedCount',
        'borderlineCount',
        'blockedCount',
        'hardFailureCount',
        'averageSoftScore',
      ],
      properties: {
        nodeCount: { type: 'integer', minimum: 2, maximum: 2000 },
        edgeCount: {
          type: 'integer',
          minimum: 1,
          maximum: 4000000,
        },
        acceptedCount: {
          type: 'integer',
          minimum: 0,
          maximum: 4000000,
        },
        borderlineCount: {
          type: 'integer',
          minimum: 0,
          maximum: 4000000,
        },
        blockedCount: {
          type: 'integer',
          minimum: 0,
          maximum: 4000000,
        },
        hardFailureCount: {
          type: 'integer',
          minimum: 0,
          maximum: 28000000,
        },
        averageSoftScore: {
          type: 'number',
          minimum: 0,
          maximum: 100,
        },
      },
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    runHash: sha256Schema,
  },
}
const variantRecipeRangeMsSchema = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: { type: 'integer', minimum: 0 },
}
const variantRecipeSourceSegmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'usage',
    'role',
    'nodeId',
    'takeId',
    'takeHash',
    'scriptBlockId',
    'sourceArtifactId',
    'sourceHash',
    'sourceRangeMs',
    'durationMs',
    'segmentHash',
  ],
  properties: {
    id: idSchema,
    usage: { enum: ['primary', 'cold-open'] },
    role: { enum: ['hook', 'body', 'proof', 'cta'] },
    nodeId: idSchema,
    takeId: idSchema,
    takeHash: sha256Schema,
    scriptBlockId: idSchema,
    sourceArtifactId: idSchema,
    sourceHash: sha256Schema,
    sourceRangeMs: variantRecipeRangeMsSchema,
    durationMs: { type: 'integer', minimum: 1 },
    segmentHash: sha256Schema,
  },
}
const variantRecipeLineageSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sequence',
    'usage',
    'role',
    'nodeId',
    'takeId',
    'takeHash',
    'scriptBlockId',
    'groupId',
    'sourceSegmentId',
    'sourceArtifactId',
    'sourceHash',
    'sourceRangeMs',
    'lineageHash',
  ],
  properties: {
    id: idSchema,
    sequence: { type: 'integer', minimum: 0, maximum: 4 },
    usage: { enum: ['primary', 'cold-open'] },
    role: { enum: ['hook', 'body', 'proof', 'cta'] },
    nodeId: idSchema,
    takeId: idSchema,
    takeHash: sha256Schema,
    scriptBlockId: idSchema,
    groupId: idSchema,
    sourceSegmentId: idSchema,
    sourceArtifactId: idSchema,
    sourceHash: sha256Schema,
    sourceRangeMs: variantRecipeRangeMsSchema,
    lineageHash: sha256Schema,
  },
}
const variantRecipeStoryBlockSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'actId',
    'role',
    'intent',
    'dependencies',
    'sourceCandidateIds',
    'durationTargetMs',
    'content',
    'presentation',
    'sourceRangeId',
  ],
  properties: {
    id: idSchema,
    actId: { enum: ['opening', 'development', 'resolution'] },
    role: { enum: ['hook', 'argument', 'proof', 'cta'] },
    intent: { type: 'string', minLength: 3, maxLength: 128 },
    dependencies: {
      type: 'array',
      maxItems: 5,
      uniqueItems: true,
      items: idSchema,
    },
    sourceCandidateIds: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: idSchema,
    },
    durationTargetMs: {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'ideal', 'max'],
      properties: {
        min: { type: 'integer', minimum: 1 },
        ideal: { type: 'integer', minimum: 1 },
        max: { type: 'integer', minimum: 1 },
      },
    },
    content: {
      type: 'object',
      additionalProperties: false,
      required: ['claimIds', 'qualifierIds', 'proofIds'],
      properties: {
        claimIds: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: idSchema,
        },
        qualifierIds: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: idSchema,
        },
        proofIds: {
          type: 'array',
          maxItems: 100,
          uniqueItems: true,
          items: idSchema,
        },
        ctaId: idSchema,
      },
    },
    presentation: {
      enum: ['source-video', 'cold-open-reference'],
    },
    sourceRangeId: idSchema,
  },
}
const variantRecipeStoryPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'schemaVersion',
    'compilerVersion',
    'objective',
    'targetDurationMs',
    'acts',
    'blocks',
    'storyHash',
  ],
  properties: {
    id: idSchema,
    schemaVersion: { const: 1 },
    compilerVersion: { const: 'variant-recipe-compiler/v1' },
    objective: idSchema,
    targetDurationMs: {
      type: 'object',
      additionalProperties: false,
      required: ['min', 'max'],
      properties: {
        min: { type: 'integer', minimum: 1 },
        max: { type: 'integer', minimum: 1 },
      },
    },
    acts: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role', 'blockIds'],
        properties: {
          id: { enum: ['opening', 'development', 'resolution'] },
          role: { enum: ['opening', 'development', 'resolution'] },
          blockIds: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            items: idSchema,
          },
        },
      },
    },
    blocks: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: variantRecipeStoryBlockSchema,
    },
    storyHash: sha256Schema,
  },
}
const variantRecipeClipSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'storyBlockId',
    'lineageId',
    'sourceSegmentId',
    'sourceArtifactId',
    'sourceHash',
    'sourceRangeMs',
    'timelineRangeFrames',
    'referenceMode',
    'clipHash',
  ],
  properties: {
    id: idSchema,
    storyBlockId: idSchema,
    lineageId: idSchema,
    sourceSegmentId: idSchema,
    sourceArtifactId: idSchema,
    sourceHash: sha256Schema,
    sourceRangeMs: variantRecipeRangeMsSchema,
    timelineRangeFrames: variantRecipeRangeMsSchema,
    referenceMode: { const: 'immutable-source' },
    clipHash: sha256Schema,
  },
}
const variantRecipeEditPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'schemaVersion',
    'compilerVersion',
    'storyPlanId',
    'fps',
    'durationFrames',
    'outputBinding',
    'trackIds',
    'videoTracks',
    'masterReferences',
    'materializesSources',
    'duplicatesMasters',
    'editPlanHash',
  ],
  properties: {
    id: idSchema,
    schemaVersion: { const: 'variant-edit-plan/v1' },
    compilerVersion: { const: 'variant-recipe-compiler/v1' },
    storyPlanId: idSchema,
    fps: { const: 30 },
    durationFrames: { type: 'integer', minimum: 1 },
    outputBinding: { const: 'deferred-to-output-matrix' },
    trackIds: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: idSchema,
    },
    videoTracks: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'clips'],
        properties: {
          id: idSchema,
          kind: { const: 'base-video' },
          clips: {
            type: 'array',
            minItems: 3,
            maxItems: 5,
            items: variantRecipeClipSchema,
          },
        },
      },
    },
    masterReferences: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'sourceArtifactId',
          'sourceHashes',
          'referenceMode',
        ],
        properties: {
          sourceArtifactId: idSchema,
          sourceHashes: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            items: sha256Schema,
          },
          referenceMode: { const: 'immutable-source' },
        },
      },
    },
    materializesSources: { const: false },
    duplicatesMasters: { const: false },
    editPlanHash: sha256Schema,
  },
}
const variantRecipeRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'compatibilityGraphId',
    'compatibilityGraphRunHash',
    'takeLibraryId',
    'schemaVersion',
    'policyVersion',
    'scoreVersion',
    'compilerVersion',
    'objective',
    'status',
    'selection',
    'orderedNodeIds',
    'compatibilityEdgeIds',
    'sourceSegments',
    'assumptions',
    'proofPolicy',
    'scores',
    'storyPlan',
    'editPlan',
    'lineage',
    'summary',
    'createdByClientId',
    'createdAt',
    'runHash',
  ],
  properties: {
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    compatibilityGraphId: idSchema,
    compatibilityGraphRunHash: sha256Schema,
    takeLibraryId: idSchema,
    schemaVersion: { const: 'variant-recipe/v1' },
    policyVersion: { const: 'variant-recipe-policy/v1' },
    scoreVersion: { const: 'variant-recipe-score/v1' },
    compilerVersion: { const: 'variant-recipe-compiler/v1' },
    objective: idSchema,
    status: { enum: ['candidate', 'selected', 'excluded'] },
    selection: {
      type: 'object',
      additionalProperties: false,
      required: ['hookNodeId', 'bodyNodeId', 'ctaNodeId'],
      properties: {
        hookNodeId: idSchema,
        bodyNodeId: idSchema,
        proofNodeId: idSchema,
        ctaNodeId: idSchema,
      },
    },
    orderedNodeIds: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      uniqueItems: true,
      items: idSchema,
    },
    compatibilityEdgeIds: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      uniqueItems: true,
      items: idSchema,
    },
    coldOpen: {
      type: 'object',
      additionalProperties: false,
      required: [
        'nodeId',
        'sourceSegmentId',
        'sourceRangeMs',
        'returnAtRole',
        'coldOpenHash',
      ],
      properties: {
        nodeId: idSchema,
        sourceSegmentId: idSchema,
        sourceRangeMs: variantRecipeRangeMsSchema,
        returnAtRole: { const: 'hook' },
        coldOpenHash: sha256Schema,
      },
    },
    sourceSegments: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: variantRecipeSourceSegmentSchema,
    },
    assumptions: {
      type: 'array',
      maxItems: 25,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'code',
          'statement',
          'evidenceRefs',
          'assumptionHash',
        ],
        properties: {
          code: {
            type: 'string',
            pattern: '^[A-Z][A-Z0-9_]{2,79}$',
          },
          statement: {
            type: 'string',
            minLength: 3,
            maxLength: 500,
          },
          evidenceRefs: {
            type: 'array',
            minItems: 1,
            maxItems: 25,
            uniqueItems: true,
            items: {
              type: 'string',
              minLength: 3,
              maxLength: 256,
            },
          },
          assumptionHash: sha256Schema,
        },
      },
    },
    proofPolicy: {
      type: 'object',
      additionalProperties: false,
      required: [
        'version',
        'objective',
        'baseRequirement',
        'effectiveRequirement',
        'stricterRequestApplied',
        'reasonCode',
        'policyHash',
      ],
      properties: {
        version: { const: 'variant-recipe-policy/v1' },
        objective: idSchema,
        baseRequirement: { enum: ['required', 'optional'] },
        effectiveRequirement: { enum: ['required', 'optional'] },
        stricterRequestApplied: { type: 'boolean' },
        reasonCode: {
          type: 'string',
          pattern: '^[A-Z][A-Z0-9_]{2,79}$',
        },
        policyHash: sha256Schema,
      },
    },
    scores: {
      type: 'object',
      additionalProperties: false,
      required: [
        'version',
        'minimumEdgeScore',
        'averageEdgeScore',
        'weightedEdgeScore',
        'objectiveScore',
        'lineageCompletenessScore',
        'totalScore',
        'dimensions',
        'scoresHash',
      ],
      properties: {
        version: { const: 'variant-recipe-score/v1' },
        minimumEdgeScore: {
          type: 'number',
          minimum: 0,
          maximum: 100,
        },
        averageEdgeScore: {
          type: 'number',
          minimum: 0,
          maximum: 100,
        },
        weightedEdgeScore: {
          type: 'number',
          minimum: 0,
          maximum: 100,
        },
        objectiveScore: {
          type: 'number',
          minimum: 0,
          maximum: 100,
        },
        lineageCompletenessScore: {
          type: 'number',
          minimum: 0,
          maximum: 100,
        },
        totalScore: {
          type: 'number',
          minimum: 0,
          maximum: 100,
        },
        dimensions: {
          type: 'array',
          minItems: 4,
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'dimension',
              'score',
              'weight',
              'evidenceRefs',
              'reasonCode',
              'scoreHash',
            ],
            properties: {
              dimension: {
                enum: [
                  'minimum-edge',
                  'weighted-edge',
                  'objective-fit',
                  'lineage-completeness',
                ],
              },
              score: {
                type: 'number',
                minimum: 0,
                maximum: 100,
              },
              weight: {
                type: 'number',
                exclusiveMinimum: 0,
                maximum: 1,
              },
              evidenceRefs: {
                type: 'array',
                minItems: 1,
                maxItems: 5,
                items: {
                  type: 'string',
                  minLength: 3,
                  maxLength: 128,
                },
              },
              reasonCode: {
                type: 'string',
                pattern: '^[A-Z][A-Z0-9_]{2,79}$',
              },
              scoreHash: sha256Schema,
            },
          },
        },
        scoresHash: sha256Schema,
      },
    },
    storyPlan: variantRecipeStoryPlanSchema,
    editPlan: variantRecipeEditPlanSchema,
    lineage: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: variantRecipeLineageSchema,
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'selectedTakeCount',
        'sourceSegmentCount',
        'lineageCount',
        'compatibilityEdgeCount',
        'estimatedDurationMs',
        'estimatedDurationFrames',
        'includesProof',
        'hasColdOpen',
        'masterReferenceCount',
      ],
      properties: {
        selectedTakeCount: {
          type: 'integer',
          minimum: 3,
          maximum: 4,
        },
        sourceSegmentCount: {
          type: 'integer',
          minimum: 3,
          maximum: 5,
        },
        lineageCount: {
          type: 'integer',
          minimum: 3,
          maximum: 5,
        },
        compatibilityEdgeCount: {
          type: 'integer',
          minimum: 2,
          maximum: 3,
        },
        estimatedDurationMs: { type: 'integer', minimum: 1 },
        estimatedDurationFrames: { type: 'integer', minimum: 1 },
        includesProof: { type: 'boolean' },
        hasColdOpen: { type: 'boolean' },
        masterReferenceCount: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
        },
      },
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    runHash: sha256Schema,
  },
}
const variantPortfolioPolicySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'workspaceId',
    'revision',
    'defaultRecipeLimit',
    'maxRecipeLimit',
    'maxOutputCount',
    'minCompatibilityEdgeScore',
    'minRecipeScore',
    'minHookCoverage',
    'minBodyCoverage',
    'minCtaCoverage',
    'maxRecipesPerSemanticCluster',
    'maxCandidateScanCount',
    'estimatedCostPerOutputMinorUnits',
    'estimatedDurationSecondsPerOutput',
    'estimatedStorageBytesPerOutput',
    'maxConcurrentJobs',
    'confirmationTtlSeconds',
    'updatedByClientId',
    'updatedAt',
    'policyHash',
  ],
  properties: {
    schemaVersion: { const: 'variant-portfolio-policy/v1' },
    workspaceId: idSchema,
    revision: { type: 'integer', minimum: 1 },
    defaultRecipeLimit: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
    },
    maxRecipeLimit: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
    },
    maxOutputCount: {
      type: 'integer',
      minimum: 1,
      maximum: 50000,
    },
    minCompatibilityEdgeScore: {
      type: 'number',
      minimum: 0,
      maximum: 100,
    },
    minRecipeScore: {
      type: 'number',
      minimum: 0,
      maximum: 100,
    },
    minHookCoverage: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
    },
    minBodyCoverage: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
    },
    minCtaCoverage: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
    },
    maxRecipesPerSemanticCluster: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
    },
    maxCandidateScanCount: {
      type: 'integer',
      minimum: 100,
      maximum: 1000000,
    },
    estimatedCostPerOutputMinorUnits: {
      type: 'integer',
      minimum: 1,
    },
    estimatedDurationSecondsPerOutput: {
      type: 'integer',
      minimum: 1,
    },
    estimatedStorageBytesPerOutput: {
      type: 'integer',
      minimum: 1,
    },
    maxConcurrentJobs: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
    },
    confirmationTtlSeconds: {
      type: 'integer',
      minimum: 60,
      maximum: 86400,
    },
    updatedByClientId: idSchema,
    updatedAt: dateTimeSchema,
    policyHash: sha256Schema,
  },
}
const variantPortfolioSelectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hookNodeId', 'bodyNodeId', 'ctaNodeId'],
  properties: {
    hookNodeId: idSchema,
    bodyNodeId: idSchema,
    proofNodeId: idSchema,
    ctaNodeId: idSchema,
  },
}
const variantPortfolioCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'rank',
    'selection',
    'orderedNodeIds',
    'compatibilityEdgeIds',
    'minimumEdgeScore',
    'averageEdgeScore',
    'totalScore',
    'semanticClusterHash',
    'noveltyScore',
    'candidateHash',
  ],
  properties: {
    rank: { type: 'integer', minimum: 1, maximum: 1000 },
    selection: variantPortfolioSelectionSchema,
    orderedNodeIds: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      uniqueItems: true,
      items: idSchema,
    },
    compatibilityEdgeIds: {
      type: 'array',
      minItems: 2,
      maxItems: 3,
      uniqueItems: true,
      items: idSchema,
    },
    minimumEdgeScore: {
      type: 'number',
      minimum: 0,
      maximum: 100,
    },
    averageEdgeScore: {
      type: 'number',
      minimum: 0,
      maximum: 100,
    },
    totalScore: {
      type: 'number',
      minimum: 0,
      maximum: 100,
    },
    semanticClusterHash: sha256Schema,
    noveltyScore: { type: 'number', minimum: 0, maximum: 1 },
    reusableRecipeId: idSchema,
    reusableRecipeRunHash: sha256Schema,
    candidateHash: sha256Schema,
  },
}
const variantPortfolioCountSetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hooks', 'bodies', 'ctas'],
  properties: {
    hooks: { type: 'integer', minimum: 0, maximum: 1000 },
    bodies: { type: 'integer', minimum: 0, maximum: 1000 },
    ctas: { type: 'integer', minimum: 0, maximum: 1000 },
  },
}
const variantPortfolioPreflightRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'selectionVersion',
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'compatibilityGraphId',
    'compatibilityGraphRunHash',
    'takeLibraryId',
    'objective',
    'policy',
    'status',
    'requestedRecipeCount',
    'effectiveRecipeLimit',
    'batchVariantCount',
    'budgetRemainingMinorUnits',
    'theoreticalCandidateCount',
    'eligibleCandidateCount',
    'scannedCandidateCount',
    'scanTruncated',
    'selectedRecipeCount',
    'productMaterialized',
    'confirmation',
    'coverage',
    'selected',
    'exclusions',
    'estimates',
    'warningCodes',
    'createdByClientId',
    'createdAt',
    'runHash',
  ],
  properties: {
    schemaVersion: { const: 'variant-portfolio-preflight/v1' },
    selectionVersion: { const: 'variant-portfolio-selection/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    compatibilityGraphId: idSchema,
    compatibilityGraphRunHash: sha256Schema,
    takeLibraryId: idSchema,
    objective: idSchema,
    policy: variantPortfolioPolicySchema,
    status: {
      enum: [
        'ready',
        'confirmation-required',
        'no-eligible-recipes',
      ],
    },
    requestedRecipeCount: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
    },
    effectiveRecipeLimit: {
      type: 'integer',
      minimum: 0,
      maximum: 1000,
    },
    batchVariantCount: {
      type: 'integer',
      minimum: 1,
      maximum: 50,
    },
    budgetRemainingMinorUnits: { type: 'integer', minimum: 0 },
    theoreticalCandidateCount: {
      type: 'string',
      pattern: '^(0|[1-9][0-9]*)$',
    },
    eligibleCandidateCount: {
      type: 'string',
      pattern: '^(0|[1-9][0-9]*)$',
    },
    scannedCandidateCount: { type: 'integer', minimum: 0 },
    scanTruncated: { type: 'boolean' },
    selectedRecipeCount: {
      type: 'integer',
      minimum: 0,
      maximum: 1000,
    },
    productMaterialized: { const: false },
    confirmation: {
      type: 'object',
      additionalProperties: false,
      required: [
        'required',
        'satisfied',
        'threshold',
        'confirmationHash',
      ],
      properties: {
        required: { type: 'boolean' },
        satisfied: { type: 'boolean' },
        threshold: { type: 'integer', minimum: 1, maximum: 1000 },
        expiresAt: dateTimeSchema,
        confirmationHash: sha256Schema,
      },
    },
    coverage: {
      type: 'object',
      additionalProperties: false,
      required: [
        'required',
        'achieved',
        'complete',
        'reasonCodes',
        'coverageHash',
      ],
      properties: {
        required: variantPortfolioCountSetSchema,
        achieved: variantPortfolioCountSetSchema,
        complete: { type: 'boolean' },
        reasonCodes: {
          type: 'array',
          maxItems: 3,
          uniqueItems: true,
          items: {
            type: 'string',
            pattern: '^[A-Z][A-Z0-9_]{2,79}$',
          },
        },
        coverageHash: sha256Schema,
      },
    },
    selected: {
      type: 'array',
      maxItems: 1000,
      items: variantPortfolioCandidateSchema,
    },
    exclusions: {
      type: 'object',
      additionalProperties: false,
      required: [
        'hardFilterCount',
        'belowQualityCount',
        'duplicateCount',
        'semanticClusterCount',
        'budgetCount',
        'capacityCount',
        'reasonCodes',
        'exclusionsHash',
      ],
      properties: {
        hardFilterCount: {
          type: 'string',
          pattern: '^(0|[1-9][0-9]*)$',
        },
        belowQualityCount: { type: 'integer', minimum: 0 },
        duplicateCount: { type: 'integer', minimum: 0 },
        semanticClusterCount: { type: 'integer', minimum: 0 },
        budgetCount: { type: 'integer', minimum: 0 },
        capacityCount: { type: 'integer', minimum: 0 },
        reasonCodes: {
          type: 'array',
          maxItems: 6,
          uniqueItems: true,
          items: {
            type: 'string',
            pattern: '^[A-Z][A-Z0-9_]{2,79}$',
          },
        },
        exclusionsHash: sha256Schema,
      },
    },
    estimates: {
      type: 'object',
      additionalProperties: false,
      required: [
        'version',
        'currency',
        'outputVariantCount',
        'reusedRecipeCount',
        'reusedOutputCount',
        'plannedJobCount',
        'jobsCreated',
        'estimatedCostMinorUnits',
        'estimatedDurationSeconds',
        'estimatedStorageBytes',
        'expectedReuseRate',
        'estimateHash',
      ],
      properties: {
        version: { const: 'variant-portfolio-estimate/v1' },
        currency: { const: 'USD' },
        outputVariantCount: { type: 'integer', minimum: 0 },
        reusedRecipeCount: { type: 'integer', minimum: 0 },
        reusedOutputCount: { type: 'integer', minimum: 0 },
        plannedJobCount: { type: 'integer', minimum: 0 },
        jobsCreated: { const: 0 },
        estimatedCostMinorUnits: { type: 'integer', minimum: 0 },
        estimatedDurationSeconds: { type: 'integer', minimum: 0 },
        estimatedStorageBytes: { type: 'integer', minimum: 0 },
        expectedReuseRate: { type: 'number', minimum: 0, maximum: 1 },
        estimateHash: sha256Schema,
      },
    },
    warningCodes: {
      type: 'array',
      maxItems: 8,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^[A-Z][A-Z0-9_]{2,79}$',
      },
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    runHash: sha256Schema,
  },
}
const semanticSearchSourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'id', 'hash', 'artifactId', 'artifactSha256'],
  properties: {
    type: {
      enum: [
        'artifact',
        'speech-segment',
        'evidence-segment',
        'long-form-moment',
        'validated-segment',
      ],
    },
    id: idSchema,
    hash: sha256Schema,
    artifactId: idSchema,
    artifactSha256: sha256Schema,
  },
}
const semanticSearchProducerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'model', 'version', 'confidence'],
  properties: {
    provider: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
    model: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
    version: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const semanticEmbeddingEvidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'state',
    'provider',
    'model',
    'version',
    'dimensions',
    'degraded',
    'inputHash',
  ],
  properties: {
    state: { enum: ['ready', 'unavailable'] },
    provider: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
    model: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
    version: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
    dimensions: { type: 'integer', minimum: 8, maximum: 4096 },
    degraded: { type: 'boolean' },
    inputHash: sha256Schema,
    vectorHash: sha256Schema,
  },
  oneOf: [
    {
      properties: {
        state: { const: 'ready' },
        vectorHash: sha256Schema,
      },
      required: ['state', 'vectorHash'],
    },
    {
      properties: {
        state: { const: 'unavailable' },
        vectorHash: sha256Schema,
      },
      required: ['state'],
      not: { required: ['vectorHash'] },
    },
  ],
}
const semanticSearchDocumentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'source',
    'identityKey',
    'kind',
    'durationMs',
    'locale',
    'personIds',
    'transcriptText',
    'ocrText',
    'intentions',
    'description',
    'metadata',
    'producer',
    'embedding',
    'rightsSnapshotId',
    'rightsStatus',
    'consentStatus',
    'indexVersion',
    'active',
    'physicalMaterialized',
    'createdBy',
    'createdAt',
    'documentHash',
  ],
  properties: {
    schemaVersion: { const: 'semantic-search-document/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    source: semanticSearchSourceSchema,
    identityKey: {
      type: 'string',
      minLength: 3,
      maxLength: 260,
    },
    kind: {
      enum: [
        'image',
        'video',
        'audio',
        'speech-segment',
        'evidence-segment',
        'long-form-moment',
        'validated-segment',
      ],
    },
    durationMs: { type: 'integer', minimum: 0 },
    locale: {
      type: 'string',
      pattern: '^[a-z]{2,3}(?:-[A-Z]{2})?$',
    },
    personIds: {
      type: 'array',
      maxItems: 100,
      uniqueItems: true,
      items: idSchema,
    },
    transcriptText: {
      type: 'string',
      maxLength: 100000,
    },
    ocrText: { type: 'string', maxLength: 100000 },
    intentions: {
      type: 'array',
      maxItems: 100,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
      },
    },
    description: { type: 'string', maxLength: 40001 },
    metadata: {
      type: 'object',
      maxProperties: 50,
      additionalProperties: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
      },
    },
    producer: semanticSearchProducerSchema,
    embedding: semanticEmbeddingEvidenceSchema,
    rightsSnapshotId: idSchema,
    rightsStatus: {
      enum: ['approved', 'restricted', 'unknown', 'expired', 'revoked'],
    },
    consentStatus: {
      enum: [
        'approved',
        'not-required',
        'restricted',
        'unknown',
        'expired',
        'revoked',
      ],
    },
    indexVersion: { const: 'semantic-search-index/v1' },
    active: { type: 'boolean' },
    physicalMaterialized: { const: false },
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'api-client' },
        id: idSchema,
      },
    },
    createdAt: dateTimeSchema,
    documentHash: sha256Schema,
  },
}
const semanticSearchFilterSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    kinds: {
      type: 'array',
      minItems: 1,
      maxItems: 7,
      uniqueItems: true,
      items: {
        enum: [
          'image',
          'video',
          'audio',
          'speech-segment',
          'evidence-segment',
          'long-form-moment',
          'validated-segment',
        ],
      },
    },
    personIds: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: idSchema,
    },
    minDurationMs: { type: 'integer', minimum: 0 },
    maxDurationMs: { type: 'integer', minimum: 0 },
    locale: {
      type: 'string',
      pattern: '^[a-z]{2,3}(?:-[A-Z]{2})?$',
    },
    metadata: {
      type: 'object',
      minProperties: 1,
      maxProperties: 20,
      additionalProperties: {
        type: 'string',
        minLength: 1,
        maxLength: 500,
      },
    },
    rights: { enum: ['approved', 'blocked', 'any'] },
  },
}
const hybridSearchQueryProperties = {
  scope: {
    enum: ['project', 'workspace'],
    default: 'project',
  },
  text: { type: 'string', minLength: 1, maxLength: 2000 },
  intention: { type: 'string', minLength: 1, maxLength: 2000 },
  atmosphere: { type: 'string', minLength: 1, maxLength: 500 },
  personIds: {
    type: 'array',
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
    items: idSchema,
  },
  speech: { type: 'string', minLength: 1, maxLength: 2000 },
  visual: { type: 'string', minLength: 1, maxLength: 2000 },
  rightsUse: {
    type: 'string',
    pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
  },
  filters: semanticSearchFilterSchema,
  includeBlocked: { type: 'boolean', default: false },
}
const hybridSearchQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rightsUse'],
  anyOf: [
    {
      properties: { text: hybridSearchQueryProperties.text },
      required: ['text'],
    },
    {
      properties: {
        intention: hybridSearchQueryProperties.intention,
      },
      required: ['intention'],
    },
    {
      properties: { filters: hybridSearchQueryProperties.filters },
      required: ['filters'],
    },
    ...['atmosphere', 'personIds', 'speech', 'visual'].map(
      (field) => ({
        properties: {
          [field]:
            hybridSearchQueryProperties[
              field as keyof typeof hybridSearchQueryProperties
            ],
        },
        required: [field],
      }),
    ),
  ],
  properties: {
    ...hybridSearchQueryProperties,
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    explain: { type: 'boolean', default: true },
  },
}
const {
  scope: _hybridSearchScope,
  ...retrievalScaleQueryProperties
} = hybridSearchQueryProperties
const retrievalScaleQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['rightsUse'],
  anyOf: [
    {
      properties: { text: retrievalScaleQueryProperties.text },
      required: ['text'],
    },
    {
      properties: {
        intention: retrievalScaleQueryProperties.intention,
      },
      required: ['intention'],
    },
    {
      properties: { filters: retrievalScaleQueryProperties.filters },
      required: ['filters'],
    },
    ...['atmosphere', 'personIds', 'speech', 'visual'].map(
      (field) => ({
        properties: {
          [field]:
            retrievalScaleQueryProperties[
              field as keyof typeof retrievalScaleQueryProperties
            ],
        },
        required: [field],
      }),
    ),
  ],
  properties: retrievalScaleQueryProperties,
}
const hybridMatchReasonsSchema = {
  type: 'array',
  maxItems: 11,
  uniqueItems: true,
  items: {
    enum: [
      'full-text:transcript',
      'full-text:ocr',
      'full-text:description',
      'full-text:intention',
      'vector:intention-description',
      'structured:kind',
      'structured:person',
      'structured:duration',
      'structured:locale',
      'structured:metadata',
      'rights:allowed',
    ],
  },
}
const retrievalMetricsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'precisionAtK',
    'recallAtK',
    'ndcgAtK',
    'reciprocalRank',
    'hitsAtK',
    'relevantCount',
    'returnedCount',
    'k',
  ],
  properties: {
    precisionAtK: { type: 'number', minimum: 0, maximum: 1 },
    recallAtK: { type: 'number', minimum: 0, maximum: 1 },
    ndcgAtK: { type: 'number', minimum: 0, maximum: 1 },
    reciprocalRank: { type: 'number', minimum: 0, maximum: 1 },
    hitsAtK: { type: 'integer', minimum: 0 },
    relevantCount: { type: 'integer', minimum: 0 },
    returnedCount: { type: 'integer', minimum: 0 },
    k: { type: 'integer', minimum: 1, maximum: 100 },
  },
}
const manualInspectorSchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    layout: { type: 'string', minLength: 1, maxLength: 500 },
    text: { type: 'string', minLength: 1, maxLength: 500 },
    subtitle: { type: 'string', minLength: 1, maxLength: 500 },
    color: { type: 'string', minLength: 1, maxLength: 500 },
    motion: { type: 'string', minLength: 1, maxLength: 500 },
    audioGain: { type: 'number', minimum: 0, maximum: 4 },
  },
}
const manualCropRegionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
    y: { type: 'number', minimum: 0, exclusiveMaximum: 1 },
    width: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    height: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
  },
}
const manualGestureSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false, required: ['kind', 'clipId'],
      properties: { kind: { const: 'select' }, clipId: idSchema },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'clipId', 'edge', 'atMs'],
      properties: {
        kind: { const: 'trim' }, clipId: idSchema, edge: { enum: ['start', 'end'] },
        atMs: { type: 'number', minimum: 0 },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'clipId', 'atMs'],
      properties: { kind: { const: 'split' }, clipId: idSchema, atMs: { type: 'number', minimum: 0 } },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'clipId', 'startMs', 'track'],
      properties: {
        kind: { const: 'move' }, clipId: idSchema, startMs: { type: 'number', minimum: 0 },
        track: { type: 'integer', minimum: 0, maximum: 63 },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'clipId', 'sourceId'],
      properties: { kind: { const: 'replace' }, clipId: idSchema, sourceId: idSchema },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'clipId', 'crop'],
      properties: { kind: { const: 'crop' }, clipId: idSchema, crop: manualCropRegionSchema },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'clipId', 'patch'],
      properties: { kind: { const: 'inspect' }, clipId: idSchema, patch: manualInspectorSchema },
    },
  ],
}
const manualGestureSchemaV1 = {
  oneOf: manualGestureSchema.oneOf.filter((schema) =>
    schema.properties.kind.const !== 'crop'),
}
const manualTimelineClipPropertiesV1 = {
  id: idSchema,
  sourceId: idSchema,
  startMs: { type: 'number', minimum: 0 },
  endMs: { type: 'number', exclusiveMinimum: 0 },
  track: { type: 'integer', minimum: 0, maximum: 63 },
  selected: { type: 'boolean' },
  inspector: {
    type: 'object', additionalProperties: false,
    properties: manualInspectorSchema.properties,
  },
}
const manualTimelineSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['versionId', 'revision', 'clips', 'snapPointsMs'],
  properties: {
    versionId: idSchema,
    revision: { type: 'integer', minimum: 1 },
    clips: {
      type: 'array', maxItems: 10000,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'sourceId', 'startMs', 'endMs', 'track', 'selected', 'inspector'],
        properties: {
          ...manualTimelineClipPropertiesV1,
          crop: manualCropRegionSchema,
        },
      },
    },
    snapPointsMs: {
      type: 'array', maxItems: 50000, uniqueItems: true,
      items: { type: 'number', minimum: 0 },
    },
  },
}
const manualTimelineSchemaV1 = {
  ...manualTimelineSchema,
  properties: {
    ...manualTimelineSchema.properties,
    clips: {
      ...manualTimelineSchema.properties.clips,
      items: {
        ...manualTimelineSchema.properties.clips.items,
        properties: manualTimelineClipPropertiesV1,
      },
    },
  },
}
const commandImpactSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'changeKinds', 'dependencyTypes', 'affectedRanges', 'affectedVariantIds',
    'affectedArtifacts', 'minimalRenders', 'renderSemanticsChanged', 'impactHash',
  ],
  properties: {
    schemaVersion: { const: 'command-impact/v1' },
    commandId: idSchema,
    commandType: { const: 'manual-edit' },
    baseVersionId: idSchema,
    resultVersionId: idSchema,
    changeKinds: {
      type: 'array', minItems: 1, maxItems: 16, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 64 },
    },
    dependencyTypes: {
      type: 'array', maxItems: 6, uniqueItems: true,
      items: { enum: ['content', 'timing', 'visual', 'audio', 'policy', 'rights'] },
    },
    affectedRanges: {
      type: 'array', minItems: 1, maxItems: 1000,
      items: {
        type: 'object', additionalProperties: false,
        required: ['startFrame', 'endFrame'],
        properties: {
          startFrame: { type: 'integer', minimum: 0 },
          endFrame: { type: 'integer', minimum: 1 },
        },
      },
    },
    affectedVariantIds: {
      type: 'array', maxItems: 100, uniqueItems: true, items: idSchema,
    },
    affectedArtifacts: {
      type: 'array', maxItems: 1000,
      items: {
        type: 'object', additionalProperties: false,
        required: ['artifactId', 'kind', 'sourceVersionId', 'variantId'],
        properties: {
          artifactId: idSchema,
          kind: { enum: ['proxy', 'final'] },
          sourceVersionId: idSchema,
          variantId: idSchema,
        },
      },
    },
    minimalRenders: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'variantId', 'ranges'],
        properties: {
          kind: { const: 'proxy' }, variantId: idSchema,
          ranges: {
            type: 'array', minItems: 1, maxItems: 1000,
            items: {
              type: 'object', additionalProperties: false,
              required: ['startFrame', 'endFrame'],
              properties: {
                startFrame: { type: 'integer', minimum: 0 },
                endFrame: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
    },
    renderSemanticsChanged: { type: 'boolean' },
    impactHash: sha256Schema,
  },
}
const reviewPatchCommandImpactSchema = {
  ...commandImpactSchema,
  properties: {
    ...commandImpactSchema.properties,
    commandType: { const: 'apply-review-patch' },
    renderSemanticsChanged: { const: true },
  },
}
const reviewPatchBatchCommandImpactSchema = {
  ...commandImpactSchema,
  properties: {
    ...commandImpactSchema.properties,
    commandType: { const: 'apply-review-patch-batch' },
    renderSemanticsChanged: { const: true },
  },
}
const commandArtifactInvalidationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'status', 'commandId', 'baseVersionId', 'resultVersionId',
    'artifactId', 'kind', 'variantId', 'dependencyTypes', 'affectedRanges',
    'impactHash', 'createdAt',
  ],
  properties: {
    schemaVersion: { const: 'command-artifact-invalidation/v1' },
    id: sha256Schema,
    status: { const: 'stale' },
    commandId: idSchema,
    baseVersionId: idSchema,
    resultVersionId: idSchema,
    artifactId: idSchema,
    kind: { enum: ['proxy', 'final'] },
    variantId: idSchema,
    dependencyTypes: commandImpactSchema.properties.dependencyTypes,
    affectedRanges: commandImpactSchema.properties.affectedRanges,
    impactHash: sha256Schema,
    createdAt: dateTimeSchema,
  },
}
const sourceTranscriptReplacementImpactSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'previousTranscriptId', 'previousTranscriptHash', 'replacementTranscriptId',
    'replacementTranscriptHash', 'changeKinds', 'dependencyTypes', 'affectedRanges',
    'affectedVariantIds', 'affectedArtifacts', 'requiredRecomputations',
    'renderBlockedUntilDirectorRun', 'impactHash',
  ],
  properties: {
    schemaVersion: { const: 'source-transcript-replacement-impact/v1' },
    commandId: idSchema,
    commandType: { const: 'replace-source-transcript' },
    baseVersionId: idSchema,
    resultVersionId: idSchema,
    previousTranscriptId: idSchema,
    previousTranscriptHash: sha256Schema,
    replacementTranscriptId: idSchema,
    replacementTranscriptHash: sha256Schema,
    changeKinds: { type: 'array', minItems: 1, maxItems: 1, prefixItems: [{ const: 'source-transcript' }], items: false },
    dependencyTypes: commandImpactSchema.properties.dependencyTypes,
    affectedRanges: commandImpactSchema.properties.affectedRanges,
    affectedVariantIds: commandImpactSchema.properties.affectedVariantIds,
    affectedArtifacts: commandImpactSchema.properties.affectedArtifacts,
    requiredRecomputations: {
      type: 'array', minItems: 6, maxItems: 6,
      prefixItems: [
        { const: 'perception' }, { const: 'treatment' }, { const: 'story' },
        { const: 'edit-plan' }, { const: 'proxy' }, { const: 'final' },
      ],
      items: false,
    },
    renderBlockedUntilDirectorRun: { const: true },
    impactHash: sha256Schema,
  },
}
const editorialCutImpactSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'sourceTranscriptId', 'sourceTranscriptHash', 'changeKinds', 'dependencyTypes',
    'affectedRanges', 'affectedVariantIds', 'affectedArtifacts', 'minimalRenders',
    'renderSemanticsChanged', 'impactHash',
  ],
  properties: {
    schemaVersion: { const: 'editorial-cut-impact/v1' },
    commandId: idSchema,
    commandType: { const: 'remove-spoken-content' },
    baseVersionId: idSchema,
    resultVersionId: idSchema,
    sourceTranscriptId: idSchema,
    sourceTranscriptHash: sha256Schema,
    changeKinds: { type: 'array', minItems: 1, maxItems: 1, prefixItems: [{ const: 'spoken-content-removal' }], items: false },
    dependencyTypes: commandImpactSchema.properties.dependencyTypes,
    affectedRanges: commandImpactSchema.properties.affectedRanges,
    affectedVariantIds: commandImpactSchema.properties.affectedVariantIds,
    affectedArtifacts: commandImpactSchema.properties.affectedArtifacts,
    minimalRenders: commandImpactSchema.properties.minimalRenders,
    renderSemanticsChanged: { const: true },
    impactHash: sha256Schema,
  },
}
const directorRunImpactSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'sourceTranscriptId', 'sourceTranscriptHash', 'plannerVersion', 'criticVersion',
    'changeKinds', 'dependencyTypes', 'affectedRanges', 'affectedVariantIds',
    'affectedArtifacts', 'minimalRenders', 'renderSemanticsChanged', 'impactHash',
  ],
  properties: {
    schemaVersion: { const: 'director-run-impact/v1' },
    commandId: idSchema,
    commandType: { const: 'run-director' },
    baseVersionId: idSchema,
    resultVersionId: idSchema,
    sourceTranscriptId: idSchema,
    sourceTranscriptHash: sha256Schema,
    plannerVersion: { type: 'string', minLength: 3, maxLength: 128 },
    criticVersion: { type: 'string', minLength: 3, maxLength: 128 },
    changeKinds: { type: 'array', minItems: 1, maxItems: 1, prefixItems: [{ const: 'director-replan' }], items: false },
    dependencyTypes: commandImpactSchema.properties.dependencyTypes,
    affectedRanges: commandImpactSchema.properties.affectedRanges,
    affectedVariantIds: commandImpactSchema.properties.affectedVariantIds,
    affectedArtifacts: commandImpactSchema.properties.affectedArtifacts,
    minimalRenders: commandImpactSchema.properties.minimalRenders,
    renderSemanticsChanged: { const: true },
    impactHash: sha256Schema,
  },
}
const projectLutSelectionImpactSchema = {
  type: 'object', additionalProperties: false,
  required: [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'selectionId', 'selectionHash', 'resolvedMode', 'resolvedLutVersionId',
    'resolvedLutRecordHash', 'intensity', 'changeKinds', 'dependencyTypes',
    'affectedRanges', 'affectedVariantIds', 'affectedArtifacts', 'minimalRenders',
    'renderSemanticsChanged', 'renderDeferredUntilTimeline', 'impactHash',
  ],
  properties: {
    schemaVersion: { const: 'project-lut-selection-impact/v1' },
    commandId: idSchema, commandType: { const: 'set-project-lut-selection' },
    baseVersionId: idSchema, resultVersionId: idSchema, selectionId: idSchema,
    selectionHash: sha256Schema, resolvedMode: { enum: ['none', 'lut-version'] },
    resolvedLutVersionId: { anyOf: [idSchema, { type: 'null' }] },
    resolvedLutRecordHash: { anyOf: [sha256Schema, { type: 'null' }] },
    intensity: { type: 'number', minimum: 0, maximum: 1 },
    changeKinds: { type: 'array', minItems: 1, maxItems: 1, prefixItems: [{ const: 'color-pipeline-selection' }], items: false },
    dependencyTypes: { type: 'array', minItems: 1, maxItems: 1, prefixItems: [{ const: 'visual' }], items: false },
    affectedRanges: { ...commandImpactSchema.properties.affectedRanges, minItems: 0 },
    affectedVariantIds: commandImpactSchema.properties.affectedVariantIds,
    affectedArtifacts: commandImpactSchema.properties.affectedArtifacts,
    minimalRenders: commandImpactSchema.properties.minimalRenders,
    renderSemanticsChanged: { const: true }, renderDeferredUntilTimeline: { type: 'boolean' }, impactHash: sha256Schema,
  },
}
const compareActionImpactSchema = {
  type: 'object', additionalProperties: false,
  required: [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'action', 'changeKinds', 'dependencyTypes', 'affectedRanges', 'affectedVariantIds',
    'affectedArtifacts', 'minimalRenders', 'renderSemanticsChanged', 'impactHash',
  ],
  properties: {
    schemaVersion: { const: 'compare-action-impact/v1' },
    commandId: idSchema, commandType: { const: 'compare-action' },
    baseVersionId: idSchema, resultVersionId: idSchema,
    action: { enum: ['accept', 'reopen'] },
    changeKinds: { type: 'array', minItems: 1, maxItems: 1, prefixItems: [{ const: 'review-state' }], items: false },
    dependencyTypes: { type: 'array', maxItems: 0, items: false },
    affectedRanges: { type: 'array', maxItems: 0, items: false },
    affectedVariantIds: { type: 'array', maxItems: 0, items: false },
    affectedArtifacts: { type: 'array', maxItems: 0, items: false },
    minimalRenders: { type: 'array', maxItems: 0, items: false },
    renderSemanticsChanged: { const: false },
    impactHash: sha256Schema,
  },
}
const projectLutSelectionResultSchemaV2 = {
  ...projectLutSelectionResultSchema,
  required: [...projectLutSelectionResultSchema.required, 'impact', 'invalidations'],
  properties: {
    ...projectLutSelectionResultSchema.properties,
    impact: projectLutSelectionImpactSchema,
    invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
  },
}
const versionComparisonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'before', 'after', 'mode', 'synchronized', 'playheadMapping', 'durationDeltaMs',
    'scoreDelta', 'issuesAdded', 'issuesResolved', 'semanticChanges', 'actions',
    'versionsPreserved',
  ],
  properties: {
    before: {
      type: 'object', additionalProperties: false,
      required: ['id', 'durationMs', 'score', 'issues'],
      properties: {
        id: idSchema, durationMs: { type: 'integer', minimum: 0 },
        mappingId: idSchema, score: { type: 'number' },
        issues: { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 500 } },
      },
    },
    after: {
      type: 'object', additionalProperties: false,
      required: ['id', 'durationMs', 'score', 'issues'],
      properties: {
        id: idSchema, durationMs: { type: 'integer', minimum: 0 },
        mappingId: idSchema, score: { type: 'number' },
        issues: { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 500 } },
      },
    },
    mode: { enum: ['toggle', 'split', 'overlay'] },
    synchronized: { type: 'boolean' },
    playheadMapping: { enum: ['shared', 'independent'] },
    durationDeltaMs: { type: 'integer' },
    scoreDelta: { type: 'number' },
    issuesAdded: { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 500 } },
    issuesResolved: { type: 'array', maxItems: 1000, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 500 } },
    semanticChanges: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: false,
        required: ['category', 'target', 'summary'],
        properties: {
          category: { enum: ['timeline', 'source', 'visual', 'composition', 'subtitle', 'duration'] },
          target: idSchema,
          summary: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
    actions: {
      type: 'array', minItems: 3, maxItems: 3,
      prefixItems: [{ const: 'accept' }, { const: 'reopen' }, { const: 'restore' }],
      items: false,
    },
    versionsPreserved: { const: true },
  },
}
const proxyQualityIssueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'severity', 'category', 'message', 'correctable'],
  properties: {
    code: { type: 'string', minLength: 1, maxLength: 80 },
    severity: { enum: ['hard', 'warning'] },
    category: { enum: ['technical', 'policy', 'integrity', 'editorial'] },
    message: { type: 'string', minLength: 1, maxLength: 1000 },
    rangeMs: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      prefixItems: [
        { type: 'integer', minimum: 0 },
        { type: 'integer', minimum: 0 },
      ],
      items: false,
    },
    targetId: idSchema,
    correctable: { type: 'boolean' },
  },
}
const proxyReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'projectId', 'projectVersionId', 'operationId', 'proxyArtifactId',
    'proxyManifestId', 'inputHash', 'rangeCacheKey', 'spec', 'status',
    'technicalIssues', 'criticIssues', 'warningsAcknowledged', 'finalAllowed',
    'uploadReceivedAt', 'renderCompletedAt', 'timeToFirstProxyMs', 'reviewHash',
    'revision', 'createdAt', 'updatedAt',
  ],
  properties: {
    id: idSchema,
    projectId: idSchema,
    projectVersionId: idSchema,
    operationId: idSchema,
    proxyArtifactId: idSchema,
    proxyManifestId: idSchema,
    inputHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    rangeCacheKey: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    spec: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height', 'codec', 'container', 'quality', 'reusableRanges'],
      properties: {
        width: { type: 'integer', minimum: 2, maximum: 8192 },
        height: { type: 'integer', minimum: 2, maximum: 8192 },
        codec: { const: 'h264' },
        container: { const: 'mp4' },
        quality: { const: 'review' },
        reusableRanges: { const: true },
      },
    },
    status: { enum: ['blocked', 'warning-ack-required', 'ready-for-final'] },
    technicalIssues: { type: 'array', maxItems: 1000, items: proxyQualityIssueSchema },
    criticIssues: { type: 'array', maxItems: 1000, items: proxyQualityIssueSchema },
    warningsAcknowledged: { type: 'boolean' },
    finalAllowed: { type: 'boolean' },
    uploadReceivedAt: dateTimeSchema,
    renderCompletedAt: dateTimeSchema,
    timeToFirstProxyMs: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    reviewHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    revision: { type: 'integer', minimum: 1 },
    acknowledgedBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id', 'at'],
      properties: {
        type: { const: 'api-client' },
        id: idSchema,
        at: dateTimeSchema,
      },
    },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
}
const assetBriefSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['intention', 'content', 'style', 'durationMs', 'entry', 'exit', 'prohibited'],
  properties: {
    intention: { type: 'string', minLength: 1, maxLength: 500 },
    content: {
      type: 'array', minItems: 1, maxItems: 32, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    style: {
      type: 'array', minItems: 1, maxItems: 24, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    durationMs: {
      type: 'object', additionalProperties: false, required: ['min', 'max'],
      properties: {
        min: { type: 'integer', minimum: 100, maximum: 120000 },
        max: { type: 'integer', minimum: 100, maximum: 120000 },
      },
    },
    entry: { type: 'string', minLength: 1, maxLength: 120 },
    exit: { type: 'string', minLength: 1, maxLength: 120 },
    prohibited: {
      type: 'array', maxItems: 32, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
  },
}
const assetCandidateInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'artifactId', 'source', 'content', 'style', 'durationMs',
    'quality', 'continuity', 'novelty', 'literalness',
  ],
  properties: {
    artifactId: idSchema,
    source: { enum: ['library', 'stock', 'generated'] },
    content: {
      type: 'array', minItems: 1, maxItems: 64, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    style: {
      type: 'array', minItems: 1, maxItems: 32, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    durationMs: { type: 'integer', minimum: 100, maximum: 120000 },
    quality: { type: 'number', minimum: 0, maximum: 1 },
    continuity: { type: 'number', minimum: 0, maximum: 1 },
    novelty: { type: 'number', minimum: 0, maximum: 1 },
    literalness: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const assetSelectionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'projectId', 'projectVersionId', 'projectVersionHash',
    'brief', 'briefHash', 'candidates', 'candidatesHash', 'rightsEvidence',
    'decision', 'selectedArtifactId', 'selectedSource', 'evaluations',
    'searchStoppedBefore', 'auditId', 'selectionHash', 'createdBy', 'createdAt',
  ],
  properties: {
    schemaVersion: { const: 'asset-selection/v1' },
    id: idSchema,
    projectId: idSchema,
    projectVersionId: idSchema,
    projectVersionHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    brief: assetBriefSchema,
    briefHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    candidates: {
      type: 'array', maxItems: 100,
      items: {
        ...assetCandidateInputSchema,
        required: [...assetCandidateInputSchema.required, 'rights'],
        properties: {
          ...assetCandidateInputSchema.properties,
          rights: { enum: ['approved', 'unknown', 'denied'] },
        },
      },
    },
    candidatesHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    rightsEvidence: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: false,
        required: ['artifactId', 'artifactSha256', 'outcome', 'reasonCodes'],
        properties: {
          artifactId: idSchema,
          artifactSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          outcome: { enum: ['allow', 'deny'] },
          reasonCodes: {
            type: 'array', maxItems: 64, uniqueItems: true,
            items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,79}$' },
          },
          rightsSnapshotId: idSchema,
          rightsSnapshotHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
          validUntil: dateTimeSchema,
        },
      },
    },
    decision: { enum: ['use_asset', 'no_insert'] },
    selectedArtifactId: { oneOf: [idSchema, { type: 'null' }] },
    selectedSource: {
      oneOf: [{ enum: ['library', 'stock', 'generated'] }, { type: 'null' }],
    },
    evaluations: {
      type: 'array', maxItems: 100,
      items: {
        type: 'object', additionalProperties: false,
        required: ['candidateId', 'source', 'score', 'verdict', 'reasons', 'dimensions'],
        properties: {
          candidateId: idSchema,
          source: { enum: ['library', 'stock', 'generated'] },
          score: { type: 'number', minimum: 0, maximum: 1 },
          verdict: { enum: ['accepted', 'rejected'] },
          reasons: {
            type: 'array', maxItems: 16, uniqueItems: true,
            items: { type: 'string', minLength: 1, maxLength: 80 },
          },
          dimensions: {
            type: 'object', additionalProperties: false,
            required: ['relevance', 'continuity', 'quality', 'rights', 'novelty', 'literalness'],
            properties: Object.fromEntries(
              ['relevance', 'continuity', 'quality', 'rights', 'novelty', 'literalness']
                .map((dimension) => [dimension, { type: 'number', minimum: 0, maximum: 1 }]),
            ),
          },
        },
      },
    },
    searchStoppedBefore: {
      type: 'array', maxItems: 2, uniqueItems: true,
      items: { enum: ['library', 'stock', 'generated'] },
    },
    auditId: { type: 'string', pattern: '^asset_selection_[a-f0-9]{64}$' },
    selectionHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    createdBy: {
      type: 'object', additionalProperties: false, required: ['type', 'id'],
      properties: { type: { const: 'api-client' }, id: idSchema },
    },
    createdAt: dateTimeSchema,
  },
}
const qualitySha256Schema = { type: 'string', pattern: '^[a-f0-9]{64}$' }
const qualityIssueSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'severity', 'category', 'message', 'correctable'],
  properties: {
    code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,79}$' },
    severity: { enum: ['hard', 'warning'] },
    category: {
      enum: ['technical', 'policy', 'integrity', 'asset', 'editorial'],
    },
    message: { type: 'string', minLength: 1, maxLength: 500 },
    rangeMs: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      prefixItems: [
        { type: 'integer', minimum: 0 },
        { type: 'integer', minimum: 1 },
      ],
      items: false,
    },
    targetId: idSchema,
    correctable: { type: 'boolean' },
  },
}
const qualityRubricEvidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['criterionId', 'score', 'evidence'],
  properties: {
    criterionId: {
      enum: [
        'hook-clarity', 'problem-recognition', 'trust-building', 'offer-clarity',
        'proof-strength', 'cta-clarity', 'friction-reduction',
        'narrative-integrity', 'legibility', 'rights-compliance',
      ],
    },
    score: { type: 'number', minimum: 0, maximum: 100 },
    evidence: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 500 },
    },
  },
}
const qualityRangeMetricSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['startMs', 'endMs', 'density'],
  properties: {
    startMs: { type: 'integer', minimum: 0 },
    endMs: { type: 'integer', minimum: 1 },
    density: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const qualityIterationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'projectId', 'projectVersionId',
    'projectVersionHash', 'iteration', 'previousIterationId', 'proxyEvidence',
    'assetPlacements', 'rubric', 'rangeMetrics', 'dataset', 'score',
    'regression', 'regressed', 'validation', 'issues', 'patches',
    'minimalRerenderRangesMs', 'fullRerenderRequired', 'budget', 'decision',
    'reportFingerprint', 'recordHash', 'createdBy', 'createdAt',
  ],
  properties: {
    schemaVersion: { const: 'quality-iteration/v1' },
    id: idSchema,
    projectId: idSchema,
    projectVersionId: idSchema,
    projectVersionHash: qualitySha256Schema,
    iteration: { type: 'integer', minimum: 1 },
    previousIterationId: { oneOf: [idSchema, { type: 'null' }] },
    proxyEvidence: {
      type: 'object',
      additionalProperties: false,
      required: [
        'id', 'reviewHash', 'revision', 'status', 'finalAllowed', 'spec',
        'technicalIssues', 'criticIssues',
      ],
      properties: {
        id: idSchema,
        reviewHash: qualitySha256Schema,
        revision: { type: 'integer', minimum: 1 },
        status: { enum: ['blocked', 'warning-ack-required', 'ready-for-final'] },
        finalAllowed: { type: 'boolean' },
        spec: {
          type: 'object',
          additionalProperties: false,
          required: ['width', 'height', 'codec', 'container', 'quality', 'reusableRanges'],
          properties: {
            width: { type: 'integer', minimum: 2, maximum: 8192 },
            height: { type: 'integer', minimum: 2, maximum: 8192 },
            codec: { const: 'h264' },
            container: { const: 'mp4' },
            quality: { const: 'review' },
            reusableRanges: { const: true },
          },
        },
        technicalIssues: {
          type: 'array', maxItems: 500, items: qualityIssueSchema,
        },
        criticIssues: {
          type: 'array', maxItems: 500, items: qualityIssueSchema,
        },
      },
    },
    assetPlacements: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'selectionId', 'selectionHash', 'rangeMs', 'selectedArtifactId',
          'selectedSource', 'relevance', 'continuity', 'quality', 'novelty',
          'rightsApproved', 'rightsReasonCodes',
        ],
        properties: {
          selectionId: idSchema,
          selectionHash: qualitySha256Schema,
          rangeMs: qualityIssueSchema.properties.rangeMs,
          selectedArtifactId: idSchema,
          selectedSource: { enum: ['library', 'stock', 'generated'] },
          relevance: { type: 'number', minimum: 0, maximum: 1 },
          continuity: { type: 'number', minimum: 0, maximum: 1 },
          quality: { type: 'number', minimum: 0, maximum: 1 },
          novelty: { type: 'number', minimum: 0, maximum: 1 },
          rightsApproved: { type: 'boolean' },
          rightsReasonCodes: {
            type: 'array',
            maxItems: 64,
            uniqueItems: true,
            items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,79}$' },
          },
          rightsSnapshotId: idSchema,
          rightsSnapshotHash: qualitySha256Schema,
        },
      },
    },
    rubric: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'objective', 'threshold', 'evidence'],
      properties: {
        id: idSchema,
        version: { type: 'integer', minimum: 1 },
        objective: {
          enum: [
            'discovery', 'awareness', 'warming', 'lead-generation', 'sale',
            'whatsapp', 'booking', 'download',
          ],
        },
        threshold: { type: 'number', minimum: 0, maximum: 100 },
        evidence: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: qualityRubricEvidenceSchema,
        },
      },
    },
    rangeMetrics: {
      type: 'array', maxItems: 200, items: qualityRangeMetricSchema,
    },
    dataset: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'baselineScore', 'fingerprint'],
      properties: {
        id: idSchema,
        version: { type: 'integer', minimum: 1 },
        baselineScore: { type: 'number', minimum: 0, maximum: 100 },
        fingerprint: qualitySha256Schema,
      },
    },
    score: { type: 'number', minimum: 0, maximum: 100 },
    regression: { type: 'number', minimum: -100, maximum: 100 },
    regressed: { type: 'boolean' },
    validation: {
      type: 'object',
      additionalProperties: false,
      required: [
        'valid', 'finalBlocked', 'hardIssueCount', 'warningIssueCount',
        'hardByCategory',
      ],
      properties: {
        valid: { type: 'boolean' },
        finalBlocked: { type: 'boolean' },
        hardIssueCount: { type: 'integer', minimum: 0, maximum: 500 },
        warningIssueCount: { type: 'integer', minimum: 0, maximum: 500 },
        hardByCategory: {
          type: 'object',
          additionalProperties: false,
          required: ['technical', 'policy', 'integrity', 'asset', 'editorial'],
          properties: Object.fromEntries(
            ['technical', 'policy', 'integrity', 'asset', 'editorial']
              .map((category) => [
                category,
                { type: 'integer', minimum: 0, maximum: 500 },
              ]),
          ),
        },
      },
    },
    issues: { type: 'array', maxItems: 500, items: qualityIssueSchema },
    patches: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'targetId', 'issueCode'],
        properties: {
          type: { enum: ['replace_asset', 'adjust'] },
          targetId: idSchema,
          issueCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,79}$' },
          rangeMs: qualityIssueSchema.properties.rangeMs,
        },
      },
    },
    minimalRerenderRangesMs: {
      type: 'array',
      maxItems: 500,
      items: qualityIssueSchema.properties.rangeMs,
    },
    fullRerenderRequired: { type: 'boolean' },
    budget: {
      type: 'object',
      additionalProperties: false,
      required: ['limitUnits', 'consumedUnits', 'remainingUnits', 'iterationCostUnits'],
      properties: {
        limitUnits: { type: 'integer', minimum: 1, maximum: 1000 },
        consumedUnits: { type: 'integer', minimum: 0, maximum: 1000 },
        remainingUnits: { type: 'integer', minimum: 0, maximum: 1000 },
        iterationCostUnits: { type: 'integer', minimum: 0, maximum: 1002 },
      },
    },
    decision: {
      type: 'object',
      additionalProperties: false,
      required: ['continue', 'terminalReason'],
      properties: {
        continue: { type: 'boolean' },
        terminalReason: {
          oneOf: [
            {
              enum: [
                'approval', 'convergence', 'budget', 'uncorrectable',
                'human_review',
              ],
            },
            { type: 'null' },
          ],
        },
      },
    },
    reportFingerprint: qualitySha256Schema,
    recordHash: qualitySha256Schema,
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: { type: { const: 'api-client' }, id: idSchema },
    },
    createdAt: dateTimeSchema,
  },
}
const apiMetaSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['apiVersion'],
  properties: { apiVersion: { const: 'v1' } },
}

const publicEventResourceTypes = [...new Set(
  PUBLIC_EVENT_CATALOG.map((descriptor) => descriptor.resourceType),
)]
const publicEventTypes = PUBLIC_EVENT_CATALOG.map((descriptor) => descriptor.type)

const publicEventSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'version', 'workspaceId', 'occurredAt', 'resource', 'data'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    type: { type: 'string', enum: publicEventTypes },
    version: { const: '1.0.0' },
    workspaceId: idSchema,
    occurredAt: dateTimeSchema,
    sequence: { type: 'integer', minimum: 1 },
    actor: {
      type: 'object',
      additionalProperties: false,
      minProperties: 1,
      properties: {
        clientId: idSchema,
        userId: idSchema,
      },
    },
    resource: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', enum: publicEventResourceTypes },
        id: idSchema,
      },
    },
    data: {
      type: 'object',
      maxProperties: 1024,
      additionalProperties: true,
    },
  },
}

function successSchema(data: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'meta'],
    properties: { data, meta: apiMetaSchema },
  }
}

const projectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'workspaceId', 'name', 'status', 'createdAt'],
  properties: {
    id: idSchema,
    workspaceId: idSchema,
    name: { type: 'string', minLength: 2, maxLength: 120 },
    status: { type: 'string' },
    currentVersionId: idSchema,
    createdAt: dateTimeSchema,
  },
}

const searchableProjectSchema = {
  ...projectSchema,
  properties: {
    ...projectSchema.properties,
    objective: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$' },
    format: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
    locale: { type: 'string', minLength: 2, maxLength: 35 },
    ownerId: idSchema,
  },
}

const renderElementSchema = {
  type: 'object', additionalProperties: false,
  required: ['elementId', 'type', 'clipId', 'sceneId', 'sourceId', 'frame', 'bounds', 'zIndex', 'opacity', 'priority'],
  properties: {
    elementId: idSchema,
    type: { enum: ['background', 'presenter', 'subtitle', 'b-roll', 'cta', 'transformation'] },
    clipId: idSchema,
    sceneId: idSchema,
    sourceId: idSchema,
    frame: { type: 'integer', minimum: 0 },
    bounds: {
      type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'],
      properties: {
        x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
        width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    zIndex: { type: 'integer' },
    opacity: { type: 'number', minimum: 0, maximum: 1 },
    priority: { type: 'integer' },
  },
}

const normalizedReviewRegionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    width: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
    height: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
  },
}

const reviewAnnotationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'projectVersionId', 'proxyArtifactId', 'proxyHash', 'frame', 'timeRangeMs',
    'screenshotRef', 'scope', 'targetIds', 'text', 'author', 'status', 'createdAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    projectVersionId: idSchema,
    proxyArtifactId: idSchema,
    proxyHash: sha256Schema,
    frame: { type: 'integer', minimum: 0 },
    timeRangeMs: {
      type: 'array', minItems: 2, maxItems: 2,
      prefixItems: [{ type: 'integer', minimum: 0 }, { type: 'integer', minimum: 0 }],
      items: false,
    },
    screenshotRef: { type: 'string', minLength: 32, maxLength: 750000, pattern: '^data:image/(?:jpeg|png);base64,' },
    scope: { enum: ['point', 'region', 'scene'] },
    region: normalizedReviewRegionSchema,
    targetIds: { type: 'array', maxItems: 20, uniqueItems: true, items: idSchema },
    text: { type: 'string', minLength: 1, maxLength: 4000 },
    author: {
      type: 'object', additionalProperties: false, required: ['id', 'name', 'type'],
      properties: { id: idSchema, name: { type: 'string', minLength: 1, maxLength: 120 }, type: { enum: ['user', 'api-client'] } },
    },
    status: { enum: ['open', 'applied', 'dismissed'] },
    createdAt: dateTimeSchema,
  },
}

const reviewApplicationScopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'targetIds', 'formatIds', 'localeIds', 'recipeIds', 'global'],
  properties: {
    kind: { enum: ['frame', 'region', 'clip', 'scene', 'range', 'project', 'formats', 'locales', 'recipes'] },
    targetIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: idSchema },
    formatIds: { type: 'array', maxItems: 20, uniqueItems: true, items: idSchema },
    localeIds: { type: 'array', maxItems: 100, uniqueItems: true, items: idSchema },
    recipeIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: idSchema },
    global: { type: 'boolean' },
  },
}

const reviewAnnotationSchemaV2 = {
  ...reviewAnnotationSchema,
  required: [...reviewAnnotationSchema.required, 'applicationScope', 'affectedCount'],
  properties: {
    ...reviewAnnotationSchema.properties,
    applicationScope: reviewApplicationScopeSchema,
    affectedCount: { type: 'integer', minimum: 1 },
  },
}

const reviewSessionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['projectVersionId', 'proxyArtifactId', 'proxyUrl', 'proxyHash', 'fps', 'resolution', 'durationFrames', 'stale'],
  properties: {
    projectVersionId: idSchema,
    proxyArtifactId: idSchema,
    proxyUrl: { type: 'string', pattern: '^/v1/artifacts/.+/content$' },
    proxyHash: sha256Schema,
    fps: { type: 'number', exclusiveMinimum: 0, maximum: 120 },
    resolution: {
      type: 'object', additionalProperties: false, required: ['width', 'height'],
      properties: { width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 } },
    },
    durationFrames: { type: 'integer', minimum: 1 },
    stale: { type: 'boolean' },
  },
}

const reviewSessionSchemaV2 = {
  ...reviewSessionSchema,
  required: [...reviewSessionSchema.required, 'currentProjectVersionId'],
  properties: { ...reviewSessionSchema.properties, currentProjectVersionId: idSchema },
}

const reviewVersionSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'sequence', 'createdAt', 'current', 'previewAvailable'],
  properties: {
    id: idSchema,
    sequence: { type: 'integer', minimum: 1 },
    createdAt: dateTimeSchema,
    current: { type: 'boolean' },
    previewAvailable: { type: 'boolean' },
  },
}

const reviewScopeContextSchema = {
  type: 'object', additionalProperties: false,
  required: ['formatId', 'localeId', 'recipeIds', 'options'],
  properties: {
    formatId: idSchema,
    localeId: idSchema,
    recipeIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: idSchema },
    options: {
      type: 'array', minItems: 9, maxItems: 9,
      items: {
        type: 'object', additionalProperties: false, required: ['kind', 'affectedCount', 'enabled'],
        properties: {
          kind: reviewApplicationScopeSchema.properties.kind,
          affectedCount: { type: 'integer', minimum: 0 },
          enabled: { type: 'boolean' },
        },
      },
    },
  },
}

const reviewSceneSchema = {
  type: 'object', additionalProperties: false, required: ['id', 'label', 'startFrame', 'endFrame'],
  properties: {
    id: idSchema,
    label: { type: 'string', minLength: 1, maxLength: 120 },
    startFrame: { type: 'integer', minimum: 0 },
    endFrame: { type: 'integer', minimum: 1 },
  },
}

const patchRangeSchema = {
  type: 'array', minItems: 2, maxItems: 2,
  prefixItems: [{ type: 'integer', minimum: 0 }, { type: 'integer', minimum: 0 }],
  items: false,
}

const patchOperationSchema = {
  type: 'object', additionalProperties: false,
  required: ['op', 'targetId', 'value'],
  properties: {
    op: { enum: ['trim', 'replace-asset', 'update-text', 'update-layout', 'update-subtitle', 'move'] },
    targetId: idSchema,
    value: { type: 'object' },
    rangeMs: patchRangeSchema,
    choiceId: { type: 'string', minLength: 3, maxLength: 128 },
  },
}

const patchProposalSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'workspaceId', 'projectId', 'annotationId', 'baseVersionId', 'status', 'interpretationVersion', 'choices', 'patch', 'impact', 'gates', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    workspaceId: idSchema,
    projectId: idSchema,
    annotationId: { type: 'string', format: 'uuid' },
    baseVersionId: idSchema,
    status: { enum: ['ready', 'ambiguous', 'prohibited', 'budget-blocked', 'applied'] },
    interpretationVersion: { type: 'string', minLength: 3, maxLength: 256 },
    choices: { type: 'array', maxItems: 12, items: patchOperationSchema },
    patch: {
      anyOf: [{ type: 'null' }, {
        type: 'object', additionalProperties: false,
        required: ['id', 'baseVersionId', 'operations', 'annotationIds', 'estimatedCost', 'invalidatedRanges'],
        properties: {
          id: idSchema, baseVersionId: idSchema,
          operations: { type: 'array', minItems: 1, maxItems: 50, items: patchOperationSchema },
          annotationIds: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
          estimatedCost: { type: 'integer', minimum: 0 },
          invalidatedRanges: { type: 'array', maxItems: 50, items: patchRangeSchema },
        },
      }],
    },
    impact: {
      anyOf: [{ type: 'null' }, {
        type: 'object', additionalProperties: false,
        required: ['operationCount', 'cost', 'invalidatedRanges', 'changedTargets', 'expectedScoreDelta', 'invalidatedArtifacts'],
        properties: {
          operationCount: { type: 'integer', minimum: 1 }, cost: { type: 'integer', minimum: 0 },
          invalidatedRanges: { type: 'array', maxItems: 50, items: patchRangeSchema },
          changedTargets: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: idSchema },
          expectedScoreDelta: { type: 'number' },
          invalidatedArtifacts: { type: 'array', maxItems: 20, uniqueItems: true, items: { enum: ['proxy', 'final'] } },
        },
      }],
    },
    gates: {
      type: 'array', minItems: 4, maxItems: 4,
      items: {
        type: 'object', additionalProperties: false, required: ['gate', 'passed', 'message', 'targetIds'],
        properties: {
          gate: { enum: ['ambiguity', 'protected-elements', 'policy', 'budget'] }, passed: { type: 'boolean' },
          code: { enum: ['AMBIGUOUS_INTENT', 'PROTECTED_TARGET', 'POLICY_DENIED', 'BUDGET_EXCEEDED'] },
          message: { type: 'string', minLength: 1, maxLength: 500 }, targetIds: { type: 'array', maxItems: 50, uniqueItems: true, items: idSchema },
        },
      },
    },
    resultCommandId: idSchema,
    resultVersionId: idSchema,
    renderOperationId: idSchema,
    comparison: {
      type: 'object', additionalProperties: false,
      required: ['beforeVersionId', 'afterVersionId', 'beforeEditPlanHash', 'afterEditPlanHash', 'changedTargets', 'invalidatedRanges'],
      properties: {
        beforeVersionId: idSchema, afterVersionId: idSchema, beforeEditPlanHash: sha256Schema, afterEditPlanHash: sha256Schema,
        changedTargets: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: idSchema },
        invalidatedRanges: { type: 'array', maxItems: 50, items: patchRangeSchema },
      },
    },
    render: {
      type: 'object', additionalProperties: false, required: ['operationId', 'status', 'phase'],
      properties: {
        operationId: idSchema, status: { type: 'string' }, phase: { type: 'string' },
        error: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } },
      },
    },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
}

const patchBatchSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'workspaceId', 'projectId', 'baseVersionId', 'mode', 'status', 'patch', 'impact', 'conflicts', 'items', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    workspaceId: idSchema,
    projectId: idSchema,
    baseVersionId: idSchema,
    mode: { enum: ['all-or-nothing', 'partial-retry'] },
    status: { enum: ['ready', 'conflict', 'partial', 'applied'] },
    patch: patchProposalSchema.properties.patch,
    impact: patchProposalSchema.properties.impact,
    conflicts: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
    items: {
      type: 'array', minItems: 2, maxItems: 100,
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'annotationId', 'proposalId', 'status', 'operation', 'conflictIds', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          annotationId: { type: 'string', format: 'uuid' },
          proposalId: { type: 'string', format: 'uuid' },
          status: { enum: ['included', 'rolled-back', 'retryable', 'applied'] },
          operation: { anyOf: [{ type: 'null' }, patchOperationSchema] },
          conflictIds: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
          reasonCode: { enum: ['ATOMIC_CONFLICT', 'TARGET_CONFLICT'] },
          createdAt: dateTimeSchema,
          updatedAt: dateTimeSchema,
        },
      },
    },
    resultCommandId: idSchema,
    resultVersionId: idSchema,
    renderOperationId: idSchema,
    comparison: patchProposalSchema.properties.comparison,
    render: patchProposalSchema.properties.render,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
  },
}

const apiClientSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'workspaceId', 'name', 'status', 'environment', 'scopes', 'createdAt'],
  properties: {
    id: idSchema,
    workspaceId: idSchema,
    name: { type: 'string', minLength: 2, maxLength: 120 },
    status: { enum: ['active', 'suspended', 'revoked'] },
    environment: { enum: ['sandbox', 'production'] },
    scopes: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z-]+:[a-z-]+$' },
    },
    createdAt: dateTimeSchema,
    lastUsedAt: dateTimeSchema,
  },
}

const apiCredentialSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'clientId', 'status', 'createdAt'],
  properties: {
    id: idSchema,
    clientId: idSchema,
    status: { enum: ['active', 'revoked'] },
    createdAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
    lastUsedAt: dateTimeSchema,
    revokedAt: dateTimeSchema,
  },
}

const artifactSourceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['artifactId', 'artifactKey', 'sha256', 'role', 'ordinal'],
  properties: {
    artifactId: idSchema,
    artifactKey: { type: 'string', minLength: 1, maxLength: 512 },
    sha256: sha256Schema,
    role: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
    ordinal: { type: 'integer', minimum: 0 },
  },
}

const artifactManifestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'schemaVersion', 'manifestHash', 'recipe', 'sources', 'createdAt'],
  properties: {
    id: idSchema,
    schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
    manifestHash: sha256Schema,
    recipe: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'parametersHash'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        parametersHash: sha256Schema,
      },
    },
    probe: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height', 'duration', 'fps'],
      properties: {
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
        duration: { type: 'number', exclusiveMinimum: 0 },
        fps: { type: 'number', exclusiveMinimum: 0 },
      },
    },
    sources: { type: 'array', items: artifactSourceSchema },
    createdAt: dateTimeSchema,
  },
}

const lineageDiagnosticManifestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'manifestHash', 'schemaVersion', 'recipe'],
  properties: {
    id: idSchema,
    manifestHash: sha256Schema,
    schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
    recipe: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'parametersHash'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        parametersHash: sha256Schema,
      },
    },
  },
}

const executionProvenanceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['tool'],
  properties: {
    tool: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'version', 'digest'],
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        digest: sha256Schema,
      },
    },
    model: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'id', 'version', 'configHash'],
      properties: {
        provider: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
        configHash: sha256Schema,
      },
    },
  },
}

const renderTokenSchema = {
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9._-]{0,127}$',
}
const renderIdentitySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'digest'],
  properties: {
    id: renderTokenSchema,
    version: renderTokenSchema,
    digest: sha256Schema,
  },
}
const renderPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'versionId', 'hash'],
  properties: {
    id: renderTokenSchema,
    versionId: renderTokenSchema,
    hash: sha256Schema,
  },
}
const renderOutputRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'locale', 'aspectRatio', 'width', 'height', 'fps',
    'safeArea', 'durationInFrames',
  ],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 128 },
    locale: {
      type: 'string',
      pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
    },
    aspectRatio: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
    width: { type: 'integer', minimum: 2, multipleOf: 2 },
    height: { type: 'integer', minimum: 2, multipleOf: 2 },
    fps: { type: 'integer', minimum: 1, maximum: 120 },
    safeArea: {
      type: 'object',
      additionalProperties: false,
      required: ['top', 'right', 'bottom', 'left'],
      properties: {
        top: { type: 'number', minimum: 0, exclusiveMaximum: 0.5 },
        right: { type: 'number', minimum: 0, exclusiveMaximum: 0.5 },
        bottom: { type: 'number', minimum: 0, exclusiveMaximum: 0.5 },
        left: { type: 'number', minimum: 0, exclusiveMaximum: 0.5 },
      },
    },
    deliveryProfileId: { type: 'string', minLength: 1, maxLength: 128 },
    durationInFrames: {
      type: 'integer',
      minimum: 1,
      maximum: 5184000,
    },
  },
}

const publicOperationTargetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'id', 'manifestId'],
  properties: {
    type: { const: 'media-artifact' },
    id: idSchema,
    manifestId: idSchema,
  },
}

const publicOperationTargetSchemaV2 = {
  oneOf: [
    publicOperationTargetSchema,
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { const: 'project-version' },
        id: idSchema,
      },
    },
  ],
}

const publicOperationTargetSchemaV3 = {
  oneOf: [
    ...publicOperationTargetSchemaV2.oneOf,
    {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id', 'batchId'],
      properties: {
        type: { const: 'production-batch-item' },
        id: idSchema,
        batchId: idSchema,
      },
    },
  ],
}

const apiClientV2Schema = {
  ...apiClientSchema,
  required: [
    ...apiClientSchema.required,
    'type',
    'allowedEnvironments',
    'scopeGrants',
    'createdBy',
  ],
  properties: {
    ...apiClientSchema.properties,
    type: {
      enum: ['service-account', 'oauth-application', 'personal-development'],
    },
    allowedEnvironments: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { enum: ['sandbox', 'production'] },
    },
    scopeGrants: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z-]+:[a-z-]+$' },
    },
    createdBy: { type: 'string', pattern: '^[A-Za-z0-9:_-]{3,128}$' },
  },
}

const apiAccessControlSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'workspaceId', 'targetType', 'targetId', 'status', 'killSwitchEngaged', 'revision'],
  properties: {
    schemaVersion: { const: 1 },
    workspaceId: idSchema,
    targetType: { enum: ['client', 'workspace'] },
    targetId: idSchema,
    status: { enum: ['active', 'suspended', 'revoked'] },
    killSwitchEngaged: { type: 'boolean' },
    revision: sha256Schema,
  },
} as const

const apiAccessCommandSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'workspaceId', 'targetType', 'targetId', 'action',
    'baseRevision', 'resultRevision', 'previousStatus', 'resultStatus',
    'previousKillSwitchEngaged', 'resultKillSwitchEngaged', 'reason',
    'actorClientId', 'idempotencyKey', 'requestFingerprint', 'changedAt',
  ],
  properties: {
    schemaVersion: { const: 1 }, id: idSchema, workspaceId: idSchema,
    targetType: { enum: ['client', 'workspace'] }, targetId: idSchema,
    action: { enum: ['activate', 'suspend', 'revoke', 'engage-kill-switch', 'release-kill-switch'] },
    baseRevision: sha256Schema, resultRevision: sha256Schema,
    previousStatus: { enum: ['active', 'suspended', 'revoked'] },
    resultStatus: { enum: ['active', 'suspended', 'revoked'] },
    previousKillSwitchEngaged: { type: 'boolean' }, resultKillSwitchEngaged: { type: 'boolean' },
    reason: { type: 'string', minLength: 3, maxLength: 500 }, actorClientId: idSchema,
    delegatedUserId: idSchema, idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
    requestFingerprint: sha256Schema, changedAt: dateTimeSchema,
  },
} as const

const apiAccessChangeRequestSchema = {
  type: 'object', additionalProperties: false,
  required: ['action', 'baseRevision', 'reason', 'confirmed'],
  properties: {
    action: { enum: ['activate', 'suspend', 'revoke', 'engage-kill-switch', 'release-kill-switch'] },
    baseRevision: sha256Schema,
    reason: { type: 'string', minLength: 3, maxLength: 500 },
    confirmed: { const: true },
  },
} as const

const apiAccessReadResponseSchema = successSchema({
  type: 'object', additionalProperties: false, required: ['access'],
  properties: { access: apiAccessControlSchema },
})

const apiAccessChangedResponseSchema = successSchema({
  type: 'object', additionalProperties: false,
  required: ['access', 'command', 'canceledOperationCount', 'replayed'],
  properties: {
    access: apiAccessControlSchema,
    command: apiAccessCommandSchema,
    canceledOperationCount: { type: 'integer', minimum: 0 },
    replayed: { type: 'boolean' },
  },
})

const reviewVersionVisibleStateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'label', 'tone', 'progress', 'primaryAction', 'availableActions', 'terminal'],
  properties: {
    schemaVersion: { const: 'visible-state/v1' },
    label: { enum: ['current', 'superseded'] },
    tone: { enum: ['neutral', 'info'] },
    progress: {
      type: 'object', additionalProperties: false, required: ['mode'],
      properties: { mode: { const: 'none' } },
    },
    primaryAction: { enum: ['open-result', 'open-historical-output', 'inspect-history'] },
    availableActions: {
      type: 'array', minItems: 1, maxItems: 1, uniqueItems: true,
      items: { enum: ['open-result', 'open-historical-output', 'inspect-history'] },
    },
    terminal: { type: 'boolean' },
  },
}

const currentProjectVersionVisibleStateSchema = {
  ...reviewVersionVisibleStateSchema,
  properties: {
    ...reviewVersionVisibleStateSchema.properties,
    label: { const: 'current' },
    tone: { const: 'info' },
    primaryAction: { const: 'open-result' },
    availableActions: { const: ['open-result'] },
    terminal: { const: false },
  },
}

const projectLutSelectionResultSchemaV3 = {
  ...projectLutSelectionResultSchemaV2,
  properties: {
    ...projectLutSelectionResultSchemaV2.properties,
    version: {
      ...projectLutSelectionResultSchema.properties.version,
      required: [
        ...projectLutSelectionResultSchema.properties.version.required,
        'visibleState',
      ],
      properties: {
        ...projectLutSelectionResultSchema.properties.version.properties,
        visibleState: currentProjectVersionVisibleStateSchema,
      },
    },
  },
}

function currentProjectVersionResultSchema(snapshotRefNames: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt', 'visibleState'],
    properties: {
      id: idSchema,
      sequence: { type: 'integer', minimum: 2 },
      parentVersionId: idSchema,
      baseHash: sha256Schema,
      snapshotRefs: {
        type: 'object',
        additionalProperties: false,
        required: [...snapshotRefNames],
        properties: Object.fromEntries(snapshotRefNames.map((name) => [name, idSchema])),
      },
      createdAt: dateTimeSchema,
      visibleState: currentProjectVersionVisibleStateSchema,
    },
  }
}

function appliedProjectCommandSchema(type:
  | 'remove-spoken-content'
  | 'run-director'
  | 'replace-source-transcript'
  | 'apply-review-patch'
  | 'apply-review-patch-batch'
) {
  return {
    type: 'object', additionalProperties: false,
    required: ['id', 'type', 'baseVersionId', 'resultVersionId', 'createdAt'],
    properties: {
      id: idSchema, type: { const: type }, baseVersionId: idSchema,
      resultVersionId: idSchema, createdAt: dateTimeSchema,
    },
  }
}

const reviewVersionSchemaV2 = {
  ...reviewVersionSchema,
  required: [...reviewVersionSchema.required, 'visibleState'],
  properties: { ...reviewVersionSchema.properties, visibleState: reviewVersionVisibleStateSchema },
  oneOf: [
    {
      properties: {
        current: { const: true },
        visibleState: {
          type: 'object',
          properties: {
            label: { const: 'current' }, tone: { const: 'info' },
            primaryAction: { const: 'open-result' }, availableActions: { const: ['open-result'] },
            terminal: { const: false },
          },
        },
      },
      required: ['current', 'visibleState'],
    },
    {
      properties: {
        current: { const: false }, previewAvailable: { const: true },
        visibleState: {
          type: 'object',
          properties: {
            label: { const: 'superseded' }, tone: { const: 'neutral' },
            primaryAction: { const: 'open-historical-output' },
            availableActions: { const: ['open-historical-output'] }, terminal: { const: true },
          },
        },
      },
      required: ['current', 'previewAvailable', 'visibleState'],
    },
    {
      properties: {
        current: { const: false }, previewAvailable: { const: false },
        visibleState: {
          type: 'object',
          properties: {
            label: { const: 'superseded' }, tone: { const: 'neutral' },
            primaryAction: { const: 'inspect-history' },
            availableActions: { const: ['inspect-history'] }, terminal: { const: true },
          },
        },
      },
      required: ['current', 'previewAvailable', 'visibleState'],
    },
  ],
}

const visibleStateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'label', 'tone', 'progress', 'primaryAction', 'availableActions', 'terminal'],
  properties: {
    schemaVersion: { const: 'visible-state/v1' },
    label: { enum: ['queued', 'in-progress', 'waiting', 'retry-scheduled', 'completed', 'failed', 'canceled'] },
    tone: { enum: ['neutral', 'info', 'warning', 'danger', 'success'] },
    progress: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { enum: ['not-started', 'determinate', 'indeterminate', 'complete', 'none'] },
        percent: { type: 'integer', minimum: 0, maximum: 100 },
      },
    },
    primaryAction: { enum: ['view-progress', 'cancel', 'resolve-dependency', 'open-result', 'inspect-error', 'retry'] },
    availableActions: {
      type: 'array', minItems: 1, maxItems: 6, uniqueItems: true,
      items: { enum: ['view-progress', 'cancel', 'resolve-dependency', 'open-result', 'inspect-error', 'retry'] },
    },
    terminal: { type: 'boolean' },
  },
}

const productionBatchVisibleStateSchema = {
  ...visibleStateSchema,
  properties: {
    ...visibleStateSchema.properties,
    label: { enum: [
      'queued', 'in-progress', 'completed', 'failed', 'canceled',
      'review-required', 'partially-completed', 'partially-failed',
      'superseded',
    ] },
    primaryAction: { enum: [
      'view-progress', 'cancel', 'open-result', 'inspect-error', 'retry',
      'review-output', 'open-results', 'retry-failed', 'inspect-history',
    ] },
    availableActions: {
      type: 'array', minItems: 1, maxItems: 9, uniqueItems: true,
      items: { enum: [
        'view-progress', 'cancel', 'open-result', 'inspect-error', 'retry',
        'review-output', 'open-results', 'retry-failed', 'inspect-history',
      ] },
    },
  },
}

const productionBatchItemSchemaV2 = {
  ...productionBatchItemSchema,
  required: [...productionBatchItemSchema.required, 'visibleState'],
  properties: {
    ...productionBatchItemSchema.properties,
    visibleState: productionBatchVisibleStateSchema,
  },
}

const productionBatchSchemaV2 = {
  ...productionBatchSchema,
  required: [...productionBatchSchema.required, 'visibleState'],
  properties: {
    ...productionBatchSchema.properties,
    items: {
      ...productionBatchSchema.properties.items,
      items: productionBatchItemSchemaV2,
    },
    visibleState: productionBatchVisibleStateSchema,
  },
}

const artifactInvalidationVisibleStateSchema = {
  ...visibleStateSchema,
  properties: {
    ...visibleStateSchema.properties,
    label: { const: 'stale-output' },
    tone: { const: 'warning' },
    progress: {
      type: 'object', additionalProperties: false,
      required: ['mode'], properties: { mode: { const: 'none' } },
    },
    primaryAction: { const: 'rebuild-output' },
    availableActions: {
      type: 'array', minItems: 2, maxItems: 2, uniqueItems: true,
      prefixItems: [
        { const: 'rebuild-output' },
        { const: 'open-historical-output' },
      ],
      items: false,
    },
    terminal: { const: false },
  },
}

const commandArtifactInvalidationSchemaV2 = {
  ...commandArtifactInvalidationSchema,
  required: [
    ...commandArtifactInvalidationSchema.required,
    'availabilityEffect',
    'visibleState',
  ],
  properties: {
    ...commandArtifactInvalidationSchema.properties,
    availabilityEffect: { const: 'none' },
    visibleState: artifactInvalidationVisibleStateSchema,
  },
}

const mediaArtifactVisibleStateSchema = {
  ...visibleStateSchema,
  properties: {
    ...visibleStateSchema.properties,
    label: { enum: ['available', 'quarantined', 'deleted'] },
    progress: {
      type: 'object', additionalProperties: false,
      required: ['mode'], properties: { mode: { const: 'none' } },
    },
    primaryAction: { enum: ['open-result', 'inspect-error', 'inspect-history'] },
    availableActions: {
      type: 'array', minItems: 1, maxItems: 1, uniqueItems: true,
      items: { enum: ['open-result', 'inspect-error', 'inspect-history'] },
    },
  },
  oneOf: [
    {
      type: 'object',
      properties: {
        label: { const: 'available' }, tone: { const: 'success' },
        primaryAction: { const: 'open-result' },
        availableActions: {
          type: 'array', minItems: 1, maxItems: 1,
          prefixItems: [{ const: 'open-result' }], items: false,
        },
        terminal: { const: true },
      },
    },
    {
      type: 'object',
      properties: {
        label: { const: 'quarantined' }, tone: { const: 'warning' },
        primaryAction: { const: 'inspect-error' },
        availableActions: {
          type: 'array', minItems: 1, maxItems: 1,
          prefixItems: [{ const: 'inspect-error' }], items: false,
        },
        terminal: { const: false },
      },
    },
    {
      type: 'object',
      properties: {
        label: { const: 'deleted' }, tone: { const: 'neutral' },
        primaryAction: { const: 'inspect-history' },
        availableActions: {
          type: 'array', minItems: 1, maxItems: 1,
          prefixItems: [{ const: 'inspect-history' }], items: false,
        },
        terminal: { const: true },
      },
    },
  ],
}

const mediaArtifactPublicSchemaV3 = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'workspaceId', 'artifactKey', 'sha256', 'byteSize',
    'mediaType', 'container', 'status', 'visibleState', 'createdAt',
  ],
  properties: {
    id: idSchema,
    workspaceId: idSchema,
    artifactKey: { type: 'string', minLength: 1, maxLength: 512 },
    sha256: sha256Schema,
    byteSize: { type: 'string', pattern: '^[1-9][0-9]*$' },
    mediaType: { enum: ['video', 'audio', 'image', 'font', 'data'] },
    container: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
    status: { enum: ['available', 'quarantined', 'deleted'] },
    visibleState: mediaArtifactVisibleStateSchema,
    createdAt: dateTimeSchema,
  },
  allOf: [
    {
      if: { type: 'object', properties: { status: { const: 'available' } } },
      then: { type: 'object', properties: { visibleState: { type: 'object', properties: { label: { const: 'available' } } } } },
    },
    {
      if: { type: 'object', properties: { status: { const: 'quarantined' } } },
      then: { type: 'object', properties: { visibleState: { type: 'object', properties: { label: { const: 'quarantined' } } } } },
    },
    {
      if: { type: 'object', properties: { status: { const: 'deleted' } } },
      then: { type: 'object', properties: { visibleState: { type: 'object', properties: { label: { const: 'deleted' } } } } },
    },
  ],
}

const mediaArtifactPublicSchemaV4 = {
  ...mediaArtifactPublicSchemaV3,
  required: [...mediaArtifactPublicSchemaV3.required, 'lifecycleRevision'],
  properties: {
    ...mediaArtifactPublicSchemaV3.properties,
    lifecycleRevision: { type: 'integer', minimum: 1, maximum: 2147483647 },
  },
}

const mediaArtifactLifecycleTransitionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'artifactId', 'baseRevision', 'resultRevision', 'fromStatus',
    'targetStatus', 'changed', 'reason', 'actorClientId', 'visibleState', 'createdAt',
  ],
  properties: {
    id: idSchema,
    artifactId: idSchema,
    baseRevision: { type: 'integer', minimum: 1, maximum: 2147483647 },
    resultRevision: { type: 'integer', minimum: 1, maximum: 2147483647 },
    fromStatus: { enum: ['available', 'quarantined', 'deleted'] },
    targetStatus: { enum: ['available', 'quarantined', 'deleted'] },
    changed: { type: 'boolean' },
    reason: { type: 'string', minLength: 3, maxLength: 500 },
    actorClientId: idSchema,
    visibleState: mediaArtifactVisibleStateSchema,
    createdAt: dateTimeSchema,
  },
  allOf: [
    {
      if: { type: 'object', properties: { targetStatus: { const: 'available' } } },
      then: { type: 'object', properties: { visibleState: { type: 'object', properties: { label: { const: 'available' } } } } },
    },
    {
      if: { type: 'object', properties: { targetStatus: { const: 'quarantined' } } },
      then: { type: 'object', properties: { visibleState: { type: 'object', properties: { label: { const: 'quarantined' } } } } },
    },
    {
      if: { type: 'object', properties: { targetStatus: { const: 'deleted' } } },
      then: { type: 'object', properties: { visibleState: { type: 'object', properties: { label: { const: 'deleted' } } } } },
    },
  ],
}

const projectStatusValues = [
  'draft', 'ingesting', 'perceiving', 'planning', 'generating',
  'reviewing-assets', 'rendering-proxy', 'reviewing-proxy', 'revising',
  'rendering-final', 'completed', 'failed', 'canceled', 'archived',
] as const

const projectVisibleStateSchema = {
  ...visibleStateSchema,
  properties: {
    ...visibleStateSchema.properties,
    label: { enum: projectStatusValues },
    primaryAction: {
      enum: ['open-result', 'view-progress', 'review-output', 'inspect-error', 'inspect-history'],
    },
    availableActions: {
      type: 'array', minItems: 1, maxItems: 1, uniqueItems: true,
      items: {
        enum: ['open-result', 'view-progress', 'review-output', 'inspect-error', 'inspect-history'],
      },
    },
  },
  oneOf: [
    {
      type: 'object',
      properties: {
        label: { const: 'draft' }, tone: { const: 'neutral' },
        progress: {
          type: 'object',
          properties: { mode: { const: 'not-started' }, percent: { const: 0 } },
          required: ['mode', 'percent'],
        },
        primaryAction: { const: 'open-result' },
        availableActions: { const: ['open-result'] }, terminal: { const: false },
      },
      required: ['label', 'tone', 'progress', 'primaryAction', 'availableActions', 'terminal'],
    },
    {
      type: 'object',
      properties: {
        label: {
          enum: [
            'ingesting', 'perceiving', 'planning', 'generating',
            'rendering-proxy', 'revising', 'rendering-final',
          ],
        },
        tone: { const: 'info' },
        progress: {
          type: 'object', properties: { mode: { const: 'indeterminate' } }, required: ['mode'],
        },
        primaryAction: { const: 'view-progress' },
        availableActions: { const: ['view-progress'] }, terminal: { const: false },
      },
      required: ['label', 'tone', 'progress', 'primaryAction', 'availableActions', 'terminal'],
    },
    {
      type: 'object',
      properties: {
        label: { enum: ['reviewing-assets', 'reviewing-proxy'] }, tone: { const: 'warning' },
        progress: { type: 'object', properties: { mode: { const: 'none' } }, required: ['mode'] },
        primaryAction: { const: 'review-output' },
        availableActions: { const: ['review-output'] }, terminal: { const: false },
      },
      required: ['label', 'tone', 'progress', 'primaryAction', 'availableActions', 'terminal'],
    },
    {
      type: 'object',
      properties: {
        label: { const: 'completed' }, tone: { const: 'success' },
        progress: {
          type: 'object',
          properties: { mode: { const: 'complete' }, percent: { const: 100 } },
          required: ['mode', 'percent'],
        },
        primaryAction: { const: 'open-result' },
        availableActions: { const: ['open-result'] }, terminal: { const: true },
      },
      required: ['label', 'tone', 'progress', 'primaryAction', 'availableActions', 'terminal'],
    },
    {
      type: 'object',
      properties: {
        label: { const: 'failed' }, tone: { const: 'danger' },
        progress: { type: 'object', properties: { mode: { const: 'none' } }, required: ['mode'] },
        primaryAction: { const: 'inspect-error' },
        availableActions: { const: ['inspect-error'] }, terminal: { const: true },
      },
      required: ['label', 'tone', 'progress', 'primaryAction', 'availableActions', 'terminal'],
    },
    {
      type: 'object',
      properties: {
        label: { enum: ['canceled', 'archived'] }, tone: { const: 'neutral' },
        progress: { type: 'object', properties: { mode: { const: 'none' } }, required: ['mode'] },
        primaryAction: { const: 'inspect-history' },
        availableActions: { const: ['inspect-history'] }, terminal: { const: true },
      },
      required: ['label', 'tone', 'progress', 'primaryAction', 'availableActions', 'terminal'],
    },
  ],
}

const searchableProjectSchemaV2 = {
  ...searchableProjectSchema,
  required: [...searchableProjectSchema.required, 'visibleState'],
  properties: {
    ...searchableProjectSchema.properties,
    status: { enum: projectStatusValues },
    visibleState: projectVisibleStateSchema,
  },
  allOf: projectStatusValues.map((status) => ({
    if: { type: 'object', properties: { status: { const: status } } },
    then: {
      type: 'object',
      properties: {
        visibleState: {
          type: 'object',
          properties: { label: { const: status } },
        },
      },
    },
  })),
}

const publicOperationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'type', 'status', 'phase', 'cancelable',
    'retryable', 'target', 'attempt', 'maxAttempts', 'createdAt', 'updatedAt',
  ],
  properties: {
    schemaVersion: { const: 'public-operation/v1' },
    id: idSchema,
    type: { const: 'artifact-render' },
    status: {
      enum: ['queued', 'running', 'waiting', 'retrying', 'succeeded', 'failed', 'canceled'],
    },
    phase: {
      enum: [
        'queued', 'materializing', 'rendering', 'verifying', 'persisting',
        'waiting', 'retrying', 'completed', 'failed', 'canceled',
      ],
    },
    progress: {
      type: 'object',
      additionalProperties: false,
      required: ['completed'],
      properties: {
        completed: { type: 'integer', minimum: 0 },
        total: { type: 'integer', minimum: 1 },
        unit: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
      },
    },
    cancelable: { type: 'boolean' },
    retryable: { type: 'boolean' },
    target: publicOperationTargetSchema,
    result: {
      type: 'object',
      additionalProperties: false,
      required: ['resource'],
      properties: { resource: publicOperationTargetSchema },
    },
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'retryable'],
      properties: {
        code: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
        message: { type: 'string', minLength: 1, maxLength: 500 },
        retryable: { type: 'boolean' },
      },
    },
    attempt: { type: 'integer', minimum: 0 },
    maxAttempts: { type: 'integer', minimum: 1 },
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    startedAt: dateTimeSchema,
    completedAt: dateTimeSchema,
  },
}

const webhookUuidSchema = {
  type: 'string',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
}
const webhookDeliverySummaryRequired = [
  'schemaVersion', 'id', 'endpointId', 'subscriptionId', 'eventId', 'status',
  'attemptCount', 'maxAttempts', 'nextAttemptAt', 'createdAt',
]
const webhookSigningSecretMetadataSchema = {
  type: 'object', additionalProperties: false,
  required: ['version', 'fingerprint', 'status', 'createdAt'],
  properties: {
    version: { type: 'integer', minimum: 1 }, fingerprint: sha256Schema,
    status: { enum: ['active', 'retired', 'revoked'] }, createdAt: dateTimeSchema,
    retiredAt: dateTimeSchema, revokedAt: dateTimeSchema,
  },
}
const webhookEndpointSummaryProperties = {
  schemaVersion: { const: 'webhook-endpoint/v1' }, id: webhookUuidSchema,
  status: { enum: ['pending-verification', 'active', 'suspended', 'revoked'] },
  revision: sha256Schema,
  destinationOrigin: { type: 'string', format: 'uri', maxLength: 255 },
  urlFingerprint: sha256Schema, createdByClientId: idSchema, createdAt: dateTimeSchema,
  verifiedAt: dateTimeSchema, suspendedAt: dateTimeSchema, revokedAt: dateTimeSchema,
  currentSigningSecret: webhookSigningSecretMetadataSchema,
}
const webhookEndpointSummarySchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'status', 'destinationOrigin', 'urlFingerprint', 'createdByClientId', 'createdAt'],
  properties: webhookEndpointSummaryProperties,
}
const webhookEndpointDetailSchema = {
  type: 'object', additionalProperties: false,
  required: [...webhookEndpointSummarySchema.required, 'signingSecrets'],
  properties: { ...webhookEndpointSummaryProperties, signingSecrets: { type: 'array', maxItems: 100, items: webhookSigningSecretMetadataSchema } },
}

const publicOperationSchemaV2 = {
  ...publicOperationSchema,
  properties: {
    ...publicOperationSchema.properties,
    type: { enum: ['artifact-render', 'media-ingest'] },
    phase: {
      enum: [
        'queued', 'assembling', 'probing', 'normalizing', 'transcribing',
        'materializing', 'rendering', 'verifying', 'persisting',
        'waiting', 'retrying', 'completed', 'failed', 'canceled',
      ],
    },
  },
}

const publicOperationSchemaV3 = {
  ...publicOperationSchemaV2,
  properties: {
    ...publicOperationSchemaV2.properties,
    type: { enum: ['artifact-render', 'media-ingest', 'project-proxy-render'] },
  },
}

const publicOperationSchemaV4 = {
  ...publicOperationSchemaV3,
  properties: {
    ...publicOperationSchemaV3.properties,
    type: { enum: ['artifact-render', 'media-ingest', 'project-proxy-render', 'project-final-export'] },
  },
}

const publicOperationSchemaV5 = {
  ...publicOperationSchemaV4,
  properties: {
    ...publicOperationSchemaV4.properties,
    type: {
      enum: [
        'artifact-render',
        'media-ingest',
        'project-proxy-render',
        'project-final-export',
        'source-cleanup',
      ],
    },
  },
}

const publicOperationSchemaV6 = {
  ...publicOperationSchemaV5,
  properties: {
    ...publicOperationSchemaV5.properties,
    type: {
      enum: [
        'artifact-render',
        'media-ingest',
        'project-proxy-render',
        'project-final-export',
        'source-cleanup',
        'long-form-index',
      ],
    },
    phase: {
      enum: [
        'queued',
        'assembling',
        'probing',
        'normalizing',
        'transcribing',
        'diarizing',
        'chunking',
        'indexing',
        'materializing',
        'rendering',
        'verifying',
        'persisting',
        'waiting',
        'retrying',
        'completed',
        'failed',
        'canceled',
      ],
    },
  },
}

const publicOperationSchemaV7 = {
  ...publicOperationSchemaV6,
  required: [...publicOperationSchemaV6.required, 'visibleState'],
  properties: {
    ...publicOperationSchemaV6.properties,
    visibleState: visibleStateSchema,
  },
}

const publicOperationSchemaV8 = {
  ...publicOperationSchemaV7,
  properties: {
    ...publicOperationSchemaV7.properties,
    projectId: idSchema,
  },
}

const publicOperationSchemaV9 = {
  ...publicOperationSchemaV8,
  properties: {
    ...publicOperationSchemaV8.properties,
    type: {
      enum: [
        'artifact-render',
        'media-ingest',
        'project-proxy-render',
        'project-final-export',
        'source-cleanup',
        'long-form-index',
        'project-director-run',
      ],
    },
    phase: {
      enum: [
        'queued', 'assembling', 'probing', 'normalizing', 'transcribing',
        'diarizing', 'chunking', 'indexing', 'directing', 'materializing',
        'rendering', 'verifying', 'persisting', 'waiting', 'retrying',
        'completed', 'failed', 'canceled',
      ],
    },
    target: publicOperationTargetSchemaV2,
    result: {
      type: 'object',
      additionalProperties: false,
      required: ['resource'],
      properties: { resource: publicOperationTargetSchemaV2 },
    },
  },
}

const publicOperationEstimatedCostSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['currency', 'estimatedMinorUnits', 'maximumMinorUnits'],
  properties: {
    currency: { const: 'USD' },
    estimatedMinorUnits: {
      type: 'integer', minimum: 0, maximum: 10000000,
    },
    maximumMinorUnits: {
      type: 'integer', minimum: 0, maximum: 10000000,
    },
  },
}

const publicOperationActualCostSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['currency', 'minorUnits'],
  properties: {
    currency: { const: 'USD' },
    minorUnits: { type: 'integer', minimum: 0, maximum: 10000000 },
  },
}

const publicOperationSchemaV10 = {
  ...publicOperationSchemaV9,
  properties: {
    ...publicOperationSchemaV9.properties,
    estimatedCost: publicOperationEstimatedCostSchema,
    actualCost: publicOperationActualCostSchema,
  },
  allOf: [
    {
      if: {
        properties: { estimatedCost: {} },
        required: ['estimatedCost'],
      },
      then: { properties: { type: { const: 'long-form-index' } } },
    },
    {
      if: {
        properties: { actualCost: {} },
        required: ['actualCost'],
      },
      then: {
        required: ['estimatedCost'],
        properties: {
          estimatedCost: publicOperationEstimatedCostSchema,
          type: { const: 'long-form-index' },
          status: { enum: ['succeeded', 'failed', 'canceled'] },
        },
      },
    },
  ],
}

const publicOperationSchemaV11 = {
  ...publicOperationSchemaV10,
  properties: {
    ...publicOperationSchemaV10.properties,
    type: {
      enum: [
        ...publicOperationSchemaV9.properties.type.enum,
        'production-batch-item',
      ],
    },
    phase: {
      enum: [
        ...publicOperationSchemaV9.properties.phase.enum,
        'planning',
        'reviewing',
      ],
    },
    target: publicOperationTargetSchemaV3,
    result: {
      type: 'object',
      additionalProperties: false,
      required: ['resource'],
      properties: { resource: publicOperationTargetSchemaV3 },
    },
  },
}

const longFormStageNames = [
  'probe',
  'transcript',
  'diarization',
  'chunks',
  'moments',
]
const longFormStageVersionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'model', 'version'],
  properties: {
    provider: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
    model: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
    version: {
      type: 'string',
      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
    },
  },
}
const longFormStageBudgetSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'estimatedCostMinorUnits',
    'maximumCostMinorUnits',
    'maximumElapsedMs',
  ],
  properties: {
    estimatedCostMinorUnits: {
      type: 'integer',
      minimum: 0,
      maximum: 10000000,
    },
    maximumCostMinorUnits: {
      type: 'integer',
      minimum: 0,
      maximum: 10000000,
    },
    maximumElapsedMs: {
      type: 'integer',
      minimum: 1,
      maximum: 86400000,
    },
  },
}
const longFormStageMapSchema = (item: object) => ({
  type: 'object',
  additionalProperties: false,
  required: longFormStageNames,
  properties: Object.fromEntries(
    longFormStageNames.map((stage) => [stage, item]),
  ),
})
const longFormWorkflowBudgetSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'currency',
    'maximumCostMinorUnits',
    'maximumElapsedMs',
    'maximumConcurrency',
  ],
  properties: {
    currency: { const: 'USD' },
    maximumCostMinorUnits: {
      type: 'integer',
      minimum: 0,
      maximum: 10000000,
    },
    maximumElapsedMs: {
      type: 'integer',
      minimum: 1,
      maximum: 86400000,
    },
    maximumConcurrency: {
      type: 'integer',
      minimum: 1,
      maximum: 32,
    },
  },
}
const longFormIndexStageCheckpointSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  required: [
    'stage',
    'sequence',
    'prerequisites',
    'execution',
    'status',
    'version',
    'budget',
    'concurrency',
    'inputHash',
    'idempotencyKey',
    'attempt',
    'resultCount',
    'searchable',
    'costMinorUnits',
    'elapsedMs',
    'stageHash',
  ],
  properties: {
    stage: { enum: longFormStageNames },
    sequence: { type: 'integer', minimum: 1, maximum: 5 },
    prerequisites: {
      type: 'array',
      maxItems: 2,
      uniqueItems: true,
      items: { enum: longFormStageNames },
    },
    execution: { enum: ['process', 'reuse'] },
    status: {
      enum: [
        'pending',
        'ready',
        'running',
        'succeeded',
        'failed',
        'budget-blocked',
      ],
    },
    version: longFormStageVersionSchema,
    budget: longFormStageBudgetSchema,
    concurrency: { type: 'integer', minimum: 1, maximum: 32 },
    inputHash: sha256Schema,
    idempotencyKey: {
      type: 'string',
      minLength: 8,
      maxLength: 256,
    },
    attempt: { type: 'integer', minimum: 0 },
    outputHash: sha256Schema,
    outputReference: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: {
          enum: [
            'media-artifact-manifest',
            'media-transcript',
            'speaker-diarization-run',
            'hierarchical-processing-run',
            'long-form-index-run',
          ],
        },
        id: idSchema,
      },
    },
    resultCount: { type: 'integer', minimum: 0 },
    searchable: { type: 'boolean' },
    costMinorUnits: { type: 'integer', minimum: 0 },
    elapsedMs: { type: 'integer', minimum: 0 },
    startedAt: dateTimeSchema,
    completedAt: dateTimeSchema,
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message', 'retryable'],
      properties: {
        code: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
        },
        message: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
        },
        retryable: { type: 'boolean' },
      },
    },
    stageHash: sha256Schema,
  },
}
const {
  outputReference: _longFormOutputReference,
  ...longFormIndexStageCheckpointPropertiesV1
} = longFormIndexStageCheckpointSchemaV2.properties
const longFormIndexStageCheckpointSchemaV1 = {
  ...longFormIndexStageCheckpointSchemaV2,
  properties: longFormIndexStageCheckpointPropertiesV1,
}
const longFormIndexWorkflowSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'policyVersion',
    'id',
    'workspaceId',
    'projectId',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'sourceManifestId',
    'sourceManifestHash',
    'durationMs',
    'status',
    'stages',
    'budget',
    'summary',
    'createdByClientId',
    'createdAt',
    'updatedAt',
    'runHash',
  ],
  properties: {
    schemaVersion: { const: 'long-form-index-workflow/v1' },
    policyVersion: {
      const: 'long-form-index-workflow-policy/v1',
    },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    sourceManifestId: idSchema,
    sourceManifestHash: sha256Schema,
    sourceTranscriptId: idSchema,
    sourceTranscriptHash: sha256Schema,
    durationMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 43200000,
    },
    status: {
      enum: ['queued', 'running', 'partial', 'succeeded', 'failed'],
    },
    stages: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: longFormIndexStageCheckpointSchemaV2,
    },
    budget: longFormWorkflowBudgetSchema,
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'completedStageCount',
        'searchableStageCount',
        'resultCount',
        'costMinorUnits',
        'elapsedMs',
        'duplicateSegments',
        'resumable',
      ],
      properties: {
        completedStageCount: {
          type: 'integer',
          minimum: 0,
          maximum: 5,
        },
        searchableStageCount: {
          type: 'integer',
          minimum: 0,
          maximum: 3,
        },
        resultCount: { type: 'integer', minimum: 0 },
        costMinorUnits: { type: 'integer', minimum: 0 },
        elapsedMs: { type: 'integer', minimum: 0 },
        nextStage: { enum: longFormStageNames },
        duplicateSegments: { const: false },
        resumable: { const: true },
      },
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    runHash: sha256Schema,
  },
}
const longFormIndexWorkflowSchemaV1 = {
  ...longFormIndexWorkflowSchemaV2,
  properties: {
    ...longFormIndexWorkflowSchemaV2.properties,
    stages: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: longFormIndexStageCheckpointSchemaV1,
    },
  },
}
const longFormIndexWorkflowRecordSchemaV1 = {
  type: 'object',
  additionalProperties: false,
  required: ['workflow', 'operation'],
  properties: {
    workflow: longFormIndexWorkflowSchemaV1,
    operation: publicOperationSchemaV6,
  },
}
const longFormIndexWorkflowRecordSchemaV2 = {
  type: 'object',
  additionalProperties: false,
  required: ['workflow', 'operation'],
  properties: {
    workflow: longFormIndexWorkflowSchemaV2,
    operation: publicOperationSchemaV6,
  },
}
const speakerDiarizationSegmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'ordinal',
    'providerSegmentId',
    'providerLabel',
    'speakerKey',
    'startMs',
    'endMs',
    'text',
    'textHash',
    'segmentHash',
  ],
  properties: {
    id: idSchema,
    ordinal: { type: 'integer', minimum: 0, maximum: 99999 },
    providerSegmentId: idSchema,
    providerLabel: {
      type: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
    },
    speakerKey: {
      type: 'string',
      pattern: '^speaker-cluster-[a-f0-9]{40}$',
    },
    startMs: { type: 'integer', minimum: 0, maximum: 43200000 },
    endMs: { type: 'integer', minimum: 1, maximum: 43200000 },
    text: { type: 'string', minLength: 1, maxLength: 10000 },
    textHash: sha256Schema,
    segmentHash: sha256Schema,
  },
}
const speakerDiarizationRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'policyVersion',
    'id',
    'workspaceId',
    'projectId',
    'workflowId',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'sourceManifestId',
    'sourceManifestHash',
    'sourceTranscriptId',
    'sourceTranscriptHash',
    'durationMs',
    'providerInput',
    'provider',
    'segments',
    'speakerCount',
    'segmentCount',
    'usageSeconds',
    'costMinorUnits',
    'elapsedMs',
    'identityResolved',
    'physicalMaterialized',
    'requestFingerprint',
    'idempotencyKey',
    'createdByClientId',
    'createdAt',
    'runHash',
  ],
  properties: {
    schemaVersion: { const: 'speaker-diarization-run/v1' },
    policyVersion: { const: 'anonymous-speaker-clusters/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    workflowId: idSchema,
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    sourceManifestId: idSchema,
    sourceManifestHash: sha256Schema,
    sourceTranscriptId: idSchema,
    sourceTranscriptHash: sha256Schema,
    durationMs: {
      type: 'integer',
      minimum: 1000,
      maximum: 43200000,
    },
    providerInput: {
      type: 'object',
      additionalProperties: false,
      required: [
        'sha256',
        'byteSize',
        'durationMs',
        'preparation',
      ],
      properties: {
        sha256: sha256Schema,
        byteSize: {
          type: 'integer',
          minimum: 1,
          maximum: 536870912,
        },
        durationMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 43200000,
        },
        preparation: {
          type: 'object',
          additionalProperties: false,
          required: [
            'toolId',
            'toolVersion',
            'configurationHash',
          ],
          properties: {
            toolId: {
              type: 'string',
              pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
            },
            toolVersion: {
              type: 'string',
              pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
            },
            configurationHash: sha256Schema,
          },
        },
      },
    },
    provider: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'model', 'version'],
      properties: {
        id: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
        },
        model: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
        },
        version: {
          type: 'string',
          pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
        },
      },
    },
    segments: {
      type: 'array',
      minItems: 1,
      maxItems: 100000,
      items: speakerDiarizationSegmentSchema,
    },
    speakerCount: {
      type: 'integer',
      minimum: 1,
      maximum: 100000,
    },
    segmentCount: {
      type: 'integer',
      minimum: 1,
      maximum: 100000,
    },
    usageSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 43200,
    },
    costMinorUnits: {
      type: 'integer',
      minimum: 0,
      maximum: 10000000,
    },
    elapsedMs: {
      type: 'integer',
      minimum: 0,
      maximum: 86400000,
    },
    identityResolved: { const: false },
    physicalMaterialized: { const: false },
    requestFingerprint: sha256Schema,
    idempotencyKey: {
      type: 'string',
      minLength: 8,
      maxLength: 128,
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    runHash: sha256Schema,
  },
}

const semanticDiffItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['commandId', 'target', 'summary'],
  properties: {
    commandId: idSchema,
    target: { type: 'string', minLength: 1, maxLength: 256 },
    summary: { type: 'string', minLength: 1, maxLength: 500 },
  },
}

const versionDiffSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'commands', 'storyChanges', 'timelineChanges', 'visualChanges', 'audioChanges',
    'outputChanges', 'invalidatedArtifacts', 'estimatedCostDelta',
  ],
  properties: {
    commands: { type: 'array', maxItems: 1000, uniqueItems: true, items: idSchema },
    storyChanges: { type: 'array', maxItems: 1000, items: semanticDiffItemSchema },
    timelineChanges: { type: 'array', maxItems: 1000, items: semanticDiffItemSchema },
    visualChanges: { type: 'array', maxItems: 1000, items: semanticDiffItemSchema },
    audioChanges: { type: 'array', maxItems: 1000, items: semanticDiffItemSchema },
    outputChanges: { type: 'array', maxItems: 1000, items: semanticDiffItemSchema },
    invalidatedArtifacts: {
      type: 'array', maxItems: 1024, uniqueItems: true, items: idSchema,
    },
    estimatedCostDelta: { type: 'number', minimum: -1000000, maximum: 1000000 },
  },
}
const webhookSigningSecretRotationMetadataSchema = {
  type: 'object', additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'endpointId', 'candidateVersion', 'fingerprint', 'status',
    'overlapSeconds', 'baseRevision', 'createdAt', 'expiresAt',
  ],
  properties: {
    schemaVersion: { const: 'webhook-signing-secret-rotation/v1' },
    id: webhookUuidSchema, endpointId: webhookUuidSchema,
    candidateVersion: { type: 'integer', minimum: 2 }, fingerprint: sha256Schema,
    status: { enum: ['staged', 'activated', 'cancelled', 'expired'] },
    overlapSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
    baseRevision: sha256Schema, createdAt: dateTimeSchema, expiresAt: dateTimeSchema,
    activatedAt: dateTimeSchema, overlapUntil: dateTimeSchema, cancelledAt: dateTimeSchema,
  },
}
const webhookSubscriptionSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'id', 'endpointId', 'status', 'eventTypes', 'createdByClientId', 'createdAt'],
  properties: {
    schemaVersion: { const: 'webhook-subscription/v1' }, id: webhookUuidSchema, endpointId: webhookUuidSchema,
    status: { enum: ['pending-verification', 'active', 'paused', 'revoked'] },
    revision: sha256Schema,
    eventTypes: { type: 'array', minItems: 1, maxItems: 64, uniqueItems: true, items: { type: 'string', minLength: 3, maxLength: 128 } },
    resourceIds: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: idSchema },
    createdByClientId: idSchema, createdAt: dateTimeSchema, pausedAt: dateTimeSchema, revokedAt: dateTimeSchema,
  },
}
const webhookDeliverySummaryProperties = {
  schemaVersion: { const: 'webhook-delivery/v1' },
  id: webhookUuidSchema,
  endpointId: webhookUuidSchema,
  subscriptionId: webhookUuidSchema,
  eventId: webhookUuidSchema,
  status: {
    enum: ['pending', 'in-flight', 'retry-scheduled', 'succeeded', 'dead-lettered'],
  },
  attemptCount: { type: 'integer', minimum: 0, maximum: 20 },
  maxAttempts: { type: 'integer', minimum: 1, maximum: 20 },
  nextAttemptAt: dateTimeSchema,
  createdAt: dateTimeSchema,
  completedAt: dateTimeSchema,
  deadLetteredAt: dateTimeSchema,
}
const webhookDeliverySummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: webhookDeliverySummaryRequired,
  properties: webhookDeliverySummaryProperties,
}
const webhookDeliveryAttemptSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'id', 'attemptNumber', 'status', 'scheduledAt', 'createdAt'],
  properties: {
    schemaVersion: { const: 'webhook-delivery-attempt/v1' },
    id: webhookUuidSchema,
    attemptNumber: { type: 'integer', minimum: 1, maximum: 20 },
    status: { enum: ['scheduled', 'in-flight', 'succeeded', 'failed'] },
    scheduledAt: dateTimeSchema,
    createdAt: dateTimeSchema,
    startedAt: dateTimeSchema,
    completedAt: dateTimeSchema,
    responseStatus: { type: 'integer', minimum: 100, maximum: 599 },
    responseBodyHash: sha256Schema,
    errorCode: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
  },
}
const webhookDeliveryDiagnosticSchema = {
  type: 'object',
  additionalProperties: false,
  required: [...webhookDeliverySummaryRequired, 'attempts'],
  properties: {
    ...webhookDeliverySummaryProperties,
    attempts: { type: 'array', maxItems: 20, items: webhookDeliveryAttemptSchema },
  },
}
const webhookEventReplayItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'delivery'],
  properties: {
    status: {
      enum: [
        'scheduled',
        'skipped-non-terminal',
        'skipped-target-inactive',
        'skipped-attempt-limit',
      ],
    },
    delivery: webhookDeliverySummarySchema,
  },
}
const renderInputAssetSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id', 'artifactId', 'artifactKey', 'kind', 'role',
    'ordinal', 'sha256', 'byteSize',
  ],
  properties: {
    id: renderTokenSchema,
    artifactId: renderTokenSchema,
    artifactKey: { type: 'string', minLength: 1, maxLength: 512 },
    kind: { enum: ['video', 'audio', 'image', 'font', 'lut', 'data'] },
    role: renderTokenSchema,
    ordinal: { type: 'integer', minimum: 0, maximum: 4095 },
    sha256: sha256Schema,
    byteSize: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  },
}

const rightsTokenSchema = {
  type: 'string',
  pattern: '^[a-z0-9][a-z0-9._:-]{0,63}$',
}
const rightsTokenArraySchema = {
  type: 'array',
  maxItems: 64,
  uniqueItems: true,
  items: rightsTokenSchema,
}
const marketArraySchema = {
  type: 'array',
  maxItems: 64,
  uniqueItems: true,
  items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9-]{1,15}$' },
}
const localeArraySchema = {
  type: 'array',
  maxItems: 64,
  uniqueItems: true,
  items: {
    type: 'string',
    pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
  },
}
const consentScopeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'allowedUses'],
  properties: {
    status: {
      enum: ['not-required', 'approved', 'restricted', 'unknown', 'expired', 'revoked'],
    },
    allowedUses: rightsTokenArraySchema,
    allowedMarkets: marketArraySchema,
    allowedLocales: localeArraySchema,
    allowedSyntheticOperations: rightsTokenArraySchema,
    expiresAt: dateTimeSchema,
    documentArtifactId: idSchema,
  },
}
const assetRightsDraftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'allowedUses', 'prohibitedUses', 'consent'],
  properties: {
    owner: { type: 'string', minLength: 1, maxLength: 240 },
    license: { type: 'string', minLength: 1, maxLength: 240 },
    status: { enum: ['approved', 'restricted', 'unknown', 'expired', 'revoked'] },
    allowedUses: rightsTokenArraySchema,
    prohibitedUses: rightsTokenArraySchema,
    allowedMarkets: marketArraySchema,
    allowedLocales: localeArraySchema,
    allowedSyntheticOperations: rightsTokenArraySchema,
    expiresAt: dateTimeSchema,
    consent: consentScopeSchema,
    sourceNote: { type: 'string', minLength: 1, maxLength: 2000 },
  },
}
const assetRightsSnapshotSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'workspaceId', 'artifactId', 'sequence',
    'snapshotHash', 'status', 'allowedUses', 'prohibitedUses',
    'allowedWorkspaceIds', 'consent', 'createdBy', 'createdAt',
  ],
  properties: {
    ...assetRightsDraftSchema.properties,
    schemaVersion: { const: 'asset-rights/v1' },
    id: idSchema,
    workspaceId: idSchema,
    artifactId: idSchema,
    sequence: { type: 'integer', minimum: 1 },
    snapshotHash: sha256Schema,
    allowedWorkspaceIds: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: idSchema,
    },
    createdBy: {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { enum: ['api-client', 'user', 'system'] },
        id: idSchema,
      },
    },
    createdAt: dateTimeSchema,
  },
}
const assetUseDenialCodes = [
  'RIGHTS_MISSING', 'RIGHTS_STATUS_RESTRICTED', 'RIGHTS_STATUS_UNKNOWN',
  'RIGHTS_STATUS_EXPIRED', 'RIGHTS_STATUS_REVOKED', 'RIGHTS_EXPIRED',
  'RIGHTS_WORKSPACE_NOT_ALLOWED', 'RIGHTS_USE_PROHIBITED',
  'RIGHTS_USE_NOT_ALLOWED', 'RIGHTS_MARKET_NOT_ALLOWED',
  'RIGHTS_LOCALE_NOT_ALLOWED', 'RIGHTS_SYNTHETIC_OPERATION_NOT_ALLOWED',
  'CONSENT_STATUS_RESTRICTED', 'CONSENT_STATUS_UNKNOWN',
  'CONSENT_STATUS_EXPIRED', 'CONSENT_STATUS_REVOKED', 'CONSENT_EXPIRED',
  'CONSENT_USE_NOT_ALLOWED', 'CONSENT_MARKET_NOT_ALLOWED',
  'CONSENT_LOCALE_NOT_ALLOWED', 'CONSENT_SYNTHETIC_OPERATION_NOT_ALLOWED',
]

const credentialMutationDataSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['client', 'credential', 'secretAvailable', 'replayed'],
  properties: {
    client: apiClientSchema,
    credential: apiCredentialSchema,
    token: { type: 'string', pattern: '^apollo_v2\\.' },
    secretAvailable: { type: 'boolean' },
    replayed: { type: 'boolean' },
  },
  allOf: [
    {
      if: { properties: { secretAvailable: { const: true } }, required: ['secretAvailable'] },
      then: {
        required: ['token'],
        properties: { token: { type: 'string', pattern: '^apollo_v2\\.' } },
      },
      else: { properties: { token: false } },
    },
  ],
}
const longFormIndexWorkflowRecordSchemaV3 = {
  type: 'object',
  additionalProperties: false,
  required: ['workflow', 'operation'],
  properties: {
    workflow: longFormIndexWorkflowSchemaV2,
    operation: publicOperationSchemaV10,
  },
}

const credentialMutationDataV2Schema = {
  ...credentialMutationDataSchema,
  properties: {
    ...credentialMutationDataSchema.properties,
    client: apiClientV2Schema,
  },
}

const sourceDeconstructionRangeMsSchema = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  prefixItems: [
    { type: 'integer', minimum: 0, maximum: 43_200_000 },
    { type: 'integer', minimum: 1, maximum: 43_200_000 },
  ],
  items: false,
}
const sourceDeconstructionRoleSchema = {
  enum: ['opening', 'hook', 'context', 'body', 'cta', 'tail'],
}
const sourceDeconstructionDesiredRoleSchema = {
  enum: ['hook', 'body', 'cta', 'complete'],
}
const sourceDeconstructionValidationScopeSchema = {
  enum: ['copy', 'take', 'opening-edit', 'full'],
}
const sourceDeconstructionDecisionSchema = {
  enum: ['automatic', 'human-review', 'reject'],
}
const sourceDeconstructionBoundaryPolicySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'preRollMs',
    'postRollMs',
    'maxJoinGapMs',
    'maxContextGapMs',
    'minCompleteThoughtScore',
  ],
  properties: {
    preRollMs: { type: 'integer', minimum: 0, maximum: 2_000 },
    postRollMs: { type: 'integer', minimum: 0, maximum: 2_000 },
    maxJoinGapMs: { type: 'integer', minimum: 0, maximum: 5_000 },
    maxContextGapMs: { type: 'integer', minimum: 0, maximum: 5_000 },
    minCompleteThoughtScore: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const sourceDeconstructionTargetCompositionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['objective', 'outputSpecId', 'targetDurationMs'],
  properties: {
    objective: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[a-z0-9][a-z0-9._:/-]*$',
    },
    outputSpecId: {
      type: 'string',
      minLength: 2,
      maxLength: 64,
      pattern: '^(?:9:16|16:9|4:5|1:1|21:9|[a-z0-9][a-z0-9._:/-]{1,63})$',
    },
    targetDurationMs: {
      type: 'integer',
      minimum: 500,
      maximum: 1_800_000,
    },
  },
}
const sourceDeconstructionSegmentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sourceSpeechSegmentId',
    'sourceSegmentId',
    'exactText',
    'normalizedText',
    'rangeMs',
    'role',
    'roleConfidence',
    'roleReasonCodes',
    'essential',
    'included',
    'includedForContext',
    'completeThoughtScore',
    'classification',
    'segmentHash',
    'analysisHash',
  ],
  properties: {
    id: idSchema,
    sourceSpeechSegmentId: idSchema,
    sourceSegmentId: { type: 'integer', minimum: 0, maximum: 10_000_000 },
    exactText: { type: 'string', minLength: 1, maxLength: 20_000 },
    normalizedText: { type: 'string', minLength: 1, maxLength: 20_000 },
    rangeMs: sourceDeconstructionRangeMsSchema,
    role: sourceDeconstructionRoleSchema,
    roleConfidence: { type: 'number', minimum: 0, maximum: 1 },
    roleReasonCodes: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
    essential: { type: 'boolean' },
    included: { type: 'boolean' },
    includedForContext: { type: 'boolean' },
    completeThoughtScore: { type: 'number', minimum: 0, maximum: 1 },
    classification: {
      enum: ['complete-thought', 'incomplete', 'interrupted'],
    },
    segmentHash: sha256Schema,
    analysisHash: sha256Schema,
  },
}
const sourceDeconstructionCleanRangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sequence',
    'rangeMs',
    'speechRangeMs',
    'sourceSpeechSegmentIds',
    'roles',
    'exactText',
    'confidence',
    'contextPreserved',
    'boundaryReasonCodes',
    'rangeHash',
  ],
  properties: {
    id: idSchema,
    sequence: { type: 'integer', minimum: 0, maximum: 100_000 },
    rangeMs: sourceDeconstructionRangeMsSchema,
    speechRangeMs: sourceDeconstructionRangeMsSchema,
    sourceSpeechSegmentIds: {
      type: 'array',
      minItems: 1,
      maxItems: 10_000,
      uniqueItems: true,
      items: idSchema,
    },
    roles: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      uniqueItems: true,
      items: sourceDeconstructionRoleSchema,
    },
    exactText: { type: 'string', minLength: 1, maxLength: 100_000 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    contextPreserved: { type: 'boolean' },
    boundaryReasonCodes: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
    rangeHash: sha256Schema,
  },
}
const sourceDeconstructionContaminantSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'kind',
    'sourceSpeechSegmentId',
    'rangeMs',
    'exactText',
    'confidence',
    'overlapsEssential',
    'removableWithoutContextLoss',
    'contaminantHash',
  ],
  properties: {
    id: idSchema,
    kind: {
      enum: [
        'prior-opening',
        'non-target-body',
        'prior-cta',
        'removable-tail',
      ],
    },
    sourceSpeechSegmentId: idSchema,
    rangeMs: sourceDeconstructionRangeMsSchema,
    exactText: { type: 'string', minLength: 1, maxLength: 20_000 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    overlapsEssential: { const: false },
    removableWithoutContextLoss: { type: 'boolean' },
    contaminantHash: sha256Schema,
  },
}
const sourceDeconstructionMappingSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sourceSpeechSegmentId',
    'sourceRangeMs',
    'role',
    'included',
  ],
  properties: {
    sourceSpeechSegmentId: idSchema,
    sourceRangeMs: sourceDeconstructionRangeMsSchema,
    cleanRangeId: idSchema,
    role: sourceDeconstructionRoleSchema,
    included: { type: 'boolean' },
  },
}
const sourceDeconstructionComparisonCoreProperties = {
  sourceRangeMs: sourceDeconstructionRangeMsSchema,
  cleanRangesMs: {
    type: 'array',
    maxItems: 10_000,
    items: sourceDeconstructionRangeMsSchema,
  },
  removedRangesMs: {
    type: 'array',
    maxItems: 10_000,
    items: sourceDeconstructionRangeMsSchema,
  },
  sourceDurationMs: {
    type: 'integer',
    minimum: 1,
    maximum: 43_200_000,
  },
  cleanDurationMs: {
    type: 'integer',
    minimum: 0,
    maximum: 43_200_000,
  },
  removedDurationMs: {
    type: 'integer',
    minimum: 0,
    maximum: 43_200_000,
  },
  retainedRatio: { type: 'number', minimum: 0, maximum: 1 },
  sourceSegmentCount: {
    type: 'integer',
    minimum: 1,
    maximum: 100_000,
  },
  includedSegmentCount: {
    type: 'integer',
    minimum: 0,
    maximum: 100_000,
  },
  excludedSegmentCount: {
    type: 'integer',
    minimum: 0,
    maximum: 100_000,
  },
  sourceTranscript: {
    type: 'string',
    minLength: 1,
    maxLength: 2_000_000,
  },
  cleanTranscript: {
    type: 'string',
    maxLength: 2_000_000,
  },
  mappings: {
    type: 'array',
    minItems: 1,
    maxItems: 100_000,
    items: sourceDeconstructionMappingSchema,
  },
  comparisonHash: sha256Schema,
}
const sourceDeconstructionComparisonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reportId',
    'sourceArtifactId',
    'desiredRole',
    'validationScope',
    'decision',
    'confidence',
    'editabilityScore',
    'contextPreserved',
    'sourceRangeMs',
    'cleanRangesMs',
    'removedRangesMs',
    'sourceDurationMs',
    'cleanDurationMs',
    'removedDurationMs',
    'retainedRatio',
    'sourceSegmentCount',
    'includedSegmentCount',
    'excludedSegmentCount',
    'sourceTranscript',
    'cleanTranscript',
    'mappings',
    'comparisonHash',
  ],
  properties: {
    reportId: idSchema,
    sourceArtifactId: idSchema,
    desiredRole: sourceDeconstructionDesiredRoleSchema,
    validationScope: sourceDeconstructionValidationScopeSchema,
    decision: sourceDeconstructionDecisionSchema,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    editabilityScore: { type: 'number', minimum: 0, maximum: 100 },
    contextPreserved: { type: 'boolean' },
    ...sourceDeconstructionComparisonCoreProperties,
  },
}
const sourceDeconstructionReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'sourceTranscriptId',
    'sourceTranscriptHash',
    'sourceDurationMs',
    'desiredRole',
    'validationScope',
    'targetComposition',
    'boundaryPolicy',
    'analyzer',
    'segments',
    'hookEnvelope',
    'bodyRanges',
    'ctaRanges',
    'cleanCandidateRanges',
    'semanticContaminants',
    'comparison',
    'confidence',
    'editabilityScore',
    'decision',
    'contextPreserved',
    'decisionReasonCodes',
    'createdByClientId',
    'createdAt',
    'reportHash',
  ],
  properties: {
    schemaVersion: { const: 'source-deconstruction-report/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    sourceTranscriptId: idSchema,
    sourceTranscriptHash: sha256Schema,
    sourceDurationMs: {
      type: 'integer',
      minimum: 1,
      maximum: 43_200_000,
    },
    desiredRole: sourceDeconstructionDesiredRoleSchema,
    validationScope: sourceDeconstructionValidationScopeSchema,
    targetComposition: sourceDeconstructionTargetCompositionSchema,
    boundaryPolicy: sourceDeconstructionBoundaryPolicySchema,
    analyzer: {
      type: 'object',
      additionalProperties: false,
      required: ['policyVersion', 'version', 'evidenceSource'],
      properties: {
        policyVersion: { const: 'source-deconstruction/v1' },
        version: { const: 'semantic-source-deconstructor/v1' },
        evidenceSource: { const: 'cataloged-speech' },
      },
    },
    segments: {
      type: 'array',
      minItems: 1,
      maxItems: 100_000,
      items: sourceDeconstructionSegmentSchema,
    },
    hookEnvelope: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'rangeMs',
            'sourceSpeechSegmentIds',
            'confidence',
          ],
          properties: {
            rangeMs: sourceDeconstructionRangeMsSchema,
            sourceSpeechSegmentIds: {
              type: 'array',
              minItems: 1,
              maxItems: 10_000,
              uniqueItems: true,
              items: idSchema,
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      ],
    },
    bodyRanges: {
      type: 'array',
      maxItems: 10_000,
      items: sourceDeconstructionRangeMsSchema,
    },
    ctaRanges: {
      type: 'array',
      maxItems: 10_000,
      items: sourceDeconstructionRangeMsSchema,
    },
    cleanCandidateRanges: {
      type: 'array',
      maxItems: 10_000,
      items: sourceDeconstructionCleanRangeSchema,
    },
    semanticContaminants: {
      type: 'array',
      maxItems: 100_000,
      items: sourceDeconstructionContaminantSchema,
    },
    comparison: sourceDeconstructionComparisonSchema,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    editabilityScore: { type: 'number', minimum: 0, maximum: 100 },
    decision: sourceDeconstructionDecisionSchema,
    contextPreserved: { type: 'boolean' },
    decisionReasonCodes: {
      type: 'array',
      minItems: 1,
      maxItems: 64,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    reportHash: sha256Schema,
  },
}

const contaminationRangeMsSchema = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  prefixItems: [
    { type: 'integer', minimum: 0, maximum: 86_399_999 },
    { type: 'integer', minimum: 1, maximum: 86_400_000 },
  ],
  items: false,
}
const contaminationTokenSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[a-z0-9][a-z0-9._:/-]{0,127}$',
}
const contaminationRegionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'number', minimum: 0, maximum: 1 },
    y: { type: 'number', minimum: 0, maximum: 1 },
    width: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 1,
    },
    height: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 1,
    },
  },
}
const contaminationDetectorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'model', 'version'],
  properties: {
    provider: contaminationTokenSchema,
    model: contaminationTokenSchema,
    version: contaminationTokenSchema,
  },
}
const contaminationAnalyzerSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'provider',
    'model',
    'version',
    'observationBatchHash',
  ],
  properties: {
    ...contaminationDetectorSchema.properties,
    observationBatchHash: sha256Schema,
  },
}
const contaminationPolicyInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'minObservationConfidence',
    'minAutomaticConfidence',
    'protectedIntersectionReviewRatio',
    'protectedIntersectionDestructiveRatio',
    'lowConfidenceRequiresReview',
  ],
  properties: {
    minObservationConfidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    minAutomaticConfidence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    protectedIntersectionReviewRatio: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    protectedIntersectionDestructiveRatio: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    lowConfidenceRequiresReview: { type: 'boolean' },
  },
}
const contaminationPolicySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...contaminationPolicyInputSchema.required,
    'version',
  ],
  properties: {
    ...contaminationPolicyInputSchema.properties,
    version: { const: 'source-contamination/v1' },
  },
}
const burnedCaptionSignalsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'text',
    'textTrackMatch',
    'frameCoverage',
    'foregroundContrast',
  ],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 4_000 },
    textTrackMatch: { type: 'number', minimum: 0, maximum: 1 },
    frameCoverage: { type: 'number', minimum: 0, maximum: 1 },
    foregroundContrast: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
  },
}
const logoWatermarkSignalsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'logoMatch', 'frameCoverage', 'opacity'],
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 256 },
    logoMatch: { type: 'number', minimum: 0, maximum: 1 },
    frameCoverage: { type: 'number', minimum: 0, maximum: 1 },
    opacity: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const musicSignalsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'musicLikelihood',
    'speechLikelihood',
    'separableStem',
    'spectralPersistence',
  ],
  properties: {
    musicLikelihood: { type: 'number', minimum: 0, maximum: 1 },
    speechLikelihood: { type: 'number', minimum: 0, maximum: 1 },
    separableStem: { type: 'boolean' },
    spectralPersistence: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
  },
}
const borderSignalsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'edges',
    'uniformity',
    'thicknessRatio',
    'frameCoverage',
  ],
  properties: {
    edges: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: {
        type: 'string',
        enum: ['top', 'right', 'bottom', 'left'],
      },
    },
    uniformity: { type: 'number', minimum: 0, maximum: 1 },
    thicknessRatio: { type: 'number', minimum: 0, maximum: 1 },
    frameCoverage: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const overlaySignalsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'overlayClass',
    'frameCoverage',
    'opacity',
    'occludesSubject',
  ],
  properties: {
    overlayClass: contaminationTokenSchema,
    frameCoverage: { type: 'number', minimum: 0, maximum: 1 },
    opacity: { type: 'number', minimum: 0, maximum: 1 },
    occludesSubject: { type: 'boolean' },
  },
}
const contaminationSignalsSchema = {
  oneOf: [
    burnedCaptionSignalsSchema,
    logoWatermarkSignalsSchema,
    musicSignalsSchema,
    borderSignalsSchema,
    overlaySignalsSchema,
  ],
}
const contaminationObservationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'kind',
    'rangeMs',
    'region',
    'confidence',
    'detector',
    'signals',
  ],
  properties: {
    id: idSchema,
    kind: {
      type: 'string',
      enum: [
        'burned-caption',
        'logo-watermark',
        'music',
        'border',
        'overlay',
      ],
    },
    rangeMs: contaminationRangeMsSchema,
    region: {
      anyOf: [
        { type: 'null' },
        contaminationRegionSchema,
      ],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    detector: contaminationDetectorSchema,
    signals: contaminationSignalsSchema,
  },
}
const contaminationProtectedRegionInputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'kind',
    'rangeMs',
    'region',
    'confidence',
    'source',
  ],
  properties: {
    id: idSchema,
    kind: {
      type: 'string',
      enum: [
        'face',
        'speaker',
        'essential-text',
        'product',
        'screen-content',
      ],
    },
    rangeMs: contaminationRangeMsSchema,
    region: contaminationRegionSchema,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    source: contaminationTokenSchema,
  },
}
const contaminationProtectedRegionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...contaminationProtectedRegionInputSchema.required,
    'regionHash',
  ],
  properties: {
    ...contaminationProtectedRegionInputSchema.properties,
    regionHash: sha256Schema,
  },
}
const contaminationFindingSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'observationId',
    'kind',
    'rangeMs',
    'region',
    'confidence',
    'detector',
    'signals',
    'overlapsEssentialTime',
    'essentialOverlapRatio',
    'protectedRegionIds',
    'protectedRegionIntersectionRatio',
    'removalImpact',
    'removalWouldDestroyEssential',
    'requiresHumanReview',
    'reasonCodes',
    'observationHash',
    'findingHash',
  ],
  properties: {
    id: idSchema,
    observationId: idSchema,
    kind: contaminationObservationSchema.properties.kind,
    rangeMs: contaminationRangeMsSchema,
    region: contaminationObservationSchema.properties.region,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    detector: contaminationDetectorSchema,
    signals: contaminationSignalsSchema,
    overlapsEssentialTime: { type: 'boolean' },
    essentialOverlapRatio: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    protectedRegionIds: {
      type: 'array',
      maxItems: 5_000,
      uniqueItems: true,
      items: idSchema,
    },
    protectedRegionIntersectionRatio: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    removalImpact: {
      type: 'string',
      enum: ['safe', 'review-required', 'destructive'],
    },
    removalWouldDestroyEssential: { type: 'boolean' },
    requiresHumanReview: { type: 'boolean' },
    reasonCodes: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 128 },
    },
    observationHash: sha256Schema,
    findingHash: sha256Schema,
  },
}
const contaminationOverlapSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'leftFindingId',
    'rightFindingId',
    'rangeMs',
    'spatiallyOverlapping',
    'intersectionRegion',
    'confidence',
    'overlapHash',
  ],
  properties: {
    id: idSchema,
    leftFindingId: idSchema,
    rightFindingId: idSchema,
    rangeMs: contaminationRangeMsSchema,
    spatiallyOverlapping: { const: true },
    intersectionRegion: {
      anyOf: [
        { type: 'null' },
        contaminationRegionSchema,
      ],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    overlapHash: sha256Schema,
  },
}
const directorContaminationDiagnosticSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'findingId',
    'code',
    'severity',
    'rangeMs',
    'region',
    'confidence',
    'removalDecision',
    'reasonCodes',
    'message',
  ],
  properties: {
    findingId: idSchema,
    code: contaminationObservationSchema.properties.kind,
    severity: {
      type: 'string',
      enum: ['information', 'warning', 'blocking'],
    },
    rangeMs: contaminationRangeMsSchema,
    region: contaminationObservationSchema.properties.region,
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    removalDecision: {
      type: 'string',
      enum: ['eligible', 'review', 'blocked'],
    },
    reasonCodes:
      contaminationFindingSchema.properties.reasonCodes,
    message: { type: 'string', minLength: 1, maxLength: 1_000 },
  },
}
const humanContaminationDiagnosticSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'findingId',
    'reviewRequired',
    'rangeMs',
    'region',
    'compareSource',
    'question',
    'reasonCodes',
  ],
  properties: {
    findingId: idSchema,
    reviewRequired: { type: 'boolean' },
    rangeMs: contaminationRangeMsSchema,
    region: contaminationObservationSchema.properties.region,
    compareSource: { const: true },
    question: { type: 'string', minLength: 1, maxLength: 1_000 },
    reasonCodes:
      contaminationFindingSchema.properties.reasonCodes,
  },
}
const contaminationDiagnosticsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'reportId',
    'sourceArtifactId',
    'decision',
    'humanReviewRequired',
    'confidence',
  ],
  properties: {
    reportId: idSchema,
    sourceArtifactId: idSchema,
    decision: {
      type: 'string',
      enum: [
        'cleanup-eligible',
        'human-review',
        'manual-preservation-required',
      ],
    },
    humanReviewRequired: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    director: {
      type: 'array',
      maxItems: 10_000,
      items: directorContaminationDiagnosticSchema,
    },
    humanReview: {
      type: 'array',
      maxItems: 10_000,
      items: humanContaminationDiagnosticSchema,
    },
  },
}
const contaminationReportSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspaceId',
    'projectId',
    'sourceDeconstructionReportId',
    'sourceDeconstructionReportHash',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'sourceDurationMs',
    'analyzer',
    'policy',
    'observations',
    'protectedRegions',
    'findings',
    'overlaps',
    'summary',
    'diagnostics',
    'decision',
    'humanReviewRequired',
    'confidence',
    'createdByClientId',
    'createdAt',
    'reportHash',
  ],
  properties: {
    schemaVersion: { const: 'contamination-report/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    sourceDeconstructionReportId: idSchema,
    sourceDeconstructionReportHash: sha256Schema,
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    sourceDurationMs: {
      type: 'integer',
      minimum: 1,
      maximum: 86_400_000,
    },
    analyzer: contaminationAnalyzerSchema,
    policy: contaminationPolicySchema,
    observations: {
      type: 'array',
      maxItems: 10_000,
      items: contaminationObservationSchema,
    },
    protectedRegions: {
      type: 'array',
      maxItems: 5_000,
      items: contaminationProtectedRegionSchema,
    },
    findings: {
      type: 'array',
      maxItems: 10_000,
      items: contaminationFindingSchema,
    },
    overlaps: {
      type: 'array',
      maxItems: 50_000_000,
      items: contaminationOverlapSchema,
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'findingCount',
        'observationCount',
        'protectedRegionCount',
        'overlapCount',
        'countsByKind',
        'safeCount',
        'reviewCount',
        'destructiveCount',
      ],
      properties: {
        findingCount: { type: 'integer', minimum: 0, maximum: 10_000 },
        observationCount: {
          type: 'integer',
          minimum: 0,
          maximum: 10_000,
        },
        protectedRegionCount: {
          type: 'integer',
          minimum: 0,
          maximum: 5_000,
        },
        overlapCount: {
          type: 'integer',
          minimum: 0,
          maximum: 50_000_000,
        },
        countsByKind: {
          type: 'object',
          additionalProperties: false,
          required: [
            'burned-caption',
            'logo-watermark',
            'music',
            'border',
            'overlay',
          ],
          properties: {
            'burned-caption': {
              type: 'integer',
              minimum: 0,
              maximum: 10_000,
            },
            'logo-watermark': {
              type: 'integer',
              minimum: 0,
              maximum: 10_000,
            },
            music: {
              type: 'integer',
              minimum: 0,
              maximum: 10_000,
            },
            border: {
              type: 'integer',
              minimum: 0,
              maximum: 10_000,
            },
            overlay: {
              type: 'integer',
              minimum: 0,
              maximum: 10_000,
            },
          },
        },
        safeCount: { type: 'integer', minimum: 0, maximum: 10_000 },
        reviewCount: {
          type: 'integer',
          minimum: 0,
          maximum: 10_000,
        },
        destructiveCount: {
          type: 'integer',
          minimum: 0,
          maximum: 10_000,
        },
      },
    },
    diagnostics: contaminationDiagnosticsSchema,
    decision: contaminationDiagnosticsSchema.properties.decision,
    humanReviewRequired: { type: 'boolean' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    reportHash: sha256Schema,
  },
}

const sourceCleanupPolicySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'minResidualQuality',
    'minIntegrity',
    'maxCost',
    'edgeTolerance',
    'maxCropFraction',
    'maxCoverArea',
    'coverColor',
    'costs',
  ],
  properties: {
    minResidualQuality: { type: 'number', minimum: 0, maximum: 1 },
    minIntegrity: { type: 'number', minimum: 0, maximum: 1 },
    maxCost: { type: 'number', minimum: 0, maximum: 1_000_000 },
    edgeTolerance: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 0.2,
    },
    maxCropFraction: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 0.4,
    },
    maxCoverArea: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 0.4,
    },
    coverColor: {
      type: 'string',
      pattern: '^#[A-F0-9]{6}$',
    },
    costs: {
      type: 'object',
      additionalProperties: false,
      required: ['trim', 'crop-reframe', 'cover'],
      properties: {
        trim: { type: 'number', minimum: 0, maximum: 1_000_000 },
        'crop-reframe': {
          type: 'number',
          minimum: 0,
          maximum: 1_000_000,
        },
        cover: { type: 'number', minimum: 0, maximum: 1_000_000 },
      },
    },
  },
}
const sourceCleanupReasonCodesSchema = {
  type: 'array',
  maxItems: 128,
  uniqueItems: true,
  items: {
    type: 'string',
    minLength: 1,
    maxLength: 128,
    pattern: '^[A-Z0-9_]+$',
  },
}
const sourceCleanupActionSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['strategy', 'keepRangeMs', 'removedRangeMs'],
      properties: {
        strategy: { const: 'trim' },
        keepRangeMs: contaminationRangeMsSchema,
        removedRangeMs: contaminationRangeMsSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['strategy', 'crop', 'removedRegion'],
      properties: {
        strategy: { const: 'crop-reframe' },
        crop: contaminationRegionSchema,
        removedRegion: contaminationRegionSchema,
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['strategy', 'rangeMs', 'region', 'color'],
      properties: {
        strategy: { const: 'cover' },
        rangeMs: contaminationRangeMsSchema,
        region: contaminationRegionSchema,
        color: { type: 'string', pattern: '^#[A-F0-9]{6}$' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['strategy', 'reasonCodes'],
      properties: {
        strategy: { const: 'reject' },
        reasonCodes: sourceCleanupReasonCodesSchema,
      },
    },
  ],
}
const sourceCleanupCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'strategy',
    'eligible',
    'predictedResidualQuality',
    'predictedIntegrity',
    'cost',
    'score',
    'reasonCodes',
  ],
  properties: {
    strategy: {
      enum: ['trim', 'crop-reframe', 'cover', 'reject'],
    },
    eligible: { type: 'boolean' },
    predictedResidualQuality: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    predictedIntegrity: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    cost: { type: 'number', minimum: 0, maximum: 1_000_000 },
    score: { type: 'number', minimum: 0, maximum: 1 },
    reasonCodes: sourceCleanupReasonCodesSchema,
    action: sourceCleanupActionSchema,
  },
}
const sourceCleanupPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'policyVersion',
    'id',
    'workspaceId',
    'projectId',
    'contaminationReportId',
    'contaminationReportHash',
    'findingId',
    'findingHash',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'sourceManifestId',
    'sourceDurationMs',
    'sourceImmutable',
    'policy',
    'candidates',
    'selectedStrategy',
    'selectedAction',
    'decision',
    'predictedResidualQuality',
    'predictedIntegrity',
    'predictedCost',
    'rightsDecision',
    'rightsReasonCodes',
    'postCleanupReviewRequired',
    'createdByClientId',
    'createdAt',
    'planHash',
  ],
  properties: {
    schemaVersion: { const: 'source-cleanup-plan/v1' },
    policyVersion: { const: 'source-cleanup-mvp/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    contaminationReportId: idSchema,
    contaminationReportHash: sha256Schema,
    findingId: idSchema,
    findingHash: sha256Schema,
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    sourceManifestId: idSchema,
    sourceDurationMs: {
      type: 'integer',
      minimum: 1,
      maximum: 86_400_000,
    },
    sourceImmutable: { const: true },
    policy: sourceCleanupPolicySchema,
    candidates: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: sourceCleanupCandidateSchema,
    },
    selectedStrategy: {
      enum: ['trim', 'crop-reframe', 'cover', 'reject'],
    },
    selectedAction: sourceCleanupActionSchema,
    decision: { enum: ['execute', 'reject'] },
    predictedResidualQuality: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    predictedIntegrity: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
    predictedCost: {
      type: 'number',
      minimum: 0,
      maximum: 1_000_000,
    },
    rightsSnapshotId: idSchema,
    rightsSnapshotHash: sha256Schema,
    rightsDecision: { enum: ['allow', 'deny'] },
    rightsReasonCodes: sourceCleanupReasonCodesSchema,
    operationId: idSchema,
    outputArtifactId: idSchema,
    outputManifestId: idSchema,
    postCleanupReviewRequired: { type: 'boolean' },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    planHash: sha256Schema,
  },
}
const postCleanupReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'cleanupPlanId',
    'cleanupPlanHash',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'outputArtifactId',
    'outputArtifactSha256',
    'outputManifestId',
    'strategy',
    'visual',
    'rights',
    'passed',
    'reviewedAt',
    'reviewHash',
  ],
  properties: {
    schemaVersion: { const: 'post-cleanup-review/v1' },
    cleanupPlanId: idSchema,
    cleanupPlanHash: sha256Schema,
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    outputArtifactId: idSchema,
    outputArtifactSha256: sha256Schema,
    outputManifestId: idSchema,
    strategy: { enum: ['trim', 'crop-reframe', 'cover'] },
    visual: {
      type: 'object',
      additionalProperties: false,
      required: [
        'passed',
        'contaminationRemoved',
        'outputPlayable',
        'durationAligned',
        'framingPreserved',
        'residualQuality',
        'reasonCodes',
      ],
      properties: {
        passed: { type: 'boolean' },
        contaminationRemoved: { type: 'boolean' },
        outputPlayable: { type: 'boolean' },
        durationAligned: { type: 'boolean' },
        framingPreserved: { type: 'boolean' },
        residualQuality: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        reasonCodes: sourceCleanupReasonCodesSchema,
      },
    },
    rights: {
      type: 'object',
      additionalProperties: false,
      required: [
        'passed',
        'sourceRightsSnapshotId',
        'sourceRightsSnapshotHash',
        'outputRightsSnapshotId',
        'outputRightsSnapshotHash',
        'use',
        'reasonCodes',
      ],
      properties: {
        passed: { type: 'boolean' },
        sourceRightsSnapshotId: idSchema,
        sourceRightsSnapshotHash: sha256Schema,
        outputRightsSnapshotId: idSchema,
        outputRightsSnapshotHash: sha256Schema,
        use: { const: 'editing' },
        reasonCodes: sourceCleanupReasonCodesSchema,
      },
    },
    passed: { type: 'boolean' },
    reviewedAt: dateTimeSchema,
    reviewHash: sha256Schema,
  },
}
const sourceCleanupRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan'],
  properties: {
    plan: sourceCleanupPlanSchema,
    operation: publicOperationSchemaV5,
    postCleanupReview: postCleanupReviewSchema,
  },
}
const validationEnvelopeAspectSchema = {
  enum: ['copy', 'take', 'framing', 'timing', 'opening'],
}
const validationEnvelopeAspectArraySchema = {
  type: 'array',
  maxItems: 5,
  uniqueItems: true,
  items: validationEnvelopeAspectSchema,
}
const validationEnvelopeChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['aspect', 'required', 'rationale'],
  properties: {
    aspect: validationEnvelopeAspectSchema,
    required: { type: 'boolean' },
    rationale: { type: 'string', minLength: 3, maxLength: 500 },
  },
}
const validationEnvelopeAspectRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['aspect', 'state', 'source'],
  properties: {
    aspect: validationEnvelopeAspectSchema,
    state: { enum: ['protected', 'mutable'] },
    source: {
      enum: [
        'copy-evidence',
        'spoken-take-evidence',
        'opening-edit-evidence',
      ],
    },
  },
}
const validationEnvelopeClipSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'role',
    'source',
    'sourceArtifactId',
    'sourceHash',
    'sourceRangeMs',
    'sourceSegmentId',
    'durationMs',
  ],
  properties: {
    id: idSchema,
    role: { enum: ['hook', 'body', 'proof', 'cta'] },
    source: {
      enum: [
        'validated-segment-envelope',
        'target-variant-recipe',
      ],
    },
    sourceArtifactId: idSchema,
    sourceHash: sha256Schema,
    sourceRangeMs: contaminationRangeMsSchema,
    sourceSegmentId: idSchema,
    takeId: idSchema,
    durationMs: {
      type: 'integer',
      minimum: 1,
      maximum: 86_400_000,
    },
  },
}
const validationEnvelopeCompositionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'clips',
    'orderedRoles',
    'includedSourceSegmentIds',
    'excludedTargetRecipeSegmentIds',
    'targetRecipeHookExcluded',
    'validatedSourceOutsideEnvelopeIncluded',
    'excessMaterialIncluded',
    'durationMs',
    'compositionHash',
  ],
  properties: {
    schemaVersion: { const: 'validation-envelope-composition/v1' },
    clips: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      items: validationEnvelopeClipSchema,
    },
    orderedRoles: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      items: { enum: ['hook', 'body', 'proof', 'cta'] },
    },
    includedSourceSegmentIds: {
      type: 'array',
      minItems: 3,
      maxItems: 4,
      uniqueItems: true,
      items: idSchema,
    },
    excludedTargetRecipeSegmentIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: idSchema,
    },
    targetRecipeHookExcluded: { const: true },
    validatedSourceOutsideEnvelopeIncluded: { const: false },
    excessMaterialIncluded: { const: false },
    durationMs: {
      type: 'integer',
      minimum: 3,
      maximum: 86_400_000,
    },
    compositionHash: sha256Schema,
  },
}
const validationEnvelopeReusePlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'policyVersion',
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'validatedSegmentId',
    'validatedSegmentHash',
    'sourceArtifactId',
    'sourceArtifactSha256',
    'sourceRangeMs',
    'targetRecipeId',
    'targetRecipeHash',
    'objective',
    'aspectRules',
    'protectedAspects',
    'mutableAspects',
    'requestedChanges',
    'autoProtectedChanges',
    'approvalRequiredChanges',
    'approvalRequired',
    'initialValidation',
    'composition',
    'createdByClientId',
    'createdAt',
    'planHash',
  ],
  properties: {
    schemaVersion: { const: 'validation-envelope-reuse/v1' },
    policyVersion: { const: 'validation-envelope-policy/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    validatedSegmentId: idSchema,
    validatedSegmentHash: sha256Schema,
    sourceArtifactId: idSchema,
    sourceArtifactSha256: sha256Schema,
    sourceRangeMs: contaminationRangeMsSchema,
    targetRecipeId: idSchema,
    targetRecipeHash: sha256Schema,
    objective: idSchema,
    aspectRules: {
      type: 'array',
      minItems: 5,
      maxItems: 5,
      items: validationEnvelopeAspectRuleSchema,
    },
    protectedAspects: validationEnvelopeAspectArraySchema,
    mutableAspects: validationEnvelopeAspectArraySchema,
    requestedChanges: {
      type: 'array',
      maxItems: 5,
      items: validationEnvelopeChangeSchema,
    },
    autoProtectedChanges: validationEnvelopeAspectArraySchema,
    approvalRequiredChanges: validationEnvelopeAspectArraySchema,
    approvalRequired: { type: 'boolean' },
    initialValidation: {
      enum: ['preserved', 'pending-approval'],
    },
    composition: validationEnvelopeCompositionSchema,
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    planHash: sha256Schema,
  },
}
const validationEnvelopeDecisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'reusePlanId',
    'sequence',
    'kind',
    'outcome',
    'validation',
    'appliedChanges',
    'blockedChanges',
    'lostAspects',
    'note',
    'actorClientId',
    'createdAt',
    'decisionHash',
  ],
  properties: {
    schemaVersion: { const: 'validation-envelope-decision/v1' },
    id: idSchema,
    reusePlanId: idSchema,
    sequence: { type: 'integer', minimum: 1, maximum: 2 },
    kind: { enum: ['created', 'approval'] },
    outcome: {
      enum: [
        'ready',
        'approval-required',
        'approved',
        'rejected',
      ],
    },
    validation: {
      enum: ['preserved', 'pending-approval', 'lost'],
    },
    appliedChanges: validationEnvelopeAspectArraySchema,
    blockedChanges: validationEnvelopeAspectArraySchema,
    lostAspects: validationEnvelopeAspectArraySchema,
    note: { type: 'string', minLength: 3, maxLength: 1_000 },
    actorClientId: idSchema,
    createdAt: dateTimeSchema,
    decisionHash: sha256Schema,
  },
}
const validationEnvelopeReuseRecordSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['plan', 'decisions', 'currentDecision'],
  properties: {
    plan: validationEnvelopeReusePlanSchema,
    decisions: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: validationEnvelopeDecisionSchema,
    },
    currentDecision: validationEnvelopeDecisionSchema,
  },
}
const proofNeedClaimKindSchema = {
  enum: ['outcome', 'quantified', 'mechanism', 'low-risk'],
}
const proofNeedTypeSchema = {
  enum: ['testimonial', 'data', 'demonstration', 'none'],
}
const proofNeedFunctionSchema = {
  enum: [
    'build-trust',
    'substantiate-quantified-claim',
    'demonstrate-mechanism',
    'no-proof-needed',
  ],
}
const proofNeedResolutionSchema = {
  enum: [
    'selected-evidence',
    'proof-unavailable',
    'no-proof-needed',
  ],
}
const proofNeedMomentSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'placement',
    'afterStoryBlockId',
    'timelineFrame',
    'timelineMs',
  ],
  properties: {
    placement: {
      enum: [
        'existing-proof-block',
        'after-claim-before-next-block',
        'not-applicable',
      ],
    },
    afterStoryBlockId: idSchema,
    beforeStoryBlockId: idSchema,
    proofStoryBlockId: idSchema,
    timelineFrame: { type: 'integer', minimum: 0 },
    timelineMs: { type: 'integer', minimum: 0 },
  },
}
const proofNeedSearchSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'strategy',
    'attempted',
    'categories',
    'candidateEvidenceIds',
    'rejectedEvidence',
  ],
  properties: {
    strategy: { const: 'evidence-first' },
    attempted: { type: 'boolean' },
    categories: {
      type: 'array',
      maxItems: 4,
      uniqueItems: true,
      items: {
        enum: [
          'testimonial',
          'demonstration',
          'financial-result',
          'before-after',
          'hearsay',
          'authority',
          'case-study',
        ],
      },
    },
    candidateEvidenceIds: {
      type: 'array',
      maxItems: 80,
      uniqueItems: true,
      items: idSchema,
    },
    rejectedEvidence: {
      type: 'array',
      maxItems: 80,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['evidenceId', 'reasons'],
        properties: {
          evidenceId: idSchema,
          reasons: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            uniqueItems: true,
            items: {
              type: 'string',
              minLength: 3,
              maxLength: 128,
            },
          },
        },
      },
    },
  },
}
const proofNeedSelectedEvidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'evidenceHash',
    'category',
    'sourceArtifactId',
    'sourceRangeMs',
    'contextRangeMs',
    'score',
  ],
  properties: {
    id: idSchema,
    evidenceHash: sha256Schema,
    category: {
      enum: [
        'testimonial',
        'demonstration',
        'financial-result',
        'before-after',
        'hearsay',
        'authority',
        'case-study',
      ],
    },
    sourceArtifactId: idSchema,
    sourceRangeMs: contaminationRangeMsSchema,
    contextRangeMs: contaminationRangeMsSchema,
    score: { type: 'number', minimum: 0, maximum: 1 },
  },
}
const proofNeedItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sequence',
    'storyBlockId',
    'claimId',
    'claimText',
    'claimKind',
    'type',
    'function',
    'required',
    'moment',
    'search',
    'resolution',
    'proofUnavailable',
    'genericCardGenerated',
    'itemHash',
  ],
  properties: {
    id: idSchema,
    sequence: { type: 'integer', minimum: 1, maximum: 16 },
    storyBlockId: idSchema,
    claimId: idSchema,
    claimText: { type: 'string', minLength: 2, maxLength: 2_000 },
    claimKind: proofNeedClaimKindSchema,
    type: proofNeedTypeSchema,
    function: proofNeedFunctionSchema,
    required: { type: 'boolean' },
    moment: proofNeedMomentSchema,
    search: proofNeedSearchSchema,
    resolution: proofNeedResolutionSchema,
    selectedEvidence: proofNeedSelectedEvidenceSchema,
    proofUnavailable: { type: 'boolean' },
    genericCardGenerated: { const: false },
    itemHash: sha256Schema,
  },
}
const proofDirectedStoryPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'baseStoryPlanId',
    'baseStoryPlanHash',
    'objective',
    'acts',
    'blocks',
    'proofNeeds',
    'storyPlanHash',
  ],
  properties: {
    schemaVersion: { const: 'proof-directed-story-plan/v1' },
    id: idSchema,
    baseStoryPlanId: idSchema,
    baseStoryPlanHash: sha256Schema,
    objective: idSchema,
    acts: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'role', 'blockIds'],
        properties: {
          id: { enum: ['opening', 'development', 'resolution'] },
          role: { enum: ['opening', 'development', 'resolution'] },
          blockIds: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            uniqueItems: true,
            items: idSchema,
          },
        },
      },
    },
    blocks: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: variantRecipeStoryBlockSchema,
    },
    proofNeeds: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'storyBlockId',
          'claimId',
          'type',
          'function',
          'required',
          'moment',
          'resolution',
          'proofUnavailable',
        ],
        properties: {
          id: idSchema,
          storyBlockId: idSchema,
          claimId: idSchema,
          type: proofNeedTypeSchema,
          function: proofNeedFunctionSchema,
          required: { type: 'boolean' },
          moment: proofNeedMomentSchema,
          resolution: proofNeedResolutionSchema,
          selectedEvidenceId: idSchema,
          proofUnavailable: { type: 'boolean' },
        },
      },
    },
    storyPlanHash: sha256Schema,
  },
}
const proofNeedRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'policyVersion',
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'targetRecipeId',
    'targetRecipeHash',
    'baseStoryPlanId',
    'baseStoryPlanHash',
    'objective',
    'storyPlan',
    'items',
    'summary',
    'createdByClientId',
    'createdAt',
    'runHash',
  ],
  properties: {
    schemaVersion: { const: 'proof-need-run/v1' },
    policyVersion: { const: 'proof-need-policy/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    targetRecipeId: idSchema,
    targetRecipeHash: sha256Schema,
    baseStoryPlanId: idSchema,
    baseStoryPlanHash: sha256Schema,
    objective: idSchema,
    storyPlan: proofDirectedStoryPlanSchema,
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: proofNeedItemSchema,
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'needCount',
        'requiredCount',
        'evidenceSearchCount',
        'selectedEvidenceCount',
        'proofUnavailableCount',
        'noProofNeededCount',
        'genericCardCount',
      ],
      properties: {
        needCount: { type: 'integer', minimum: 1, maximum: 16 },
        requiredCount: { type: 'integer', minimum: 0, maximum: 16 },
        evidenceSearchCount: {
          type: 'integer',
          minimum: 0,
          maximum: 16,
        },
        selectedEvidenceCount: {
          type: 'integer',
          minimum: 0,
          maximum: 16,
        },
        proofUnavailableCount: {
          type: 'integer',
          minimum: 0,
          maximum: 16,
        },
        noProofNeededCount: {
          type: 'integer',
          minimum: 0,
          maximum: 16,
        },
        genericCardCount: { const: 0 },
      },
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    runHash: sha256Schema,
  },
}

const contiguousScoreSchema = {
  type: 'number',
  minimum: 0,
  maximum: 1,
}

const contiguousRangeMsSchema = {
  type: 'array',
  minItems: 2,
  maxItems: 2,
  items: {
    type: 'integer',
    minimum: 0,
    maximum: 43_200_000,
  },
}

const contiguousActorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'id'],
  properties: {
    type: { const: 'api-client' },
    id: idSchema,
  },
}

const contiguousScoreBreakdownSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'selfContained',
    'density',
    'integrity',
    'audio',
    'visual',
    'duration',
  ],
  properties: {
    selfContained: contiguousScoreSchema,
    density: contiguousScoreSchema,
    integrity: contiguousScoreSchema,
    audio: contiguousScoreSchema,
    visual: contiguousScoreSchema,
    duration: contiguousScoreSchema,
  },
}

const contiguousExtractionCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sourceIndexRunId',
    'sourceMomentId',
    'sourceMomentHash',
    'sourceEvaluationId',
    'sourceEvaluationHash',
    'sourceEvaluationProducer',
    'sourceRangeMs',
    'durationMs',
    'durationDeltaMs',
    'score',
    'scoreBreakdown',
    'evidenceRefs',
    'candidateHash',
  ],
  properties: {
    sourceIndexRunId: idSchema,
    sourceMomentId: idSchema,
    sourceMomentHash: sha256Schema,
    sourceEvaluationId: idSchema,
    sourceEvaluationHash: sha256Schema,
    sourceEvaluationProducer: {
      type: 'object',
      additionalProperties: false,
      required: [
        'provider',
        'model',
        'version',
        'inputHash',
        'outputHash',
      ],
      properties: {
        provider: idSchema,
        model: idSchema,
        version: idSchema,
        inputHash: sha256Schema,
        outputHash: sha256Schema,
      },
    },
    sourceRangeMs: contiguousRangeMsSchema,
    durationMs: {
      type: 'integer',
      minimum: 1,
      maximum: 43_200_000,
    },
    durationDeltaMs: {
      type: 'integer',
      minimum: 0,
      maximum: 3_600_000,
    },
    score: contiguousScoreSchema,
    scoreBreakdown: contiguousScoreBreakdownSchema,
    evidenceRefs: {
      type: 'array',
      minItems: 5,
      maxItems: 160,
      uniqueItems: true,
      items: idSchema,
    },
    candidateHash: sha256Schema,
  },
}

const contiguousExtractionSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'policyVersion',
    'id',
    'workspaceId',
    'projectId',
    'objective',
    'topic',
    'targetDurationMs',
    'toleranceMs',
    'candidates',
    'selectedCandidateHash',
    'storyPlan',
    'editPlan',
    'resultHash',
    'createdBy',
    'createdAt',
  ],
  properties: {
    schemaVersion: {
      const: 'contiguous-extraction-result/v1',
    },
    policyVersion: { const: 'contiguous-extraction/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    objective: {
      type: 'string',
      minLength: 1,
      maxLength: 240,
    },
    topic: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
    },
    targetDurationMs: {
      type: 'integer',
      minimum: 1_000,
      maximum: 3_600_000,
    },
    toleranceMs: {
      type: 'integer',
      minimum: 0,
      maximum: 3_600_000,
    },
    candidates: {
      type: 'array',
      minItems: 1,
      maxItems: 10_000,
      items: contiguousExtractionCandidateSchema,
    },
    selectedCandidateHash: sha256Schema,
    storyPlan: {
      type: 'object',
      required: [
        'schemaVersion',
        'id',
        'mode',
        'sourceRangeId',
        'objective',
        'targetDurationMs',
        'acts',
        'blocks',
      ],
      properties: {
        schemaVersion: { const: 1 },
        id: idSchema,
        mode: { const: 'contiguous' },
        sourceRangeId: idSchema,
        objective: { type: 'string' },
        targetDurationMs: { type: 'object' },
        acts: { type: 'array', minItems: 1 },
        blocks: { type: 'array', minItems: 1, maxItems: 1 },
      },
    },
    editPlan: {
      type: 'object',
      required: [
        'schemaVersion',
        'state',
        'mode',
        'id',
        'storyPlanId',
        'fps',
        'durationFrames',
        'sources',
        'videoTracks',
        'synthesizedRanges',
        'lineageRefs',
        'movementPolicy',
        'selectionHash',
      ],
      properties: {
        schemaVersion: { const: 2 },
        state: { const: 'compiled' },
        mode: { const: 'contiguous' },
        id: idSchema,
        storyPlanId: idSchema,
        fps: { type: 'integer', minimum: 1, maximum: 120 },
        durationFrames: { type: 'integer', minimum: 1 },
        sources: { type: 'array', minItems: 1, maxItems: 1 },
        videoTracks: { type: 'array', minItems: 1, maxItems: 1 },
        synthesizedRanges: { const: false },
        lineageRefs: {
          type: 'array',
          minItems: 6,
          maxItems: 256,
          items: { type: 'string' },
        },
        movementPolicy: {
          type: 'object',
          additionalProperties: false,
          required: ['automaticZoom', 'reason'],
          properties: {
            automaticZoom: { const: false },
            reason: {
              const: 'contiguous-source-preservation',
            },
          },
        },
        selectionHash: sha256Schema,
      },
    },
    resultHash: sha256Schema,
    createdBy: contiguousActorSchema,
    createdAt: dateTimeSchema,
  },
}
const proofIntegrityOutcomeSchema = {
  enum: ['approved', 'blocked', 'not-applicable'],
}
const proofIntegrityReasonCodeSchema = {
  enum: [
    'PROOF_UNAVAILABLE',
    'EVIDENCE_MISSING',
    'EVIDENCE_IDENTITY_MISMATCH',
    'RECIPE_CLAIM_UNSPECIFIED',
    'RECIPE_CLAIM_MISMATCH',
    'RECIPE_PERSON_UNSPECIFIED',
    'RECIPE_PERIOD_UNSPECIFIED',
    'RECIPE_AUDIENCE_UNSPECIFIED',
    'EVIDENCE_AUDIENCE_UNSPECIFIED',
    'CLAIM_MISMATCH',
    'PRODUCT_MISMATCH',
    'PERSON_MISMATCH',
    'PERIOD_MISMATCH',
    'AUDIENCE_MISMATCH',
    'RIGHTS_SNAPSHOT_STALE',
    'RIGHTS_NOT_APPROVED',
    'RIGHTS_EXPIRED',
    'CONSENT_NOT_APPROVED',
    'CONSENT_EXPIRED',
    'EVIDENCE_INTEGRITY_BLOCKED',
    'CONTEXT_RANGE_MISSING',
    'CONTEXT_RANGE_INCOMPLETE',
    'ADJACENT_CONTEXT_MISSING',
  ],
}
const proofIntegrityUseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['includedAdjacentEvidenceIds'],
  properties: {
    includedContextRangeMs: contaminationRangeMsSchema,
    includedAdjacentEvidenceIds: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: idSchema,
    },
  },
}
const proofIntegrityRecipeContextSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'nodeId',
    'nodeHash',
    'contextHash',
    'claimId',
    'productId',
    'audienceTags',
    'consentRequirement',
    'contextHashBinding',
  ],
  properties: {
    nodeId: idSchema,
    nodeHash: sha256Schema,
    contextHash: sha256Schema,
    claimId: idSchema,
    claimText: {
      type: 'string',
      minLength: 2,
      maxLength: 2_000,
    },
    productId: idSchema,
    person: { type: 'string', minLength: 1, maxLength: 240 },
    period: { type: 'string', minLength: 1, maxLength: 240 },
    audienceTags: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 240 },
    },
    consentRequirement: {
      enum: ['approved', 'approved-or-not-required'],
    },
    contextHashBinding: sha256Schema,
  },
}
const proofIntegrityComparisonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['dimension', 'expected', 'actual', 'outcome'],
  properties: {
    dimension: {
      enum: [
        'claim',
        'product',
        'person',
        'period',
        'audience',
        'consent',
        'rights',
        'context',
      ],
    },
    expected: {
      type: 'array',
      maxItems: 128,
      items: { type: 'string', maxLength: 2_000 },
    },
    actual: {
      type: 'array',
      maxItems: 128,
      items: { type: 'string', maxLength: 2_000 },
    },
    outcome: {
      enum: ['match', 'mismatch', 'missing', 'expired'],
    },
    reasonCode: proofIntegrityReasonCodeSchema,
  },
}
const proofIntegrityPresentationSideSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['attribution', 'qualifiers', 'mandatory'],
  properties: {
    attribution: {
      type: 'string',
      minLength: 1,
      maxLength: 240,
    },
    qualifiers: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 500 },
    },
    mandatory: { const: true },
  },
}
const proofIntegrityPresentationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'evidenceId',
    'evidenceHash',
    'requiredContextRangeMs',
    'requiredAdjacentEvidenceIds',
    'visual',
    'verbal',
    'presentationHash',
  ],
  properties: {
    schemaVersion: { const: 'proof-integrity-presentation/v1' },
    evidenceId: idSchema,
    evidenceHash: sha256Schema,
    requiredContextRangeMs: contaminationRangeMsSchema,
    requiredAdjacentEvidenceIds: {
      type: 'array',
      maxItems: 64,
      uniqueItems: true,
      items: idSchema,
    },
    visual: proofIntegrityPresentationSideSchema,
    verbal: proofIntegrityPresentationSideSchema,
    presentationHash: sha256Schema,
  },
}
const proofIntegrityIssueSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'code',
    'severity',
    'reasonCodes',
    'actions',
    'fabricationSuggested',
    'message',
    'issueHash',
  ],
  properties: {
    code: { const: 'PROOF_INTEGRITY_BLOCKED' },
    severity: { const: 'hard' },
    reasonCodes: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      items: proofIntegrityReasonCodeSchema,
    },
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      uniqueItems: true,
      items: {
        enum: [
          'add-structured-recipe-context',
          'select-compatible-existing-evidence',
          'restore-required-evidence-context',
          'renew-rights-or-consent',
        ],
      },
    },
    fabricationSuggested: { const: false },
    message: {
      type: 'string',
      minLength: 1,
      maxLength: 1_000,
    },
    issueHash: sha256Schema,
  },
}
const proofIntegrityEvaluationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sequence',
    'proofNeedItemId',
    'proofNeedItemHash',
    'proofNeedResolution',
    'use',
    'comparisons',
    'outcome',
    'allowedForAssembly',
    'fabricationSuggested',
    'evaluatedAt',
    'evaluationHash',
  ],
  properties: {
    id: idSchema,
    sequence: { type: 'integer', minimum: 1, maximum: 16 },
    proofNeedItemId: idSchema,
    proofNeedItemHash: sha256Schema,
    proofNeedResolution: proofNeedResolutionSchema,
    selectedEvidenceId: idSchema,
    selectedEvidenceHash: sha256Schema,
    recipeContext: proofIntegrityRecipeContextSchema,
    use: proofIntegrityUseSchema,
    comparisons: {
      type: 'array',
      maxItems: 8,
      items: proofIntegrityComparisonSchema,
    },
    outcome: proofIntegrityOutcomeSchema,
    allowedForAssembly: { type: 'boolean' },
    presentation: proofIntegrityPresentationSchema,
    issue: proofIntegrityIssueSchema,
    fabricationSuggested: { const: false },
    evaluatedAt: dateTimeSchema,
    evaluationHash: sha256Schema,
  },
}
const proofIntegrityRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'policyVersion',
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'targetRecipeId',
    'targetRecipeHash',
    'proofNeedRunId',
    'proofNeedRunHash',
    'evaluations',
    'summary',
    'createdByClientId',
    'createdAt',
    'runHash',
  ],
  properties: {
    schemaVersion: { const: 'proof-integrity-run/v1' },
    policyVersion: { const: 'proof-integrity-policy/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    targetRecipeId: idSchema,
    targetRecipeHash: sha256Schema,
    proofNeedRunId: idSchema,
    proofNeedRunHash: sha256Schema,
    evaluations: {
      type: 'array',
      minItems: 1,
      maxItems: 16,
      items: proofIntegrityEvaluationSchema,
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'evaluationCount',
        'approvedCount',
        'blockedCount',
        'notApplicableCount',
        'hardIssueCount',
        'fabricationSuggestionCount',
        'readyForAssembly',
      ],
      properties: {
        evaluationCount: {
          type: 'integer',
          minimum: 1,
          maximum: 16,
        },
        approvedCount: {
          type: 'integer',
          minimum: 0,
          maximum: 16,
        },
        blockedCount: {
          type: 'integer',
          minimum: 0,
          maximum: 16,
        },
        notApplicableCount: {
          type: 'integer',
          minimum: 0,
          maximum: 16,
        },
        hardIssueCount: {
          type: 'integer',
          minimum: 0,
          maximum: 16,
        },
        fabricationSuggestionCount: { const: 0 },
        readyForAssembly: { type: 'boolean' },
      },
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    runHash: sha256Schema,
  },
}

const proofModeRectSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['x', 'y', 'width', 'height'],
  properties: {
    x: { type: 'integer', minimum: 0, maximum: 10_000 },
    y: { type: 'integer', minimum: 0, maximum: 10_000 },
    width: { type: 'integer', minimum: 2, maximum: 10_000 },
    height: { type: 'integer', minimum: 2, maximum: 10_000 },
  },
}
const proofModeLayoutSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'format',
    'canvas',
    'safeRegion',
    'evidenceRegion',
    'creditRegion',
    'qualifierRegion',
    'backgroundTreatment',
    'layoutHash',
  ],
  properties: {
    schemaVersion: { const: 'proof-mode-layout/v1' },
    format: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
    canvas: {
      type: 'object',
      additionalProperties: false,
      required: ['width', 'height'],
      properties: {
        width: { type: 'integer', minimum: 2, maximum: 10_000 },
        height: { type: 'integer', minimum: 2, maximum: 10_000 },
      },
    },
    safeRegion: proofModeRectSchema,
    evidenceRegion: proofModeRectSchema,
    presenterRegion: proofModeRectSchema,
    creditRegion: proofModeRectSchema,
    qualifierRegion: proofModeRectSchema,
    backgroundTreatment: {
      enum: ['source', 'dimmed-source', 'solid'],
    },
    layoutHash: sha256Schema,
  },
}
const proofModeTimingSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'timelineEntryFrame',
    'timelineEntryMs',
    'sourceContextRangeMs',
    'minimumDurationFrames',
    'targetDurationFrames',
    'maximumDurationFrames',
    'entryTransition',
    'exitTransition',
    'timingHash',
  ],
  properties: {
    timelineEntryFrame: {
      type: 'integer',
      minimum: 0,
      maximum: 100_000_000,
    },
    timelineEntryMs: {
      type: 'integer',
      minimum: 0,
      maximum: 86_400_000,
    },
    sourceContextRangeMs: contaminationRangeMsSchema,
    minimumDurationFrames: {
      type: 'integer',
      minimum: 1,
      maximum: 100_000,
    },
    targetDurationFrames: {
      type: 'integer',
      minimum: 1,
      maximum: 100_000,
    },
    maximumDurationFrames: {
      type: 'integer',
      minimum: 1,
      maximum: 100_000,
    },
    entryTransition: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'durationFrames'],
      properties: {
        kind: { enum: ['cut', 'crossfade'] },
        durationFrames: {
          type: 'integer',
          minimum: 0,
          maximum: 120,
        },
      },
    },
    exitTransition: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'durationFrames'],
      properties: {
        kind: { enum: ['cut', 'crossfade'] },
        durationFrames: {
          type: 'integer',
          minimum: 0,
          maximum: 120,
        },
      },
    },
    timingHash: sha256Schema,
  },
}
const proofModePlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'sequence',
    'proofIntegrityEvaluationId',
    'proofIntegrityEvaluationHash',
    'proofNeedItemId',
    'proofNeedItemHash',
    'claimText',
    'sourceEvidenceId',
    'sourceEvidenceHash',
    'sourceArtifactId',
    'sourceMediaType',
    'format',
    'rhythm',
    'mode',
    'selection',
    'reasonCodes',
    'contextRequired',
    'identificationRequired',
    'presentation',
    'timing',
    'layout',
    'legibility',
    'rendererContract',
    'planHash',
  ],
  properties: {
    id: idSchema,
    sequence: { type: 'integer', minimum: 1, maximum: 80 },
    proofIntegrityEvaluationId: idSchema,
    proofIntegrityEvaluationHash: sha256Schema,
    proofNeedItemId: idSchema,
    proofNeedItemHash: sha256Schema,
    claimText: {
      type: 'string',
      minLength: 2,
      maxLength: 500,
    },
    sourceEvidenceId: idSchema,
    sourceEvidenceHash: sha256Schema,
    sourceArtifactId: idSchema,
    sourceMediaType: {
      enum: ['video', 'image', 'audio', 'document'],
    },
    format: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
    rhythm: { enum: ['fast', 'measured'] },
    mode: { enum: ['cutaway', 'split-screen', 'proof-card'] },
    selection: { enum: ['automatic', 'manual-override'] },
    reasonCodes: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      uniqueItems: true,
      items: {
        enum: [
          'CONTEXT_PRESERVED',
          'FAST_VISUAL_CUTAWAY',
          'MEASURED_VISUAL_CUTAWAY',
          'MEASURED_WIDE_SPLIT',
          'MEASURED_IMAGE_CARD',
          'NONVISUAL_PROOF_CARD',
          'MANUAL_OVERRIDE',
        ],
      },
    },
    contextRequired: { type: 'boolean' },
    identificationRequired: { const: true },
    presentation: proofIntegrityPresentationSchema,
    timing: proofModeTimingSchema,
    layout: proofModeLayoutSchema,
    legibility: {
      type: 'object',
      additionalProperties: false,
      required: [
        'minimumContrast',
        'minimumFontPixels',
        'maximumAttributionCharacters',
        'maximumQualifierCharacters',
        'safeAreaRequired',
      ],
      properties: {
        minimumContrast: { const: 4.5 },
        minimumFontPixels: {
          type: 'integer',
          minimum: 20,
          maximum: 500,
        },
        maximumAttributionCharacters: { const: 96 },
        maximumQualifierCharacters: { const: 160 },
        safeAreaRequired: { const: true },
      },
    },
    rendererContract: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'version', 'materializesNewMedia'],
      properties: {
        kind: { const: 'proof-presentation' },
        version: { const: 1 },
        materializesNewMedia: { const: false },
      },
    },
    planHash: sha256Schema,
  },
}
const proofModeRunSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'policyVersion',
    'id',
    'workspaceId',
    'projectId',
    'batchId',
    'proofIntegrityRunId',
    'proofIntegrityRunHash',
    'proofNeedRunId',
    'proofNeedRunHash',
    'formats',
    'rhythm',
    'plans',
    'summary',
    'createdByClientId',
    'createdAt',
    'runHash',
  ],
  properties: {
    schemaVersion: { const: 'proof-mode-run/v1' },
    policyVersion: { const: 'proof-mode-policy/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    batchId: idSchema,
    proofIntegrityRunId: idSchema,
    proofIntegrityRunHash: sha256Schema,
    proofNeedRunId: idSchema,
    proofNeedRunHash: sha256Schema,
    formats: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      uniqueItems: true,
      items: {
        enum: ['9:16', '16:9', '4:5', '1:1', '21:9'],
      },
    },
    rhythm: { enum: ['fast', 'measured'] },
    plans: {
      type: 'array',
      minItems: 1,
      maxItems: 80,
      items: proofModePlanSchema,
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'approvedEvidenceCount',
        'formatCount',
        'planCount',
        'automaticCount',
        'manualOverrideCount',
        'cutawayCount',
        'splitScreenCount',
        'proofCardCount',
        'allIntegrityBindingsPreserved',
        'readyForCompilation',
      ],
      properties: {
        approvedEvidenceCount: {
          type: 'integer',
          minimum: 1,
          maximum: 16,
        },
        formatCount: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
        },
        planCount: {
          type: 'integer',
          minimum: 1,
          maximum: 80,
        },
        automaticCount: {
          type: 'integer',
          minimum: 0,
          maximum: 80,
        },
        manualOverrideCount: {
          type: 'integer',
          minimum: 0,
          maximum: 80,
        },
        cutawayCount: {
          type: 'integer',
          minimum: 0,
          maximum: 80,
        },
        splitScreenCount: {
          type: 'integer',
          minimum: 0,
          maximum: 80,
        },
        proofCardCount: {
          type: 'integer',
          minimum: 0,
          maximum: 80,
        },
        allIntegrityBindingsPreserved: { const: true },
        readyForCompilation: { type: 'boolean' },
      },
    },
    createdByClientId: idSchema,
    createdAt: dateTimeSchema,
    runHash: sha256Schema,
  },
}

function defineSchema(
  id: string,
  version: number,
  title: string,
  body: Record<string, unknown>,
): PublicSchemaDefinition {
  const ref = `apollo://schemas/${id}/v${version}`
  assertDomain(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) && Number.isInteger(version) && version > 0,
    'INVALID_PUBLIC_SCHEMA',
    'Public schema id/version is invalid',
    { id, version },
  )
  return Object.freeze({
    ref,
    id,
    version,
    title,
    schema: Object.freeze({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: ref,
      title,
      ...body,
    }),
  })
}

function defineSchemaRegistry(definitions: readonly PublicSchemaDefinition[]) {
  const refs = new Set<string>()
  for (const definition of definitions) {
    assertDomain(
      !refs.has(definition.ref),
      'INVALID_PUBLIC_SCHEMA',
      'Public schema refs must be unique',
      { ref: definition.ref },
    )
    refs.add(definition.ref)
  }
  return Object.freeze([...definitions])
}

const colorMetadataSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['colorSpace', 'transfer', 'primaries', 'matrix', 'range', 'bitDepth'],
  properties: {
    colorSpace: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
    transfer: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
    primaries: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
    matrix: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
    range: { enum: ['full', 'limited'] },
    bitDepth: { type: 'integer', minimum: 8, maximum: 32 },
  },
} as const
const colorTransformSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'version', 'enabled', 'input', 'output', 'implementation'],
  properties: {
    id: idSchema,
    kind: { enum: ['technical', 'match', 'creative-lut', 'output'] },
    version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
    enabled: { type: 'boolean' },
    input: colorMetadataSchema,
    output: colorMetadataSchema,
    implementation: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'version', 'parameters', 'parametersHash'],
      properties: {
        provider: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
        version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
        parameters: {
          type: 'object',
          propertyNames: { pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$' },
          additionalProperties: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
            ],
          },
        },
        parametersHash: sha256Schema,
      },
    },
    lut: {
      type: 'object',
      additionalProperties: false,
      required: ['artifactId', 'sha256'],
      properties: { artifactId: idSchema, sha256: sha256Schema },
    },
  },
} as const
const colorTransformRequestSchema = {
  ...colorTransformSchema,
  required: ['id', 'kind', 'version', 'enabled', 'output', 'implementation'],
  properties: Object.fromEntries(
    Object.entries(colorTransformSchema.properties).filter(([key]) => key !== 'input'),
  ),
} as const
const resolvedColorPipelineSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'sourceMetadata', 'outputMetadata', 'stages', 'target', 'manifestKey', 'pipelineHash'],
  properties: {
    schemaVersion: { const: 'resolved-color-pipeline/v1' },
    sourceMetadata: colorMetadataSchema,
    outputMetadata: colorMetadataSchema,
    stages: {
      type: 'array', minItems: 4, maxItems: 4,
      items: colorTransformSchema,
    },
    target: {
      type: 'object', additionalProperties: false, required: ['sourceId'],
      properties: { sourceId: idSchema },
    },
    manifestKey: { type: 'string', minLength: 1, maxLength: 1024 },
    pipelineHash: sha256Schema,
  },
} as const
const colorPipelineCompilationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'id', 'workspaceId', 'projectId', 'sourceArtifactId',
    'sourceManifestId', 'colorProbeId', 'colorProbeHash', 'pipeline',
    'createdBy', 'createdAt', 'compilationHash',
  ],
  properties: {
    schemaVersion: { const: 'color-pipeline-compilation/v1' },
    id: idSchema,
    workspaceId: idSchema,
    projectId: idSchema,
    sourceArtifactId: idSchema,
    sourceManifestId: idSchema,
    colorProbeId: idSchema,
    colorProbeHash: sha256Schema,
    pipeline: resolvedColorPipelineSchema,
    createdBy: {
      type: 'object', additionalProperties: false, required: ['type', 'id'],
      properties: { type: { const: 'api-client' }, id: idSchema },
    },
    createdAt: dateTimeSchema,
    compilationHash: sha256Schema,
  },
} as const

function projectManualTimelineBody(timeline: Record<string, unknown>) {
  return successSchema({
    type: 'object',
    additionalProperties: false,
    required: ['timeline', 'baseHash', 'editPlanHash', 'history'],
    properties: {
      timeline,
      baseHash: sha256Schema,
      editPlanHash: sha256Schema,
      history: {
        type: 'array',
        maxItems: 40,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'sequence', 'createdAt'],
          properties: {
            id: idSchema,
            sequence: { type: 'integer', minimum: 1 },
            parentVersionId: idSchema,
            commandId: idSchema,
            commandType: { type: 'string', minLength: 1, maxLength: 80 },
            action: { enum: ['apply', 'undo', 'redo', 'restore'] },
            restoresVersionId: idSchema,
            createdAt: dateTimeSchema,
          },
        },
      },
    },
  })
}

function applyProjectManualEditRequestBody(operation: Record<string, unknown>) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'action', 'baseVersionId', 'baseHash', 'expectedRevision', 'variantId', 'targetId',
    ],
    properties: {
      action: { enum: ['apply', 'undo', 'redo', 'restore'] },
      baseVersionId: idSchema,
      baseHash: sha256Schema,
      expectedRevision: { type: 'integer', minimum: 1 },
      variantId: idSchema,
      targetId: idSchema,
      operation,
      targetVersionId: idSchema,
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    oneOf: [
      {
        required: ['operation'],
        properties: {
          action: { const: 'apply' },
          operation: {},
          targetVersionId: false,
        },
      },
      {
        required: ['targetVersionId'],
        properties: {
          action: { enum: ['undo', 'redo', 'restore'] },
          operation: false,
          targetVersionId: {},
        },
      },
    ],
  }
}

function projectManualEditAppliedBody(
  timeline: Record<string, unknown>,
  includeVisibleVersionState = false,
) {
  return successSchema({
    type: 'object',
    additionalProperties: false,
    required: ['command', 'version', 'timeline', 'comparison', 'operation', 'replayed'],
    properties: {
      command: {
        type: 'object', additionalProperties: false,
        required: [
          'id', 'type', 'action', 'baseVersionId', 'resultVersionId',
          'scope', 'payload', 'createdAt',
        ],
        properties: {
          id: idSchema, type: { const: 'manual-edit' }, action: { enum: ['apply', 'undo', 'redo', 'restore'] },
          baseVersionId: idSchema, resultVersionId: idSchema,
          scope: { type: 'object' }, payload: { type: 'object' }, createdAt: dateTimeSchema,
        },
      },
      version: {
        type: 'object', additionalProperties: false,
        required: [
          'id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt',
          ...(includeVisibleVersionState ? ['visibleState'] : []),
        ],
        properties: {
          id: idSchema, sequence: { type: 'integer', minimum: 2 }, parentVersionId: idSchema,
          baseHash: sha256Schema,
          snapshotRefs: {
            type: 'object',
            required: ['brief', 'editPlan', 'policies'],
            properties: { brief: idSchema, editPlan: idSchema, policies: idSchema },
          },
          createdAt: dateTimeSchema,
          ...(includeVisibleVersionState
            ? { visibleState: currentProjectVersionVisibleStateSchema }
            : {}),
        },
      },
      timeline,
      comparison: {
        type: 'object', additionalProperties: false,
        required: [
          'beforeVersionId', 'afterVersionId', 'beforeEditPlanHash',
          'afterEditPlanHash', 'action', 'targetId',
        ],
        properties: {
          beforeVersionId: idSchema, afterVersionId: idSchema,
          beforeEditPlanHash: sha256Schema, afterEditPlanHash: sha256Schema,
          action: { enum: ['apply', 'undo', 'redo', 'restore'] }, targetId: idSchema,
        },
      },
      operation: publicOperationSchemaV3,
      replayed: { type: 'boolean' },
    },
  })
}

function projectVersionComparisonActionResultBody(
  timeline: Record<string, unknown>,
  impact?: Record<string, unknown>,
  includeVisibleRestoreVersionState = false,
) {
  return successSchema({
    oneOf: [
      {
        type: 'object', additionalProperties: false,
        required: [
          'action', 'command', 'projectStatus', 'comparison',
          'versionsPreserved', 'replayed', ...(impact ? ['impact'] : []),
        ],
        properties: {
          action: { enum: ['accept', 'reopen'] },
          command: {
            type: 'object', additionalProperties: false,
            required: ['id', 'type', 'baseVersionId', 'scope', 'payload', 'createdAt'],
            properties: {
              id: idSchema, type: { const: 'compare-action' }, baseVersionId: idSchema,
              scope: { type: 'object' }, payload: { type: 'object' }, createdAt: dateTimeSchema,
            },
          },
          projectStatus: { enum: ['reviewing-proxy', 'revising'] },
          comparison: versionComparisonSchema,
          ...(impact ? { impact } : {}),
          versionsPreserved: { const: true },
          replayed: { type: 'boolean' },
        },
      },
      {
        type: 'object', additionalProperties: false,
        required: [
          'action', 'command', 'version', 'timeline', 'comparison',
          'versionsPreserved', 'operation', 'replayed',
        ],
        properties: {
          action: { const: 'restore' },
          command: {
            type: 'object', additionalProperties: false,
            required: [
              'id', 'type', 'baseVersionId', 'resultVersionId',
              'scope', 'payload', 'createdAt',
            ],
            properties: {
              id: idSchema, type: { const: 'manual-edit' },
              baseVersionId: idSchema, resultVersionId: idSchema,
              scope: { type: 'object' }, payload: { type: 'object' }, createdAt: dateTimeSchema,
            },
          },
          version: {
            type: 'object', additionalProperties: false,
            required: [
              'id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt',
              ...(includeVisibleRestoreVersionState ? ['visibleState'] : []),
            ],
            properties: {
              id: idSchema, sequence: { type: 'integer', minimum: 2 },
              parentVersionId: idSchema, baseHash: sha256Schema,
              snapshotRefs: {
                type: 'object', required: ['brief', 'editPlan', 'policies'],
                properties: { brief: idSchema, editPlan: idSchema, policies: idSchema },
              },
              createdAt: dateTimeSchema,
              ...(includeVisibleRestoreVersionState
                ? { visibleState: currentProjectVersionVisibleStateSchema }
                : {}),
            },
          },
          timeline,
          comparison: versionComparisonSchema,
          versionsPreserved: { const: true },
          operation: publicOperationSchemaV3,
          replayed: { type: 'boolean' },
        },
      },
    ],
  })
}

export const PUBLIC_SCHEMAS = defineSchemaRegistry([
  defineSchema('health-response', 1, 'Health response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['service', 'status'],
      properties: {
        service: { const: 'apollo-video' },
        status: { const: 'ok' },
      },
    }),
  ),
  defineSchema('ui-session-create-request', 1, 'Human UI session login request', {
    type: 'object',
    additionalProperties: false,
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', minLength: 3, maxLength: 80 },
      password: { type: 'string', minLength: 12, maxLength: 256, writeOnly: true },
      next: { type: 'string', minLength: 1, maxLength: 1024, pattern: '^/(?!/)' },
    },
  }),
  defineSchema('ui-session-created', 1, 'Human UI session login response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'workspaceId', 'expiresAt', 'redirectTo'],
      properties: {
        subject: { type: 'string', minLength: 3, maxLength: 80 },
        workspaceId: idSchema,
        expiresAt: dateTimeSchema,
        redirectTo: { type: 'string', pattern: '^/(?!/)', maxLength: 1024 },
      },
    }),
  ),
  defineSchema('oidc-authorization-start-request', 1, 'OIDC authorization start request', {
    type: 'object',
    additionalProperties: false,
    properties: {
      next: { type: 'string', minLength: 1, maxLength: 1024, pattern: '^/(?!/)' },
    },
  }),
  defineSchema('oidc-authorization-started', 1, 'OIDC authorization start response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['authorizationUrl', 'recoveryUrl', 'expiresAt'],
      properties: {
        authorizationUrl: { type: 'string', format: 'uri', maxLength: 4096 },
        recoveryUrl: { type: 'string', format: 'uri', maxLength: 2048 },
        expiresAt: dateTimeSchema,
      },
    }),
  ),
  defineSchema('oidc-callback-request', 1, 'OIDC authorization callback request', {
    type: 'object',
    additionalProperties: false,
    required: ['code', 'state'],
    properties: {
      code: { type: 'string', minLength: 8, maxLength: 2048, pattern: '^[A-Za-z0-9._~-]+$' },
      state: { type: 'string', minLength: 43, maxLength: 43, pattern: '^[A-Za-z0-9_-]+$' },
    },
  }),
  defineSchema('oidc-session-created', 1, 'OIDC human session response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId', 'memberId', 'role', 'expiresAt', 'redirectTo'],
      properties: {
        workspaceId: idSchema,
        memberId: { type: 'string', format: 'uuid' },
        role: { enum: ['administrator', 'operator', 'director', 'reviewer', 'viewer'] },
        expiresAt: dateTimeSchema,
        redirectTo: { type: 'string', pattern: '^/(?!/)', maxLength: 1024 },
      },
    }),
  ),
  defineSchema('ui-session-status', 1, 'Current human UI session response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'workspaceId', 'expiresAt'],
      properties: {
        subject: { type: 'string', minLength: 3, maxLength: 80 },
        workspaceId: idSchema,
        expiresAt: dateTimeSchema,
      },
    }),
  ),
  defineSchema('ui-session-ended', 1, 'Human UI session logout response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['signedOut'],
      properties: { signedOut: { const: true } },
    }),
  ),
  defineSchema('capability-list', 1, 'Capability list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['capabilities'],
      properties: {
        capabilities: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id', 'version', 'title', 'description', 'operationKind', 'authMode',
              'requiredScopes', 'outputSchemaRef', 'endpoint', 'toolName',
              'supportsDryRun', 'costClass', 'confirmation', 'successStatuses',
              'idempotency', 'responseMediaType',
            ],
            properties: {
              id: { type: 'string', pattern: '^apollo\\.' },
              version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
              title: { type: 'string' },
              description: { type: 'string' },
              operationKind: { enum: ['query', 'command', 'preflight', 'job'] },
              authMode: { enum: ['none', 'optional', 'required'] },
              requiredScopes: { type: 'array', items: { type: 'string' }, uniqueItems: true },
              inputSchemaRef: { type: 'string' },
              outputSchemaRef: { type: 'string' },
              endpoint: {
                type: 'object',
                additionalProperties: false,
                required: ['method', 'path'],
                properties: {
                  method: { enum: ['GET', 'POST', 'PATCH', 'DELETE'] },
                  path: { type: 'string', pattern: '^/v1/' },
                },
              },
              toolName: { type: 'string' },
              supportsDryRun: { type: 'boolean' },
              costClass: { enum: ['free', 'low', 'medium', 'high', 'variable'] },
              confirmation: { enum: ['none', 'preflight-token', 'human-approval'] },
              successStatuses: { type: 'array', items: { type: 'integer' }, uniqueItems: true },
              idempotency: { enum: ['not-applicable', 'required', 'natural'] },
              queryParameters: { type: 'array', items: { type: 'object' } },
              requestBodyRequired: { type: 'boolean' },
              responseMediaType: {
                enum: ['application/json', 'application/schema+json'],
              },
            },
          },
        },
      },
    }),
  ),
  defineSchema('public-event', 1, 'Public event envelope', publicEventSchema),
  defineSchema('event-catalog', 1, 'Public event catalog response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['envelopeSchemaRef', 'events'],
      properties: {
        envelopeSchemaRef: { const: 'apollo://schemas/public-event/v1' },
        events: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['type', 'version', 'resourceType', 'description'],
            properties: {
              type: { type: 'string', enum: publicEventTypes },
              version: { const: '1.0.0' },
              resourceType: { type: 'string', enum: publicEventResourceTypes },
              description: { type: 'string', minLength: 1, maxLength: 512 },
            },
          },
        },
      },
    }),
  ),
  defineSchema('project-list', 1, 'Project list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['projects'],
      properties: { projects: { type: 'array', items: projectSchema } },
    }),
  ),
  defineSchema('capability-list', 2, 'Capability list with explicit authentication scheme',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['capabilities'],
      properties: {
        capabilities: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'id', 'version', 'title', 'description', 'operationKind', 'authMode',
              'authScheme', 'requiredScopes', 'outputSchemaRef', 'endpoint',
              'supportsDryRun', 'costClass', 'confirmation', 'successStatuses',
              'idempotency', 'responseMediaType',
            ],
            properties: {
              id: { type: 'string', pattern: '^apollo\\.' },
              version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
              title: { type: 'string' },
              description: { type: 'string' },
              operationKind: { enum: ['query', 'command', 'preflight', 'job'] },
              authMode: { enum: ['none', 'optional', 'required'] },
              authScheme: { enum: ['none', 'bearer', 'ui-session'] },
              requiredScopes: { type: 'array', items: { type: 'string' }, uniqueItems: true },
              inputSchemaRef: { type: 'string' },
              outputSchemaRef: { type: 'string' },
              endpoint: {
                type: 'object',
                additionalProperties: false,
                required: ['method', 'path'],
                properties: {
                  method: { enum: ['GET', 'POST', 'PATCH', 'DELETE'] },
                  path: { type: 'string', pattern: '^/v1/' },
                },
              },
              toolName: { type: 'string' },
              supportsDryRun: { type: 'boolean' },
              costClass: { enum: ['free', 'low', 'medium', 'high', 'variable'] },
              confirmation: { enum: ['none', 'preflight-token', 'human-approval'] },
              successStatuses: { type: 'array', items: { type: 'integer' }, uniqueItems: true },
              idempotency: { enum: ['not-applicable', 'required', 'natural'] },
              queryParameters: { type: 'array', items: { type: 'object' } },
              requestBodyRequired: { type: 'boolean' },
              responseMediaType: { enum: ['application/json', 'application/schema+json'] },
            },
          },
        },
      },
    }),
  ),
  defineSchema('capability-list', 3, 'Capability list with signed transports and media types',
    successSchema({
      type: 'object', additionalProperties: false, required: ['capabilities'],
      properties: {
        capabilities: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: [
              'id', 'version', 'title', 'description', 'operationKind', 'authMode',
              'authScheme', 'requiredScopes', 'outputSchemaRef', 'endpoint',
              'supportsDryRun', 'costClass', 'confirmation', 'successStatuses',
              'idempotency', 'requestMediaType', 'responseMediaType',
            ],
            properties: {
              id: { type: 'string', pattern: '^apollo\\.' }, version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
              title: { type: 'string' }, description: { type: 'string' }, operationKind: { enum: ['query', 'command', 'preflight', 'job'] },
              authMode: { enum: ['none', 'optional', 'required'] }, authScheme: { enum: ['none', 'bearer', 'ui-session', 'signed-token'] },
              requiredScopes: { type: 'array', items: { type: 'string' }, uniqueItems: true }, inputSchemaRef: { type: 'string' }, outputSchemaRef: { type: 'string' },
              endpoint: { type: 'object', additionalProperties: false, required: ['method', 'path'], properties: { method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', pattern: '^/v1/' } } },
              toolName: { type: 'string' }, supportsDryRun: { type: 'boolean' }, costClass: { enum: ['free', 'low', 'medium', 'high', 'variable'] },
              confirmation: { enum: ['none', 'preflight-token', 'human-approval'] }, successStatuses: { type: 'array', items: { type: 'integer' }, uniqueItems: true },
              idempotency: { enum: ['not-applicable', 'required', 'natural'] }, queryParameters: { type: 'array', items: { type: 'object' } },
              requestBodyRequired: { type: 'boolean' }, requestMediaType: { enum: ['application/json', 'application/octet-stream'] },
              responseMediaType: { enum: ['application/json', 'application/schema+json', 'application/octet-stream'] },
            },
          },
        },
      },
    }),
  ),
  defineSchema('project-list', 2, 'Paginated project list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['projects'],
      properties: {
        projects: { type: 'array', items: projectSchema },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024 },
      },
    }),
  ),
  defineSchema('artifact-detail', 1, 'Media artifact detail response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifact', 'manifests'],
      properties: {
        artifact: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id', 'workspaceId', 'artifactKey', 'sha256', 'byteSize',
            'mediaType', 'container', 'status', 'createdAt',
          ],
          properties: {
            id: idSchema,
            workspaceId: idSchema,
            artifactKey: { type: 'string', minLength: 1, maxLength: 512 },
            sha256: sha256Schema,
            byteSize: { type: 'string', pattern: '^[1-9][0-9]*$' },
            mediaType: { enum: ['video', 'audio', 'image'] },
            container: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
            status: { enum: ['available', 'quarantined', 'deleted'] },
            createdAt: dateTimeSchema,
          },
        },
        manifests: { type: 'array', items: artifactManifestSchema },
      },
    }),
  ),
  defineSchema('artifact-detail', 2, 'Artifact detail response including immutable font and auxiliary data resources',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifact', 'manifests'],
      properties: {
        artifact: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id', 'workspaceId', 'artifactKey', 'sha256', 'byteSize',
            'mediaType', 'container', 'status', 'createdAt',
          ],
          properties: {
            id: idSchema,
            workspaceId: idSchema,
            artifactKey: { type: 'string', minLength: 1, maxLength: 512 },
            sha256: sha256Schema,
            byteSize: { type: 'string', pattern: '^[1-9][0-9]*$' },
            mediaType: { enum: ['video', 'audio', 'image', 'font', 'data'] },
            container: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
            status: { enum: ['available', 'quarantined', 'deleted'] },
            createdAt: dateTimeSchema,
          },
        },
        manifests: { type: 'array', items: artifactManifestSchema },
      },
    }),
  ),
  defineSchema('artifact-lineage-diagnostic', 1, 'Media artifact lineage diagnostic response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifactId', 'manifestId', 'healthy', 'nodes', 'edges', 'issues', 'limits'],
      properties: {
        artifactId: idSchema,
        manifestId: idSchema,
        healthy: { type: 'boolean' },
        nodes: {
          type: 'array',
          uniqueItems: true,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['artifactId', 'artifactKey', 'sha256', 'status', 'manifestCount'],
            properties: {
              artifactId: idSchema,
              artifactKey: { type: 'string', minLength: 1, maxLength: 512 },
              sha256: sha256Schema,
              status: { enum: ['available', 'quarantined', 'deleted'] },
              manifestCount: { type: 'integer', minimum: 0 },
              selectedManifest: lineageDiagnosticManifestSchema,
            },
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sourceArtifactId', 'targetArtifactId', 'sha256', 'role', 'ordinal'],
            properties: {
              sourceArtifactId: idSchema,
              targetArtifactId: idSchema,
              sha256: sha256Schema,
              role: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
              ordinal: { type: 'integer', minimum: 0 },
            },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'artifactId', 'message'],
            properties: {
              code: {
                enum: [
                  'ARTIFACT_UNAVAILABLE', 'MANIFEST_MISSING', 'SOURCE_NOT_FOUND',
                  'SOURCE_CHECKSUM_MISMATCH', 'SOURCE_INTEGRITY_FAILURE',
                  'LINEAGE_CYCLE', 'GRAPH_LIMIT_EXCEEDED', 'DEPTH_LIMIT_EXCEEDED',
                ],
              },
              artifactId: idSchema,
              message: { type: 'string', minLength: 1 },
            },
          },
        },
        limits: {
          type: 'object',
          additionalProperties: false,
          required: ['maxNodes', 'maxDepth', 'truncated'],
          properties: {
            maxNodes: { type: 'integer', minimum: 1 },
            maxDepth: { type: 'integer', minimum: 0 },
            truncated: { type: 'boolean' },
          },
        },
      },
    }),
  ),
  defineSchema('artifact-execution-provenance', 1, 'Artifact execution provenance response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'artifactId', 'manifestId', 'schemaVersion', 'manifestHash',
        'complete', 'edges', 'issues',
      ],
      properties: {
        artifactId: idSchema,
        manifestId: idSchema,
        schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
        manifestHash: sha256Schema,
        complete: { type: 'boolean' },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['sourceArtifactId', 'role', 'ordinal'],
            properties: {
              sourceArtifactId: idSchema,
              role: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
              ordinal: { type: 'integer', minimum: 0 },
              execution: executionProvenanceSchema,
            },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'sourceArtifactId', 'ordinal', 'message'],
            properties: {
              code: { const: 'EXECUTION_PROVENANCE_MISSING' },
              sourceArtifactId: idSchema,
              ordinal: { type: 'integer', minimum: 0 },
              message: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    }),
  ),
  defineSchema('artifact-replay-spec', 1, 'Artifact replay specification response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'artifactId', 'manifestId', 'schemaVersion', 'manifestHash',
        'recipe', 'available', 'issues',
      ],
      properties: {
        artifactId: idSchema,
        manifestId: idSchema,
        schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
        manifestHash: sha256Schema,
        recipe: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'version', 'parametersHash'],
          properties: {
            id: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
            version: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]*$' },
            parametersHash: sha256Schema,
          },
        },
        available: { type: 'boolean' },
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'canonicalByteSize', 'protection'],
          properties: {
            ref: {
              type: 'string',
              pattern: '^recipe-parameters/sha256/[a-f0-9]{64}$',
            },
            canonicalByteSize: {
              type: 'integer',
              minimum: 1,
              maximum: 1048576,
            },
            protection: {
              type: 'object',
              additionalProperties: false,
              required: ['algorithm'],
              properties: { algorithm: { const: 'aes-256-gcm' } },
            },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: {
              code: { const: 'REPLAY_PARAMETERS_MISSING' },
              message: { type: 'string', minLength: 1 },
            },
          },
        },
      },
      allOf: [
        {
          if: { properties: { available: { const: true } } },
          then: {
            required: ['parameters'],
            properties: {
              parameters: { type: 'object' },
              issues: { type: 'array', maxItems: 0 },
            },
          },
        },
        {
          if: { properties: { available: { const: false } } },
          then: {
            not: { required: ['parameters'] },
            properties: { issues: { type: 'array', minItems: 1 } },
          },
        },
      ],
    }),
  ),
  defineSchema('artifact-render-input', 1, 'Artifact RenderInput metadata response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'artifactId', 'manifestId', 'schemaVersion', 'manifestHash',
        'available', 'issues',
      ],
      properties: {
        artifactId: idSchema,
        manifestId: idSchema,
        schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
        manifestHash: sha256Schema,
        available: { type: 'boolean' },
        renderInput: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'inputHash', 'canonicalByteSize', 'protection'],
          properties: {
            ref: {
              type: 'string',
              pattern: '^render-input/sha256/[a-f0-9]{64}$',
            },
            inputHash: sha256Schema,
            canonicalByteSize: {
              type: 'integer',
              minimum: 1,
              maximum: 4194304,
            },
            protection: {
              type: 'object',
              additionalProperties: false,
              required: ['algorithm'],
              properties: { algorithm: { const: 'aes-256-gcm' } },
            },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: {
              code: { const: 'RENDER_INPUT_MISSING' },
              message: { type: 'string', minLength: 1 },
            },
          },
        },
      },
      allOf: [
        {
          if: { properties: { available: { const: true } } },
          then: {
            required: ['renderInput'],
            properties: {
              renderInput: { type: 'object' },
              issues: { type: 'array', maxItems: 0 },
            },
          },
        },
        {
          if: { properties: { available: { const: false } } },
          then: {
            not: { required: ['renderInput'] },
            properties: { issues: { type: 'array', minItems: 1 } },
          },
        },
      ],
    }),
  ),
  defineSchema('artifact-reconstruction-preflight', 1, 'Artifact reconstruction preflight response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'artifactId', 'manifestId', 'schemaVersion', 'manifestHash',
        'validationScope', 'rightsValidationRequired', 'materializationRequired',
        'payloadAuthenticated', 'eligible', 'assets', 'issues',
      ],
      properties: {
        artifactId: idSchema,
        manifestId: idSchema,
        schemaVersion: { type: 'string', minLength: 1, maxLength: 64 },
        manifestHash: sha256Schema,
        validationScope: { const: 'protected-input-and-asset-identity' },
        rightsValidationRequired: { const: true },
        materializationRequired: { const: true },
        payloadAuthenticated: { type: 'boolean' },
        eligible: { type: 'boolean' },
        inputHash: sha256Schema,
        renderer: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'version', 'digest', 'supported'],
          properties: {
            id: renderTokenSchema,
            version: renderTokenSchema,
            digest: sha256Schema,
            supported: { type: 'boolean' },
          },
        },
        composition: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'version', 'propsSchemaRef', 'supported'],
          properties: {
            id: renderTokenSchema,
            version: renderTokenSchema,
            propsSchemaRef: {
              type: 'string',
              pattern: '^apollo://render-props/[a-z0-9][a-z0-9-]*/v[1-9][0-9]*$',
            },
            supported: { type: 'boolean' },
          },
        },
        assets: {
          type: 'object',
          additionalProperties: false,
          required: ['total', 'available'],
          properties: {
            total: { type: 'integer', minimum: 0, maximum: 4096 },
            available: { type: 'integer', minimum: 0, maximum: 4096 },
          },
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['code', 'message'],
            properties: {
              code: {
                enum: [
                  'RENDER_INPUT_MISSING', 'RENDERER_UNAVAILABLE',
                  'COMPOSITION_UNAVAILABLE', 'ASSET_NOT_FOUND',
                  'ASSET_UNAVAILABLE', 'ASSET_IDENTITY_MISMATCH',
                  'ASSET_KIND_UNSUPPORTED',
                ],
              },
              message: { type: 'string', minLength: 1 },
              assetOrdinal: { type: 'integer', minimum: 0, maximum: 4095 },
              assetKind: { enum: ['video', 'audio', 'image', 'font', 'lut', 'data'] },
            },
          },
        },
      },
      allOf: [
        {
          if: { properties: { payloadAuthenticated: { const: true } } },
          then: {
            required: ['inputHash', 'renderer', 'composition'],
            properties: {
              inputHash: {},
              renderer: {},
              composition: {},
            },
          },
        },
        {
          if: { properties: { eligible: { const: true } } },
          then: { properties: { issues: { type: 'array', maxItems: 0 } } },
        },
        {
          if: { properties: { eligible: { const: false } } },
          then: { properties: { issues: { type: 'array', minItems: 1 } } },
        },
      ],
    }),
  ),
  defineSchema('set-asset-rights-request', 1, 'Set asset rights request',
    assetRightsDraftSchema,
  ),
  defineSchema('asset-rights-current', 1, 'Current asset rights response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifactId', 'configured'],
      properties: {
        artifactId: idSchema,
        configured: { type: 'boolean' },
        rights: assetRightsSnapshotSchema,
      },
      allOf: [
        {
          if: { properties: { configured: { const: true } }, required: ['configured'] },
          then: { required: ['rights'], properties: { rights: {} } },
          else: { properties: { rights: false } },
        },
      ],
    }),
  ),
  defineSchema('asset-rights-set', 1, 'Asset rights set response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifactId', 'rights', 'replayed'],
      properties: {
        artifactId: idSchema,
        rights: assetRightsSnapshotSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema(
    'authorize-materialization-request',
    1,
    'Authorize RenderInput materialization request',
    {
      type: 'object',
      additionalProperties: false,
      required: ['use'],
      properties: {
        use: rightsTokenSchema,
        market: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9-]{1,15}$' },
        syntheticOperations: rightsTokenArraySchema,
      },
    },
  ),
  defineSchema(
    'materialization-authorization',
    1,
    'RenderInput materialization authorization response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['authorization', 'replayed'],
      properties: {
        replayed: { type: 'boolean' },
        authorization: {
          type: 'object',
          additionalProperties: false,
          required: [
            'schemaVersion', 'id', 'artifactId', 'manifestId', 'inputHash',
            'use', 'locale', 'syntheticOperations', 'status', 'issues',
            'decisions', 'evaluatedAt', 'revalidationRequired',
          ],
          properties: {
            schemaVersion: { const: 'materialization-authorization/v1' },
            id: idSchema,
            artifactId: idSchema,
            manifestId: idSchema,
            inputHash: sha256Schema,
            use: rightsTokenSchema,
            market: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9-]{1,15}$' },
            locale: {
              type: 'string',
              pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
            },
            syntheticOperations: rightsTokenArraySchema,
            status: { enum: ['authorized', 'denied'] },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['code'],
                properties: {
                  code: {
                    enum: [
                      'RENDERER_UNAVAILABLE', 'COMPOSITION_UNAVAILABLE',
                      'ASSET_NOT_FOUND', 'ASSET_UNAVAILABLE',
                      'ASSET_IDENTITY_MISMATCH', 'ASSET_KIND_UNSUPPORTED',
                      'ASSET_RIGHTS_DENIED',
                    ],
                  },
                  assetOrdinal: { type: 'integer', minimum: 0, maximum: 4095 },
                  assetKind: { enum: ['video', 'audio', 'image', 'font', 'lut', 'data'] },
                },
              },
            },
            decisions: {
              type: 'array',
              maxItems: 4096,
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'artifactId', 'assetOrdinal', 'assetKind', 'outcome', 'reasonCodes',
                ],
                properties: {
                  artifactId: idSchema,
                  assetOrdinal: { type: 'integer', minimum: 0, maximum: 4095 },
                  assetKind: { enum: ['video', 'audio', 'image', 'font', 'lut', 'data'] },
                  outcome: { enum: ['allow', 'deny'] },
                  reasonCodes: {
                    type: 'array',
                    uniqueItems: true,
                    items: { enum: assetUseDenialCodes },
                  },
                  rightsSnapshotId: idSchema,
                  rightsSnapshotHash: sha256Schema,
                  validUntil: dateTimeSchema,
                },
                allOf: [
                  {
                    if: { properties: { outcome: { const: 'allow' } }, required: ['outcome'] },
                    then: {
                      required: ['rightsSnapshotId', 'rightsSnapshotHash', 'validUntil'],
                      properties: {
                        reasonCodes: { type: 'array', maxItems: 0 },
                        rightsSnapshotId: {},
                        rightsSnapshotHash: {},
                        validUntil: {},
                      },
                    },
                    else: { properties: { reasonCodes: { type: 'array', minItems: 1 } } },
                  },
                ],
              },
            },
            evaluatedAt: dateTimeSchema,
            validUntil: dateTimeSchema,
            revalidationRequired: { const: true },
          },
          allOf: [
            {
              if: { properties: { status: { const: 'authorized' } }, required: ['status'] },
              then: {
                required: ['validUntil'],
                properties: {
                  issues: { type: 'array', maxItems: 0 },
                  validUntil: {},
                },
              },
              else: {
                properties: {
                  issues: { type: 'array', minItems: 1 },
                  validUntil: false,
                },
              },
            },
          ],
        },
      },
    }),
  ),
  defineSchema('render-input-preflight-request', 1, 'Portable RenderInput preflight request', {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion', 'renderer', 'composition', 'plan',
      'output', 'assets', 'props',
    ],
    properties: {
      schemaVersion: { const: 'render-input/v1' },
      renderer: renderIdentitySchema,
      composition: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'version', 'propsSchemaRef'],
        properties: {
          id: renderTokenSchema,
          version: renderTokenSchema,
          propsSchemaRef: {
            type: 'string',
            pattern: '^apollo://render-props/[a-z0-9][a-z0-9-]*/v[1-9][0-9]*$',
          },
        },
      },
      plan: renderPlanSchema,
      output: renderOutputRequestSchema,
      assets: {
        type: 'array',
        maxItems: 4096,
        items: renderInputAssetSchema,
      },
      props: { type: 'object' },
    },
  }),
  defineSchema('render-input-preflight', 1, 'Portable RenderInput preflight response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion', 'validationScope', 'materializationRequired',
        'inputHash', 'renderer', 'composition',
        'plan', 'output', 'assetCount', 'totalAssetBytes',
      ],
      properties: {
        schemaVersion: { const: 'render-input/v1' },
        validationScope: { const: 'portable-envelope' },
        materializationRequired: { const: true },
        inputHash: sha256Schema,
        renderer: renderIdentitySchema,
        composition: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'version', 'propsSchemaRef', 'propsHash'],
          properties: {
            id: renderTokenSchema,
            version: renderTokenSchema,
            propsSchemaRef: {
              type: 'string',
              pattern: '^apollo://render-props/[a-z0-9][a-z0-9-]*/v[1-9][0-9]*$',
            },
            propsHash: sha256Schema,
          },
        },
        plan: renderPlanSchema,
        output: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id', 'locale', 'aspectRatio', 'width', 'height',
            'fps', 'durationInFrames',
          ],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 128 },
            locale: {
              type: 'string',
              pattern: '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$',
            },
            aspectRatio: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
            width: { type: 'integer', minimum: 2, multipleOf: 2 },
            height: { type: 'integer', minimum: 2, multipleOf: 2 },
            fps: { type: 'integer', minimum: 1, maximum: 120 },
            durationInFrames: { type: 'integer', minimum: 1, maximum: 5184000 },
          },
        },
        assetCount: { type: 'integer', minimum: 0, maximum: 4096 },
        totalAssetBytes: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
      },
    }),
  ),
  defineSchema('enqueue-artifact-render-request', 1, 'Authorized artifact render request', {
    type: 'object',
    additionalProperties: false,
    required: ['authorizationId'],
    properties: { authorizationId: idSchema },
  }),
  defineSchema('artifact-render-operation-accepted', 1, 'Accepted artifact render operation',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'replayed'],
      properties: {
        operation: publicOperationSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('public-operation-detail', 1, 'Public operation detail response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: publicOperationSchema },
    }),
  ),
  defineSchema('media-color-probe', 1, 'Immutable trusted colorimetry evidence bound to an exact artifact manifest',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['probe'],
      properties: {
        probe: {
          type: 'object',
          additionalProperties: false,
          required: [
            'schemaVersion',
            'id',
            'workspaceId',
            'artifactId',
            'manifestId',
            'detection',
            'producer',
            'createdAt',
            'probeHash',
          ],
          properties: {
            schemaVersion: { const: 'media-color-probe/v1' },
            id: idSchema,
            workspaceId: idSchema,
            artifactId: idSchema,
            manifestId: idSchema,
            detection: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: [
                    'state',
                    'metadata',
                    'pixelFormat',
                    'hdrMode',
                  ],
                  properties: {
                    state: { const: 'ready' },
                    metadata: {
                      type: 'object',
                      additionalProperties: false,
                      required: [
                        'colorSpace',
                        'transfer',
                        'primaries',
                        'matrix',
                        'range',
                        'bitDepth',
                      ],
                      properties: {
                        colorSpace: {
                          type: 'string',
                          pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
                        },
                        transfer: {
                          type: 'string',
                          pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
                        },
                        primaries: {
                          type: 'string',
                          pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
                        },
                        matrix: {
                          type: 'string',
                          pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
                        },
                        range: { enum: ['full', 'limited'] },
                        bitDepth: {
                          type: 'integer',
                          minimum: 8,
                          maximum: 32,
                        },
                      },
                    },
                    pixelFormat: {
                      type: 'string',
                      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
                    },
                    hdrMode: { enum: ['sdr', 'hlg', 'pq'] },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['state', 'reasons'],
                  properties: {
                    state: { const: 'unavailable' },
                    pixelFormat: {
                      type: 'string',
                      pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
                    },
                    reasons: {
                      type: 'array',
                      minItems: 1,
                      maxItems: 16,
                      uniqueItems: true,
                      items: {
                        type: 'string',
                        pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
                      },
                    },
                  },
                },
              ],
            },
            producer: {
              type: 'object',
              additionalProperties: false,
              required: ['provider', 'version', 'binaryDigest'],
              properties: {
                provider: { const: 'ffprobe' },
                version: {
                  type: 'string',
                  pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
                },
                binaryDigest: sha256Schema,
              },
            },
            createdAt: dateTimeSchema,
            probeHash: sha256Schema,
          },
        },
      },
    }),
  ),
  defineSchema(
    'create-color-pipeline-compilation-request',
    1,
    'Compile four explicit color transforms from trusted server-side source colorimetry',
    {
      type: 'object',
      additionalProperties: false,
      required: ['sourceArtifactId', 'sourceManifestId', 'outputMetadata', 'stages'],
      properties: {
        sourceArtifactId: idSchema,
        sourceManifestId: idSchema,
        outputMetadata: colorMetadataSchema,
        stages: {
          type: 'array', minItems: 4, maxItems: 4,
          items: colorTransformRequestSchema,
        },
      },
    },
  ),
  defineSchema(
    'color-pipeline-compilation-mutated',
    1,
    'Created or replayed immutable color pipeline compilation',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['compilation', 'replayed'],
      properties: {
        compilation: colorPipelineCompilationSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema(
    'color-pipeline-compilation-read',
    1,
    'Immutable trusted color pipeline compilation',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['compilation'],
      properties: { compilation: colorPipelineCompilationSchema },
    }),
  ),
  defineSchema('public-operation-detail', 2, 'Public operation detail response for render and media ingest',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: publicOperationSchemaV2 },
    }),
  ),
  defineSchema('public-operation-detail', 3, 'Public operation detail response including project proxy renders',
    successSchema({
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: { operation: publicOperationSchemaV3 },
    }),
  ),
  defineSchema('public-operation-detail', 4, 'Public operation detail including final project exports',
    successSchema({
      type: 'object', additionalProperties: false, required: ['operation'],
      properties: { operation: publicOperationSchemaV4 },
    }),
  ),
  defineSchema('public-operation-detail', 5, 'Public operation detail including source cleanup derivatives',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: publicOperationSchemaV5 },
    }),
  ),
  defineSchema('public-operation-detail', 6, 'Public operation detail including durable long-form indexing',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: publicOperationSchemaV6 },
    }),
  ),
  defineSchema('ui-session-status', 2, 'Current human UI session and selectable workspaces response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'workspaceId', 'memberId', 'role', 'expiresAt', 'workspaces'],
      properties: {
        subject: { type: 'string', minLength: 3, maxLength: 80 },
        workspaceId: idSchema,
        memberId: { type: 'string', format: 'uuid' },
        role: { enum: ['administrator', 'director', 'operator', 'reviewer'] },
        expiresAt: dateTimeSchema,
        workspaces: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['memberId', 'workspaceId', 'workspaceSlug', 'workspaceName', 'role'],
            properties: {
              memberId: { type: 'string', format: 'uuid' },
              workspaceId: idSchema,
              workspaceSlug: { type: 'string', minLength: 3, maxLength: 63, pattern: '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$' },
              workspaceName: { type: 'string', minLength: 2, maxLength: 120 },
              role: { enum: ['administrator', 'director', 'operator', 'reviewer'] },
            },
          },
        },
      },
    }),
  ),
  defineSchema('ui-workspace-switch-request', 1, 'Human UI workspace switch request', {
    type: 'object',
    additionalProperties: false,
    required: ['workspaceId'],
    properties: { workspaceId: idSchema },
  }),
  defineSchema('ui-workspace-switched', 1, 'Human UI workspace switch response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId', 'memberId', 'role', 'expiresAt', 'workspaces', 'rotated'],
      properties: {
        workspaceId: idSchema,
        memberId: { type: 'string', format: 'uuid' },
        role: { enum: ['administrator', 'director', 'operator', 'reviewer'] },
        expiresAt: dateTimeSchema,
        rotated: { type: 'boolean' },
        workspaces: {
          type: 'array', minItems: 1, maxItems: 100,
          items: {
            type: 'object', additionalProperties: false,
            required: ['memberId', 'workspaceId', 'workspaceSlug', 'workspaceName', 'role'],
            properties: {
              memberId: { type: 'string', format: 'uuid' }, workspaceId: idSchema,
              workspaceSlug: { type: 'string', minLength: 3, maxLength: 63 },
              workspaceName: { type: 'string', minLength: 2, maxLength: 120 },
              role: { enum: ['administrator', 'director', 'operator', 'reviewer'] },
            },
          },
        },
      },
    }),
  ),
  defineSchema('artifact-detail', 3, 'Artifact detail response with explicit lifecycle visible state',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifact', 'manifests'],
      properties: {
        artifact: mediaArtifactPublicSchemaV3,
        manifests: { type: 'array', items: artifactManifestSchema },
      },
    }),
  ),
  defineSchema('artifact-detail', 4, 'Artifact detail response with revision-fenced lifecycle state',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['artifact', 'manifests'],
      properties: {
        artifact: mediaArtifactPublicSchemaV4,
        manifests: { type: 'array', items: artifactManifestSchema },
      },
    }),
  ),
  defineSchema('media-artifact-lifecycle-transition-request', 1, 'Revision-fenced media artifact lifecycle transition request', {
    type: 'object',
    additionalProperties: false,
    required: ['baseRevision', 'targetStatus', 'reason'],
    properties: {
      baseRevision: { type: 'integer', minimum: 1, maximum: 2147483647 },
      targetStatus: { enum: ['available', 'quarantined', 'deleted'] },
      reason: { type: 'string', minLength: 3, maxLength: 500 },
    },
  }),
  defineSchema('media-artifact-lifecycle-transition-result', 1, 'Audited media artifact lifecycle transition result',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['transition', 'replayed'],
      properties: {
        transition: mediaArtifactLifecycleTransitionSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('public-operation-detail', 7, 'Public operation detail with an honest actionable visible-state projection',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: publicOperationSchemaV7 },
    }),
  ),
  defineSchema('public-operation-detail', 8, 'Project-filterable public operation detail with an honest actionable visible-state projection',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: publicOperationSchemaV8 },
    }),
  ),
  defineSchema('public-operation-detail', 9, 'Public operation detail with project-version targets for durable Director execution',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: publicOperationSchemaV9 },
    }),
  ),
  defineSchema('public-operation-detail', 10, 'Public operation detail with persisted cost estimates and terminal actual cost where a trustworthy source exists',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: publicOperationSchemaV10 },
    }),
  ),
  defineSchema('public-operation-detail', 11, 'Public operation detail including durable production batch item projections',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation'],
      properties: { operation: publicOperationSchemaV11 },
    }),
  ),
  defineSchema('project-final-export-attempt-history', 1, 'Immutable project final export attempt history',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operationId', 'projectId', 'projectVersionId', 'proxyReviewId', 'outputSpec', 'attempts'],
      properties: {
        operationId: idSchema,
        projectId: idSchema,
        projectVersionId: idSchema,
        proxyReviewId: idSchema,
        outputSpec: {
          type: 'object',
          additionalProperties: false,
          required: ['aspectRatio', 'width', 'height', 'fps', 'codec', 'audioCodec', 'container', 'quality'],
          properties: {
            aspectRatio: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
            width: { type: 'integer', minimum: 2, multipleOf: 2 },
            height: { type: 'integer', minimum: 2, multipleOf: 2 },
            fps: { type: 'integer', minimum: 1, maximum: 120 },
            codec: { const: 'h264' },
            audioCodec: { const: 'aac' },
            container: { const: 'mp4' },
            quality: { const: 'final' },
          },
        },
        attempts: {
          type: 'array',
          maxItems: 100,
          items: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['attempt', 'status', 'validators', 'error', 'startedAt', 'completedAt'],
                properties: {
                  attempt: { type: 'integer', minimum: 1 },
                  status: { const: 'failed' },
                  validators: {
                    type: 'array', minItems: 1, maxItems: 100,
                    items: {
                      type: 'object', additionalProperties: false,
                      required: ['code', 'passed', 'message'],
                      properties: {
                        code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,63}$' },
                        passed: { type: 'boolean' },
                        message: { type: 'string', minLength: 1, maxLength: 500 },
                      },
                    },
                  },
                  error: {
                    type: 'object', additionalProperties: false, required: ['code', 'message'],
                    properties: {
                      code: { type: 'string', minLength: 1, maxLength: 64 },
                      message: { type: 'string', minLength: 1, maxLength: 500 },
                    },
                  },
                  startedAt: dateTimeSchema,
                  completedAt: dateTimeSchema,
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                required: ['attempt', 'status', 'validators', 'output', 'startedAt', 'completedAt'],
                properties: {
                  attempt: { type: 'integer', minimum: 1 },
                  status: { const: 'promoted' },
                  validators: {
                    type: 'array', minItems: 1, maxItems: 100,
                    items: {
                      type: 'object', additionalProperties: false,
                      required: ['code', 'passed', 'message'],
                      properties: {
                        code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{2,63}$' },
                        passed: { type: 'boolean' },
                        message: { type: 'string', minLength: 1, maxLength: 500 },
                      },
                    },
                  },
                  output: {
                    type: 'object', additionalProperties: false,
                    required: ['artifactId', 'manifestId', 'sha256', 'byteSize'],
                    properties: {
                      artifactId: idSchema,
                      manifestId: idSchema,
                      sha256: sha256Schema,
                      byteSize: { type: 'integer', minimum: 1 },
                    },
                  },
                  startedAt: dateTimeSchema,
                  completedAt: dateTimeSchema,
                },
              },
            ],
          },
        },
      },
    }),
  ),
  defineSchema('public-operation-list', 1, 'Public operation list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operations'],
      properties: {
        operations: {
          type: 'array',
          maxItems: 100,
          items: publicOperationSchema,
        },
        nextCursor: {
          type: 'string',
          minLength: 8,
          maxLength: 1024,
          pattern: '^[A-Za-z0-9_-]+$',
        },
      },
    }),
  ),
  defineSchema('webhook-delivery-list', 1, 'Webhook delivery list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['deliveries'],
      properties: {
        deliveries: {
          type: 'array',
          maxItems: 100,
          items: webhookDeliverySummarySchema,
        },
        nextCursor: {
          type: 'string',
          minLength: 8,
          maxLength: 1024,
          pattern: '^[A-Za-z0-9_-]+$',
        },
      },
    }),
  ),
  defineSchema('webhook-endpoint-list', 1, 'Webhook endpoint list response',
    successSchema({ type: 'object', additionalProperties: false, required: ['endpoints'], properties: {
      endpoints: { type: 'array', maxItems: 100, items: webhookEndpointSummarySchema },
      nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
    } }),
  ),
  defineSchema('create-webhook-endpoint-request', 1, 'Create webhook endpoint request', {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri', pattern: '^https://', minLength: 12, maxLength: 2048 },
    },
  }),
  defineSchema('webhook-endpoint-created', 1, 'Webhook endpoint creation response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'replayed'],
      properties: {
        endpoint: webhookEndpointSummarySchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('webhook-endpoint-detail', 1, 'Webhook endpoint detail response',
    successSchema({ type: 'object', additionalProperties: false, required: ['endpoint'], properties: { endpoint: webhookEndpointDetailSchema } }),
  ),
  defineSchema('set-webhook-endpoint-status-request', 1, 'Set webhook endpoint status request', {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'baseRevision'],
    properties: {
      status: { enum: ['active', 'suspended', 'revoked'] },
      baseRevision: sha256Schema,
    },
  }),
  defineSchema('webhook-endpoint-status-result', 1, 'Webhook endpoint status result',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'effects', 'replayed'],
      properties: {
        endpoint: webhookEndpointSummarySchema,
        effects: {
          type: 'object',
          additionalProperties: false,
          required: ['pausedSubscriptions', 'revokedSubscriptions', 'revokedSigningSecrets'],
          properties: {
            pausedSubscriptions: { type: 'integer', minimum: 0 },
            revokedSubscriptions: { type: 'integer', minimum: 0 },
            revokedSigningSecrets: { type: 'integer', minimum: 0 },
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('webhook-endpoint-challenge-result', 1, 'Webhook endpoint challenge result',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'effects', 'replayed'],
      properties: {
        endpoint: webhookEndpointSummarySchema,
        effects: {
          type: 'object',
          additionalProperties: false,
          required: ['activatedSubscriptions'],
          properties: { activatedSubscriptions: { type: 'integer', minimum: 0 } },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('provision-webhook-signing-secret-request', 1, 'Provision webhook signing secret request', {
    type: 'object',
    additionalProperties: false,
    required: ['baseRevision'],
    properties: { baseRevision: sha256Schema },
  }),
  defineSchema('webhook-signing-secret-provisioned', 1, 'Webhook signing secret provisioning response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['endpoint', 'secretAvailable', 'replayed'],
      properties: {
        endpoint: webhookEndpointSummarySchema,
        secretBase64url: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
        secretAvailable: { type: 'boolean' },
        replayed: { type: 'boolean' },
      },
      allOf: [
        {
          if: { properties: { secretAvailable: { const: true } }, required: ['secretAvailable'] },
          then: {
            required: ['secretBase64url'],
            properties: { secretBase64url: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
          },
          else: { properties: { secretBase64url: false } },
        },
      ],
    }),
  ),
  defineSchema('stage-webhook-signing-secret-rotation-request', 1, 'Stage webhook signing secret rotation request', {
    type: 'object',
    additionalProperties: false,
    required: ['baseRevision', 'overlapSeconds'],
    properties: {
      baseRevision: sha256Schema,
      overlapSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
    },
  }),
  defineSchema('webhook-signing-secret-rotation-staged', 1, 'Staged webhook signing secret rotation response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['rotation', 'secretAvailable', 'replayed'],
      properties: {
        rotation: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'endpointId', 'candidateVersion', 'fingerprint', 'status', 'overlapSeconds', 'createdAt', 'expiresAt'],
          properties: {
            id: idSchema,
            endpointId: idSchema,
            candidateVersion: { type: 'integer', minimum: 1 },
            fingerprint: sha256Schema,
            status: { type: 'string', const: 'staged' },
            overlapSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
            createdAt: dateTimeSchema,
            expiresAt: dateTimeSchema,
          },
        },
        secretBase64url: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
        secretAvailable: { type: 'boolean' },
        replayed: { type: 'boolean' },
      },
      allOf: [{
        if: { properties: { secretAvailable: { const: true } }, required: ['secretAvailable'] },
        then: {
          required: ['secretBase64url'],
          properties: { secretBase64url: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
        },
        else: { properties: { secretBase64url: false } },
      }],
    }),
  ),
  defineSchema('activate-webhook-signing-secret-rotation-request', 1, 'Activate webhook signing secret rotation request', {
    type: 'object', additionalProperties: false, required: ['baseRevision'],
    properties: { baseRevision: sha256Schema },
  }),
  defineSchema('webhook-signing-secret-rotation-activated', 1, 'Activated webhook signing secret rotation response',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['endpoint', 'rotation', 'signing', 'replayed'],
      properties: {
        endpoint: {
          type: 'object', additionalProperties: false, required: ['id', 'status', 'revision'],
          properties: { id: idSchema, status: { type: 'string', const: 'active' }, revision: sha256Schema },
        },
        rotation: {
          type: 'object', additionalProperties: false,
          required: ['id', 'status', 'candidateVersion', 'fingerprint', 'overlapSeconds', 'activatedAt', 'overlapUntil'],
          properties: {
            id: idSchema, status: { type: 'string', const: 'activated' },
            candidateVersion: { type: 'integer', minimum: 2 }, fingerprint: sha256Schema,
            overlapSeconds: { type: 'integer', minimum: 60, maximum: 86400 },
            activatedAt: dateTimeSchema, overlapUntil: dateTimeSchema,
          },
        },
        signing: {
          type: 'object', additionalProperties: false,
          required: ['activeVersion', 'activeFingerprint', 'previousVersion', 'previousFingerprint', 'previousUsableUntil'],
          properties: {
            activeVersion: { type: 'integer', minimum: 2 }, activeFingerprint: sha256Schema,
            previousVersion: { type: 'integer', minimum: 1 }, previousFingerprint: sha256Schema,
            previousUsableUntil: dateTimeSchema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('cancel-webhook-signing-secret-rotation-request', 1, 'Cancel webhook signing secret rotation request', {
    type: 'object', additionalProperties: false, required: ['baseRevision'],
    properties: { baseRevision: sha256Schema },
  }),
  defineSchema('webhook-signing-secret-rotation-cancelled', 1, 'Cancelled webhook signing secret rotation response',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['rotation', 'envelopeDestroyed', 'replayed'],
      properties: {
        rotation: {
          type: 'object', additionalProperties: false,
          required: ['id', 'endpointId', 'status', 'candidateVersion', 'fingerprint', 'cancelledAt'],
          properties: {
            id: idSchema, endpointId: idSchema,
            status: { type: 'string', enum: ['cancelled', 'expired'] },
            candidateVersion: { type: 'integer', minimum: 2 },
            fingerprint: sha256Schema, cancelledAt: dateTimeSchema,
          },
        },
        envelopeDestroyed: { type: 'boolean', const: true },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-list', 3, 'Filtered paginated project list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['projects'],
      properties: {
        projects: { type: 'array', items: searchableProjectSchema },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024 },
      },
    }),
  ),
  defineSchema('public-operation-list', 2, 'Public render and media ingest operation list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operations'],
      properties: {
        operations: { type: 'array', maxItems: 100, items: publicOperationSchemaV2 },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
      },
    }),
  ),
  defineSchema('public-operation-list', 3, 'Public operation list including project proxy renders',
    successSchema({
      type: 'object', additionalProperties: false, required: ['operations'],
      properties: {
        operations: { type: 'array', maxItems: 100, items: publicOperationSchemaV3 },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
      },
    }),
  ),
  defineSchema('public-operation-list', 4, 'Public operation list including final project exports',
    successSchema({
      type: 'object', additionalProperties: false, required: ['operations'],
      properties: {
        operations: { type: 'array', maxItems: 100, items: publicOperationSchemaV4 },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
      },
    }),
  ),
  defineSchema('public-operation-list', 5, 'Public operation list including source cleanup derivatives',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operations'],
      properties: {
        operations: {
          type: 'array',
          maxItems: 100,
          items: publicOperationSchemaV5,
        },
        nextCursor: {
          type: 'string',
          minLength: 8,
          maxLength: 1024,
          pattern: '^[A-Za-z0-9_-]+$',
        },
      },
    }),
  ),
  defineSchema('public-operation-list', 6, 'Public operation list including durable long-form indexing',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operations'],
      properties: {
        operations: {
          type: 'array',
          maxItems: 100,
          items: publicOperationSchemaV6,
        },
        nextCursor: {
          type: 'string',
          minLength: 8,
          maxLength: 1024,
          pattern: '^[A-Za-z0-9_-]+$',
        },
      },
    }),
  ),
  defineSchema('project-list', 4, 'Filtered paginated project list with explicit project visible state',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['projects'],
      properties: {
        projects: { type: 'array', items: searchableProjectSchemaV2 },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024 },
      },
    }),
  ),
  defineSchema('public-operation-list', 7, 'Public operation list with honest actionable visible-state projections',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operations'],
      properties: {
        operations: { type: 'array', maxItems: 100, items: publicOperationSchemaV7 },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
      },
    }),
  ),
  defineSchema('public-operation-list', 8, 'Project-filterable public operation list with honest actionable visible-state projections',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operations'],
      properties: {
        operations: { type: 'array', maxItems: 100, items: publicOperationSchemaV8 },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
      },
    }),
  ),
  defineSchema('public-operation-list', 9, 'Public operation list including durable project Director execution',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operations'],
      properties: {
        operations: { type: 'array', maxItems: 100, items: publicOperationSchemaV9 },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
      },
    }),
  ),
  defineSchema('public-operation-list', 10, 'Public operation list with persisted cost estimates and terminal actual cost where a trustworthy source exists',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operations'],
      properties: {
        operations: { type: 'array', maxItems: 100, items: publicOperationSchemaV10 },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
      },
    }),
  ),
  defineSchema('operation-telemetry-summary', 1, 'Bounded durable operation telemetry summary',
    successSchema({
      type: 'object', additionalProperties: false, required: ['from', 'to', 'events', 'alerts', 'metrics'],
      properties: {
        from: dateTimeSchema, to: dateTimeSchema,
        events: {
          type: 'object', additionalProperties: false,
          required: ['total', 'created', 'succeeded', 'failed', 'canceled', 'spansSucceeded', 'spansFailed'],
          properties: Object.fromEntries(['total', 'created', 'succeeded', 'failed', 'canceled', 'spansSucceeded', 'spansFailed'].map((name) => [name, { type: 'integer', minimum: 0 }])),
        },
        alerts: {
          type: 'object', additionalProperties: false,
          required: ['total', 'warning', 'critical', 'operationFailed', 'queueWaitHigh', 'runDurationHigh', 'spanDurationHigh', 'costHigh'],
          properties: Object.fromEntries(['total', 'warning', 'critical', 'operationFailed', 'queueWaitHigh', 'runDurationHigh', 'spanDurationHigh', 'costHigh'].map((name) => [name, { type: 'integer', minimum: 0 }])),
        },
        metrics: {
          type: 'object', additionalProperties: false,
          required: ['queueWaitMs', 'runDurationMs', 'spanDurationMs', 'inputBytes', 'outputBytes', 'inputTokens', 'outputTokens', 'costMinorUnits'],
          properties: Object.fromEntries(['queueWaitMs', 'runDurationMs', 'spanDurationMs', 'inputBytes', 'outputBytes', 'inputTokens', 'outputTokens', 'costMinorUnits'].map((name) => [name, {
            type: 'object', additionalProperties: false, required: ['sampleCount', 'total', 'maximum'],
            properties: { sampleCount: { type: 'integer', minimum: 0 }, total: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' }, maximum: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } },
          }])),
        },
      },
    }),
  ),
  defineSchema('binary-media-content', 1, 'Binary media content', {
    type: 'string',
    format: 'binary',
  }),
  defineSchema('create-review-annotation-request', 1, 'Create project review annotation request', {
    type: 'object',
    additionalProperties: false,
    required: ['projectVersionId', 'proxyArtifactId', 'proxyHash', 'frame', 'timeRangeMs', 'scope', 'targetIds', 'screenshotRef', 'text'],
    properties: {
      projectVersionId: idSchema,
      proxyArtifactId: idSchema,
      proxyHash: sha256Schema,
      frame: { type: 'integer', minimum: 0 },
      timeRangeMs: reviewAnnotationSchema.properties.timeRangeMs,
      scope: { enum: ['point', 'region', 'scene'] },
      region: normalizedReviewRegionSchema,
      targetIds: reviewAnnotationSchema.properties.targetIds,
      screenshotRef: reviewAnnotationSchema.properties.screenshotRef,
      text: reviewAnnotationSchema.properties.text,
    },
    allOf: [
      {
        if: { properties: { scope: { const: 'region' } }, required: ['scope'] },
        then: { required: ['region'], properties: { region: normalizedReviewRegionSchema } },
        else: { properties: { region: false } },
      },
      {
        if: { properties: { scope: { const: 'scene' } }, required: ['scope'] },
        then: { properties: { targetIds: { type: 'array', minItems: 1, maxItems: 1, uniqueItems: true, items: idSchema } } },
      },
    ],
  }),
  defineSchema('create-review-annotation-request', 2, 'Create project review annotation request with deterministic application scope', {
    type: 'object',
    additionalProperties: false,
    required: ['projectVersionId', 'proxyArtifactId', 'proxyHash', 'frame', 'timeRangeMs', 'scope', 'targetIds', 'screenshotRef', 'text'],
    properties: {
      projectVersionId: idSchema,
      proxyArtifactId: idSchema,
      proxyHash: sha256Schema,
      frame: { type: 'integer', minimum: 0 },
      timeRangeMs: reviewAnnotationSchema.properties.timeRangeMs,
      scope: { enum: ['point', 'region', 'scene'] },
      region: normalizedReviewRegionSchema,
      targetIds: reviewAnnotationSchema.properties.targetIds,
      applicationScope: {
        ...reviewApplicationScopeSchema,
        required: [],
      },
      confirmedGlobal: { type: 'boolean' },
      screenshotRef: reviewAnnotationSchema.properties.screenshotRef,
      text: reviewAnnotationSchema.properties.text,
    },
    allOf: [
      {
        if: { properties: { scope: { const: 'region' } }, required: ['scope'] },
        then: { required: ['region'], properties: { region: normalizedReviewRegionSchema } },
        else: { properties: { region: false } },
      },
      {
        if: { properties: { scope: { const: 'scene' } }, required: ['scope'] },
        then: { properties: { targetIds: { type: 'array', minItems: 1, maxItems: 1, uniqueItems: true, items: idSchema } } },
      },
      {
        if: {
          properties: { applicationScope: { type: 'object', properties: { global: { const: true } }, required: ['global'] } },
          required: ['applicationScope'],
        },
        then: { required: ['confirmedGlobal'], properties: { confirmedGlobal: { const: true } } },
      },
    ],
  }),
  defineSchema('project-review', 1, 'Project review session and annotations',
    successSchema({
      type: 'object', additionalProperties: false, required: ['session', 'scenes', 'annotations'],
      properties: {
        session: reviewSessionSchema,
        scenes: { type: 'array', maxItems: 1000, items: reviewSceneSchema },
        annotations: { type: 'array', maxItems: 100, items: reviewAnnotationSchema },
      },
    }),
  ),
  defineSchema('project-review', 2, 'Version-selectable project review session, scope context and annotations',
    successSchema({
      type: 'object', additionalProperties: false, required: ['session', 'versions', 'scopeContext', 'scenes', 'annotations'],
      properties: {
        session: reviewSessionSchemaV2,
        versions: { type: 'array', minItems: 1, maxItems: 1000, items: reviewVersionSchema },
        scopeContext: reviewScopeContextSchema,
        scenes: { type: 'array', maxItems: 1000, items: reviewSceneSchema },
        annotations: { type: 'array', maxItems: 100, items: reviewAnnotationSchemaV2 },
      },
    }),
  ),
  defineSchema('review-annotation-created', 1, 'Review annotation creation response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['annotation', 'replayed'],
      properties: { annotation: reviewAnnotationSchema, replayed: { type: 'boolean' } },
    }),
  ),
  defineSchema('review-annotation-created', 2, 'Review annotation creation response with resolved application scope',
    successSchema({
      type: 'object', additionalProperties: false, required: ['annotation', 'replayed'],
      properties: { annotation: reviewAnnotationSchemaV2, replayed: { type: 'boolean' } },
    }),
  ),
  defineSchema('create-review-patch-proposal-request', 1, 'Create an auditable patch proposal from one review annotation', {
    type: 'object', additionalProperties: false, required: ['annotationId'],
    properties: { annotationId: { type: 'string', format: 'uuid' }, selectedChoiceId: { type: 'string', minLength: 3, maxLength: 128 } },
  }),
  defineSchema('review-patch-proposal-created', 1, 'Persisted typed patch proposal and deterministic gate results',
    successSchema({ type: 'object', additionalProperties: false, required: ['proposal', 'replayed'], properties: { proposal: patchProposalSchema, replayed: { type: 'boolean' } } }),
  ),
  defineSchema('review-patch-proposal', 1, 'Persisted typed patch proposal including render outcome when applied',
    successSchema({ type: 'object', additionalProperties: false, required: ['proposal'], properties: { proposal: patchProposalSchema } }),
  ),
  defineSchema('apply-review-patch-request', 1, 'Explicit confirmation for a ready review patch proposal', {
    type: 'object', additionalProperties: false, required: ['confirmed'], properties: { confirmed: { const: true } },
  }),
  defineSchema('review-patch-applied', 1, 'Immutable version, semantic comparison and durable proxy render operation created by a confirmed patch',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['proposal', 'command', 'version', 'comparison', 'operation', 'replayed'],
      properties: {
        proposal: patchProposalSchema,
        command: { type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'resultVersionId', 'createdAt'], properties: { id: idSchema, type: { const: 'apply-review-patch' }, baseVersionId: idSchema, resultVersionId: idSchema, createdAt: dateTimeSchema } },
        version: { type: 'object', additionalProperties: false, required: ['id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt'], properties: { id: idSchema, sequence: { type: 'integer', minimum: 2 }, parentVersionId: idSchema, baseHash: sha256Schema, snapshotRefs: { type: 'object' }, createdAt: dateTimeSchema } },
        comparison: patchProposalSchema.properties.comparison,
        operation: publicOperationSchemaV4,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('review-patch-applied', 2, 'Immutable version, persisted frame-first impact, stale output relationships and durable proxy render created by a confirmed patch',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['proposal', 'command', 'version', 'comparison', 'impact', 'invalidations', 'operation', 'replayed'],
      properties: {
        proposal: patchProposalSchema,
        command: { type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'resultVersionId', 'createdAt'], properties: { id: idSchema, type: { const: 'apply-review-patch' }, baseVersionId: idSchema, resultVersionId: idSchema, createdAt: dateTimeSchema } },
        version: { type: 'object', additionalProperties: false, required: ['id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt'], properties: { id: idSchema, sequence: { type: 'integer', minimum: 2 }, parentVersionId: idSchema, baseHash: sha256Schema, snapshotRefs: { type: 'object' }, createdAt: dateTimeSchema } },
        comparison: patchProposalSchema.properties.comparison,
        impact: reviewPatchCommandImpactSchema,
        invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
        operation: publicOperationSchemaV4,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('review-patch-applied', 3, 'Confirmed patch result with explicit current ProjectVersion state',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['proposal', 'command', 'version', 'comparison', 'impact', 'invalidations', 'operation', 'replayed'],
      properties: {
        proposal: patchProposalSchema,
        command: appliedProjectCommandSchema('apply-review-patch'),
        version: currentProjectVersionResultSchema(['brief', 'treatment', 'story', 'editPlan', 'policies']),
        comparison: patchProposalSchema.properties.comparison,
        impact: reviewPatchCommandImpactSchema,
        invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
        operation: publicOperationSchemaV4,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('create-review-patch-batch-request', 1, 'Compile compatible review patch proposals with atomic or explicit partial-retry semantics', {
    type: 'object', additionalProperties: false, required: ['proposalIds'],
    properties: {
      proposalIds: { type: 'array', minItems: 2, maxItems: 100, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
      mode: { enum: ['all-or-nothing', 'partial-retry'], default: 'all-or-nothing' },
    },
  }),
  defineSchema('review-patch-batch-created', 1, 'Persisted batch patch compilation and per-annotation outcomes',
    successSchema({ type: 'object', additionalProperties: false, required: ['batch', 'replayed'], properties: { batch: patchBatchSchema, replayed: { type: 'boolean' } } }),
  ),
  defineSchema('review-patch-batch', 1, 'Persisted batch patch including conflicts, comparison and render outcome',
    successSchema({ type: 'object', additionalProperties: false, required: ['batch'], properties: { batch: patchBatchSchema } }),
  ),
  defineSchema('apply-review-patch-batch-request', 1, 'Explicit confirmation for a ready or explicitly partial batch patch', {
    type: 'object', additionalProperties: false, required: ['confirmed'], properties: { confirmed: { const: true } },
  }),
  defineSchema('review-patch-batch-applied', 1, 'Atomic immutable version and durable proxy render created by a confirmed batch patch',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['batch', 'command', 'version', 'comparison', 'operation', 'replayed'],
      properties: {
        batch: patchBatchSchema,
        command: { type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'resultVersionId', 'createdAt'], properties: { id: idSchema, type: { const: 'apply-review-patch-batch' }, baseVersionId: idSchema, resultVersionId: idSchema, createdAt: dateTimeSchema } },
        version: { type: 'object', additionalProperties: false, required: ['id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt'], properties: { id: idSchema, sequence: { type: 'integer', minimum: 2 }, parentVersionId: idSchema, baseHash: sha256Schema, snapshotRefs: { type: 'object' }, createdAt: dateTimeSchema } },
        comparison: patchBatchSchema.properties.comparison,
        operation: publicOperationSchemaV4,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('review-patch-batch-applied', 2, 'Atomic immutable version, persisted frame-first impact, stale output relationships and durable proxy render created by a confirmed batch patch',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['batch', 'command', 'version', 'comparison', 'impact', 'invalidations', 'operation', 'replayed'],
      properties: {
        batch: patchBatchSchema,
        command: { type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'resultVersionId', 'createdAt'], properties: { id: idSchema, type: { const: 'apply-review-patch-batch' }, baseVersionId: idSchema, resultVersionId: idSchema, createdAt: dateTimeSchema } },
        version: { type: 'object', additionalProperties: false, required: ['id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt'], properties: { id: idSchema, sequence: { type: 'integer', minimum: 2 }, parentVersionId: idSchema, baseHash: sha256Schema, snapshotRefs: { type: 'object' }, createdAt: dateTimeSchema } },
        comparison: patchBatchSchema.properties.comparison,
        impact: reviewPatchBatchCommandImpactSchema,
        invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
        operation: publicOperationSchemaV4,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('review-patch-batch-applied', 3, 'Confirmed batch patch result with explicit current ProjectVersion state',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['batch', 'command', 'version', 'comparison', 'impact', 'invalidations', 'operation', 'replayed'],
      properties: {
        batch: patchBatchSchema,
        command: appliedProjectCommandSchema('apply-review-patch-batch'),
        version: currentProjectVersionResultSchema(['brief', 'treatment', 'story', 'editPlan', 'policies']),
        comparison: patchBatchSchema.properties.comparison,
        impact: reviewPatchBatchCommandImpactSchema,
        invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
        operation: publicOperationSchemaV4,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('render-element-hit-test', 1, 'Rendered element hit-test result for an exact immutable preview',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['map', 'selected', 'chooserRequired', 'candidates'],
      properties: {
        map: {
          type: 'object', additionalProperties: false,
          required: ['schemaVersion', 'mapHash', 'proxyHash', 'fps', 'durationFrames', 'canvas', 'frame'],
          properties: {
            schemaVersion: { const: 'render-element-map/v1' },
            mapHash: sha256Schema,
            proxyHash: sha256Schema,
            fps: { type: 'number', exclusiveMinimum: 0 },
            durationFrames: { type: 'integer', minimum: 1 },
            canvas: {
              type: 'object', additionalProperties: false, required: ['width', 'height'],
              properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 } },
            },
            frame: { type: 'integer', minimum: 0 },
          },
        },
        selected: { anyOf: [{ type: 'null' }, renderElementSchema] },
        chooserRequired: { type: 'boolean' },
        candidates: { type: 'array', maxItems: 32, items: renderElementSchema },
      },
    }),
  ),
  defineSchema('project-workspace', 1, 'Project editing workspace response',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['project', 'media', 'transcripts', 'operationIds', 'operations'],
      properties: {
        project: searchableProjectSchema,
        version: {
          type: 'object', additionalProperties: false, required: ['id', 'sequence', 'baseHash', 'createdAt'],
          properties: { id: idSchema, sequence: { type: 'integer', minimum: 1 }, baseHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, createdAt: dateTimeSchema },
        },
        brief: { type: 'object', additionalProperties: true },
        media: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'role', 'originalFileName', 'artifactId', 'manifestId', 'mediaType', 'container', 'byteSize', 'sha256', 'status', 'createdAt'],
            properties: {
              id: idSchema, role: { enum: ['source-master', 'editing-proxy'] }, originalFileName: { type: 'string', minLength: 1, maxLength: 255 },
              artifactId: idSchema, manifestId: idSchema, mediaType: { enum: ['video', 'audio', 'image'] }, container: { type: 'string', minLength: 2, maxLength: 16 },
              byteSize: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, status: { enum: ['available', 'quarantined', 'deleted'] },
              rightsStatus: { type: 'string' },
              probe: {
                type: 'object', additionalProperties: false, required: ['width', 'height', 'duration', 'fps'],
                properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, duration: { type: 'number', exclusiveMinimum: 0 }, fps: { type: 'number', exclusiveMinimum: 0 } },
              },
              createdAt: dateTimeSchema,
            },
          },
        },
        transcripts: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'sourceArtifactId', 'language', 'provider', 'model', 'transcriptHash', 'text', 'wordCount', 'segmentCount', 'createdAt'],
            properties: {
              id: idSchema, sourceArtifactId: idSchema, language: { type: 'string', minLength: 2, maxLength: 35 }, provider: { type: 'string' }, model: { type: 'string' },
              transcriptHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, text: { type: 'string' }, wordCount: { type: 'integer', minimum: 0 }, segmentCount: { type: 'integer', minimum: 0 }, createdAt: dateTimeSchema,
            },
          },
        },
        operationIds: { type: 'array', maxItems: 1000, items: idSchema, uniqueItems: true },
        operations: { type: 'array', maxItems: 1000, items: publicOperationSchemaV2 },
      },
    }),
  ),
  defineSchema('project-workspace', 2, 'Project editing workspace response with immutable Commands and EditPlan status',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['project', 'commands', 'media', 'transcripts', 'operationIds', 'operations'],
      properties: {
        project: searchableProjectSchema,
        version: {
          type: 'object', additionalProperties: false, required: ['id', 'sequence', 'baseHash', 'createdAt'],
          properties: { id: idSchema, sequence: { type: 'integer', minimum: 1 }, baseHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, createdAt: dateTimeSchema },
        },
        brief: { type: 'object', additionalProperties: true },
        editPlan: {
          type: 'object', additionalProperties: false,
          required: ['id', 'state', 'fps', 'durationFrames', 'clipCount', 'cutCount', 'automaticZoom', 'subtitleFaceProtection'],
          properties: {
            id: idSchema, state: { type: 'string' }, fps: { type: 'number', minimum: 0 }, durationFrames: { type: 'integer', minimum: 0 },
            clipCount: { type: 'integer', minimum: 0 }, cutCount: { type: 'integer', minimum: 0 },
            automaticZoom: { type: 'boolean' }, subtitleFaceProtection: { type: 'boolean' },
          },
        },
        commands: {
          type: 'array', maxItems: 20,
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'createdAt'],
            properties: {
              id: idSchema, type: { type: 'string' }, baseVersionId: idSchema, resultVersionId: idSchema,
              reason: { type: 'string', maxLength: 1000 }, createdAt: dateTimeSchema,
            },
          },
        },
        media: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'role', 'originalFileName', 'artifactId', 'manifestId', 'mediaType', 'container', 'byteSize', 'sha256', 'status', 'createdAt'],
            properties: {
              id: idSchema, role: { enum: ['source-master', 'editing-proxy'] }, originalFileName: { type: 'string', minLength: 1, maxLength: 255 },
              artifactId: idSchema, manifestId: idSchema, mediaType: { enum: ['video', 'audio', 'image'] }, container: { type: 'string', minLength: 2, maxLength: 16 },
              byteSize: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, status: { enum: ['available', 'quarantined', 'deleted'] },
              rightsStatus: { type: 'string' },
              probe: {
                type: 'object', additionalProperties: false, required: ['width', 'height', 'duration', 'fps'],
                properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, duration: { type: 'number', exclusiveMinimum: 0 }, fps: { type: 'number', exclusiveMinimum: 0 } },
              },
              createdAt: dateTimeSchema,
            },
          },
        },
        transcripts: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'sourceArtifactId', 'language', 'provider', 'model', 'transcriptHash', 'text', 'wordCount', 'segmentCount', 'createdAt'],
            properties: {
              id: idSchema, sourceArtifactId: idSchema, language: { type: 'string', minLength: 2, maxLength: 35 }, provider: { type: 'string' }, model: { type: 'string' },
              transcriptHash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, text: { type: 'string' }, wordCount: { type: 'integer', minimum: 0 }, segmentCount: { type: 'integer', minimum: 0 }, createdAt: dateTimeSchema,
            },
          },
        },
        operationIds: { type: 'array', maxItems: 1000, items: idSchema, uniqueItems: true },
        operations: { type: 'array', maxItems: 1000, items: publicOperationSchemaV2 },
      },
    }),
  ),
  defineSchema('project-workspace', 3, 'Project workspace with materialized editorial proxy renders',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['project', 'commands', 'media', 'transcripts', 'operationIds', 'operations'],
      properties: {
        project: searchableProjectSchema,
        version: {
          type: 'object', additionalProperties: false, required: ['id', 'sequence', 'baseHash', 'createdAt'],
          properties: { id: idSchema, sequence: { type: 'integer', minimum: 1 }, baseHash: sha256Schema, createdAt: dateTimeSchema },
        },
        brief: { type: 'object', additionalProperties: true },
        editPlan: {
          type: 'object', additionalProperties: false,
          required: ['id', 'state', 'fps', 'durationFrames', 'clipCount', 'cutCount', 'automaticZoom', 'subtitleFaceProtection'],
          properties: {
            id: idSchema, state: { type: 'string' }, fps: { type: 'number', minimum: 0 }, durationFrames: { type: 'integer', minimum: 0 },
            clipCount: { type: 'integer', minimum: 0 }, cutCount: { type: 'integer', minimum: 0 },
            automaticZoom: { type: 'boolean' }, subtitleFaceProtection: { type: 'boolean' },
          },
        },
        commands: {
          type: 'array', maxItems: 20,
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'createdAt'],
            properties: { id: idSchema, type: { type: 'string' }, baseVersionId: idSchema, resultVersionId: idSchema, reason: { type: 'string', maxLength: 1000 }, createdAt: dateTimeSchema },
          },
        },
        media: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'role', 'originalFileName', 'artifactId', 'manifestId', 'mediaType', 'container', 'byteSize', 'sha256', 'status', 'createdAt'],
            properties: {
              id: idSchema, role: { enum: ['source-master', 'editing-proxy', 'editorial-proxy'] }, originalFileName: { type: 'string', minLength: 1, maxLength: 255 },
              artifactId: idSchema, manifestId: idSchema, mediaType: { enum: ['video', 'audio', 'image'] }, container: { type: 'string', minLength: 2, maxLength: 16 },
              byteSize: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, sha256: sha256Schema, status: { enum: ['available', 'quarantined', 'deleted'] }, rightsStatus: { type: 'string' },
              probe: { type: 'object', additionalProperties: false, required: ['width', 'height', 'duration', 'fps'], properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, duration: { type: 'number', exclusiveMinimum: 0 }, fps: { type: 'number', exclusiveMinimum: 0 } } },
              createdAt: dateTimeSchema,
            },
          },
        },
        transcripts: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'sourceArtifactId', 'language', 'provider', 'model', 'transcriptHash', 'text', 'wordCount', 'segmentCount', 'createdAt'],
            properties: {
              id: idSchema, sourceArtifactId: idSchema, language: { type: 'string', minLength: 2, maxLength: 35 }, provider: { type: 'string' }, model: { type: 'string' },
              transcriptHash: sha256Schema, text: { type: 'string' }, wordCount: { type: 'integer', minimum: 0 }, segmentCount: { type: 'integer', minimum: 0 }, createdAt: dateTimeSchema,
            },
          },
        },
        operationIds: { type: 'array', maxItems: 1000, items: idSchema, uniqueItems: true },
        operations: { type: 'array', maxItems: 1000, items: publicOperationSchemaV3 },
      },
    }),
  ),
  defineSchema('project-workspace', 4, 'Project workspace with persisted DirectorRun summaries',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['project', 'commands', 'directorRuns', 'media', 'transcripts', 'operationIds', 'operations'],
      properties: {
        project: searchableProjectSchema,
        version: {
          type: 'object', additionalProperties: false, required: ['id', 'sequence', 'baseHash', 'createdAt'],
          properties: { id: idSchema, sequence: { type: 'integer', minimum: 1 }, baseHash: sha256Schema, createdAt: dateTimeSchema },
        },
        brief: { type: 'object', additionalProperties: true },
        editPlan: {
          type: 'object', additionalProperties: false,
          required: ['id', 'state', 'fps', 'durationFrames', 'clipCount', 'cutCount', 'automaticZoom', 'subtitleFaceProtection'],
          properties: {
            id: idSchema, state: { type: 'string' }, fps: { type: 'number', minimum: 0 }, durationFrames: { type: 'integer', minimum: 0 },
            clipCount: { type: 'integer', minimum: 0 }, cutCount: { type: 'integer', minimum: 0 },
            automaticZoom: { type: 'boolean' }, subtitleFaceProtection: { type: 'boolean' },
          },
        },
        commands: {
          type: 'array', maxItems: 20,
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'createdAt'],
            properties: { id: idSchema, type: { enum: ['remove-spoken-content', 'run-director'] }, baseVersionId: idSchema, resultVersionId: idSchema, reason: { type: 'string', maxLength: 1000 }, createdAt: dateTimeSchema },
          },
        },
        directorRuns: {
          type: 'array', maxItems: 10,
          items: {
            type: 'object', additionalProperties: false,
            required: [
              'id', 'status', 'plannerVersion', 'criticVersion', 'baseVersionId', 'resultVersionId',
              'treatmentSnapshotId', 'storySnapshotId', 'qualitySnapshotId', 'qualityStatus',
              'qualityScore', 'decisionCount', 'assumptionCount', 'subtitleCueCount', 'transitionCount',
              'automaticZoom', 'createdAt',
            ],
            properties: {
              id: idSchema, status: { enum: ['planned', 'rendering', 'succeeded', 'failed'] },
              plannerVersion: { type: 'string', minLength: 3, maxLength: 64 }, criticVersion: { type: 'string', minLength: 3, maxLength: 64 },
              baseVersionId: idSchema, resultVersionId: idSchema, treatmentSnapshotId: idSchema,
              storySnapshotId: idSchema, qualitySnapshotId: idSchema,
              qualityStatus: { enum: ['approved', 'approved-with-warnings', 'blocked'] },
              qualityScore: { type: 'number', minimum: 0, maximum: 1 },
              decisionCount: { type: 'integer', minimum: 0, maximum: 64 }, assumptionCount: { type: 'integer', minimum: 0, maximum: 64 },
              subtitleCueCount: { type: 'integer', minimum: 0 }, transitionCount: { type: 'integer', minimum: 0 },
              automaticZoom: { type: 'boolean' }, createdAt: dateTimeSchema,
            },
          },
        },
        media: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'role', 'originalFileName', 'artifactId', 'manifestId', 'mediaType', 'container', 'byteSize', 'sha256', 'status', 'createdAt'],
            properties: {
              id: idSchema, role: { enum: ['source-master', 'editing-proxy', 'editorial-proxy'] }, originalFileName: { type: 'string', minLength: 1, maxLength: 255 },
              artifactId: idSchema, manifestId: idSchema, mediaType: { enum: ['video', 'audio', 'image'] }, container: { type: 'string', minLength: 2, maxLength: 16 },
              byteSize: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, sha256: sha256Schema, status: { enum: ['available', 'quarantined', 'deleted'] }, rightsStatus: { type: 'string' },
              probe: { type: 'object', additionalProperties: false, required: ['width', 'height', 'duration', 'fps'], properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, duration: { type: 'number', exclusiveMinimum: 0 }, fps: { type: 'number', exclusiveMinimum: 0 } } },
              createdAt: dateTimeSchema,
            },
          },
        },
        transcripts: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'sourceArtifactId', 'language', 'provider', 'model', 'transcriptHash', 'text', 'wordCount', 'segmentCount', 'createdAt'],
            properties: {
              id: idSchema, sourceArtifactId: idSchema, language: { type: 'string', minLength: 2, maxLength: 35 }, provider: { type: 'string' }, model: { type: 'string' },
              transcriptHash: sha256Schema, text: { type: 'string' }, wordCount: { type: 'integer', minimum: 0 }, segmentCount: { type: 'integer', minimum: 0 }, createdAt: dateTimeSchema,
            },
          },
        },
        operationIds: { type: 'array', maxItems: 1000, items: idSchema, uniqueItems: true },
        operations: { type: 'array', maxItems: 1000, items: publicOperationSchemaV3 },
      },
    }),
  ),
  defineSchema('project-workspace', 5, 'Project workspace with persisted final exports',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['project', 'commands', 'directorRuns', 'media', 'transcripts', 'operationIds', 'operations'],
      properties: {
        project: searchableProjectSchema,
        version: {
          type: 'object', additionalProperties: false, required: ['id', 'sequence', 'baseHash', 'createdAt'],
          properties: { id: idSchema, sequence: { type: 'integer', minimum: 1 }, baseHash: sha256Schema, createdAt: dateTimeSchema },
        },
        brief: { type: 'object', additionalProperties: true },
        editPlan: {
          type: 'object', additionalProperties: false,
          required: ['id', 'state', 'fps', 'durationFrames', 'clipCount', 'cutCount', 'automaticZoom', 'subtitleFaceProtection'],
          properties: {
            id: idSchema, state: { type: 'string' }, fps: { type: 'number', minimum: 0 }, durationFrames: { type: 'integer', minimum: 0 },
            clipCount: { type: 'integer', minimum: 0 }, cutCount: { type: 'integer', minimum: 0 },
            automaticZoom: { type: 'boolean' }, subtitleFaceProtection: { type: 'boolean' },
          },
        },
        commands: {
          type: 'array', maxItems: 20,
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'createdAt'],
            properties: { id: idSchema, type: { enum: ['remove-spoken-content', 'run-director'] }, baseVersionId: idSchema, resultVersionId: idSchema, reason: { type: 'string', maxLength: 1000 }, createdAt: dateTimeSchema },
          },
        },
        directorRuns: {
          type: 'array', maxItems: 10,
          items: {
            type: 'object', additionalProperties: false,
            required: [
              'id', 'status', 'plannerVersion', 'criticVersion', 'baseVersionId', 'resultVersionId',
              'treatmentSnapshotId', 'storySnapshotId', 'qualitySnapshotId', 'qualityStatus',
              'qualityScore', 'decisionCount', 'assumptionCount', 'subtitleCueCount', 'transitionCount',
              'automaticZoom', 'createdAt',
            ],
            properties: {
              id: idSchema, status: { enum: ['planned', 'rendering', 'succeeded', 'failed'] },
              plannerVersion: { type: 'string', minLength: 3, maxLength: 64 }, criticVersion: { type: 'string', minLength: 3, maxLength: 64 },
              baseVersionId: idSchema, resultVersionId: idSchema, treatmentSnapshotId: idSchema,
              storySnapshotId: idSchema, qualitySnapshotId: idSchema,
              qualityStatus: { enum: ['approved', 'approved-with-warnings', 'blocked'] },
              qualityScore: { type: 'number', minimum: 0, maximum: 1 },
              decisionCount: { type: 'integer', minimum: 0, maximum: 64 }, assumptionCount: { type: 'integer', minimum: 0, maximum: 64 },
              subtitleCueCount: { type: 'integer', minimum: 0 }, transitionCount: { type: 'integer', minimum: 0 },
              automaticZoom: { type: 'boolean' }, createdAt: dateTimeSchema,
            },
          },
        },
        media: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'role', 'originalFileName', 'artifactId', 'manifestId', 'mediaType', 'container', 'byteSize', 'sha256', 'status', 'createdAt'],
            properties: {
              id: idSchema, role: { enum: ['source-master', 'editing-proxy', 'editorial-proxy', 'final-output'] }, originalFileName: { type: 'string', minLength: 1, maxLength: 255 },
              artifactId: idSchema, manifestId: idSchema, mediaType: { enum: ['video', 'audio', 'image'] }, container: { type: 'string', minLength: 2, maxLength: 16 },
              byteSize: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, sha256: sha256Schema, status: { enum: ['available', 'quarantined', 'deleted'] }, rightsStatus: { type: 'string' },
              probe: { type: 'object', additionalProperties: false, required: ['width', 'height', 'duration', 'fps'], properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, duration: { type: 'number', exclusiveMinimum: 0 }, fps: { type: 'number', exclusiveMinimum: 0 } } },
              createdAt: dateTimeSchema,
            },
          },
        },
        transcripts: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'sourceArtifactId', 'language', 'provider', 'model', 'transcriptHash', 'text', 'wordCount', 'segmentCount', 'createdAt'],
            properties: {
              id: idSchema, sourceArtifactId: idSchema, language: { type: 'string', minLength: 2, maxLength: 35 }, provider: { type: 'string' }, model: { type: 'string' },
              transcriptHash: sha256Schema, text: { type: 'string' }, wordCount: { type: 'integer', minimum: 0 }, segmentCount: { type: 'integer', minimum: 0 }, createdAt: dateTimeSchema,
            },
          },
        },
        operationIds: { type: 'array', maxItems: 1000, items: idSchema, uniqueItems: true },
        operations: { type: 'array', maxItems: 1000, items: publicOperationSchemaV4 },
      },
    }),
  ),
  defineSchema('begin-media-upload-request', 1, 'Begin media upload request', {
    type: 'object', additionalProperties: false,
    required: ['kind', 'size', 'mimeType', 'checksum'],
    properties: {
      kind: { enum: ['video', 'audio', 'image'] },
      size: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
      mimeType: { type: 'string', pattern: '^(video|audio|image)/[a-z0-9.+-]+$', maxLength: 160 },
      checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
  }),
  defineSchema('begin-media-upload-request', 2, 'Begin project media upload request', {
    type: 'object', additionalProperties: false,
    required: ['projectId', 'fileName', 'rightsConfirmed', 'kind', 'size', 'mimeType', 'checksum'],
    properties: {
      projectId: idSchema,
      fileName: { type: 'string', minLength: 1, maxLength: 255 },
      rightsConfirmed: { const: true },
      kind: { const: 'video' },
      size: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
      mimeType: { type: 'string', pattern: '^video/[a-z0-9.+-]+$', maxLength: 160 },
      checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
  }),
  defineSchema('media-upload-begun', 1, 'Media upload intent response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['upload', 'replayed'],
      properties: {
        upload: {
          type: 'object', additionalProperties: false,
          required: ['id', 'kind', 'size', 'mimeType', 'checksum', 'status', 'expiresAt', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' }, kind: { enum: ['video', 'audio', 'image'] },
            size: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
            mimeType: { type: 'string', maxLength: 160 }, checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            status: { const: 'pending-session' }, expiresAt: dateTimeSchema, createdAt: dateTimeSchema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('media-upload-begun', 2, 'Project media upload intent response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['upload', 'replayed'],
      properties: {
        upload: {
          type: 'object', additionalProperties: false,
          required: ['id', 'projectId', 'fileName', 'rightsConfirmed', 'kind', 'size', 'mimeType', 'checksum', 'status', 'expiresAt', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' }, projectId: idSchema, fileName: { type: 'string', minLength: 1, maxLength: 255 }, rightsConfirmed: { const: true },
            kind: { const: 'video' }, size: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' }, mimeType: { type: 'string', pattern: '^video/', maxLength: 160 },
            checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' }, status: { const: 'pending-session' }, expiresAt: dateTimeSchema, createdAt: dateTimeSchema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('media-upload-session', 1, 'Signed media upload session',
    successSchema({
      type: 'object', additionalProperties: false, required: ['uploadId', 'session'],
      properties: {
        uploadId: { type: 'string', format: 'uuid' },
        session: {
          type: 'object', additionalProperties: false,
          required: ['mode', 'expiresAt', 'maxParts', 'requiredHeaders'],
          properties: {
            mode: { enum: ['single', 'multipart'] }, expiresAt: dateTimeSchema,
            maxParts: { type: 'integer', minimum: 1, maximum: 10000 },
            requiredHeaders: {
              type: 'object', additionalProperties: false,
              required: ['content-type', 'x-apollo-content-sha256'],
              properties: {
                'content-type': { type: 'string', maxLength: 160 },
                'x-apollo-content-sha256': { type: 'string', pattern: '^[a-f0-9]{64}$' },
              },
            },
            uploadUrl: { type: 'string', format: 'uri', maxLength: 4096 },
            partSize: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
            partUrlTemplate: { type: 'string', pattern: '^https?://', maxLength: 4096 },
          },
        },
      },
    }),
  ),
  defineSchema('media-upload-content-received', 1, 'Signed media bytes receipt',
    successSchema({
      type: 'object', additionalProperties: false, required: ['receipt'],
      properties: {
        receipt: {
          type: 'object', additionalProperties: false, required: ['byteSize', 'checksum', 'etag'],
          properties: { byteSize: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' }, etag: { type: 'string', maxLength: 258 } },
        },
        part: {
          type: 'object', additionalProperties: false, required: ['uploadId', 'partNumber', 'byteSize', 'etag', 'checksum', 'recordedAt'],
          properties: { uploadId: { type: 'string', format: 'uuid' }, partNumber: { type: 'integer', minimum: 1, maximum: 10000 }, byteSize: { type: 'string' }, etag: { type: 'string' }, checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' }, recordedAt: dateTimeSchema },
        },
      },
    }),
  ),
  defineSchema('record-media-upload-part-request', 1, 'Record multipart upload receipt request', {
    type: 'object', additionalProperties: false, required: ['byteSize', 'etag', 'checksum'],
    properties: {
      byteSize: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
      etag: { type: 'string', pattern: '^\"[A-Za-z0-9+/=_-]{8,256}\"$' },
      checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    },
  }),
  defineSchema('media-upload-part-recorded', 1, 'Recorded multipart upload receipt response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['part'],
      properties: {
        part: {
          type: 'object', additionalProperties: false,
          required: ['uploadId', 'partNumber', 'byteSize', 'etag', 'checksum', 'recordedAt'],
          properties: {
            uploadId: { type: 'string', format: 'uuid' }, partNumber: { type: 'integer', minimum: 1, maximum: 10000 },
            byteSize: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' }, etag: { type: 'string', maxLength: 258 },
            checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' }, recordedAt: dateTimeSchema,
          },
        },
      },
    }),
  ),
  defineSchema('media-upload-detail', 1, 'Resumable media upload detail response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['upload', 'parts', 'missingPartNumbers'],
      properties: {
        upload: {
          type: 'object', additionalProperties: false,
          required: ['id', 'kind', 'size', 'mimeType', 'checksum', 'status', 'expiresAt', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' }, kind: { enum: ['video', 'audio', 'image'] },
            size: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' }, mimeType: { type: 'string', maxLength: 160 },
            checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            status: { enum: ['pending-session', 'uploading', 'uploaded', 'verified', 'expired', 'aborted'] },
            expiresAt: dateTimeSchema, createdAt: dateTimeSchema,
          },
        },
        parts: {
          type: 'array', maxItems: 10000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['uploadId', 'partNumber', 'byteSize', 'etag', 'checksum', 'recordedAt'],
            properties: {
              uploadId: { type: 'string', format: 'uuid' }, partNumber: { type: 'integer', minimum: 1, maximum: 10000 },
              byteSize: { type: 'string' }, etag: { type: 'string' }, checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' }, recordedAt: dateTimeSchema,
            },
          },
        },
        missingPartNumbers: { type: 'array', maxItems: 10000, items: { type: 'integer', minimum: 1, maximum: 10000 }, uniqueItems: true },
      },
    }),
  ),
  defineSchema('media-upload-detail', 2, 'Resumable project media upload detail response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['upload', 'parts', 'missingPartNumbers'],
      properties: {
        upload: {
          type: 'object', additionalProperties: false,
          required: ['id', 'projectId', 'fileName', 'rightsConfirmed', 'kind', 'size', 'mimeType', 'checksum', 'status', 'expiresAt', 'createdAt'],
          properties: {
            id: { type: 'string', format: 'uuid' }, projectId: idSchema, fileName: { type: 'string', minLength: 1, maxLength: 255 }, rightsConfirmed: { const: true },
            kind: { const: 'video' }, size: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' }, mimeType: { type: 'string', pattern: '^video/', maxLength: 160 }, checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            status: { enum: ['pending-session', 'uploading', 'uploaded', 'verified', 'expired', 'aborted'] }, expiresAt: dateTimeSchema, createdAt: dateTimeSchema,
          },
        },
        parts: {
          type: 'array', maxItems: 10000,
          items: { type: 'object', additionalProperties: false, required: ['uploadId', 'partNumber', 'byteSize', 'etag', 'checksum', 'recordedAt'], properties: { uploadId: { type: 'string', format: 'uuid' }, partNumber: { type: 'integer', minimum: 1, maximum: 10000 }, byteSize: { type: 'string' }, etag: { type: 'string' }, checksum: { type: 'string', pattern: '^[a-f0-9]{64}$' }, recordedAt: dateTimeSchema } },
        },
        missingPartNumbers: { type: 'array', maxItems: 10000, items: { type: 'integer', minimum: 1, maximum: 10000 }, uniqueItems: true },
      },
    }),
  ),
  defineSchema('media-upload-completed', 1, 'Verified media upload completion response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['uploadId', 'status', 'verifiedAt', 'replayed'],
      properties: {
        uploadId: { type: 'string', format: 'uuid' }, status: { const: 'verified' }, verifiedAt: dateTimeSchema, replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('media-upload-completed', 2, 'Verified project media upload and queued ingest response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['uploadId', 'status', 'verifiedAt', 'operation', 'replayed'],
      properties: {
        uploadId: { type: 'string', format: 'uuid' }, status: { const: 'verified' }, verifiedAt: dateTimeSchema,
        operation: publicOperationSchemaV2, replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('media-upload-aborted', 1, 'Aborted project media upload response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['uploadId', 'status', 'aborted'],
      properties: { uploadId: { type: 'string', format: 'uuid' }, status: { const: 'aborted' }, aborted: { const: true } },
    }),
  ),
  defineSchema('issue-media-download-grant-request', 1, 'Issue media download grant request', {
    type: 'object', additionalProperties: false,
    properties: { ttlSeconds: { type: 'integer', minimum: 30, maximum: 900, default: 300 } },
  }),
  defineSchema('media-download-grant-issued', 1, 'Issued media download grant response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['grant', 'downloadUrl', 'replayed'],
      properties: {
        grant: {
          type: 'object', additionalProperties: false, required: ['id', 'artifactId', 'status', 'expiresAt', 'createdAt'],
          properties: { id: { type: 'string', format: 'uuid' }, artifactId: idSchema, status: { const: 'active' }, expiresAt: dateTimeSchema, createdAt: dateTimeSchema },
        },
        downloadUrl: { type: 'string', format: 'uri', pattern: '^https?://', maxLength: 8192 },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('media-download-grant-revoked', 1, 'Revoked media download grant response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['grant', 'replayed'],
      properties: {
        grant: {
          type: 'object', additionalProperties: false, required: ['id', 'artifactId', 'status', 'expiresAt', 'revokedAt'],
          properties: { id: { type: 'string', format: 'uuid' }, artifactId: idSchema, status: { const: 'revoked' }, expiresAt: dateTimeSchema, revokedAt: dateTimeSchema },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema(
    'preflight-result',
    1,
    'Canonical preflight result',
    preflightResultSchema,
  ),
  defineSchema('preflight-commit-token', 1, 'Trusted preflight commit token evidence', {
    type: 'object', additionalProperties: false, required: ['token', 'expiresAt'],
    properties: { token: { type: 'string', pattern: '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$', minLength: 80, maxLength: 4096 }, expiresAt: dateTimeSchema },
  }),
  defineSchema('batch-item-page', 1, 'Paged batch item operation results', successSchema({
    type: 'object', additionalProperties: false, required: ['batchId', 'items'],
    properties: {
      batchId: idSchema,
      items: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['itemId', 'operationId', 'status', 'retryable', 'updatedAt'], properties: {
        itemId: idSchema, operationId: idSchema, status: { enum: ['queued', 'running', 'succeeded', 'failed', 'canceled'] }, retryable: { type: 'boolean' }, resultRef: idSchema,
        error: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: { code: { type: 'string', maxLength: 80 }, message: { type: 'string', maxLength: 1000 } } }, updatedAt: dateTimeSchema,
      } } },
      nextCursor: { type: 'string', minLength: 16, maxLength: 4096 },
    },
  })),
  defineSchema('governance-usage-audit-page', 1, 'Redacted governance usage and audit page', successSchema({
    type: 'object', additionalProperties: false, required: ['entries'], properties: {
      entries: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id', 'clientId', 'action', 'status', 'target', 'usage', 'createdAt', 'updatedAt'], properties: {
        id: idSchema, clientId: idSchema, action: { type: 'string', maxLength: 80 }, status: { type: 'string', maxLength: 32 }, target: { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: { type: { type: 'string' }, id: idSchema } },
        usage: { type: 'object', additionalProperties: false, required: ['unit', 'quantity'], properties: { unit: { const: 'operation' }, quantity: { const: 1 } } }, createdAt: dateTimeSchema, updatedAt: dateTimeSchema,
      } } }, nextCursor: { type: 'string', minLength: 8, maxLength: 1024 },
    },
  })),
  defineSchema('agent-tool-list', 1, 'Scope-filtered agent tool list',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['tools'],
      properties: {
        tools: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'name', 'title', 'description', 'inputSchema', 'outputSchema',
              'errorSchema', 'annotations', 'apollo',
            ],
            properties: {
              name: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{2,127}$' },
              title: { type: 'string', minLength: 1, maxLength: 160 },
              description: { type: 'string', minLength: 1, maxLength: 1000 },
              inputSchema: { type: 'object' },
              outputSchema: { type: 'object' },
              errorSchema: { type: 'object' },
              annotations: {
                type: 'object', additionalProperties: false,
                required: ['readOnlyHint', 'idempotentHint'],
                properties: {
                  readOnlyHint: { type: 'boolean' },
                  idempotentHint: { type: 'boolean' },
                },
              },
              apollo: {
                type: 'object', additionalProperties: false,
                required: [
                  'capabilityId', 'capabilityVersion', 'operationKind',
                  'requiredScopes', 'endpoint', 'costClass', 'confirmation', 'supportsDryRun',
                ],
                properties: {
                  capabilityId: { type: 'string', pattern: '^apollo\\.' },
                  capabilityVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
                  operationKind: { enum: ['query', 'command', 'preflight', 'job'] },
                  requiredScopes: {
                    type: 'array', uniqueItems: true, items: { type: 'string' },
                  },
                  endpoint: {
                    type: 'object', additionalProperties: false, required: ['method', 'path'],
                    properties: {
                      method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
                      path: { type: 'string', pattern: '^/v1/' },
                    },
                  },
                  costClass: { enum: ['free', 'low', 'medium', 'high', 'variable'] },
                  confirmation: { enum: ['none', 'preflight-token', 'human-approval'] },
                  supportsDryRun: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    }),
  ),
  defineSchema('agent-tool-list', 2, 'Scope-filtered agent tool list with data trust boundaries',
    successSchema({
      type: 'object', additionalProperties: false, required: ['tools'],
      properties: {
        tools: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'errorSchema', 'annotations', 'apollo'],
            properties: {
              name: { type: 'string', pattern: '^[a-z][a-z0-9_.-]{2,127}$' },
              title: { type: 'string', minLength: 1, maxLength: 160 },
              description: { type: 'string', minLength: 1, maxLength: 1000 },
              inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, errorSchema: { type: 'object' },
              annotations: {
                type: 'object', additionalProperties: false, required: ['readOnlyHint', 'idempotentHint'],
                properties: { readOnlyHint: { type: 'boolean' }, idempotentHint: { type: 'boolean' } },
              },
              apollo: {
                type: 'object', additionalProperties: false,
                required: ['capabilityId', 'capabilityVersion', 'operationKind', 'requiredScopes', 'endpoint', 'costClass', 'confirmation', 'supportsDryRun', 'dataBoundary'],
                properties: {
                  capabilityId: { type: 'string', pattern: '^apollo\\.' },
                  capabilityVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
                  operationKind: { enum: ['query', 'command', 'preflight', 'job'] },
                  requiredScopes: { type: 'array', uniqueItems: true, items: { type: 'string' } },
                  endpoint: {
                    type: 'object', additionalProperties: false, required: ['method', 'path'],
                    properties: { method: { enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', pattern: '^/v1/' } },
                  },
                  costClass: { enum: ['free', 'low', 'medium', 'high', 'variable'] },
                  confirmation: { enum: ['none', 'preflight-token', 'human-approval'] },
                  supportsDryRun: { type: 'boolean' },
                  dataBoundary: {
                    type: 'object', additionalProperties: false,
                    required: ['structureClassification', 'mediaContentClassification', 'instructionPolicy', 'inputPaths', 'outputPaths'],
                    properties: {
                      structureClassification: { const: 'trusted-contract' },
                      mediaContentClassification: { const: 'untrusted-data' },
                      instructionPolicy: { const: 'never-execute' },
                      inputPaths: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^/' } },
                      outputPaths: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^/' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ),
  defineSchema('webhook-signing-secret-rotation-list', 1, 'Webhook signing secret rotation list response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['rotations'],
      properties: {
        rotations: { type: 'array', maxItems: 100, items: webhookSigningSecretRotationMetadataSchema },
        nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
      },
    }),
  ),
  defineSchema('webhook-signing-secret-rotation-detail', 1, 'Webhook signing secret rotation detail response',
    successSchema({
      type: 'object', additionalProperties: false, required: ['rotation'],
      properties: { rotation: webhookSigningSecretRotationMetadataSchema },
    }),
  ),
  defineSchema('run-webhook-signing-secret-hygiene-request', 1, 'Run webhook signing secret hygiene request', {
    type: 'object', additionalProperties: false, required: ['limitPerKind'],
    properties: { limitPerKind: { type: 'integer', minimum: 1, maximum: 100 } },
  }),
  defineSchema('webhook-signing-secret-hygiene-result', 1, 'Webhook signing secret hygiene result',
    successSchema({
      type: 'object', additionalProperties: false,
      required: [
        'asOf', 'expiredRotations', 'destroyedRotationEnvelopes',
        'destroyedSigningSecretPayloads', 'hasMore',
      ],
      properties: {
        asOf: dateTimeSchema,
        expiredRotations: { type: 'integer', minimum: 0, maximum: 100 },
        destroyedRotationEnvelopes: { type: 'integer', minimum: 0, maximum: 100 },
        destroyedSigningSecretPayloads: { type: 'integer', minimum: 0, maximum: 100 },
        hasMore: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('webhook-subscription-list', 1, 'Webhook subscription list response',
    successSchema({ type: 'object', additionalProperties: false, required: ['subscriptions'], properties: {
      subscriptions: { type: 'array', maxItems: 100, items: webhookSubscriptionSchema },
      nextCursor: { type: 'string', minLength: 8, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' },
    } }),
  ),
  defineSchema('create-webhook-subscription-request', 1, 'Create webhook subscription request', {
    type: 'object',
    additionalProperties: false,
    required: ['endpointId', 'eventTypes'],
    properties: {
      endpointId: idSchema,
      eventTypes: {
        type: 'array', minItems: 1, maxItems: 64, uniqueItems: true,
        items: { type: 'string', enum: publicEventTypes },
      },
      resourceIds: {
        type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: idSchema,
      },
    },
  }),
  defineSchema('webhook-subscription-created', 1, 'Webhook subscription creation response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['subscription', 'replayed'],
      properties: {
        subscription: webhookSubscriptionSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('webhook-subscription-detail', 1, 'Webhook subscription detail response',
    successSchema({ type: 'object', additionalProperties: false, required: ['subscription'], properties: { subscription: webhookSubscriptionSchema } }),
  ),
  defineSchema('set-webhook-subscription-status-request', 1, 'Set webhook subscription status request', {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'baseRevision'],
    properties: {
      status: { enum: ['active', 'paused', 'revoked'] },
      baseRevision: sha256Schema,
    },
  }),
  defineSchema('webhook-delivery-detail', 1, 'Webhook delivery diagnostic response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['delivery'],
      properties: { delivery: webhookDeliveryDiagnosticSchema },
    }),
  ),
  defineSchema('webhook-delivery-replay-result', 1, 'Webhook delivery replay response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['delivery', 'replayed'],
      properties: {
        delivery: webhookDeliveryDiagnosticSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('webhook-event-replay-result', 1, 'Webhook event replay response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['eventId', 'items', 'replayed'],
      properties: {
        eventId: webhookUuidSchema,
        items: { type: 'array', maxItems: 100, items: webhookEventReplayItemSchema },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('create-project-request', 1, 'Create project request', {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string', minLength: 2, maxLength: 120 } },
  }),
  defineSchema('create-project-request', 2, 'Create project request with direction inputs', {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'objective', 'format'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 120 },
      objective: {
        enum: [
          'discovery', 'awareness', 'warming', 'lead-generation',
          'sale', 'whatsapp', 'booking', 'download',
        ],
      },
      format: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
      locale: { type: 'string', minLength: 2, maxLength: 35 },
      briefing: { type: 'string', maxLength: 10000 },
      destination: { type: 'string', minLength: 1, maxLength: 2048 },
    },
  }),
  defineSchema('project-created', 1, 'Project creation response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['project', 'version', 'replayed'],
      properties: {
        project: projectSchema,
        version: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'sequence', 'baseHash', 'snapshotRefs', 'createdAt'],
          properties: {
            id: idSchema,
            sequence: { type: 'integer', minimum: 1 },
            baseHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            snapshotRefs: {
              type: 'object',
              additionalProperties: false,
              required: ['editPlan', 'policies'],
              properties: { editPlan: idSchema, policies: idSchema },
            },
            createdAt: dateTimeSchema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-created', 2, 'Project creation response with direction snapshot',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['project', 'version', 'replayed'],
      properties: {
        project: searchableProjectSchema,
        version: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'sequence', 'baseHash', 'snapshotRefs', 'createdAt'],
          properties: {
            id: idSchema,
            sequence: { type: 'integer', minimum: 1 },
            baseHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            snapshotRefs: {
              type: 'object',
              additionalProperties: false,
              required: ['brief', 'editPlan', 'policies'],
              properties: { brief: idSchema, editPlan: idSchema, policies: idSchema },
            },
            createdAt: dateTimeSchema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('duplicate-project-request', 1, 'Copy-on-write project duplication request', {
    type: 'object',
    additionalProperties: false,
    required: ['expectedVersionId', 'expectedVersionHash'],
    properties: {
      expectedVersionId: idSchema,
      expectedVersionHash: sha256Schema,
      name: { type: 'string', minLength: 1, maxLength: 120 },
    },
  }),
  defineSchema('project-duplicated', 1, 'Copy-on-write project duplication response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'project',
        'version',
        'sharedArtifactIds',
        'copiedBytes',
        'replayed',
      ],
      properties: {
        project: {
          ...searchableProjectSchema,
          required: [
            ...searchableProjectSchema.required,
            'duplicatedFromProjectId',
          ],
          properties: {
            ...searchableProjectSchema.properties,
            duplicatedFromProjectId: idSchema,
          },
        },
        version: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id',
            'sequence',
            'baseHash',
            'forkedFromProjectId',
            'forkedFromVersionId',
            'snapshotRefs',
            'createdAt',
          ],
          properties: {
            id: idSchema,
            sequence: { const: 1 },
            baseHash: sha256Schema,
            forkedFromProjectId: idSchema,
            forkedFromVersionId: idSchema,
            snapshotRefs: {
              type: 'object',
              additionalProperties: false,
              required: ['brief', 'editPlan', 'policies'],
              properties: {
                brief: idSchema,
                treatment: idSchema,
                story: idSchema,
                editPlan: idSchema,
                policies: idSchema,
              },
            },
            createdAt: dateTimeSchema,
          },
        },
        sharedArtifactIds: {
          type: 'array',
          maxItems: 10000,
          uniqueItems: true,
          items: idSchema,
        },
        copiedBytes: { const: 0 },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('run-mvp-core-gate-request', 1, 'Server-evaluated MVP Core gate request', {
    type: 'object',
    additionalProperties: false,
    required: [
      'primaryVersionId',
      'primaryVersionHash',
      'companionProjectId',
      'companionVersionId',
      'companionVersionHash',
      'duplicateProjectId',
    ],
    properties: {
      primaryVersionId: idSchema,
      primaryVersionHash: sha256Schema,
      companionProjectId: idSchema,
      companionVersionId: idSchema,
      companionVersionHash: sha256Schema,
      duplicateProjectId: idSchema,
    },
  }),
  defineSchema('mvp-core-gate-executed', 1, 'Persisted server-evaluated MVP Core gate response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['gate', 'replayed'],
      properties: {
        gate: mvpCoreGateSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('mvp-core-gate-list', 1, 'Persisted MVP Core gate history',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['gates'],
      properties: {
        gates: {
          type: 'array',
          maxItems: 100,
          items: mvpCoreGateSchema,
        },
      },
    }),
  ),
  defineSchema('catalog-speech-segments-request', 1, 'Catalog virtual speech segments from an immutable aligned transcript', {
    type: 'object',
    additionalProperties: false,
    required: [
      'sourceTranscriptId',
      'expectedTranscriptHash',
      'extractionPolicyVersion',
      'producer',
      'annotations',
    ],
    properties: {
      sourceTranscriptId: idSchema,
      expectedTranscriptHash: sha256Schema,
      extractionPolicyVersion: { const: 'speech-segment-extraction/v1' },
      producer: speechCatalogProducerSchema,
      annotations: {
        type: 'array',
        maxItems: 100000,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceSegmentId'],
          properties: {
            sourceSegmentId: { type: 'integer', minimum: 0 },
            speaker: speechObservedInputSchema,
            visual: {
              type: 'object',
              additionalProperties: false,
              properties: {
                emotion: speechObservedInputSchema,
                expression: speechObservedInputSchema,
                wardrobe: speechObservedInputSchema,
                setting: speechObservedInputSchema,
                colors: {
                  type: 'array',
                  maxItems: 32,
                  items: speechObservedInputSchema,
                },
              },
            },
            intentions: {
              type: 'array',
              maxItems: 64,
              items: speechObservedInputSchema,
            },
          },
        },
      },
    },
  }),
  defineSchema('speech-segment-cataloged', 1, 'Persisted virtual speech segment catalog run',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run', 'replayed'],
      properties: {
        run: speechCatalogRunSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('speech-segment-search-results', 1, 'Workspace-scoped virtual speech segment search results',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'segment',
              'matchedBy',
              'rightsStatus',
              'eligibleForReuse',
              'blockedReasons',
            ],
            properties: {
              segment: speechSegmentSchema,
              matchedBy: {
                type: 'array',
                maxItems: 10,
                uniqueItems: true,
                items: {
                  enum: [
                    'speech',
                    'intention',
                    'person',
                    'emotion',
                    'expression',
                    'wardrobe',
                    'setting',
                    'source-artifact',
                    'classification',
                    'complete-thought',
                  ],
                },
              },
              rightsStatus: {
                type: 'string',
                minLength: 1,
                maxLength: 64,
              },
              eligibleForReuse: { type: 'boolean' },
              blockedReasons: {
                type: 'array',
                maxItems: 16,
                uniqueItems: true,
                items: { type: 'string', minLength: 1, maxLength: 128 },
              },
            },
          },
        },
      },
    }),
  ),
  defineSchema('catalog-evidence-segment-request', 1, 'Catalog immutable proof from an exact SpeechSegment and current rights snapshot', {
    type: 'object',
    additionalProperties: false,
    required: [
      'sourceSpeechSegmentId',
      'expectedSpeechSegmentHash',
      'category',
      'claim',
      'context',
      'qualifiers',
      'subject',
      'attribution',
      'compatibleOfferIds',
      'compatibleAudienceTags',
      'compatibleObjections',
      'credibilityScore',
      'specificityScore',
      'authenticityScore',
      'contextRangeMs',
      'frameRefs',
      'adjacentEvidenceIds',
      'requiresContext',
      'producer',
    ],
    properties: {
      sourceSpeechSegmentId: idSchema,
      expectedSpeechSegmentHash: sha256Schema,
      category: {
        enum: [
          'testimonial',
          'financial-result',
          'before-after',
          'hearsay',
          'authority',
          'case-study',
          'demonstration',
        ],
      },
      claim: evidenceObservedInputSchema,
      result: evidenceObservedInputSchema,
      context: evidenceObservedInputSchema,
      qualifiers: {
        type: 'array',
        maxItems: 32,
        items: evidenceObservedInputSchema,
      },
      subject: evidenceIdentityObservedInputSchema,
      attribution: evidenceIdentityObservedInputSchema,
      compatibleOfferIds: {
        type: 'array',
        maxItems: 64,
        uniqueItems: true,
        items: idSchema,
      },
      compatibleAudienceTags: {
        type: 'array',
        maxItems: 64,
        uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: 240 },
      },
      compatibleObjections: {
        type: 'array',
        maxItems: 64,
        uniqueItems: true,
        items: { type: 'string', minLength: 1, maxLength: 240 },
      },
      credibilityScore: { type: 'number', minimum: 0, maximum: 1 },
      specificityScore: { type: 'number', minimum: 0, maximum: 1 },
      authenticityScore: { type: 'number', minimum: 0, maximum: 1 },
      contextRangeMs: {
        type: 'array',
        minItems: 2,
        maxItems: 2,
        items: { type: 'integer', minimum: 0 },
      },
      frameRefs: {
        type: 'array',
        maxItems: 64,
        uniqueItems: true,
        items: idSchema,
      },
      adjacentEvidenceIds: {
        type: 'array',
        maxItems: 64,
        uniqueItems: true,
        items: idSchema,
      },
      requiresContext: { type: 'boolean' },
      producer: evidenceProducerSchema,
    },
  }),
  defineSchema('evidence-segment-cataloged', 1, 'Persisted immutable virtual evidence segment',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['evidence', 'replayed'],
      properties: {
        evidence: evidenceSegmentSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('evidence-segment-search-results', 1, 'Workspace-scoped evidence search and reuse preflight results',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['evidence', 'matchedBy', 'reuseDecision'],
            properties: {
              evidence: evidenceSegmentSchema,
              matchedBy: {
                type: 'array',
                maxItems: 7,
                uniqueItems: true,
                items: {
                  enum: [
                    'text',
                    'category',
                    'subject',
                    'attribution',
                    'source-speech-segment',
                    'offer',
                    'objection',
                  ],
                },
              },
              reuseDecision: evidenceReuseDecisionSchema,
            },
          },
        },
      },
    }),
  ),
  defineSchema('catalog-long-form-moments-request', 1, 'Catalog hierarchical chapters and moments from an immutable long-form video master', {
    type: 'object',
    additionalProperties: false,
    required: [
      'sourceArtifactId',
      'expectedArtifactSha256',
      'sourceManifestId',
      'expectedManifestHash',
      'indexPolicyVersion',
      'producer',
      'chapters',
      'moments',
    ],
    properties: {
      sourceArtifactId: idSchema,
      expectedArtifactSha256: sha256Schema,
      sourceManifestId: idSchema,
      expectedManifestHash: sha256Schema,
      indexPolicyVersion: { const: 'long-form-index/v1' },
      producer: longFormProducerSchema,
      chapters: {
        type: 'array',
        minItems: 1,
        maxItems: 10000,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'sourceChapterId',
            'title',
            'topicPath',
            'rangeMs',
          ],
          properties: {
            sourceChapterId: idSchema,
            title: longFormObservationInputSchema,
            topicPath: {
              type: 'array',
              maxItems: 16,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 240,
              },
            },
            rangeMs: longFormRangeSchema,
          },
        },
      },
      moments: {
        type: 'array',
        minItems: 1,
        maxItems: 100000,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'sourceMomentId',
            'sourceChapterId',
            'topic',
            'summary',
            'speakerIds',
            'rangesMs',
            'recommendedRangeIndex',
            'evidenceSpanIds',
            'salience',
            'hookPotential',
            'standaloneScore',
            'contextScore',
            'insightDensity',
            'roles',
            'tags',
          ],
          properties: {
            sourceMomentId: idSchema,
            sourceChapterId: idSchema,
            topic: longFormObservationInputSchema,
            summary: longFormObservationInputSchema,
            keyQuote: longFormObservationInputSchema,
            speakerIds: {
              type: 'array',
              maxItems: 64,
              uniqueItems: true,
              items: idSchema,
            },
            rangesMs: {
              type: 'array',
              minItems: 1,
              maxItems: 32,
              items: longFormRangeSchema,
            },
            recommendedRangeIndex: {
              type: 'integer',
              minimum: 0,
              maximum: 31,
            },
            evidenceSpanIds: {
              type: 'array',
              maxItems: 256,
              uniqueItems: true,
              items: idSchema,
            },
            salience: { type: 'number', minimum: 0, maximum: 1 },
            hookPotential: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            standaloneScore: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            contextScore: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            insightDensity: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            roles: {
              type: 'array',
              maxItems: 32,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 240,
              },
            },
            tags: {
              type: 'array',
              maxItems: 64,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 240,
              },
            },
          },
        },
      },
    },
  }),
  defineSchema('long-form-moments-cataloged', 1, 'Persisted immutable hierarchy of virtual long-form chapters and moments',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run', 'replayed'],
      properties: {
        run: longFormIndexRunSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('long-form-moment-search-results', 1, 'Workspace-scoped long-form moment search with bounded master preview ranges',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'moment',
              'chapter',
              'matchedBy',
              'preview',
              'rightsSnapshotId',
              'rightsStatus',
              'consentStatus',
              'eligibleForReuse',
              'blockedReasons',
            ],
            properties: {
              moment: longFormMomentSchema,
              chapter: longFormChapterSchema,
              matchedBy: {
                type: 'array',
                maxItems: 7,
                uniqueItems: true,
                items: {
                  enum: [
                    'text',
                    'chapter',
                    'source-artifact',
                    'speaker',
                    'role',
                    'tag',
                    'salience',
                  ],
                },
              },
              preview: longFormPreviewSchema,
              rightsSnapshotId: idSchema,
              rightsStatus: {
                enum: [
                  'approved',
                  'restricted',
                  'unknown',
                  'expired',
                  'revoked',
                ],
              },
              consentStatus: {
                enum: [
                  'not-required',
                  'approved',
                  'restricted',
                  'unknown',
                  'expired',
                  'revoked',
                ],
              },
              eligibleForReuse: { type: 'boolean' },
              blockedReasons: {
                type: 'array',
                maxItems: 16,
                uniqueItems: true,
                items: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 128,
                },
              },
            },
          },
        },
      },
    }),
  ),
  defineSchema('catalog-validated-segment-request', 1, 'Catalog historical performance validation for an exact virtual segment or whole video', {
    type: 'object',
    additionalProperties: false,
    required: [
      'sourceArtifactId',
      'expectedArtifactSha256',
      'sourceManifestId',
      'expectedManifestHash',
      'policyVersion',
      'scope',
      'source',
      'performance',
      'validatedAt',
    ],
    dependentRequired: {
      sourceSpeechSegmentId: ['expectedSpeechSegmentHash'],
      expectedSpeechSegmentHash: ['sourceSpeechSegmentId'],
    },
    properties: {
      sourceArtifactId: idSchema,
      expectedArtifactSha256: sha256Schema,
      sourceManifestId: idSchema,
      expectedManifestHash: sha256Schema,
      sourceSpeechSegmentId: idSchema,
      expectedSpeechSegmentHash: sha256Schema,
      policyVersion: { const: 'validated-segment/v1' },
      scope: validationScopeSchema,
      source: validationSourceSchema,
      performance: validationPerformanceSchema,
      validatedAt: dateTimeSchema,
      expiresAt: dateTimeSchema,
    },
  }),
  defineSchema('validated-segment-cataloged', 1, 'Persisted immutable historical validation and protected envelope',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['segment', 'replayed'],
      properties: {
        segment: validatedSegmentSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('validated-segment-search-results', 1, 'Workspace-scoped validation search with current rights eligibility',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'segment',
              'matchedBy',
              'currentRightsStatus',
              'currentConsentStatus',
              'eligibleForReuse',
              'blockedReasons',
            ],
            properties: {
              segment: validatedSegmentSchema,
              matchedBy: {
                type: 'array',
                maxItems: 7,
                uniqueItems: true,
                items: {
                  enum: [
                    'text',
                    'source-artifact',
                    'platform',
                    'unit',
                    'evidence-scope',
                    'metric',
                    'active-at',
                  ],
                },
              },
              currentRightsSnapshotId: idSchema,
              currentRightsStatus: {
                enum: [
                  'approved',
                  'restricted',
                  'unknown',
                  'expired',
                  'revoked',
                ],
              },
              currentConsentStatus: {
                enum: [
                  'approved',
                  'not-required',
                  'restricted',
                  'unknown',
                  'expired',
                  'revoked',
                ],
              },
              eligibleForReuse: { type: 'boolean' },
              blockedReasons: {
                type: 'array',
                maxItems: 16,
                uniqueItems: true,
                items: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 128,
                },
              },
            },
          },
        },
      },
    }),
  ),
  defineSchema('preflight-validated-segment-reuse-request', 1, 'Evaluate one exact validation against a new recipe without asserting causality', {
    type: 'object',
    additionalProperties: false,
    required: ['targetRecipe', 'requestedChanges', 'claim'],
    properties: {
      targetRecipe: validatedSegmentTargetRecipeSchema,
      requestedChanges: {
        type: 'array',
        maxItems: 4,
        uniqueItems: true,
        items: { enum: ['copy', 'take', 'timing', 'opening'] },
      },
      claim: { enum: ['historical-association', 'causality'] },
    },
  }),
  defineSchema('validated-segment-reuse-preflight', 1, 'Deterministic compatibility decision preserving scope, envelope and non-causal interpretation',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['decision'],
      properties: {
        decision: validatedSegmentReuseDecisionSchema,
      },
    }),
  ),
  defineSchema('catalog-semantic-search-document-request', 1, 'Catalog one immutable source identity for full-text and semantic retrieval', {
    type: 'object',
    additionalProperties: false,
    required: [
      'source',
      'expectedSourceHash',
      'indexVersion',
      'observations',
    ],
    properties: {
      source: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'id'],
        properties: {
          type: {
            enum: [
              'artifact',
              'speech-segment',
              'evidence-segment',
              'long-form-moment',
              'validated-segment',
            ],
          },
          id: idSchema,
        },
      },
      expectedSourceHash: sha256Schema,
      indexVersion: { const: 'semantic-search-index/v1' },
      observations: {
        type: 'object',
        additionalProperties: false,
        required: ['producer'],
        properties: {
          ocrText: { type: 'string', maxLength: 100000 },
          description: { type: 'string', maxLength: 20000 },
          intentions: {
            type: 'array',
            maxItems: 100,
            uniqueItems: true,
            items: {
              type: 'string',
              pattern: '^[a-z0-9][a-z0-9._/-]{0,127}$',
            },
          },
          personIds: {
            type: 'array',
            maxItems: 100,
            uniqueItems: true,
            items: idSchema,
          },
          metadata: {
            type: 'object',
            maxProperties: 50,
            additionalProperties: {
              type: 'string',
              minLength: 1,
              maxLength: 500,
            },
          },
          producer: semanticSearchProducerSchema,
        },
      },
    },
  }),
  defineSchema('semantic-search-document-cataloged', 1, 'Persisted immutable hybrid-search document without vector materialization',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['document', 'replayed'],
      properties: {
        document: semanticSearchDocumentSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('hybrid-search-query-request', 1, 'Hybrid full-text, vector and structured retrieval request', hybridSearchQuerySchema),
  defineSchema('hybrid-search-results', 1, 'Rights-aware deduplicated results reranked by hybrid-rerank/v1',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: [
        'schemaVersion',
        'query',
        'queryHash',
        'resultSetHash',
        'semantic',
        'rerankPolicyVersion',
        'results',
        'evaluatedAt',
      ],
      properties: {
        schemaVersion: { const: 'hybrid-search-results/v1' },
        query: hybridSearchQuerySchema,
        queryHash: sha256Schema,
        resultSetHash: sha256Schema,
        semantic: {
          type: 'object',
          additionalProperties: false,
          required: [
            'state',
            'provider',
            'model',
            'version',
            'dimensions',
            'degraded',
          ],
          properties: {
            state: { enum: ['ready', 'unavailable'] },
            provider: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            model: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            version: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            dimensions: {
              type: 'integer',
              minimum: 8,
              maximum: 4096,
            },
            degraded: { type: 'boolean' },
          },
        },
        rerankPolicyVersion: { const: 'hybrid-rerank/v1' },
        results: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'document',
              'score',
              'scoreBreakdown',
              'matchedBy',
              'blockedReasons',
              'eligibleForReuse',
              'rerankPolicyVersion',
            ],
            properties: {
              document: semanticSearchDocumentSchema,
              score: { type: 'number', minimum: 0, maximum: 1 },
              scoreBreakdown: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'fullText',
                  'vector',
                  'intention',
                  'structured',
                  'rights',
                ],
                properties: {
                  fullText: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                  },
                  vector: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                  },
                  intention: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                  },
                  structured: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                  },
                  rights: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                  },
                },
              },
              matchedBy: hybridMatchReasonsSchema,
              blockedReasons: {
                type: 'array',
                maxItems: 32,
                uniqueItems: true,
                items: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 128,
                },
              },
              eligibleForReuse: { type: 'boolean' },
              rerankPolicyVersion: {
                const: 'hybrid-rerank/v1',
              },
            },
          },
        },
        evaluatedAt: dateTimeSchema,
      },
    }),
  ),
  defineSchema('evaluate-hybrid-retrieval-request', 1, 'Run a persisted precision, recall and nDCG evaluation over fixed relevance judgments', {
    type: 'object',
    additionalProperties: false,
    required: ['k', 'cases'],
    properties: {
      k: { type: 'integer', minimum: 1, maximum: 100 },
      cases: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'query', 'relevantIdentityKeys'],
          properties: {
            id: idSchema,
            query: {
              type: 'object',
              additionalProperties: false,
              required: ['rightsUse'],
              anyOf: [
                {
                  properties: {
                    text: hybridSearchQueryProperties.text,
                  },
                  required: ['text'],
                },
                {
                  properties: {
                    intention:
                      hybridSearchQueryProperties.intention,
                  },
                  required: ['intention'],
                },
                {
                  properties: {
                    filters: hybridSearchQueryProperties.filters,
                  },
                  required: ['filters'],
                },
                ...['atmosphere', 'personIds', 'speech', 'visual'].map(
                  (field) => ({
                    properties: {
                      [field]:
                        hybridSearchQueryProperties[
                          field as keyof typeof hybridSearchQueryProperties
                        ],
                    },
                    required: [field],
                  }),
                ),
              ],
              properties: hybridSearchQueryProperties,
            },
            relevantIdentityKeys: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 3,
                maxLength: 260,
              },
            },
          },
        },
      },
    },
  }),
  defineSchema('hybrid-retrieval-evaluated', 1, 'Persisted retrieval evaluation with per-query and macro metrics',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['evaluation', 'replayed'],
      properties: {
        evaluation: {
          type: 'object',
          additionalProperties: false,
          required: [
            'schemaVersion',
            'id',
            'workspaceId',
            'projectId',
            'policyVersion',
            'rerankPolicyVersion',
            'k',
            'cases',
            'aggregate',
            'createdBy',
            'createdAt',
            'reportHash',
          ],
          properties: {
            schemaVersion: { const: 'retrieval-evaluation/v1' },
            id: idSchema,
            workspaceId: idSchema,
            projectId: idSchema,
            policyVersion: { const: 'retrieval-eval/v1' },
            rerankPolicyVersion: { const: 'hybrid-rerank/v1' },
            k: { type: 'integer', minimum: 1, maximum: 100 },
            cases: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'id',
                  'queryHash',
                  'relevantIdentityKeys',
                  'rankedIdentityKeys',
                  'metrics',
                  'semanticState',
                ],
                properties: {
                  id: idSchema,
                  queryHash: sha256Schema,
                  relevantIdentityKeys: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 500,
                    uniqueItems: true,
                    items: {
                      type: 'string',
                      minLength: 3,
                      maxLength: 260,
                    },
                  },
                  rankedIdentityKeys: {
                    type: 'array',
                    maxItems: 100,
                    uniqueItems: true,
                    items: {
                      type: 'string',
                      minLength: 3,
                      maxLength: 260,
                    },
                  },
                  metrics: retrievalMetricsSchema,
                  semanticState: {
                    enum: ['ready', 'unavailable'],
                  },
                },
              },
            },
            aggregate: retrievalMetricsSchema,
            createdBy: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'id'],
              properties: {
                type: { const: 'api-client' },
                id: idSchema,
              },
            },
            createdAt: dateTimeSchema,
            reportHash: sha256Schema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('evaluate-retrieval-scale-request', 1, 'Measure fixed relevance judgments and latency against one stable project or workspace library snapshot', {
    type: 'object',
    additionalProperties: false,
    required: ['scope', 'k', 'cases'],
    properties: {
      scope: { enum: ['project', 'workspace'] },
      k: { type: 'integer', minimum: 1, maximum: 100 },
      cases: {
        type: 'array',
        minItems: 3,
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'query', 'relevantIdentityKeys'],
          properties: {
            id: idSchema,
            query: retrievalScaleQuerySchema,
            relevantIdentityKeys: {
              type: 'array',
              minItems: 1,
              maxItems: 500,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 3,
                maxLength: 260,
              },
            },
          },
        },
      },
    },
  }),
  defineSchema('retrieval-scale-evaluated', 1, 'Immutable quality and latency report bound to a stable semantic library size',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['evaluation', 'replayed'],
      properties: {
        evaluation: {
          type: 'object',
          additionalProperties: false,
          required: [
            'schemaVersion',
            'id',
            'workspaceId',
            'projectId',
            'policyVersion',
            'rerankPolicyVersion',
            'scope',
            'librarySize',
            'k',
            'cases',
            'aggregateQuality',
            'aggregateLatency',
            'createdBy',
            'createdAt',
            'reportHash',
          ],
          properties: {
            schemaVersion: {
              const: 'retrieval-scale-evaluation/v1',
            },
            id: idSchema,
            workspaceId: idSchema,
            projectId: idSchema,
            policyVersion: { const: 'retrieval-scale-eval/v1' },
            rerankPolicyVersion: { const: 'hybrid-rerank/v1' },
            scope: { enum: ['project', 'workspace'] },
            librarySize: { type: 'integer', minimum: 1 },
            k: { type: 'integer', minimum: 1, maximum: 100 },
            cases: {
              type: 'array',
              minItems: 3,
              maxItems: 50,
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'id',
                  'queryHash',
                  'relevantIdentityKeys',
                  'rankedIdentityKeys',
                  'metrics',
                  'semanticState',
                  'latencyMs',
                ],
                properties: {
                  id: idSchema,
                  queryHash: sha256Schema,
                  relevantIdentityKeys: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 500,
                    uniqueItems: true,
                    items: {
                      type: 'string',
                      minLength: 3,
                      maxLength: 260,
                    },
                  },
                  rankedIdentityKeys: {
                    type: 'array',
                    maxItems: 100,
                    uniqueItems: true,
                    items: {
                      type: 'string',
                      minLength: 3,
                      maxLength: 260,
                    },
                  },
                  metrics: retrievalMetricsSchema,
                  semanticState: {
                    enum: ['ready', 'unavailable'],
                  },
                  latencyMs: {
                    type: 'integer',
                    minimum: 0,
                    maximum: 3600000,
                  },
                },
              },
            },
            aggregateQuality: retrievalMetricsSchema,
            aggregateLatency: {
              type: 'object',
              additionalProperties: false,
              required: [
                'sampleCount',
                'minMs',
                'p50Ms',
                'p95Ms',
                'maxMs',
                'meanMs',
              ],
              properties: {
                sampleCount: {
                  type: 'integer',
                  minimum: 3,
                  maximum: 50,
                },
                minMs: { type: 'integer', minimum: 0 },
                p50Ms: { type: 'integer', minimum: 0 },
                p95Ms: { type: 'integer', minimum: 0 },
                maxMs: { type: 'integer', minimum: 0 },
                meanMs: { type: 'integer', minimum: 0 },
              },
            },
            createdBy: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'id'],
              properties: {
                type: { const: 'api-client' },
                id: idSchema,
              },
            },
            createdAt: dateTimeSchema,
            reportHash: sha256Schema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('record-semantic-reuse-request', 1, 'Record one trusted semantic search and partition every eligible result into reused or Director-rejected candidates', {
    type: 'object',
    additionalProperties: false,
    required: [
      'query',
      'expectedQueryHash',
      'expectedResultSetHash',
      'reusedIdentityKeys',
      'directorRejections',
    ],
    properties: {
      query: hybridSearchQuerySchema,
      expectedQueryHash: sha256Schema,
      expectedResultSetHash: sha256Schema,
      reusedIdentityKeys: {
        type: 'array',
        maxItems: 100,
        uniqueItems: true,
        items: {
          type: 'string',
          minLength: 3,
          maxLength: 260,
        },
      },
      directorRejections: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['identityKey', 'reason'],
          properties: {
            identityKey: {
              type: 'string',
              minLength: 3,
              maxLength: 260,
            },
            reason: {
              enum: [
                'narrative-mismatch',
                'duplicate',
                'quality-lower',
                'duration-mismatch',
                'continuity-risk',
                'not-needed',
              ],
            },
          },
        },
      },
    },
  }),
  defineSchema('semantic-reuse-recorded', 1, 'Immutable audit of candidates returned, reused, Director-rejected and rejected by trusted retrieval policy',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run', 'replayed'],
      properties: {
        run: {
          type: 'object',
          additionalProperties: false,
          required: [
            'schemaVersion',
            'id',
            'workspaceId',
            'projectId',
            'queryHash',
            'resultSetHash',
            'query',
            'semantic',
            'rerankPolicyVersion',
            'candidateAudit',
            'returnedIdentityKeys',
            'reusedIdentityKeys',
            'directorRejections',
            'candidateCount',
            'returnedCount',
            'reusedCount',
            'searchEvaluatedAt',
            'searchLatencyMs',
            'createdBy',
            'createdAt',
            'runHash',
          ],
          properties: {
            schemaVersion: { const: 'semantic-reuse-run/v1' },
            id: idSchema,
            workspaceId: idSchema,
            projectId: idSchema,
            queryHash: sha256Schema,
            resultSetHash: sha256Schema,
            query: hybridSearchQuerySchema,
            semantic: {
              type: 'object',
              additionalProperties: false,
              required: [
                'state',
                'provider',
                'model',
                'version',
                'dimensions',
                'degraded',
              ],
              properties: {
                state: { enum: ['ready', 'unavailable'] },
                provider: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 128,
                },
                model: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 128,
                },
                version: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 128,
                },
                dimensions: {
                  type: 'integer',
                  minimum: 8,
                  maximum: 4096,
                },
                degraded: { type: 'boolean' },
              },
            },
            rerankPolicyVersion: { const: 'hybrid-rerank/v1' },
            candidateAudit: {
              type: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'documentId',
                  'identityKey',
                  'disposition',
                  'rejectionReasons',
                ],
                properties: {
                  documentId: idSchema,
                  identityKey: {
                    type: 'string',
                    minLength: 3,
                    maxLength: 260,
                  },
                  rank: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 100,
                  },
                  score: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                  },
                  disposition: {
                    enum: ['returned', 'rejected'],
                  },
                  rejectionReasons: {
                    type: 'array',
                    maxItems: 32,
                    uniqueItems: true,
                    items: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 128,
                    },
                  },
                },
              },
            },
            returnedIdentityKeys: {
              type: 'array',
              maxItems: 100,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 3,
                maxLength: 260,
              },
            },
            reusedIdentityKeys: {
              type: 'array',
              maxItems: 100,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 3,
                maxLength: 260,
              },
            },
            directorRejections: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['identityKey', 'reason'],
                properties: {
                  identityKey: {
                    type: 'string',
                    minLength: 3,
                    maxLength: 260,
                  },
                  reason: {
                    enum: [
                      'narrative-mismatch',
                      'duplicate',
                      'quality-lower',
                      'duration-mismatch',
                      'continuity-risk',
                      'not-needed',
                    ],
                  },
                },
              },
            },
            candidateCount: {
              type: 'integer',
              minimum: 0,
              maximum: 500,
            },
            returnedCount: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
            },
            reusedCount: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
            },
            searchEvaluatedAt: dateTimeSchema,
            searchLatencyMs: {
              type: 'integer',
              minimum: 0,
              maximum: 3600000,
            },
            createdBy: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'id'],
              properties: {
                type: { const: 'api-client' },
                id: idSchema,
              },
            },
            createdAt: dateTimeSchema,
            runHash: sha256Schema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('execute-hierarchical-processing-request', 1, 'Execute an exact long-form artifact and transcript through versioned overlapping processing tiers', {
    type: 'object',
    additionalProperties: false,
    required: [
      'sourceArtifactId',
      'expectedArtifactSha256',
      'sourceManifestId',
      'expectedManifestHash',
      'sourceTranscriptId',
      'expectedTranscriptHash',
      'processingPolicyVersion',
      'chunking',
      'tierVersions',
      'budget',
    ],
    properties: {
      sourceArtifactId: idSchema,
      expectedArtifactSha256: sha256Schema,
      sourceManifestId: idSchema,
      expectedManifestHash: sha256Schema,
      sourceTranscriptId: idSchema,
      expectedTranscriptHash: sha256Schema,
      processingPolicyVersion: {
        const: 'hierarchical-processing/v1',
      },
      chunking: {
        type: 'object',
        additionalProperties: false,
        required: [
          'policyVersion',
          'chunkDurationMs',
          'overlapMs',
        ],
        properties: {
          policyVersion: { const: 'overlapping-time-chunks/v1' },
          chunkDurationMs: {
            type: 'integer',
            minimum: 60000,
            maximum: 900000,
          },
          overlapMs: {
            type: 'integer',
            minimum: 0,
            maximum: 60000,
          },
        },
      },
      tierVersions: hierarchicalTierVersionsSchema,
      previousRun: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'expectedRunHash'],
        properties: {
          id: idSchema,
          expectedRunHash: sha256Schema,
        },
      },
      budget: hierarchicalBudgetSchema,
    },
  }),
  defineSchema('hierarchical-processing-executed', 1, 'Persisted hierarchical processing with chunk mapping, tier lineage, aggregation and measurements',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run', 'replayed'],
      properties: {
        run: hierarchicalProcessingRunSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('hierarchical-processing-run-read', 1, 'Read one exact immutable hierarchical processing run',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run'],
      properties: {
        run: hierarchicalProcessingRunSchema,
      },
    }),
  ),
  defineSchema('create-source-deconstruction-request', 1, 'Deconstruct one exact published source from cataloged speech evidence', {
    type: 'object',
    additionalProperties: false,
    required: [
      'sourceArtifactId',
      'expectedArtifactSha256',
      'sourceTranscriptId',
      'expectedTranscriptHash',
      'desiredRole',
      'validationScope',
      'targetComposition',
    ],
    properties: {
      sourceArtifactId: idSchema,
      expectedArtifactSha256: sha256Schema,
      sourceTranscriptId: idSchema,
      expectedTranscriptHash: sha256Schema,
      desiredRole: sourceDeconstructionDesiredRoleSchema,
      validationScope: sourceDeconstructionValidationScopeSchema,
      targetComposition: sourceDeconstructionTargetCompositionSchema,
      boundaryPolicy: sourceDeconstructionBoundaryPolicySchema,
    },
  }),
  defineSchema('source-deconstruction-mutated', 1, 'Created or replayed immutable source deconstruction report',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['report', 'replayed'],
      properties: {
        report: sourceDeconstructionReportSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('source-deconstruction-read', 1, 'Read one immutable source deconstruction report',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['report'],
      properties: {
        report: sourceDeconstructionReportSchema,
      },
    }),
  ),
  defineSchema('source-deconstruction-comparison-read', 1, 'Read the source-versus-clean timeline, transcript and segment mapping',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['comparison'],
      properties: {
        comparison: sourceDeconstructionComparisonSchema,
      },
    }),
  ),
  defineSchema('source-deconstruction-page', 1, 'Cursor page of immutable source deconstruction reports',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['reports'],
      properties: {
        reports: {
          type: 'array',
          maxItems: 100,
          items: sourceDeconstructionReportSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-contamination-report-request', 1, 'Diagnose multimodal contamination against one exact source deconstruction', {
    type: 'object',
    additionalProperties: false,
    required: [
      'sourceDeconstructionReportId',
      'expectedSourceDeconstructionReportHash',
      'analyzer',
      'observations',
      'protectedRegions',
    ],
    properties: {
      sourceDeconstructionReportId: idSchema,
      expectedSourceDeconstructionReportHash: sha256Schema,
      analyzer: contaminationDetectorSchema,
      policy: contaminationPolicyInputSchema,
      observations: {
        type: 'array',
        maxItems: 10_000,
        items: contaminationObservationSchema,
      },
      protectedRegions: {
        type: 'array',
        maxItems: 5_000,
        items: contaminationProtectedRegionInputSchema,
      },
    },
  }),
  defineSchema('contamination-report-mutated', 1, 'Created or replayed immutable source-contamination report',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['report', 'replayed'],
      properties: {
        report: contaminationReportSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('contamination-report-read', 1, 'Read one immutable source-contamination report',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['report'],
      properties: {
        report: contaminationReportSchema,
      },
    }),
  ),
  defineSchema('contamination-diagnostics-read', 1, 'Read Director, human-review or dual contamination diagnostics',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['diagnostics'],
      properties: {
        diagnostics: contaminationDiagnosticsSchema,
      },
    }),
  ),
  defineSchema('contamination-report-page', 1, 'Cursor page of immutable source-contamination reports',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['reports'],
      properties: {
        reports: {
          type: 'array',
          maxItems: 100,
          items: contaminationReportSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-source-cleanup-request', 1, 'Choose and enqueue one bounded source-cleanup strategy', {
    type: 'object',
    additionalProperties: false,
    required: [
      'contaminationReportId',
      'expectedReportHash',
      'findingId',
    ],
    properties: {
      contaminationReportId: idSchema,
      expectedReportHash: sha256Schema,
      findingId: idSchema,
      policy: sourceCleanupPolicySchema,
    },
  }),
  defineSchema('source-cleanup-mutated', 1, 'Created, rejected or replayed source-cleanup plan and operation',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['cleanup', 'replayed'],
      properties: {
        cleanup: sourceCleanupRecordSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('source-cleanup-read', 1, 'Read one source-cleanup plan, operation and mandatory review',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['cleanup'],
      properties: {
        cleanup: sourceCleanupRecordSchema,
      },
    }),
  ),
  defineSchema('source-cleanup-page', 1, 'Cursor page of source-cleanup plans and derivative status',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['cleanups'],
      properties: {
        cleanups: {
          type: 'array',
          maxItems: 100,
          items: sourceCleanupRecordSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-validation-envelope-reuse-request', 1, 'Compose an exact validated hook envelope with a target VariantRecipe', {
    type: 'object',
    additionalProperties: false,
    required: [
      'batchId',
      'validatedSegmentId',
      'expectedValidatedSegmentHash',
      'targetRecipeId',
      'expectedTargetRecipeHash',
      'policyVersion',
      'requestedChanges',
    ],
    properties: {
      batchId: idSchema,
      validatedSegmentId: idSchema,
      expectedValidatedSegmentHash: sha256Schema,
      targetRecipeId: idSchema,
      expectedTargetRecipeHash: sha256Schema,
      policyVersion: { const: 'validation-envelope-policy/v1' },
      requestedChanges: {
        type: 'array',
        maxItems: 5,
        items: validationEnvelopeChangeSchema,
      },
    },
  }),
  defineSchema('decide-validation-envelope-reuse-request', 1, 'Approve validation loss or reject the protected change', {
    type: 'object',
    additionalProperties: false,
    required: ['expectedPlanHash', 'action', 'note'],
    properties: {
      expectedPlanHash: sha256Schema,
      action: { enum: ['approve', 'reject'] },
      note: { type: 'string', minLength: 3, maxLength: 1_000 },
    },
  }),
  defineSchema('validation-envelope-reuse-mutated', 1, 'Created, approved, rejected or replayed validation-envelope reuse',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['reuse', 'replayed'],
      properties: {
        reuse: validationEnvelopeReuseRecordSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('validation-envelope-reuse-read', 1, 'Read one exact validation-envelope reuse and decisions log',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['reuse'],
      properties: {
        reuse: validationEnvelopeReuseRecordSchema,
      },
    }),
  ),
  defineSchema('validation-envelope-reuse-page', 1, 'Cursor page of exact validation-envelope reuse plans',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['reuses'],
      properties: {
        reuses: {
          type: 'array',
          maxItems: 100,
          items: validationEnvelopeReuseRecordSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema(
    'create-contiguous-extraction-request',
    1,
    'Select one semantic long-form window by objective, topic and target duration',
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'objective',
        'topic',
        'targetDurationMs',
        'toleranceMs',
        'fps',
      ],
      properties: {
        objective: {
          type: 'string',
          minLength: 1,
          maxLength: 240,
        },
        topic: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
        },
        targetDurationMs: {
          type: 'integer',
          minimum: 1_000,
          maximum: 3_600_000,
        },
        toleranceMs: {
          type: 'integer',
          minimum: 0,
          maximum: 3_600_000,
        },
        fps: {
          type: 'integer',
          minimum: 1,
          maximum: 120,
        },
      },
    },
  ),
  defineSchema(
    'contiguous-extraction-mutated',
    1,
    'Created or replayed immutable contiguous extraction',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['extraction', 'replayed'],
      properties: {
        extraction: contiguousExtractionSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema(
    'contiguous-extraction-read',
    1,
    'Read one immutable contiguous extraction',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['extraction'],
      properties: {
        extraction: contiguousExtractionSchema,
      },
    }),
  ),
  defineSchema('create-proof-need-run-request', 1, 'Declare proof type, function and moment for exact StoryPlan claims', {
    type: 'object',
    additionalProperties: false,
    required: [
      'batchId',
      'targetRecipeId',
      'expectedTargetRecipeHash',
      'policyVersion',
      'declarations',
    ],
    properties: {
      batchId: idSchema,
      targetRecipeId: idSchema,
      expectedTargetRecipeHash: sha256Schema,
      policyVersion: { const: 'proof-need-policy/v1' },
      declarations: {
        type: 'array',
        minItems: 1,
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'storyBlockId',
            'claimId',
            'claimText',
            'claimKind',
          ],
          properties: {
            storyBlockId: idSchema,
            claimId: idSchema,
            claimText: {
              type: 'string',
              minLength: 2,
              maxLength: 2_000,
            },
            claimKind: proofNeedClaimKindSchema,
            offerId: idSchema,
            objection: {
              type: 'string',
              minLength: 2,
              maxLength: 500,
            },
          },
        },
      },
    },
  }),
  defineSchema('proof-need-run-mutated', 1, 'Created or replayed proof-directed StoryPlan',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run', 'replayed'],
      properties: {
        run: proofNeedRunSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('proof-need-run-read', 1, 'Read one immutable proof-directed StoryPlan',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run'],
      properties: {
        run: proofNeedRunSchema,
      },
    }),
  ),
  defineSchema('proof-need-run-page', 1, 'Cursor page of proof-directed StoryPlans',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['runs'],
      properties: {
        runs: {
          type: 'array',
          maxItems: 100,
          items: proofNeedRunSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-proof-integrity-run-request', 1, 'Evaluate exact proof uses against recipe context and current authorization', {
    type: 'object',
    additionalProperties: false,
    required: [
      'proofNeedRunId',
      'expectedProofNeedRunHash',
      'policyVersion',
      'uses',
    ],
    properties: {
      proofNeedRunId: idSchema,
      expectedProofNeedRunHash: sha256Schema,
      policyVersion: { const: 'proof-integrity-policy/v1' },
      uses: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'proofNeedItemId',
            'includedAdjacentEvidenceIds',
          ],
          properties: {
            proofNeedItemId: idSchema,
            includedContextRangeMs: contaminationRangeMsSchema,
            includedAdjacentEvidenceIds: {
              type: 'array',
              maxItems: 64,
              uniqueItems: true,
              items: idSchema,
            },
          },
        },
      },
    },
  }),
  defineSchema('proof-integrity-run-mutated', 1, 'Created or replayed proof integrity evaluation',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run', 'replayed'],
      properties: {
        run: proofIntegrityRunSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('proof-integrity-run-read', 1, 'Read one immutable proof integrity evaluation',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run'],
      properties: {
        run: proofIntegrityRunSchema,
      },
    }),
  ),
  defineSchema('proof-integrity-run-page', 1, 'Cursor page of proof integrity evaluations',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['runs'],
      properties: {
        runs: {
          type: 'array',
          maxItems: 100,
          items: proofIntegrityRunSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-proof-mode-run-request', 1, 'Plan proof presentation modes for approved evidence', {
    type: 'object',
    additionalProperties: false,
    required: [
      'proofIntegrityRunId',
      'expectedProofIntegrityRunHash',
      'policyVersion',
      'formats',
      'rhythm',
      'overrides',
    ],
    properties: {
      proofIntegrityRunId: idSchema,
      expectedProofIntegrityRunHash: sha256Schema,
      policyVersion: { const: 'proof-mode-policy/v1' },
      formats: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        uniqueItems: true,
        items: {
          enum: ['9:16', '16:9', '4:5', '1:1', '21:9'],
        },
      },
      rhythm: { enum: ['fast', 'measured'] },
      overrides: {
        type: 'array',
        maxItems: 80,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'proofNeedItemId',
            'format',
            'mode',
            'expectedEvaluationHash',
          ],
          properties: {
            proofNeedItemId: idSchema,
            format: {
              enum: ['9:16', '16:9', '4:5', '1:1', '21:9'],
            },
            mode: {
              enum: ['cutaway', 'split-screen', 'proof-card'],
            },
            expectedEvaluationHash: sha256Schema,
          },
        },
      },
    },
  }),
  defineSchema('proof-mode-run-mutated', 1, 'Created or replayed proof presentation matrix',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run', 'replayed'],
      properties: {
        run: proofModeRunSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('proof-mode-run-read', 1, 'Read one immutable proof presentation matrix',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['run'],
      properties: {
        run: proofModeRunSchema,
      },
    }),
  ),
  defineSchema('proof-mode-run-page', 1, 'Cursor page of proof presentation matrices',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['runs'],
      properties: {
        runs: {
          type: 'array',
          maxItems: 100,
          items: proofModeRunSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-production-batch-request', 1, 'Create one explicit bounded production batch', {
    type: 'object',
    additionalProperties: false,
    required: [
      'projectId',
      'name',
      'objective',
      'sourceGroups',
      'recipes',
      'variants',
      'budget',
      'items',
    ],
    properties: {
      projectId: idSchema,
      name: { type: 'string', minLength: 1, maxLength: 200 },
      objective: {
        type: 'string',
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$',
      },
      sourceGroups: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: productionBatchSourceGroupSchema,
      },
      recipes: {
        type: 'array',
        minItems: 1,
        maxItems: 250,
        items: productionBatchRecipeSchema,
      },
      variants: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: productionBatchVariantSchema,
      },
      budget: productionBatchBudgetSchema,
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 1000,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'key',
            'sourceGroupId',
            'recipeId',
            'variantId',
          ],
          properties: {
            key: {
              type: 'string',
              pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$',
            },
            sourceGroupId: idSchema,
            recipeId: idSchema,
            variantId: idSchema,
          },
        },
      },
    },
  }),
  defineSchema('production-batch-mutated', 1, 'Created or mutated production batch with idempotency evidence',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['batch', 'replayed'],
      properties: {
        batch: productionBatchSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-review', 3, 'Project review with derived current and superseded version states',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['session', 'versions', 'scopeContext', 'scenes', 'annotations'],
      properties: {
        session: reviewSessionSchemaV2,
        versions: { type: 'array', minItems: 1, maxItems: 1000, items: reviewVersionSchemaV2 },
        scopeContext: reviewScopeContextSchema,
        scenes: { type: 'array', maxItems: 1000, items: reviewSceneSchema },
        annotations: { type: 'array', maxItems: 100, items: reviewAnnotationSchemaV2 },
      },
    }),
  ),
  defineSchema('project-created', 3, 'Project creation response with direction snapshot and explicit visible state',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['project', 'version', 'replayed'],
      properties: {
        project: searchableProjectSchemaV2,
        version: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'sequence', 'baseHash', 'snapshotRefs', 'createdAt'],
          properties: {
            id: idSchema,
            sequence: { type: 'integer', minimum: 1 },
            baseHash: sha256Schema,
            snapshotRefs: {
              type: 'object',
              additionalProperties: false,
              required: ['brief', 'editPlan', 'policies'],
              properties: { brief: idSchema, editPlan: idSchema, policies: idSchema },
            },
            createdAt: dateTimeSchema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-workspace', 6, 'Project workspace with visible project and operation states',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['project', 'commands', 'directorRuns', 'media', 'transcripts', 'operationIds', 'operations'],
      properties: {
        project: searchableProjectSchemaV2,
        version: {
          type: 'object', additionalProperties: false, required: ['id', 'sequence', 'baseHash', 'createdAt'],
          properties: { id: idSchema, sequence: { type: 'integer', minimum: 1 }, baseHash: sha256Schema, createdAt: dateTimeSchema },
        },
        brief: { type: 'object', additionalProperties: true },
        editPlan: {
          type: 'object', additionalProperties: false,
          required: ['id', 'state', 'fps', 'durationFrames', 'clipCount', 'cutCount', 'automaticZoom', 'subtitleFaceProtection'],
          properties: {
            id: idSchema, state: { type: 'string' }, fps: { type: 'number', minimum: 0 }, durationFrames: { type: 'integer', minimum: 0 },
            clipCount: { type: 'integer', minimum: 0 }, cutCount: { type: 'integer', minimum: 0 },
            automaticZoom: { type: 'boolean' }, subtitleFaceProtection: { type: 'boolean' },
          },
        },
        commands: {
          type: 'array', maxItems: 20,
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'createdAt'],
            properties: { id: idSchema, type: { enum: ['remove-spoken-content', 'run-director'] }, baseVersionId: idSchema, resultVersionId: idSchema, reason: { type: 'string', maxLength: 1000 }, createdAt: dateTimeSchema },
          },
        },
        directorRuns: {
          type: 'array', maxItems: 10,
          items: {
            type: 'object', additionalProperties: false,
            required: [
              'id', 'status', 'plannerVersion', 'criticVersion', 'baseVersionId', 'resultVersionId',
              'treatmentSnapshotId', 'storySnapshotId', 'qualitySnapshotId', 'qualityStatus',
              'qualityScore', 'decisionCount', 'assumptionCount', 'subtitleCueCount', 'transitionCount',
              'automaticZoom', 'createdAt',
            ],
            properties: {
              id: idSchema, status: { enum: ['planned', 'rendering', 'succeeded', 'failed'] },
              plannerVersion: { type: 'string', minLength: 3, maxLength: 64 }, criticVersion: { type: 'string', minLength: 3, maxLength: 64 },
              baseVersionId: idSchema, resultVersionId: idSchema, treatmentSnapshotId: idSchema,
              storySnapshotId: idSchema, qualitySnapshotId: idSchema,
              qualityStatus: { enum: ['approved', 'approved-with-warnings', 'blocked'] },
              qualityScore: { type: 'number', minimum: 0, maximum: 1 },
              decisionCount: { type: 'integer', minimum: 0, maximum: 64 }, assumptionCount: { type: 'integer', minimum: 0, maximum: 64 },
              subtitleCueCount: { type: 'integer', minimum: 0 }, transitionCount: { type: 'integer', minimum: 0 },
              automaticZoom: { type: 'boolean' }, createdAt: dateTimeSchema,
            },
          },
        },
        media: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'role', 'originalFileName', 'artifactId', 'manifestId', 'mediaType', 'container', 'byteSize', 'sha256', 'status', 'createdAt'],
            properties: {
              id: idSchema, role: { enum: ['source-master', 'editing-proxy', 'editorial-proxy', 'final-output'] }, originalFileName: { type: 'string', minLength: 1, maxLength: 255 },
              artifactId: idSchema, manifestId: idSchema, mediaType: { enum: ['video', 'audio', 'image'] }, container: { type: 'string', minLength: 2, maxLength: 16 },
              byteSize: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, sha256: sha256Schema, status: { enum: ['available', 'quarantined', 'deleted'] }, rightsStatus: { type: 'string' },
              probe: { type: 'object', additionalProperties: false, required: ['width', 'height', 'duration', 'fps'], properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, duration: { type: 'number', exclusiveMinimum: 0 }, fps: { type: 'number', exclusiveMinimum: 0 } } },
              createdAt: dateTimeSchema,
            },
          },
        },
        transcripts: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'sourceArtifactId', 'language', 'provider', 'model', 'transcriptHash', 'text', 'wordCount', 'segmentCount', 'createdAt'],
            properties: {
              id: idSchema, sourceArtifactId: idSchema, language: { type: 'string', minLength: 2, maxLength: 35 }, provider: { type: 'string' }, model: { type: 'string' },
              transcriptHash: sha256Schema, text: { type: 'string' }, wordCount: { type: 'integer', minimum: 0 }, segmentCount: { type: 'integer', minimum: 0 }, createdAt: dateTimeSchema,
            },
          },
        },
        operationIds: { type: 'array', maxItems: 1000, items: idSchema, uniqueItems: true },
        operations: { type: 'array', maxItems: 1000, items: publicOperationSchemaV7 },
      },
    }),
  ),
  defineSchema('project-created', 4, 'Project creation response with visible project and current version states',
    successSchema({
      type: 'object', additionalProperties: false, required: ['project', 'version', 'replayed'],
      properties: {
        project: searchableProjectSchemaV2,
        version: {
          type: 'object', additionalProperties: false,
          required: ['id', 'sequence', 'baseHash', 'snapshotRefs', 'createdAt', 'visibleState'],
          properties: {
            id: idSchema, sequence: { type: 'integer', minimum: 1 }, baseHash: sha256Schema,
            snapshotRefs: {
              type: 'object', additionalProperties: false, required: ['brief', 'editPlan', 'policies'],
              properties: { brief: idSchema, editPlan: idSchema, policies: idSchema },
            },
            createdAt: dateTimeSchema,
            visibleState: currentProjectVersionVisibleStateSchema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-duplicated', 2, 'Copy-on-write project duplication with visible project and current version states',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['project', 'version', 'sharedArtifactIds', 'copiedBytes', 'replayed'],
      properties: {
        project: {
          ...searchableProjectSchemaV2,
          required: [...searchableProjectSchemaV2.required, 'duplicatedFromProjectId'],
          properties: { ...searchableProjectSchemaV2.properties, duplicatedFromProjectId: idSchema },
        },
        version: {
          type: 'object', additionalProperties: false,
          required: [
            'id', 'sequence', 'baseHash', 'forkedFromProjectId', 'forkedFromVersionId',
            'snapshotRefs', 'createdAt', 'visibleState',
          ],
          properties: {
            id: idSchema, sequence: { const: 1 }, baseHash: sha256Schema,
            forkedFromProjectId: idSchema, forkedFromVersionId: idSchema,
            snapshotRefs: {
              type: 'object', additionalProperties: false, required: ['brief', 'editPlan', 'policies'],
              properties: { brief: idSchema, treatment: idSchema, story: idSchema, editPlan: idSchema, policies: idSchema },
            },
            createdAt: dateTimeSchema,
            visibleState: currentProjectVersionVisibleStateSchema,
          },
        },
        sharedArtifactIds: { type: 'array', maxItems: 1000, uniqueItems: true, items: idSchema },
        copiedBytes: { const: 0 },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-workspace', 7, 'Project workspace with visible project, current version and operation states',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['project', 'commands', 'directorRuns', 'media', 'transcripts', 'operationIds', 'operations'],
      properties: {
        project: searchableProjectSchemaV2,
        version: {
          type: 'object', additionalProperties: false,
          required: ['id', 'sequence', 'baseHash', 'createdAt', 'visibleState'],
          properties: {
            id: idSchema, sequence: { type: 'integer', minimum: 1 }, baseHash: sha256Schema,
            createdAt: dateTimeSchema, visibleState: currentProjectVersionVisibleStateSchema,
          },
        },
        brief: { type: 'object', additionalProperties: true },
        editPlan: {
          type: 'object', additionalProperties: false,
          required: ['id', 'state', 'fps', 'durationFrames', 'clipCount', 'cutCount', 'automaticZoom', 'subtitleFaceProtection'],
          properties: {
            id: idSchema, state: { type: 'string' }, fps: { type: 'number', minimum: 0 }, durationFrames: { type: 'integer', minimum: 0 },
            clipCount: { type: 'integer', minimum: 0 }, cutCount: { type: 'integer', minimum: 0 },
            automaticZoom: { type: 'boolean' }, subtitleFaceProtection: { type: 'boolean' },
          },
        },
        commands: {
          type: 'array', maxItems: 20,
          items: {
            type: 'object', additionalProperties: false, required: ['id', 'type', 'baseVersionId', 'createdAt'],
            properties: { id: idSchema, type: { enum: ['remove-spoken-content', 'run-director'] }, baseVersionId: idSchema, resultVersionId: idSchema, reason: { type: 'string', maxLength: 1000 }, createdAt: dateTimeSchema },
          },
        },
        directorRuns: {
          type: 'array', maxItems: 10,
          items: {
            type: 'object', additionalProperties: false,
            required: [
              'id', 'status', 'plannerVersion', 'criticVersion', 'baseVersionId', 'resultVersionId',
              'treatmentSnapshotId', 'storySnapshotId', 'qualitySnapshotId', 'qualityStatus',
              'qualityScore', 'decisionCount', 'assumptionCount', 'subtitleCueCount', 'transitionCount',
              'automaticZoom', 'createdAt',
            ],
            properties: {
              id: idSchema, status: { enum: ['planned', 'rendering', 'succeeded', 'failed'] },
              plannerVersion: { type: 'string', minLength: 3, maxLength: 64 }, criticVersion: { type: 'string', minLength: 3, maxLength: 64 },
              baseVersionId: idSchema, resultVersionId: idSchema, treatmentSnapshotId: idSchema,
              storySnapshotId: idSchema, qualitySnapshotId: idSchema,
              qualityStatus: { enum: ['approved', 'approved-with-warnings', 'blocked'] },
              qualityScore: { type: 'number', minimum: 0, maximum: 1 },
              decisionCount: { type: 'integer', minimum: 0, maximum: 64 }, assumptionCount: { type: 'integer', minimum: 0, maximum: 64 },
              subtitleCueCount: { type: 'integer', minimum: 0 }, transitionCount: { type: 'integer', minimum: 0 },
              automaticZoom: { type: 'boolean' }, createdAt: dateTimeSchema,
            },
          },
        },
        media: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'role', 'originalFileName', 'artifactId', 'manifestId', 'mediaType', 'container', 'byteSize', 'sha256', 'status', 'createdAt'],
            properties: {
              id: idSchema, role: { enum: ['source-master', 'editing-proxy', 'editorial-proxy', 'final-output'] }, originalFileName: { type: 'string', minLength: 1, maxLength: 255 },
              artifactId: idSchema, manifestId: idSchema, mediaType: { enum: ['video', 'audio', 'image'] }, container: { type: 'string', minLength: 2, maxLength: 16 },
              byteSize: { type: 'string', pattern: '^[1-9][0-9]{0,18}$' }, sha256: sha256Schema, status: { enum: ['available', 'quarantined', 'deleted'] }, rightsStatus: { type: 'string' },
              probe: { type: 'object', additionalProperties: false, required: ['width', 'height', 'duration', 'fps'], properties: { width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, duration: { type: 'number', exclusiveMinimum: 0 }, fps: { type: 'number', exclusiveMinimum: 0 } } },
              createdAt: dateTimeSchema,
            },
          },
        },
        transcripts: {
          type: 'array', maxItems: 1000,
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'sourceArtifactId', 'language', 'provider', 'model', 'transcriptHash', 'text', 'wordCount', 'segmentCount', 'createdAt'],
            properties: {
              id: idSchema, sourceArtifactId: idSchema, language: { type: 'string', minLength: 2, maxLength: 35 }, provider: { type: 'string' }, model: { type: 'string' },
              transcriptHash: sha256Schema, text: { type: 'string' }, wordCount: { type: 'integer', minimum: 0 }, segmentCount: { type: 'integer', minimum: 0 }, createdAt: dateTimeSchema,
            },
          },
        },
        operationIds: { type: 'array', maxItems: 1000, items: idSchema, uniqueItems: true },
        operations: { type: 'array', maxItems: 1000, items: publicOperationSchemaV7 },
      },
    }),
  ),
  defineSchema('production-batch-mutated', 2, 'Created or mutated production batch with aggregate and per-item visible state',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['batch', 'replayed'],
      properties: {
        batch: productionBatchSchemaV2,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('production-batch-read', 1, 'Read one production batch with truthful aggregate status and progress',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['batch'],
      properties: {
        batch: productionBatchSchema,
      },
    }),
  ),
  defineSchema('production-batch-read', 2, 'Read one production batch with truthful aggregate, per-item progress and visible actions',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['batch'],
      properties: {
        batch: productionBatchSchemaV2,
      },
    }),
  ),
  defineSchema('production-batch-page', 1, 'Filtered cursor page of production batches',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['batches'],
      properties: {
        batches: {
          type: 'array',
          maxItems: 100,
          items: productionBatchSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('production-batch-page', 2, 'Filtered cursor page of production batches with aggregate and per-item visible state',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['batches'],
      properties: {
        batches: {
          type: 'array',
          maxItems: 100,
          items: productionBatchSchemaV2,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('production-batch-action-request', 1, 'Cancel or resume unfinished production batch items', {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'expectedBatchRevision'],
    properties: {
      action: { enum: ['cancel', 'resume'] },
      expectedBatchRevision: {
        type: 'integer',
        minimum: 1,
        maximum: 1000000,
      },
    },
  }),
  defineSchema('production-batch-item-action-request', 1, 'Advance, fail, cancel, resume, or retry one production batch item step', {
    type: 'object',
    additionalProperties: false,
    required: [
      'action',
      'expectedBatchRevision',
      'expectedItemRevision',
    ],
    properties: {
      action: {
        enum: [
          'start-step',
          'complete-step',
          'fail-step',
          'cancel',
          'resume',
          'retry-step',
        ],
      },
      step: productionBatchStepNameSchema,
      expectedBatchRevision: {
        type: 'integer',
        minimum: 1,
        maximum: 1000000,
      },
      expectedItemRevision: {
        type: 'integer',
        minimum: 1,
        maximum: 1000000,
      },
      costMinorUnits: {
        type: 'integer',
        minimum: 0,
        maximum: 100000000,
      },
      cacheHit: { type: 'boolean' },
      error: productionBatchErrorSchema,
      artifactIds: {
        type: 'array',
        minItems: 1,
        maxItems: 1000,
        uniqueItems: true,
        items: idSchema,
      },
    },
  }),
  defineSchema('create-batch-partial-retry-request', 1, 'Requeue only explicit failed item steps from one exact production batch revision', {
    type: 'object',
    additionalProperties: false,
    required: ['expectedBatchRevision', 'targets'],
    properties: {
      expectedBatchRevision: {
        type: 'integer',
        minimum: 1,
        maximum: 1000000,
      },
      targets: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'itemId',
            'step',
            'expectedItemRevision',
            'expectedStepHash',
          ],
          properties: {
            itemId: idSchema,
            step: productionBatchStepNameSchema,
            expectedItemRevision: {
              type: 'integer',
              minimum: 1,
              maximum: 1000000,
            },
            expectedStepHash: sha256Schema,
          },
        },
      },
    },
  }),
  defineSchema('batch-partial-retry-mutated', 1, 'Persisted mixed partial retry with resulting batch, stable lineage and idempotency evidence',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['batch', 'partialRetry', 'replayed'],
      properties: {
        batch: productionBatchSchema,
        partialRetry: batchPartialRetrySchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('batch-partial-retry-mutated', 2, 'Persisted mixed partial retry with resulting visible batch state, stable lineage and idempotency evidence',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['batch', 'partialRetry', 'replayed'],
      properties: {
        batch: productionBatchSchemaV2,
        partialRetry: batchPartialRetrySchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('batch-partial-retry-read', 1, 'Read one immutable production batch partial retry and its durable jobs',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['partialRetry'],
      properties: {
        partialRetry: batchPartialRetrySchema,
      },
    }),
  ),
  defineSchema('batch-partial-retry-page', 1, 'Cursor page of immutable production batch partial retries',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['partialRetries'],
      properties: {
        partialRetries: {
          type: 'array',
          maxItems: 100,
          items: batchPartialRetrySchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-script-alignment-request', 1, 'Import one labeled script and align it to exact approved batch transcripts', {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'locale', 'rawText', 'sources'],
    properties: {
      title: { type: 'string', minLength: 2, maxLength: 200 },
      locale: { type: 'string', minLength: 2, maxLength: 35 },
      rawText: { type: 'string', minLength: 3, maxLength: 500000 },
      sources: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['transcriptId', 'expectedTranscriptHash'],
          properties: {
            transcriptId: idSchema,
            expectedTranscriptHash: sha256Schema,
            roleHint: scriptBlockRoleSchema,
          },
        },
      },
    },
  }),
  defineSchema('script-alignment-review-request', 1, 'Resolve uncertain script blocks and extra takes against one exact alignment revision', {
    type: 'object',
    additionalProperties: false,
    required: ['expectedRevision', 'decisions'],
    properties: {
      expectedRevision: {
        type: 'integer',
        minimum: 1,
        maximum: 1000000,
      },
      decisions: {
        type: 'array',
        minItems: 1,
        maxItems: 500,
        items: scriptAlignmentDecisionSchema,
      },
    },
  }),
  defineSchema('script-alignment-mutated', 1, 'Created or reviewed script alignment with idempotency evidence',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['alignment', 'replayed'],
      properties: {
        alignment: scriptAlignmentRunSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('script-alignment-read', 1, 'Read one exact script alignment run',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['alignment'],
      properties: {
        alignment: scriptAlignmentRunSchema,
      },
    }),
  ),
  defineSchema('script-alignment-page', 1, 'Cursor page of script alignment runs for one production batch',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['alignments'],
      properties: {
        alignments: {
          type: 'array',
          maxItems: 100,
          items: scriptAlignmentRunSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-take-library-request', 1, 'Build one source-preserving take library from an exact script alignment and optional measured quality evidence', {
    type: 'object',
    additionalProperties: false,
    required: [
      'alignmentId',
      'expectedAlignmentRunHash',
      'evaluations',
    ],
    properties: {
      alignmentId: idSchema,
      expectedAlignmentRunHash: sha256Schema,
      evaluations: {
        type: 'array',
        maxItems: 2000,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'sourceKind',
            'sourceId',
            'expectedSourceHash',
            'dimensions',
          ],
          properties: {
            sourceKind: {
              enum: ['alignment-candidate', 'extra-take'],
            },
            sourceId: idSchema,
            expectedSourceHash: sha256Schema,
            dimensions: {
              type: 'array',
              maxItems: 5,
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'dimension',
                  'score',
                  'evaluatorVersion',
                  'evidenceRefs',
                ],
                properties: {
                  dimension: takeDimensionSchema,
                  score: { type: 'number', minimum: 0, maximum: 1 },
                  evaluatorVersion: idSchema,
                  evidenceRefs: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 50,
                    uniqueItems: true,
                    items: idSchema,
                  },
                  reasonCodes: {
                    type: 'array',
                    maxItems: 50,
                    uniqueItems: true,
                    items: {
                      type: 'string',
                      pattern: '^[A-Z][A-Z0-9_]{2,79}$',
                    },
                  },
                },
              },
            },
            inferredIntention: {
              type: 'object',
              additionalProperties: false,
              required: [
                'role',
                'label',
                'confidence',
                'evidenceRefs',
              ],
              properties: {
                role: takeIntentionRoleSchema,
                label: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 240,
                },
                confidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                },
                evidenceRefs: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 50,
                  uniqueItems: true,
                  items: idSchema,
                },
              },
            },
          },
        },
      },
    },
  }),
  defineSchema('take-library-selection-request', 1, 'Select and optionally protect one eligible take against an exact take-library revision', {
    type: 'object',
    additionalProperties: false,
    required: [
      'expectedRevision',
      'groupId',
      'takeId',
      'protect',
    ],
    properties: {
      expectedRevision: {
        type: 'integer',
        minimum: 1,
        maximum: 1000000,
      },
      groupId: idSchema,
      takeId: idSchema,
      protect: { type: 'boolean' },
      replacedProtectedTakeId: idSchema,
      note: { type: 'string', minLength: 1, maxLength: 500 },
    },
  }),
  defineSchema('take-library-mutated', 1, 'Created or manually selected take library with idempotency evidence',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['library', 'replayed'],
      properties: {
        library: takeLibraryRunSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('take-library-read', 1, 'Read one exact source-preserving take library run',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['library'],
      properties: {
        library: takeLibraryRunSchema,
      },
    }),
  ),
  defineSchema('take-library-page', 1, 'Cursor page of take-library runs for one production batch',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['libraries'],
      properties: {
        libraries: {
          type: 'array',
          maxItems: 100,
          items: takeLibraryRunSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-compatibility-graph-request', 1, 'Build an immutable compatibility graph from one exact take library and source-bound semantic contexts', {
    type: 'object',
    additionalProperties: false,
    required: [
      'takeLibraryId',
      'expectedTakeLibraryRunHash',
      'contexts',
    ],
    properties: {
      takeLibraryId: idSchema,
      expectedTakeLibraryRunHash: sha256Schema,
      contexts: {
        type: 'array',
        minItems: 2,
        maxItems: 2000,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'takeId',
            'expectedTakeHash',
            'offerId',
            'audienceTags',
            'claims',
            'personaId',
            'locale',
            'continuityProvides',
            'continuityRequires',
            'narrativeTags',
            'tone',
            'energy',
            'visual',
            'experiment',
            'evidenceRefs',
          ],
          properties: {
            takeId: idSchema,
            expectedTakeHash: sha256Schema,
            ...compatibilityContextProperties,
          },
        },
      },
      acceptThreshold: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        default: 70,
      },
      reviewThreshold: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        default: 60,
      },
    },
  }),
  defineSchema('compatibility-graph-mutated', 1, 'Created immutable compatibility graph with idempotency evidence',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['graph', 'replayed'],
      properties: {
        graph: compatibilityGraphRunSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('compatibility-graph-read', 1, 'Read one exact compatibility graph run',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['graph'],
      properties: {
        graph: compatibilityGraphRunSchema,
      },
    }),
  ),
  defineSchema('compatibility-graph-page', 1, 'Cursor page of compatibility graph runs for one production batch',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['graphs'],
      properties: {
        graphs: {
          type: 'array',
          maxItems: 100,
          items: compatibilityGraphRunSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-variant-recipe-request', 1, 'Compile one immutable variant recipe from an exact compatibility graph and accepted H+B+optional proof+CTA path', {
    type: 'object',
    additionalProperties: false,
    required: [
      'compatibilityGraphId',
      'expectedCompatibilityGraphRunHash',
      'selection',
      'orderedNodeIds',
    ],
    properties: {
      compatibilityGraphId: idSchema,
      expectedCompatibilityGraphRunHash: sha256Schema,
      selection: {
        type: 'object',
        additionalProperties: false,
        required: ['hookNodeId', 'bodyNodeId', 'ctaNodeId'],
        properties: {
          hookNodeId: idSchema,
          bodyNodeId: idSchema,
          proofNodeId: idSchema,
          ctaNodeId: idSchema,
        },
      },
      orderedNodeIds: {
        type: 'array',
        minItems: 3,
        maxItems: 4,
        uniqueItems: true,
        items: idSchema,
      },
      assumptions: {
        type: 'array',
        maxItems: 25,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'statement', 'evidenceRefs'],
          properties: {
            code: {
              type: 'string',
              pattern: '^[A-Z][A-Z0-9_]{2,79}$',
            },
            statement: {
              type: 'string',
              minLength: 3,
              maxLength: 500,
            },
            evidenceRefs: {
              type: 'array',
              minItems: 1,
              maxItems: 25,
              uniqueItems: true,
              items: {
                type: 'string',
                minLength: 3,
                maxLength: 256,
              },
            },
          },
        },
      },
      requireProof: { type: 'boolean', default: false },
      coldOpen: {
        type: 'object',
        additionalProperties: false,
        required: ['nodeId', 'sourceRangeMs', 'returnAtRole'],
        properties: {
          nodeId: idSchema,
          sourceRangeMs: variantRecipeRangeMsSchema,
          returnAtRole: { const: 'hook' },
        },
      },
    },
  }),
  defineSchema('variant-recipe-mutated', 1, 'Created immutable variant recipe with idempotency evidence',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['recipe', 'replayed'],
      properties: {
        recipe: variantRecipeRunSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('variant-recipe-read', 1, 'Read one exact variant recipe run',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['recipe'],
      properties: {
        recipe: variantRecipeRunSchema,
      },
    }),
  ),
  defineSchema('variant-recipe-page', 1, 'Cursor page of immutable variant recipe runs for one production batch',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['recipes'],
      properties: {
        recipes: {
          type: 'array',
          maxItems: 100,
          items: variantRecipeRunSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-variant-portfolio-preflight-request', 1, 'Count, filter, rank and bound the variant space before any paid job is created', {
    type: 'object',
    additionalProperties: false,
    required: [
      'compatibilityGraphId',
      'expectedCompatibilityGraphRunHash',
      'requestedRecipeCount',
    ],
    properties: {
      compatibilityGraphId: idSchema,
      expectedCompatibilityGraphRunHash: sha256Schema,
      requestedRecipeCount: {
        type: 'integer',
        minimum: 1,
        maximum: 1000,
      },
      requireProof: { type: 'boolean', default: false },
      confirmationToken: {
        type: 'string',
        minLength: 32,
        maxLength: 4096,
        pattern: '^[!-~]+$',
      },
    },
  }),
  defineSchema('variant-portfolio-preflight-mutated', 1, 'Persisted bounded portfolio preflight with optional signed expansion confirmation',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['preflight', 'replayed'],
      properties: {
        preflight: variantPortfolioPreflightRunSchema,
        replayed: { type: 'boolean' },
        confirmationToken: {
          type: 'string',
          minLength: 32,
          maxLength: 4096,
        },
      },
    }),
  ),
  defineSchema('variant-portfolio-preflight-mutated', 2, 'Persisted bounded portfolio preflight with canonical result and optional signed expansion confirmation',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['preflight', 'result', 'replayed'],
      properties: {
        preflight: variantPortfolioPreflightRunSchema,
        result: preflightResultSchema,
        replayed: { type: 'boolean' },
        confirmationToken: {
          type: 'string',
          minLength: 32,
          maxLength: 4096,
        },
      },
    }),
  ),
  defineSchema('variant-portfolio-preflight-read', 1, 'Read one exact bounded portfolio preflight',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['preflight'],
      properties: {
        preflight: variantPortfolioPreflightRunSchema,
      },
    }),
  ),
  defineSchema('variant-portfolio-preflight-page', 1, 'Cursor page of bounded portfolio preflights for one production batch',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['preflights'],
      properties: {
        preflights: {
          type: 'array',
          maxItems: 100,
          items: variantPortfolioPreflightRunSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('create-batch-edit-preflight-request', 1, 'Explicit recipe, format and item scope for a bounded batch edit impact preview', {
    type: 'object',
    additionalProperties: false,
    required: [
      'expectedBatchRevision',
      'expectedBatchDefinitionHash',
      'recipeIds',
      'outputSpecIds',
      'itemIds',
      'operation',
    ],
    properties: {
      expectedBatchRevision: {
        type: 'integer', minimum: 1, maximum: 1000000,
      },
      expectedBatchDefinitionHash: sha256Schema,
      recipeIds: {
        type: 'array', minItems: 1, maxItems: 1000,
        uniqueItems: true, items: idSchema,
      },
      outputSpecIds: {
        type: 'array', minItems: 1, maxItems: 1000,
        uniqueItems: true, items: idSchema,
      },
      itemIds: {
        type: 'array', minItems: 1, maxItems: 1000,
        uniqueItems: true, items: idSchema,
      },
      operation: batchEditOperationSchema,
      mode: { enum: ['all-or-nothing', 'skip-failures'] },
    },
  }),
  defineSchema('batch-edit-preflight-mutated', 1, 'Persisted impact preview, sampled diff, protected conflicts, invalidations, cost and signed commit token',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['preflight', 'replayed'],
      properties: {
        preflight: batchEditPreflightSchema,
        replayed: { type: 'boolean' },
        commitToken: {
          type: 'string',
          minLength: 32,
          maxLength: 4096,
          pattern: '^[!-~]+$',
        },
      },
    }),
  ),
  defineSchema('batch-edit-preflight-mutated', 2, 'Persisted impact preview with canonical result and signed commit token',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['preflight', 'result', 'replayed'],
      properties: {
        preflight: batchEditPreflightSchema,
        result: preflightResultSchema,
        replayed: { type: 'boolean' },
        commitToken: {
          type: 'string',
          minLength: 32,
          maxLength: 4096,
          pattern: '^[!-~]+$',
        },
      },
    }),
  ),
  defineSchema('batch-edit-preflight-read', 1, 'Read one immutable batch edit impact preview',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['preflight'],
      properties: { preflight: batchEditPreflightSchema },
    }),
  ),
  defineSchema('batch-edit-preflight-page', 1, 'Cursor page of immutable batch edit impact previews',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['preflights'],
      properties: {
        preflights: {
          type: 'array',
          maxItems: 100,
          items: batchEditPreflightSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('commit-batch-edit-request', 1, 'Commit one exact signed batch edit preflight without hidden targets', {
    type: 'object',
    additionalProperties: false,
    required: [
      'expectedPreflightHash',
      'expectedScopeHash',
      'commitToken',
    ],
    properties: {
      expectedPreflightHash: sha256Schema,
      expectedScopeHash: sha256Schema,
      commitToken: {
        type: 'string',
        minLength: 32,
        maxLength: 4096,
        pattern: '^[!-~]+$',
      },
    },
  }),
  defineSchema('batch-edit-command-mutated', 1, 'Atomic or skip-failures batch edit command with one durable result per explicit item',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['command', 'replayed'],
      properties: {
        command: batchEditCommandSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('batch-edit-command-read', 1, 'Read one immutable batch edit command and its item results',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: { command: batchEditCommandSchema },
    }),
  ),
  defineSchema('batch-edit-command-page', 1, 'Cursor page of immutable batch edit commands',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['commands'],
      properties: {
        commands: {
          type: 'array',
          maxItems: 100,
          items: batchEditCommandSchema,
        },
        nextCursor: idSchema,
      },
    }),
  ),
  defineSchema('apply-project-edit-command-request', 1, 'Typed project edit command request', {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'baseVersionId', 'baseHash', 'sourceTranscriptId', 'rules'],
    properties: {
      type: { const: 'remove-spoken-content' },
      baseVersionId: idSchema,
      baseHash: sha256Schema,
      sourceTranscriptId: idSchema,
      rules: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'label', 'alternatives'],
          properties: {
            id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' },
            label: { type: 'string', minLength: 1, maxLength: 160 },
            alternatives: {
              type: 'array', minItems: 1, maxItems: 8, uniqueItems: true,
              items: { type: 'string', minLength: 1, maxLength: 240 },
            },
          },
        },
      },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  }),
  defineSchema('apply-project-edit-command-request', 2, 'Typed project edit command request with justified exclusion ranges', {
    type: 'object', additionalProperties: false,
    required: ['type', 'baseVersionId', 'baseHash', 'sourceTranscriptId', 'rules'],
    properties: {
      type: { const: 'remove-spoken-content' }, baseVersionId: idSchema, baseHash: sha256Schema, sourceTranscriptId: idSchema,
      rules: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'label', 'alternatives'],
          properties: {
            id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' }, label: { type: 'string', minLength: 1, maxLength: 160 },
            alternatives: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 240 } },
          },
        },
      },
      exclusionOverrides: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object', additionalProperties: false, required: ['sourceStartSeconds', 'sourceEndSeconds', 'ruleIds', 'reason'],
          properties: {
            sourceStartSeconds: { type: 'number', minimum: 0 }, sourceEndSeconds: { type: 'number', exclusiveMinimum: 0 },
            ruleIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' } },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  }),
  defineSchema('apply-project-edit-command-request', 3, 'Typed project edit command or complete DirectorRun request', {
    type: 'object', additionalProperties: false,
    required: ['type', 'baseVersionId', 'baseHash'],
    properties: {
      type: { enum: ['remove-spoken-content', 'run-director'] },
      baseVersionId: idSchema,
      baseHash: sha256Schema,
      sourceTranscriptId: idSchema,
      rules: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'label', 'alternatives'],
          properties: {
            id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' }, label: { type: 'string', minLength: 1, maxLength: 160 },
            alternatives: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 240 } },
          },
        },
      },
      exclusionOverrides: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object', additionalProperties: false, required: ['sourceStartSeconds', 'sourceEndSeconds', 'ruleIds', 'reason'],
          properties: {
            sourceStartSeconds: { type: 'number', minimum: 0 }, sourceEndSeconds: { type: 'number', exclusiveMinimum: 0 },
            ruleIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' } },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    oneOf: [
      {
        required: ['sourceTranscriptId', 'rules'],
        properties: {
          type: { const: 'remove-spoken-content' },
          sourceTranscriptId: {},
          rules: {},
        },
      },
      {
        properties: {
          type: { const: 'run-director' },
          sourceTranscriptId: false,
          rules: false,
          exclusionOverrides: false,
        },
      },
    ],
  }),
  defineSchema('apply-project-edit-command-request', 4, 'Typed project edit command, source transcript replacement or complete DirectorRun request', {
    type: 'object', additionalProperties: false,
    required: ['type', 'baseVersionId', 'baseHash'],
    properties: {
      type: { enum: ['remove-spoken-content', 'replace-source-transcript', 'run-director'] },
      baseVersionId: idSchema,
      baseHash: sha256Schema,
      sourceTranscriptId: idSchema,
      expectedTranscriptHash: sha256Schema,
      rules: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object', additionalProperties: false, required: ['id', 'label', 'alternatives'],
          properties: {
            id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' }, label: { type: 'string', minLength: 1, maxLength: 160 },
            alternatives: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 240 } },
          },
        },
      },
      exclusionOverrides: {
        type: 'array', minItems: 1, maxItems: 32,
        items: {
          type: 'object', additionalProperties: false, required: ['sourceStartSeconds', 'sourceEndSeconds', 'ruleIds', 'reason'],
          properties: {
            sourceStartSeconds: { type: 'number', minimum: 0 }, sourceEndSeconds: { type: 'number', exclusiveMinimum: 0 },
            ruleIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' } },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
    oneOf: [
      {
        required: ['sourceTranscriptId', 'rules'],
        properties: {
          type: { const: 'remove-spoken-content' }, sourceTranscriptId: {}, rules: {},
          expectedTranscriptHash: false,
        },
      },
      {
        required: ['sourceTranscriptId', 'expectedTranscriptHash'],
        properties: {
          type: { const: 'replace-source-transcript' }, sourceTranscriptId: {}, expectedTranscriptHash: {},
          rules: false, exclusionOverrides: false,
        },
      },
      {
        properties: {
          type: { const: 'run-director' }, sourceTranscriptId: false,
          expectedTranscriptHash: false, rules: false, exclusionOverrides: false,
        },
      },
    ],
  }),
  defineSchema('project-edit-command-applied', 1, 'Applied project edit command response',
    successSchema({
      type: 'object', additionalProperties: false,
      required: ['command', 'version', 'editorial', 'replayed'],
      properties: {
        command: {
          type: 'object', additionalProperties: false,
          required: ['id', 'type', 'baseVersionId', 'resultVersionId', 'createdAt'],
          properties: {
            id: idSchema, type: { const: 'remove-spoken-content' }, baseVersionId: idSchema,
            resultVersionId: idSchema, createdAt: dateTimeSchema,
          },
        },
        version: {
          type: 'object', additionalProperties: false,
          required: ['id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt'],
          properties: {
            id: idSchema, sequence: { type: 'integer', minimum: 2 }, parentVersionId: idSchema,
            baseHash: sha256Schema,
            snapshotRefs: {
              type: 'object', additionalProperties: false, required: ['brief', 'editPlan', 'policies'],
              properties: { brief: idSchema, editPlan: idSchema, policies: idSchema },
            },
            createdAt: dateTimeSchema,
          },
        },
        editorial: {
          type: 'object', additionalProperties: false,
          required: [
            'sourceTranscriptId', 'sourceArtifactId', 'exclusions', 'retainedSourceRanges',
            'outputDurationFrames', 'fps', 'automaticZoom', 'protectedOpeningFrames', 'subtitleFaceProtection',
          ],
          properties: {
            sourceTranscriptId: idSchema,
            sourceArtifactId: idSchema,
            exclusions: {
              type: 'array', minItems: 1, maxItems: 128,
              items: {
                type: 'object', additionalProperties: false,
                required: ['sourceStartSeconds', 'sourceEndSeconds', 'ruleIds', 'labels', 'matchedText'],
                properties: {
                  sourceStartSeconds: { type: 'number', minimum: 0 },
                  sourceEndSeconds: { type: 'number', exclusiveMinimum: 0 },
                  ruleIds: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string' } },
                  labels: { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string' } },
                  matchedText: { type: 'string', minLength: 1, maxLength: 2000 },
                },
              },
            },
            retainedSourceRanges: {
              type: 'array', minItems: 1, maxItems: 129,
              items: {
                type: 'object', additionalProperties: false,
                required: ['sourceStartSeconds', 'sourceEndSeconds'],
                properties: {
                  sourceStartSeconds: { type: 'number', minimum: 0 },
                  sourceEndSeconds: { type: 'number', exclusiveMinimum: 0 },
                },
              },
            },
            outputDurationFrames: { type: 'integer', minimum: 1 },
            fps: { type: 'number', exclusiveMinimum: 0 },
            automaticZoom: { const: false },
            protectedOpeningFrames: { type: 'integer', minimum: 1 },
            subtitleFaceProtection: { const: true },
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-edit-command-applied', 2, 'Applied edit command response including complete DirectorRun execution',
    successSchema({
      oneOf: [
        {
          type: 'object', required: ['command', 'version', 'editorial', 'replayed'],
          properties: {
            command: { type: 'object' }, version: { type: 'object' }, editorial: { type: 'object' }, replayed: { type: 'boolean' },
          },
        },
        {
          type: 'object', additionalProperties: false,
          required: ['command', 'version', 'directorRun', 'operation', 'replayed'],
          properties: {
            command: {
              type: 'object', additionalProperties: false,
              required: ['id', 'type', 'baseVersionId', 'resultVersionId', 'createdAt'],
              properties: { id: idSchema, type: { const: 'run-director' }, baseVersionId: idSchema, resultVersionId: idSchema, createdAt: dateTimeSchema },
            },
            version: {
              type: 'object', additionalProperties: false,
              required: ['id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt'],
              properties: {
                id: idSchema, sequence: { type: 'integer', minimum: 2 }, parentVersionId: idSchema, baseHash: sha256Schema, createdAt: dateTimeSchema,
                snapshotRefs: {
                  type: 'object', additionalProperties: false,
                  required: ['brief', 'perception', 'treatment', 'story', 'editPlan', 'quality', 'policies'],
                  properties: { brief: idSchema, perception: idSchema, treatment: idSchema, story: idSchema, editPlan: idSchema, quality: idSchema, policies: idSchema },
                },
              },
            },
            directorRun: {
              type: 'object', additionalProperties: false,
              required: [
                'id', 'status', 'plannerVersion', 'criticVersion', 'baseVersionId', 'resultVersionId',
                'perception', 'treatmentPlan', 'storyPlan', 'editPlan', 'qualityReport', 'decisions', 'assumptions', 'createdAt',
              ],
              properties: {
                id: idSchema, status: { enum: ['planned', 'rendering', 'succeeded', 'failed'] },
                plannerVersion: { type: 'string' }, criticVersion: { type: 'string' }, baseVersionId: idSchema, resultVersionId: idSchema,
                perception: { type: 'object', additionalProperties: false, required: ['snapshotId', 'summary'], properties: { snapshotId: idSchema, summary: { type: 'object' } } },
                treatmentPlan: { type: 'object', additionalProperties: false, required: ['snapshotId', 'plan'], properties: { snapshotId: idSchema, plan: { type: 'object' } } },
                storyPlan: { type: 'object', additionalProperties: false, required: ['snapshotId', 'plan'], properties: { snapshotId: idSchema, plan: { type: 'object' } } },
                editPlan: {
                  type: 'object', additionalProperties: false,
                  required: ['snapshotId', 'id', 'durationFrames', 'fps', 'subtitleCueCount', 'transitionCount', 'automaticZoom'],
                  properties: {
                    snapshotId: idSchema, id: idSchema, durationFrames: { type: 'integer', minimum: 1 }, fps: { type: 'number', exclusiveMinimum: 0 },
                    subtitleCueCount: { type: 'integer', minimum: 1 }, transitionCount: { type: 'integer', minimum: 0 }, automaticZoom: { const: false },
                  },
                },
                qualityReport: { type: 'object', additionalProperties: false, required: ['snapshotId', 'report'], properties: { snapshotId: idSchema, report: { type: 'object' } } },
                decisions: { type: 'array', minItems: 4, maxItems: 64, items: { type: 'object' } },
                assumptions: { type: 'array', maxItems: 64, items: { type: 'string' } },
                createdAt: dateTimeSchema,
              },
            },
            operation: publicOperationSchemaV3,
            replayed: { type: 'boolean' },
          },
        },
      ],
    }),
  ),
  defineSchema('source-transcript-replacement-impact', 1, 'Content-addressed invalidation impact of selecting a new immutable source transcript', sourceTranscriptReplacementImpactSchema),
  defineSchema('editorial-cut-impact', 1, 'Content-addressed full-timeline impact of removing aligned spoken content', editorialCutImpactSchema),
  defineSchema('director-run-impact', 1, 'Content-addressed full-timeline impact of a persisted Director replan', directorRunImpactSchema),
  defineSchema('project-lut-selection-impact', 1, 'Content-addressed full-timeline impact of selecting a project color recipe', projectLutSelectionImpactSchema),
  defineSchema('project-edit-command-applied', 3, 'Applied edit command response including source transcript replacement and required Director recomputation',
    successSchema({
      oneOf: [
        {
          type: 'object', required: ['command', 'version', 'editorial', 'replayed'],
          properties: { command: { type: 'object' }, version: { type: 'object' }, editorial: { type: 'object' }, replayed: { type: 'boolean' } },
        },
        {
          type: 'object', required: ['command', 'version', 'directorRun', 'operation', 'replayed'],
          properties: { command: { type: 'object' }, version: { type: 'object' }, directorRun: { type: 'object' }, operation: publicOperationSchemaV3, replayed: { type: 'boolean' } },
        },
        {
          type: 'object', additionalProperties: false,
          required: ['command', 'version', 'sourceTranscript', 'replayed'],
          properties: {
            command: {
              type: 'object', additionalProperties: false,
              required: ['id', 'type', 'baseVersionId', 'resultVersionId', 'createdAt'],
              properties: { id: idSchema, type: { const: 'replace-source-transcript' }, baseVersionId: idSchema, resultVersionId: idSchema, createdAt: dateTimeSchema },
            },
            version: {
              type: 'object', additionalProperties: false,
              required: ['id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt'],
              properties: {
                id: idSchema, sequence: { type: 'integer', minimum: 2 }, parentVersionId: idSchema,
                baseHash: sha256Schema, createdAt: dateTimeSchema,
                snapshotRefs: {
                  type: 'object', additionalProperties: false,
                  required: ['brief', 'editPlan', 'policies'],
                  properties: { brief: idSchema, treatment: idSchema, story: idSchema, editPlan: idSchema, policies: idSchema },
                },
              },
            },
            sourceTranscript: {
              type: 'object', additionalProperties: false,
              required: [
                'previousTranscriptId', 'previousTranscriptHash', 'replacementTranscriptId',
                'replacementTranscriptHash', 'impact', 'invalidations', 'nextRequiredCapability',
              ],
              properties: {
                previousTranscriptId: idSchema, previousTranscriptHash: sha256Schema,
                replacementTranscriptId: idSchema, replacementTranscriptHash: sha256Schema,
                impact: sourceTranscriptReplacementImpactSchema,
                invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
                nextRequiredCapability: { const: 'apollo.projects.commands.apply:run-director' },
              },
            },
            replayed: { type: 'boolean' },
          },
        },
      ],
    }),
  ),
  defineSchema('project-edit-command-applied', 4, 'Applied edit command response including persisted editorial impact and stale output relationships',
    successSchema({
      oneOf: [
        {
          type: 'object', additionalProperties: false,
          required: ['command', 'version', 'editorial', 'operation', 'replayed'],
          properties: {
            command: {
              type: 'object', additionalProperties: false,
              required: ['id', 'type', 'baseVersionId', 'resultVersionId', 'createdAt'],
              properties: { id: idSchema, type: { const: 'remove-spoken-content' }, baseVersionId: idSchema, resultVersionId: idSchema, createdAt: dateTimeSchema },
            },
            version: { type: 'object' },
            editorial: {
              type: 'object', additionalProperties: false,
              required: [
                'sourceTranscriptId', 'sourceArtifactId', 'exclusions', 'retainedSourceRanges',
                'outputDurationFrames', 'fps', 'automaticZoom', 'protectedOpeningFrames',
                'subtitleFaceProtection', 'impact', 'invalidations',
              ],
              properties: {
                sourceTranscriptId: idSchema, sourceArtifactId: idSchema,
                exclusions: { type: 'array', minItems: 1, maxItems: 128 },
                retainedSourceRanges: { type: 'array', minItems: 1, maxItems: 129 },
                outputDurationFrames: { type: 'integer', minimum: 1 },
                fps: { type: 'number', exclusiveMinimum: 0 }, automaticZoom: { const: false },
                protectedOpeningFrames: { type: 'integer', minimum: 1 }, subtitleFaceProtection: { const: true },
                impact: editorialCutImpactSchema,
                invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
              },
            },
            operation: publicOperationSchemaV3,
            replayed: { type: 'boolean' },
          },
        },
        {
          type: 'object', required: ['command', 'version', 'directorRun', 'operation', 'replayed'],
          properties: { command: { type: 'object' }, version: { type: 'object' }, directorRun: { type: 'object' }, operation: publicOperationSchemaV3, replayed: { type: 'boolean' } },
        },
        {
          type: 'object', required: ['command', 'version', 'sourceTranscript', 'replayed'],
          properties: { command: { type: 'object' }, version: { type: 'object' }, sourceTranscript: { type: 'object' }, replayed: { type: 'boolean' } },
        },
      ],
    }),
  ),
  defineSchema('project-edit-command-applied', 5, 'Applied edit command response including persisted Director impact and stale output relationships',
    successSchema({
      oneOf: [
        {
          type: 'object', required: ['command', 'version', 'editorial', 'operation', 'replayed'],
          properties: { command: { type: 'object' }, version: { type: 'object' }, editorial: { type: 'object' }, operation: publicOperationSchemaV3, replayed: { type: 'boolean' } },
        },
        {
          type: 'object', additionalProperties: false,
          required: ['command', 'version', 'directorRun', 'operation', 'replayed'],
          properties: {
            command: {
              type: 'object', additionalProperties: false,
              required: ['id', 'type', 'baseVersionId', 'resultVersionId', 'createdAt'],
              properties: { id: idSchema, type: { const: 'run-director' }, baseVersionId: idSchema, resultVersionId: idSchema, createdAt: dateTimeSchema },
            },
            version: {
              type: 'object', additionalProperties: false,
              required: ['id', 'sequence', 'parentVersionId', 'baseHash', 'snapshotRefs', 'createdAt'],
              properties: {
                id: idSchema, sequence: { type: 'integer', minimum: 2 }, parentVersionId: idSchema,
                baseHash: sha256Schema, createdAt: dateTimeSchema,
                snapshotRefs: {
                  type: 'object', additionalProperties: false,
                  required: ['brief', 'perception', 'treatment', 'story', 'editPlan', 'quality', 'policies'],
                  properties: { brief: idSchema, perception: idSchema, treatment: idSchema, story: idSchema, editPlan: idSchema, quality: idSchema, policies: idSchema },
                },
              },
            },
            directorRun: {
              type: 'object', additionalProperties: false,
              required: [
                'id', 'status', 'plannerVersion', 'criticVersion', 'baseVersionId', 'resultVersionId',
                'perception', 'treatmentPlan', 'storyPlan', 'editPlan', 'qualityReport', 'decisions',
                'assumptions', 'impact', 'invalidations', 'createdAt',
              ],
              properties: {
                id: idSchema, status: { enum: ['planned', 'rendering', 'succeeded', 'failed'] },
                plannerVersion: { type: 'string' }, criticVersion: { type: 'string' }, baseVersionId: idSchema, resultVersionId: idSchema,
                perception: { type: 'object', additionalProperties: false, required: ['snapshotId', 'summary'], properties: { snapshotId: idSchema, summary: { type: 'object' } } },
                treatmentPlan: { type: 'object', additionalProperties: false, required: ['snapshotId', 'plan'], properties: { snapshotId: idSchema, plan: { type: 'object' } } },
                storyPlan: { type: 'object', additionalProperties: false, required: ['snapshotId', 'plan'], properties: { snapshotId: idSchema, plan: { type: 'object' } } },
                editPlan: {
                  type: 'object', additionalProperties: false,
                  required: ['snapshotId', 'id', 'durationFrames', 'fps', 'subtitleCueCount', 'transitionCount', 'automaticZoom'],
                  properties: {
                    snapshotId: idSchema, id: idSchema, durationFrames: { type: 'integer', minimum: 1 }, fps: { type: 'number', exclusiveMinimum: 0 },
                    subtitleCueCount: { type: 'integer', minimum: 1 }, transitionCount: { type: 'integer', minimum: 0 }, automaticZoom: { const: false },
                  },
                },
                qualityReport: { type: 'object', additionalProperties: false, required: ['snapshotId', 'report'], properties: { snapshotId: idSchema, report: { type: 'object' } } },
                decisions: { type: 'array', minItems: 4, maxItems: 64, items: { type: 'object' } },
                assumptions: { type: 'array', maxItems: 64, items: { type: 'string' } },
                impact: directorRunImpactSchema,
                invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
                createdAt: dateTimeSchema,
              },
            },
            operation: publicOperationSchemaV3,
            replayed: { type: 'boolean' },
          },
        },
        {
          type: 'object', required: ['command', 'version', 'sourceTranscript', 'replayed'],
          properties: { command: { type: 'object' }, version: { type: 'object' }, sourceTranscript: { type: 'object' }, replayed: { type: 'boolean' } },
        },
      ],
    }),
  ),
  defineSchema('project-edit-command-applied', 6, 'Applied edit command response with explicit current ProjectVersion state',
    successSchema({
      oneOf: [
        {
          type: 'object', additionalProperties: false,
          required: ['command', 'version', 'editorial', 'operation', 'replayed'],
          properties: {
            command: appliedProjectCommandSchema('remove-spoken-content'),
            version: currentProjectVersionResultSchema(['brief', 'editPlan', 'policies']),
            editorial: {
              type: 'object', additionalProperties: false,
              required: [
                'sourceTranscriptId', 'sourceArtifactId', 'exclusions', 'retainedSourceRanges',
                'outputDurationFrames', 'fps', 'automaticZoom', 'protectedOpeningFrames',
                'subtitleFaceProtection', 'impact', 'invalidations',
              ],
              properties: {
                sourceTranscriptId: idSchema, sourceArtifactId: idSchema,
                exclusions: { type: 'array', minItems: 1, maxItems: 128 },
                retainedSourceRanges: { type: 'array', minItems: 1, maxItems: 129 },
                outputDurationFrames: { type: 'integer', minimum: 1 },
                fps: { type: 'number', exclusiveMinimum: 0 }, automaticZoom: { const: false },
                protectedOpeningFrames: { type: 'integer', minimum: 1 }, subtitleFaceProtection: { const: true },
                impact: editorialCutImpactSchema,
                invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
              },
            },
            operation: publicOperationSchemaV3,
            replayed: { type: 'boolean' },
          },
        },
        {
          type: 'object', additionalProperties: false,
          required: ['command', 'version', 'directorRun', 'operation', 'replayed'],
          properties: {
            command: appliedProjectCommandSchema('run-director'),
            version: currentProjectVersionResultSchema([
              'brief', 'perception', 'treatment', 'story', 'editPlan', 'quality', 'policies',
            ]),
            directorRun: {
              type: 'object', additionalProperties: false,
              required: [
                'id', 'status', 'plannerVersion', 'criticVersion', 'baseVersionId', 'resultVersionId',
                'perception', 'treatmentPlan', 'storyPlan', 'editPlan', 'qualityReport', 'decisions',
                'assumptions', 'impact', 'invalidations', 'createdAt',
              ],
              properties: {
                id: idSchema, status: { enum: ['planned', 'rendering', 'succeeded', 'failed'] },
                plannerVersion: { type: 'string' }, criticVersion: { type: 'string' },
                baseVersionId: idSchema, resultVersionId: idSchema,
                perception: { type: 'object', additionalProperties: false, required: ['snapshotId', 'summary'], properties: { snapshotId: idSchema, summary: { type: 'object' } } },
                treatmentPlan: { type: 'object', additionalProperties: false, required: ['snapshotId', 'plan'], properties: { snapshotId: idSchema, plan: { type: 'object' } } },
                storyPlan: { type: 'object', additionalProperties: false, required: ['snapshotId', 'plan'], properties: { snapshotId: idSchema, plan: { type: 'object' } } },
                editPlan: {
                  type: 'object', additionalProperties: false,
                  required: ['snapshotId', 'id', 'durationFrames', 'fps', 'subtitleCueCount', 'transitionCount', 'automaticZoom'],
                  properties: {
                    snapshotId: idSchema, id: idSchema, durationFrames: { type: 'integer', minimum: 1 },
                    fps: { type: 'number', exclusiveMinimum: 0 }, subtitleCueCount: { type: 'integer', minimum: 1 },
                    transitionCount: { type: 'integer', minimum: 0 }, automaticZoom: { const: false },
                  },
                },
                qualityReport: { type: 'object', additionalProperties: false, required: ['snapshotId', 'report'], properties: { snapshotId: idSchema, report: { type: 'object' } } },
                decisions: { type: 'array', minItems: 4, maxItems: 64, items: { type: 'object' } },
                assumptions: { type: 'array', maxItems: 64, items: { type: 'string' } },
                impact: directorRunImpactSchema,
                invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
                createdAt: dateTimeSchema,
              },
            },
            operation: publicOperationSchemaV3,
            replayed: { type: 'boolean' },
          },
        },
        {
          type: 'object', additionalProperties: false,
          required: ['command', 'version', 'sourceTranscript', 'replayed'],
          properties: {
            command: appliedProjectCommandSchema('replace-source-transcript'),
            version: currentProjectVersionResultSchema(['brief', 'treatment', 'story', 'editPlan', 'policies']),
            sourceTranscript: {
              type: 'object', additionalProperties: false,
              required: [
                'previousTranscriptId', 'previousTranscriptHash', 'replacementTranscriptId',
                'replacementTranscriptHash', 'impact', 'invalidations', 'nextRequiredCapability',
              ],
              properties: {
                previousTranscriptId: idSchema, previousTranscriptHash: sha256Schema,
                replacementTranscriptId: idSchema, replacementTranscriptHash: sha256Schema,
                impact: sourceTranscriptReplacementImpactSchema,
                invalidations: { type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema },
                nextRequiredCapability: { const: 'apollo.projects.commands.apply:run-director' },
              },
            },
            replayed: { type: 'boolean' },
          },
        },
      ],
    }),
  ),
  defineSchema('enqueue-project-director-run-request', 1, 'Enqueue one fenced Director run against an immutable project version', {
    type: 'object',
    additionalProperties: false,
    required: ['baseVersionId', 'baseHash'],
    properties: {
      baseVersionId: idSchema,
      baseHash: sha256Schema,
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  }),
  defineSchema('project-director-operation-enqueued', 1, 'Durable Director operation accepted for asynchronous execution',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['operation', 'replayed'],
      properties: {
        operation: publicOperationSchemaV9,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-manual-timeline', 1, 'Current manual editing timeline and immutable history',
    projectManualTimelineBody(manualTimelineSchemaV1),
  ),
  defineSchema('project-manual-timeline', 2, 'Current manual editing timeline with normalized clip crops and immutable history',
    projectManualTimelineBody(manualTimelineSchema),
  ),
  defineSchema('command-impact', 1, 'Content-addressed dependency impact persisted with a V2 Command', commandImpactSchema),
  defineSchema('command-artifact-invalidation', 1, 'Version-scoped stale relationship between a V2 Command and an affected historical output', commandArtifactInvalidationSchema),
  defineSchema('command-artifact-invalidation', 2, 'Visible version-scoped stale relationship that leaves historical artifact availability unchanged', commandArtifactInvalidationSchemaV2),
  defineSchema('apply-project-manual-edit-request', 1, 'Apply, undo, redo or restore a scoped manual edit', {
    ...applyProjectManualEditRequestBody(manualGestureSchemaV1),
  }),
  defineSchema('apply-project-manual-edit-request', 2, 'Apply a normalized crop or another scoped manual edit, or restore an immutable version', {
    ...applyProjectManualEditRequestBody(manualGestureSchema),
  }),
  defineSchema('project-manual-edit-applied', 1, 'Applied manual edit with immutable version and proxy operation',
    projectManualEditAppliedBody(manualTimelineSchemaV1),
  ),
  defineSchema('project-manual-edit-applied', 2, 'Applied manual edit with normalized clip crops, immutable version and proxy operation',
    projectManualEditAppliedBody(manualTimelineSchema),
  ),
  defineSchema('project-manual-edit-applied', 3, 'Applied manual edit with explicit current ProjectVersion state',
    projectManualEditAppliedBody(manualTimelineSchema, true),
  ),
  defineSchema('project-artifact-invalidations', 1, 'Version-scoped stale output relationships for one immutable project version',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'resultVersionId', 'invalidations'],
      properties: {
        projectId: idSchema,
        resultVersionId: idSchema,
        invalidations: {
          type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchema,
        },
      },
    }),
  ),
  defineSchema('project-artifact-invalidations', 2, 'Visible unresolved stale output relationships that do not mutate historical artifact availability',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'resultVersionId', 'invalidations'],
      properties: {
        projectId: idSchema,
        resultVersionId: idSchema,
        invalidations: {
          type: 'array', maxItems: 1000, items: commandArtifactInvalidationSchemaV2,
        },
      },
    }),
  ),
  defineSchema('project-version-comparison', 1, 'Semantic and visual comparison of two immutable project versions',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['current', 'versions', 'comparison'],
      properties: {
        current: {
          type: 'object', additionalProperties: false,
          required: ['versionId', 'baseHash', 'revision'],
          properties: {
            versionId: idSchema, baseHash: sha256Schema,
            revision: { type: 'integer', minimum: 1 },
          },
        },
        versions: {
          type: 'object', additionalProperties: false,
          required: ['before', 'after'],
          properties: {
            before: {
              type: 'object', additionalProperties: false,
              required: ['id', 'sequence', 'editPlanHash'],
              properties: {
                id: idSchema, sequence: { type: 'integer', minimum: 1 },
                editPlanHash: sha256Schema,
              },
            },
            after: {
              type: 'object', additionalProperties: false,
              required: ['id', 'sequence', 'editPlanHash'],
              properties: {
                id: idSchema, sequence: { type: 'integer', minimum: 1 },
                editPlanHash: sha256Schema,
              },
            },
          },
        },
        comparison: versionComparisonSchema,
      },
    }),
  ),
  defineSchema('project-version-comparison-action-request', 1, 'Accept, reopen or restore a version comparison', {
    type: 'object',
    additionalProperties: false,
    required: [
      'action', 'beforeVersionId', 'afterVersionId', 'mode', 'baseVersionId',
      'baseHash', 'expectedRevision', 'variantId',
    ],
    properties: {
      action: { enum: ['accept', 'reopen', 'restore'] },
      beforeVersionId: idSchema,
      afterVersionId: idSchema,
      mode: { enum: ['toggle', 'split', 'overlay'] },
      baseVersionId: idSchema,
      baseHash: sha256Schema,
      expectedRevision: { type: 'integer', minimum: 1 },
      variantId: idSchema,
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  }),
  defineSchema('project-version-comparison-action-result', 1, 'Audited version comparison action result',
    projectVersionComparisonActionResultBody(manualTimelineSchemaV1),
  ),
  defineSchema('project-version-comparison-action-result', 2, 'Audited version comparison action result with normalized clip crops',
    projectVersionComparisonActionResultBody(manualTimelineSchema),
  ),
  defineSchema('project-version-comparison-action-result', 3, 'Audited version comparison action result with the explicit zero impact of the accept or reopen decision',
    projectVersionComparisonActionResultBody(manualTimelineSchema, compareActionImpactSchema),
  ),
  defineSchema('project-version-comparison-action-result', 4, 'Audited comparison action with explicit current state on a restored ProjectVersion',
    projectVersionComparisonActionResultBody(manualTimelineSchema, compareActionImpactSchema, true),
  ),
  defineSchema('project-proxy-review-response', 1, 'Version-bound post-render proxy review',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['review'],
      properties: { review: proxyReviewSchema },
    }),
  ),
  defineSchema('project-proxy-review-warning-acknowledgement-request', 1, 'Acknowledge non-hard proxy warnings against an exact review revision', {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'proxyReviewId', 'projectVersionId', 'baseRevision', 'expectedRevision'],
    properties: {
      action: { const: 'acknowledge-warnings' },
      proxyReviewId: idSchema,
      projectVersionId: idSchema,
      baseRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      expectedRevision: { type: 'integer', minimum: 1 },
    },
  }),
  defineSchema('project-proxy-review-warning-acknowledgement-result', 1, 'Auditable proxy warning acknowledgement result',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['review', 'decision', 'replayed'],
      properties: {
        review: proxyReviewSchema,
        decision: {
          type: 'object',
          additionalProperties: false,
          required: [
            'id', 'proxyReviewId', 'action', 'actor', 'baseReviewHash',
            'resultReviewHash', 'createdAt',
          ],
          properties: {
            id: idSchema,
            proxyReviewId: idSchema,
            action: { const: 'acknowledge-warnings' },
            actor: {
              type: 'object',
              additionalProperties: false,
              required: ['type', 'id'],
              properties: { type: { const: 'api-client' }, id: idSchema },
            },
            baseReviewHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            resultReviewHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            createdAt: dateTimeSchema,
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-asset-selection-request', 1, 'Select one visual asset against an exact immutable project version', {
    type: 'object',
    additionalProperties: false,
    required: ['projectVersionId', 'projectVersionHash', 'brief', 'candidates'],
    properties: {
      projectVersionId: idSchema,
      projectVersionHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      brief: assetBriefSchema,
      candidates: { type: 'array', maxItems: 100, items: assetCandidateInputSchema },
    },
  }),
  defineSchema('project-asset-selection-created', 1, 'Immutable asset selection audit result',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['selection', 'replayed'],
      properties: {
        selection: assetSelectionSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-asset-selection-list', 1, 'Immutable asset selection audit history',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['selections'],
      properties: {
        selections: { type: 'array', maxItems: 100, items: assetSelectionSchema },
      },
    }),
  ),
  defineSchema('project-quality-iteration-request', 1, 'Run one deterministic closed-loop quality iteration against exact server evidence', {
    type: 'object',
    additionalProperties: false,
    required: [
      'projectVersionId', 'projectVersionHash', 'proxyReviewId',
      'proxyReviewHash', 'expectedProxyReviewRevision', 'assetPlacements',
      'rubricEvidence', 'rangeMetrics', 'datasetId', 'datasetVersion',
      'budgetLimitUnits',
    ],
    properties: {
      projectVersionId: idSchema,
      projectVersionHash: sha256Schema,
      proxyReviewId: idSchema,
      proxyReviewHash: sha256Schema,
      expectedProxyReviewRevision: { type: 'integer', minimum: 1 },
      assetPlacements: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['selectionId', 'startMs', 'endMs'],
          properties: {
            selectionId: idSchema,
            startMs: { type: 'integer', minimum: 0 },
            endMs: { type: 'integer', minimum: 1 },
          },
        },
      },
      rubricEvidence: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: qualityRubricEvidenceSchema,
      },
      rangeMetrics: {
        type: 'array',
        maxItems: 200,
        items: qualityRangeMetricSchema,
      },
      datasetId: idSchema,
      datasetVersion: { type: 'integer', minimum: 1 },
      budgetLimitUnits: { type: 'integer', minimum: 1, maximum: 1000 },
    },
  }),
  defineSchema('project-quality-iteration-created', 1, 'Immutable closed-loop quality report and patch decision',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['iteration', 'replayed'],
      properties: {
        iteration: qualityIterationSchema,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('project-quality-iteration-list', 1, 'Immutable closed-loop quality iteration history',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['iterations'],
      properties: {
        iterations: {
          type: 'array',
          maxItems: 100,
          items: qualityIterationSchema,
        },
      },
    }),
  ),
  defineSchema('project-proxy-render-operation-accepted', 1, 'Accepted project proxy render operation',
    successSchema({
      type: 'object', additionalProperties: false, required: ['operation', 'replayed'],
      properties: { operation: publicOperationSchemaV3, replayed: { type: 'boolean' } },
    }),
  ),
  defineSchema('workspace-lut-import-request', 1, 'Import and validate one immutable workspace .cube LUT', {
    type: 'object', additionalProperties: false,
    required: ['lutId', 'name', 'owner', 'license', 'compatibility', 'cubeContent'],
    properties: {
      lutId: idSchema, name: { type: 'string', minLength: 1, maxLength: 160 }, owner: { type: 'string', minLength: 1, maxLength: 240 },
      license: { type: 'object', additionalProperties: false, required: ['policy', 'name'], properties: { policy: { enum: ['owned', 'licensed', 'restricted'] }, name: { type: 'string', minLength: 1, maxLength: 240 }, usageNotes: { type: 'string', minLength: 1, maxLength: 2000 } } },
      tags: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 48 } },
      compatibility: { type: 'object', additionalProperties: false, required: ['inputColorSpace', 'outputColorSpace'], properties: { inputColorSpace: { enum: ['rec709', 'display-p3', 'rec2020'] }, outputColorSpace: { enum: ['rec709', 'display-p3', 'rec2020'] } } },
      intensity: { type: 'number', minimum: 0, maximum: 1, default: 1 },
      cubeContent: { type: 'string', minLength: 1, maxLength: 8388608 },
    },
  }),
  defineSchema('workspace-lut-imported', 1, 'Imported immutable workspace LUT', successSchema({ type: 'object', additionalProperties: false, required: ['lut', 'replayed'], properties: { lut: workspaceLutSchema, replayed: { type: 'boolean' } } })),
  defineSchema('workspace-lut-response', 1, 'Current immutable workspace LUT', successSchema({ type: 'object', additionalProperties: false, required: ['lut'], properties: { lut: workspaceLutSchema } })),
  defineSchema('workspace-lut-list', 1, 'Current workspace LUT library', successSchema({ type: 'object', additionalProperties: false, required: ['items'], properties: { items: { type: 'array', maxItems: 100, items: workspaceLutSchema } } })),
  defineSchema('workspace-lut-version-create-request', 1, 'Create the next immutable version of a workspace LUT', {
    type: 'object', additionalProperties: false,
    required: ['baseVersion', 'name', 'owner', 'license', 'compatibility', 'cubeContent'],
    properties: {
      baseVersion: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1, maxLength: 160 }, owner: { type: 'string', minLength: 1, maxLength: 240 },
      license: { type: 'object', additionalProperties: false, required: ['policy', 'name'], properties: { policy: { enum: ['owned', 'licensed', 'restricted'] }, name: { type: 'string', minLength: 1, maxLength: 240 }, usageNotes: { type: 'string', minLength: 1, maxLength: 2000 } } },
      tags: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 48 } },
      compatibility: { type: 'object', additionalProperties: false, required: ['inputColorSpace', 'outputColorSpace'], properties: { inputColorSpace: { enum: ['rec709', 'display-p3', 'rec2020'] }, outputColorSpace: { enum: ['rec709', 'display-p3', 'rec2020'] } } },
      intensity: { type: 'number', minimum: 0, maximum: 1, default: 1 }, cubeContent: { type: 'string', minLength: 1, maxLength: 8388608 },
    },
  }),
  defineSchema('workspace-lut-version-response', 1, 'One immutable historical workspace LUT version', successSchema({ type: 'object', additionalProperties: false, required: ['version'], properties: { version: workspaceLutVersionSchema } })),
  defineSchema('workspace-lut-lifecycle-response', 1, 'Current revisioned workspace LUT lifecycle', successSchema({ type: 'object', additionalProperties: false, required: ['lifecycle'], properties: { lifecycle: workspaceLutLifecycleSchema } })),
  defineSchema('workspace-lut-status-request', 1, 'Revision-guarded workspace LUT activation or deactivation', {
    type: 'object', additionalProperties: false, required: ['baseRevision', 'status'],
    properties: { baseRevision: { type: 'integer', minimum: 1 }, status: { enum: ['active', 'inactive'] } },
  }),
  defineSchema('workspace-lut-status-applied', 1, 'Applied immutable workspace LUT lifecycle command', successSchema({
    type: 'object', additionalProperties: false, required: ['lifecycle', 'command', 'replayed'],
    properties: { lifecycle: workspaceLutLifecycleSchema, command: workspaceLutStatusCommandSchema, replayed: { type: 'boolean' } },
  })),
  defineSchema('workspace-lut-default-set-request', 1, 'Set an explicit revisioned workspace LUT default', {
    type: 'object', additionalProperties: false, required: ['baseRevision', 'selection'],
    properties: {
      baseRevision: { type: 'integer', minimum: 0 },
      selection: {
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'none' } } },
          { type: 'object', additionalProperties: false, required: ['mode', 'lutId', 'version'], properties: { mode: { const: 'lut-version' }, lutId: idSchema, version: { type: 'integer', minimum: 1 } } },
        ],
      },
    },
  }),
  defineSchema('workspace-lut-default-response', 1, 'Current versioned workspace LUT default', successSchema({
    type: 'object', additionalProperties: false, required: ['default'], properties: {
      default: { type: 'object', additionalProperties: false, required: ['workspaceId', 'revision', 'current'], properties: { workspaceId: idSchema, revision: { type: 'integer', minimum: 0 }, current: { anyOf: [{ type: 'null' }, workspaceLutDefaultVersionSchema] } } },
    },
  })),
  defineSchema('workspace-lut-default-set', 1, 'Applied immutable workspace LUT default version', successSchema({
    type: 'object', additionalProperties: false, required: ['defaultVersion', 'replayed'], properties: { defaultVersion: workspaceLutDefaultVersionSchema, replayed: { type: 'boolean' } },
  })),
  defineSchema('project-lut-selection-set-request', 1, 'Apply an explicit project LUT selection through EditCommand and ProjectVersion', {
    type: 'object', additionalProperties: false, required: ['baseVersionId', 'baseHash', 'selection'],
    properties: {
      baseVersionId: idSchema, baseHash: sha256Schema,
      selection: { oneOf: [
        { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'workspace-default' } } },
        { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'none' } } },
        { type: 'object', additionalProperties: false, required: ['mode', 'lutId', 'version'], properties: { mode: { const: 'lut-version' }, lutId: idSchema, version: { type: 'integer', minimum: 1 } } },
      ] },
      intensity: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string', minLength: 1, maxLength: 1000 },
    },
  }),
  defineSchema('project-lut-selection-applied', 1, 'Applied project LUT EditCommand and immutable result version', successSchema(projectLutSelectionResultSchema)),
  defineSchema('project-lut-selection-response', 1, 'Current explicit project LUT selection', successSchema({ type: 'object', additionalProperties: false, required: ['result'], properties: { result: { anyOf: [{ type: 'null' }, projectLutSelectionResultSchema] } } })),
  defineSchema('project-lut-selection-applied', 2, 'Applied project LUT selection with persisted impact, stale outputs and a proxy operation when the timeline is renderable', successSchema({
    ...projectLutSelectionResultSchemaV2,
    properties: { ...projectLutSelectionResultSchemaV2.properties, operation: publicOperationSchemaV3 },
  })),
  defineSchema('project-lut-selection-response', 2, 'Current explicit project LUT selection with persisted impact and stale outputs', successSchema({
    type: 'object', additionalProperties: false, required: ['result'], properties: { result: { anyOf: [{ type: 'null' }, projectLutSelectionResultSchemaV2] } },
  })),
  defineSchema('project-lut-selection-applied', 3, 'Applied project LUT selection with explicit current ProjectVersion state', successSchema({
    ...projectLutSelectionResultSchemaV3,
    properties: { ...projectLutSelectionResultSchemaV3.properties, operation: publicOperationSchemaV3 },
  })),
  defineSchema('project-lut-selection-response', 3, 'Current project LUT selection with explicit current ProjectVersion state', successSchema({
    type: 'object', additionalProperties: false, required: ['result'], properties: { result: { anyOf: [{ type: 'null' }, projectLutSelectionResultSchemaV3] } },
  })),
  defineSchema('project-final-export-request', 1, 'Approve and export the current project version', {
    type: 'object', additionalProperties: false,
    required: ['projectVersionId', 'projectVersionHash', 'format', 'approval'],
    properties: {
      projectVersionId: idSchema,
      projectVersionHash: sha256Schema,
      format: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
      approval: {
        type: 'object', additionalProperties: false, required: ['approved'],
        properties: { approved: { const: true }, note: { type: 'string', minLength: 1, maxLength: 1000 } },
      },
    },
  }),
  defineSchema('project-final-export-operation-accepted', 1, 'Accepted approved project final export operation',
    successSchema({
      type: 'object', additionalProperties: false, required: ['operation', 'approval', 'outputSpec', 'replayed'],
      properties: {
        operation: publicOperationSchemaV4,
        approval: {
          type: 'object', additionalProperties: false, required: ['actorType', 'actorId', 'approvedAt'],
          properties: {
            actorType: { enum: ['api-client', 'user'] }, actorId: idSchema,
            approvedAt: dateTimeSchema, note: { type: 'string', minLength: 1, maxLength: 1000 },
          },
        },
        outputSpec: {
          type: 'object', additionalProperties: false, required: ['aspectRatio', 'width', 'height', 'fps'],
          properties: {
            aspectRatio: { enum: ['9:16', '16:9', '4:5', '1:1', '21:9'] },
            width: { type: 'integer', minimum: 2 }, height: { type: 'integer', minimum: 2 },
            fps: { type: 'integer', minimum: 1, maximum: 120 },
          },
        },
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('api-client-list', 1, 'API client list response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['clients'],
      properties: { clients: { type: 'array', items: apiClientSchema } },
    }),
  ),
  defineSchema('api-client-list', 2, 'API client list response with typed identities and grants',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['clients'],
      properties: { clients: { type: 'array', items: apiClientV2Schema } },
    }),
  ),
  defineSchema('api-access-change-request', 1, 'Explicit API access lifecycle or kill-switch command', apiAccessChangeRequestSchema),
  defineSchema('api-access-read-response', 1, 'Current API access lifecycle and kill-switch state', apiAccessReadResponseSchema),
  defineSchema('api-access-changed-response', 1, 'Applied API access command with cancellation evidence', apiAccessChangedResponseSchema),
  defineSchema('create-api-client-request', 1, 'Create API client request', {
    type: 'object',
    additionalProperties: false,
    required: ['name', 'scopes'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 120 },
      environment: { enum: ['sandbox', 'production'] },
      scopes: {
        type: 'array',
        maxItems: 64,
        uniqueItems: true,
        items: { type: 'string', pattern: '^[a-z-]+:[a-z-]+$' },
      },
    },
  }),
  defineSchema('api-client-created', 1, 'API client creation response',
    successSchema(credentialMutationDataSchema),
  ),
  defineSchema('api-client-created', 2, 'Typed API client creation response',
    successSchema(credentialMutationDataV2Schema),
  ),
  defineSchema('rotate-api-credential-request', 1, 'Rotate API credential request', {
    type: 'object',
    additionalProperties: false,
    properties: {
      overlapSeconds: { type: 'integer', minimum: 0, maximum: 86400, default: 900 },
    },
  }),
  defineSchema('api-credential-created', 1, 'API credential creation response',
    successSchema(credentialMutationDataSchema),
  ),
  defineSchema('api-credential-created', 2, 'API credential creation response with typed client identity',
    successSchema(credentialMutationDataV2Schema),
  ),
  defineSchema('api-credential-revoked', 1, 'API credential revocation response',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['credential'],
      properties: { credential: apiCredentialSchema },
    }),
  ),
  defineSchema('create-long-form-index-workflow-request', 1, 'Create a durable five-stage long-form indexing workflow', {
    type: 'object',
    additionalProperties: false,
    required: [
      'sourceArtifactId',
      'expectedArtifactSha256',
      'sourceManifestId',
      'expectedManifestHash',
      'policyVersion',
      'versions',
      'stageBudgets',
      'budget',
    ],
    properties: {
      sourceArtifactId: idSchema,
      expectedArtifactSha256: sha256Schema,
      sourceManifestId: idSchema,
      expectedManifestHash: sha256Schema,
      sourceTranscript: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'expectedHash'],
        properties: {
          id: idSchema,
          expectedHash: sha256Schema,
        },
      },
      policyVersion: {
        const: 'long-form-index-workflow-policy/v1',
      },
      versions: longFormStageMapSchema(
        longFormStageVersionSchema,
      ),
      stageBudgets: longFormStageMapSchema(
        longFormStageBudgetSchema,
      ),
      budget: longFormWorkflowBudgetSchema,
    },
  }),
  defineSchema('long-form-index-workflow-mutated', 1, 'Accepted or idempotently replayed long-form indexing workflow',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['workflow', 'operation', 'replayed'],
      properties: {
        ...longFormIndexWorkflowRecordSchemaV1.properties,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('long-form-index-workflow-mutated', 2, 'Accepted or idempotently replayed long-form indexing workflow with typed stage outputs',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['workflow', 'operation', 'replayed'],
      properties: {
        ...longFormIndexWorkflowRecordSchemaV2.properties,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('long-form-index-workflow-mutated', 3, 'Accepted or replayed long-form workflow with typed outputs and persisted public cost projection',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['workflow', 'operation', 'replayed'],
      properties: {
        ...longFormIndexWorkflowRecordSchemaV3.properties,
        replayed: { type: 'boolean' },
      },
    }),
  ),
  defineSchema('long-form-index-workflow-read', 1, 'One durable long-form indexing workflow and its public operation',
    successSchema(longFormIndexWorkflowRecordSchemaV1),
  ),
  defineSchema('long-form-index-workflow-read', 2, 'One durable long-form indexing workflow with typed stage outputs and its public operation',
    successSchema(longFormIndexWorkflowRecordSchemaV2),
  ),
  defineSchema('long-form-index-workflow-read', 3, 'One durable long-form workflow with typed outputs and persisted public cost projection',
    successSchema(longFormIndexWorkflowRecordSchemaV3),
  ),
  defineSchema('long-form-index-workflow-page', 1, 'Cursor page of durable long-form indexing workflows',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['workflows'],
      properties: {
        workflows: {
          type: 'array',
          maxItems: 100,
          items: longFormIndexWorkflowRecordSchemaV1,
        },
        nextCursor: {
          type: 'string',
          minLength: 3,
          maxLength: 128,
        },
      },
    }),
  ),
  defineSchema('long-form-index-workflow-page', 2, 'Cursor page of durable long-form indexing workflows with typed stage outputs',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['workflows'],
      properties: {
        workflows: {
          type: 'array',
          maxItems: 100,
          items: longFormIndexWorkflowRecordSchemaV2,
        },
        nextCursor: {
          type: 'string',
          minLength: 3,
          maxLength: 128,
        },
      },
    }),
  ),
  defineSchema('long-form-index-workflow-page', 3, 'Cursor page of durable long-form workflows with typed outputs and persisted public cost projections',
    successSchema({
      type: 'object',
      additionalProperties: false,
      required: ['workflows'],
      properties: {
        workflows: {
          type: 'array',
          maxItems: 100,
          items: longFormIndexWorkflowRecordSchemaV3,
        },
        nextCursor: {
          type: 'string',
          minLength: 3,
          maxLength: 128,
        },
      },
    }),
  ),
  defineSchema(
    'speaker-diarization-read',
    1,
    'Immutable anonymous speaker intervals produced by one long-form workflow',
    successSchema(speakerDiarizationRunSchema),
  ),
  defineSchema('error-envelope', 1, 'Public API error envelope', {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message', 'category', 'retryable', 'requestId'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          category: { enum: ['auth', 'conflict', 'validation', 'internal'] },
          retryable: { type: 'boolean' },
          requestId: { type: 'string' },
          details: { type: 'object' },
        },
      },
    },
  }),
  defineSchema('error-envelope', 2, 'Public API error envelope with semantic conflict', {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message', 'category', 'retryable', 'requestId'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          category: { enum: ['auth', 'conflict', 'validation', 'internal'] },
          retryable: { type: 'boolean' },
          requestId: { type: 'string' },
          details: { type: 'object' },
          conflict: {
            type: 'object',
            additionalProperties: false,
            required: ['currentVersionId', 'conflictingTargets', 'diff'],
            properties: {
              currentVersionId: idSchema,
              conflictingTargets: {
                type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true,
                items: { type: 'string', minLength: 1, maxLength: 256 },
              },
              diff: versionDiffSchema,
            },
          },
        },
      },
    },
  }),
  defineSchema('error-envelope', 3, 'Public API error envelope with stable error categories', {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message', 'category', 'retryable', 'requestId'],
        properties: {
          code: { enum: PUBLIC_ERROR_CODES },
          message: { type: 'string' },
          category: {
            enum: ['validation', 'auth', 'policy', 'conflict', 'quota', 'provider', 'internal'],
          },
          retryable: { type: 'boolean' },
          requestId: { type: 'string' },
          details: { type: 'object' },
          conflict: {
            type: 'object',
            additionalProperties: false,
            required: ['currentVersionId', 'conflictingTargets', 'diff'],
            properties: {
              currentVersionId: idSchema,
              conflictingTargets: {
                type: 'array', minItems: 1, maxItems: 1024, uniqueItems: true,
                items: { type: 'string', minLength: 1, maxLength: 256 },
              },
              diff: versionDiffSchema,
            },
          },
        },
      },
    },
  }),
  defineSchema('openapi-document', 1, 'OpenAPI 3.1 document', {
    type: 'object',
    required: ['openapi', 'info', 'paths', 'components'],
    properties: {
      openapi: { const: '3.1.0' },
      info: { type: 'object' },
      paths: { type: 'object' },
      components: { type: 'object' },
    },
  }),
  defineSchema('json-schema-document', 1, 'JSON Schema document', {
    type: 'object',
    required: ['$schema', '$id', 'title'],
    properties: {
      $schema: { const: 'https://json-schema.org/draft/2020-12/schema' },
      $id: { type: 'string', pattern: '^apollo://schemas/' },
      title: { type: 'string' },
    },
  }),
])

const schemasByRef = new Map(PUBLIC_SCHEMAS.map((definition) => [definition.ref, definition]))
const schemasByRoute = new Map(
  PUBLIC_SCHEMAS.map((definition) => [
    `${definition.id}:v${definition.version}`,
    definition,
  ]),
)

export function getPublicSchema(ref: string): PublicSchemaDefinition {
  const definition = schemasByRef.get(ref)
  if (!definition) {
    throw new DomainError('PUBLIC_SCHEMA_NOT_FOUND', 'Public schema was not found')
  }
  return definition
}

export function getPublicSchemaByRoute(id: string, version: string): PublicSchemaDefinition {
  if (!/^v[1-9]\d*$/.test(version)) {
    throw new DomainError('PUBLIC_SCHEMA_NOT_FOUND', 'Public schema was not found')
  }
  const definition = schemasByRoute.get(`${id}:${version}`)
  if (!definition) {
    throw new DomainError('PUBLIC_SCHEMA_NOT_FOUND', 'Public schema was not found')
  }
  return definition
}

export function publicSchemaPath(definition: PublicSchemaDefinition): string {
  return `/v1/schemas/${definition.id}/v${definition.version}`
}
