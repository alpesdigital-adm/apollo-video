import type { PublicSchemaDefinition } from './schema-registry.ts'
import { createCompareActionImpact } from '../domain/compare-action-impact.ts'
import { PUBLIC_EVENT_CATALOG } from '../domain/public-event.ts'
import {
  MVP_CORE_ACCEPTANCE_CRITERIA,
  MVP_CORE_CRITERION_CHECKS,
} from '../domain/mvp-core-gate.ts'

const createdAt = '2026-07-12T20:00:00.000Z'
/** Built by the real factory so the published example carries a real impact hash. */
const compareActionImpactExample = createCompareActionImpact({
  commandId: 'compare-command-example-3',
  baseVersionId: 'project-version-example-5',
  resultVersionId: 'project-version-example-5',
  action: 'accept',
})
const projectId = 'project-example-1'
const workspaceId = 'workspace-example-1'
const clientId = 'client-example-1'
const credentialId = 'credential-example-1'
const artifactId = 'artifact-example-1'
const workspaceLutCubeExample = 'TITLE "Coração 🎞️"\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n0 0 1\n0 1 0\n0 1 1\n1 0 0\n1 0 1\n1 1 0\n1 1 1\n'
const workspaceLutExample = {
  id: 'lut-cinema-example', workspaceId, status: 'active',
  currentVersion: {
    id: 'lut-version-example-1', version: 1, name: 'Coração 🎞️', owner: 'Apollo Studio',
    license: { policy: 'owned', name: 'Propriedade do workspace' }, tags: ['cinema', 'coração'],
    compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' },
    intensity: { default: 0.75, min: 0, max: 1 },
    cube: { title: 'Coração 🎞️', size: 2, domainMin: [0, 0, 0], domainMax: [1, 1, 1], rows: 8, contentHash: '8'.repeat(64) },
    preview: { mediaType: 'image/png', width: 512, height: 288, byteSize: 2048, sha256: '9'.repeat(64), path: `/v1/workspaces/${workspaceId}/luts/lut-cinema-example/versions/1/preview` },
    createdByClientId: clientId, createdAt, recordHash: 'a'.repeat(64),
  },
}
const projectLutSelectionExample = {
  command: { id: 'project-lut-command-example-1', type: 'set-project-lut-selection', baseVersionId: 'project-version-example-1', author: { type: 'api-client', id: clientId }, reason: 'Usar o look aprovado.', createdAt },
  version: { id: 'project-version-example-lut-2', sequence: 2, parentVersionId: 'project-version-example-1', baseHash: 'd'.repeat(64), createdAt },
  selection: {
    id: 'project-lut-selection-example-1', requested: { mode: 'workspace-default' },
    resolved: { mode: 'lut-version', lut: { lutId: workspaceLutExample.id, versionId: workspaceLutExample.currentVersion.id, version: 1, name: workspaceLutExample.currentVersion.name, recordHash: workspaceLutExample.currentVersion.recordHash, cubeContentHash: workspaceLutExample.currentVersion.cube.contentHash } },
    workspaceDefaultRevision: 1, intensity: 0.75, selectionHash: 'e'.repeat(64), createdAt,
  },
  replayed: false,
}
const colorSourceMetadataExample = {
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709',
  matrix: 'bt709', range: 'limited', bitDepth: 10,
}
const colorOutputMetadataExample = {
  ...colorSourceMetadataExample,
  bitDepth: 8,
}
const colorPipelineStagesExample = [
  {
    id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true,
    input: colorSourceMetadataExample, output: colorSourceMetadataExample,
    implementation: { provider: 'ffmpeg-zscale', version: '7.1.1', parameters: { mode: 'identity' }, parametersHash: '1'.repeat(64) },
  },
  {
    id: 'match-source', kind: 'match', version: 'v1', enabled: false,
    input: colorSourceMetadataExample, output: colorSourceMetadataExample,
    implementation: { provider: 'apollo-match', version: 'v1', parameters: { mode: 'bypass' }, parametersHash: '2'.repeat(64) },
  },
  {
    id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false,
    input: colorSourceMetadataExample, output: colorSourceMetadataExample,
    implementation: { provider: 'apollo-lut', version: 'v1', parameters: { mode: 'none' }, parametersHash: '3'.repeat(64) },
  },
  {
    id: 'output-rec709', kind: 'output', version: 'v1', enabled: true,
    input: colorSourceMetadataExample, output: colorOutputMetadataExample,
    implementation: { provider: 'ffmpeg-zscale', version: '7.1.1', parameters: { dither: true }, parametersHash: '4'.repeat(64) },
  },
]
const colorPipelineCompilationExample = {
  schemaVersion: 'color-pipeline-compilation/v1',
  id: 'color-pipeline-example-1',
  workspaceId,
  projectId,
  sourceArtifactId: artifactId,
  sourceManifestId: 'manifest-example-1',
  colorProbeId: 'color-probe-example-1',
  colorProbeHash: '8'.repeat(64),
  pipeline: {
    schemaVersion: 'resolved-color-pipeline/v1',
    sourceMetadata: colorSourceMetadataExample,
    outputMetadata: colorOutputMetadataExample,
    stages: colorPipelineStagesExample,
    target: { sourceId: artifactId },
    manifestKey: 'technical:technical-rec709@v1:1>match:match-source@v1:2>creative-lut:creative-none@v1:3>output:output-rec709@v1:4',
    pipelineHash: '5'.repeat(64),
  },
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  compilationHash: '6'.repeat(64),
}
const rightsSnapshotId = 'rights-example-1'
const assetRightsRequestExample = {
  owner: 'Alpes Digital',
  license: 'owned-media',
  status: 'approved',
  allowedUses: ['paid-ad', 'organic-content'],
  prohibitedUses: [],
  allowedMarkets: ['BR'],
  allowedLocales: ['pt-BR'],
  allowedSyntheticOperations: [],
  expiresAt: '2027-07-12T20:00:00.000Z',
  consent: {
    status: 'not-required',
    allowedUses: [],
  },
  sourceNote: 'Direitos confirmados pelo administrador do workspace.',
}
const assetRightsSnapshotExample = {
  schemaVersion: 'asset-rights/v1',
  id: rightsSnapshotId,
  workspaceId,
  artifactId,
  sequence: 1,
  snapshotHash: '6'.repeat(64),
  ...assetRightsRequestExample,
  allowedWorkspaceIds: [workspaceId],
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
}
const renderInputRequestExample = {
  schemaVersion: 'render-input/v1',
  renderer: {
    id: 'remotion',
    version: '4.0.489',
    digest: '8'.repeat(64),
  },
  composition: {
    id: 'apollo-video',
    version: 'v1',
    propsSchemaRef: 'apollo://render-props/apollo-video/v1',
  },
  plan: {
    id: 'plan-example-1',
    versionId: 'plan-version-example-1',
    hash: '9'.repeat(64),
  },
  output: {
    id: 'preset-9x16',
    locale: 'pt-BR',
    aspectRatio: '9:16',
    width: 1080,
    height: 1920,
    fps: 30,
    safeArea: { top: 0.05, right: 0.05, bottom: 0.05, left: 0.05 },
    durationInFrames: 900,
  },
  assets: [
    {
      id: 'asset-primary-video',
      artifactId,
      artifactKey: 'artifact:artifact-example-source-1',
      kind: 'video',
      role: 'primary',
      ordinal: 0,
      sha256: 'a'.repeat(64),
      byteSize: 2849012,
    },
  ],
  props: {
    primaryVideoAssetId: 'asset-primary-video',
    title: 'Abertura validada',
  },
}
const queuedRenderOperationExample = {
  schemaVersion: 'public-operation/v1',
  id: 'operation-render-example-1',
  type: 'artifact-render',
  status: 'queued',
  phase: 'queued',
  progress: { completed: 0, total: 1, unit: 'render' },
  cancelable: true,
  retryable: false,
  target: {
    type: 'media-artifact',
    id: artifactId,
    manifestId: 'manifest-example-1',
  },
  attempt: 0,
  maxAttempts: 3,
  createdAt,
  updatedAt: createdAt,
}
const webhookDeliveryExample = {
  schemaVersion: 'webhook-delivery/v1',
  id: '00000000-0000-4000-8000-000000000701',
  endpointId: '00000000-0000-4000-8000-000000000702',
  subscriptionId: '00000000-0000-4000-8000-000000000703',
  eventId: '00000000-0000-4000-8000-000000000704',
  status: 'succeeded',
  attemptCount: 1,
  maxAttempts: 8,
  nextAttemptAt: createdAt,
  createdAt,
  completedAt: '2026-07-12T20:00:01.000Z',
}
const webhookSecretMetadataExample = {
  version: 1,
  fingerprint: 'd'.repeat(64),
  status: 'active',
  createdAt,
}
const webhookEndpointExample = {
  schemaVersion: 'webhook-endpoint/v1',
  id: '00000000-0000-4000-8000-000000000702',
  status: 'active',
  revision: 'f'.repeat(64),
  destinationOrigin: 'https://hooks.example.com',
  urlFingerprint: 'c'.repeat(64),
  createdByClientId: clientId,
  createdAt,
  verifiedAt: createdAt,
  currentSigningSecret: webhookSecretMetadataExample,
}
const webhookPendingEndpointExample = {
  schemaVersion: webhookEndpointExample.schemaVersion,
  id: '00000000-0000-4000-8000-000000000710',
  status: 'pending-verification',
  revision: 'a'.repeat(64),
  destinationOrigin: 'https://hooks.example.com',
  urlFingerprint: 'b'.repeat(64),
  createdByClientId: clientId,
  createdAt,
  currentSigningSecret: webhookSecretMetadataExample,
}
const queuedMediaIngestOperationExample = {
  schemaVersion: 'public-operation/v1',
  id: 'operation-ingest-example-1',
  type: 'media-ingest',
  status: 'queued',
  phase: 'queued',
  progress: { completed: 0, total: 6, unit: 'ingest-stage' },
  cancelable: true,
  retryable: false,
  target: { type: 'media-artifact', id: 'artifact-example-master-1', manifestId: 'manifest-example-master-1' },
  attempt: 0,
  maxAttempts: 3,
  createdAt,
  updatedAt: createdAt,
}
const queuedProjectProxyRenderOperationExample = {
  ...queuedRenderOperationExample,
  id: 'operation-project-proxy-example-1',
  type: 'project-proxy-render',
  target: { type: 'media-artifact', id: 'artifact-editorial-proxy-example-1', manifestId: 'manifest-editorial-proxy-example-1' },
}
const queuedProjectFinalExportOperationExample = {
  ...queuedRenderOperationExample,
  id: 'operation-project-final-example-1',
  type: 'project-final-export',
  target: { type: 'media-artifact', id: 'artifact-final-example-1', manifestId: 'manifest-final-example-1' },
}
const queuedSourceCleanupOperationExample = {
  ...queuedRenderOperationExample,
  id: 'operation-source-cleanup-example-1',
  type: 'source-cleanup',
  target: {
    type: 'media-artifact',
    id: 'artifact-cleaned-example-1',
    manifestId: 'manifest-cleaned-example-1',
  },
}
const queuedLongFormIndexOperationExample = {
  ...queuedMediaIngestOperationExample,
  id: 'operation-long-form-example-1',
  type: 'long-form-index',
  progress: { completed: 0, total: 1, unit: 'stage' },
  target: {
    type: 'media-artifact',
    id: 'artifact-long-form-example-1',
    manifestId: 'manifest-long-form-example-1',
  },
}
const queuedLongFormIndexOperationVisibleExample = {
  ...queuedLongFormIndexOperationExample,
  visibleState: {
    schemaVersion: 'visible-state/v1',
    label: 'queued',
    tone: 'neutral',
    progress: { mode: 'not-started', percent: 0 },
    primaryAction: 'view-progress',
    availableActions: ['view-progress', 'cancel'],
    terminal: false,
  },
}
const queuedLongFormIndexOperationVisibleProjectExample = {
  ...queuedLongFormIndexOperationVisibleExample,
  projectId,
}
const queuedLongFormIndexCostOperationExample = {
  ...queuedLongFormIndexOperationVisibleProjectExample,
  estimatedCost: {
    currency: 'USD',
    estimatedMinorUnits: 30,
    maximumMinorUnits: 200,
  },
}
const queuedProjectDirectorOperationVisibleExample = {
  schemaVersion: 'public-operation/v1',
  id: 'operation-project-director-example-1',
  projectId,
  type: 'project-director-run',
  status: 'queued',
  phase: 'queued',
  progress: { completed: 0, total: 1, unit: 'director-run' },
  cancelable: true,
  retryable: false,
  target: { type: 'project-version', id: 'project-version-director-example-1' },
  attempt: 0,
  maxAttempts: 3,
  createdAt,
  updatedAt: createdAt,
  visibleState: {
    schemaVersion: 'visible-state/v1',
    label: 'queued',
    tone: 'neutral',
    progress: { mode: 'not-started', percent: 0 },
    primaryAction: 'view-progress',
    availableActions: ['view-progress', 'cancel'],
    terminal: false,
  },
}
const queuedProductionBatchItemOperationVisibleExample = {
  schemaVersion: 'public-operation/v1',
  id: `production-batch-item-operation-${'b'.repeat(64)}`,
  projectId,
  type: 'production-batch-item',
  status: 'queued',
  phase: 'queued',
  progress: { completed: 2, total: 4, unit: 'batch-step' },
  cancelable: true,
  retryable: false,
  target: {
    type: 'production-batch-item',
    id: 'production-batch-item-example-1',
    batchId: 'production-batch-example-1',
  },
  attempt: 1,
  maxAttempts: 3,
  createdAt,
  updatedAt: createdAt,
  visibleState: {
    schemaVersion: 'visible-state/v1',
    label: 'queued',
    tone: 'neutral',
    progress: { mode: 'not-started', percent: 0 },
    primaryAction: 'view-progress',
    availableActions: ['view-progress', 'cancel'],
    terminal: false,
  },
}
const longFormStageVersionsExample = Object.fromEntries(
  ['probe', 'transcript', 'diarization', 'chunks', 'moments']
    .map((stage) => [
      stage,
      {
        provider: stage === 'probe' ? 'ffprobe' : 'apollo',
        model: `${stage}-model`,
        version: 'v1',
      },
    ]),
)
const longFormStageBudgetsExample = Object.fromEntries(
  ['probe', 'transcript', 'diarization', 'chunks', 'moments']
    .map((stage) => [
      stage,
      {
        estimatedCostMinorUnits:
          ['probe', 'transcript'].includes(stage) ? 0 : 25,
        maximumCostMinorUnits: 100,
        maximumElapsedMs: 3600000,
      },
    ]),
)
const longFormWorkflowBudgetExample = {
  currency: 'USD',
  maximumCostMinorUnits: 500,
  maximumElapsedMs: 14400000,
  maximumConcurrency: 4,
}
const longFormOutputTypeByStage = {
  probe: 'media-artifact-manifest',
  transcript: 'media-transcript',
  diarization: 'speaker-diarization-run',
  chunks: 'hierarchical-processing-run',
  moments: 'long-form-index-run',
}
const longFormStageExample = (
  stage: string,
  sequence: number,
  prerequisites: string[],
  status: string,
  outputHash?: string,
) => ({
  stage,
  sequence,
  prerequisites,
  execution: ['probe', 'transcript'].includes(stage)
    ? 'reuse'
    : 'process',
  status,
  version:
    longFormStageVersionsExample[
      stage as keyof typeof longFormStageVersionsExample
    ],
  budget:
    longFormStageBudgetsExample[
      stage as keyof typeof longFormStageBudgetsExample
    ],
  concurrency: ['chunks', 'moments'].includes(stage) ? 4 : 1,
  inputHash: String(sequence).repeat(64),
  idempotencyKey:
    `long-form-workflow-example-1:${stage}:${String(sequence).repeat(32)}`,
  attempt: 0,
  ...(outputHash ? { outputHash } : {}),
  ...(outputHash
    ? {
        outputReference: {
          type:
            longFormOutputTypeByStage[
              stage as keyof typeof longFormOutputTypeByStage
            ],
          id: stage === 'probe'
            ? 'manifest-long-form-example-1'
            : `${stage}-long-form-example-1`,
        },
      }
    : {}),
  resultCount: outputHash ? 1 : 0,
  searchable: stage === 'transcript',
  costMinorUnits: 0,
  elapsedMs: 0,
  ...(outputHash ? { completedAt: createdAt } : {}),
  stageHash: ['6', '7', '8', '9', 'a'][sequence - 1]!.repeat(64),
})
const longFormIndexWorkflowExample = {
  schemaVersion: 'long-form-index-workflow/v1',
  policyVersion: 'long-form-index-workflow-policy/v1',
  id: 'long-form-workflow-example-1',
  workspaceId,
  projectId,
  sourceArtifactId: 'artifact-long-form-example-1',
  sourceArtifactSha256: 'a'.repeat(64),
  sourceManifestId: 'manifest-long-form-example-1',
  sourceManifestHash: 'b'.repeat(64),
  sourceTranscriptId: 'transcript-long-form-example-1',
  sourceTranscriptHash: 'c'.repeat(64),
  durationMs: 7200000,
  status: 'partial',
  stages: [
    longFormStageExample(
      'probe',
      1,
      [],
      'succeeded',
      'd'.repeat(64),
    ),
    longFormStageExample(
      'transcript',
      2,
      ['probe'],
      'succeeded',
      'c'.repeat(64),
    ),
    longFormStageExample(
      'diarization',
      3,
      ['transcript'],
      'ready',
    ),
    longFormStageExample(
      'chunks',
      4,
      ['transcript', 'diarization'],
      'pending',
    ),
    longFormStageExample(
      'moments',
      5,
      ['chunks'],
      'pending',
    ),
  ],
  budget: longFormWorkflowBudgetExample,
  summary: {
    completedStageCount: 2,
    searchableStageCount: 1,
    resultCount: 2,
    costMinorUnits: 0,
    elapsedMs: 0,
    nextStage: 'diarization',
    duplicateSegments: false,
    resumable: true,
  },
  createdByClientId: clientId,
  createdAt,
  updatedAt: createdAt,
  runHash: 'f'.repeat(64),
}
const longFormIndexWorkflowExampleV1 = {
  ...longFormIndexWorkflowExample,
  stages: longFormIndexWorkflowExample.stages.map((stage) => {
    const {
      outputReference: _outputReference,
      ...legacyStage
    } = stage
    return legacyStage
  }),
}
const speakerDiarizationRunExample = {
  schemaVersion: 'speaker-diarization-run/v1',
  policyVersion: 'anonymous-speaker-clusters/v1',
  id: 'diarization-run-example-1',
  workspaceId,
  projectId,
  workflowId: longFormIndexWorkflowExample.id,
  sourceArtifactId: longFormIndexWorkflowExample.sourceArtifactId,
  sourceArtifactSha256:
    longFormIndexWorkflowExample.sourceArtifactSha256,
  sourceManifestId: longFormIndexWorkflowExample.sourceManifestId,
  sourceManifestHash:
    longFormIndexWorkflowExample.sourceManifestHash,
  sourceTranscriptId:
    longFormIndexWorkflowExample.sourceTranscriptId,
  sourceTranscriptHash:
    longFormIndexWorkflowExample.sourceTranscriptHash,
  durationMs: longFormIndexWorkflowExample.durationMs,
  providerInput: {
    sha256: '7'.repeat(64),
    byteSize: 14400000,
    durationMs: longFormIndexWorkflowExample.durationMs,
    preparation: {
      toolId: 'ffmpeg',
      toolVersion: 'static',
      configurationHash: '8'.repeat(64),
    },
  },
  provider: {
    id: 'openai',
    model: 'gpt-4o-transcribe-diarize',
    version: 'v1',
  },
  segments: [
    {
      id: 'diarization-segment-example-1',
      ordinal: 0,
      providerSegmentId: 'provider-segment-example-1',
      providerLabel: 'A',
      speakerKey: `speaker-cluster-${'1'.repeat(40)}`,
      startMs: 0,
      endMs: 5200,
      text: 'Abertura do especialista.',
      textHash: '1'.repeat(64),
      segmentHash: '2'.repeat(64),
    },
    {
      id: 'diarization-segment-example-2',
      ordinal: 1,
      providerSegmentId: 'provider-segment-example-2',
      providerLabel: 'B',
      speakerKey: `speaker-cluster-${'3'.repeat(40)}`,
      startMs: 5200,
      endMs: 12800,
      text: 'Resposta do convidado.',
      textHash: '3'.repeat(64),
      segmentHash: '4'.repeat(64),
    },
  ],
  speakerCount: 2,
  segmentCount: 2,
  usageSeconds: 7200,
  costMinorUnits: 120,
  elapsedMs: 180000,
  identityResolved: false,
  physicalMaterialized: false,
  requestFingerprint: '5'.repeat(64),
  idempotencyKey:
    'long-form-workflow-example-1:diarization:55555555555555555555555555555555',
  createdByClientId: clientId,
  createdAt,
  runHash: '6'.repeat(64),
}
const createLongFormIndexWorkflowRequestExample = {
  sourceArtifactId: longFormIndexWorkflowExample.sourceArtifactId,
  expectedArtifactSha256:
    longFormIndexWorkflowExample.sourceArtifactSha256,
  sourceManifestId: longFormIndexWorkflowExample.sourceManifestId,
  expectedManifestHash:
    longFormIndexWorkflowExample.sourceManifestHash,
  sourceTranscript: {
    id: longFormIndexWorkflowExample.sourceTranscriptId,
    expectedHash:
      longFormIndexWorkflowExample.sourceTranscriptHash,
  },
  policyVersion: longFormIndexWorkflowExample.policyVersion,
  versions: longFormStageVersionsExample,
  stageBudgets: longFormStageBudgetsExample,
  budget: longFormWorkflowBudgetExample,
}
const versionComparisonExample = {
  before: {
    id: 'project-version-example-4',
    durationMs: 10000,
    mappingId: 'sync-mapping-example-1',
    score: 0.72,
    issues: ['SUBTITLE_FACE_OVERLAP'],
  },
  after: {
    id: 'project-version-example-5',
    durationMs: 12000,
    mappingId: 'sync-mapping-example-1',
    score: 0.91,
    issues: ['PATTERN_BREAK_DENSITY'],
  },
  mode: 'split',
  synchronized: true,
  playheadMapping: 'shared',
  durationDeltaMs: 2000,
  scoreDelta: 0.19,
  issuesAdded: ['PATTERN_BREAK_DENSITY'],
  issuesResolved: ['SUBTITLE_FACE_OVERLAP'],
  semanticChanges: [
    { category: 'timeline', target: 'clip-example-1', summary: 'Clip timing changed.' },
    { category: 'duration', target: 'project-timeline', summary: 'Total duration changed.' },
  ],
  actions: ['accept', 'reopen', 'restore'],
  versionsPreserved: true,
}
const proxyReviewExample = {
  id: 'proxy-review-example-1',
  projectId,
  projectVersionId: 'project-version-example-5',
  operationId: 'operation-project-proxy-example-1',
  proxyArtifactId: 'artifact-editorial-proxy-example-1',
  proxyManifestId: 'manifest-editorial-proxy-example-1',
  inputHash: '8'.repeat(64),
  rangeCacheKey: '9'.repeat(64),
  spec: {
    width: 540,
    height: 960,
    codec: 'h264',
    container: 'mp4',
    quality: 'review',
    reusableRanges: true,
  },
  status: 'warning-ack-required',
  technicalIssues: [],
  criticIssues: [{
    code: 'PATTERN_DENSITY',
    severity: 'warning',
    category: 'editorial',
    message: 'Pattern breaks are dense in this range.',
    rangeMs: [2000, 4200],
    targetId: 'scene-example-1',
    correctable: true,
  }],
  warningsAcknowledged: false,
  finalAllowed: false,
  uploadReceivedAt: '2026-07-12T19:58:00.000Z',
  renderCompletedAt: createdAt,
  timeToFirstProxyMs: 120000,
  reviewHash: 'a'.repeat(64),
  revision: 1,
  createdAt,
  updatedAt: createdAt,
}
const assetBriefExample = {
  intention: 'Reforçar visualmente o ganho de clareza sem interromper a fala.',
  content: ['dashboard', 'resultado'],
  style: ['clean', 'editorial'],
  durationMs: { min: 1200, max: 3500 },
  entry: 'cut on sentence boundary',
  exit: 'return before next claim',
  prohibited: ['dinheiro falso', 'interface ilegível'],
}
const assetSelectionCandidatesExample = [
  {
    artifactId: 'artifact-library-rejected-1',
    source: 'library',
    content: ['praia'],
    style: ['clean'],
    durationMs: 2400,
    quality: 0.9,
    continuity: 0.8,
    novelty: 0.4,
    literalness: 0.2,
  },
  {
    artifactId: 'artifact-library-approved-1',
    source: 'library',
    content: ['dashboard', 'resultado'],
    style: ['clean', 'editorial'],
    durationMs: 2500,
    quality: 0.92,
    continuity: 0.88,
    novelty: 0.5,
    literalness: 0.25,
  },
  {
    artifactId: 'artifact-stock-unused-1',
    source: 'stock',
    content: ['dashboard', 'resultado'],
    style: ['clean', 'editorial'],
    durationMs: 2500,
    quality: 0.95,
    continuity: 0.9,
    novelty: 0.5,
    literalness: 0.2,
  },
]
const assetSelectionExample = {
  schemaVersion: 'asset-selection/v1',
  id: 'asset-selection-example-1',
  projectId,
  projectVersionId: 'project-version-example-5',
  projectVersionHash: 'e'.repeat(64),
  brief: assetBriefExample,
  briefHash: '1'.repeat(64),
  candidates: assetSelectionCandidatesExample.map((candidate) => ({
    ...candidate,
    rights: 'approved',
  })),
  candidatesHash: '2'.repeat(64),
  rightsEvidence: assetSelectionCandidatesExample.map((candidate, index) => ({
    artifactId: candidate.artifactId,
    artifactSha256: String(index + 3).repeat(64),
    outcome: 'allow',
    reasonCodes: [],
    rightsSnapshotId: `rights-selection-example-${index + 1}`,
    rightsSnapshotHash: String(index + 6).repeat(64),
    validUntil: '2026-07-12T20:05:00.000Z',
  })),
  decision: 'use_asset',
  selectedArtifactId: 'artifact-library-approved-1',
  selectedSource: 'library',
  evaluations: [
    {
      candidateId: 'artifact-library-approved-1',
      source: 'library',
      score: 0.9,
      verdict: 'accepted',
      reasons: [],
      dimensions: {
        relevance: 1, continuity: 0.88, quality: 0.92,
        rights: 1, novelty: 0.95, literalness: 0.75,
      },
    },
    {
      candidateId: 'artifact-library-rejected-1',
      source: 'library',
      score: 0.58,
      verdict: 'rejected',
      reasons: ['irrelevant'],
      dimensions: {
        relevance: 0, continuity: 0.8, quality: 0.9,
        rights: 1, novelty: 1, literalness: 0.8,
      },
    },
  ],
  searchStoppedBefore: ['stock', 'generated'],
  auditId: `asset_selection_${'a'.repeat(64)}`,
  selectionHash: 'b'.repeat(64),
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
}
const noInsertAssetSelectionExample = {
  ...assetSelectionExample,
  id: 'asset-selection-example-2',
  candidates: [{
    ...assetSelectionExample.candidates[0],
    rights: 'denied',
  }],
  candidatesHash: 'c'.repeat(64),
  rightsEvidence: [{
    artifactId: 'artifact-library-rejected-1',
    artifactSha256: '3'.repeat(64),
    outcome: 'deny',
    reasonCodes: ['RIGHTS_STATUS_REVOKED'],
    rightsSnapshotId: 'rights-selection-example-1',
    rightsSnapshotHash: '6'.repeat(64),
  }],
  decision: 'no_insert',
  selectedArtifactId: null,
  selectedSource: null,
  evaluations: [{
    candidateId: 'artifact-library-rejected-1',
    source: 'library',
    score: 0.43,
    verdict: 'rejected',
    reasons: ['irrelevant', 'rights-unavailable'],
    dimensions: {
      relevance: 0, continuity: 0.8, quality: 0.9,
      rights: 0, novelty: 1, literalness: 0.8,
    },
  }],
  searchStoppedBefore: [],
  auditId: `asset_selection_${'d'.repeat(64)}`,
  selectionHash: 'e'.repeat(64),
}
const qualityRubricEvidenceExample = [
  { criterionId: 'hook-clarity', score: 82, evidence: ['Opening promise remains explicit in the reviewed proxy.'] },
  { criterionId: 'problem-recognition', score: 82, evidence: ['The audience problem is named with source-backed context.'] },
  { criterionId: 'trust-building', score: 82, evidence: ['Claims remain attributed and visually sober.'] },
  { criterionId: 'narrative-integrity', score: 82, evidence: ['No qualifier or causal boundary was removed.'] },
  { criterionId: 'legibility', score: 82, evidence: ['Subtitles remain inside the safe region.'] },
  { criterionId: 'rights-compliance', score: 82, evidence: ['Every selected asset has server-verified rendering rights.'] },
]
const qualityIterationRequestExample = {
  projectVersionId: 'project-version-example-5',
  projectVersionHash: 'e'.repeat(64),
  proxyReviewId: proxyReviewExample.id,
  proxyReviewHash: proxyReviewExample.reviewHash,
  expectedProxyReviewRevision: 1,
  assetPlacements: [{
    selectionId: assetSelectionExample.id,
    startMs: 2000,
    endMs: 3500,
  }],
  rubricEvidence: qualityRubricEvidenceExample,
  rangeMetrics: [{ startMs: 2000, endMs: 3500, density: 0.95 }],
  datasetId: 'apollo-discovery-reference',
  datasetVersion: 1,
  budgetLimitUnits: 10,
}
const qualityIssueExample = {
  code: 'PATTERN_DENSITY',
  severity: 'warning',
  category: 'editorial',
  message: 'Pattern-break density is above the allowed range.',
  rangeMs: [2000, 3500],
  targetId: 'variant',
  correctable: true,
}
const qualityIterationExample = {
  schemaVersion: 'quality-iteration/v1',
  id: 'quality-iteration-example-1',
  projectId,
  projectVersionId: 'project-version-example-5',
  projectVersionHash: 'e'.repeat(64),
  iteration: 1,
  previousIterationId: null,
  proxyEvidence: {
    id: proxyReviewExample.id,
    reviewHash: proxyReviewExample.reviewHash,
    revision: 1,
    status: 'ready-for-final',
    finalAllowed: true,
    spec: proxyReviewExample.spec,
    technicalIssues: [],
    criticIssues: [],
  },
  assetPlacements: [{
    selectionId: assetSelectionExample.id,
    selectionHash: assetSelectionExample.selectionHash,
    rangeMs: [2000, 3500],
    selectedArtifactId: assetSelectionExample.selectedArtifactId,
    selectedSource: 'library',
    relevance: 1,
    continuity: 0.88,
    quality: 0.92,
    novelty: 0.5,
    rightsApproved: true,
    rightsReasonCodes: [],
    rightsSnapshotId: 'rights-selection-example-1',
    rightsSnapshotHash: '6'.repeat(64),
  }],
  rubric: {
    id: 'awareness-discovery',
    version: 1,
    objective: 'discovery',
    threshold: 68,
    evidence: qualityRubricEvidenceExample,
  },
  rangeMetrics: [{ startMs: 2000, endMs: 3500, density: 0.95 }],
  dataset: {
    id: 'apollo-discovery-reference',
    version: 1,
    baselineScore: 68,
    fingerprint: '9'.repeat(64),
  },
  score: 82,
  regression: 14,
  regressed: false,
  validation: {
    valid: true,
    finalBlocked: false,
    hardIssueCount: 0,
    warningIssueCount: 1,
    hardByCategory: {
      technical: 0,
      policy: 0,
      integrity: 0,
      asset: 0,
      editorial: 0,
    },
  },
  issues: [qualityIssueExample],
  patches: [{
    type: 'adjust',
    targetId: 'variant',
    issueCode: 'PATTERN_DENSITY',
    rangeMs: [2000, 3500],
  }],
  minimalRerenderRangesMs: [[2000, 3500]],
  fullRerenderRequired: false,
  budget: {
    limitUnits: 10,
    consumedUnits: 1,
    remainingUnits: 9,
    iterationCostUnits: 1,
  },
  decision: { continue: false, terminalReason: 'approval' },
  reportFingerprint: '8'.repeat(64),
  recordHash: '7'.repeat(64),
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
}
const reviewPatchProposalExample = {
  id: '90000000-0000-4000-8000-000000000214',
  workspaceId,
  projectId,
  annotationId: 'd8f7ec49-b87c-4ca8-80a7-7840de71c650',
  baseVersionId: 'project-version-example-2',
  status: 'ready',
  interpretationVersion: 'review-patch-interpreter/1.0.0+review-patch-policy/1.0.0',
  choices: [],
  patch: {
    id: 'patch-example-214',
    baseVersionId: 'project-version-example-2',
    operations: [{ op: 'update-layout', targetId: 'subtitle:subtitle-cue-2', value: { anchor: 'bottom', faceProtection: true }, rangeMs: [10500, 10500] }],
    annotationIds: ['d8f7ec49-b87c-4ca8-80a7-7840de71c650'],
    estimatedCost: 0,
    invalidatedRanges: [[10500, 10500]],
  },
  impact: {
    operationCount: 1,
    cost: 0,
    invalidatedRanges: [[10500, 10500]],
    changedTargets: ['subtitle:subtitle-cue-2'],
    expectedScoreDelta: 3,
    invalidatedArtifacts: ['proxy', 'final'],
  },
  gates: [
    { gate: 'ambiguity', passed: true, message: 'Uma interpretação tipada foi resolvida.', targetIds: ['subtitle:subtitle-cue-2'] },
    { gate: 'protected-elements', passed: true, message: 'Nenhum alvo protegido será alterado.', targetIds: [] },
    { gate: 'policy', passed: true, message: 'A operação é permitida pela policy ativa.', targetIds: ['subtitle:subtitle-cue-2'] },
    { gate: 'budget', passed: true, message: 'O custo estimado cabe no budget restante.', targetIds: ['subtitle:subtitle-cue-2'] },
  ],
  createdAt,
  updatedAt: createdAt,
}
const reviewPatchProposalTwoId = '90000000-0000-4000-8000-000000000215'
const reviewPatchAnnotationTwoId = 'd8f7ec49-b87c-4ca8-80a7-7840de71c651'
const reviewPatchBatchExample = {
  id: '91000000-0000-4000-8000-000000000215',
  workspaceId,
  projectId,
  baseVersionId: 'project-version-example-2',
  mode: 'all-or-nothing',
  status: 'ready',
  patch: {
    id: 'patch-batch-example-215',
    baseVersionId: 'project-version-example-2',
    operations: [
      reviewPatchProposalExample.patch.operations[0],
      { op: 'move', targetId: 'clip:clip-example-2', value: { toFrame: 420 }, rangeMs: [14000, 17000] },
    ],
    annotationIds: [reviewPatchProposalExample.annotationId, reviewPatchAnnotationTwoId],
    estimatedCost: 0,
    invalidatedRanges: [[10500, 10500], [14000, 17000]],
  },
  impact: {
    operationCount: 2,
    cost: 0,
    invalidatedRanges: [[10500, 10500], [14000, 17000]],
    changedTargets: ['clip:clip-example-2', 'subtitle:subtitle-cue-2'],
    expectedScoreDelta: 4,
    invalidatedArtifacts: ['proxy', 'final'],
  },
  conflicts: [],
  items: [
    {
      id: '92000000-0000-4000-8000-000000000215',
      annotationId: reviewPatchProposalExample.annotationId,
      proposalId: reviewPatchProposalExample.id,
      status: 'included',
      operation: reviewPatchProposalExample.patch.operations[0],
      conflictIds: [],
      createdAt,
      updatedAt: createdAt,
    },
    {
      id: '92000000-0000-4000-8000-000000000216',
      annotationId: reviewPatchAnnotationTwoId,
      proposalId: reviewPatchProposalTwoId,
      status: 'included',
      operation: { op: 'move', targetId: 'clip:clip-example-2', value: { toFrame: 420 }, rangeMs: [14000, 17000] },
      conflictIds: [],
      createdAt,
      updatedAt: createdAt,
    },
  ],
  createdAt,
  updatedAt: createdAt,
}
const webhookSigningSecretRotationExample = {
  schemaVersion: 'webhook-signing-secret-rotation/v1',
  id: '20000000-0000-4000-8000-000000000010',
  endpointId: webhookEndpointExample.id,
  candidateVersion: 2,
  fingerprint: 'c'.repeat(64),
  status: 'staged',
  overlapSeconds: 300,
  baseRevision: webhookEndpointExample.revision,
  createdAt,
  expiresAt: '2026-07-13T20:00:00.000Z',
}
const webhookSubscriptionExample = {
  schemaVersion: 'webhook-subscription/v1',
  id: '00000000-0000-4000-8000-000000000703',
  endpointId: webhookEndpointExample.id,
  status: 'active',
  revision: 'e'.repeat(64),
  eventTypes: ['project.created'],
  resourceIds: ['project-example-1'],
  createdByClientId: clientId,
  createdAt,
}
const webhookAttemptExample = {
  schemaVersion: 'webhook-delivery-attempt/v1',
  id: '00000000-0000-4000-8000-000000000705',
  attemptNumber: 1,
  status: 'succeeded',
  scheduledAt: createdAt,
  createdAt,
  startedAt: createdAt,
  completedAt: '2026-07-12T20:00:01.000Z',
  responseStatus: 204,
  responseBodyHash: 'e'.repeat(64),
}
const webhookReplayDeliverySummaryExample = {
  schemaVersion: webhookDeliveryExample.schemaVersion,
  id: webhookDeliveryExample.id,
  endpointId: webhookDeliveryExample.endpointId,
  subscriptionId: webhookDeliveryExample.subscriptionId,
  eventId: webhookDeliveryExample.eventId,
  status: 'retry-scheduled',
  attemptCount: webhookDeliveryExample.attemptCount,
  maxAttempts: webhookDeliveryExample.maxAttempts,
  nextAttemptAt: '2026-07-12T20:00:02.001Z',
  createdAt: webhookDeliveryExample.createdAt,
}
const webhookReplayDeliveryExample = {
  ...webhookReplayDeliverySummaryExample,
  attempts: [webhookAttemptExample],
}
const mvpCorePrimaryVersionId = 'project-version-mvp-primary-1'
const mvpCoreCompanionProjectId = 'project-mvp-companion-1'
const mvpCoreCompanionVersionId = 'project-version-mvp-companion-1'
const mvpCoreDuplicateProjectId = 'project-mvp-duplicate-1'
const mvpCoreEvidenceExample = MVP_CORE_ACCEPTANCE_CRITERIA.map(
  (criterion) => ({
    criterion,
    source: 'server',
    automatic: true,
    passed: true,
    missingChecks: [],
    checks: MVP_CORE_CRITERION_CHECKS[criterion].map((code) => ({
      code,
      passed: true,
      references: [{
        type: criterion === 'AC-001' ? 'workspace' : 'project',
        id: criterion === 'AC-001' ? workspaceId : projectId,
      }],
    })),
  }),
)
const mvpCoreReportExample = {
  schemaVersion: 'mvp-core-gate-report/v1',
  gate: 'mvp-core/v1',
  workspaceId,
  primaryProjectId: projectId,
  companionProjectId: mvpCoreCompanionProjectId,
  approved: true,
  covered: 16,
  passed: 16,
  total: 16,
  missing: [],
  failed: [],
  serverEvidenceOnly: true,
  evidence: mvpCoreEvidenceExample,
  evaluatedAt: createdAt,
  fingerprint: 'c'.repeat(64),
}
const mvpCoreGateExample = {
  schemaVersion: 'mvp-core-gate/v1',
  id: 'mvp-core-gate-example-1',
  workspaceId,
  primaryProjectId: projectId,
  companionProjectId: mvpCoreCompanionProjectId,
  primaryVersionId: mvpCorePrimaryVersionId,
  companionVersionId: mvpCoreCompanionVersionId,
  primaryVersionHash: 'a'.repeat(64),
  companionVersionHash: 'b'.repeat(64),
  report: mvpCoreReportExample,
  reportFingerprint: mvpCoreReportExample.fingerprint,
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  recordHash: 'd'.repeat(64),
}
const speechCatalogProducerExample = {
  provider: 'apollo',
  model: 'speech-catalog',
  version: '1.0.0',
  confidence: 0.94,
}
const speechObservationProvenanceExample = {
  source: 'catalog-observation',
  provider: speechCatalogProducerExample.provider,
  model: speechCatalogProducerExample.model,
  version: speechCatalogProducerExample.version,
  confidence: 0.92,
  observedAt: createdAt,
}
const speechObservationExample = {
  value: 'Confiante',
  normalizedValue: 'confiante',
  provenance: speechObservationProvenanceExample,
}
const speechSegmentExample = {
  schemaVersion: 'speech-segment/v1',
  id: 'speech-segment-example-1',
  workspaceId,
  projectId,
  catalogRunId: 'speech-catalog-run-example-1',
  sourceTranscriptId: 'transcript-example-1',
  sourceTranscriptHash: 'e'.repeat(64),
  sourceArtifactId: artifactId,
  sourceSegmentId: 10,
  exactText: 'Uma ideia completa muda a direção do vídeo.',
  normalizedText: 'uma ideia completa muda a direcao do video',
  words: [
    { word: 'Uma', startMs: 1000, endMs: 1150, confidence: 0.96 },
    { word: 'ideia', startMs: 1160, endMs: 1340, confidence: 0.96 },
    { word: 'completa', startMs: 1350, endMs: 1600, confidence: 0.96 },
    { word: 'muda', startMs: 1610, endMs: 1780, confidence: 0.96 },
    { word: 'a', startMs: 1790, endMs: 1840, confidence: 0.96 },
    { word: 'direção', startMs: 1850, endMs: 2100, confidence: 0.96 },
    { word: 'do', startMs: 2110, endMs: 2200, confidence: 0.96 },
    { word: 'vídeo.', startMs: 2210, endMs: 2500, confidence: 0.96 },
  ],
  speaker: {
    value: 'person-specialist',
    normalizedValue: 'person specialist',
    provenance: {
      ...speechObservationProvenanceExample,
      confidence: 0.99,
    },
  },
  speakerId: 'person-specialist',
  rangeMs: [1000, 2500],
  completeThoughtScore: 0.93,
  classification: 'complete-thought',
  visual: {
    emotion: speechObservationExample,
    expression: {
      value: 'Sorriso leve',
      normalizedValue: 'sorriso leve',
      provenance: {
        ...speechObservationProvenanceExample,
        confidence: 0.88,
      },
    },
    wardrobe: {
      value: 'Camisa azul',
      normalizedValue: 'camisa azul',
      provenance: {
        ...speechObservationProvenanceExample,
        confidence: 0.95,
      },
    },
    setting: {
      value: 'Estúdio claro',
      normalizedValue: 'estudio claro',
      provenance: {
        ...speechObservationProvenanceExample,
        confidence: 0.9,
      },
    },
    colors: [{
      value: 'Azul',
      normalizedValue: 'azul',
      provenance: {
        ...speechObservationProvenanceExample,
        confidence: 0.9,
      },
    }],
  },
  intentions: [{
    value: 'Hook de autoridade',
    normalizedValue: 'hook de autoridade',
    provenance: {
      ...speechObservationProvenanceExample,
      confidence: 0.94,
    },
  }],
  extractionProvenance: {
    source: 'transcript',
    provider: 'groq',
    model: 'whisper-large-v3',
    version: 'media-transcript/v1',
    confidence: 0.96,
    observedAt: createdAt,
  },
  extractionPolicyVersion: 'speech-segment-extraction/v1',
  physicalMaterialized: false,
  createdAt,
  segmentHash: 'f'.repeat(64),
}
const speechCatalogRunExample = {
  schemaVersion: 'speech-segment-catalog-run/v1',
  id: speechSegmentExample.catalogRunId,
  workspaceId,
  projectId,
  sourceTranscriptId: speechSegmentExample.sourceTranscriptId,
  sourceTranscriptHash: speechSegmentExample.sourceTranscriptHash,
  sourceArtifactId: speechSegmentExample.sourceArtifactId,
  extractionPolicyVersion: 'speech-segment-extraction/v1',
  producer: speechCatalogProducerExample,
  annotationsHash: '1'.repeat(64),
  segments: [speechSegmentExample],
  segmentCount: 1,
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  recordHash: '2'.repeat(64),
  active: true,
}
const evidenceProducerExample = {
  provider: 'apollo',
  model: 'evidence-catalog',
  version: '1.0.0',
  confidence: 0.96,
}
const evidenceObservationProvenanceExample = {
  source: 'evidence-observation',
  provider: evidenceProducerExample.provider,
  model: evidenceProducerExample.model,
  version: evidenceProducerExample.version,
  confidence: 0.96,
  observedAt: createdAt,
}
const evidenceObservationExample = {
  value: 'A conversão aumentou vinte por cento',
  normalizedValue: 'a conversao aumentou vinte por cento',
  provenance: evidenceObservationProvenanceExample,
}
const evidenceSegmentExample = {
  schemaVersion: 'evidence-segment/v1',
  id: 'evidence-segment-example-1',
  workspaceId,
  projectId,
  sourceSpeechSegmentId: speechSegmentExample.id,
  sourceSpeechSegmentHash: speechSegmentExample.segmentHash,
  sourceTranscriptId: speechSegmentExample.sourceTranscriptId,
  sourceTranscriptHash: speechSegmentExample.sourceTranscriptHash,
  sourceArtifactId: speechSegmentExample.sourceArtifactId,
  rightsSnapshotId: 'rights-snapshot-example-1',
  rightsStatus: 'approved',
  consentStatus: 'approved',
  category: 'testimonial',
  speaker: speechSegmentExample.speaker,
  speakerId: speechSegmentExample.speakerId,
  claim: evidenceObservationExample,
  result: {
    value: 'Vinte por cento no período medido',
    normalizedValue: 'vinte por cento no periodo medido',
    provenance: {
      ...evidenceObservationProvenanceExample,
      confidence: 0.94,
    },
  },
  context: {
    value: 'Resultado observado no período medido',
    normalizedValue: 'resultado observado no periodo medido',
    provenance: {
      ...evidenceObservationProvenanceExample,
      confidence: 0.95,
    },
  },
  qualifiers: [{
    value: 'Sem atribuição causal',
    normalizedValue: 'sem atribuicao causal',
    provenance: {
      ...evidenceObservationProvenanceExample,
      confidence: 0.98,
    },
  }],
  subject: {
    value: 'Cliente A',
    normalizedValue: 'cliente a',
    provenance: {
      ...evidenceObservationProvenanceExample,
      confidence: 0.99,
    },
  },
  attribution: {
    value: 'Depoimento do Cliente A',
    normalizedValue: 'depoimento do cliente a',
    provenance: {
      ...evidenceObservationProvenanceExample,
      confidence: 0.99,
    },
  },
  compatibleOfferIds: ['offer-example-1'],
  compatibleAudienceTags: ['empreendedores'],
  compatibleObjections: ['preço'],
  credibilityScore: 0.91,
  specificityScore: 0.94,
  authenticityScore: 0.93,
  sourceRangeMs: [1000, 2500],
  contextRangeMs: [500, 3000],
  handlesMs: { before: 500, after: 500 },
  exactTranscript: speechSegmentExample.exactText,
  frameRefs: ['frame-example-30', 'frame-example-75'],
  adjacentEvidenceIds: [],
  requiresContext: true,
  integrityStatus: 'context-required',
  integrityReasons: [],
  producer: evidenceProducerExample,
  integrityPolicyVersion: 'evidence-integrity/v1',
  physicalMaterialized: false,
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  evidenceHash: '3'.repeat(64),
}
const longFormProducerExample = {
  provider: 'apollo',
  model: 'long-form-indexer',
  version: '1.0.0',
  confidence: 0.96,
}
const longFormObservation = (
  value: string,
  normalizedValue: string,
  confidence = 0.96,
) => ({
  value,
  normalizedValue,
  provenance: {
    source: 'long-form-analysis',
    provider: longFormProducerExample.provider,
    model: longFormProducerExample.model,
    version: longFormProducerExample.version,
    confidence,
    observedAt: createdAt,
  },
})
const longFormChapterTrafficId = 'long-form-chapter-example-traffic'
const longFormChapterOfferId = 'long-form-chapter-example-offer'
const longFormMomentTrafficId = 'long-form-moment-example-traffic'
const longFormMomentOfferId = 'long-form-moment-example-offer'
const longFormChapterTrafficExample = {
  schemaVersion: 'long-form-chapter/v1',
  id: longFormChapterTrafficId,
  workspaceId,
  projectId,
  indexRunId: 'long-form-index-run-example-1',
  sourceArtifactId: 'artifact-long-form-example-1',
  sourceChapterId: 'source-chapter-traffic',
  title: longFormObservation('Tráfego pago', 'trafego pago'),
  topicPath: ['Marketing', 'Tráfego pago'],
  rangeMs: [0, 3_600_000],
  momentIds: [longFormMomentTrafficId],
  physicalMaterialized: false,
  indexPolicyVersion: 'long-form-index/v1',
  createdAt,
  chapterHash: '4'.repeat(64),
}
const longFormChapterOfferExample = {
  schemaVersion: 'long-form-chapter/v1',
  id: longFormChapterOfferId,
  workspaceId,
  projectId,
  indexRunId: 'long-form-index-run-example-1',
  sourceArtifactId: 'artifact-long-form-example-1',
  sourceChapterId: 'source-chapter-offer',
  title: longFormObservation('Construção da oferta', 'construcao da oferta'),
  topicPath: ['Marketing', 'Oferta'],
  rangeMs: [3_600_000, 7_200_000],
  momentIds: [longFormMomentOfferId],
  physicalMaterialized: false,
  indexPolicyVersion: 'long-form-index/v1',
  createdAt,
  chapterHash: '5'.repeat(64),
}
const longFormMomentTrafficExample = {
  schemaVersion: 'long-form-moment/v1',
  id: longFormMomentTrafficId,
  workspaceId,
  projectId,
  indexRunId: 'long-form-index-run-example-1',
  chapterId: longFormChapterTrafficId,
  sourceArtifactId: 'artifact-long-form-example-1',
  sourceMomentId: 'source-moment-traffic-analysis',
  topic: longFormObservation('Análise de campanhas', 'analise de campanhas'),
  summary: longFormObservation(
    'Como identificar uma campanha que precisa de ajuste.',
    'como identificar uma campanha que precisa de ajuste',
  ),
  keyQuote: longFormObservation(
    'O contexto muda a leitura da métrica.',
    'o contexto muda a leitura da metrica',
  ),
  speakerIds: ['person-specialist'],
  rangesMs: [[100_000, 130_000]],
  recommendedRangeIndex: 0,
  recommendedRangeMs: [100_000, 130_000],
  evidenceSpanIds: ['speech-segment-example-1'],
  salience: 0.82,
  hookPotential: 0.71,
  standaloneScore: 0.84,
  contextScore: 0.89,
  insightDensity: 0.8,
  roles: ['education'],
  tags: ['campaign-analysis'],
  physicalMaterialized: false,
  indexPolicyVersion: 'long-form-index/v1',
  createdAt,
  momentHash: '6'.repeat(64),
}
const longFormMomentOfferExample = {
  schemaVersion: 'long-form-moment/v1',
  id: longFormMomentOfferId,
  workspaceId,
  projectId,
  indexRunId: 'long-form-index-run-example-1',
  chapterId: longFormChapterOfferId,
  sourceArtifactId: 'artifact-long-form-example-1',
  sourceMomentId: 'source-moment-offer-construction',
  topic: longFormObservation('Oferta', 'oferta'),
  summary: longFormObservation(
    'Construção da oferta a partir do problema central.',
    'construcao da oferta a partir do problema central',
  ),
  keyQuote: longFormObservation(
    'A oferta organiza a transformação.',
    'a oferta organiza a transformacao',
  ),
  speakerIds: ['person-specialist', 'person-host'],
  rangesMs: [[4_000_000, 4_030_000]],
  recommendedRangeIndex: 0,
  recommendedRangeMs: [4_000_000, 4_030_000],
  evidenceSpanIds: ['speech-segment-example-2'],
  salience: 0.93,
  hookPotential: 0.88,
  standaloneScore: 0.91,
  contextScore: 0.86,
  insightDensity: 0.9,
  roles: ['education', 'story'],
  tags: ['offer'],
  physicalMaterialized: false,
  indexPolicyVersion: 'long-form-index/v1',
  createdAt,
  momentHash: '7'.repeat(64),
}
const longFormIndexRunExample = {
  schemaVersion: 'long-form-index-run/v1',
  id: 'long-form-index-run-example-1',
  workspaceId,
  projectId,
  sourceArtifactId: 'artifact-long-form-example-1',
  sourceArtifactSha256: '8'.repeat(64),
  sourceManifestId: 'manifest-long-form-example-1',
  sourceManifestHash: '9'.repeat(64),
  durationMs: 7_200_000,
  rightsSnapshotId: 'rights-snapshot-example-1',
  rightsStatus: 'approved',
  consentStatus: 'not-required',
  indexPolicyVersion: 'long-form-index/v1',
  producer: longFormProducerExample,
  chapters: [
    longFormChapterTrafficExample,
    longFormChapterOfferExample,
  ],
  moments: [longFormMomentTrafficExample, longFormMomentOfferExample],
  chapterCount: 2,
  momentCount: 2,
  hierarchyHash: 'a'.repeat(64),
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  recordHash: 'b'.repeat(64),
  active: true,
}
const validatedSegmentExample = {
  schemaVersion: 'validated-segment/v1',
  id: 'validated-segment-example-1',
  workspaceId,
  projectId,
  sourceArtifactId: 'artifact-validated-example-1',
  sourceArtifactSha256: 'c'.repeat(64),
  sourceManifestId: 'manifest-validated-example-1',
  sourceManifestHash: 'd'.repeat(64),
  sourceSpeechSegmentId: 'speech-segment-validated-example-1',
  sourceSpeechSegmentHash: 'e'.repeat(64),
  scope: {
    unit: 'hook',
    evidenceScope: 'opening-edit',
  },
  wholeVideoValidated: false,
  source: {
    platform: 'instagram',
    publicationRef: 'reel-example-validated-1',
    accountRef: '@especialista',
    url: 'https://www.instagram.com/reel/example-validated-1/',
    observedAt: '2026-07-01T12:00:00.000Z',
  },
  performance: {
    metric: 'three-second-hold-rate',
    value: 0.81,
    unit: 'ratio',
    sampleSize: 25000,
    period: {
      start: '2026-07-01T12:00:00.000Z',
      end: '2026-07-08T12:00:00.000Z',
    },
    comparison: {
      label: 'Median of the previous ten publications',
      value: 0.56,
      unit: 'ratio',
    },
  },
  protectedEnvelope: {
    schemaVersion: 'protected-validation-envelope/v1',
    sourceArtifactId: 'artifact-validated-example-1',
    sourceArtifactSha256: 'c'.repeat(64),
    sourceRangeMs: [1000, 8000],
    sourceSpeechSegmentId: 'speech-segment-validated-example-1',
    sourceSpeechSegmentHash: 'e'.repeat(64),
    exactCopy: 'Este hook foi observado no material publicado.',
    speakerId: 'person-specialist',
    protectedAspects: ['copy', 'take', 'timing', 'opening'],
    copyProtected: true,
    takeProtected: true,
    timingProtected: true,
    openingProtected: true,
    envelopeHash: 'f'.repeat(64),
  },
  rightsSnapshotId,
  rightsStatus: 'approved',
  consentStatus: 'not-required',
  validatedAt: '2026-07-10T12:00:00.000Z',
  expiresAt: '2027-01-10T12:00:00.000Z',
  claimPolicyVersion: 'historical-association/v1',
  causalClaimAllowed: false,
  policyVersion: 'validated-segment/v1',
  physicalMaterialized: false,
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  validatedSegmentHash: '1'.repeat(64),
}
const validatedSegmentReuseDecisionExample = {
  schemaVersion: 'validated-segment-reuse-decision/v1',
  validatedSegmentId: validatedSegmentExample.id,
  targetRecipe: {
    id: 'recipe-new-ad-example-1',
    role: 'hook',
    objective: 'lead-generation',
    format: '9:16',
    locale: 'pt-BR',
  },
  requestedChanges: [],
  claim: 'historical-association',
  compatible: true,
  reasons: [],
  protectedAspects:
    validatedSegmentExample.protectedEnvelope.protectedAspects,
  wholeVideoValidated: false,
  causalClaimAllowed: false,
  performanceInterpretation: 'historical-association',
  evaluatedAt: createdAt,
}
const semanticSearchDocumentExample = {
  schemaVersion: 'semantic-search-document/v1',
  id: 'semantic-document-example-1',
  workspaceId,
  projectId,
  source: {
    type: 'artifact',
    id: 'artifact-search-example-1',
    hash: '2'.repeat(64),
    artifactId: 'artifact-search-example-1',
    artifactSha256: '2'.repeat(64),
  },
  identityKey: 'artifact:artifact-search-example-1',
  kind: 'image',
  durationMs: 0,
  locale: 'pt-BR',
  personIds: ['person-specialist'],
  transcriptText: '',
  ocrText: 'Custo por lead caiu 31 por cento',
  intentions: ['proof', 'lead-generation'],
  description: 'Captura de tela com resultado comprovado da campanha.',
  metadata: {
    atmosphere: 'confiante',
    campaign: 'captacao',
  },
  producer: {
    provider: 'apollo',
    model: 'media-observer',
    version: '1.0.0',
    confidence: 0.96,
  },
  embedding: {
    state: 'ready',
    provider: 'openai',
    model: 'text-embedding-3-small',
    version: '2024-01-25',
    dimensions: 256,
    degraded: false,
    inputHash: '3'.repeat(64),
    vectorHash: '4'.repeat(64),
  },
  rightsSnapshotId,
  rightsStatus: 'approved',
  consentStatus: 'not-required',
  indexVersion: 'semantic-search-index/v1',
  active: true,
  physicalMaterialized: false,
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  documentHash: '5'.repeat(64),
}
const hybridSearchQueryExample = {
  scope: 'workspace',
  text: 'custo por lead',
  intention: 'proof',
  atmosphere: 'confiante',
  personIds: ['person-specialist'],
  speech: 'custo por lead caiu',
  visual: 'dashboard com gráfico positivo',
  rightsUse: 'social-ad',
  filters: {
    kinds: ['image'],
    personIds: ['person-specialist'],
    maxDurationMs: 5000,
    locale: 'pt-BR',
    metadata: { campaign: 'captacao' },
    rights: 'approved',
  },
  includeBlocked: false,
  limit: 20,
  explain: true,
}
const retrievalMetricsExample = {
  precisionAtK: 1,
  recallAtK: 1,
  ndcgAtK: 1,
  reciprocalRank: 1,
  hitsAtK: 1,
  relevantCount: 1,
  returnedCount: 1,
  k: 5,
}
const retrievalEvaluationExample = {
  schemaVersion: 'retrieval-evaluation/v1',
  id: 'retrieval-evaluation-example-1',
  workspaceId,
  projectId,
  policyVersion: 'retrieval-eval/v1',
  rerankPolicyVersion: 'hybrid-rerank/v1',
  k: 5,
  cases: [{
    id: 'case-proof-image',
    queryHash: '6'.repeat(64),
    relevantIdentityKeys: [
      semanticSearchDocumentExample.identityKey,
    ],
    rankedIdentityKeys: [
      semanticSearchDocumentExample.identityKey,
    ],
    metrics: retrievalMetricsExample,
    semanticState: 'ready',
  }],
  aggregate: retrievalMetricsExample,
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  reportHash: '7'.repeat(64),
}
const retrievalScaleEvaluationExample = {
  schemaVersion: 'retrieval-scale-evaluation/v1',
  id: 'retrieval-scale-evaluation-example-1',
  workspaceId,
  projectId,
  policyVersion: 'retrieval-scale-eval/v1',
  rerankPolicyVersion: 'hybrid-rerank/v1',
  scope: 'workspace',
  librarySize: 1_000,
  k: 5,
  cases: ['intention', 'speech', 'visual'].map((channel, index) => ({
    id: `scale-${channel}`,
    queryHash: String(index + 1).repeat(64),
    relevantIdentityKeys: [
      semanticSearchDocumentExample.identityKey,
    ],
    rankedIdentityKeys: [
      semanticSearchDocumentExample.identityKey,
    ],
    metrics: retrievalMetricsExample,
    semanticState: 'ready',
    latencyMs: 40 + index * 10,
  })),
  aggregateQuality: retrievalMetricsExample,
  aggregateLatency: {
    sampleCount: 3,
    minMs: 40,
    p50Ms: 50,
    p95Ms: 60,
    maxMs: 60,
    meanMs: 50,
  },
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  reportHash: 'b'.repeat(64),
}
const semanticReuseRunExample = {
  schemaVersion: 'semantic-reuse-run/v1',
  id: 'semantic-reuse-run-example-1',
  workspaceId,
  projectId,
  queryHash: '8'.repeat(64),
  resultSetHash: 'a'.repeat(64),
  query: hybridSearchQueryExample,
  semantic: {
    state: 'ready',
    provider: 'openai',
    model: 'text-embedding-3-small',
    version: '2024-01-25',
    dimensions: 256,
    degraded: false,
  },
  rerankPolicyVersion: 'hybrid-rerank/v1',
  candidateAudit: [
    {
      documentId: semanticSearchDocumentExample.id,
      identityKey: semanticSearchDocumentExample.identityKey,
      rank: 1,
      score: 0.97,
      disposition: 'returned',
      rejectionReasons: [],
    },
    {
      documentId: 'semantic-document-rights-blocked',
      identityKey: 'artifact:artifact-rights-blocked',
      disposition: 'rejected',
      rejectionReasons: ['RIGHTS_RESTRICTED'],
    },
  ],
  returnedIdentityKeys: [
    semanticSearchDocumentExample.identityKey,
  ],
  reusedIdentityKeys: [
    semanticSearchDocumentExample.identityKey,
  ],
  directorRejections: [],
  candidateCount: 2,
  returnedCount: 1,
  reusedCount: 1,
  searchEvaluatedAt: createdAt,
  searchLatencyMs: 42,
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  runHash: '9'.repeat(64),
}
const hierarchicalTierVersionsExample = {
  'cheap-signals': {
    provider: 'apollo',
    model: 'transcript-statistics',
    version: '1.0.0',
  },
  vision: {
    provider: 'apollo',
    model: 'cataloged-visual-observations',
    version: '1.0.0',
  },
  language: {
    provider: 'apollo',
    model: 'transcript-segmentation',
    version: '1.0.0',
  },
  aggregation: {
    provider: 'apollo',
    model: 'evidence-preserving-aggregation',
    version: '1.0.0',
  },
}
const hierarchicalProcessingRequestExample = {
  sourceArtifactId: 'artifact-long-form-example-1',
  expectedArtifactSha256: '8'.repeat(64),
  sourceManifestId: 'manifest-long-form-example-1',
  expectedManifestHash: '9'.repeat(64),
  sourceTranscriptId: 'transcript-long-form-example-1',
  expectedTranscriptHash: 'a'.repeat(64),
  processingPolicyVersion: 'hierarchical-processing/v1',
  chunking: {
    policyVersion: 'overlapping-time-chunks/v1',
    chunkDurationMs: 300000,
    overlapMs: 15000,
  },
  tierVersions: hierarchicalTierVersionsExample,
  budget: {
    currency: 'USD',
    maxCostMinorUnits: 1000,
    maxWorkingSetBytes: 268435456,
    maxElapsedMs: 1800000,
  },
}
const hierarchicalChunksExample = [
  {
    id: 'hierarchical-chunk-example-1',
    artifactId: 'artifact-long-form-example-1',
    sequence: 0,
    coreRangeMs: [0, 300000],
    sourceRangeMs: [0, 315000],
    overlapBeforeMs: 0,
    overlapAfterMs: 15000,
    evidenceSpanIds: ['evidence-span-example-1'],
    wordCount: 8,
    segmentCount: 1,
    speechMs: 20000,
    chunkHash: 'b'.repeat(64),
  },
  {
    id: 'hierarchical-chunk-example-2',
    artifactId: 'artifact-long-form-example-1',
    sequence: 1,
    coreRangeMs: [300000, 600000],
    sourceRangeMs: [285000, 600000],
    overlapBeforeMs: 15000,
    overlapAfterMs: 0,
    evidenceSpanIds: ['evidence-span-example-2'],
    wordCount: 7,
    segmentCount: 1,
    speechMs: 18000,
    chunkHash: 'c'.repeat(64),
  },
]
const hierarchicalEvidenceSpansExample = [
  {
    id: 'evidence-span-example-1',
    sourceSegmentId: 1,
    rangeMs: [10000, 30000],
    textHash: 'd'.repeat(64),
    wordCount: 8,
    chunkIds: ['hierarchical-chunk-example-1'],
    spanHash: 'e'.repeat(64),
  },
  {
    id: 'evidence-span-example-2',
    sourceSegmentId: 2,
    rangeMs: [310000, 328000],
    textHash: 'f'.repeat(64),
    wordCount: 7,
    chunkIds: ['hierarchical-chunk-example-2'],
    spanHash: '0'.repeat(64),
  },
]
const hierarchicalProcessingRunExample = {
  schemaVersion: 'hierarchical-processing-run/v1',
  id: 'hierarchical-processing-run-example-1',
  workspaceId,
  projectId,
  sourceArtifactId: hierarchicalProcessingRequestExample.sourceArtifactId,
  sourceArtifactSha256:
    hierarchicalProcessingRequestExample.expectedArtifactSha256,
  sourceManifestId: hierarchicalProcessingRequestExample.sourceManifestId,
  sourceManifestHash:
    hierarchicalProcessingRequestExample.expectedManifestHash,
  sourceTranscriptId:
    hierarchicalProcessingRequestExample.sourceTranscriptId,
  sourceTranscriptHash:
    hierarchicalProcessingRequestExample.expectedTranscriptHash,
  durationMs: 600000,
  rightsSnapshotId,
  rightsStatus: 'approved',
  consentStatus: 'not-required',
  processingPolicyVersion: 'hierarchical-processing/v1',
  chunkPolicyVersion: 'overlapping-time-chunks/v1',
  chunkDurationMs: 300000,
  overlapMs: 15000,
  tierVersions: hierarchicalTierVersionsExample,
  plan: {
    tiers: [
      {
        tier: 'cheap-signals',
        sequence: 0,
        version: hierarchicalTierVersionsExample['cheap-signals'],
        prerequisites: [],
        status: 'process',
      },
      {
        tier: 'vision',
        sequence: 1,
        version: hierarchicalTierVersionsExample.vision,
        prerequisites: ['cheap-signals'],
        status: 'process',
      },
      {
        tier: 'language',
        sequence: 2,
        version: hierarchicalTierVersionsExample.language,
        prerequisites: ['cheap-signals'],
        status: 'process',
      },
      {
        tier: 'aggregation',
        sequence: 3,
        version: hierarchicalTierVersionsExample.aggregation,
        prerequisites: ['vision', 'language'],
        status: 'process',
      },
    ],
    executionOrder: [
      'cheap-signals',
      'vision',
      'language',
      'aggregation',
    ],
    invalidatedTiers: [
      'cheap-signals',
      'vision',
      'language',
      'aggregation',
    ],
    cheapSignalsFirst: true,
    planHash: '1'.repeat(64),
  },
  chunks: hierarchicalChunksExample,
  evidenceSpans: hierarchicalEvidenceSpansExample,
  visionObservations: hierarchicalChunksExample.map((chunk, index) => ({
    chunkId: chunk.id,
    sourceRangeMs: chunk.sourceRangeMs,
    width: 1920,
    height: 1080,
    fps: 30,
    sampleCount: 32,
    catalogedObservationCount: 2,
    observationHash: String(index + 2).repeat(64),
  })),
  languageCandidates: [
    {
      id: 'hierarchical-candidate-example-1',
      chunkId: hierarchicalChunksExample[0].id,
      topic: 'aquisicao e oferta',
      summary: 'Reflexao completa sobre aquisicao e oferta.',
      rangeMs: [10000, 30000],
      evidenceSpanIds: ['evidence-span-example-1'],
      salience: 0.82,
      candidateHash: '4'.repeat(64),
    },
    {
      id: 'hierarchical-candidate-example-2',
      chunkId: hierarchicalChunksExample[1].id,
      topic: 'prova e conversao',
      summary: 'Reflexao completa sobre prova e conversao.',
      rangeMs: [310000, 328000],
      evidenceSpanIds: ['evidence-span-example-2'],
      salience: 0.78,
      candidateHash: '5'.repeat(64),
    },
  ],
  aggregation: {
    chapters: [{
      id: 'hierarchical-chapter-example-1',
      ordinal: 0,
      title: 'aquisicao e oferta',
      rangeMs: [10000, 328000],
      momentIds: [
        'hierarchical-moment-example-1',
        'hierarchical-moment-example-2',
      ],
      evidenceSpanIds: [
        'evidence-span-example-1',
        'evidence-span-example-2',
      ],
      chapterHash: '6'.repeat(64),
    }],
    moments: [
      {
        id: 'hierarchical-moment-example-1',
        sourceChunkId: hierarchicalChunksExample[0].id,
        chapterId: 'hierarchical-chapter-example-1',
        ordinal: 0,
        topic: 'aquisicao e oferta',
        summary: 'Reflexao completa sobre aquisicao e oferta.',
        rangesMs: [[10000, 30000]],
        evidenceSpanIds: ['evidence-span-example-1'],
        salience: 0.82,
        momentHash: '7'.repeat(64),
      },
      {
        id: 'hierarchical-moment-example-2',
        sourceChunkId: hierarchicalChunksExample[1].id,
        chapterId: 'hierarchical-chapter-example-1',
        ordinal: 1,
        topic: 'prova e conversao',
        summary: 'Reflexao completa sobre prova e conversao.',
        rangesMs: [[310000, 328000]],
        evidenceSpanIds: ['evidence-span-example-2'],
        salience: 0.78,
        momentHash: '8'.repeat(64),
      },
    ],
    evidencePreserved: true,
    aggregationHash: '9'.repeat(64),
  },
  tierExecutions: [
    {
      tier: 'cheap-signals',
      sequence: 0,
      version: hierarchicalTierVersionsExample['cheap-signals'],
      prerequisites: [],
      status: 'processed',
      startedAt: createdAt,
      completedAt: createdAt,
      elapsedMs: 5,
      workingSetBytes: 4096,
      costMinorUnits: 0,
      outputHash: 'a'.repeat(64),
    },
    {
      tier: 'vision',
      sequence: 1,
      version: hierarchicalTierVersionsExample.vision,
      prerequisites: ['cheap-signals'],
      status: 'processed',
      startedAt: createdAt,
      completedAt: createdAt,
      elapsedMs: 5,
      workingSetBytes: 4096,
      costMinorUnits: 4,
      outputHash: 'b'.repeat(64),
    },
    {
      tier: 'language',
      sequence: 2,
      version: hierarchicalTierVersionsExample.language,
      prerequisites: ['cheap-signals'],
      status: 'processed',
      startedAt: createdAt,
      completedAt: createdAt,
      elapsedMs: 5,
      workingSetBytes: 4096,
      costMinorUnits: 4,
      outputHash: 'c'.repeat(64),
    },
    {
      tier: 'aggregation',
      sequence: 3,
      version: hierarchicalTierVersionsExample.aggregation,
      prerequisites: ['vision', 'language'],
      status: 'processed',
      startedAt: createdAt,
      completedAt: createdAt,
      elapsedMs: 5,
      workingSetBytes: 4096,
      costMinorUnits: 4,
      outputHash: 'd'.repeat(64),
    },
  ],
  budget: hierarchicalProcessingRequestExample.budget,
  measurement: {
    schemaVersion: 'hierarchical-processing-measurement/v1',
    durationMs: 600000,
    chunkCount: 2,
    evidenceSpanCount: 2,
    processedTierCount: 4,
    reusedTierCount: 0,
    workingSetBytes: 16384,
    cost: {
      policyVersion: 'hierarchical-cost-policy/v1',
      currency: 'USD',
      minorUnits: 12,
    },
    elapsedMs: 20,
    bounded: true,
    measurementHash: 'e'.repeat(64),
  },
  physicalMaterialized: false,
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  runHash: 'f'.repeat(64),
  active: true,
}
const sourceDeconstructionRequestExample = {
  sourceArtifactId: 'artifact-published-reel-example-1',
  expectedArtifactSha256: '1'.repeat(64),
  sourceTranscriptId: 'transcript-published-reel-example-1',
  expectedTranscriptHash: '2'.repeat(64),
  desiredRole: 'hook',
  validationScope: 'full',
  targetComposition: {
    objective: 'content-distribution',
    outputSpecId: '9:16',
    targetDurationMs: 15_000,
  },
  boundaryPolicy: {
    preRollMs: 120,
    postRollMs: 160,
    maxJoinGapMs: 250,
    maxContextGapMs: 500,
    minCompleteThoughtScore: 0.7,
  },
}
const sourceDeconstructionSegmentsExample = [
  {
    id: 'source-analysis-segment-opening',
    sourceSpeechSegmentId: 'speech-segment-opening',
    sourceSegmentId: 0,
    exactText: 'Antes de começar, deixa eu me apresentar.',
    normalizedText: 'antes de comecar deixa eu me apresentar',
    rangeMs: [0, 900],
    role: 'opening',
    roleConfidence: 0.94,
    roleReasonCodes: ['catalog-intention'],
    essential: false,
    included: false,
    includedForContext: false,
    completeThoughtScore: 0.95,
    classification: 'complete-thought',
    segmentHash: '3'.repeat(64),
    analysisHash: '4'.repeat(64),
  },
  {
    id: 'source-analysis-segment-hook',
    sourceSpeechSegmentId: 'speech-segment-hook',
    sourceSegmentId: 1,
    exactText: 'Se o seu anúncio não prende atenção, ninguém ouve a oferta.',
    normalizedText: 'se o seu anuncio nao prende atencao ninguem ouve a oferta',
    rangeMs: [900, 2300],
    role: 'hook',
    roleConfidence: 0.97,
    roleReasonCodes: ['catalog-intention'],
    essential: true,
    included: true,
    includedForContext: false,
    completeThoughtScore: 0.98,
    classification: 'complete-thought',
    segmentHash: '5'.repeat(64),
    analysisHash: '6'.repeat(64),
  },
  {
    id: 'source-analysis-segment-body',
    sourceSpeechSegmentId: 'speech-segment-body',
    sourceSegmentId: 2,
    exactText: 'No restante deste vídeo eu explico três formas de estruturar a mensagem.',
    normalizedText: 'no restante deste video eu explico tres formas de estruturar a mensagem',
    rangeMs: [2300, 4000],
    role: 'body',
    roleConfidence: 0.93,
    roleReasonCodes: ['catalog-intention'],
    essential: false,
    included: false,
    includedForContext: false,
    completeThoughtScore: 0.96,
    classification: 'complete-thought',
    segmentHash: '7'.repeat(64),
    analysisHash: '8'.repeat(64),
  },
  {
    id: 'source-analysis-segment-cta',
    sourceSpeechSegmentId: 'speech-segment-cta',
    sourceSegmentId: 3,
    exactText: 'Clique no link e entre para a aula.',
    normalizedText: 'clique no link e entre para a aula',
    rangeMs: [4000, 5100],
    role: 'cta',
    roleConfidence: 0.96,
    roleReasonCodes: ['catalog-intention'],
    essential: false,
    included: false,
    includedForContext: false,
    completeThoughtScore: 0.98,
    classification: 'complete-thought',
    segmentHash: '9'.repeat(64),
    analysisHash: 'a'.repeat(64),
  },
  {
    id: 'source-analysis-segment-tail',
    sourceSpeechSegmentId: 'speech-segment-tail',
    sourceSegmentId: 4,
    exactText: 'Nos vemos lá, um abraço.',
    normalizedText: 'nos vemos la um abraco',
    rangeMs: [5100, 6200],
    role: 'tail',
    roleConfidence: 0.91,
    roleReasonCodes: ['lexical-tail'],
    essential: false,
    included: false,
    includedForContext: false,
    completeThoughtScore: 0.95,
    classification: 'complete-thought',
    segmentHash: 'b'.repeat(64),
    analysisHash: 'c'.repeat(64),
  },
]
const sourceDeconstructionComparisonExample = {
  reportId: 'source-deconstruction-report-example-1',
  sourceArtifactId: sourceDeconstructionRequestExample.sourceArtifactId,
  desiredRole: 'hook',
  validationScope: 'full',
  decision: 'automatic',
  confidence: 0.91,
  editabilityScore: 92,
  contextPreserved: true,
  sourceRangeMs: [0, 6200],
  cleanRangesMs: [[780, 2460]],
  removedRangesMs: [[0, 780], [2460, 6200]],
  sourceDurationMs: 6200,
  cleanDurationMs: 1680,
  removedDurationMs: 4520,
  retainedRatio: 0.271,
  sourceSegmentCount: 5,
  includedSegmentCount: 1,
  excludedSegmentCount: 4,
  sourceTranscript: sourceDeconstructionSegmentsExample
    .map((segment) => segment.exactText)
    .join(' '),
  cleanTranscript: sourceDeconstructionSegmentsExample[1].exactText,
  mappings: sourceDeconstructionSegmentsExample.map((segment, index) => ({
    sourceSpeechSegmentId: segment.sourceSpeechSegmentId,
    sourceRangeMs: segment.rangeMs,
    ...(index === 1
      ? { cleanRangeId: 'source-clean-range-example-1' }
      : {}),
    role: segment.role,
    included: index === 1,
  })),
  comparisonHash: 'd'.repeat(64),
}
const sourceDeconstructionReportExample = {
  schemaVersion: 'source-deconstruction-report/v1',
  id: sourceDeconstructionComparisonExample.reportId,
  workspaceId,
  projectId,
  sourceArtifactId: sourceDeconstructionRequestExample.sourceArtifactId,
  sourceArtifactSha256:
    sourceDeconstructionRequestExample.expectedArtifactSha256,
  sourceTranscriptId:
    sourceDeconstructionRequestExample.sourceTranscriptId,
  sourceTranscriptHash:
    sourceDeconstructionRequestExample.expectedTranscriptHash,
  sourceDurationMs: 6200,
  desiredRole: 'hook',
  validationScope: 'full',
  targetComposition:
    sourceDeconstructionRequestExample.targetComposition,
  boundaryPolicy: sourceDeconstructionRequestExample.boundaryPolicy,
  analyzer: {
    policyVersion: 'source-deconstruction/v1',
    version: 'semantic-source-deconstructor/v1',
    evidenceSource: 'cataloged-speech',
  },
  segments: sourceDeconstructionSegmentsExample,
  hookEnvelope: {
    rangeMs: [780, 2460],
    sourceSpeechSegmentIds: ['speech-segment-hook'],
    confidence: 0.97,
  },
  bodyRanges: [[2300, 4000]],
  ctaRanges: [[4000, 5100]],
  cleanCandidateRanges: [{
    id: 'source-clean-range-example-1',
    sequence: 0,
    rangeMs: [780, 2460],
    speechRangeMs: [900, 2300],
    sourceSpeechSegmentIds: ['speech-segment-hook'],
    roles: ['hook'],
    exactText: sourceDeconstructionSegmentsExample[1].exactText,
    confidence: 0.97,
    contextPreserved: true,
    boundaryReasonCodes: [
      'speech-boundary',
      'complete-thought',
      'handles-applied',
    ],
    rangeHash: 'e'.repeat(64),
  }],
  semanticContaminants: [
    {
      id: 'source-contaminant-opening',
      kind: 'prior-opening',
      sourceSpeechSegmentId: 'speech-segment-opening',
      rangeMs: [0, 900],
      exactText: sourceDeconstructionSegmentsExample[0].exactText,
      confidence: 0.94,
      overlapsEssential: false,
      removableWithoutContextLoss: true,
      contaminantHash: 'f'.repeat(64),
    },
    {
      id: 'source-contaminant-body',
      kind: 'non-target-body',
      sourceSpeechSegmentId: 'speech-segment-body',
      rangeMs: [2300, 4000],
      exactText: sourceDeconstructionSegmentsExample[2].exactText,
      confidence: 0.93,
      overlapsEssential: false,
      removableWithoutContextLoss: true,
      contaminantHash: '0'.repeat(64),
    },
    {
      id: 'source-contaminant-cta',
      kind: 'prior-cta',
      sourceSpeechSegmentId: 'speech-segment-cta',
      rangeMs: [4000, 5100],
      exactText: sourceDeconstructionSegmentsExample[3].exactText,
      confidence: 0.96,
      overlapsEssential: false,
      removableWithoutContextLoss: true,
      contaminantHash: '1'.repeat(64),
    },
    {
      id: 'source-contaminant-tail',
      kind: 'removable-tail',
      sourceSpeechSegmentId: 'speech-segment-tail',
      rangeMs: [5100, 6200],
      exactText: sourceDeconstructionSegmentsExample[4].exactText,
      confidence: 0.91,
      overlapsEssential: false,
      removableWithoutContextLoss: true,
      contaminantHash: '2'.repeat(64),
    },
  ],
  comparison: sourceDeconstructionComparisonExample,
  confidence: 0.91,
  editabilityScore: 92,
  decision: 'automatic',
  contextPreserved: true,
  decisionReasonCodes: [
    'clean-range-found',
    'complete-thought-preserved',
    'semantic-contaminants-removable',
  ],
  createdByClientId: clientId,
  createdAt,
  reportHash: '3'.repeat(64),
}
const contaminationDetectorExample = {
  provider: 'apollo',
  model: 'contamination-diagnostics',
  version: '1.0.0',
}
const contaminationPolicyExample = {
  minObservationConfidence: 0.5,
  minAutomaticConfidence: 0.85,
  protectedIntersectionReviewRatio: 0.1,
  protectedIntersectionDestructiveRatio: 0.35,
  lowConfidenceRequiresReview: true,
}
const contaminationObservationsExample = [
  {
    id: 'contamination-observation-caption-example',
    kind: 'burned-caption',
    rangeMs: [900, 2300],
    region: { x: 0.1, y: 0.8, width: 0.8, height: 0.12 },
    confidence: 0.98,
    detector: contaminationDetectorExample,
    signals: {
      text: 'Se o seu anúncio não prende atenção',
      textTrackMatch: 0.99,
      frameCoverage: 0.96,
      foregroundContrast: 0.92,
    },
  },
  {
    id: 'contamination-observation-music-example',
    kind: 'music',
    rangeMs: [900, 4000],
    region: null,
    confidence: 0.96,
    detector: contaminationDetectorExample,
    signals: {
      musicLikelihood: 0.98,
      speechLikelihood: 0.91,
      separableStem: false,
      spectralPersistence: 0.94,
    },
  },
]
const contaminationProtectedRegionsExample = [
  {
    id: 'contamination-protected-face-example',
    kind: 'face',
    rangeMs: [0, 6200],
    region: { x: 0.26, y: 0.13, width: 0.48, height: 0.53 },
    confidence: 0.99,
    source: 'face-detector/v1',
  },
]
const contaminationRequestExample = {
  sourceDeconstructionReportId:
    sourceDeconstructionReportExample.id,
  expectedSourceDeconstructionReportHash:
    sourceDeconstructionReportExample.reportHash,
  analyzer: contaminationDetectorExample,
  policy: contaminationPolicyExample,
  observations: contaminationObservationsExample,
  protectedRegions: contaminationProtectedRegionsExample,
}
const contaminationFindingsExample = [
  {
    id: 'contamination-finding-caption-example',
    observationId: contaminationObservationsExample[0].id,
    kind: 'burned-caption',
    rangeMs: [900, 2300],
    region: contaminationObservationsExample[0].region,
    confidence: 0.98,
    detector: contaminationDetectorExample,
    signals: contaminationObservationsExample[0].signals,
    overlapsEssentialTime: true,
    essentialOverlapRatio: 1,
    protectedRegionIds: [
      contaminationProtectedRegionsExample[0].id,
    ],
    protectedRegionIntersectionRatio: 0.4,
    removalImpact: 'destructive',
    removalWouldDestroyEssential: true,
    requiresHumanReview: true,
    reasonCodes: [
      'overlaps-clean-candidate',
      'protected-region-destructive-overlap',
    ],
    observationHash: '4'.repeat(64),
    findingHash: '5'.repeat(64),
  },
  {
    id: 'contamination-finding-music-example',
    observationId: contaminationObservationsExample[1].id,
    kind: 'music',
    rangeMs: [900, 4000],
    region: null,
    confidence: 0.96,
    detector: contaminationDetectorExample,
    signals: contaminationObservationsExample[1].signals,
    overlapsEssentialTime: true,
    essentialOverlapRatio: 0.4516,
    protectedRegionIds: [],
    protectedRegionIntersectionRatio: 0,
    removalImpact: 'destructive',
    removalWouldDestroyEssential: true,
    requiresHumanReview: true,
    reasonCodes: [
      'overlaps-clean-candidate',
      'mixed-with-essential-speech',
      'no-separable-stem',
    ],
    observationHash: '6'.repeat(64),
    findingHash: '7'.repeat(64),
  },
]
const contaminationDirectorDiagnosticsExample =
  contaminationFindingsExample.map((finding) => ({
    findingId: finding.id,
    code: finding.kind,
    severity: 'blocking',
    rangeMs: finding.rangeMs,
    region: finding.region,
    confidence: finding.confidence,
    removalDecision: 'blocked',
    reasonCodes: finding.reasonCodes,
    message:
      `${finding.kind} não pode ser removido sem afetar conteúdo essencial.`,
  }))
const contaminationHumanDiagnosticsExample =
  contaminationFindingsExample.map((finding) => ({
    findingId: finding.id,
    reviewRequired: true,
    rangeMs: finding.rangeMs,
    region: finding.region,
    compareSource: true,
    question:
      `A remoção de ${finding.kind} destruiria conteúdo essencial?`,
    reasonCodes: finding.reasonCodes,
  }))
const contaminationDiagnosticsExample = {
  reportId: 'contamination-report-example-1',
  sourceArtifactId: sourceDeconstructionReportExample.sourceArtifactId,
  decision: 'manual-preservation-required',
  humanReviewRequired: true,
  confidence: 0.97,
  director: contaminationDirectorDiagnosticsExample,
  humanReview: contaminationHumanDiagnosticsExample,
}
const contaminationReportExample = {
  schemaVersion: 'contamination-report/v1',
  id: contaminationDiagnosticsExample.reportId,
  workspaceId,
  projectId,
  sourceDeconstructionReportId:
    sourceDeconstructionReportExample.id,
  sourceDeconstructionReportHash:
    sourceDeconstructionReportExample.reportHash,
  sourceArtifactId: sourceDeconstructionReportExample.sourceArtifactId,
  sourceArtifactSha256:
    sourceDeconstructionReportExample.sourceArtifactSha256,
  sourceDurationMs: sourceDeconstructionReportExample.sourceDurationMs,
  analyzer: {
    ...contaminationDetectorExample,
    observationBatchHash: '8'.repeat(64),
  },
  policy: {
    ...contaminationPolicyExample,
    version: 'source-contamination/v1',
  },
  observations: contaminationObservationsExample,
  protectedRegions: contaminationProtectedRegionsExample.map(
    (region) => ({
      ...region,
      regionHash: '9'.repeat(64),
    }),
  ),
  findings: contaminationFindingsExample,
  overlaps: [{
    id: 'contamination-overlap-example-1',
    leftFindingId: contaminationFindingsExample[0].id,
    rightFindingId: contaminationFindingsExample[1].id,
    rangeMs: [900, 2300],
    spatiallyOverlapping: true,
    intersectionRegion:
      contaminationObservationsExample[0].region,
    confidence: 0.96,
    overlapHash: 'a'.repeat(64),
  }],
  summary: {
    findingCount: 2,
    observationCount: 2,
    protectedRegionCount: 1,
    overlapCount: 1,
    countsByKind: {
      'burned-caption': 1,
      'logo-watermark': 0,
      music: 1,
      border: 0,
      overlay: 0,
    },
    safeCount: 0,
    reviewCount: 0,
    destructiveCount: 2,
  },
  diagnostics: contaminationDiagnosticsExample,
  decision: 'manual-preservation-required',
  humanReviewRequired: true,
  confidence: 0.97,
  createdByClientId: clientId,
  createdAt,
  reportHash: 'b'.repeat(64),
}
const sourceCleanupPolicyExample = {
  minResidualQuality: 0.7,
  minIntegrity: 0.9,
  maxCost: 1,
  edgeTolerance: 0.04,
  maxCropFraction: 0.25,
  maxCoverArea: 0.12,
  coverColor: '#111111',
  costs: {
    trim: 0.1,
    'crop-reframe': 0.2,
    cover: 0.3,
  },
}
const sourceCleanupRequestExample = {
  contaminationReportId: contaminationReportExample.id,
  expectedReportHash: contaminationReportExample.reportHash,
  findingId: 'contamination-finding-safe-example-1',
  policy: sourceCleanupPolicyExample,
}
const sourceCleanupPlanExample = {
  schemaVersion: 'source-cleanup-plan/v1',
  policyVersion: 'source-cleanup-mvp/v1',
  id: 'source-cleanup-example-1',
  workspaceId,
  projectId,
  contaminationReportId: contaminationReportExample.id,
  contaminationReportHash: contaminationReportExample.reportHash,
  findingId: sourceCleanupRequestExample.findingId,
  findingHash: 'c'.repeat(64),
  sourceArtifactId: contaminationReportExample.sourceArtifactId,
  sourceArtifactSha256:
    contaminationReportExample.sourceArtifactSha256,
  sourceManifestId: 'manifest-source-cleanup-example-1',
  sourceDurationMs: contaminationReportExample.sourceDurationMs,
  sourceImmutable: true,
  policy: sourceCleanupPolicyExample,
  candidates: [
    {
      strategy: 'trim',
      eligible: false,
      predictedResidualQuality: 0.95,
      predictedIntegrity: 1,
      cost: 0.1,
      score: 0.88,
      reasonCodes: ['TEMPORAL_RANGE_NOT_AT_EDGE'],
    },
    {
      strategy: 'crop-reframe',
      eligible: false,
      predictedResidualQuality: 0,
      predictedIntegrity: 1,
      cost: 0.2,
      score: 0.52,
      reasonCodes: ['NO_SAFE_EDGE_CROP'],
    },
    {
      strategy: 'cover',
      eligible: true,
      predictedResidualQuality: 0.97,
      predictedIntegrity: 1,
      cost: 0.3,
      score: 0.92,
      reasonCodes: [],
      action: {
        strategy: 'cover',
        rangeMs: [900, 2300],
        region: { x: 0.02, y: 0.85, width: 0.2, height: 0.08 },
        color: '#111111',
      },
    },
  ],
  selectedStrategy: 'cover',
  selectedAction: {
    strategy: 'cover',
    rangeMs: [900, 2300],
    region: { x: 0.02, y: 0.85, width: 0.2, height: 0.08 },
    color: '#111111',
  },
  decision: 'execute',
  predictedResidualQuality: 0.97,
  predictedIntegrity: 1,
  predictedCost: 0.3,
  rightsSnapshotId: 'rights-source-cleanup-example-1',
  rightsSnapshotHash: 'd'.repeat(64),
  rightsDecision: 'allow',
  rightsReasonCodes: [],
  operationId: queuedSourceCleanupOperationExample.id,
  outputArtifactId:
    queuedSourceCleanupOperationExample.target.id,
  outputManifestId:
    queuedSourceCleanupOperationExample.target.manifestId,
  postCleanupReviewRequired: true,
  createdByClientId: clientId,
  createdAt,
  planHash: 'e'.repeat(64),
}
const sourceCleanupRecordExample = {
  plan: sourceCleanupPlanExample,
  operation: queuedSourceCleanupOperationExample,
}
const validationEnvelopeCreateRequestExample = {
  batchId: 'production-batch-validation-example-1',
  validatedSegmentId: validatedSegmentExample.id,
  expectedValidatedSegmentHash:
    validatedSegmentExample.validatedSegmentHash,
  targetRecipeId: 'variant-recipe-validation-example-1',
  expectedTargetRecipeHash: '2'.repeat(64),
  policyVersion: 'validation-envelope-policy/v1',
  requestedChanges: [{
    aspect: 'framing',
    required: false,
    rationale: 'Adaptar o enquadramento ao formato vertical.',
  }],
}
const validationEnvelopeCompositionExample = {
  schemaVersion: 'validation-envelope-composition/v1',
  clips: [
    {
      id: 'validation-clip-hook-example-1',
      role: 'hook',
      source: 'validated-segment-envelope',
      sourceArtifactId: validatedSegmentExample.sourceArtifactId,
      sourceHash: validatedSegmentExample.sourceArtifactSha256,
      sourceRangeMs:
        validatedSegmentExample.protectedEnvelope.sourceRangeMs,
      sourceSegmentId:
        validatedSegmentExample.sourceSpeechSegmentId,
      durationMs: 7_000,
    },
    {
      id: 'validation-clip-body-example-1',
      role: 'body',
      source: 'target-variant-recipe',
      sourceArtifactId: 'artifact-body-validation-example-1',
      sourceHash: '3'.repeat(64),
      sourceRangeMs: [10_000, 25_000],
      sourceSegmentId: 'recipe-segment-body-validation-example-1',
      takeId: 'take-body-validation-example-1',
      durationMs: 15_000,
    },
    {
      id: 'validation-clip-cta-example-1',
      role: 'cta',
      source: 'target-variant-recipe',
      sourceArtifactId: 'artifact-cta-validation-example-1',
      sourceHash: '4'.repeat(64),
      sourceRangeMs: [30_000, 35_000],
      sourceSegmentId: 'recipe-segment-cta-validation-example-1',
      takeId: 'take-cta-validation-example-1',
      durationMs: 5_000,
    },
  ],
  orderedRoles: ['hook', 'body', 'cta'],
  includedSourceSegmentIds: [
    validatedSegmentExample.sourceSpeechSegmentId,
    'recipe-segment-body-validation-example-1',
    'recipe-segment-cta-validation-example-1',
  ],
  excludedTargetRecipeSegmentIds: [
    'recipe-segment-hook-validation-example-1',
  ],
  targetRecipeHookExcluded: true,
  validatedSourceOutsideEnvelopeIncluded: false,
  excessMaterialIncluded: false,
  durationMs: 27_000,
  compositionHash: '5'.repeat(64),
}
const validationEnvelopePlanExample = {
  schemaVersion: 'validation-envelope-reuse/v1',
  policyVersion: 'validation-envelope-policy/v1',
  id: 'validation-envelope-reuse-example-1',
  workspaceId,
  projectId,
  batchId: validationEnvelopeCreateRequestExample.batchId,
  validatedSegmentId: validatedSegmentExample.id,
  validatedSegmentHash:
    validatedSegmentExample.validatedSegmentHash,
  sourceArtifactId: validatedSegmentExample.sourceArtifactId,
  sourceArtifactSha256:
    validatedSegmentExample.sourceArtifactSha256,
  sourceRangeMs:
    validatedSegmentExample.protectedEnvelope.sourceRangeMs,
  targetRecipeId:
    validationEnvelopeCreateRequestExample.targetRecipeId,
  targetRecipeHash:
    validationEnvelopeCreateRequestExample.expectedTargetRecipeHash,
  objective: 'lead-generation',
  aspectRules: [
    {
      aspect: 'copy',
      state: 'protected',
      source: 'opening-edit-evidence',
    },
    {
      aspect: 'take',
      state: 'protected',
      source: 'opening-edit-evidence',
    },
    {
      aspect: 'framing',
      state: 'protected',
      source: 'opening-edit-evidence',
    },
    {
      aspect: 'timing',
      state: 'protected',
      source: 'opening-edit-evidence',
    },
    {
      aspect: 'opening',
      state: 'protected',
      source: 'opening-edit-evidence',
    },
  ],
  protectedAspects: ['copy', 'take', 'framing', 'timing', 'opening'],
  mutableAspects: [],
  requestedChanges:
    validationEnvelopeCreateRequestExample.requestedChanges,
  autoProtectedChanges: ['framing'],
  approvalRequiredChanges: [],
  approvalRequired: false,
  initialValidation: 'preserved',
  composition: validationEnvelopeCompositionExample,
  createdByClientId: clientId,
  createdAt,
  planHash: '6'.repeat(64),
}
const validationEnvelopeInitialDecisionExample = {
  schemaVersion: 'validation-envelope-decision/v1',
  id: 'validation-envelope-decision-example-1',
  reusePlanId: validationEnvelopePlanExample.id,
  sequence: 1,
  kind: 'created',
  outcome: 'ready',
  validation: 'preserved',
  appliedChanges: [],
  blockedChanges: ['framing'],
  lostAspects: [],
  note: 'Validation envelope preserved automatically.',
  actorClientId: clientId,
  createdAt,
  decisionHash: '7'.repeat(64),
}
const validationEnvelopeRecordExample = {
  plan: validationEnvelopePlanExample,
  decisions: [validationEnvelopeInitialDecisionExample],
  currentDecision: validationEnvelopeInitialDecisionExample,
}
const productionBatchCreateRequestExample = {
  projectId,
  name: 'Campanha de descoberta — julho',
  objective: 'content-distribution',
  sourceGroups: [
    {
      id: 'source-group-hooks',
      name: 'Hooks validados',
      sourceArtifactIds: [
        'artifact-hook-example-1',
        'artifact-hook-example-2',
      ],
    },
    {
      id: 'source-group-body',
      name: 'Corpo e CTA',
      sourceArtifactIds: ['artifact-body-example-1'],
    },
  ],
  recipes: [
    {
      id: 'recipe-hook',
      name: 'Hook direto',
      sourceGroupIds: ['source-group-hooks'],
    },
    {
      id: 'recipe-body',
      name: 'Argumento completo',
      sourceGroupIds: ['source-group-body'],
    },
  ],
  variants: [
    {
      id: 'variant-vertical',
      name: 'Vertical 9:16',
      outputSpecId: '9:16',
      locale: 'pt-BR',
    },
    {
      id: 'variant-square',
      name: 'Quadrado 1:1',
      outputSpecId: '1:1',
      locale: 'pt-BR',
    },
  ],
  budget: {
    currency: 'USD',
    maxCostMinorUnits: 5000,
    reservedCostMinorUnits: 1800,
  },
  items: [
    {
      key: 'hook/vertical',
      sourceGroupId: 'source-group-hooks',
      recipeId: 'recipe-hook',
      variantId: 'variant-vertical',
    },
    {
      key: 'body/square',
      sourceGroupId: 'source-group-body',
      recipeId: 'recipe-body',
      variantId: 'variant-square',
    },
  ],
}
const queuedProductionBatchStepsExample = [
  'planning',
  'materializing',
  'rendering',
  'reviewing',
].map((step, sequence) => ({
  step,
  sequence,
  state: 'queued',
  attempt: 0,
  costMinorUnits: 0,
  cacheHit: false,
  stepHash: String(sequence + 1).repeat(64),
}))
const productionBatchExample = {
  schemaVersion: 'production-batch/v1',
  id: 'production-batch-example-1',
  workspaceId,
  projectId,
  name: productionBatchCreateRequestExample.name,
  objective: productionBatchCreateRequestExample.objective,
  policyVersion: 'production-batch/v1',
  revision: 1,
  sourceGroups: productionBatchCreateRequestExample.sourceGroups,
  recipes: productionBatchCreateRequestExample.recipes,
  variants: productionBatchCreateRequestExample.variants,
  budget: productionBatchCreateRequestExample.budget,
  items: productionBatchCreateRequestExample.items.map((item, index) => ({
    id: `production-batch-item-example-${index + 1}`,
    ...item,
    state: 'queued',
    revision: 1,
    steps: queuedProductionBatchStepsExample.map((step) => ({
      ...step,
      stepHash: String(index + step.sequence + 1).repeat(64),
    })),
    artifactIds: [],
    retryCount: 0,
    createdAt,
    updatedAt: createdAt,
    itemHash: String(index + 5).repeat(64),
  })),
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
  updatedAt: createdAt,
  definitionHash: '7'.repeat(64),
  status: 'queued',
  progress: {
    completedSteps: 0,
    failedSteps: 0,
    cancelledSteps: 0,
    runningSteps: 0,
    totalSteps: 8,
    percent: 0,
    completedItems: 0,
    failedItems: 0,
    cancelledItems: 0,
    activeItems: 0,
    queuedItems: 2,
    totalItems: 2,
    spentMinorUnits: 0,
    remainingMinorUnits: 5000,
  },
}
const productionBatchVisibleExample = {
  ...productionBatchExample,
  items: productionBatchExample.items.map((item) => ({
    ...item,
    visibleState: {
      schemaVersion: 'visible-state/v1',
      label: 'queued',
      tone: 'neutral',
      progress: { mode: 'determinate', percent: 0 },
      primaryAction: 'view-progress',
      availableActions: ['view-progress', 'cancel'],
      terminal: false,
    },
  })),
  visibleState: {
    schemaVersion: 'visible-state/v1',
    label: 'queued',
    tone: 'neutral',
    progress: { mode: 'determinate', percent: 0 },
    primaryAction: 'view-progress',
    availableActions: ['view-progress', 'cancel'],
    terminal: false,
  },
}
const batchPartialRetryRequestExample = {
  expectedBatchRevision: 9,
  targets: [
    {
      itemId: 'production-batch-item-example-1',
      step: 'materializing',
      expectedItemRevision: 5,
      expectedStepHash: 'a'.repeat(64),
    },
  ],
}
const batchPartialRetryProgressBeforeExample = {
  completedSteps: 1,
  failedSteps: 1,
  cancelledSteps: 0,
  runningSteps: 0,
  totalSteps: 8,
  percent: 12,
  completedItems: 0,
  failedItems: 1,
  cancelledItems: 0,
  activeItems: 0,
  queuedItems: 1,
  totalItems: 2,
  spentMinorUnits: 120,
  remainingMinorUnits: 4880,
}
const batchPartialRetryProgressAfterExample = {
  ...batchPartialRetryProgressBeforeExample,
  failedSteps: 0,
  queuedItems: 2,
  failedItems: 0,
}
const batchPartialRetryExample = {
  schemaVersion: 'batch-partial-retry/v1',
  id: 'production-batch-partial-retry-example-1',
  workspaceId,
  projectId,
  batchId: productionBatchExample.id,
  batchDefinitionHash: productionBatchExample.definitionHash,
  batchRevisionBefore: 9,
  batchRevisionAfter: 10,
  status: 'queued',
  jobs: [
    {
      schemaVersion: 'batch-partial-retry-job/v1',
      id: 'production-batch-retry-job-example-1',
      workspaceId,
      projectId,
      batchId: productionBatchExample.id,
      retryId: 'production-batch-partial-retry-example-1',
      itemId: 'production-batch-item-example-1',
      step: 'materializing',
      executorClass: 'provider',
      status: 'queued',
      lineageKey: 'b'.repeat(64),
      failedAttempt: 1,
      retryAttempt: 2,
      previousStepHash: 'a'.repeat(64),
      queuedStepHash: 'c'.repeat(64),
      failureCode: 'PROVIDER_TIMEOUT',
      failureMessage: 'Provider exceeded the bounded attempt.',
      preservedArtifactIds: [artifactId],
      preservedArtifactCount: 1,
      chargedMinorUnitsAtEnqueue: 0,
      createdAt,
      jobHash: 'd'.repeat(64),
    },
  ],
  targetCount: 1,
  preservedCompletedItemIds: [],
  preservedArtifactIds: [artifactId],
  progressBefore: batchPartialRetryProgressBeforeExample,
  progressAfter: batchPartialRetryProgressAfterExample,
  spentMinorUnitsBefore: 120,
  spentMinorUnitsAfter: 120,
  remainingMinorUnitsBefore: 4880,
  remainingMinorUnitsAfter: 4880,
  createdByClientId: clientId,
  createdAt,
  retryHash: 'e'.repeat(64),
}
const scriptAlignmentCreateRequestExample = {
  title: 'Roteiro de descoberta',
  locale: 'pt-BR',
  rawText: [
    'HOOK 1: Pare de perder dinheiro com anuncios.',
    'CORPO 1: Alinhe oferta, publico e mensagem.',
    'PROVA 1: Mais de cem clientes aplicaram este metodo.',
    'CTA 1: Clique no link e agende uma conversa.',
  ].join('\n'),
  sources: [
    {
      transcriptId: 'transcript-hooks-example-1',
      expectedTranscriptHash: '8'.repeat(64),
      roleHint: 'hook',
    },
    {
      transcriptId: 'transcript-body-cta-example-1',
      expectedTranscriptHash: '9'.repeat(64),
      roleHint: 'body',
    },
  ],
}
const scriptAlignmentCandidateExample = {
  id: 'script-candidate-example-1',
  transcriptId: 'transcript-hooks-example-1',
  sourceArtifactId: 'artifact-hooks-example-1',
  kind: 'near',
  sourceRangeMs: [1240, 3380],
  evidenceWordIndices: [4, 5, 6, 7, 8, 9],
  spokenText: 'Pare de perder dinheiro com seus anuncios',
  normalizedSpokenText: 'pare de perder dinheiro com seus anuncios',
  metrics: {
    semanticSimilarity: 0.91,
    lexicalCoverage: 1,
    expectedOrder: 1,
    boundaryCompleteness: 0.8,
    durationPlausibility: 1,
    labelSignal: 1,
    total: 91.85,
  },
  deviations: [
    {
      kind: 'insertion',
      plannedTokens: [],
      spokenTokens: ['seus'],
      reasonCode: 'OFF_SCRIPT_WORDS_INSERTED',
    },
  ],
  candidateHash: 'a'.repeat(64),
}
const scriptAlignmentRunExample = {
  id: 'script-alignment-example-1',
  workspaceId,
  projectId,
  batchId: productionBatchExample.id,
  schemaVersion: 'script-alignment-run/v1',
  algorithmVersion: 'monotonic-lexical-sequence/v1',
  status: 'review-required',
  revision: 1,
  document: {
    schemaVersion: 'script-document/v1',
    title: 'Roteiro de descoberta',
    locale: 'pt-BR',
    rawText: 'HOOK 1: Pare de perder dinheiro com anuncios.',
    normalizedText: 'hook 1 pare de perder dinheiro com anuncios',
    blocks: [
      {
        id: 'script-block-1',
        role: 'hook',
        originalLabel: 'HOOK 1',
        plannedText: 'Pare de perder dinheiro com anuncios.',
        normalizedText: 'pare de perder dinheiro com anuncios',
        documentOrder: 0,
        blockHash: 'b'.repeat(64),
      },
    ],
    documentHash: 'c'.repeat(64),
  },
  sourceRefs: [
    {
      transcriptId: 'transcript-hooks-example-1',
      sourceArtifactId: 'artifact-hooks-example-1',
      transcriptHash: '8'.repeat(64),
      language: 'pt-BR',
      roleHint: 'hook',
    },
  ],
  alignments: [
    {
      blockId: 'script-block-1',
      role: 'hook',
      documentOrder: 0,
      kind: 'near',
      confidence: 91.85,
      reviewStatus: 'review-required',
      ambiguous: true,
      reasonCodes: ['ALIGNMENT_AMBIGUOUS'],
      selectedCandidate: scriptAlignmentCandidateExample,
      alternatives: [
        {
          ...scriptAlignmentCandidateExample,
          id: 'script-candidate-example-2',
          sourceRangeMs: [5520, 7660],
          evidenceWordIndices: [16, 17, 18, 19, 20, 21],
          candidateHash: 'd'.repeat(64),
        },
      ],
      alignmentHash: 'e'.repeat(64),
    },
  ],
  extraTakes: [
    {
      id: 'script-extra-example-1',
      transcriptId: 'transcript-hooks-example-1',
      sourceArtifactId: 'artifact-hooks-example-1',
      sourceRangeMs: [0, 900],
      evidenceWordIndices: [0, 1, 2],
      spokenText: 'Preparando para gravar',
      normalizedSpokenText: 'preparando para gravar',
      reviewStatus: 'review-required',
      extraHash: 'f'.repeat(64),
    },
  ],
  reviews: [],
  summary: {
    blockCount: 1,
    exactCount: 0,
    nearCount: 1,
    partialCount: 0,
    missingCount: 0,
    extraTakeCount: 1,
    ambiguousCount: 1,
    reviewRequiredCount: 2,
    resolvedReviewCount: 0,
    averageConfidence: 91.85,
  },
  createdByClientId: clientId,
  createdAt,
  updatedAt: createdAt,
  runHash: '1'.repeat(64),
}
const takeLibraryCreateRequestExample = {
  alignmentId: scriptAlignmentRunExample.id,
  expectedAlignmentRunHash: scriptAlignmentRunExample.runHash,
  evaluations: [
    {
      sourceKind: 'alignment-candidate',
      sourceId: scriptAlignmentCandidateExample.id,
      expectedSourceHash: scriptAlignmentCandidateExample.candidateHash,
      dimensions: [
        {
          dimension: 'completeness',
          score: 0.95,
          evaluatorVersion: 'take-quality-example/v1',
          evidenceRefs: ['quality-report-example-1'],
        },
        {
          dimension: 'performance',
          score: 0.9,
          evaluatorVersion: 'take-quality-example/v1',
          evidenceRefs: ['quality-report-example-1'],
        },
        {
          dimension: 'audio',
          score: 0.92,
          evaluatorVersion: 'take-quality-example/v1',
          evidenceRefs: ['audio-report-example-1'],
        },
        {
          dimension: 'video',
          score: 0.88,
          evaluatorVersion: 'take-quality-example/v1',
          evidenceRefs: ['video-report-example-1'],
        },
        {
          dimension: 'integrity',
          score: 0.88,
          evaluatorVersion: 'take-quality-example/v1',
          evidenceRefs: ['quality-report-example-1'],
        },
      ],
    },
    {
      sourceKind: 'extra-take',
      sourceId: 'script-extra-example-1',
      expectedSourceHash: 'f'.repeat(64),
      dimensions: [],
      inferredIntention: {
        role: 'other',
        label: 'Preparacao fora da composicao',
        confidence: 0.98,
        evidenceRefs: ['director-review-example-1'],
      },
    },
  ],
}
const takeLibraryMeasuredEvaluationsExample = [
  ['completeness', 0.95, 'quality-report-example-1'],
  ['performance', 0.9, 'quality-report-example-1'],
  ['audio', 0.92, 'audio-report-example-1'],
  ['video', 0.88, 'video-report-example-1'],
  ['integrity', 0.88, 'quality-report-example-1'],
].map(([dimension, score, evidenceRef], index) => ({
  dimension,
  score,
  state: 'measured',
  evaluatorVersion: 'take-quality-example/v1',
  evidenceRefs: [evidenceRef],
  reasonCodes: [],
  evaluationHash: String(index + 2).repeat(64),
}))
const takeLibraryUnavailableEvaluationsExample = [
  'completeness',
  'performance',
  'audio',
  'video',
  'integrity',
].map((dimension, index) => ({
  dimension,
  score: null,
  state: 'unavailable',
  evaluatorVersion: 'five-dimension-take-quality/v1',
  evidenceRefs: ['f'.repeat(64)],
  reasonCodes: [`${String(dimension).toUpperCase()}_EVIDENCE_UNAVAILABLE`],
  evaluationHash: String(index + 3).repeat(64),
}))
const takeLibraryRunExample = {
  id: 'take-library-example-1',
  workspaceId,
  projectId,
  batchId: productionBatchExample.id,
  alignmentId: scriptAlignmentRunExample.id,
  alignmentRunHash: scriptAlignmentRunExample.runHash,
  schemaVersion: 'take-library/v1',
  groupingPolicyVersion: 'script-block-or-intention/v1',
  evaluationPolicyVersion: 'five-dimension-take-quality/v1',
  status: 'review-required',
  revision: 2,
  groups: [
    {
      id: 'take-group-script-block-1',
      key: 'script-block:script-block-1',
      assignmentKind: 'script-block',
      role: 'hook',
      label: 'HOOK 1',
      scriptBlockId: 'script-block-1',
      takeIds: ['take-example-primary-1'],
      primaryTakeId: 'take-example-primary-1',
      protectedTakeId: 'take-example-primary-1',
      groupHash: '7'.repeat(64),
    },
    {
      id: 'take-group-inferred-other-1',
      key: 'inferred-intention:other:preparacao',
      assignmentKind: 'inferred-intention',
      role: 'other',
      label: 'Preparacao fora da composicao',
      takeIds: ['take-example-review-1'],
      groupHash: '8'.repeat(64),
    },
  ],
  takes: [
    {
      id: 'take-example-primary-1',
      groupId: 'take-group-script-block-1',
      retakeBoundaryId: 'retake-boundary-example-1',
      sourceKind: 'alignment-candidate',
      sourceId: scriptAlignmentCandidateExample.id,
      sourceHash: scriptAlignmentCandidateExample.candidateHash,
      transcriptId: scriptAlignmentCandidateExample.transcriptId,
      sourceArtifactId: scriptAlignmentCandidateExample.sourceArtifactId,
      sourceRangeMs: scriptAlignmentCandidateExample.sourceRangeMs,
      evidenceWordIndices:
        scriptAlignmentCandidateExample.evidenceWordIndices,
      spokenText: scriptAlignmentCandidateExample.spokenText,
      normalizedSpokenText:
        scriptAlignmentCandidateExample.normalizedSpokenText,
      assignment: {
        kind: 'script-block',
        role: 'hook',
        label: 'HOOK 1',
        confidence: 0.9185,
        evidenceRefs: [
          'e'.repeat(64),
          scriptAlignmentCandidateExample.candidateHash,
        ],
        scriptBlockId: 'script-block-1',
        assignmentHash: '9'.repeat(64),
      },
      evaluations: takeLibraryMeasuredEvaluationsExample,
      weightedScore: 0.9112,
      status: 'primary',
      protected: true,
      selectionSource: 'manual',
      reasonCodes: [],
      takeHash: '2'.repeat(64),
    },
    {
      id: 'take-example-review-1',
      groupId: 'take-group-inferred-other-1',
      retakeBoundaryId: 'retake-boundary-example-2',
      sourceKind: 'extra-take',
      sourceId: 'script-extra-example-1',
      sourceHash: 'f'.repeat(64),
      transcriptId: 'transcript-hooks-example-1',
      sourceArtifactId: 'artifact-hooks-example-1',
      sourceRangeMs: [0, 900],
      evidenceWordIndices: [0, 1, 2],
      spokenText: 'Preparando para gravar',
      normalizedSpokenText: 'preparando para gravar',
      assignment: {
        kind: 'inferred-intention',
        role: 'other',
        label: 'Preparacao fora da composicao',
        confidence: 0.98,
        evidenceRefs: [
          'director-review-example-1',
          'f'.repeat(64),
        ],
        assignmentHash: '3'.repeat(64),
      },
      evaluations: takeLibraryUnavailableEvaluationsExample,
      weightedScore: null,
      status: 'needs-review',
      protected: false,
      selectionSource: 'automatic',
      reasonCodes: [
        'AUDIO_EVIDENCE_UNAVAILABLE',
        'COMPLETENESS_EVIDENCE_UNAVAILABLE',
        'INTEGRITY_EVIDENCE_UNAVAILABLE',
        'PERFORMANCE_EVIDENCE_UNAVAILABLE',
        'VIDEO_EVIDENCE_UNAVAILABLE',
      ],
      takeHash: '4'.repeat(64),
    },
  ],
  selections: [
    {
      id: 'take-selection-example-1',
      revision: 2,
      groupId: 'take-group-script-block-1',
      takeId: 'take-example-primary-1',
      protect: true,
      actorClientId: clientId,
      createdAt,
      selectionHash: '5'.repeat(64),
    },
  ],
  summary: {
    groupCount: 2,
    takeCount: 2,
    primaryCount: 1,
    alternateCount: 0,
    rejectedCount: 0,
    needsReviewCount: 1,
    protectedCount: 1,
    measuredDimensionCount: 5,
    unavailableDimensionCount: 5,
    averageWeightedScore: 0.9112,
  },
  createdByClientId: clientId,
  createdAt,
  updatedAt: createdAt,
  runHash: '6'.repeat(64),
}
const compatibilityContextsExample = [
  {
    takeId: 'take-example-hook-1',
    expectedTakeHash: '1'.repeat(64),
    offerId: 'offer-apollo-example',
    audienceTags: ['especialistas'],
    claims: [{ key: 'resultado', value: 'clareza' }],
    personaId: 'persona-especialista',
    locale: 'pt-BR',
    desiredAction: 'whatsapp',
    continuityProvides: ['promessa-aberta'],
    continuityRequires: [],
    narrativeTags: ['clareza', 'vendas'],
    tone: 0.55,
    energy: 0.65,
    visual: 0.5,
    experiment: 0.4,
    evidenceRefs: ['1'.repeat(64)],
  },
  {
    takeId: 'take-example-body-1',
    expectedTakeHash: '2'.repeat(64),
    offerId: 'offer-apollo-example',
    audienceTags: ['especialistas'],
    claims: [{ key: 'resultado', value: 'clareza' }],
    personaId: 'persona-especialista',
    locale: 'pt-BR',
    desiredAction: 'whatsapp',
    continuityProvides: ['mecanismo-explicado'],
    continuityRequires: ['promessa-aberta'],
    narrativeTags: ['clareza', 'vendas'],
    tone: 0.58,
    energy: 0.62,
    visual: 0.52,
    experiment: 0.4,
    evidenceRefs: ['2'.repeat(64)],
  },
  {
    takeId: 'take-example-cta-1',
    expectedTakeHash: '3'.repeat(64),
    offerId: 'offer-apollo-example',
    audienceTags: ['especialistas'],
    claims: [{ key: 'resultado', value: 'clareza' }],
    personaId: 'persona-especialista',
    locale: 'pt-BR',
    desiredAction: 'whatsapp',
    continuityProvides: [],
    continuityRequires: ['mecanismo-explicado'],
    narrativeTags: ['clareza', 'vendas'],
    tone: 0.6,
    energy: 0.66,
    visual: 0.54,
    experiment: 0.4,
    evidenceRefs: ['3'.repeat(64)],
  },
]
const compatibilityNodeExample = (
  index: number,
  role: 'hook' | 'body' | 'cta',
  sourceRangeMs: readonly [number, number],
  context: (typeof compatibilityContextsExample)[number],
) => ({
  id: `compat-node-example-${index}`,
  takeId: context.takeId,
  takeHash: context.expectedTakeHash,
  groupId: `take-group-example-${role}`,
  scriptBlockId: `script-block-example-${role}`,
  role,
  sourceArtifactId: 'artifact-compatibility-example',
  sourceHash: String(index + 2).repeat(64),
  sourceRangeMs,
  durationMs: sourceRangeMs[1] - sourceRangeMs[0],
  offerId: context.offerId,
  audienceTags: context.audienceTags,
  claims: context.claims,
  personaId: context.personaId,
  locale: context.locale,
  desiredAction: context.desiredAction,
  continuityProvides: context.continuityProvides,
  continuityRequires: context.continuityRequires,
  narrativeTags: context.narrativeTags,
  tone: context.tone,
  energy: context.energy,
  visual: context.visual,
  experiment: context.experiment,
  evidenceRefs: context.evidenceRefs,
  contextHash: String(index + 4).repeat(64),
  nodeHash: String(index + 6).repeat(64),
})
const compatibilityNodesExample = [
  compatibilityNodeExample(
    0,
    'hook',
    [0, 3200],
    compatibilityContextsExample[0],
  ),
  compatibilityNodeExample(
    1,
    'body',
    [3200, 9700],
    compatibilityContextsExample[1],
  ),
  compatibilityNodeExample(
    2,
    'cta',
    [9700, 12000],
    compatibilityContextsExample[2],
  ),
]
const compatibilitySoftScoresExample = [
  ['narrative', 1, 0.3],
  ['tone', 0.97, 0.15],
  ['energy', 0.97, 0.15],
  ['duration', 0.492308, 0.15],
  ['visual', 0.98, 0.15],
  ['experiment', 1, 0.1],
].map(([dimension, score, weight], index) => ({
  dimension,
  score,
  weight,
  reasonCode: `${String(dimension).toUpperCase()}_CONTINUITY`,
  evidenceRefs: [
    compatibilityNodesExample[0].contextHash,
    compatibilityNodesExample[1].contextHash,
    compatibilityNodesExample[0].takeHash,
    compatibilityNodesExample[1].takeHash,
  ],
  scoreHash: String(index + 1).repeat(64),
}))
const compatibilityGraphRunExample = {
  id: 'compatibility-graph-example-1',
  workspaceId,
  projectId,
  batchId: productionBatchExample.id,
  takeLibraryId: takeLibraryRunExample.id,
  takeLibraryRunHash: takeLibraryRunExample.runHash,
  schemaVersion: 'compatibility-graph/v1',
  ruleVersion: 'compatibility-rules/v1',
  softScoreVersion: 'compatibility-soft-score/v1',
  acceptThreshold: 70,
  reviewThreshold: 60,
  nodes: compatibilityNodesExample,
  edges: [
    {
      id: 'compat-edge-example-hook-body',
      fromNodeId: compatibilityNodesExample[0].id,
      toNodeId: compatibilityNodesExample[1].id,
      relation: 'hook-body',
      decision: 'accepted',
      eligible: true,
      hardFailures: [],
      softScores: compatibilitySoftScoresExample,
      softScore: 91.785,
      reasonCodes: ['COMPATIBLE'],
      evidence: {
        fromTakeHash: compatibilityNodesExample[0].takeHash,
        toTakeHash: compatibilityNodesExample[1].takeHash,
        fromSourceHash: compatibilityNodesExample[0].sourceHash,
        toSourceHash: compatibilityNodesExample[1].sourceHash,
        fromContextHash: compatibilityNodesExample[0].contextHash,
        toContextHash: compatibilityNodesExample[1].contextHash,
        ruleVersion: 'compatibility-rules/v1',
        softScoreVersion: 'compatibility-soft-score/v1',
        evidenceHash: 'a'.repeat(64),
      },
      edgeHash: 'b'.repeat(64),
    },
    {
      id: 'compat-edge-example-body-cta',
      fromNodeId: compatibilityNodesExample[1].id,
      toNodeId: compatibilityNodesExample[2].id,
      relation: 'body-cta',
      decision: 'accepted',
      eligible: true,
      hardFailures: [],
      softScores: compatibilitySoftScoresExample.map(
        (score, index) => ({
          ...score,
          evidenceRefs: [
            compatibilityNodesExample[1].contextHash,
            compatibilityNodesExample[2].contextHash,
            compatibilityNodesExample[1].takeHash,
            compatibilityNodesExample[2].takeHash,
          ],
          scoreHash: String(index + 2).repeat(64),
        }),
      ),
      softScore: 89.5,
      reasonCodes: ['COMPATIBLE'],
      evidence: {
        fromTakeHash: compatibilityNodesExample[1].takeHash,
        toTakeHash: compatibilityNodesExample[2].takeHash,
        fromSourceHash: compatibilityNodesExample[1].sourceHash,
        toSourceHash: compatibilityNodesExample[2].sourceHash,
        fromContextHash: compatibilityNodesExample[1].contextHash,
        toContextHash: compatibilityNodesExample[2].contextHash,
        ruleVersion: 'compatibility-rules/v1',
        softScoreVersion: 'compatibility-soft-score/v1',
        evidenceHash: 'd'.repeat(64),
      },
      edgeHash: 'e'.repeat(64),
    },
  ],
  summary: {
    nodeCount: 3,
    edgeCount: 2,
    acceptedCount: 2,
    borderlineCount: 0,
    blockedCount: 0,
    hardFailureCount: 0,
    averageSoftScore: 90.6425,
  },
  createdByClientId: clientId,
  createdAt,
  runHash: 'c'.repeat(64),
}
const variantRecipeSourceSegmentsExample =
  compatibilityNodesExample.map((node, index) => ({
    id: `variant-source-segment-${index + 1}`,
    usage: 'primary',
    role: node.role,
    nodeId: node.id,
    takeId: node.takeId,
    takeHash: node.takeHash,
    scriptBlockId: node.scriptBlockId,
    sourceArtifactId: node.sourceArtifactId,
    sourceHash: node.sourceHash,
    sourceRangeMs: node.sourceRangeMs,
    durationMs: node.durationMs,
    segmentHash: String(index + 5).repeat(64),
  }))
const variantRecipeLineageExample =
  variantRecipeSourceSegmentsExample.map((segment, index) => ({
    id: `variant-lineage-${index + 1}`,
    sequence: index,
    usage: 'primary',
    role: segment.role,
    nodeId: segment.nodeId,
    takeId: segment.takeId,
    takeHash: segment.takeHash,
    scriptBlockId: compatibilityNodesExample[index].scriptBlockId,
    groupId: compatibilityNodesExample[index].groupId,
    sourceSegmentId: segment.id,
    sourceArtifactId: segment.sourceArtifactId,
    sourceHash: segment.sourceHash,
    sourceRangeMs: segment.sourceRangeMs,
    lineageHash: ['8', '9', 'a'][index].repeat(64),
  }))
const variantStoryBlocksExample =
  variantRecipeSourceSegmentsExample.map((segment, index) => {
    const node = compatibilityNodesExample[index]
    return {
      id: `variant-story-block-${segment.role}`,
      actId: segment.role === 'hook'
        ? 'opening'
        : segment.role === 'cta'
          ? 'resolution'
          : 'development',
      role: segment.role === 'body' ? 'argument' : segment.role,
      intent: `use-${segment.role}-take`,
      dependencies: index === 0
        ? []
        : [`variant-story-block-${
            variantRecipeSourceSegmentsExample[index - 1].role
          }`],
      sourceCandidateIds: [segment.takeId],
      durationTargetMs: {
        min: segment.durationMs,
        ideal: segment.durationMs,
        max: segment.durationMs,
      },
      content: {
        claimIds: node.claims.map((claim) => claim.key),
        qualifierIds: [],
        proofIds: [],
        ...(segment.role === 'cta'
          ? { ctaId: segment.takeId }
          : {}),
      },
      presentation: 'source-video',
      sourceRangeId: segment.id,
    }
  })
const variantStoryPlanExample = {
  id: 'variant-story-plan-example-1',
  schemaVersion: 1,
  compilerVersion: 'variant-recipe-compiler/v1',
  objective: productionBatchExample.objective,
  targetDurationMs: { min: 12000, max: 12000 },
  acts: [
    {
      id: 'opening',
      role: 'opening',
      blockIds: ['variant-story-block-hook'],
    },
    {
      id: 'development',
      role: 'development',
      blockIds: ['variant-story-block-body'],
    },
    {
      id: 'resolution',
      role: 'resolution',
      blockIds: ['variant-story-block-cta'],
    },
  ],
  blocks: variantStoryBlocksExample,
  storyHash: 'e'.repeat(64),
}
const variantEditPlanExample = {
  id: 'variant-edit-plan-example-1',
  schemaVersion: 'variant-edit-plan/v1',
  compilerVersion: 'variant-recipe-compiler/v1',
  storyPlanId: variantStoryPlanExample.id,
  fps: 30,
  durationFrames: 360,
  outputBinding: 'deferred-to-output-matrix',
  trackIds: ['variant-video-track-example-1'],
  videoTracks: [
    {
      id: 'variant-video-track-example-1',
      kind: 'base-video',
      clips: variantRecipeLineageExample.map((lineage, index) => ({
        id: `variant-clip-example-${index + 1}`,
        storyBlockId: variantStoryBlocksExample[index].id,
        lineageId: lineage.id,
        sourceSegmentId: lineage.sourceSegmentId,
        sourceArtifactId: lineage.sourceArtifactId,
        sourceHash: lineage.sourceHash,
        sourceRangeMs: lineage.sourceRangeMs,
        timelineRangeFrames: [
          [0, 96],
          [96, 291],
          [291, 360],
        ][index],
        referenceMode: 'immutable-source',
        clipHash: ['b', 'c', 'd'][index].repeat(64),
      })),
    },
  ],
  masterReferences: [
    {
      sourceArtifactId: 'artifact-compatibility-example',
      sourceHashes: compatibilityNodesExample.map((node) =>
        node.sourceHash),
      referenceMode: 'immutable-source',
    },
  ],
  materializesSources: false,
  duplicatesMasters: false,
  editPlanHash: 'f'.repeat(64),
}
const variantRecipeRunExample = {
  id: 'variant-recipe-example-1',
  workspaceId,
  projectId,
  batchId: productionBatchExample.id,
  compatibilityGraphId: compatibilityGraphRunExample.id,
  compatibilityGraphRunHash: compatibilityGraphRunExample.runHash,
  takeLibraryId: takeLibraryRunExample.id,
  schemaVersion: 'variant-recipe/v1',
  policyVersion: 'variant-recipe-policy/v1',
  scoreVersion: 'variant-recipe-score/v1',
  compilerVersion: 'variant-recipe-compiler/v1',
  objective: productionBatchExample.objective,
  status: 'candidate',
  selection: {
    hookNodeId: compatibilityNodesExample[0].id,
    bodyNodeId: compatibilityNodesExample[1].id,
    ctaNodeId: compatibilityNodesExample[2].id,
  },
  orderedNodeIds: compatibilityNodesExample.map((node) => node.id),
  compatibilityEdgeIds:
    compatibilityGraphRunExample.edges.map((edge) => edge.id),
  sourceSegments: variantRecipeSourceSegmentsExample,
  assumptions: [
    {
      code: 'PROOF_OMITTED_BY_POLICY',
      statement: 'Content distribution permits a short recipe without proof under the active policy.',
      evidenceRefs: [
        'a'.repeat(64),
        compatibilityGraphRunExample.runHash,
      ],
      assumptionHash: 'd'.repeat(64),
    },
  ],
  proofPolicy: {
    version: 'variant-recipe-policy/v1',
    objective: productionBatchExample.objective,
    baseRequirement: 'optional',
    effectiveRequirement: 'optional',
    stricterRequestApplied: false,
    reasonCode: 'PROOF_OPTIONAL_FOR_OBJECTIVE',
    policyHash: 'a'.repeat(64),
  },
  scores: {
    version: 'variant-recipe-score/v1',
    minimumEdgeScore: 89.5,
    averageEdgeScore: 90.6425,
    weightedEdgeScore: 89.84275,
    objectiveScore: 100,
    lineageCompletenessScore: 100,
    totalScore: 92.19355,
    dimensions: [
      {
        dimension: 'minimum-edge',
        score: 89.5,
        weight: 0.55,
        evidenceRefs: compatibilityGraphRunExample.edges.map((edge) =>
          edge.edgeHash),
        reasonCode: 'WEAKEST_EDGE_PENALTY',
        scoreHash: '1'.repeat(64),
      },
      {
        dimension: 'weighted-edge',
        score: 89.84275,
        weight: 0.2,
        evidenceRefs: compatibilityGraphRunExample.edges.map((edge) =>
          edge.edgeHash),
        reasonCode: 'WEAKEST_EDGE_WEIGHTED',
        scoreHash: '2'.repeat(64),
      },
      {
        dimension: 'objective-fit',
        score: 100,
        weight: 0.2,
        evidenceRefs: compatibilityNodesExample.map((node) =>
          node.contextHash),
        reasonCode: 'OBJECTIVE_FIT',
        scoreHash: '3'.repeat(64),
      },
      {
        dimension: 'lineage-completeness',
        score: 100,
        weight: 0.05,
        evidenceRefs: variantRecipeLineageExample.map((entry) =>
          entry.lineageHash),
        reasonCode: 'LINEAGE_COMPLETE',
        scoreHash: '4'.repeat(64),
      },
    ],
    scoresHash: 'b'.repeat(64),
  },
  storyPlan: variantStoryPlanExample,
  editPlan: variantEditPlanExample,
  lineage: variantRecipeLineageExample,
  summary: {
    selectedTakeCount: 3,
    sourceSegmentCount: 3,
    lineageCount: 3,
    compatibilityEdgeCount: 2,
    estimatedDurationMs: 12000,
    estimatedDurationFrames: 360,
    includesProof: false,
    hasColdOpen: false,
    masterReferenceCount: 1,
  },
  createdByClientId: clientId,
  createdAt,
  runHash: 'c'.repeat(64),
}
const proofNeedCreateRequestExample = {
  batchId: variantRecipeRunExample.batchId,
  targetRecipeId: variantRecipeRunExample.id,
  expectedTargetRecipeHash: variantRecipeRunExample.runHash,
  policyVersion: 'proof-need-policy/v1',
  declarations: [
    {
      storyBlockId: variantStoryBlocksExample[1].id,
      claimId: variantStoryBlocksExample[1].content.claimIds[0],
      claimText: 'Clientes recuperaram confiança para falar em público.',
      claimKind: 'outcome',
      offerId: 'offer-immersao-example-1',
      objection: 'Ainda não acredito que funciona para mim.',
    },
  ],
}
const proofNeedMomentExample = {
  placement: 'after-claim-before-next-block',
  afterStoryBlockId:
    proofNeedCreateRequestExample.declarations[0].storyBlockId,
  beforeStoryBlockId: variantStoryBlocksExample[2].id,
  timelineFrame: 291,
  timelineMs: 9_700,
}
const proofNeedSelectedEvidenceExample = {
  id: 'evidence-proof-need-example-1',
  evidenceHash: '8'.repeat(64),
  category: 'testimonial',
  sourceArtifactId: 'artifact-proof-need-example-1',
  sourceRangeMs: [1_200, 7_800],
  contextRangeMs: [800, 8_300],
  score: 0.94,
}
const proofNeedItemExample = {
  id: 'proof-need-item-example-1',
  sequence: 1,
  storyBlockId:
    proofNeedCreateRequestExample.declarations[0].storyBlockId,
  claimId: proofNeedCreateRequestExample.declarations[0].claimId,
  claimText: proofNeedCreateRequestExample.declarations[0].claimText,
  claimKind: 'outcome',
  type: 'testimonial',
  function: 'build-trust',
  required: true,
  moment: proofNeedMomentExample,
  search: {
    strategy: 'evidence-first',
    attempted: true,
    categories: ['testimonial', 'case-study'],
    candidateEvidenceIds: [proofNeedSelectedEvidenceExample.id],
    rejectedEvidence: [],
  },
  resolution: 'selected-evidence',
  selectedEvidence: proofNeedSelectedEvidenceExample,
  proofUnavailable: false,
  genericCardGenerated: false,
  itemHash: '9'.repeat(64),
}
const proofDirectedStoryPlanExample = {
  schemaVersion: 'proof-directed-story-plan/v1',
  id: 'proof-directed-story-plan-example-1',
  baseStoryPlanId: variantStoryPlanExample.id,
  baseStoryPlanHash: variantStoryPlanExample.storyHash,
  objective: variantRecipeRunExample.objective,
  acts: variantStoryPlanExample.acts,
  blocks: variantStoryPlanExample.blocks,
  proofNeeds: [
    {
      id: proofNeedItemExample.id,
      storyBlockId: proofNeedItemExample.storyBlockId,
      claimId: proofNeedItemExample.claimId,
      type: proofNeedItemExample.type,
      function: proofNeedItemExample.function,
      required: true,
      moment: proofNeedMomentExample,
      resolution: 'selected-evidence',
      selectedEvidenceId: proofNeedSelectedEvidenceExample.id,
      proofUnavailable: false,
    },
  ],
  storyPlanHash: 'a'.repeat(64),
}
const proofNeedRunExample = {
  schemaVersion: 'proof-need-run/v1',
  policyVersion: 'proof-need-policy/v1',
  id: 'proof-need-run-example-1',
  workspaceId,
  projectId,
  batchId: variantRecipeRunExample.batchId,
  targetRecipeId: variantRecipeRunExample.id,
  targetRecipeHash: variantRecipeRunExample.runHash,
  baseStoryPlanId: variantStoryPlanExample.id,
  baseStoryPlanHash: variantStoryPlanExample.storyHash,
  objective: variantRecipeRunExample.objective,
  storyPlan: proofDirectedStoryPlanExample,
  items: [proofNeedItemExample],
  summary: {
    needCount: 1,
    requiredCount: 1,
    evidenceSearchCount: 1,
    selectedEvidenceCount: 1,
    proofUnavailableCount: 0,
    noProofNeededCount: 0,
    genericCardCount: 0,
  },
  createdByClientId: clientId,
  createdAt,
  runHash: 'b'.repeat(64),
}
const proofIntegrityCreateRequestExample = {
  proofNeedRunId: proofNeedRunExample.id,
  expectedProofNeedRunHash: proofNeedRunExample.runHash,
  policyVersion: 'proof-integrity-policy/v1',
  uses: [
    {
      proofNeedItemId: proofNeedItemExample.id,
      includedContextRangeMs:
        proofNeedSelectedEvidenceExample.contextRangeMs,
      includedAdjacentEvidenceIds: [],
    },
  ],
}
const proofIntegrityRecipeContextExample = {
  nodeId: 'compatibility-node-proof-example-1',
  nodeHash: 'c'.repeat(64),
  contextHash: 'd'.repeat(64),
  claimId: proofNeedItemExample.claimId,
  claimText: proofNeedItemExample.claimText,
  productId: 'offer-immersao-example-1',
  person: 'Cliente verificado',
  period: '2025',
  audienceTags: ['profissionais'],
  consentRequirement: 'approved',
  contextHashBinding: 'e'.repeat(64),
}
const proofIntegrityPresentationExample = {
  schemaVersion: 'proof-integrity-presentation/v1',
  evidenceId: proofNeedSelectedEvidenceExample.id,
  evidenceHash: proofNeedSelectedEvidenceExample.evidenceHash,
  requiredContextRangeMs:
    proofNeedSelectedEvidenceExample.contextRangeMs,
  requiredAdjacentEvidenceIds: [],
  visual: {
    attribution: 'Cliente verificado',
    qualifiers: ['period:2025'],
    mandatory: true,
  },
  verbal: {
    attribution: 'Cliente verificado',
    qualifiers: ['period:2025'],
    mandatory: true,
  },
  presentationHash: 'f'.repeat(64),
}
const proofIntegrityEvaluationExample = {
  id: 'proof-integrity-evaluation-example-1',
  sequence: 1,
  proofNeedItemId: proofNeedItemExample.id,
  proofNeedItemHash: proofNeedItemExample.itemHash,
  proofNeedResolution: 'selected-evidence',
  selectedEvidenceId: proofNeedSelectedEvidenceExample.id,
  selectedEvidenceHash:
    proofNeedSelectedEvidenceExample.evidenceHash,
  recipeContext: proofIntegrityRecipeContextExample,
  use: {
    includedContextRangeMs:
      proofNeedSelectedEvidenceExample.contextRangeMs,
    includedAdjacentEvidenceIds: [],
  },
  comparisons: [
    {
      dimension: 'claim',
      expected: [proofNeedItemExample.claimText],
      actual: [proofNeedItemExample.claimText],
      outcome: 'match',
    },
    {
      dimension: 'product',
      expected: ['offer-immersao-example-1'],
      actual: ['offer-immersao-example-1'],
      outcome: 'match',
    },
    {
      dimension: 'person',
      expected: ['Cliente verificado'],
      actual: ['Cliente verificado'],
      outcome: 'match',
    },
    {
      dimension: 'period',
      expected: ['2025'],
      actual: ['2025'],
      outcome: 'match',
    },
    {
      dimension: 'audience',
      expected: ['profissionais'],
      actual: ['profissionais'],
      outcome: 'match',
    },
    {
      dimension: 'rights',
      expected: ['approved'],
      actual: ['approved'],
      outcome: 'match',
    },
    {
      dimension: 'consent',
      expected: ['approved'],
      actual: ['approved'],
      outcome: 'match',
    },
    {
      dimension: 'context',
      expected: ['800-8300'],
      actual: ['800-8300'],
      outcome: 'match',
    },
  ],
  outcome: 'approved',
  allowedForAssembly: true,
  presentation: proofIntegrityPresentationExample,
  fabricationSuggested: false,
  evaluatedAt: createdAt,
  evaluationHash: '1'.repeat(64),
}
const proofIntegrityRunExample = {
  schemaVersion: 'proof-integrity-run/v1',
  policyVersion: 'proof-integrity-policy/v1',
  id: 'proof-integrity-run-example-1',
  workspaceId,
  projectId,
  batchId: proofNeedRunExample.batchId,
  targetRecipeId: proofNeedRunExample.targetRecipeId,
  targetRecipeHash: proofNeedRunExample.targetRecipeHash,
  proofNeedRunId: proofNeedRunExample.id,
  proofNeedRunHash: proofNeedRunExample.runHash,
  evaluations: [proofIntegrityEvaluationExample],
  summary: {
    evaluationCount: 1,
    approvedCount: 1,
    blockedCount: 0,
    notApplicableCount: 0,
    hardIssueCount: 0,
    fabricationSuggestionCount: 0,
    readyForAssembly: true,
  },
  createdByClientId: clientId,
  createdAt,
  runHash: '2'.repeat(64),
}
const proofModeCreateRequestExample = {
  proofIntegrityRunId: proofIntegrityRunExample.id,
  expectedProofIntegrityRunHash: proofIntegrityRunExample.runHash,
  policyVersion: 'proof-mode-policy/v1',
  formats: ['9:16'],
  rhythm: 'measured',
  overrides: [],
}
const proofModePlanExample = {
  id: 'proof-mode-plan-example-1',
  sequence: 1,
  proofIntegrityEvaluationId: proofIntegrityEvaluationExample.id,
  proofIntegrityEvaluationHash:
    proofIntegrityEvaluationExample.evaluationHash,
  proofNeedItemId: proofNeedItemExample.id,
  proofNeedItemHash: proofNeedItemExample.itemHash,
  claimText: proofNeedItemExample.claimText,
  sourceEvidenceId: proofNeedSelectedEvidenceExample.id,
  sourceEvidenceHash: proofNeedSelectedEvidenceExample.evidenceHash,
  sourceArtifactId: proofNeedSelectedEvidenceExample.sourceArtifactId,
  sourceMediaType: 'video',
  format: '9:16',
  rhythm: 'measured',
  mode: 'cutaway',
  selection: 'automatic',
  reasonCodes: ['MEASURED_VISUAL_CUTAWAY'],
  contextRequired: false,
  identificationRequired: true,
  presentation: proofIntegrityPresentationExample,
  timing: {
    timelineEntryFrame: proofNeedItemExample.moment.timelineFrame,
    timelineEntryMs: proofNeedItemExample.moment.timelineMs,
    sourceContextRangeMs:
      proofNeedSelectedEvidenceExample.contextRangeMs,
    minimumDurationFrames: 225,
    targetDurationFrames: 225,
    maximumDurationFrames: 240,
    entryTransition: {
      kind: 'crossfade',
      durationFrames: 6,
    },
    exitTransition: {
      kind: 'cut',
      durationFrames: 0,
    },
    timingHash: '3'.repeat(64),
  },
  layout: {
    schemaVersion: 'proof-mode-layout/v1',
    format: '9:16',
    canvas: { width: 1080, height: 1920 },
    safeRegion: {
      x: 54,
      y: 96,
      width: 972,
      height: 1728,
    },
    evidenceRegion: {
      x: 0,
      y: 0,
      width: 1080,
      height: 1920,
    },
    creditRegion: {
      x: 54,
      y: 1652,
      width: 972,
      height: 172,
    },
    qualifierRegion: {
      x: 54,
      y: 1486,
      width: 972,
      height: 130,
    },
    backgroundTreatment: 'source',
    layoutHash: '4'.repeat(64),
  },
  legibility: {
    minimumContrast: 4.5,
    minimumFontPixels: 28,
    maximumAttributionCharacters: 96,
    maximumQualifierCharacters: 160,
    safeAreaRequired: true,
  },
  rendererContract: {
    kind: 'proof-presentation',
    version: 1,
    materializesNewMedia: false,
  },
  planHash: '5'.repeat(64),
}
const proofModeRunExample = {
  schemaVersion: 'proof-mode-run/v1',
  policyVersion: 'proof-mode-policy/v1',
  id: 'proof-mode-run-example-1',
  workspaceId,
  projectId,
  batchId: proofIntegrityRunExample.batchId,
  proofIntegrityRunId: proofIntegrityRunExample.id,
  proofIntegrityRunHash: proofIntegrityRunExample.runHash,
  proofNeedRunId: proofNeedRunExample.id,
  proofNeedRunHash: proofNeedRunExample.runHash,
  formats: ['9:16'],
  rhythm: 'measured',
  plans: [proofModePlanExample],
  summary: {
    approvedEvidenceCount: 1,
    formatCount: 1,
    planCount: 1,
    automaticCount: 1,
    manualOverrideCount: 0,
    cutawayCount: 1,
    splitScreenCount: 0,
    proofCardCount: 0,
    allIntegrityBindingsPreserved: true,
    readyForCompilation: true,
  },
  createdByClientId: clientId,
  createdAt,
  runHash: '6'.repeat(64),
}
const variantPortfolioPreflightRunExample = {
  schemaVersion: 'variant-portfolio-preflight/v1',
  selectionVersion: 'variant-portfolio-selection/v1',
  id: 'variant-portfolio-preflight-example-1',
  workspaceId,
  projectId,
  batchId: productionBatchExample.id,
  compatibilityGraphId: compatibilityGraphRunExample.id,
  compatibilityGraphRunHash: compatibilityGraphRunExample.runHash,
  takeLibraryId: takeLibraryRunExample.id,
  objective: productionBatchExample.objective,
  policy: {
    schemaVersion: 'variant-portfolio-policy/v1',
    workspaceId,
    revision: 1,
    defaultRecipeLimit: 12,
    maxRecipeLimit: 50,
    maxOutputCount: 250,
    minCompatibilityEdgeScore: 70,
    minRecipeScore: 70,
    minHookCoverage: 2,
    minBodyCoverage: 2,
    minCtaCoverage: 2,
    maxRecipesPerSemanticCluster: 2,
    maxCandidateScanCount: 10000,
    estimatedCostPerOutputMinorUnits: 25,
    estimatedDurationSecondsPerOutput: 45,
    estimatedStorageBytesPerOutput: 50000000,
    maxConcurrentJobs: 4,
    confirmationTtlSeconds: 900,
    updatedByClientId: clientId,
    updatedAt: createdAt,
    policyHash: '1'.repeat(64),
  },
  status: 'confirmation-required',
  requestedRecipeCount: 20,
  effectiveRecipeLimit: 12,
  batchVariantCount: 2,
  budgetRemainingMinorUnits: 10000,
  theoreticalCandidateCount: '54',
  eligibleCandidateCount: '3',
  scannedCandidateCount: 3,
  scanTruncated: false,
  selectedRecipeCount: 1,
  productMaterialized: false,
  confirmation: {
    required: true,
    satisfied: false,
    threshold: 12,
    expiresAt: '2026-07-28T03:15:00.000Z',
    confirmationHash: '2'.repeat(64),
  },
  coverage: {
    required: { hooks: 2, bodies: 2, ctas: 2 },
    achieved: { hooks: 1, bodies: 1, ctas: 1 },
    complete: false,
    reasonCodes: [
      'BODY_COVERAGE_UNAVAILABLE_AT_QUALITY_THRESHOLD',
      'CTA_COVERAGE_UNAVAILABLE_AT_QUALITY_THRESHOLD',
      'HOOK_COVERAGE_UNAVAILABLE_AT_QUALITY_THRESHOLD',
    ],
    coverageHash: '3'.repeat(64),
  },
  selected: [
    {
      rank: 1,
      selection: variantRecipeRunExample.selection,
      orderedNodeIds: variantRecipeRunExample.orderedNodeIds,
      compatibilityEdgeIds:
        variantRecipeRunExample.compatibilityEdgeIds,
      minimumEdgeScore: 89.5,
      averageEdgeScore: 90.642,
      totalScore: 92.194,
      semanticClusterHash: '4'.repeat(64),
      noveltyScore: 1,
      reusableRecipeId: variantRecipeRunExample.id,
      reusableRecipeRunHash: variantRecipeRunExample.runHash,
      candidateHash: '5'.repeat(64),
    },
  ],
  exclusions: {
    hardFilterCount: '51',
    belowQualityCount: 0,
    duplicateCount: 0,
    semanticClusterCount: 0,
    budgetCount: 0,
    capacityCount: 2,
    reasonCodes: [
      'HARD_COMPATIBILITY_FILTER',
      'PORTFOLIO_CAPACITY_LIMIT',
    ],
    exclusionsHash: '6'.repeat(64),
  },
  estimates: {
    version: 'variant-portfolio-estimate/v1',
    currency: 'USD',
    outputVariantCount: 2,
    reusedRecipeCount: 1,
    reusedOutputCount: 2,
    plannedJobCount: 0,
    jobsCreated: 0,
    estimatedCostMinorUnits: 0,
    estimatedDurationSeconds: 0,
    estimatedStorageBytes: 0,
    expectedReuseRate: 1,
    estimateHash: '7'.repeat(64),
  },
  warningCodes: [
    'EXPANSION_CONFIRMATION_REQUIRED',
    'MINIMUM_COVERAGE_NOT_REACHED',
    'QUALITY_LIMITED_PORTFOLIO',
  ],
  createdByClientId: clientId,
  createdAt,
  runHash: '8'.repeat(64),
}
const variantPortfolioPreflightResultExample = {
  schemaVersion: 'preflight-result/v1',
  eligible: false,
  fingerprint: '9'.repeat(64),
  evaluatedAt: createdAt,
  targets: [
    {
      kind: 'variant-recipe-candidate',
      id: variantPortfolioPreflightRunExample.selected[0].candidateHash,
      version:
        variantPortfolioPreflightRunExample.selected[0]
          .reusableRecipeRunHash,
    },
  ],
  conflicts: [
    {
      code: 'CONFIRMATION_REQUIRED',
      target: variantPortfolioPreflightRunExample.id,
      message: 'Variant portfolio expansion requires confirmation',
    },
  ],
  invalidations: [],
  jobs: [],
  cost: {
    currency: 'USD',
    estimatedMinorUnits: 0,
    maximumMinorUnits: 0,
  },
  quota: {
    unit: 'USD-minor-unit',
    required: 0,
    remaining:
      variantPortfolioPreflightRunExample.budgetRemainingMinorUnits,
    allowed: true,
  },
  warnings: variantPortfolioPreflightRunExample.warningCodes.map(
    (code) => ({
      code,
      message: code.toLowerCase().replaceAll('_', ' '),
    }),
  ),
}
const batchEditPolicyExample = {
  schemaVersion: 'batch-edit-policy/v1',
  workspaceId,
  revision: 1,
  defaultMode: 'all-or-nothing',
  maxItemCount: 100,
  diffSampleSize: 5,
  replaceCtaCostMinorUnits: 125,
  subtitleStyleCostMinorUnits: 25,
  brandKitCostMinorUnits: 75,
  confirmationTtlSeconds: 900,
  updatedByClientId: clientId,
  updatedAt: createdAt,
  policyHash: '9'.repeat(64),
}
const batchEditBeforeStateExample = {
  schemaVersion: 'batch-edit-item-state/v1',
  workspaceId,
  batchId: productionBatchExample.id,
  itemId: productionBatchExample.items[0].id,
  revision: 1,
  directives: {},
  protectedOperations: [],
  createdByClientId: clientId,
  createdAt,
  stateHash: 'a'.repeat(64),
}
const batchEditTargetRef =
  `${productionBatchExample.items[0].id}:subtitle-style`
const batchEditScopeExample = {
  recipeIds: ['recipe-hook'],
  outputSpecIds: ['9:16'],
  itemIds: [productionBatchExample.items[0].id],
  scopeHash: 'b'.repeat(64),
}
const batchEditPreflightExample = {
  schemaVersion: 'batch-edit-preflight/v1',
  impactVersion: 'batch-edit-impact/v1',
  id: 'batch-edit-preflight-example-1',
  workspaceId,
  projectId,
  batchId: productionBatchExample.id,
  batchRevision: 1,
  batchDefinitionHash: productionBatchExample.definitionHash,
  policy: batchEditPolicyExample,
  mode: 'all-or-nothing',
  operation: {
    type: 'subtitle-style',
    valueRef: 'subtitle-style-bold-purple',
  },
  scope: batchEditScopeExample,
  status: 'ready',
  budgetRemainingMinorUnits: 3200,
  affectedItemCount: 1,
  applicableItemCount: 1,
  protectedConflictCount: 0,
  unchangedItemCount: 0,
  invalidationCount: 2,
  estimatedCostMinorUnits: 25,
  budgetExceeded: false,
  impacts: [
    {
      itemId: productionBatchExample.items[0].id,
      recipeId: 'recipe-hook',
      variantId: 'variant-vertical',
      outputSpecId: '9:16',
      locale: 'pt-BR',
      targetRef: batchEditTargetRef,
      disposition: 'applicable',
      afterValueRef: 'subtitle-style-bold-purple',
      beforeStateRevision: 1,
      beforeStateHash: batchEditBeforeStateExample.stateHash,
      protectedConflict: false,
      conflictCodes: [],
      invalidatedSteps: ['rendering', 'reviewing'],
      invalidatedTargetRefs: [
        `${batchEditTargetRef}:rendering`,
        `${batchEditTargetRef}:reviewing`,
      ],
      estimatedCostMinorUnits: 25,
      impactHash: 'c'.repeat(64),
    },
  ],
  sampleDiff: [
    {
      itemId: productionBatchExample.items[0].id,
      recipeId: 'recipe-hook',
      outputSpecId: '9:16',
      targetRef: batchEditTargetRef,
      before: { mode: 'inherit' },
      after: {
        mode: 'override',
        valueRef: 'subtitle-style-bold-purple',
      },
      disposition: 'applicable',
      conflictCodes: [],
      diffHash: 'd'.repeat(64),
    },
  ],
  warningCodes: ['PARTIAL_FORMAT_SCOPE', 'PARTIAL_RECIPE_SCOPE'],
  confirmationExpiresAt: '2026-07-12T20:15:00.000Z',
  costFingerprint: 'e'.repeat(64),
  createdByClientId: clientId,
  createdAt,
  preflightHash: 'f'.repeat(64),
}
const batchEditPreflightResultExample = {
  schemaVersion: 'preflight-result/v1',
  eligible: true,
  fingerprint: '0'.repeat(64),
  evaluatedAt: createdAt,
  targets: [
    {
      kind: 'batch-item',
      id: productionBatchExample.items[0].id,
      version: '1',
    },
  ],
  conflicts: [],
  invalidations: [
    {
      kind: 'render',
      id: `${batchEditTargetRef}:rendering`,
      reason: 'subtitle-style invalidates rendering',
    },
    {
      kind: 'proxy',
      id: `${batchEditTargetRef}:reviewing`,
      reason: 'subtitle-style invalidates reviewing',
    },
  ],
  jobs: [
    { kind: 'batch-rendering', count: 1 },
    { kind: 'batch-reviewing', count: 1 },
  ],
  cost: {
    currency: 'USD',
    estimatedMinorUnits: 25,
    maximumMinorUnits: 25,
  },
  quota: {
    unit: 'USD-minor-unit',
    required: 25,
    remaining: 3200,
    allowed: true,
  },
  warnings: batchEditPreflightExample.warningCodes.map((code) => ({
    code,
    message: code.toLowerCase().replaceAll('_', ' '),
  })),
}
const batchEditAfterStateExample = {
  ...batchEditBeforeStateExample,
  revision: 2,
  directives: { subtitleStyleId: 'subtitle-style-bold-purple' },
  previousStateHash: batchEditBeforeStateExample.stateHash,
  sourceCommandId: 'batch-edit-command-example-1',
  stateHash: '1'.repeat(64),
}
const batchEditCommandExample = {
  schemaVersion: 'batch-edit-command/v1',
  id: 'batch-edit-command-example-1',
  workspaceId,
  projectId,
  batchId: productionBatchExample.id,
  preflightId: batchEditPreflightExample.id,
  preflightHash: batchEditPreflightExample.preflightHash,
  batchRevision: 1,
  batchDefinitionHash: productionBatchExample.definitionHash,
  policyHash: batchEditPolicyExample.policyHash,
  mode: 'all-or-nothing',
  operation: batchEditPreflightExample.operation,
  scope: batchEditScopeExample,
  status: 'committed',
  resultItems: [
    {
      itemId: productionBatchExample.items[0].id,
      recipeId: 'recipe-hook',
      variantId: 'variant-vertical',
      outputSpecId: '9:16',
      targetRef: batchEditTargetRef,
      status: 'applied',
      beforeStateRevision: 1,
      beforeStateHash: batchEditBeforeStateExample.stateHash,
      afterStateRevision: 2,
      afterStateHash: batchEditAfterStateExample.stateHash,
      conflictCodes: [],
      invalidatedSteps: ['rendering', 'reviewing'],
      invalidatedTargetRefs: [
        `${batchEditTargetRef}:rendering`,
        `${batchEditTargetRef}:reviewing`,
      ],
      costMinorUnits: 25,
      resultHash: '2'.repeat(64),
    },
  ],
  newStates: [batchEditAfterStateExample],
  affectedItemCount: 1,
  appliedItemCount: 1,
  skippedItemCount: 0,
  unchangedItemCount: 0,
  invalidationCount: 2,
  costMinorUnits: 25,
  createdByClientId: clientId,
  createdAt,
  commandHash: '3'.repeat(64),
}

const contiguousExtractionRequestExample = {
  objective: 'education',
  topic: 'aquisicao por anuncios',
  targetDurationMs: 120_000,
  toleranceMs: 15_000,
  fps: 30,
}
const contiguousCandidateHash = 'c'.repeat(64)
const contiguousExtractionExample = {
  schemaVersion: 'contiguous-extraction-result/v1',
  policyVersion: 'contiguous-extraction/v1',
  id: 'contiguous-extraction-example-1',
  workspaceId,
  projectId,
  objective: contiguousExtractionRequestExample.objective,
  topic: contiguousExtractionRequestExample.topic,
  targetDurationMs: contiguousExtractionRequestExample.targetDurationMs,
  toleranceMs: contiguousExtractionRequestExample.toleranceMs,
  candidates: [
    {
      sourceIndexRunId: longFormIndexRunExample.id,
      sourceMomentId: longFormMomentTrafficExample.id,
      sourceMomentHash: longFormMomentTrafficExample.momentHash,
      sourceEvaluationId: 'contiguous-evaluation-example-1',
      sourceEvaluationHash: 'b'.repeat(64),
      sourceEvaluationProducer: {
        provider: 'apollo',
        model: 'contiguous-quality-evaluator',
        version: '1.0.0',
        inputHash: '1'.repeat(64),
        outputHash: '2'.repeat(64),
      },
      sourceRangeMs: [3_495_000, 3_615_000],
      durationMs: 120_000,
      durationDeltaMs: 0,
      score: 0.92,
      scoreBreakdown: {
        selfContained: 0.94,
        density: 0.91,
        integrity: 0.96,
        audio: 0.9,
        visual: 0.89,
        duration: 1,
      },
      evidenceRefs: [
        'evidence-contiguous-self-contained',
        'evidence-contiguous-density',
        'evidence-contiguous-integrity',
        'evidence-contiguous-audio',
        'evidence-contiguous-visual',
      ],
      candidateHash: contiguousCandidateHash,
    },
  ],
  selectedCandidateHash: contiguousCandidateHash,
  storyPlan: {
    schemaVersion: 1,
    id: 'contiguous-extraction-example-1:story-plan',
    mode: 'contiguous',
    sourceRangeId: 'contiguous-extraction-example-1:source-range',
    objective: contiguousExtractionRequestExample.objective,
    targetDurationMs: { min: 120_000, max: 120_000 },
    acts: [
      {
        id: 'contiguous-extraction-example-1:development',
        role: 'development',
        blockIds: ['contiguous-extraction-example-1:source-block'],
      },
    ],
    blocks: [
      {
        id: 'contiguous-extraction-example-1:source-block',
        actId: 'contiguous-extraction-example-1:development',
        role: 'argument',
        intent: contiguousExtractionRequestExample.objective,
        dependencies: [],
        sourceCandidateIds: [longFormMomentTrafficExample.id],
        durationTargetMs: {
          min: 120_000,
          ideal: 120_000,
          max: 120_000,
        },
        content: { claimIds: [], qualifierIds: [], proofIds: [] },
        presentation: 'source-video',
        sourceRangeId: 'contiguous-extraction-example-1:source-range',
      },
    ],
  },
  editPlan: {
    schemaVersion: 2,
    state: 'compiled',
    mode: 'contiguous',
    id: 'contiguous-extraction-example-1:edit-plan',
    storyPlanId: 'contiguous-extraction-example-1:story-plan',
    fps: 30,
    durationFrames: 3_600,
    sources: [
      {
        id: 'contiguous-extraction-example-1:source',
        artifactId: longFormIndexRunExample.sourceArtifactId,
        artifactSha256: longFormIndexRunExample.sourceArtifactSha256,
        manifestId: longFormIndexRunExample.sourceManifestId,
        manifestHash: longFormIndexRunExample.sourceManifestHash,
        kind: 'video',
      },
    ],
    videoTracks: [
      {
        id: 'contiguous-extraction-example-1:base-video',
        kind: 'base-video',
        clips: [
          {
            id: 'contiguous-extraction-example-1:clip',
            sourceArtifactId: longFormIndexRunExample.sourceArtifactId,
            sourceInFrame: 104_850,
            sourceOutFrame: 108_450,
            timelineInFrame: 0,
            timelineOutFrame: 3_600,
            rate: 1,
          },
        ],
      },
    ],
    synthesizedRanges: false,
    lineageRefs: [
      longFormIndexRunExample.id,
      longFormChapterTrafficExample.id,
      longFormMomentTrafficExample.id,
      longFormMomentTrafficExample.momentHash,
      'contiguous-evaluation-example-1',
      'b'.repeat(64),
      rightsSnapshotId,
      'evidence-contiguous-self-contained',
    ],
    movementPolicy: {
      automaticZoom: false,
      reason: 'contiguous-source-preservation',
    },
    selectionHash: contiguousCandidateHash,
  },
  resultHash: 'd'.repeat(64),
  createdBy: { type: 'api-client', id: clientId },
  createdAt,
}

const editorialCutImpactExample = {
  schemaVersion: 'editorial-cut-impact/v1',
  commandId: 'edit-command-editorial-example-1',
  commandType: 'remove-spoken-content',
  baseVersionId: 'project-version-example-1',
  resultVersionId: 'project-version-example-2',
  sourceTranscriptId: 'transcript-example-1',
  sourceTranscriptHash: '1'.repeat(64),
  changeKinds: ['spoken-content-removal'],
  dependencyTypes: ['audio', 'content', 'timing', 'visual'],
  affectedRanges: [{ startFrame: 0, endFrame: 3065 }],
  affectedVariantIds: ['9:16'],
  affectedArtifacts: [{
    artifactId: 'artifact-proxy-example-1', kind: 'proxy',
    sourceVersionId: 'project-version-example-1', variantId: '9:16',
  }],
  minimalRenders: [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 0, endFrame: 2955 }] }],
  renderSemanticsChanged: true,
  impactHash: '2'.repeat(64),
}
const editorialCutInvalidationExample = {
  schemaVersion: 'command-artifact-invalidation/v1', id: '3'.repeat(64), status: 'stale',
  commandId: editorialCutImpactExample.commandId,
  baseVersionId: editorialCutImpactExample.baseVersionId,
  resultVersionId: editorialCutImpactExample.resultVersionId,
  artifactId: 'artifact-proxy-example-1', kind: 'proxy', variantId: '9:16',
  dependencyTypes: editorialCutImpactExample.dependencyTypes,
  affectedRanges: editorialCutImpactExample.affectedRanges,
  impactHash: editorialCutImpactExample.impactHash,
  createdAt,
}
const directorRunImpactExample = {
  schemaVersion: 'director-run-impact/v1',
  commandId: 'edit-command-director-example-1',
  commandType: 'run-director',
  baseVersionId: 'project-version-example-3',
  resultVersionId: 'project-version-example-4',
  sourceTranscriptId: 'transcript-example-1',
  sourceTranscriptHash: '4'.repeat(64),
  plannerVersion: 'apollo-director-policy/v1',
  criticVersion: 'apollo-director-critic/v1',
  changeKinds: ['director-replan'],
  dependencyTypes: ['audio', 'content', 'policy', 'timing', 'visual'],
  affectedRanges: [{ startFrame: 0, endFrame: 3065 }],
  affectedVariantIds: ['9:16'],
  affectedArtifacts: [{
    artifactId: 'artifact-proxy-example-3', kind: 'proxy',
    sourceVersionId: 'project-version-example-3', variantId: '9:16',
  }],
  minimalRenders: [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 0, endFrame: 2380 }] }],
  renderSemanticsChanged: true,
  impactHash: '5'.repeat(64),
}
const directorRunInvalidationExample = {
  schemaVersion: 'command-artifact-invalidation/v1', id: '6'.repeat(64), status: 'stale',
  commandId: directorRunImpactExample.commandId,
  baseVersionId: directorRunImpactExample.baseVersionId,
  resultVersionId: directorRunImpactExample.resultVersionId,
  artifactId: 'artifact-proxy-example-3', kind: 'proxy', variantId: '9:16',
  dependencyTypes: directorRunImpactExample.dependencyTypes,
  affectedRanges: directorRunImpactExample.affectedRanges,
  impactHash: directorRunImpactExample.impactHash,
  createdAt,
}
const projectLutSelectionImpactExample = {
  schemaVersion: 'project-lut-selection-impact/v1',
  commandId: projectLutSelectionExample.command.id,
  commandType: 'set-project-lut-selection',
  baseVersionId: projectLutSelectionExample.command.baseVersionId,
  resultVersionId: projectLutSelectionExample.version.id,
  selectionId: projectLutSelectionExample.selection.id,
  selectionHash: projectLutSelectionExample.selection.selectionHash,
  resolvedMode: 'lut-version',
  resolvedLutVersionId: workspaceLutExample.currentVersion.id,
  resolvedLutRecordHash: workspaceLutExample.currentVersion.recordHash,
  intensity: projectLutSelectionExample.selection.intensity,
  changeKinds: ['color-pipeline-selection'], dependencyTypes: ['visual'],
  affectedRanges: [{ startFrame: 0, endFrame: 2380 }],
  affectedVariantIds: ['9:16'],
  affectedArtifacts: [{
    artifactId: 'artifact-project-lut-proxy-example-1', kind: 'proxy',
    sourceVersionId: projectLutSelectionExample.command.baseVersionId, variantId: '9:16',
  }],
  minimalRenders: [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 0, endFrame: 2380 }] }],
  renderSemanticsChanged: true, renderDeferredUntilTimeline: false, impactHash: '7'.repeat(64),
}
const projectLutSelectionInvalidationExample = {
  schemaVersion: 'command-artifact-invalidation/v1', id: '8'.repeat(64), status: 'stale',
  commandId: projectLutSelectionImpactExample.commandId,
  baseVersionId: projectLutSelectionImpactExample.baseVersionId,
  resultVersionId: projectLutSelectionImpactExample.resultVersionId,
  artifactId: 'artifact-project-lut-proxy-example-1', kind: 'proxy', variantId: '9:16',
  dependencyTypes: ['visual'], affectedRanges: projectLutSelectionImpactExample.affectedRanges,
  impactHash: projectLutSelectionImpactExample.impactHash, createdAt,
}
const projectLutSelectionExampleV2 = {
  ...projectLutSelectionExample,
  impact: projectLutSelectionImpactExample,
  invalidations: [projectLutSelectionInvalidationExample],
}
const projectLutSelectionDeferredImpactExample = {
  ...projectLutSelectionImpactExample,
  commandId: 'project-lut-command-deferred-example-1',
  resultVersionId: 'project-version-example-lut-deferred-2',
  selectionId: 'project-lut-selection-deferred-example-1',
  selectionHash: '9'.repeat(64),
  resolvedMode: 'none', resolvedLutVersionId: null, resolvedLutRecordHash: null, intensity: 1,
  affectedRanges: [], affectedVariantIds: [], affectedArtifacts: [], minimalRenders: [],
  renderDeferredUntilTimeline: true, impactHash: 'a'.repeat(64),
}
const projectLutSelectionDeferredExampleV2 = {
  command: {
    id: projectLutSelectionDeferredImpactExample.commandId, type: 'set-project-lut-selection',
    baseVersionId: projectLutSelectionDeferredImpactExample.baseVersionId,
    author: { type: 'api-client', id: clientId }, reason: 'Persist selection before ingest.', createdAt,
  },
  version: {
    id: projectLutSelectionDeferredImpactExample.resultVersionId, sequence: 2,
    parentVersionId: projectLutSelectionDeferredImpactExample.baseVersionId,
    baseHash: 'b'.repeat(64), createdAt,
  },
  selection: {
    id: projectLutSelectionDeferredImpactExample.selectionId,
    requested: { mode: 'none' }, resolved: { mode: 'none' }, intensity: 1,
    selectionHash: projectLutSelectionDeferredImpactExample.selectionHash, createdAt,
  },
  impact: projectLutSelectionDeferredImpactExample,
  invalidations: [], replayed: false,
}
const currentProjectVersionVisibleStateExample = {
  schemaVersion: 'visible-state/v1', label: 'current', tone: 'info',
  progress: { mode: 'none' }, primaryAction: 'open-result',
  availableActions: ['open-result'], terminal: false,
}
const projectLutSelectionExampleV3 = {
  ...projectLutSelectionExampleV2,
  version: {
    ...projectLutSelectionExampleV2.version,
    visibleState: currentProjectVersionVisibleStateExample,
  },
}
const projectLutSelectionDeferredExampleV3 = {
  ...projectLutSelectionDeferredExampleV2,
  version: {
    ...projectLutSelectionDeferredExampleV2.version,
    visibleState: currentProjectVersionVisibleStateExample,
  },
}

export const PUBLIC_SCHEMA_EXAMPLES: Readonly<Record<string, readonly unknown[]>> =
  Object.freeze({
    'apollo://schemas/health-response/v1': [
      {
        data: { service: 'apollo-video', status: 'ok' },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/ui-session-create-request/v1': [
      { username: 'apollo-operator', password: 'example-password-not-a-secret', next: '/' },
    ],
    'apollo://schemas/ui-session-created/v1': [
      {
        data: {
          subject: 'apollo-operator',
          workspaceId,
          expiresAt: '2026-07-13T08:00:00.000Z',
          redirectTo: '/',
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/oidc-authorization-start-request/v1': [
      { next: '/projects' },
    ],
    'apollo://schemas/oidc-authorization-started/v1': [
      {
        data: {
          authorizationUrl: 'https://identity.example.test/authorize?response_type=code',
          recoveryUrl: 'https://identity.example.test/recovery',
          expiresAt: '2026-08-02T20:10:00.000Z',
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/oidc-callback-request/v1': [
      { code: 'authorization-code-123', state: 's'.repeat(43) },
    ],
    'apollo://schemas/oidc-session-created/v1': [
      {
        data: {
          workspaceId,
          memberId: '00000000-0000-4000-8000-000000000901',
          role: 'administrator',
          expiresAt: '2026-08-03T08:00:00.000Z',
          redirectTo: '/projects',
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/ui-session-status/v1': [
      {
        data: {
          subject: 'apollo-operator',
          workspaceId,
          expiresAt: '2026-07-13T08:00:00.000Z',
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/ui-session-ended/v1': [
      { data: { signedOut: true }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/capability-list/v1': [
      {
        data: {
          capabilities: [
            {
              id: 'apollo.health.read',
              version: '1.0.0',
              title: 'Read API health',
              description: 'Returns API liveness.',
              operationKind: 'query',
              authMode: 'none',
              requiredScopes: [],
              outputSchemaRef: 'apollo://schemas/health-response/v1',
              endpoint: { method: 'GET', path: '/v1/health' },
              toolName: 'apollo.health.read',
              supportsDryRun: false,
              costClass: 'free',
              confirmation: 'none',
              successStatuses: [200],
              idempotency: 'not-applicable',
              responseMediaType: 'application/json',
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/public-event/v1': [
      {
        id: '123e4567-e89b-42d3-a456-426614174000',
        type: 'operation.status.changed',
        version: '1.0.0',
        workspaceId,
        occurredAt: createdAt,
        sequence: 7,
        actor: { clientId },
        resource: { type: 'operation', id: 'operation-render-example-1' },
        data: { previousStatus: 'queued', status: 'running' },
      },
    ],
    'apollo://schemas/event-catalog/v1': [
      {
        data: {
          envelopeSchemaRef: 'apollo://schemas/public-event/v1',
          events: PUBLIC_EVENT_CATALOG.map((descriptor) => ({ ...descriptor })),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-list/v1': [
      { data: { projects: [] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/project-list/v2': [
      { data: { projects: [] }, meta: { apiVersion: 'v1' } },
      {
        data: {
          projects: [
            {
              id: projectId,
              workspaceId,
              name: 'Anúncio de descoberta',
              status: 'draft',
              currentVersionId: 'project-version-example-1',
              createdAt,
            },
          ],
          nextCursor: Buffer.from('project-page-example').toString('base64url'),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-detail/v1': [
      {
        data: {
          artifact: {
            id: artifactId,
            workspaceId,
            artifactKey: 'artifact:artifact-example-final-1',
            sha256: 'b'.repeat(64),
            byteSize: '2849012',
            mediaType: 'video',
            container: 'mp4',
            status: 'available',
            createdAt,
          },
          manifests: [
            {
              id: 'manifest-example-1',
              schemaVersion: 'media-artifact-manifest/v1',
              manifestHash: 'c'.repeat(64),
              recipe: {
                id: 'normalize-video',
                version: '1.0.0',
                parametersHash: 'd'.repeat(64),
              },
              probe: { width: 1080, height: 1920, duration: 32.5, fps: 30 },
              sources: [
                {
                  artifactId: 'artifact-source-example-1',
                  artifactKey: 'artifact:artifact-example-source-1',
                  sha256: 'a'.repeat(64),
                  role: 'primary',
                  ordinal: 0,
                },
              ],
              createdAt,
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-lineage-diagnostic/v1': [
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-1',
          healthy: true,
          nodes: [
            {
              artifactId: 'artifact-source-example-1',
              artifactKey: 'artifact:artifact-example-source-1',
              sha256: 'a'.repeat(64),
              status: 'available',
              manifestCount: 1,
              selectedManifest: {
                id: 'manifest-source-example-1',
                manifestHash: 'e'.repeat(64),
                schemaVersion: 'media-artifact-manifest/v1',
                recipe: {
                  id: 'ingest-source',
                  version: '1.0.0',
                  parametersHash: 'f'.repeat(64),
                },
              },
            },
            {
              artifactId,
              artifactKey: 'artifact:artifact-example-final-1',
              sha256: 'b'.repeat(64),
              status: 'available',
              manifestCount: 1,
              selectedManifest: {
                id: 'manifest-example-1',
                manifestHash: 'c'.repeat(64),
                schemaVersion: 'media-artifact-manifest/v1',
                recipe: {
                  id: 'normalize-video',
                  version: '1.0.0',
                  parametersHash: 'd'.repeat(64),
                },
              },
            },
          ],
          edges: [
            {
              sourceArtifactId: 'artifact-source-example-1',
              targetArtifactId: artifactId,
              sha256: 'a'.repeat(64),
              role: 'primary',
              ordinal: 0,
            },
          ],
          issues: [],
          limits: { maxNodes: 256, maxDepth: 32, truncated: false },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-execution-provenance/v1': [
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-2',
          schemaVersion: 'media-artifact-manifest/v2',
          manifestHash: '1'.repeat(64),
          complete: true,
          edges: [
            {
              sourceArtifactId: 'artifact-source-example-1',
              role: 'primary',
              ordinal: 0,
              execution: {
                tool: {
                  id: 'heygen-adapter',
                  version: '2.1.0',
                  digest: '2'.repeat(64),
                },
                model: {
                  provider: 'heygen',
                  id: 'avatar-iv',
                  version: '2026.07',
                  configHash: '3'.repeat(64),
                },
              },
            },
          ],
          issues: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-replay-spec/v1': [
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-3',
          schemaVersion: 'media-artifact-manifest/v3',
          manifestHash: '4'.repeat(64),
          recipe: {
            id: 'normalize-video',
            version: 'v3',
            parametersHash: '5'.repeat(64),
          },
          available: true,
          parameters: {
            ref: `recipe-parameters/sha256/${'5'.repeat(64)}`,
            canonicalByteSize: 42,
            protection: { algorithm: 'aes-256-gcm' },
          },
          issues: [],
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-legacy',
          schemaVersion: 'media-artifact-manifest/v2',
          manifestHash: '6'.repeat(64),
          recipe: {
            id: 'normalize-video',
            version: 'v2',
            parametersHash: '7'.repeat(64),
          },
          available: false,
          issues: [
            {
              code: 'REPLAY_PARAMETERS_MISSING',
              message: 'Manifest predates protected replay parameters',
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-render-input/v1': [
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-4',
          schemaVersion: 'media-artifact-manifest/v4',
          manifestHash: '8'.repeat(64),
          available: true,
          renderInput: {
            ref: `render-input/sha256/${'9'.repeat(64)}`,
            inputHash: '9'.repeat(64),
            canonicalByteSize: 2048,
            protection: { algorithm: 'aes-256-gcm' },
          },
          issues: [],
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-legacy',
          schemaVersion: 'media-artifact-manifest/v3',
          manifestHash: 'a'.repeat(64),
          available: false,
          issues: [
            {
              code: 'RENDER_INPUT_MISSING',
              message: 'Manifest predates protected RenderInput',
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-reconstruction-preflight/v1': [
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-4',
          schemaVersion: 'media-artifact-manifest/v4',
          manifestHash: '8'.repeat(64),
          validationScope: 'protected-input-and-asset-identity',
          rightsValidationRequired: true,
          materializationRequired: true,
          payloadAuthenticated: true,
          eligible: true,
          inputHash: '9'.repeat(64),
          renderer: {
            id: 'remotion',
            version: '4.0.489',
            digest: '7'.repeat(64),
            supported: true,
          },
          composition: {
            id: 'apollo-video',
            version: 'v1',
            propsSchemaRef: 'apollo://render-props/apollo-video/v1',
            supported: true,
          },
          assets: { total: 1, available: 1 },
          issues: [],
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          artifactId,
          manifestId: 'manifest-example-legacy',
          schemaVersion: 'media-artifact-manifest/v3',
          manifestHash: 'a'.repeat(64),
          validationScope: 'protected-input-and-asset-identity',
          rightsValidationRequired: true,
          materializationRequired: true,
          payloadAuthenticated: false,
          eligible: false,
          assets: { total: 0, available: 0 },
          issues: [
            {
              code: 'RENDER_INPUT_MISSING',
              message: 'Manifest predates protected RenderInput',
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/set-asset-rights-request/v1': [
      assetRightsRequestExample,
    ],
    'apollo://schemas/asset-rights-current/v1': [
      {
        data: {
          artifactId,
          configured: true,
          rights: assetRightsSnapshotExample,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: { artifactId, configured: false },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/asset-rights-set/v1': [
      {
        data: {
          artifactId,
          rights: assetRightsSnapshotExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/authorize-materialization-request/v1': [
      { use: 'paid-ad', market: 'BR', syntheticOperations: [] },
    ],
    'apollo://schemas/materialization-authorization/v1': [
      {
        data: {
          authorization: {
            schemaVersion: 'materialization-authorization/v1',
            id: 'materialization-auth-example-1',
            artifactId,
            manifestId: 'manifest-example-4',
            inputHash: '9'.repeat(64),
            use: 'paid-ad',
            market: 'BR',
            locale: 'pt-BR',
            syntheticOperations: [],
            status: 'authorized',
            issues: [],
            decisions: [
              {
                artifactId,
                assetOrdinal: 0,
                assetKind: 'video',
                outcome: 'allow',
                reasonCodes: [],
                rightsSnapshotId,
                rightsSnapshotHash: '6'.repeat(64),
                validUntil: '2026-07-12T20:05:00.000Z',
              },
            ],
            evaluatedAt: createdAt,
            validUntil: '2026-07-12T20:05:00.000Z',
            revalidationRequired: true,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/render-input-preflight-request/v1': [
      renderInputRequestExample,
    ],
    'apollo://schemas/render-input-preflight/v1': [
      {
        data: {
          schemaVersion: 'render-input/v1',
          validationScope: 'portable-envelope',
          materializationRequired: true,
          inputHash: 'b'.repeat(64),
          renderer: { ...renderInputRequestExample.renderer },
          composition: {
            ...renderInputRequestExample.composition,
            propsHash: 'c'.repeat(64),
          },
          plan: { ...renderInputRequestExample.plan },
          output: {
            id: 'preset-9x16',
            locale: 'pt-BR',
            aspectRatio: '9:16',
            width: 1080,
            height: 1920,
            fps: 30,
            durationInFrames: 900,
          },
          assetCount: 1,
          totalAssetBytes: '2849012',
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/enqueue-artifact-render-request/v1': [
      { authorizationId: 'materialization-auth-example-1' },
    ],
    'apollo://schemas/artifact-render-operation-accepted/v1': [
      {
        data: { operation: queuedRenderOperationExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/public-operation-detail/v1': [
      {
        data: { operation: queuedRenderOperationExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-detail/v2': [
      {
        data: {
          artifact: {
            id: 'artifact-font-example-1', workspaceId,
            artifactKey: 'artifact:artifact-font-example-1', sha256: 'f'.repeat(64),
            byteSize: '184320', mediaType: 'font', container: 'woff2',
            status: 'available', createdAt,
          },
          manifests: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-color-probe/v1': [
      {
        data: {
          probe: {
            schemaVersion: 'media-color-probe/v1',
            id: 'color-probe-example-1',
            workspaceId,
            artifactId,
            manifestId: 'manifest-example-1',
            detection: {
              state: 'ready',
              metadata: {
                colorSpace: 'rec709',
                transfer: 'bt709',
                primaries: 'bt709',
                matrix: 'bt709',
                range: 'limited',
                bitDepth: 10,
              },
              pixelFormat: 'yuv420p10le',
              hdrMode: 'sdr',
            },
            producer: {
              provider: 'ffprobe',
              version: 'json-v1',
              binaryDigest: '9'.repeat(64),
            },
            createdAt,
            probeHash: '8'.repeat(64),
          },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-color-pipeline-compilation-request/v1': [
      {
        sourceArtifactId: artifactId,
        sourceManifestId: 'manifest-example-1',
        outputMetadata: colorOutputMetadataExample,
        stages: colorPipelineStagesExample.map(({ input: _input, ...stage }) => stage),
      },
    ],
    'apollo://schemas/color-pipeline-compilation-mutated/v1': [
      {
        data: {
          compilation: colorPipelineCompilationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/color-pipeline-compilation-read/v1': [
      {
        data: { compilation: colorPipelineCompilationExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/public-operation-detail/v2': [
      { data: { operation: queuedMediaIngestOperationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-detail/v3': [
      { data: { operation: queuedProjectProxyRenderOperationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-detail/v4': [
      { data: { operation: queuedProjectFinalExportOperationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-detail/v5': [
      { data: { operation: queuedSourceCleanupOperationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-detail/v6': [
      { data: { operation: queuedLongFormIndexOperationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/ui-session-status/v2': [
      {
        data: {
          subject: 'apollo-operator', workspaceId,
          memberId: '11111111-1111-4111-8111-111111111111', role: 'administrator',
          expiresAt: '2026-07-13T08:00:00.000Z',
          workspaces: [{
            memberId: '11111111-1111-4111-8111-111111111111', workspaceId,
            workspaceSlug: 'apollo-main', workspaceName: 'Apollo Main', role: 'administrator',
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/ui-workspace-switch-request/v1': [
      { workspaceId: 'workspace-secondary' },
    ],
    'apollo://schemas/ui-workspace-switched/v1': [
      {
        data: {
          workspaceId: 'workspace-secondary', memberId: '22222222-2222-4222-8222-222222222222',
          role: 'director', expiresAt: '2026-07-13T08:00:00.000Z', rotated: true,
          workspaces: [{
            memberId: '22222222-2222-4222-8222-222222222222', workspaceId: 'workspace-secondary',
            workspaceSlug: 'apollo-secondary', workspaceName: 'Apollo Secondary', role: 'director',
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-detail/v3': [
      {
        data: {
          artifact: {
            id: 'artifact-font-example-1', workspaceId,
            artifactKey: 'artifact:artifact-font-example-1', sha256: 'f'.repeat(64),
            byteSize: '184320', mediaType: 'font', container: 'woff2',
            status: 'available',
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'available', tone: 'success',
              progress: { mode: 'none' }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: true,
            },
            createdAt,
          },
          manifests: [],
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          artifact: {
            id: 'artifact-quarantined-example-1', workspaceId,
            artifactKey: 'artifact:artifact-quarantined-example-1', sha256: 'e'.repeat(64),
            byteSize: '1024', mediaType: 'data', container: 'json',
            status: 'quarantined',
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'quarantined', tone: 'warning',
              progress: { mode: 'none' }, primaryAction: 'inspect-error',
              availableActions: ['inspect-error'], terminal: false,
            },
            createdAt,
          },
          manifests: [],
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          artifact: {
            id: 'artifact-deleted-example-1', workspaceId,
            artifactKey: 'artifact:artifact-deleted-example-1', sha256: 'd'.repeat(64),
            byteSize: '2048', mediaType: 'image', container: 'png',
            status: 'deleted',
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'deleted', tone: 'neutral',
              progress: { mode: 'none' }, primaryAction: 'inspect-history',
              availableActions: ['inspect-history'], terminal: true,
            },
            createdAt,
          },
          manifests: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/artifact-detail/v4': [
      {
        data: {
          artifact: {
            id: 'artifact-font-example-1', workspaceId,
            artifactKey: 'artifact:artifact-font-example-1', sha256: 'f'.repeat(64),
            byteSize: '184320', mediaType: 'font', container: 'woff2',
            status: 'available', lifecycleRevision: 1,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'available', tone: 'success',
              progress: { mode: 'none' }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: true,
            },
            createdAt,
          },
          manifests: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-artifact-lifecycle-transition-request/v1': [
      {
        baseRevision: 1,
        targetStatus: 'quarantined',
        reason: 'Automated integrity verification requires human inspection.',
      },
    ],
    'apollo://schemas/media-artifact-lifecycle-transition-result/v1': [
      {
        data: {
          transition: {
            id: '123e4567-e89b-42d3-a456-426614174099',
            artifactId,
            baseRevision: 1,
            resultRevision: 2,
            fromStatus: 'available',
            targetStatus: 'quarantined',
            changed: true,
            reason: 'Automated integrity verification requires human inspection.',
            actorClientId: clientId,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'quarantined', tone: 'warning',
              progress: { mode: 'none' }, primaryAction: 'inspect-error',
              availableActions: ['inspect-error'], terminal: false,
            },
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/public-operation-detail/v7': [
      { data: { operation: queuedLongFormIndexOperationVisibleExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-detail/v8': [
      { data: { operation: queuedLongFormIndexOperationVisibleProjectExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-detail/v9': [
      { data: { operation: queuedProjectDirectorOperationVisibleExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-detail/v10': [
      { data: { operation: queuedLongFormIndexCostOperationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-detail/v11': [
      { data: { operation: queuedProductionBatchItemOperationVisibleExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v1': [
      {
        data: { operations: [] },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          operations: [queuedRenderOperationExample],
          nextCursor: Buffer.from(JSON.stringify({
            v: 1,
            createdAt: queuedRenderOperationExample.createdAt,
            id: queuedRenderOperationExample.id,
            filterHash: 'a'.repeat(64),
          })).toString('base64url'),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/public-operation-list/v2': [
      { data: { operations: [queuedMediaIngestOperationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v3': [
      { data: { operations: [queuedProjectProxyRenderOperationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v4': [
      { data: { operations: [queuedProjectFinalExportOperationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v5': [
      { data: { operations: [queuedSourceCleanupOperationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v6': [
      { data: { operations: [queuedLongFormIndexOperationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v7': [
      { data: { operations: [queuedLongFormIndexOperationVisibleExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v8': [
      { data: { operations: [queuedLongFormIndexOperationVisibleProjectExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v9': [
      { data: { operations: [queuedProjectDirectorOperationVisibleExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/public-operation-list/v10': [
      { data: { operations: [queuedLongFormIndexCostOperationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/enqueue-project-director-run-request/v1': [
      {
        baseVersionId: 'project-version-base-example-1',
        baseHash: 'b'.repeat(64),
        reason: 'Recompute the persisted editorial plan after transcript review.',
      },
    ],
    'apollo://schemas/project-director-operation-enqueued/v1': [
      {
        data: { operation: queuedProjectDirectorOperationVisibleExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/operation-telemetry-summary/v1': [
      {
        data: {
          from: '2026-07-11T20:00:00.000Z', to: createdAt,
          events: { total: 12, created: 2, succeeded: 1, failed: 1, canceled: 0, spansSucceeded: 4, spansFailed: 0 },
          alerts: { total: 2, warning: 1, critical: 1, operationFailed: 1, queueWaitHigh: 0, runDurationHigh: 0, spanDurationHigh: 1, costHigh: 0 },
          metrics: {
            queueWaitMs: { sampleCount: 2, total: '2400', maximum: '1800' },
            runDurationMs: { sampleCount: 2, total: '42000', maximum: '30000' },
            spanDurationMs: { sampleCount: 4, total: '39000', maximum: '21000' },
            inputBytes: { sampleCount: 1, total: '1048576', maximum: '1048576' },
            outputBytes: { sampleCount: 1, total: '524288', maximum: '524288' },
            inputTokens: { sampleCount: 1, total: '1200', maximum: '1200' },
            outputTokens: { sampleCount: 1, total: '300', maximum: '300' },
            costMinorUnits: { sampleCount: 1, total: '75', maximum: '75' },
          },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-delivery-list/v1': [
      {
        data: { deliveries: [] },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          deliveries: [webhookDeliveryExample],
          nextCursor: Buffer.from(JSON.stringify({
            v: 1,
            createdAt,
            id: webhookDeliveryExample.id,
            filterHash: 'f'.repeat(64),
          })).toString('base64url'),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-endpoint-list/v1': [
      { data: { endpoints: [] }, meta: { apiVersion: 'v1' } },
      { data: { endpoints: [webhookEndpointExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/create-webhook-endpoint-request/v1': [
      { url: 'https://hooks.example.com/apollo' },
    ],
    'apollo://schemas/webhook-endpoint-created/v1': [
      {
        data: { endpoint: webhookPendingEndpointExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
      {
        data: { endpoint: webhookPendingEndpointExample, replayed: true },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-endpoint-detail/v1': [
      { data: { endpoint: { ...webhookEndpointExample, signingSecrets: [webhookSecretMetadataExample] } }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/set-webhook-endpoint-status-request/v1': [
      { status: 'suspended', baseRevision: webhookEndpointExample.revision },
      { status: 'revoked', baseRevision: webhookEndpointExample.revision },
    ],
    'apollo://schemas/webhook-endpoint-status-result/v1': [
      {
        data: {
          endpoint: { ...webhookEndpointExample, status: 'suspended' },
          effects: { pausedSubscriptions: 1, revokedSubscriptions: 0, revokedSigningSecrets: 0 },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          endpoint: webhookEndpointExample,
          effects: { pausedSubscriptions: 0, revokedSubscriptions: 0, revokedSigningSecrets: 0 },
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-endpoint-challenge-result/v1': [
      {
        data: {
          endpoint: webhookEndpointExample,
          effects: { activatedSubscriptions: 1 },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          endpoint: webhookEndpointExample,
          effects: { activatedSubscriptions: 0 },
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/provision-webhook-signing-secret-request/v1': [
      { baseRevision: webhookPendingEndpointExample.revision },
    ],
    'apollo://schemas/webhook-signing-secret-provisioned/v1': [
      {
        data: {
          endpoint: {
            ...webhookPendingEndpointExample,
            currentSigningSecret: { ...webhookSecretMetadataExample, version: 2 },
          },
          secretBase64url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          secretAvailable: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          endpoint: {
            ...webhookPendingEndpointExample,
            currentSigningSecret: { ...webhookSecretMetadataExample, version: 2 },
          },
          secretAvailable: false,
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/stage-webhook-signing-secret-rotation-request/v1': [
      { baseRevision: webhookEndpointExample.revision, overlapSeconds: 300 },
    ],
    'apollo://schemas/webhook-signing-secret-rotation-staged/v1': [
      {
        data: {
          rotation: {
            id: '20000000-0000-4000-8000-000000000010',
            endpointId: webhookEndpointExample.id,
            candidateVersion: 2,
            fingerprint: 'c'.repeat(64),
            status: 'staged',
            overlapSeconds: 300,
            createdAt,
            expiresAt: '2026-07-13T20:00:00.000Z',
          },
          secretBase64url: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          secretAvailable: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          rotation: {
            id: '20000000-0000-4000-8000-000000000010',
            endpointId: webhookEndpointExample.id,
            candidateVersion: 2,
            fingerprint: 'c'.repeat(64),
            status: 'staged',
            overlapSeconds: 300,
            createdAt,
            expiresAt: '2026-07-13T20:00:00.000Z',
          },
          secretAvailable: false,
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/activate-webhook-signing-secret-rotation-request/v1': [
      { baseRevision: webhookEndpointExample.revision },
    ],
    'apollo://schemas/webhook-signing-secret-rotation-activated/v1': [
      {
        data: {
          endpoint: { id: webhookEndpointExample.id, status: 'active', revision: 'd'.repeat(64) },
          rotation: {
            id: '20000000-0000-4000-8000-000000000010', status: 'activated',
            candidateVersion: 2, fingerprint: 'c'.repeat(64), overlapSeconds: 300,
            activatedAt: '2026-07-12T20:05:00.000Z', overlapUntil: '2026-07-12T20:10:00.000Z',
          },
          signing: {
            activeVersion: 2, activeFingerprint: 'c'.repeat(64),
            previousVersion: 1, previousFingerprint: webhookSecretMetadataExample.fingerprint,
            previousUsableUntil: '2026-07-12T20:10:00.000Z',
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/cancel-webhook-signing-secret-rotation-request/v1': [
      { baseRevision: webhookEndpointExample.revision },
    ],
    'apollo://schemas/webhook-signing-secret-rotation-cancelled/v1': [
      {
        data: {
          rotation: {
            id: '20000000-0000-4000-8000-000000000011',
            endpointId: webhookEndpointExample.id,
            status: 'cancelled', candidateVersion: 3,
            fingerprint: 'e'.repeat(64), cancelledAt: '2026-07-12T20:15:00.000Z',
          },
          envelopeDestroyed: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-list/v3': [
      { data: { projects: [] }, meta: { apiVersion: 'v1' } },
      {
        data: {
          projects: [{
            id: projectId, workspaceId, name: 'Anúncio de descoberta', status: 'draft',
            currentVersionId: 'project-version-example-1', objective: 'discovery', format: '9:16',
            locale: 'pt-BR', ownerId: 'client-example-1', createdAt,
          }],
          nextCursor: Buffer.from('project-search-page-example').toString('base64url'),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/capability-list/v2': [
      {
        data: {
          capabilities: [
            {
              id: 'apollo.sessions.login',
              version: '1.0.0',
              title: 'Create human UI session',
              description: 'Authenticates a human operator and creates an HTTP-only UI session.',
              operationKind: 'command',
              authMode: 'none',
              authScheme: 'none',
              requiredScopes: [],
              inputSchemaRef: 'apollo://schemas/ui-session-create-request/v1',
              outputSchemaRef: 'apollo://schemas/ui-session-created/v1',
              endpoint: { method: 'POST', path: '/v1/session' },
              supportsDryRun: false,
              costClass: 'free',
              confirmation: 'none',
              successStatuses: [200],
              idempotency: 'natural',
              requestBodyRequired: true,
              responseMediaType: 'application/json',
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/capability-list/v3': [
      {
        data: {
          capabilities: [{
            id: 'apollo.media.uploads.content.put', version: '1.0.0', title: 'Upload signed media bytes',
            description: 'Receives media bytes through a short-lived signed URL.', operationKind: 'command',
            authMode: 'required', authScheme: 'signed-token', requiredScopes: [],
            inputSchemaRef: 'apollo://schemas/binary-media-content/v1', outputSchemaRef: 'apollo://schemas/media-upload-content-received/v1',
            endpoint: { method: 'PUT', path: '/v1/media/uploads/{uploadId}/content' }, supportsDryRun: false,
            costClass: 'low', confirmation: 'none', successStatuses: [201], idempotency: 'natural',
            queryParameters: [], requestBodyRequired: true, requestMediaType: 'application/octet-stream', responseMediaType: 'application/json',
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/begin-media-upload-request/v1': [
      { kind: 'video', size: '104857600', mimeType: 'video/mp4', checksum: 'a'.repeat(64) },
    ],
    'apollo://schemas/binary-media-content/v1': ['binary-media-bytes'],
    'apollo://schemas/create-review-annotation-request/v1': [
      {
        projectVersionId: 'project-version-example-2',
        proxyArtifactId: 'artifact-review-proxy-1',
        proxyHash: 'e'.repeat(64),
        frame: 315,
        timeRangeMs: [10500, 10500],
        scope: 'region',
        region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
        targetIds: [],
        screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
        text: 'Reposicionar a legenda abaixo do rosto.',
      },
    ],
    'apollo://schemas/create-review-annotation-request/v2': [
      {
        projectVersionId: 'project-version-example-2',
        proxyArtifactId: 'artifact-review-proxy-1',
        proxyHash: 'e'.repeat(64),
        frame: 315,
        timeRangeMs: [10500, 10500],
        scope: 'region',
        region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
        targetIds: [],
        applicationScope: { kind: 'scene', global: false },
        screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
        text: 'Reposicionar a legenda abaixo do rosto.',
      },
    ],
    'apollo://schemas/project-review/v1': [
      {
        data: {
          session: {
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyUrl: '/v1/artifacts/artifact-review-proxy-1/content',
            proxyHash: 'e'.repeat(64),
            fps: 30,
            resolution: { width: 1080, height: 1920 },
            durationFrames: 2400,
            stale: false,
          },
          scenes: [{ id: 'scene:clip-example-1', label: 'Cena 1', startFrame: 0, endFrame: 900 }],
          annotations: [{
            id: 'd8f7ec49-b87c-4ca8-80a7-7840de71c650',
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyHash: 'e'.repeat(64),
            frame: 315,
            timeRangeMs: [10500, 10500],
            screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
            scope: 'region',
            region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
            targetIds: [],
            text: 'Reposicionar a legenda abaixo do rosto.',
            author: { id: clientId, name: 'Editor Apollo', type: 'api-client' },
            status: 'open',
            createdAt,
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-review/v2': [
      {
        data: {
          session: {
            currentProjectVersionId: 'project-version-example-2',
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyUrl: '/v1/artifacts/artifact-review-proxy-1/content',
            proxyHash: 'e'.repeat(64),
            fps: 30,
            resolution: { width: 1080, height: 1920 },
            durationFrames: 2400,
            stale: false,
          },
          versions: [
            { id: 'project-version-example-2', sequence: 2, createdAt, current: true, previewAvailable: true },
            { id: 'project-version-example-1', sequence: 1, createdAt, current: false, previewAvailable: false },
          ],
          scopeContext: {
            formatId: '9:16',
            localeId: 'pt-BR',
            recipeIds: ['project-final-export'],
            options: [
              { kind: 'frame', affectedCount: 2400, enabled: true },
              { kind: 'region', affectedCount: 1, enabled: true },
              { kind: 'clip', affectedCount: 3, enabled: true },
              { kind: 'scene', affectedCount: 3, enabled: true },
              { kind: 'range', affectedCount: 1, enabled: true },
              { kind: 'project', affectedCount: 1, enabled: true },
              { kind: 'formats', affectedCount: 1, enabled: true },
              { kind: 'locales', affectedCount: 1, enabled: true },
              { kind: 'recipes', affectedCount: 1, enabled: true },
            ],
          },
          scenes: [{ id: 'scene:clip-example-1', label: 'Cena 1', startFrame: 0, endFrame: 900 }],
          annotations: [{
            id: 'd8f7ec49-b87c-4ca8-80a7-7840de71c650',
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyHash: 'e'.repeat(64),
            frame: 315,
            timeRangeMs: [10500, 10500],
            screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
            scope: 'region',
            region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
            targetIds: [],
            applicationScope: { kind: 'scene', targetIds: ['scene:clip-example-1'], formatIds: ['9:16'], localeIds: ['pt-BR'], recipeIds: ['project-final-export'], global: false },
            affectedCount: 1,
            text: 'Reposicionar a legenda abaixo do rosto.',
            author: { id: clientId, name: 'Editor Apollo', type: 'api-client' },
            status: 'open',
            createdAt,
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-review/v3': [
      {
        data: {
          session: {
            currentProjectVersionId: 'project-version-example-2',
            projectVersionId: 'project-version-example-2', proxyArtifactId: 'artifact-review-proxy-1',
            proxyUrl: '/v1/artifacts/artifact-review-proxy-1/content', proxyHash: 'e'.repeat(64),
            fps: 30, resolution: { width: 1080, height: 1920 }, durationFrames: 2400, stale: false,
          },
          versions: [
            {
              id: 'project-version-example-2', sequence: 2, createdAt, current: true, previewAvailable: true,
              visibleState: {
                schemaVersion: 'visible-state/v1', label: 'current', tone: 'info', progress: { mode: 'none' },
                primaryAction: 'open-result', availableActions: ['open-result'], terminal: false,
              },
            },
            {
              id: 'project-version-example-1', sequence: 1, createdAt, current: false, previewAvailable: false,
              visibleState: {
                schemaVersion: 'visible-state/v1', label: 'superseded', tone: 'neutral', progress: { mode: 'none' },
                primaryAction: 'inspect-history', availableActions: ['inspect-history'], terminal: true,
              },
            },
          ],
          scopeContext: {
            formatId: '9:16', localeId: 'pt-BR', recipeIds: ['project-final-export'],
            options: [
              { kind: 'frame', affectedCount: 2400, enabled: true }, { kind: 'region', affectedCount: 1, enabled: true },
              { kind: 'clip', affectedCount: 3, enabled: true }, { kind: 'scene', affectedCount: 3, enabled: true },
              { kind: 'range', affectedCount: 1, enabled: true }, { kind: 'project', affectedCount: 1, enabled: true },
              { kind: 'formats', affectedCount: 1, enabled: true }, { kind: 'locales', affectedCount: 1, enabled: true },
              { kind: 'recipes', affectedCount: 1, enabled: true },
            ],
          },
          scenes: [], annotations: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/review-annotation-created/v1': [
      {
        data: {
          annotation: {
            id: 'd8f7ec49-b87c-4ca8-80a7-7840de71c650',
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyHash: 'e'.repeat(64),
            frame: 315,
            timeRangeMs: [10500, 10500],
            screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
            scope: 'region',
            region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
            targetIds: [],
            text: 'Reposicionar a legenda abaixo do rosto.',
            author: { id: clientId, name: 'Editor Apollo', type: 'api-client' },
            status: 'open',
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/review-annotation-created/v2': [
      {
        data: {
          annotation: {
            id: 'd8f7ec49-b87c-4ca8-80a7-7840de71c650',
            projectVersionId: 'project-version-example-2',
            proxyArtifactId: 'artifact-review-proxy-1',
            proxyHash: 'e'.repeat(64),
            frame: 315,
            timeRangeMs: [10500, 10500],
            screenshotRef: `data:image/jpeg;base64,${Buffer.from('apollo-review-frame').toString('base64')}`,
            scope: 'region',
            region: { x: 0.18, y: 0.12, width: 0.42, height: 0.28 },
            targetIds: [],
            applicationScope: { kind: 'scene', targetIds: ['scene:clip-example-1'], formatIds: ['9:16'], localeIds: ['pt-BR'], recipeIds: ['project-final-export'], global: false },
            affectedCount: 1,
            text: 'Reposicionar a legenda abaixo do rosto.',
            author: { id: clientId, name: 'Editor Apollo', type: 'api-client' },
            status: 'open',
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-review-patch-proposal-request/v1': [
      { annotationId: reviewPatchProposalExample.annotationId },
    ],
    'apollo://schemas/review-patch-proposal-created/v1': [
      { data: { proposal: reviewPatchProposalExample, replayed: false }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/review-patch-proposal/v1': [
      { data: { proposal: reviewPatchProposalExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/apply-review-patch-request/v1': [
      { confirmed: true },
    ],
    'apollo://schemas/review-patch-applied/v1': [
      {
        data: {
          proposal: {
            ...reviewPatchProposalExample,
            status: 'applied',
            resultCommandId: 'edit-command-example-214',
            resultVersionId: 'project-version-example-3',
            renderOperationId: queuedProjectProxyRenderOperationExample.id,
            comparison: {
              beforeVersionId: 'project-version-example-2',
              afterVersionId: 'project-version-example-3',
              beforeEditPlanHash: 'a'.repeat(64),
              afterEditPlanHash: 'b'.repeat(64),
              changedTargets: ['subtitle:subtitle-cue-2'],
              invalidatedRanges: [[10500, 10500]],
            },
            render: { operationId: queuedProjectProxyRenderOperationExample.id, status: 'queued', phase: 'queued' },
          },
          command: { id: 'edit-command-example-214', type: 'apply-review-patch', baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3', createdAt },
          version: {
            id: 'project-version-example-3', sequence: 3, parentVersionId: 'project-version-example-2', baseHash: 'c'.repeat(64),
            snapshotRefs: { brief: 'snapshot-brief-example-1', treatment: 'snapshot-treatment-example-1', story: 'snapshot-story-example-1', editPlan: 'snapshot-edit-plan-example-3', policies: 'snapshot-policies-example-1' },
            createdAt,
          },
          comparison: {
            beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3', beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
            changedTargets: ['subtitle:subtitle-cue-2'], invalidatedRanges: [[10500, 10500]],
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/review-patch-applied/v2': [
      {
        data: {
          proposal: {
            ...reviewPatchProposalExample,
            status: 'applied',
            resultCommandId: 'edit-command-example-214',
            resultVersionId: 'project-version-example-3',
            renderOperationId: queuedProjectProxyRenderOperationExample.id,
            comparison: {
              beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3',
              beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
              changedTargets: ['subtitle:subtitle-cue-2'], invalidatedRanges: [[10500, 10500]],
            },
            render: { operationId: queuedProjectProxyRenderOperationExample.id, status: 'queued', phase: 'queued' },
          },
          command: { id: 'edit-command-example-214', type: 'apply-review-patch', baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3', createdAt },
          version: {
            id: 'project-version-example-3', sequence: 3, parentVersionId: 'project-version-example-2', baseHash: 'c'.repeat(64),
            snapshotRefs: { brief: 'snapshot-brief-example-1', treatment: 'snapshot-treatment-example-1', story: 'snapshot-story-example-1', editPlan: 'snapshot-edit-plan-example-3', policies: 'snapshot-policies-example-1' },
            createdAt,
          },
          comparison: {
            beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3',
            beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
            changedTargets: ['subtitle:subtitle-cue-2'], invalidatedRanges: [[10500, 10500]],
          },
          impact: {
            schemaVersion: 'command-impact/v1', commandId: 'edit-command-example-214', commandType: 'apply-review-patch',
            baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3',
            changeKinds: ['update-layout'], dependencyTypes: ['visual'],
            affectedRanges: [{ startFrame: 315, endFrame: 316 }], affectedVariantIds: ['9:16'],
            affectedArtifacts: [{ artifactId: 'artifact-proxy-example-2', kind: 'proxy', sourceVersionId: 'project-version-example-2', variantId: '9:16' }],
            minimalRenders: [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 315, endFrame: 316 }] }],
            renderSemanticsChanged: true, impactHash: 'd'.repeat(64),
          },
          invalidations: [{
            schemaVersion: 'command-artifact-invalidation/v1', id: 'e'.repeat(64), status: 'stale',
            commandId: 'edit-command-example-214', baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3',
            artifactId: 'artifact-proxy-example-2', kind: 'proxy', variantId: '9:16', dependencyTypes: ['visual'],
            affectedRanges: [{ startFrame: 315, endFrame: 316 }], impactHash: 'd'.repeat(64), createdAt,
          }],
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/review-patch-applied/v3': [
      {
        data: {
          proposal: {
            ...reviewPatchProposalExample, status: 'applied',
            resultCommandId: 'edit-command-example-214', resultVersionId: 'project-version-example-3',
            renderOperationId: queuedProjectProxyRenderOperationExample.id,
            comparison: {
              beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3',
              beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
              changedTargets: ['subtitle:subtitle-cue-2'], invalidatedRanges: [[10500, 10500]],
            },
            render: { operationId: queuedProjectProxyRenderOperationExample.id, status: 'queued', phase: 'queued' },
          },
          command: {
            id: 'edit-command-example-214', type: 'apply-review-patch',
            baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3', createdAt,
          },
          version: {
            id: 'project-version-example-3', sequence: 3,
            parentVersionId: 'project-version-example-2', baseHash: 'c'.repeat(64),
            snapshotRefs: {
              brief: 'snapshot-brief-example-1', treatment: 'snapshot-treatment-example-1',
              story: 'snapshot-story-example-1', editPlan: 'snapshot-edit-plan-example-3',
              policies: 'snapshot-policies-example-1',
            },
            createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'current', tone: 'info',
              progress: { mode: 'none' }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: false,
            },
          },
          comparison: {
            beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3',
            beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
            changedTargets: ['subtitle:subtitle-cue-2'], invalidatedRanges: [[10500, 10500]],
          },
          impact: {
            schemaVersion: 'command-impact/v1', commandId: 'edit-command-example-214', commandType: 'apply-review-patch',
            baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3',
            changeKinds: ['update-layout'], dependencyTypes: ['visual'],
            affectedRanges: [{ startFrame: 315, endFrame: 316 }], affectedVariantIds: ['9:16'],
            affectedArtifacts: [{ artifactId: 'artifact-proxy-example-2', kind: 'proxy', sourceVersionId: 'project-version-example-2', variantId: '9:16' }],
            minimalRenders: [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 315, endFrame: 316 }] }],
            renderSemanticsChanged: true, impactHash: 'd'.repeat(64),
          },
          invalidations: [{
            schemaVersion: 'command-artifact-invalidation/v1', id: 'e'.repeat(64), status: 'stale',
            commandId: 'edit-command-example-214', baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3',
            artifactId: 'artifact-proxy-example-2', kind: 'proxy', variantId: '9:16', dependencyTypes: ['visual'],
            affectedRanges: [{ startFrame: 315, endFrame: 316 }], impactHash: 'd'.repeat(64), createdAt,
          }],
          operation: queuedProjectProxyRenderOperationExample, replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-review-patch-batch-request/v1': [
      { proposalIds: [reviewPatchProposalExample.id, reviewPatchProposalTwoId], mode: 'all-or-nothing' },
    ],
    'apollo://schemas/review-patch-batch-created/v1': [
      { data: { batch: reviewPatchBatchExample, replayed: false }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/review-patch-batch/v1': [
      { data: { batch: reviewPatchBatchExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/apply-review-patch-batch-request/v1': [
      { confirmed: true },
    ],
    'apollo://schemas/review-patch-batch-applied/v1': [
      {
        data: {
          batch: {
            ...reviewPatchBatchExample,
            status: 'applied',
            items: reviewPatchBatchExample.items.map((item) => ({ ...item, status: 'applied' })),
            resultCommandId: 'edit-command-example-215',
            resultVersionId: 'project-version-example-3',
            renderOperationId: queuedProjectProxyRenderOperationExample.id,
            comparison: {
              beforeVersionId: 'project-version-example-2',
              afterVersionId: 'project-version-example-3',
              beforeEditPlanHash: 'a'.repeat(64),
              afterEditPlanHash: 'b'.repeat(64),
              changedTargets: ['clip:clip-example-2', 'subtitle:subtitle-cue-2'],
              invalidatedRanges: [[10500, 10500], [14000, 17000]],
            },
            render: { operationId: queuedProjectProxyRenderOperationExample.id, status: 'queued', phase: 'queued' },
          },
          command: { id: 'edit-command-example-215', type: 'apply-review-patch-batch', baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3', createdAt },
          version: {
            id: 'project-version-example-3', sequence: 3, parentVersionId: 'project-version-example-2', baseHash: 'c'.repeat(64),
            snapshotRefs: { brief: 'snapshot-brief-example-1', treatment: 'snapshot-treatment-example-1', story: 'snapshot-story-example-1', editPlan: 'snapshot-edit-plan-example-3', policies: 'snapshot-policies-example-1' },
            createdAt,
          },
          comparison: {
            beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3', beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
            changedTargets: ['clip:clip-example-2', 'subtitle:subtitle-cue-2'], invalidatedRanges: [[10500, 10500], [14000, 17000]],
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/review-patch-batch-applied/v2': [
      {
        data: {
          batch: {
            ...reviewPatchBatchExample,
            status: 'applied',
            items: reviewPatchBatchExample.items.map((item) => ({ ...item, status: 'applied' })),
            resultCommandId: 'edit-command-example-215',
            resultVersionId: 'project-version-example-3',
            renderOperationId: queuedProjectProxyRenderOperationExample.id,
            comparison: {
              beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3',
              beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
              changedTargets: ['clip:clip-example-2', 'subtitle:subtitle-cue-2'], invalidatedRanges: [[10500, 10500], [14000, 17000]],
            },
            render: { operationId: queuedProjectProxyRenderOperationExample.id, status: 'queued', phase: 'queued' },
          },
          command: { id: 'edit-command-example-215', type: 'apply-review-patch-batch', baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3', createdAt },
          version: {
            id: 'project-version-example-3', sequence: 3, parentVersionId: 'project-version-example-2', baseHash: 'c'.repeat(64),
            snapshotRefs: { brief: 'snapshot-brief-example-1', treatment: 'snapshot-treatment-example-1', story: 'snapshot-story-example-1', editPlan: 'snapshot-edit-plan-example-3', policies: 'snapshot-policies-example-1' },
            createdAt,
          },
          comparison: {
            beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3', beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
            changedTargets: ['clip:clip-example-2', 'subtitle:subtitle-cue-2'], invalidatedRanges: [[10500, 10500], [14000, 17000]],
          },
          impact: {
            schemaVersion: 'command-impact/v1', commandId: 'edit-command-example-215', commandType: 'apply-review-patch-batch',
            baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3',
            changeKinds: ['update-text'], dependencyTypes: ['content', 'visual'],
            affectedRanges: [{ startFrame: 315, endFrame: 316 }, { startFrame: 420, endFrame: 510 }], affectedVariantIds: ['9:16'],
            affectedArtifacts: [{ artifactId: 'artifact-proxy-example-2', kind: 'proxy', sourceVersionId: 'project-version-example-2', variantId: '9:16' }],
            minimalRenders: [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 315, endFrame: 316 }, { startFrame: 420, endFrame: 510 }] }],
            renderSemanticsChanged: true, impactHash: 'd'.repeat(64),
          },
          invalidations: [{
            schemaVersion: 'command-artifact-invalidation/v1', id: 'e'.repeat(64), status: 'stale',
            commandId: 'edit-command-example-215', baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3',
            artifactId: 'artifact-proxy-example-2', kind: 'proxy', variantId: '9:16', dependencyTypes: ['content', 'visual'],
            affectedRanges: [{ startFrame: 315, endFrame: 316 }, { startFrame: 420, endFrame: 510 }], impactHash: 'd'.repeat(64), createdAt,
          }],
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/review-patch-batch-applied/v3': [
      {
        data: {
          batch: {
            ...reviewPatchBatchExample, status: 'applied',
            items: reviewPatchBatchExample.items.map((item) => ({ ...item, status: 'applied' })),
            resultCommandId: 'edit-command-example-215', resultVersionId: 'project-version-example-3',
            renderOperationId: queuedProjectProxyRenderOperationExample.id,
            comparison: {
              beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3',
              beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
              changedTargets: ['clip:clip-example-2', 'subtitle:subtitle-cue-2'],
              invalidatedRanges: [[10500, 10500], [14000, 17000]],
            },
            render: { operationId: queuedProjectProxyRenderOperationExample.id, status: 'queued', phase: 'queued' },
          },
          command: {
            id: 'edit-command-example-215', type: 'apply-review-patch-batch',
            baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3', createdAt,
          },
          version: {
            id: 'project-version-example-3', sequence: 3,
            parentVersionId: 'project-version-example-2', baseHash: 'c'.repeat(64),
            snapshotRefs: {
              brief: 'snapshot-brief-example-1', treatment: 'snapshot-treatment-example-1',
              story: 'snapshot-story-example-1', editPlan: 'snapshot-edit-plan-example-3',
              policies: 'snapshot-policies-example-1',
            },
            createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'current', tone: 'info',
              progress: { mode: 'none' }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: false,
            },
          },
          comparison: {
            beforeVersionId: 'project-version-example-2', afterVersionId: 'project-version-example-3',
            beforeEditPlanHash: 'a'.repeat(64), afterEditPlanHash: 'b'.repeat(64),
            changedTargets: ['clip:clip-example-2', 'subtitle:subtitle-cue-2'],
            invalidatedRanges: [[10500, 10500], [14000, 17000]],
          },
          impact: {
            schemaVersion: 'command-impact/v1', commandId: 'edit-command-example-215', commandType: 'apply-review-patch-batch',
            baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3',
            changeKinds: ['update-text'], dependencyTypes: ['content', 'visual'],
            affectedRanges: [{ startFrame: 315, endFrame: 316 }, { startFrame: 420, endFrame: 510 }],
            affectedVariantIds: ['9:16'],
            affectedArtifacts: [{ artifactId: 'artifact-proxy-example-2', kind: 'proxy', sourceVersionId: 'project-version-example-2', variantId: '9:16' }],
            minimalRenders: [{ kind: 'proxy', variantId: '9:16', ranges: [{ startFrame: 315, endFrame: 316 }, { startFrame: 420, endFrame: 510 }] }],
            renderSemanticsChanged: true, impactHash: 'd'.repeat(64),
          },
          invalidations: [{
            schemaVersion: 'command-artifact-invalidation/v1', id: 'e'.repeat(64), status: 'stale',
            commandId: 'edit-command-example-215', baseVersionId: 'project-version-example-2', resultVersionId: 'project-version-example-3',
            artifactId: 'artifact-proxy-example-2', kind: 'proxy', variantId: '9:16', dependencyTypes: ['content', 'visual'],
            affectedRanges: [{ startFrame: 315, endFrame: 316 }, { startFrame: 420, endFrame: 510 }],
            impactHash: 'd'.repeat(64), createdAt,
          }],
          operation: queuedProjectProxyRenderOperationExample, replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/render-element-hit-test/v1': [
      {
        data: {
          map: {
            schemaVersion: 'render-element-map/v1',
            mapHash: 'f'.repeat(64),
            proxyHash: 'e'.repeat(64),
            fps: 30,
            durationFrames: 2400,
            canvas: { width: 1080, height: 1920 },
            frame: 315,
          },
          selected: {
            elementId: 'subtitle:cue-example-1',
            type: 'subtitle',
            clipId: 'clip-example-1',
            sceneId: 'scene:clip-example-1',
            sourceId: artifactId,
            frame: 315,
            bounds: { x: 162, y: 1560, width: 756, height: 128 },
            zIndex: 20,
            opacity: 1,
            priority: 300,
          },
          chooserRequired: true,
          candidates: [
            {
              elementId: 'subtitle:cue-example-1', type: 'subtitle', clipId: 'clip-example-1',
              sceneId: 'scene:clip-example-1', sourceId: artifactId, frame: 315,
              bounds: { x: 162, y: 1560, width: 756, height: 128 }, zIndex: 20, opacity: 1, priority: 300,
            },
            {
              elementId: 'presenter:clip-example-1', type: 'presenter', clipId: 'clip-example-1',
              sceneId: 'scene:clip-example-1', sourceId: artifactId, frame: 315,
              bounds: { x: 0, y: 656, width: 1080, height: 608 }, zIndex: 10, opacity: 1, priority: 200,
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v1': [
      {
        data: {
          project: { id: projectId, workspaceId, name: 'Anúncio de descoberta', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt },
          media: [], transcripts: [], operationIds: [], operations: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v2': [
      {
        data: {
          project: { id: projectId, workspaceId, name: 'Anúncio de descoberta', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt },
          version: { id: 'project-version-example-2', sequence: 2, baseHash: 'b'.repeat(64), createdAt },
          editPlan: {
            id: 'edit-plan-example-2', state: 'compiled', fps: 30, durationFrames: 2683,
            clipCount: 4, cutCount: 3, automaticZoom: false, subtitleFaceProtection: true,
          },
          commands: [{
            id: 'edit-command-example-1', type: 'remove-spoken-content',
            baseVersionId: 'project-version-example-1', resultVersionId: 'project-version-example-2',
            reason: 'Remover datas e duração obsoletas.', createdAt,
          }],
          media: [], transcripts: [], operationIds: [], operations: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v3': [
      {
        data: {
          project: { id: projectId, workspaceId, name: 'Anuncio de descoberta', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt },
          version: { id: 'project-version-example-3', sequence: 3, baseHash: 'c'.repeat(64), createdAt },
          editPlan: { id: 'edit-plan-example-3', state: 'compiled', fps: 30, durationFrames: 2380, clipCount: 3, cutCount: 2, automaticZoom: false, subtitleFaceProtection: true },
          commands: [],
          media: [{
            id: 'project-media-editorial-example-1', role: 'editorial-proxy', originalFileName: 'video-editorial.mp4',
            artifactId: 'artifact-editorial-proxy-example-1', manifestId: 'manifest-editorial-proxy-example-1', mediaType: 'video', container: 'mp4',
            byteSize: '1234567', sha256: 'e'.repeat(64), status: 'available', probe: { width: 540, height: 960, duration: 79.3, fps: 30 }, createdAt,
          }],
          transcripts: [], operationIds: [queuedProjectProxyRenderOperationExample.id], operations: [queuedProjectProxyRenderOperationExample],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v4': [
      {
        data: {
          project: { id: projectId, workspaceId, name: 'Anuncio de descoberta', status: 'draft', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt },
          version: { id: 'project-version-example-4', sequence: 4, baseHash: 'd'.repeat(64), createdAt },
          editPlan: { id: 'edit-plan-example-4', state: 'compiled', fps: 30, durationFrames: 2380, clipCount: 3, cutCount: 2, automaticZoom: false, subtitleFaceProtection: true },
          commands: [{
            id: 'edit-command-director-example-1', type: 'run-director', baseVersionId: 'project-version-example-3',
            resultVersionId: 'project-version-example-4', reason: 'Planejar e revisar a composicao completa.', createdAt,
          }],
          directorRuns: [{
            id: 'director-run-example-1', status: 'planned', plannerVersion: 'apollo-director-policy/v1', criticVersion: 'apollo-director-critic/v1',
            baseVersionId: 'project-version-example-3', resultVersionId: 'project-version-example-4',
            treatmentSnapshotId: 'project-snapshot-treatment-1', storySnapshotId: 'project-snapshot-story-1', qualitySnapshotId: 'project-snapshot-quality-1',
            qualityStatus: 'approved-with-warnings', qualityScore: 0.9, decisionCount: 6, assumptionCount: 2,
            subtitleCueCount: 28, transitionCount: 2, automaticZoom: false, createdAt,
          }],
          media: [{
            id: 'project-media-editorial-example-1', role: 'editorial-proxy', originalFileName: 'video-editorial.mp4',
            artifactId: 'artifact-editorial-proxy-example-1', manifestId: 'manifest-editorial-proxy-example-1', mediaType: 'video', container: 'mp4',
            byteSize: '1234567', sha256: 'e'.repeat(64), status: 'available', probe: { width: 540, height: 960, duration: 79.3, fps: 30 }, createdAt,
          }],
          transcripts: [], operationIds: [queuedProjectProxyRenderOperationExample.id], operations: [queuedProjectProxyRenderOperationExample],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v5': [
      {
        data: {
          project: { id: projectId, workspaceId, name: 'Anuncio de descoberta', status: 'completed', objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt },
          version: { id: 'project-version-example-4', sequence: 4, baseHash: 'd'.repeat(64), createdAt },
          editPlan: { id: 'edit-plan-example-4', state: 'compiled', fps: 30, durationFrames: 2380, clipCount: 3, cutCount: 2, automaticZoom: false, subtitleFaceProtection: true },
          commands: [{
            id: 'edit-command-director-example-1', type: 'run-director', baseVersionId: 'project-version-example-3',
            resultVersionId: 'project-version-example-4', reason: 'Planejar e revisar a composicao completa.', createdAt,
          }],
          directorRuns: [{
            id: 'director-run-example-1', status: 'succeeded', plannerVersion: 'apollo-director-policy/v1', criticVersion: 'apollo-director-critic/v1',
            baseVersionId: 'project-version-example-3', resultVersionId: 'project-version-example-4',
            treatmentSnapshotId: 'project-snapshot-treatment-1', storySnapshotId: 'project-snapshot-story-1', qualitySnapshotId: 'project-snapshot-quality-1',
            qualityStatus: 'approved-with-warnings', qualityScore: 0.9, decisionCount: 6, assumptionCount: 2,
            subtitleCueCount: 28, transitionCount: 2, automaticZoom: false, createdAt,
          }],
          media: [{
            id: 'project-media-final-example-1', role: 'final-output', originalFileName: 'video-final-1080x1920.mp4',
            artifactId: 'artifact-final-example-1', manifestId: 'manifest-final-example-1', mediaType: 'video', container: 'mp4',
            byteSize: '6234567', sha256: 'f'.repeat(64), status: 'available', probe: { width: 1080, height: 1920, duration: 79.3, fps: 30 }, createdAt,
          }],
          transcripts: [], operationIds: [queuedProjectFinalExportOperationExample.id], operations: [queuedProjectFinalExportOperationExample],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/begin-media-upload-request/v2': [
      { projectId, fileName: 'gravacao-bruta.mp4', rightsConfirmed: true, kind: 'video', size: '104857600', mimeType: 'video/mp4', checksum: 'a'.repeat(64) },
    ],
    'apollo://schemas/media-upload-begun/v1': [
      {
        data: {
          upload: {
            id: '123e4567-e89b-42d3-a456-426614174001', kind: 'video', size: '104857600',
            mimeType: 'video/mp4', checksum: 'a'.repeat(64), status: 'pending-session',
            expiresAt: '2026-07-16T22:30:00.000Z', createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-begun/v2': [
      {
        data: {
          upload: {
            id: '123e4567-e89b-42d3-a456-426614174001', projectId, fileName: 'gravacao-bruta.mp4', rightsConfirmed: true,
            kind: 'video', size: '104857600', mimeType: 'video/mp4', checksum: 'a'.repeat(64), status: 'pending-session',
            expiresAt: '2026-07-16T22:30:00.000Z', createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-session/v1': [
      {
        data: {
          uploadId: '123e4567-e89b-42d3-a456-426614174001',
          session: {
            mode: 'single', expiresAt: '2026-07-16T22:25:00.000Z', maxParts: 1,
            requiredHeaders: { 'content-type': 'video/mp4', 'x-apollo-content-sha256': 'a'.repeat(64) },
            uploadUrl: 'https://uploads.example.com/v1/media/uploads/123e4567-e89b-42d3-a456-426614174001/content?token=opaque',
          },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-content-received/v1': [
      { data: { receipt: { byteSize: '104857600', checksum: 'a'.repeat(64), etag: '"uploadetag001"' } }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/record-media-upload-part-request/v1': [
      { byteSize: '67108864', etag: '"partetag001"', checksum: 'b'.repeat(64) },
    ],
    'apollo://schemas/media-upload-part-recorded/v1': [
      {
        data: { part: { uploadId: '123e4567-e89b-42d3-a456-426614174001', partNumber: 1, byteSize: '67108864', etag: '"partetag001"', checksum: 'b'.repeat(64), recordedAt: createdAt } },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-detail/v1': [
      {
        data: {
          upload: { id: '123e4567-e89b-42d3-a456-426614174001', kind: 'video', size: '134217728', mimeType: 'video/mp4', checksum: 'a'.repeat(64), status: 'uploading', expiresAt: '2026-07-16T22:30:00.000Z', createdAt },
          parts: [{ uploadId: '123e4567-e89b-42d3-a456-426614174001', partNumber: 1, byteSize: '67108864', etag: '"partetag001"', checksum: 'b'.repeat(64), recordedAt: createdAt }],
          missingPartNumbers: [2],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-detail/v2': [
      {
        data: {
          upload: { id: '123e4567-e89b-42d3-a456-426614174001', projectId, fileName: 'gravacao-bruta.mp4', rightsConfirmed: true, kind: 'video', size: '134217728', mimeType: 'video/mp4', checksum: 'a'.repeat(64), status: 'uploading', expiresAt: '2026-07-16T22:30:00.000Z', createdAt },
          parts: [{ uploadId: '123e4567-e89b-42d3-a456-426614174001', partNumber: 1, byteSize: '67108864', etag: '"partetag001"', checksum: 'b'.repeat(64), recordedAt: createdAt }],
          missingPartNumbers: [2],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-upload-completed/v1': [
      { data: { uploadId: '123e4567-e89b-42d3-a456-426614174001', status: 'verified', verifiedAt: createdAt, replayed: false }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/media-upload-completed/v2': [
      { data: { uploadId: '123e4567-e89b-42d3-a456-426614174001', status: 'verified', verifiedAt: createdAt, operation: queuedMediaIngestOperationExample, replayed: false }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/media-upload-aborted/v1': [
      { data: { uploadId: '123e4567-e89b-42d3-a456-426614174001', status: 'aborted', aborted: true }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/issue-media-download-grant-request/v1': [
      { ttlSeconds: 300 },
    ],
    'apollo://schemas/media-download-grant-issued/v1': [
      {
        data: {
          grant: { id: '123e4567-e89b-42d3-a456-426614174301', artifactId: 'artifact-example-proxy-1', status: 'active', expiresAt: '2026-07-16T22:35:00.000Z', createdAt },
          downloadUrl: 'https://downloads.example.com/grants/123e4567-e89b-42d3-a456-426614174301/content?token=opaque',
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/media-download-grant-revoked/v1': [
      {
        data: { grant: { id: '123e4567-e89b-42d3-a456-426614174301', artifactId: 'artifact-example-proxy-1', status: 'revoked', expiresAt: '2026-07-16T22:35:00.000Z', revokedAt: '2026-07-16T22:32:00.000Z' }, replayed: false },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/preflight-result/v1': [
      {
        schemaVersion: 'preflight-result/v1', eligible: true, fingerprint: 'f'.repeat(64), evaluatedAt: createdAt,
        targets: [{ kind: 'project-version', id: 'project-version-example-2', version: '2' }], conflicts: [],
        invalidations: [{ kind: 'proxy', id: 'artifact-example-proxy-1', reason: 'Timeline trim changes proxy frames.' }],
        jobs: [{ kind: 'render-proxy', count: 1, estimatedDurationMs: 45000 }],
        cost: { currency: 'USD', estimatedMinorUnits: 12, maximumMinorUnits: 20 },
        quota: { unit: 'render-minute', required: 1, remaining: 120, allowed: true },
        warnings: [{ code: 'CAPTION_REFLOW', message: 'Caption line breaks may change.', target: 'track:captions' }],
      },
    ],
    'apollo://schemas/preflight-commit-token/v1': [
      { token: `${'e'.repeat(80)}.${'s'.repeat(43)}`, expiresAt: '2026-07-16T23:35:00.000Z' },
    ],
    'apollo://schemas/batch-item-page/v1': [
      { data: { batchId: 'batch-example-1', items: [
        { itemId: 'item-1', operationId: 'operation-example-1', status: 'succeeded', retryable: false, resultRef: 'artifact-example-1', updatedAt: createdAt },
        { itemId: 'item-2', operationId: 'operation-example-2', status: 'failed', retryable: true, error: { code: 'PROVIDER_TIMEOUT', message: 'Provider timed out.' }, updatedAt: createdAt },
      ] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/set-governance-policy-request/v1': [
      {
        scopeType: 'client',
        scopeId: 'client-example-1',
        environment: 'production',
        limits: {
          requestsPerMinute: 120,
          maxConcurrency: 4,
          quotaUnits: 10000,
          spendBudgetMinorUnits: 25000,
        },
        baseRevision: null,
        reason: 'Apply the approved production budget.',
        confirmed: true,
      },
    ],
    'apollo://schemas/delete-governance-policy-request/v1': [
      {
        baseRevision: 'a'.repeat(64),
        reason: 'Restore workspace defaults after the review.',
        confirmed: true,
      },
    ],
    'apollo://schemas/governance-policy-list/v1': [
      {
        data: {
          policies: [{
            id: 'governance-policy-example-1',
            workspaceId: 'workspace-example-1',
            scopeType: 'client',
            scopeId: 'client-example-1',
            environment: 'production',
            limits: {
              requestsPerMinute: 120,
              maxConcurrency: 4,
              quotaUnits: 10000,
              spendBudgetMinorUnits: 25000,
            },
            updatedByClientId: 'client-admin-example-1',
            createdAt,
            updatedAt: createdAt,
            revision: 'a'.repeat(64),
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/governance-policy-command-result/v1': [
      {
        data: {
          action: 'set',
          policy: {
            id: 'governance-policy-example-1',
            workspaceId: 'workspace-example-1',
            scopeType: 'client',
            scopeId: 'client-example-1',
            environment: 'production',
            limits: {
              requestsPerMinute: 120,
              maxConcurrency: 4,
              quotaUnits: 10000,
              spendBudgetMinorUnits: 25000,
            },
            updatedByClientId: 'client-admin-example-1',
            createdAt,
            updatedAt: createdAt,
            revision: 'a'.repeat(64),
          },
          commandHash: 'b'.repeat(64),
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          action: 'delete',
          deletedPolicyId: 'governance-policy-example-1',
          commandHash: 'c'.repeat(64),
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/governance-usage-audit-page/v1': [
      { data: { entries: [{ id: 'operation-example-1', clientId: 'client-example-1', action: 'artifact-render', status: 'succeeded', target: { type: 'artifact', id: 'artifact-example-1' }, usage: { unit: 'operation', quantity: 1 }, createdAt, updatedAt: createdAt }] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/governance-usage-audit-page/v2': [
      {
        data: {
          entries: [{
            id: 'governance-admission-example-1',
            clientId: 'client-example-1',
            capabilityId: 'apollo.projects.list',
            environment: 'production',
            operationKind: 'query',
            costClass: 'free',
            decision: 'allowed',
            reasonCodes: [],
            scopes: {
              workspace: {
                reasons: [],
                limits: {
                  requestsPerMinute: 1000, maxConcurrency: 20,
                  quotaUnits: 10000, spendBudgetMinorUnits: 10000,
                },
                usage: {
                  requestsInWindow: 20, activeConcurrency: 2,
                  quotaUnitsUsed: 100, spendMinorUnits: 100,
                },
                remaining: {
                  requests: 979, concurrency: 18,
                  quotaUnits: 9900, spendMinorUnits: 9900,
                },
              },
              client: {
                reasons: [],
                limits: {
                  requestsPerMinute: 100, maxConcurrency: 4,
                  quotaUnits: 1000, spendBudgetMinorUnits: 1000,
                },
                usage: {
                  requestsInWindow: 4, activeConcurrency: 0,
                  quotaUnitsUsed: 20, spendMinorUnits: 20,
                },
                remaining: {
                  requests: 95, concurrency: 4,
                  quotaUnits: 980, spendMinorUnits: 980,
                },
              },
            },
            requested: {
              requests: 1, concurrency: 0,
              quotaUnits: 0, spendMinorUnits: 0,
            },
            createdAt,
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-signing-secret-rotation-list/v1': [
      { data: { rotations: [] }, meta: { apiVersion: 'v1' } },
      { data: { rotations: [webhookSigningSecretRotationExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/webhook-signing-secret-rotation-detail/v1': [
      { data: { rotation: webhookSigningSecretRotationExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/run-webhook-signing-secret-hygiene-request/v1': [
      { limitPerKind: 100 },
    ],
    'apollo://schemas/webhook-signing-secret-hygiene-result/v1': [
      {
        data: {
          asOf: createdAt, expiredRotations: 1, destroyedRotationEnvelopes: 1,
          destroyedSigningSecretPayloads: 2, hasMore: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/agent-tool-list/v1': [
      {
        data: {
          tools: [{
            name: 'apollo.health.read',
            title: 'Read API health',
            description: 'Returns API liveness.',
            inputSchema: { type: 'object', additionalProperties: false, properties: {} },
            outputSchema: { type: 'object' },
            errorSchema: { type: 'object' },
            annotations: { readOnlyHint: true, idempotentHint: true },
            apollo: {
              capabilityId: 'apollo.health.read',
              capabilityVersion: '1.0.0',
              operationKind: 'query',
              requiredScopes: [],
              endpoint: { method: 'GET', path: '/v1/health' },
              costClass: 'free',
              confirmation: 'none',
              supportsDryRun: false,
            },
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/agent-tool-list/v2': [
      {
        data: {
          tools: [{
            name: 'apollo.health.read', title: 'Read API health', description: 'Returns API liveness.',
            inputSchema: { type: 'object', additionalProperties: false, properties: {} },
            outputSchema: { type: 'object' }, errorSchema: { type: 'object' },
            annotations: { readOnlyHint: true, idempotentHint: true },
            apollo: {
              capabilityId: 'apollo.health.read', capabilityVersion: '1.0.0', operationKind: 'query',
              requiredScopes: [], endpoint: { method: 'GET', path: '/v1/health' }, costClass: 'free',
              confirmation: 'none', supportsDryRun: false,
              dataBoundary: {
                structureClassification: 'trusted-contract', mediaContentClassification: 'untrusted-data',
                instructionPolicy: 'never-execute', inputPaths: [], outputPaths: [],
              },
            },
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-subscription-list/v1': [
      { data: { subscriptions: [] }, meta: { apiVersion: 'v1' } },
      { data: { subscriptions: [webhookSubscriptionExample] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/create-webhook-subscription-request/v1': [
      {
        endpointId: webhookEndpointExample.id,
        eventTypes: ['artifact.ready'],
        resourceIds: ['artifact-example-1'],
      },
    ],
    'apollo://schemas/webhook-subscription-created/v1': [
      {
        data: { subscription: webhookSubscriptionExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
      {
        data: { subscription: webhookSubscriptionExample, replayed: true },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-subscription-detail/v1': [
      { data: { subscription: webhookSubscriptionExample }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/set-webhook-subscription-status-request/v1': [
      { status: 'paused', baseRevision: webhookSubscriptionExample.revision },
      { status: 'revoked', baseRevision: webhookSubscriptionExample.revision },
    ],
    'apollo://schemas/webhook-delivery-detail/v1': [
      {
        data: {
          delivery: { ...webhookDeliveryExample, attempts: [webhookAttemptExample] },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-delivery-replay-result/v1': [
      {
        data: { delivery: webhookReplayDeliveryExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
      {
        data: { delivery: webhookReplayDeliveryExample, replayed: true },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/webhook-event-replay-result/v1': [
      {
        data: {
          eventId: webhookDeliveryExample.eventId,
          items: [{ status: 'scheduled', delivery: webhookReplayDeliverySummaryExample }],
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          eventId: webhookDeliveryExample.eventId,
          items: [{ status: 'scheduled', delivery: webhookReplayDeliverySummaryExample }],
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-project-request/v1': [
      { name: 'Anúncio de descoberta' },
    ],
    'apollo://schemas/create-project-request/v2': [
      {
        name: 'Anúncio de descoberta',
        objective: 'discovery',
        format: '9:16',
        locale: 'pt-BR',
        briefing: 'Apresentar a ideia com ritmo natural e sem efeitos gratuitos.',
      },
    ],
    'apollo://schemas/project-created/v1': [
      {
        data: {
          project: {
            id: projectId,
            workspaceId,
            name: 'Anúncio de descoberta',
            status: 'draft',
            currentVersionId: 'project-version-example-1',
            createdAt,
          },
          version: {
            id: 'project-version-example-1',
            sequence: 1,
            baseHash: 'a'.repeat(64),
            snapshotRefs: {
              editPlan: 'project-snapshot-edit-plan-1',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-created/v2': [
      {
        data: {
          project: {
            id: projectId,
            workspaceId,
            name: 'Anúncio de descoberta',
            status: 'draft',
            objective: 'discovery',
            format: '9:16',
            locale: 'pt-BR',
            ownerId: clientId,
            currentVersionId: 'project-version-example-1',
            createdAt,
          },
          version: {
            id: 'project-version-example-1',
            sequence: 1,
            baseHash: 'a'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1',
              editPlan: 'project-snapshot-edit-plan-1',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/duplicate-project-request/v1': [
      {
        expectedVersionId: 'project-version-example-1',
        expectedVersionHash: 'a'.repeat(64),
        name: 'Anúncio de descoberta — variação',
      },
    ],
    'apollo://schemas/project-duplicated/v1': [
      {
        data: {
          project: {
            id: 'project-duplicate-example-1',
            workspaceId,
            name: 'Anúncio de descoberta — variação',
            status: 'draft',
            objective: 'discovery',
            format: '9:16',
            locale: 'pt-BR',
            ownerId: clientId,
            currentVersionId: 'project-version-duplicate-example-1',
            duplicatedFromProjectId: projectId,
            createdAt,
          },
          version: {
            id: 'project-version-duplicate-example-1',
            sequence: 1,
            baseHash: 'b'.repeat(64),
            forkedFromProjectId: projectId,
            forkedFromVersionId: 'project-version-example-1',
            snapshotRefs: {
              brief: 'project-snapshot-brief-1',
              editPlan: 'project-snapshot-edit-plan-1',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          sharedArtifactIds: ['artifact-example-source-1'],
          copiedBytes: 0,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-duplicated/v2': [
      {
        data: {
          project: {
            id: 'project-duplicate-example-1', workspaceId,
            name: 'AnÃºncio de descoberta â€” variaÃ§Ã£o', status: 'draft',
            objective: 'discovery', format: '9:16', locale: 'pt-BR', ownerId: clientId,
            currentVersionId: 'project-version-duplicate-example-1', duplicatedFromProjectId: projectId,
            createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'draft', tone: 'neutral',
              progress: { mode: 'not-started', percent: 0 }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: false,
            },
          },
          version: {
            id: 'project-version-duplicate-example-1', sequence: 1, baseHash: 'b'.repeat(64),
            forkedFromProjectId: projectId, forkedFromVersionId: 'project-version-example-1',
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', editPlan: 'project-snapshot-edit-plan-1',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'current', tone: 'info',
              progress: { mode: 'none' }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: false,
            },
          },
          sharedArtifactIds: ['artifact-example-source-1'], copiedBytes: 0, replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/run-mvp-core-gate-request/v1': [
      {
        primaryVersionId: mvpCorePrimaryVersionId,
        primaryVersionHash: 'a'.repeat(64),
        companionProjectId: mvpCoreCompanionProjectId,
        companionVersionId: mvpCoreCompanionVersionId,
        companionVersionHash: 'b'.repeat(64),
        duplicateProjectId: mvpCoreDuplicateProjectId,
      },
    ],
    'apollo://schemas/mvp-core-gate-executed/v1': [
      {
        data: {
          gate: mvpCoreGateExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/mvp-core-gate-list/v1': [
      {
        data: { gates: [mvpCoreGateExample] },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/catalog-speech-segments-request/v1': [
      {
        sourceTranscriptId: speechSegmentExample.sourceTranscriptId,
        expectedTranscriptHash: speechSegmentExample.sourceTranscriptHash,
        extractionPolicyVersion: 'speech-segment-extraction/v1',
        producer: speechCatalogProducerExample,
        annotations: [{
          sourceSegmentId: speechSegmentExample.sourceSegmentId,
          speaker: { value: 'person-specialist', confidence: 0.99 },
          visual: {
            emotion: { value: 'Confiante', confidence: 0.92 },
            expression: { value: 'Sorriso leve', confidence: 0.88 },
            wardrobe: { value: 'Camisa azul', confidence: 0.95 },
            setting: { value: 'Estúdio claro', confidence: 0.9 },
            colors: [{ value: 'Azul', confidence: 0.9 }],
          },
          intentions: [
            { value: 'Hook de autoridade', confidence: 0.94 },
          ],
        }],
      },
    ],
    'apollo://schemas/speech-segment-cataloged/v1': [
      {
        data: {
          run: speechCatalogRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/speech-segment-search-results/v1': [
      {
        data: {
          results: [{
            segment: speechSegmentExample,
            matchedBy: [
              'speech',
              'intention',
              'person',
              'wardrobe',
            ],
            rightsStatus: 'approved',
            eligibleForReuse: true,
            blockedReasons: [],
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/catalog-evidence-segment-request/v1': [
      {
        sourceSpeechSegmentId: evidenceSegmentExample.sourceSpeechSegmentId,
        expectedSpeechSegmentHash:
          evidenceSegmentExample.sourceSpeechSegmentHash,
        category: evidenceSegmentExample.category,
        claim: {
          value: evidenceSegmentExample.claim.value,
          confidence: 0.96,
        },
        result: {
          value: evidenceSegmentExample.result.value,
          confidence: 0.94,
        },
        context: {
          value: evidenceSegmentExample.context.value,
          confidence: 0.95,
        },
        qualifiers: [{
          value: evidenceSegmentExample.qualifiers[0].value,
          confidence: 0.98,
        }],
        subject: {
          value: evidenceSegmentExample.subject.value,
          confidence: 0.99,
        },
        attribution: {
          value: evidenceSegmentExample.attribution.value,
          confidence: 0.99,
        },
        compatibleOfferIds: evidenceSegmentExample.compatibleOfferIds,
        compatibleAudienceTags:
          evidenceSegmentExample.compatibleAudienceTags,
        compatibleObjections:
          evidenceSegmentExample.compatibleObjections,
        credibilityScore: evidenceSegmentExample.credibilityScore,
        specificityScore: evidenceSegmentExample.specificityScore,
        authenticityScore: evidenceSegmentExample.authenticityScore,
        contextRangeMs: evidenceSegmentExample.contextRangeMs,
        frameRefs: evidenceSegmentExample.frameRefs,
        adjacentEvidenceIds: evidenceSegmentExample.adjacentEvidenceIds,
        requiresContext: true,
        producer: evidenceProducerExample,
      },
    ],
    'apollo://schemas/evidence-segment-cataloged/v1': [
      {
        data: {
          evidence: evidenceSegmentExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/evidence-segment-search-results/v1': [
      {
        data: {
          results: [{
            evidence: evidenceSegmentExample,
            matchedBy: ['text', 'category', 'offer', 'objection'],
            reuseDecision: {
              allowed: true,
              reasons: [],
              requiredContextRangeMs:
                evidenceSegmentExample.contextRangeMs,
              requiredAdjacentEvidenceIds: [],
              requiredQualifierValues: [
                evidenceSegmentExample.qualifiers[0].value,
              ],
              rightsSnapshotId: evidenceSegmentExample.rightsSnapshotId,
            },
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/catalog-long-form-moments-request/v1': [
      {
        sourceArtifactId: longFormIndexRunExample.sourceArtifactId,
        expectedArtifactSha256:
          longFormIndexRunExample.sourceArtifactSha256,
        sourceManifestId: longFormIndexRunExample.sourceManifestId,
        expectedManifestHash: longFormIndexRunExample.sourceManifestHash,
        indexPolicyVersion: 'long-form-index/v1',
        producer: longFormProducerExample,
        chapters: [
          {
            sourceChapterId:
              longFormChapterTrafficExample.sourceChapterId,
            title: {
              value: longFormChapterTrafficExample.title.value,
              confidence: 0.96,
            },
            topicPath: longFormChapterTrafficExample.topicPath,
            rangeMs: longFormChapterTrafficExample.rangeMs,
          },
          {
            sourceChapterId:
              longFormChapterOfferExample.sourceChapterId,
            title: {
              value: longFormChapterOfferExample.title.value,
              confidence: 0.96,
            },
            topicPath: longFormChapterOfferExample.topicPath,
            rangeMs: longFormChapterOfferExample.rangeMs,
          },
        ],
        moments: [
          {
            sourceMomentId:
              longFormMomentTrafficExample.sourceMomentId,
            sourceChapterId:
              longFormChapterTrafficExample.sourceChapterId,
            topic: {
              value: longFormMomentTrafficExample.topic.value,
              confidence: 0.96,
            },
            summary: {
              value: longFormMomentTrafficExample.summary.value,
              confidence: 0.96,
            },
            keyQuote: {
              value: longFormMomentTrafficExample.keyQuote.value,
              confidence: 0.96,
            },
            speakerIds: longFormMomentTrafficExample.speakerIds,
            rangesMs: longFormMomentTrafficExample.rangesMs,
            recommendedRangeIndex: 0,
            evidenceSpanIds:
              longFormMomentTrafficExample.evidenceSpanIds,
            salience: longFormMomentTrafficExample.salience,
            hookPotential: longFormMomentTrafficExample.hookPotential,
            standaloneScore:
              longFormMomentTrafficExample.standaloneScore,
            contextScore: longFormMomentTrafficExample.contextScore,
            insightDensity:
              longFormMomentTrafficExample.insightDensity,
            roles: longFormMomentTrafficExample.roles,
            tags: longFormMomentTrafficExample.tags,
          },
          {
            sourceMomentId:
              longFormMomentOfferExample.sourceMomentId,
            sourceChapterId:
              longFormChapterOfferExample.sourceChapterId,
            topic: {
              value: longFormMomentOfferExample.topic.value,
              confidence: 0.97,
            },
            summary: {
              value: longFormMomentOfferExample.summary.value,
              confidence: 0.97,
            },
            keyQuote: {
              value: longFormMomentOfferExample.keyQuote.value,
              confidence: 0.97,
            },
            speakerIds: longFormMomentOfferExample.speakerIds,
            rangesMs: longFormMomentOfferExample.rangesMs,
            recommendedRangeIndex: 0,
            evidenceSpanIds:
              longFormMomentOfferExample.evidenceSpanIds,
            salience: longFormMomentOfferExample.salience,
            hookPotential: longFormMomentOfferExample.hookPotential,
            standaloneScore:
              longFormMomentOfferExample.standaloneScore,
            contextScore: longFormMomentOfferExample.contextScore,
            insightDensity:
              longFormMomentOfferExample.insightDensity,
            roles: longFormMomentOfferExample.roles,
            tags: longFormMomentOfferExample.tags,
          },
        ],
      },
    ],
    'apollo://schemas/long-form-moments-cataloged/v1': [
      {
        data: {
          run: longFormIndexRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/long-form-moment-search-results/v1': [
      {
        data: {
          results: [{
            moment: longFormMomentOfferExample,
            chapter: longFormChapterOfferExample,
            matchedBy: ['text', 'speaker', 'role', 'salience'],
            preview: {
              sourceArtifactId:
                longFormMomentOfferExample.sourceArtifactId,
              masterDurationMs: 7_200_000,
              requestedContextMs: { before: 10_000, after: 10_000 },
              primary: {
                sourceRangeMs:
                  longFormMomentOfferExample.recommendedRangeMs,
                previewRangeMs: [3_990_000, 4_040_000],
                clippedBefore: false,
                clippedAfter: false,
              },
              ranges: [{
                sourceRangeMs:
                  longFormMomentOfferExample.recommendedRangeMs,
                previewRangeMs: [3_990_000, 4_040_000],
                clippedBefore: false,
                clippedAfter: false,
              }],
            },
            rightsSnapshotId:
              longFormIndexRunExample.rightsSnapshotId,
            rightsStatus: 'approved',
            consentStatus: 'not-required',
            eligibleForReuse: true,
            blockedReasons: [],
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/catalog-validated-segment-request/v1': [
      {
        sourceArtifactId: validatedSegmentExample.sourceArtifactId,
        expectedArtifactSha256:
          validatedSegmentExample.sourceArtifactSha256,
        sourceManifestId: validatedSegmentExample.sourceManifestId,
        expectedManifestHash:
          validatedSegmentExample.sourceManifestHash,
        sourceSpeechSegmentId:
          validatedSegmentExample.sourceSpeechSegmentId,
        expectedSpeechSegmentHash:
          validatedSegmentExample.sourceSpeechSegmentHash,
        policyVersion: 'validated-segment/v1',
        scope: validatedSegmentExample.scope,
        source: validatedSegmentExample.source,
        performance: validatedSegmentExample.performance,
        validatedAt: validatedSegmentExample.validatedAt,
        expiresAt: validatedSegmentExample.expiresAt,
      },
    ],
    'apollo://schemas/validated-segment-cataloged/v1': [
      {
        data: {
          segment: validatedSegmentExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/validated-segment-search-results/v1': [
      {
        data: {
          results: [{
            segment: validatedSegmentExample,
            matchedBy: [
              'text',
              'platform',
              'unit',
              'evidence-scope',
              'metric',
              'active-at',
            ],
            currentRightsSnapshotId: rightsSnapshotId,
            currentRightsStatus: 'approved',
            currentConsentStatus: 'not-required',
            eligibleForReuse: true,
            blockedReasons: [],
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/preflight-validated-segment-reuse-request/v1': [
      {
        targetRecipe:
          validatedSegmentReuseDecisionExample.targetRecipe,
        requestedChanges: [],
        claim: 'historical-association',
      },
      {
        targetRecipe:
          validatedSegmentReuseDecisionExample.targetRecipe,
        requestedChanges: ['copy'],
        claim: 'causality',
      },
    ],
    'apollo://schemas/validated-segment-reuse-preflight/v1': [
      {
        data: {
          decision: validatedSegmentReuseDecisionExample,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/catalog-semantic-search-document-request/v1': [
      {
        source: {
          type: semanticSearchDocumentExample.source.type,
          id: semanticSearchDocumentExample.source.id,
        },
        expectedSourceHash:
          semanticSearchDocumentExample.source.hash,
        indexVersion: 'semantic-search-index/v1',
        observations: {
          ocrText: semanticSearchDocumentExample.ocrText,
          description: semanticSearchDocumentExample.description,
          intentions: semanticSearchDocumentExample.intentions,
          personIds: semanticSearchDocumentExample.personIds,
          metadata: semanticSearchDocumentExample.metadata,
          producer: semanticSearchDocumentExample.producer,
        },
      },
    ],
    'apollo://schemas/semantic-search-document-cataloged/v1': [
      {
        data: {
          document: semanticSearchDocumentExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/hybrid-search-query-request/v1': [
      hybridSearchQueryExample,
    ],
    'apollo://schemas/hybrid-search-results/v1': [
      {
        data: {
          schemaVersion: 'hybrid-search-results/v1',
          query: hybridSearchQueryExample,
          queryHash: '8'.repeat(64),
          resultSetHash: 'a'.repeat(64),
          semantic: {
            state: 'ready',
            provider: 'openai',
            model: 'text-embedding-3-small',
            version: '2024-01-25',
            dimensions: 256,
            degraded: false,
          },
          rerankPolicyVersion: 'hybrid-rerank/v1',
          results: [{
            document: semanticSearchDocumentExample,
            score: 0.97,
            scoreBreakdown: {
              fullText: 1,
              vector: 0.95,
              intention: 1,
              structured: 1,
              rights: 1,
            },
            matchedBy: [
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
            blockedReasons: [],
            eligibleForReuse: true,
            rerankPolicyVersion: 'hybrid-rerank/v1',
          }],
          evaluatedAt: createdAt,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/evaluate-hybrid-retrieval-request/v1': [
      {
        k: 5,
        cases: [{
          id: 'case-proof-image',
          query: {
            text: hybridSearchQueryExample.text,
            intention: hybridSearchQueryExample.intention,
            rightsUse: hybridSearchQueryExample.rightsUse,
            filters: hybridSearchQueryExample.filters,
            includeBlocked: false,
          },
          relevantIdentityKeys: [
            semanticSearchDocumentExample.identityKey,
          ],
        }],
      },
    ],
    'apollo://schemas/hybrid-retrieval-evaluated/v1': [
      {
        data: {
          evaluation: retrievalEvaluationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/evaluate-retrieval-scale-request/v1': [
      {
        scope: 'workspace',
        k: 5,
        cases: [
          {
            id: 'scale-intention',
            query: {
              intention: hybridSearchQueryExample.intention,
              rightsUse: hybridSearchQueryExample.rightsUse,
            },
            relevantIdentityKeys: [
              semanticSearchDocumentExample.identityKey,
            ],
          },
          {
            id: 'scale-speech',
            query: {
              speech: hybridSearchQueryExample.speech,
              rightsUse: hybridSearchQueryExample.rightsUse,
            },
            relevantIdentityKeys: [
              semanticSearchDocumentExample.identityKey,
            ],
          },
          {
            id: 'scale-visual',
            query: {
              visual: hybridSearchQueryExample.visual,
              rightsUse: hybridSearchQueryExample.rightsUse,
            },
            relevantIdentityKeys: [
              semanticSearchDocumentExample.identityKey,
            ],
          },
        ],
      },
    ],
    'apollo://schemas/retrieval-scale-evaluated/v1': [
      {
        data: {
          evaluation: retrievalScaleEvaluationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/record-semantic-reuse-request/v1': [
      {
        query: hybridSearchQueryExample,
        expectedQueryHash: semanticReuseRunExample.queryHash,
        expectedResultSetHash:
          semanticReuseRunExample.resultSetHash,
        reusedIdentityKeys:
          semanticReuseRunExample.reusedIdentityKeys,
        directorRejections: [],
      },
    ],
    'apollo://schemas/semantic-reuse-recorded/v1': [
      {
        data: {
          run: semanticReuseRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/execute-hierarchical-processing-request/v1': [
      hierarchicalProcessingRequestExample,
      {
        ...hierarchicalProcessingRequestExample,
        previousRun: {
          id: hierarchicalProcessingRunExample.id,
          expectedRunHash: hierarchicalProcessingRunExample.runHash,
        },
        tierVersions: {
          ...hierarchicalTierVersionsExample,
          vision: {
            ...hierarchicalTierVersionsExample.vision,
            version: '2.0.0',
          },
        },
      },
    ],
    'apollo://schemas/hierarchical-processing-executed/v1': [
      {
        data: {
          run: hierarchicalProcessingRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/hierarchical-processing-run-read/v1': [
      {
        data: { run: hierarchicalProcessingRunExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-source-deconstruction-request/v1': [
      sourceDeconstructionRequestExample,
    ],
    'apollo://schemas/source-deconstruction-mutated/v1': [
      {
        data: {
          report: sourceDeconstructionReportExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/source-deconstruction-read/v1': [
      {
        data: { report: sourceDeconstructionReportExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/source-deconstruction-comparison-read/v1': [
      {
        data: {
          comparison: sourceDeconstructionComparisonExample,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/source-deconstruction-page/v1': [
      {
        data: {
          reports: [sourceDeconstructionReportExample],
          nextCursor: sourceDeconstructionReportExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-contamination-report-request/v1': [
      contaminationRequestExample,
    ],
    'apollo://schemas/contamination-report-mutated/v1': [
      {
        data: {
          report: contaminationReportExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/contamination-report-read/v1': [
      {
        data: { report: contaminationReportExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/contamination-diagnostics-read/v1': [
      {
        data: { diagnostics: contaminationDiagnosticsExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/contamination-report-page/v1': [
      {
        data: {
          reports: [contaminationReportExample],
          nextCursor: contaminationReportExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-source-cleanup-request/v1': [
      sourceCleanupRequestExample,
    ],
    'apollo://schemas/source-cleanup-mutated/v1': [
      {
        data: {
          cleanup: sourceCleanupRecordExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/source-cleanup-read/v1': [
      {
        data: { cleanup: sourceCleanupRecordExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/source-cleanup-page/v1': [
      {
        data: {
          cleanups: [sourceCleanupRecordExample],
          nextCursor: sourceCleanupPlanExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-validation-envelope-reuse-request/v1': [
      validationEnvelopeCreateRequestExample,
    ],
    'apollo://schemas/decide-validation-envelope-reuse-request/v1': [
      {
        expectedPlanHash: validationEnvelopePlanExample.planHash,
        action: 'approve',
        note: 'Aprovo conscientemente a perda da validação histórica.',
      },
    ],
    'apollo://schemas/validation-envelope-reuse-mutated/v1': [
      {
        data: {
          reuse: validationEnvelopeRecordExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/validation-envelope-reuse-read/v1': [
      {
        data: { reuse: validationEnvelopeRecordExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/validation-envelope-reuse-page/v1': [
      {
        data: {
          reuses: [validationEnvelopeRecordExample],
          nextCursor: validationEnvelopePlanExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-contiguous-extraction-request/v1': [
      contiguousExtractionRequestExample,
    ],
    'apollo://schemas/contiguous-extraction-mutated/v1': [
      {
        data: {
          extraction: contiguousExtractionExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/contiguous-extraction-read/v1': [
      {
        data: { extraction: contiguousExtractionExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-proof-need-run-request/v1': [
      proofNeedCreateRequestExample,
    ],
    'apollo://schemas/proof-need-run-mutated/v1': [
      {
        data: {
          run: proofNeedRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/proof-need-run-read/v1': [
      {
        data: { run: proofNeedRunExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/proof-need-run-page/v1': [
      {
        data: {
          runs: [proofNeedRunExample],
          nextCursor: proofNeedRunExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-proof-integrity-run-request/v1': [
      proofIntegrityCreateRequestExample,
    ],
    'apollo://schemas/proof-integrity-run-mutated/v1': [
      {
        data: {
          run: proofIntegrityRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/proof-integrity-run-read/v1': [
      {
        data: { run: proofIntegrityRunExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/proof-integrity-run-page/v1': [
      {
        data: {
          runs: [proofIntegrityRunExample],
          nextCursor: proofIntegrityRunExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-proof-mode-run-request/v1': [
      proofModeCreateRequestExample,
    ],
    'apollo://schemas/proof-mode-run-mutated/v1': [
      {
        data: {
          run: proofModeRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/proof-mode-run-read/v1': [
      {
        data: { run: proofModeRunExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/proof-mode-run-page/v1': [
      {
        data: {
          runs: [proofModeRunExample],
          nextCursor: proofModeRunExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-production-batch-request/v1': [
      productionBatchCreateRequestExample,
    ],
    'apollo://schemas/production-batch-mutated/v1': [
      {
        data: {
          batch: productionBatchExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/production-batch-mutated/v2': [
      {
        data: {
          batch: productionBatchVisibleExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v6': [
      {
        data: {
          project: {
            id: projectId, workspaceId, name: 'Anuncio de descoberta', status: 'completed',
            objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'completed', tone: 'success',
              progress: { mode: 'complete', percent: 100 }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: true,
            },
          },
          version: { id: 'project-version-example-4', sequence: 4, baseHash: 'd'.repeat(64), createdAt },
          editPlan: { id: 'edit-plan-example-4', state: 'compiled', fps: 30, durationFrames: 2380, clipCount: 3, cutCount: 2, automaticZoom: false, subtitleFaceProtection: true },
          commands: [{
            id: 'edit-command-director-example-1', type: 'run-director', baseVersionId: 'project-version-example-3',
            resultVersionId: 'project-version-example-4', reason: 'Planejar e revisar a composicao completa.', createdAt,
          }],
          directorRuns: [{
            id: 'director-run-example-1', status: 'succeeded', plannerVersion: 'apollo-director-policy/v1', criticVersion: 'apollo-director-critic/v1',
            baseVersionId: 'project-version-example-3', resultVersionId: 'project-version-example-4',
            treatmentSnapshotId: 'project-snapshot-treatment-1', storySnapshotId: 'project-snapshot-story-1', qualitySnapshotId: 'project-snapshot-quality-1',
            qualityStatus: 'approved-with-warnings', qualityScore: 0.9, decisionCount: 6, assumptionCount: 2,
            subtitleCueCount: 28, transitionCount: 2, automaticZoom: false, createdAt,
          }],
          media: [{
            id: 'project-media-final-example-1', role: 'final-output', originalFileName: 'video-final-1080x1920.mp4',
            artifactId: 'artifact-final-example-1', manifestId: 'manifest-final-example-1', mediaType: 'video', container: 'mp4',
            byteSize: '6234567', sha256: 'f'.repeat(64), status: 'available', probe: { width: 1080, height: 1920, duration: 79.3, fps: 30 }, createdAt,
          }],
          transcripts: [],
          operationIds: [queuedProjectFinalExportOperationExample.id],
          operations: [{
            ...queuedProjectFinalExportOperationExample,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'queued', tone: 'neutral',
              progress: { mode: 'not-started', percent: 0 }, primaryAction: 'view-progress',
              availableActions: ['view-progress', 'cancel'], terminal: false,
            },
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-workspace/v7': [
      {
        data: {
          project: {
            id: projectId, workspaceId, name: 'Anuncio de descoberta', status: 'completed',
            objective: 'discovery', format: '9:16', locale: 'pt-BR', createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'completed', tone: 'success',
              progress: { mode: 'complete', percent: 100 }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: true,
            },
          },
          version: {
            id: 'project-version-example-4', sequence: 4, baseHash: 'd'.repeat(64), createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'current', tone: 'info',
              progress: { mode: 'none' }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: false,
            },
          },
          commands: [], directorRuns: [], media: [], transcripts: [], operationIds: [], operations: [],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-created/v3': [
      {
        data: {
          project: {
            id: projectId,
            workspaceId,
            name: 'AnÃºncio de descoberta',
            status: 'draft',
            objective: 'discovery',
            format: '9:16',
            locale: 'pt-BR',
            ownerId: clientId,
            currentVersionId: 'project-version-example-1',
            createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1',
              label: 'draft',
              tone: 'neutral',
              progress: { mode: 'not-started', percent: 0 },
              primaryAction: 'open-result',
              availableActions: ['open-result'],
              terminal: false,
            },
          },
          version: {
            id: 'project-version-example-1',
            sequence: 1,
            baseHash: 'a'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1',
              editPlan: 'project-snapshot-edit-plan-1',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-created/v4': [
      {
        data: {
          project: {
            id: projectId, workspaceId, name: 'AnÃƒÂºncio de descoberta', status: 'draft',
            objective: 'discovery', format: '9:16', locale: 'pt-BR', ownerId: clientId,
            currentVersionId: 'project-version-example-1', createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'draft', tone: 'neutral',
              progress: { mode: 'not-started', percent: 0 }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: false,
            },
          },
          version: {
            id: 'project-version-example-1', sequence: 1, baseHash: 'a'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', editPlan: 'project-snapshot-edit-plan-1',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'current', tone: 'info',
              progress: { mode: 'none' }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: false,
            },
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-list/v4': [
      { data: { projects: [] }, meta: { apiVersion: 'v1' } },
      {
        data: {
          projects: [{
            id: projectId, workspaceId, name: 'Anúncio de descoberta', status: 'draft',
            currentVersionId: 'project-version-example-1', objective: 'discovery', format: '9:16',
            locale: 'pt-BR', ownerId: 'client-example-1', createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'draft', tone: 'neutral',
              progress: { mode: 'not-started', percent: 0 },
              primaryAction: 'open-result', availableActions: ['open-result'], terminal: false,
            },
          }],
          nextCursor: Buffer.from('project-search-page-example').toString('base64url'),
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/production-batch-read/v1': [
      {
        data: { batch: productionBatchExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/production-batch-read/v2': [
      {
        data: { batch: productionBatchVisibleExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/production-batch-page/v1': [
      {
        data: {
          batches: [productionBatchExample],
          nextCursor: productionBatchExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/production-batch-page/v2': [
      {
        data: {
          batches: [productionBatchVisibleExample],
          nextCursor: productionBatchVisibleExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/production-batch-action-request/v1': [
      {
        action: 'cancel',
        expectedBatchRevision: 1,
      },
      {
        action: 'resume',
        expectedBatchRevision: 2,
      },
    ],
    'apollo://schemas/production-batch-item-action-request/v1': [
      {
        action: 'start-step',
        step: 'planning',
        expectedBatchRevision: 1,
        expectedItemRevision: 1,
      },
      {
        action: 'fail-step',
        step: 'rendering',
        expectedBatchRevision: 8,
        expectedItemRevision: 8,
        costMinorUnits: 25,
        cacheHit: false,
        error: {
          code: 'RENDER_TIMEOUT',
          message: 'Renderer exceeded the bounded attempt.',
        },
      },
      {
        action: 'complete-step',
        step: 'reviewing',
        expectedBatchRevision: 11,
        expectedItemRevision: 11,
        costMinorUnits: 5,
        cacheHit: false,
        artifactIds: ['artifact-final-example-1'],
      },
    ],
    'apollo://schemas/create-batch-partial-retry-request/v1': [
      batchPartialRetryRequestExample,
    ],
    'apollo://schemas/batch-partial-retry-mutated/v1': [
      {
        data: {
          batch: {
            ...productionBatchExample,
            revision: 10,
          },
          partialRetry: batchPartialRetryExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/batch-partial-retry-mutated/v2': [
      {
        data: {
          batch: productionBatchVisibleExample,
          partialRetry: batchPartialRetryExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/batch-partial-retry-read/v1': [
      {
        data: { partialRetry: batchPartialRetryExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/batch-partial-retry-page/v1': [
      {
        data: {
          partialRetries: [batchPartialRetryExample],
          nextCursor: batchPartialRetryExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-script-alignment-request/v1': [
      scriptAlignmentCreateRequestExample,
    ],
    'apollo://schemas/script-alignment-review-request/v1': [
      {
        expectedRevision: 1,
        decisions: [
          {
            targetKind: 'block',
            blockId: 'script-block-1',
            resolution: 'select-alternative',
            candidateId: 'script-candidate-example-2',
            note: 'Segundo take tem uma entrega mais direta.',
          },
          {
            targetKind: 'extra-take',
            extraTakeId: 'script-extra-example-1',
            resolution: 'reject-extra',
            note: 'Preparacao fora da composicao.',
          },
        ],
      },
    ],
    'apollo://schemas/script-alignment-mutated/v1': [
      {
        data: {
          alignment: scriptAlignmentRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/script-alignment-read/v1': [
      {
        data: { alignment: scriptAlignmentRunExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/script-alignment-page/v1': [
      {
        data: {
          alignments: [scriptAlignmentRunExample],
          nextCursor: scriptAlignmentRunExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-take-library-request/v1': [
      takeLibraryCreateRequestExample,
    ],
    'apollo://schemas/take-library-selection-request/v1': [
      {
        expectedRevision: 1,
        groupId: 'take-group-script-block-1',
        takeId: 'take-example-primary-1',
        protect: true,
        note: 'Performance escolhida e protegida pelo diretor.',
      },
    ],
    'apollo://schemas/take-library-mutated/v1': [
      {
        data: {
          library: takeLibraryRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/take-library-read/v1': [
      {
        data: { library: takeLibraryRunExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/take-library-page/v1': [
      {
        data: {
          libraries: [takeLibraryRunExample],
          nextCursor: takeLibraryRunExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-compatibility-graph-request/v1': [
      {
        takeLibraryId: takeLibraryRunExample.id,
        expectedTakeLibraryRunHash: takeLibraryRunExample.runHash,
        contexts: compatibilityContextsExample,
        acceptThreshold: 70,
        reviewThreshold: 60,
      },
    ],
    'apollo://schemas/compatibility-graph-mutated/v1': [
      {
        data: {
          graph: compatibilityGraphRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/compatibility-graph-read/v1': [
      {
        data: { graph: compatibilityGraphRunExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/compatibility-graph-page/v1': [
      {
        data: {
          graphs: [compatibilityGraphRunExample],
          nextCursor: compatibilityGraphRunExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-variant-recipe-request/v1': [
      {
        compatibilityGraphId: compatibilityGraphRunExample.id,
        expectedCompatibilityGraphRunHash:
          compatibilityGraphRunExample.runHash,
        selection: variantRecipeRunExample.selection,
        orderedNodeIds: variantRecipeRunExample.orderedNodeIds,
        assumptions: [
          {
            code: 'VALIDATED_HOOK_REUSED',
            statement: 'The selected hook was previously validated.',
            evidenceRefs: ['validated-hook-example-1'],
          },
        ],
        requireProof: false,
      },
    ],
    'apollo://schemas/variant-recipe-mutated/v1': [
      {
        data: {
          recipe: variantRecipeRunExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/variant-recipe-read/v1': [
      {
        data: { recipe: variantRecipeRunExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/variant-recipe-page/v1': [
      {
        data: {
          recipes: [variantRecipeRunExample],
          nextCursor: variantRecipeRunExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-variant-portfolio-preflight-request/v1': [
      {
        compatibilityGraphId: compatibilityGraphRunExample.id,
        expectedCompatibilityGraphRunHash:
          compatibilityGraphRunExample.runHash,
        requestedRecipeCount: 20,
        requireProof: false,
      },
    ],
    'apollo://schemas/variant-portfolio-preflight-mutated/v1': [
      {
        data: {
          preflight: variantPortfolioPreflightRunExample,
          replayed: false,
          confirmationToken:
            `${'a'.repeat(48)}.${'b'.repeat(43)}`,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/variant-portfolio-preflight-mutated/v2': [
      {
        data: {
          preflight: variantPortfolioPreflightRunExample,
          result: variantPortfolioPreflightResultExample,
          replayed: false,
          confirmationToken:
            `${'a'.repeat(48)}.${'b'.repeat(43)}`,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/variant-portfolio-preflight-read/v1': [
      {
        data: { preflight: variantPortfolioPreflightRunExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/variant-portfolio-preflight-page/v1': [
      {
        data: {
          preflights: [variantPortfolioPreflightRunExample],
          nextCursor: variantPortfolioPreflightRunExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-batch-edit-preflight-request/v1': [
      {
        expectedBatchRevision: 1,
        expectedBatchDefinitionHash:
          productionBatchExample.definitionHash,
        recipeIds: ['recipe-hook'],
        outputSpecIds: ['9:16'],
        itemIds: [productionBatchExample.items[0].id],
        operation: {
          type: 'subtitle-style',
          valueRef: 'subtitle-style-bold-purple',
        },
        mode: 'all-or-nothing',
      },
    ],
    'apollo://schemas/batch-edit-preflight-mutated/v1': [
      {
        data: {
          preflight: batchEditPreflightExample,
          replayed: false,
          commitToken: `${'c'.repeat(48)}.${'d'.repeat(43)}`,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/batch-edit-preflight-mutated/v2': [
      {
        data: {
          preflight: batchEditPreflightExample,
          result: batchEditPreflightResultExample,
          replayed: false,
          commitToken: `${'c'.repeat(48)}.${'d'.repeat(43)}`,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/batch-edit-preflight-read/v1': [
      {
        data: { preflight: batchEditPreflightExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/batch-edit-preflight-page/v1': [
      {
        data: {
          preflights: [batchEditPreflightExample],
          nextCursor: batchEditPreflightExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/commit-batch-edit-request/v1': [
      {
        expectedPreflightHash:
          batchEditPreflightExample.preflightHash,
        expectedScopeHash:
          batchEditPreflightExample.scope.scopeHash,
        commitToken: `${'c'.repeat(48)}.${'d'.repeat(43)}`,
      },
    ],
    'apollo://schemas/batch-edit-command-mutated/v1': [
      {
        data: {
          command: batchEditCommandExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/batch-edit-command-read/v1': [
      {
        data: { command: batchEditCommandExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/batch-edit-command-page/v1': [
      {
        data: {
          commands: [batchEditCommandExample],
          nextCursor: batchEditCommandExample.id,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/apply-project-edit-command-request/v1': [
      {
        type: 'remove-spoken-content', baseVersionId: 'project-version-example-1', baseHash: 'a'.repeat(64), sourceTranscriptId: 'transcript-example-1',
        rules: [
          { id: 'date-january-31', label: '31 de janeiro', alternatives: ['31 de janeiro', 'trinta e um de janeiro'] },
          { id: 'date-february-1', label: '1 de fevereiro', alternatives: ['1 de fevereiro', 'primeiro de fevereiro'] },
          { id: 'duration-two-days', label: 'dois dias', alternatives: ['dois dias', '2 dias'] },
        ],
      },
    ],
    'apollo://schemas/apply-project-edit-command-request/v2': [
      {
        type: 'remove-spoken-content',
        baseVersionId: 'project-version-example-1',
        baseHash: 'a'.repeat(64),
        sourceTranscriptId: 'transcript-example-1',
        rules: [
          { id: 'date-january-31', label: '31 de janeiro', alternatives: ['31 de janeiro', 'trinta e um de janeiro'] },
          { id: 'date-february-1', label: '1 de fevereiro', alternatives: ['1 de fevereiro', 'primeiro de fevereiro'] },
          { id: 'duration-two-days', label: 'dois dias', alternatives: ['dois dias', '2 dias'] },
        ],
        exclusionOverrides: [
          { sourceStartSeconds: 36.26, sourceEndSeconds: 58.12, ruleIds: ['date-january-31', 'date-february-1'], reason: 'Remover o bloco de agenda sem deixar uma frase quebrada.' },
          { sourceStartSeconds: 86.58, sourceEndSeconds: 87.76, ruleIds: ['duration-two-days'], reason: 'Remover apenas a duração, preservando o restante da promessa.' },
        ],
        reason: 'Remover informações de data e duração que não pertencem à nova composição.',
      },
    ],
    'apollo://schemas/apply-project-edit-command-request/v3': [
      {
        type: 'remove-spoken-content',
        baseVersionId: 'project-version-example-1',
        baseHash: 'a'.repeat(64),
        sourceTranscriptId: 'transcript-example-1',
        rules: [{ id: 'duration-two-days', label: 'dois dias', alternatives: ['dois dias', '2 dias'] }],
        reason: 'Remover a duracao obsoleta.',
      },
      {
        type: 'run-director',
        baseVersionId: 'project-version-example-3',
        baseHash: 'c'.repeat(64),
        reason: 'Planejar, criticar e materializar a composicao completa.',
      },
    ],
    'apollo://schemas/apply-project-edit-command-request/v4': [
      {
        type: 'remove-spoken-content', baseVersionId: 'project-version-example-1', baseHash: 'a'.repeat(64),
        sourceTranscriptId: 'transcript-example-1',
        rules: [{ id: 'duration-two-days', label: 'dois dias', alternatives: ['dois dias', '2 dias'] }],
      },
      {
        type: 'replace-source-transcript', baseVersionId: 'project-version-example-4', baseHash: 'd'.repeat(64),
        sourceTranscriptId: 'transcript-example-corrected-2', expectedTranscriptHash: '2'.repeat(64),
        reason: 'Selecionar a retranscrição revisada e recalcular todos os dependentes.',
      },
      {
        type: 'run-director', baseVersionId: 'project-version-example-5', baseHash: 'e'.repeat(64),
      },
    ],
    'apollo://schemas/apply-project-manual-edit-request/v1': [
      {
        action: 'apply',
        baseVersionId: 'project-version-example-4',
        baseHash: 'd'.repeat(64),
        expectedRevision: 4,
        variantId: 'output-spec-9x16',
        targetId: 'clip-example-1',
        operation: {
          kind: 'split',
          clipId: 'clip-example-1',
          atMs: 3120,
        },
        reason: 'Separar a frase para ajustar o ritmo.',
      },
      {
        action: 'undo',
        baseVersionId: 'project-version-example-5',
        baseHash: 'e'.repeat(64),
        expectedRevision: 5,
        variantId: 'output-spec-9x16',
        targetId: 'clip-example-1',
        targetVersionId: 'project-version-example-4',
      },
    ],
    'apollo://schemas/apply-project-manual-edit-request/v2': [
      {
        action: 'apply',
        baseVersionId: 'project-version-example-5',
        baseHash: 'e'.repeat(64),
        expectedRevision: 5,
        variantId: 'output-spec-9x16',
        targetId: 'clip-example-1',
        operation: {
          kind: 'crop',
          clipId: 'clip-example-1',
          crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
        },
        reason: 'Reenquadrar manualmente apenas o clip e formato selecionados.',
      },
    ],
    'apollo://schemas/project-version-comparison-action-request/v1': [
      {
        action: 'accept',
        beforeVersionId: 'project-version-example-4',
        afterVersionId: 'project-version-example-5',
        mode: 'split',
        baseVersionId: 'project-version-example-5',
        baseHash: 'e'.repeat(64),
        expectedRevision: 5,
        variantId: 'output-spec-9x16',
        reason: 'A versão depois resolve o problema sem introduzir bloqueios.',
      },
      {
        action: 'restore',
        beforeVersionId: 'project-version-example-4',
        afterVersionId: 'project-version-example-5',
        mode: 'overlay',
        baseVersionId: 'project-version-example-5',
        baseHash: 'e'.repeat(64),
        expectedRevision: 5,
        variantId: 'output-spec-9x16',
      },
    ],
    'apollo://schemas/project-edit-command-applied/v1': [
      {
        data: {
          command: {
            id: 'edit-command-example-1', type: 'remove-spoken-content',
            baseVersionId: 'project-version-example-1', resultVersionId: 'project-version-example-2', createdAt,
          },
          version: {
            id: 'project-version-example-2', sequence: 2, parentVersionId: 'project-version-example-1',
            baseHash: 'b'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', editPlan: 'project-snapshot-edit-plan-2', policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          editorial: {
            sourceTranscriptId: 'transcript-example-1', sourceArtifactId: artifactId,
            exclusions: [{
              sourceStartSeconds: 39.02, sourceEndSeconds: 42.68,
              ruleIds: ['date-january-31', 'date-february-1'],
              labels: ['31 de janeiro', '1 de fevereiro'],
              matchedText: '31 de janeiro | 1 de fevereiro',
            }],
            retainedSourceRanges: [
              { sourceStartSeconds: 0, sourceEndSeconds: 39.02 },
              { sourceStartSeconds: 42.68, sourceEndSeconds: 102.166 },
            ],
            outputDurationFrames: 2955, fps: 30, automaticZoom: false,
            protectedOpeningFrames: 120, subtitleFaceProtection: true,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-edit-command-applied/v2': [
      {
        data: {
          command: {
            id: 'edit-command-director-example-1', type: 'run-director',
            baseVersionId: 'project-version-example-3', resultVersionId: 'project-version-example-4', createdAt,
          },
          version: {
            id: 'project-version-example-4', sequence: 4, parentVersionId: 'project-version-example-3', baseHash: 'd'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', perception: 'project-snapshot-perception-1', treatment: 'project-snapshot-treatment-1',
              story: 'project-snapshot-story-1', editPlan: 'project-snapshot-edit-plan-4', quality: 'project-snapshot-quality-1', policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          directorRun: {
            id: 'director-run-example-1', status: 'planned', plannerVersion: 'apollo-director-policy/v1', criticVersion: 'apollo-director-critic/v1',
            baseVersionId: 'project-version-example-3', resultVersionId: 'project-version-example-4',
            perception: { snapshotId: 'project-snapshot-perception-1', summary: { speechCoverage: 0.78, visualCoverage: 'partial', faceCoverage: 'absent' } },
            treatmentPlan: { snapshotId: 'project-snapshot-treatment-1', plan: { mode: 'talking-head', objective: 'discovery' } },
            storyPlan: { snapshotId: 'project-snapshot-story-1', plan: { objective: 'discovery', blockCount: 3 } },
            editPlan: { snapshotId: 'project-snapshot-edit-plan-4', id: 'edit-plan-example-4', durationFrames: 2380, fps: 30, subtitleCueCount: 28, transitionCount: 2, automaticZoom: false },
            qualityReport: { snapshotId: 'project-snapshot-quality-1', report: { status: 'approved-with-warnings', score: 0.9 } },
            decisions: [
              { id: 'decision-narrative-linear', category: 'narrative', choice: 'preserve-linear-narrative' },
              { id: 'decision-motion-none', category: 'movement', choice: 'no_effect' },
              { id: 'decision-layout-inset', category: 'layout', choice: 'landscape-inset-on-blurred-source' },
              { id: 'decision-subtitle-bottom', category: 'subtitle', choice: 'bottom-face-safe-clean' },
            ],
            assumptions: ['Face detector indisponivel; aplicar safe area conservadora.'],
            createdAt,
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/source-transcript-replacement-impact/v1': [
      {
        schemaVersion: 'source-transcript-replacement-impact/v1',
        commandId: 'edit-command-transcript-example-1', commandType: 'replace-source-transcript',
        baseVersionId: 'project-version-example-4', resultVersionId: 'project-version-example-5',
        previousTranscriptId: 'transcript-example-1', previousTranscriptHash: '1'.repeat(64),
        replacementTranscriptId: 'transcript-example-corrected-2', replacementTranscriptHash: '2'.repeat(64),
        changeKinds: ['source-transcript'],
        dependencyTypes: ['audio', 'content', 'policy', 'timing', 'visual'],
        affectedRanges: [{ startFrame: 0, endFrame: 2380 }],
        affectedVariantIds: ['9:16'],
        affectedArtifacts: [{ artifactId: 'artifact-proxy-example-4', kind: 'proxy', sourceVersionId: 'project-version-example-4', variantId: '9:16' }],
        requiredRecomputations: ['perception', 'treatment', 'story', 'edit-plan', 'proxy', 'final'],
        renderBlockedUntilDirectorRun: true,
        impactHash: '3'.repeat(64),
      },
    ],
    'apollo://schemas/editorial-cut-impact/v1': [editorialCutImpactExample],
    'apollo://schemas/director-run-impact/v1': [directorRunImpactExample],
    'apollo://schemas/project-lut-selection-impact/v1': [projectLutSelectionImpactExample, projectLutSelectionDeferredImpactExample],
    'apollo://schemas/project-edit-command-applied/v3': [
      {
        data: {
          command: {
            id: 'edit-command-transcript-example-1', type: 'replace-source-transcript',
            baseVersionId: 'project-version-example-4', resultVersionId: 'project-version-example-5', createdAt,
          },
          version: {
            id: 'project-version-example-5', sequence: 5, parentVersionId: 'project-version-example-4',
            baseHash: 'e'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', treatment: 'project-snapshot-treatment-1', story: 'project-snapshot-story-1',
              editPlan: 'project-snapshot-edit-plan-5', policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          sourceTranscript: {
            previousTranscriptId: 'transcript-example-1', previousTranscriptHash: '1'.repeat(64),
            replacementTranscriptId: 'transcript-example-corrected-2', replacementTranscriptHash: '2'.repeat(64),
            impact: {
              schemaVersion: 'source-transcript-replacement-impact/v1',
              commandId: 'edit-command-transcript-example-1', commandType: 'replace-source-transcript',
              baseVersionId: 'project-version-example-4', resultVersionId: 'project-version-example-5',
              previousTranscriptId: 'transcript-example-1', previousTranscriptHash: '1'.repeat(64),
              replacementTranscriptId: 'transcript-example-corrected-2', replacementTranscriptHash: '2'.repeat(64),
              changeKinds: ['source-transcript'], dependencyTypes: ['audio', 'content', 'policy', 'timing', 'visual'],
              affectedRanges: [{ startFrame: 0, endFrame: 2380 }], affectedVariantIds: ['9:16'],
              affectedArtifacts: [{ artifactId: 'artifact-proxy-example-4', kind: 'proxy', sourceVersionId: 'project-version-example-4', variantId: '9:16' }],
              requiredRecomputations: ['perception', 'treatment', 'story', 'edit-plan', 'proxy', 'final'],
              renderBlockedUntilDirectorRun: true, impactHash: '3'.repeat(64),
            },
            invalidations: [{
              schemaVersion: 'command-artifact-invalidation/v1', id: '4'.repeat(64), status: 'stale',
              commandId: 'edit-command-transcript-example-1', baseVersionId: 'project-version-example-4', resultVersionId: 'project-version-example-5',
              artifactId: 'artifact-proxy-example-4', kind: 'proxy', variantId: '9:16',
              dependencyTypes: ['audio', 'content', 'policy', 'timing', 'visual'], affectedRanges: [{ startFrame: 0, endFrame: 2380 }],
              impactHash: '3'.repeat(64), createdAt,
            }],
            nextRequiredCapability: 'apollo.projects.commands.apply:run-director',
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-edit-command-applied/v4': [
      {
        data: {
          command: {
            id: editorialCutImpactExample.commandId, type: 'remove-spoken-content',
            baseVersionId: editorialCutImpactExample.baseVersionId,
            resultVersionId: editorialCutImpactExample.resultVersionId,
            createdAt,
          },
          version: {
            id: editorialCutImpactExample.resultVersionId, sequence: 2,
            parentVersionId: editorialCutImpactExample.baseVersionId,
            baseHash: 'b'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', editPlan: 'project-snapshot-edit-plan-2',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          editorial: {
            sourceTranscriptId: editorialCutImpactExample.sourceTranscriptId,
            sourceArtifactId: artifactId,
            exclusions: [{
              sourceStartSeconds: 39.02, sourceEndSeconds: 42.68,
              ruleIds: ['date-january-31', 'date-february-1'],
              labels: ['31 de janeiro', '1 de fevereiro'],
              matchedText: '31 de janeiro | 1 de fevereiro',
            }],
            retainedSourceRanges: [
              { sourceStartSeconds: 0, sourceEndSeconds: 39.02 },
              { sourceStartSeconds: 42.68, sourceEndSeconds: 102.166 },
            ],
            outputDurationFrames: 2955, fps: 30, automaticZoom: false,
            protectedOpeningFrames: 120, subtitleFaceProtection: true,
            impact: editorialCutImpactExample,
            invalidations: [editorialCutInvalidationExample],
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-edit-command-applied/v5': [
      {
        data: {
          command: {
            id: directorRunImpactExample.commandId, type: 'run-director',
            baseVersionId: directorRunImpactExample.baseVersionId,
            resultVersionId: directorRunImpactExample.resultVersionId,
            createdAt,
          },
          version: {
            id: directorRunImpactExample.resultVersionId, sequence: 4,
            parentVersionId: directorRunImpactExample.baseVersionId,
            baseHash: 'd'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', perception: 'project-snapshot-perception-1',
              treatment: 'project-snapshot-treatment-1', story: 'project-snapshot-story-1',
              editPlan: 'project-snapshot-edit-plan-4', quality: 'project-snapshot-quality-1',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          directorRun: {
            id: 'director-run-example-1', status: 'planned',
            plannerVersion: directorRunImpactExample.plannerVersion,
            criticVersion: directorRunImpactExample.criticVersion,
            baseVersionId: directorRunImpactExample.baseVersionId,
            resultVersionId: directorRunImpactExample.resultVersionId,
            perception: { snapshotId: 'project-snapshot-perception-1', summary: { speechCoverage: 0.78 } },
            treatmentPlan: { snapshotId: 'project-snapshot-treatment-1', plan: { mode: 'talking-head' } },
            storyPlan: { snapshotId: 'project-snapshot-story-1', plan: { blockCount: 3 } },
            editPlan: {
              snapshotId: 'project-snapshot-edit-plan-4', id: 'edit-plan-example-4',
              durationFrames: 2380, fps: 30, subtitleCueCount: 28,
              transitionCount: 2, automaticZoom: false,
            },
            qualityReport: { snapshotId: 'project-snapshot-quality-1', report: { status: 'approved-with-warnings', score: 0.9 } },
            decisions: [
              { id: 'decision-narrative-linear' }, { id: 'decision-motion-none' },
              { id: 'decision-layout-inset' }, { id: 'decision-subtitle-bottom' },
            ],
            assumptions: ['Face detector indisponivel; aplicar safe area conservadora.'],
            impact: directorRunImpactExample,
            invalidations: [directorRunInvalidationExample],
            createdAt,
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-edit-command-applied/v6': [
      {
        data: {
          command: {
            id: directorRunImpactExample.commandId, type: 'run-director',
            baseVersionId: directorRunImpactExample.baseVersionId,
            resultVersionId: directorRunImpactExample.resultVersionId, createdAt,
          },
          version: {
            id: directorRunImpactExample.resultVersionId, sequence: 4,
            parentVersionId: directorRunImpactExample.baseVersionId, baseHash: 'd'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', perception: 'project-snapshot-perception-1',
              treatment: 'project-snapshot-treatment-1', story: 'project-snapshot-story-1',
              editPlan: 'project-snapshot-edit-plan-4', quality: 'project-snapshot-quality-1',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'current', tone: 'info',
              progress: { mode: 'none' }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: false,
            },
          },
          directorRun: {
            id: 'director-run-example-1', status: 'planned',
            plannerVersion: directorRunImpactExample.plannerVersion,
            criticVersion: directorRunImpactExample.criticVersion,
            baseVersionId: directorRunImpactExample.baseVersionId,
            resultVersionId: directorRunImpactExample.resultVersionId,
            perception: { snapshotId: 'project-snapshot-perception-1', summary: { speechCoverage: 0.78 } },
            treatmentPlan: { snapshotId: 'project-snapshot-treatment-1', plan: { mode: 'talking-head' } },
            storyPlan: { snapshotId: 'project-snapshot-story-1', plan: { blockCount: 3 } },
            editPlan: {
              snapshotId: 'project-snapshot-edit-plan-4', id: 'edit-plan-example-4',
              durationFrames: 2380, fps: 30, subtitleCueCount: 28,
              transitionCount: 2, automaticZoom: false,
            },
            qualityReport: { snapshotId: 'project-snapshot-quality-1', report: { status: 'approved-with-warnings', score: 0.9 } },
            decisions: [
              { id: 'decision-narrative-linear' }, { id: 'decision-motion-none' },
              { id: 'decision-layout-inset' }, { id: 'decision-subtitle-bottom' },
            ],
            assumptions: ['Face detector indisponivel; aplicar safe area conservadora.'],
            impact: directorRunImpactExample,
            invalidations: [directorRunInvalidationExample],
            createdAt,
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-manual-timeline/v1': [
      {
        data: {
          timeline: {
            versionId: 'project-version-example-4',
            revision: 4,
            clips: [{
              id: 'clip-example-1',
              sourceId: 'artifact-example-1',
              startMs: 0,
              endMs: 5000,
              track: 0,
              selected: true,
              inspector: {},
            }],
            snapPointsMs: [0, 5000],
          },
          baseHash: 'd'.repeat(64),
          editPlanHash: '4'.repeat(64),
          history: [{
            id: 'project-version-example-4',
            sequence: 4,
            parentVersionId: 'project-version-example-3',
            commandId: 'edit-command-director-example-1',
            commandType: 'run-director',
            createdAt,
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-manual-timeline/v2': [
      {
        data: {
          timeline: {
            versionId: 'project-version-example-5',
            revision: 5,
            clips: [{
              id: 'clip-example-1',
              sourceId: 'artifact-example-1',
              startMs: 0,
              endMs: 5000,
              track: 0,
              selected: true,
              inspector: {},
              crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
            }],
            snapPointsMs: [0, 5000],
          },
          baseHash: 'e'.repeat(64),
          editPlanHash: '5'.repeat(64),
          history: [{
            id: 'project-version-example-5',
            sequence: 5,
            parentVersionId: 'project-version-example-4',
            commandId: 'manual-edit-command-example-crop',
            commandType: 'manual-edit',
            action: 'apply',
            createdAt,
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-manual-edit-applied/v1': [
      {
        data: {
          command: {
            id: 'manual-edit-command-example-1',
            type: 'manual-edit',
            action: 'apply',
            baseVersionId: 'project-version-example-4',
            resultVersionId: 'project-version-example-5',
            scope: {
              clipIds: ['clip-example-1'],
              outputSpecIds: ['output-spec-9x16'],
            },
            payload: {
              schemaVersion: 1,
              action: 'apply',
              expectedRevision: 4,
              variantId: 'output-spec-9x16',
              targetId: 'clip-example-1',
              operation: { kind: 'split', clipId: 'clip-example-1', atMs: 3120 },
            },
            createdAt,
          },
          version: {
            id: 'project-version-example-5',
            sequence: 5,
            parentVersionId: 'project-version-example-4',
            baseHash: 'e'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1',
              editPlan: 'project-snapshot-edit-plan-5',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          timeline: {
            versionId: 'project-version-example-5',
            revision: 5,
            clips: [
              { id: 'clip-example-1:a', sourceId: 'artifact-example-1', startMs: 0, endMs: 3120, track: 0, selected: true, inspector: {} },
              { id: 'clip-example-1:b', sourceId: 'artifact-example-1', startMs: 3120, endMs: 5000, track: 0, selected: false, inspector: {} },
            ],
            snapPointsMs: [0, 3120, 5000],
          },
          comparison: {
            beforeVersionId: 'project-version-example-4',
            afterVersionId: 'project-version-example-5',
            beforeEditPlanHash: '4'.repeat(64),
            afterEditPlanHash: '5'.repeat(64),
            action: 'apply',
            targetId: 'clip-example-1',
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-manual-edit-applied/v2': [
      {
        data: {
          command: {
            id: 'manual-edit-command-example-crop',
            type: 'manual-edit',
            action: 'apply',
            baseVersionId: 'project-version-example-4',
            resultVersionId: 'project-version-example-5',
            scope: {
              clipIds: ['clip-example-1'],
              outputSpecIds: ['output-spec-9x16'],
            },
            payload: {
              schemaVersion: 2,
              action: 'apply',
              expectedRevision: 4,
              variantId: 'output-spec-9x16',
              targetId: 'clip-example-1',
              operation: {
                kind: 'crop', clipId: 'clip-example-1',
                crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
              },
            },
            createdAt,
          },
          version: {
            id: 'project-version-example-5',
            sequence: 5,
            parentVersionId: 'project-version-example-4',
            baseHash: 'e'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1',
              editPlan: 'project-snapshot-edit-plan-5',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          timeline: {
            versionId: 'project-version-example-5',
            revision: 5,
            clips: [{
              id: 'clip-example-1', sourceId: 'artifact-example-1',
              startMs: 0, endMs: 5000, track: 0, selected: true, inspector: {},
              crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
            }],
            snapPointsMs: [0, 5000],
          },
          comparison: {
            beforeVersionId: 'project-version-example-4',
            afterVersionId: 'project-version-example-5',
            beforeEditPlanHash: '4'.repeat(64),
            afterEditPlanHash: '5'.repeat(64),
            action: 'apply',
            targetId: 'clip-example-1',
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-manual-edit-applied/v3': [
      {
        data: {
          command: {
            id: 'manual-edit-command-example-crop', type: 'manual-edit', action: 'apply',
            baseVersionId: 'project-version-example-4', resultVersionId: 'project-version-example-5',
            scope: { clipIds: ['clip-example-1'], outputSpecIds: ['output-spec-9x16'] },
            payload: {
              schemaVersion: 2, action: 'apply', expectedRevision: 4,
              variantId: 'output-spec-9x16', targetId: 'clip-example-1',
              operation: {
                kind: 'crop', clipId: 'clip-example-1',
                crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
              },
            },
            createdAt,
          },
          version: {
            id: 'project-version-example-5', sequence: 5,
            parentVersionId: 'project-version-example-4', baseHash: 'e'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', editPlan: 'project-snapshot-edit-plan-5',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'current', tone: 'info',
              progress: { mode: 'none' }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: false,
            },
          },
          timeline: {
            versionId: 'project-version-example-5', revision: 5,
            clips: [{
              id: 'clip-example-1', sourceId: 'artifact-example-1',
              startMs: 0, endMs: 5000, track: 0, selected: true, inspector: {},
              crop: { x: 0.2, y: 0, width: 0.6, height: 1 },
            }],
            snapPointsMs: [0, 5000],
          },
          comparison: {
            beforeVersionId: 'project-version-example-4', afterVersionId: 'project-version-example-5',
            beforeEditPlanHash: '4'.repeat(64), afterEditPlanHash: '5'.repeat(64),
            action: 'apply', targetId: 'clip-example-1',
          },
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-artifact-invalidations/v1': [{
      data: {
        projectId: 'project-example-1',
        resultVersionId: 'project-version-example-5',
        invalidations: [{
          schemaVersion: 'command-artifact-invalidation/v1',
          id: '8'.repeat(64),
          status: 'stale',
          commandId: 'manual-edit-command-example-1',
          baseVersionId: 'project-version-example-4',
          resultVersionId: 'project-version-example-5',
          artifactId: 'artifact-proxy-example-4',
          kind: 'proxy',
          variantId: 'output-spec-9x16',
          dependencyTypes: ['timing', 'visual', 'audio'],
          affectedRanges: [{ startFrame: 0, endFrame: 150 }],
          impactHash: '7'.repeat(64),
          createdAt,
        }],
      },
      meta: { apiVersion: 'v1' },
    }],
    'apollo://schemas/project-artifact-invalidations/v2': [{
      data: {
        projectId: 'project-example-1',
        resultVersionId: 'project-version-example-5',
        invalidations: [{
          schemaVersion: 'command-artifact-invalidation/v1',
          id: '8'.repeat(64), status: 'stale',
          commandId: 'manual-edit-command-example-1',
          baseVersionId: 'project-version-example-4',
          resultVersionId: 'project-version-example-5',
          artifactId: 'artifact-proxy-example-4', kind: 'proxy',
          variantId: 'output-spec-9x16',
          dependencyTypes: ['timing', 'visual', 'audio'],
          affectedRanges: [{ startFrame: 0, endFrame: 150 }],
          impactHash: '7'.repeat(64), createdAt,
          availabilityEffect: 'none',
          visibleState: {
            schemaVersion: 'visible-state/v1', label: 'stale-output',
            tone: 'warning', progress: { mode: 'none' },
            primaryAction: 'rebuild-output',
            availableActions: ['rebuild-output', 'open-historical-output'],
            terminal: false,
          },
        }],
      },
      meta: { apiVersion: 'v1' },
    }],
    'apollo://schemas/command-impact/v1': [{
      schemaVersion: 'command-impact/v1',
      commandId: 'manual-edit-command-example-2',
      commandType: 'manual-edit',
      baseVersionId: 'project-version-example-5',
      resultVersionId: 'project-version-example-6',
      changeKinds: ['inspect:subtitle'],
      dependencyTypes: ['visual'],
      affectedRanges: [{ startFrame: 0, endFrame: 150 }],
      affectedVariantIds: ['output-spec-9x16'],
      affectedArtifacts: [{
        artifactId: 'artifact-proxy-example-5',
        kind: 'proxy',
        sourceVersionId: 'project-version-example-5',
        variantId: 'output-spec-9x16',
      }],
      minimalRenders: [{
        kind: 'proxy',
        variantId: 'output-spec-9x16',
        ranges: [{ startFrame: 0, endFrame: 150 }],
      }],
      renderSemanticsChanged: true,
      impactHash: '585da7627612690643c46d0aefef96462ed50dbd9c81c0fbcd399a355ef1f550',
    }],
    'apollo://schemas/command-artifact-invalidation/v1': [{
      schemaVersion: 'command-artifact-invalidation/v1',
      id: '8'.repeat(64),
      status: 'stale',
      commandId: 'manual-edit-command-example-2',
      baseVersionId: 'project-version-example-5',
      resultVersionId: 'project-version-example-6',
      artifactId: 'artifact-proxy-example-5',
      kind: 'proxy',
      variantId: 'output-spec-9x16',
      dependencyTypes: ['visual'],
      affectedRanges: [{ startFrame: 0, endFrame: 150 }],
      impactHash: '585da7627612690643c46d0aefef96462ed50dbd9c81c0fbcd399a355ef1f550',
      createdAt,
    }],
    'apollo://schemas/command-artifact-invalidation/v2': [{
      schemaVersion: 'command-artifact-invalidation/v1',
      id: '8'.repeat(64), status: 'stale',
      commandId: 'manual-edit-command-example-2',
      baseVersionId: 'project-version-example-5',
      resultVersionId: 'project-version-example-6',
      artifactId: 'artifact-proxy-example-5', kind: 'proxy',
      variantId: 'output-spec-9x16', dependencyTypes: ['visual'],
      affectedRanges: [{ startFrame: 0, endFrame: 150 }],
      impactHash: '585da7627612690643c46d0aefef96462ed50dbd9c81c0fbcd399a355ef1f550',
      createdAt, availabilityEffect: 'none',
      visibleState: {
        schemaVersion: 'visible-state/v1', label: 'stale-output',
        tone: 'warning', progress: { mode: 'none' },
        primaryAction: 'rebuild-output',
        availableActions: ['rebuild-output', 'open-historical-output'],
        terminal: false,
      },
    }],
    'apollo://schemas/project-version-comparison/v1': [
      {
        data: {
          current: {
            versionId: 'project-version-example-5',
            baseHash: 'e'.repeat(64),
            revision: 5,
          },
          versions: {
            before: {
              id: 'project-version-example-4',
              sequence: 4,
              editPlanHash: '4'.repeat(64),
            },
            after: {
              id: 'project-version-example-5',
              sequence: 5,
              editPlanHash: '5'.repeat(64),
            },
          },
          comparison: versionComparisonExample,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-version-comparison-action-result/v1': [
      {
        data: {
          action: 'accept',
          command: {
            id: 'compare-command-example-1',
            type: 'compare-action',
            baseVersionId: 'project-version-example-5',
            scope: { project: true },
            payload: {
              schemaVersion: 1,
              action: 'accept',
              expectedRevision: 5,
              beforeVersionId: 'project-version-example-4',
              afterVersionId: 'project-version-example-5',
              mode: 'split',
              comparison: versionComparisonExample,
            },
            createdAt,
          },
          projectStatus: 'reviewing-proxy',
          comparison: versionComparisonExample,
          versionsPreserved: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          action: 'restore',
          command: {
            id: 'manual-restore-command-example-1',
            type: 'manual-edit',
            baseVersionId: 'project-version-example-5',
            resultVersionId: 'project-version-example-6',
            scope: { project: true },
            payload: {
              schemaVersion: 1,
              action: 'restore',
              expectedRevision: 5,
              variantId: 'output-spec-9x16',
              targetId: 'project-edit-plan',
              restoresVersionId: 'project-version-example-4',
            },
            createdAt,
          },
          version: {
            id: 'project-version-example-6',
            sequence: 6,
            parentVersionId: 'project-version-example-5',
            baseHash: 'f'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1',
              editPlan: 'project-snapshot-edit-plan-6',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
          },
          timeline: {
            versionId: 'project-version-example-6',
            revision: 6,
            clips: [{
              id: 'clip-example-1',
              sourceId: 'artifact-example-1',
              startMs: 0,
              endMs: 10000,
              track: 0,
              selected: false,
              inspector: {},
            }],
            snapPointsMs: [0, 10000],
          },
          comparison: versionComparisonExample,
          versionsPreserved: true,
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-version-comparison-action-result/v2': [
      {
        data: {
          action: 'accept',
          command: {
            id: 'compare-command-example-2',
            type: 'compare-action',
            baseVersionId: 'project-version-example-5',
            scope: { project: true },
            payload: {
              schemaVersion: 1,
              action: 'accept',
              expectedRevision: 5,
              beforeVersionId: 'project-version-example-4',
              afterVersionId: 'project-version-example-5',
              mode: 'split',
              comparison: versionComparisonExample,
            },
            createdAt,
          },
          projectStatus: 'reviewing-proxy',
          comparison: versionComparisonExample,
          versionsPreserved: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-version-comparison-action-result/v3': [
      {
        data: {
          action: 'accept',
          command: {
            id: 'compare-command-example-3',
            type: 'compare-action',
            baseVersionId: 'project-version-example-5',
            scope: { project: true },
            payload: {
              schemaVersion: 2,
              action: 'accept',
              expectedRevision: 5,
              beforeVersionId: 'project-version-example-4',
              afterVersionId: 'project-version-example-5',
              mode: 'split',
              comparison: versionComparisonExample,
              impact: compareActionImpactExample,
            },
            createdAt,
          },
          projectStatus: 'reviewing-proxy',
          comparison: versionComparisonExample,
          impact: compareActionImpactExample,
          versionsPreserved: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-version-comparison-action-result/v4': [
      {
        data: {
          action: 'accept',
          command: {
            id: 'compare-command-example-3', type: 'compare-action',
            baseVersionId: 'project-version-example-5', scope: { project: true },
            payload: {
              schemaVersion: 2, action: 'accept', expectedRevision: 5,
              beforeVersionId: 'project-version-example-4', afterVersionId: 'project-version-example-5',
              mode: 'split', comparison: versionComparisonExample, impact: compareActionImpactExample,
            },
            createdAt,
          },
          projectStatus: 'reviewing-proxy', comparison: versionComparisonExample,
          impact: compareActionImpactExample, versionsPreserved: true, replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
      {
        data: {
          action: 'restore',
          command: {
            id: 'manual-restore-command-example-1', type: 'manual-edit',
            baseVersionId: 'project-version-example-5', resultVersionId: 'project-version-example-6',
            scope: { project: true },
            payload: {
              schemaVersion: 1, action: 'restore', expectedRevision: 5,
              variantId: 'output-spec-9x16', targetId: 'project-edit-plan',
              restoresVersionId: 'project-version-example-4',
            },
            createdAt,
          },
          version: {
            id: 'project-version-example-6', sequence: 6,
            parentVersionId: 'project-version-example-5', baseHash: 'f'.repeat(64),
            snapshotRefs: {
              brief: 'project-snapshot-brief-1', editPlan: 'project-snapshot-edit-plan-6',
              policies: 'project-snapshot-policies-1',
            },
            createdAt,
            visibleState: {
              schemaVersion: 'visible-state/v1', label: 'current', tone: 'info',
              progress: { mode: 'none' }, primaryAction: 'open-result',
              availableActions: ['open-result'], terminal: false,
            },
          },
          timeline: {
            versionId: 'project-version-example-6', revision: 6,
            clips: [{
              id: 'clip-example-1', sourceId: 'artifact-example-1', startMs: 0,
              endMs: 10000, track: 0, selected: false, inspector: {},
            }],
            snapPointsMs: [0, 10000],
          },
          comparison: versionComparisonExample, versionsPreserved: true,
          operation: queuedProjectProxyRenderOperationExample, replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-proxy-render-operation-accepted/v1': [
      {
        data: {
          operation: queuedProjectProxyRenderOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/workspace-lut-import-request/v1': [{
      lutId: 'lut-cinema-example', name: 'Coração 🎞️', owner: 'Apollo Studio',
      license: { policy: 'owned', name: 'Propriedade do workspace' }, tags: ['cinema', 'coração'],
      compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 0.75,
      cubeContent: workspaceLutCubeExample,
    }],
    'apollo://schemas/workspace-lut-imported/v1': [{ data: { lut: workspaceLutExample, replayed: false }, meta: { apiVersion: 'v1' } }],
    'apollo://schemas/workspace-lut-response/v1': [{ data: { lut: workspaceLutExample }, meta: { apiVersion: 'v1' } }],
    'apollo://schemas/workspace-lut-list/v1': [{ data: { items: [workspaceLutExample] }, meta: { apiVersion: 'v1' } }],
    'apollo://schemas/workspace-lut-version-create-request/v1': [{
      baseVersion: 1, name: 'CoraÃ§Ã£o ðŸŽžï¸ v2', owner: 'Apollo Studio',
      license: { policy: 'owned', name: 'Propriedade do workspace' }, tags: ['cinema', 'v2'],
      compatibility: { inputColorSpace: 'rec709', outputColorSpace: 'rec709' }, intensity: 0.8, cubeContent: workspaceLutCubeExample,
    }],
    'apollo://schemas/workspace-lut-version-response/v1': [{ data: { version: workspaceLutExample.currentVersion }, meta: { apiVersion: 'v1' } }],
    'apollo://schemas/workspace-lut-lifecycle-response/v1': [{ data: { lifecycle: { id: workspaceLutExample.id, workspaceId, status: 'active', revision: 1, currentVersion: 1 } }, meta: { apiVersion: 'v1' } }],
    'apollo://schemas/workspace-lut-status-request/v1': [{ baseRevision: 1, status: 'inactive' }],
    'apollo://schemas/workspace-lut-status-applied/v1': [{
      data: {
        lifecycle: { id: workspaceLutExample.id, workspaceId, status: 'inactive', revision: 2, currentVersion: 1 },
        command: { id: 'lut-status-example-1', lutId: workspaceLutExample.id, baseRevision: 1, resultRevision: 2, status: 'inactive', createdByClientId: clientId, createdAt },
        replayed: false,
      },
      meta: { apiVersion: 'v1' },
    }],
    'apollo://schemas/workspace-lut-default-set-request/v1': [
      { baseRevision: 0, selection: { mode: 'lut-version', lutId: workspaceLutExample.id, version: 1 } },
      { baseRevision: 1, selection: { mode: 'none' } },
    ],
    'apollo://schemas/workspace-lut-default-response/v1': [
      { data: { default: { workspaceId, revision: 0, current: null } }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/workspace-lut-default-set/v1': [{
      data: {
        defaultVersion: { id: 'lut-default-example-1', revision: 1, mode: 'lut-version', selectionHash: 'c'.repeat(64), lut: { id: workspaceLutExample.id, versionId: workspaceLutExample.currentVersion.id, version: 1, name: workspaceLutExample.currentVersion.name, recordHash: workspaceLutExample.currentVersion.recordHash }, createdByClientId: clientId, createdAt },
        replayed: false,
      },
      meta: { apiVersion: 'v1' },
    }],
    'apollo://schemas/project-lut-selection-set-request/v1': [
      { baseVersionId: 'project-version-example-1', baseHash: 'a'.repeat(64), selection: { mode: 'workspace-default' }, reason: 'Usar o default aprovado.' },
      { baseVersionId: 'project-version-example-lut-2', baseHash: 'd'.repeat(64), selection: { mode: 'none' } },
    ],
    'apollo://schemas/project-lut-selection-applied/v1': [{ data: projectLutSelectionExample, meta: { apiVersion: 'v1' } }],
    'apollo://schemas/project-lut-selection-response/v1': [{ data: { result: projectLutSelectionExample }, meta: { apiVersion: 'v1' } }],
    'apollo://schemas/project-lut-selection-applied/v2': [
      { data: { ...projectLutSelectionExampleV2, operation: queuedProjectProxyRenderOperationExample }, meta: { apiVersion: 'v1' } },
      { data: projectLutSelectionDeferredExampleV2, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/project-lut-selection-response/v2': [
      { data: { result: projectLutSelectionExampleV2 }, meta: { apiVersion: 'v1' } },
      { data: { result: projectLutSelectionDeferredExampleV2 }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/project-lut-selection-applied/v3': [
      { data: { ...projectLutSelectionExampleV3, operation: queuedProjectProxyRenderOperationExample }, meta: { apiVersion: 'v1' } },
      { data: projectLutSelectionDeferredExampleV3, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/project-lut-selection-response/v3': [
      { data: { result: projectLutSelectionExampleV3 }, meta: { apiVersion: 'v1' } },
      { data: { result: projectLutSelectionDeferredExampleV3 }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/project-proxy-review-response/v1': [
      {
        data: { review: proxyReviewExample },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-proxy-review-warning-acknowledgement-request/v1': [
      {
        action: 'acknowledge-warnings',
        proxyReviewId: proxyReviewExample.id,
        projectVersionId: proxyReviewExample.projectVersionId,
        baseRevision: proxyReviewExample.reviewHash,
        expectedRevision: 1,
      },
    ],
    'apollo://schemas/project-proxy-review-warning-acknowledgement-result/v1': [
      {
        data: {
          review: {
            ...proxyReviewExample,
            status: 'ready-for-final',
            warningsAcknowledged: true,
            finalAllowed: true,
            reviewHash: 'b'.repeat(64),
            revision: 2,
            acknowledgedBy: { type: 'api-client', id: clientId, at: createdAt },
          },
          decision: {
            id: 'proxy-review-decision-example-1',
            proxyReviewId: proxyReviewExample.id,
            action: 'acknowledge-warnings',
            actor: { type: 'api-client', id: clientId },
            baseReviewHash: proxyReviewExample.reviewHash,
            resultReviewHash: 'b'.repeat(64),
            createdAt,
          },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-asset-selection-request/v1': [
      {
        projectVersionId: 'project-version-example-5',
        projectVersionHash: 'e'.repeat(64),
        brief: assetBriefExample,
        candidates: assetSelectionCandidatesExample,
      },
    ],
    'apollo://schemas/project-asset-selection-created/v1': [
      {
        data: { selection: assetSelectionExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
      {
        data: { selection: noInsertAssetSelectionExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-asset-selection-list/v1': [
      {
        data: { selections: [assetSelectionExample, noInsertAssetSelectionExample] },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-quality-iteration-request/v1': [
      qualityIterationRequestExample,
    ],
    'apollo://schemas/project-quality-iteration-created/v1': [
      {
        data: { iteration: qualityIterationExample, replayed: false },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-quality-iteration-list/v1': [
      {
        data: { iterations: [qualityIterationExample] },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-final-export-request/v1': [
      {
        projectVersionId: 'project-version-example-4', projectVersionHash: 'd'.repeat(64), format: '9:16',
        approval: { approved: true, note: 'Revisado e aprovado para entrega.' },
      },
    ],
    'apollo://schemas/project-final-export-operation-accepted/v1': [
      {
        data: {
          operation: queuedProjectFinalExportOperationExample,
          approval: { actorType: 'api-client', actorId: 'api-client-example-1', approvedAt: createdAt, note: 'Revisado e aprovado para entrega.' },
          outputSpec: { aspectRatio: '9:16', width: 1080, height: 1920, fps: 30 },
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/project-final-export-attempt-history/v1': [
      {
        data: {
          operationId: 'operation-project-final-example-1',
          projectId,
          projectVersionId: 'project-version-example-4',
          proxyReviewId: 'proxy-review-example-1',
          outputSpec: {
            aspectRatio: '9:16', width: 1080, height: 1920, fps: 30,
            codec: 'h264', audioCodec: 'aac', container: 'mp4', quality: 'final',
          },
          attempts: [
            {
              attempt: 1,
              status: 'promoted',
              validators: [
                { code: 'FINAL_CHECKSUM', passed: true, message: 'Output checksum and byte size are valid.' },
              ],
              output: {
                artifactId: 'artifact-final-example-1',
                manifestId: 'manifest-final-example-1',
                sha256: 'e'.repeat(64),
                byteSize: 1048576,
              },
              startedAt: createdAt,
              completedAt: createdAt,
            },
          ],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/api-client-list/v1': [
      { data: { clients: [] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/api-client-list/v2': [
      { data: { clients: [] }, meta: { apiVersion: 'v1' } },
    ],
    'apollo://schemas/api-access-change-request/v1': [
      {
        action: 'engage-kill-switch',
        baseRevision: '0'.repeat(64),
        reason: 'Emergency containment requested by the workspace owner',
        confirmed: true,
      },
    ],
    'apollo://schemas/api-access-read-response/v1': [
      {
        data: {
          access: {
            schemaVersion: 1, workspaceId, targetType: 'client', targetId: clientId,
            status: 'active', killSwitchEngaged: false, revision: '0'.repeat(64),
          },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/api-access-changed-response/v1': [
      {
        data: {
          access: {
            schemaVersion: 1, workspaceId, targetType: 'client', targetId: clientId,
            status: 'active', killSwitchEngaged: true, revision: '2'.repeat(64),
          },
          command: {
            schemaVersion: 1, id: 'api-access-command-example-1', workspaceId,
            targetType: 'client', targetId: clientId, action: 'engage-kill-switch',
            baseRevision: '0'.repeat(64), resultRevision: '2'.repeat(64),
            previousStatus: 'active', resultStatus: 'active',
            previousKillSwitchEngaged: false, resultKillSwitchEngaged: true,
            reason: 'Emergency containment requested by the workspace owner',
            actorClientId: 'client-example-admin', delegatedUserId: 'member-example-admin',
            idempotencyKey: 'access-example-1', requestFingerprint: '1'.repeat(64), changedAt: createdAt,
          },
          canceledOperationCount: 2,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-api-client-request/v1': [
      {
        name: 'Automation Agent',
        environment: 'sandbox',
        scopes: ['projects:read'],
      },
    ],
    'apollo://schemas/api-client-created/v1': [
      {
        data: {
          client: {
            id: clientId,
            workspaceId,
            name: 'Automation Agent',
            status: 'active',
            environment: 'sandbox',
            scopes: ['projects:read'],
            createdAt,
          },
          credential: {
            id: credentialId,
            clientId,
            status: 'active',
            createdAt,
          },
          token: `apollo_v2.${clientId}.${credentialId}.example-secret-that-is-not-valid`,
          secretAvailable: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/api-client-created/v2': [
      {
        data: {
          client: {
            id: clientId,
            workspaceId,
            name: 'Automation Agent',
            status: 'active',
            type: 'service-account',
            environment: 'sandbox',
            scopes: ['projects:read'],
            allowedEnvironments: ['sandbox'],
            scopeGrants: ['projects:read'],
            createdBy: 'client-example-admin',
            createdAt,
          },
          credential: {
            id: credentialId,
            clientId,
            status: 'active',
            createdAt,
          },
          token: `apollo_v2.${clientId}.${credentialId}.example-secret-that-is-not-valid`,
          secretAvailable: true,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/rotate-api-credential-request/v1': [
      {},
      { overlapSeconds: 900 },
    ],
    'apollo://schemas/api-credential-created/v1': [
      {
        data: {
          client: {
            id: clientId,
            workspaceId,
            name: 'Automation Agent',
            status: 'active',
            environment: 'sandbox',
            scopes: ['projects:read'],
            createdAt,
          },
          credential: {
            id: 'credential-example-2',
            clientId,
            status: 'active',
            createdAt,
          },
          secretAvailable: false,
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/api-credential-created/v2': [
      {
        data: {
          client: {
            id: clientId,
            workspaceId,
            name: 'Automation Agent',
            status: 'active',
            type: 'service-account',
            environment: 'sandbox',
            scopes: ['projects:read'],
            allowedEnvironments: ['sandbox'],
            scopeGrants: ['projects:read'],
            createdBy: 'client-example-admin',
            createdAt,
          },
          credential: {
            id: 'credential-example-2',
            clientId,
            status: 'active',
            createdAt,
          },
          secretAvailable: false,
          replayed: true,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/api-credential-revoked/v1': [
      {
        data: {
          credential: {
            id: credentialId,
            clientId,
            status: 'revoked',
            createdAt,
            revokedAt: '2026-07-12T20:10:00.000Z',
          },
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/create-long-form-index-workflow-request/v1': [
      createLongFormIndexWorkflowRequestExample,
    ],
    'apollo://schemas/long-form-index-workflow-mutated/v1': [
      {
        data: {
          workflow: longFormIndexWorkflowExampleV1,
          operation: queuedLongFormIndexOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/long-form-index-workflow-mutated/v2': [
      {
        data: {
          workflow: longFormIndexWorkflowExample,
          operation: queuedLongFormIndexOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/long-form-index-workflow-mutated/v3': [
      {
        data: {
          workflow: longFormIndexWorkflowExample,
          operation: queuedLongFormIndexCostOperationExample,
          replayed: false,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/long-form-index-workflow-read/v1': [
      {
        data: {
          workflow: longFormIndexWorkflowExampleV1,
          operation: queuedLongFormIndexOperationExample,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/long-form-index-workflow-read/v2': [
      {
        data: {
          workflow: longFormIndexWorkflowExample,
          operation: queuedLongFormIndexOperationExample,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/long-form-index-workflow-read/v3': [
      {
        data: {
          workflow: longFormIndexWorkflowExample,
          operation: queuedLongFormIndexCostOperationExample,
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/long-form-index-workflow-page/v1': [
      {
        data: {
          workflows: [{
            workflow: longFormIndexWorkflowExampleV1,
            operation: queuedLongFormIndexOperationExample,
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/long-form-index-workflow-page/v2': [
      {
        data: {
          workflows: [{
            workflow: longFormIndexWorkflowExample,
            operation: queuedLongFormIndexOperationExample,
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/long-form-index-workflow-page/v3': [
      {
        data: {
          workflows: [{
            workflow: longFormIndexWorkflowExample,
            operation: queuedLongFormIndexCostOperationExample,
          }],
        },
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/speaker-diarization-read/v1': [
      {
        data: speakerDiarizationRunExample,
        meta: { apiVersion: 'v1' },
      },
    ],
    'apollo://schemas/error-envelope/v1': [
      {
        error: {
          code: 'AUTH_INVALID',
          message: 'Invalid API credential',
          category: 'auth',
          retryable: false,
          requestId: 'request-example-1',
        },
      },
    ],
    'apollo://schemas/error-envelope/v2': [
      {
        error: {
          code: 'VERSION_CONFLICT',
          message: 'Command targets changed since its base version',
          category: 'conflict',
          retryable: false,
          requestId: 'request-conflict-example-1',
          conflict: {
            currentVersionId: 'project-version-example-2',
            conflictingTargets: ['clip:clip-example-1'],
            diff: {
              commands: ['command-example-intervening-1'],
              storyChanges: [],
              timelineChanges: [
                {
                  commandId: 'command-example-intervening-1',
                  target: 'clip:clip-example-1',
                  summary: 'Clip trim changed from the command base.',
                },
              ],
              visualChanges: [],
              audioChanges: [],
              outputChanges: [],
              invalidatedArtifacts: ['artifact-example-proxy-1'],
              estimatedCostDelta: 0,
            },
          },
        },
      },
    ],
    'apollo://schemas/error-envelope/v3': [
      {
        error: {
          code: 'WEBHOOK_CHALLENGE_TRANSPORT_FAILED',
          message: 'An external provider request could not be completed',
          category: 'provider',
          retryable: true,
          requestId: 'request-provider-example-1',
        },
      },
    ],
    'apollo://schemas/openapi-document/v1': [
      {
        openapi: '3.1.0',
        info: { title: 'Apollo Video Public API', version: '1.0.0' },
        paths: {},
        components: {},
      },
    ],
    'apollo://schemas/json-schema-document/v1': [
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: 'apollo://schemas/example/v1',
        title: 'Example schema',
        type: 'object',
      },
    ],
  })

export function publicSchemaExamples(definition: PublicSchemaDefinition): readonly unknown[] {
  return PUBLIC_SCHEMA_EXAMPLES[definition.ref] ?? []
}

export function publicSchemaDocument(definition: PublicSchemaDefinition) {
  return Object.freeze({
    ...definition.schema,
    examples: Object.freeze([...publicSchemaExamples(definition)]),
  })
}
