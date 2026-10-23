import { createTransformationBrief } from '../../../src/v2/domain/transformation-brief.ts'

/**
 * Golden transformation briefs for the tests. They are test content, not product: the Apollo derives every transformation brief from the
 * request of each video, so no scene ("medieval", "studio") or prompt is a value the product ships. The contract tests build their cases from these.
 */
export const TRANSFORMATION_GOLDENS = {
  simple: createTransformationBrief({
    workspaceId: 'workspace-golden', projectId: 'project-golden', projectVersionId: 'version-golden', storyPlanId: 'story-plan-simple', storyPlanHash: '1'.repeat(64), sourceArtifactId: 'artifact-scene-one', sourceArtifactHash: '2'.repeat(64), sourceRange: { startFrame: 0, endFrame: 150 }, intent: 'dramatic-emphasis', editorialIntent: 'Iluminar o estúdio sem alterar a pessoa.', mode: 'relight', prompt: 'Luz de estúdio suave e natural.', negativeConstraints: ['não alterar o rosto'], preserve: ['identity', 'speech', 'wardrobe'], allowedChanges: ['lighting'], target: { lighting: 'soft' }, outputSpecIds: ['output-vertical'], intensityBps: 2_000, noveltyBps: 2_000, safety: ['no-face-change'], safeZones: [{ x: 0.25, y: 0.05, width: 0.5, height: 0.6, purpose: 'face' }], fallbackLadder: ['source-unchanged'], rightsSnapshotId: 'rights-simple', rightsSnapshotHash: '3'.repeat(64), identitySnapshotId: 'identity-simple', identitySnapshotHash: '4'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z',
  }),
  medieval: createTransformationBrief({
    workspaceId: 'workspace-golden', projectId: 'project-golden', projectVersionId: 'version-golden', storyPlanId: 'story-plan-medieval', storyPlanHash: '5'.repeat(64), sourceArtifactId: 'artifact-scene-two', sourceArtifactHash: '6'.repeat(64), sourceRange: { startFrame: 30, endFrame: 210 }, intent: 'world-shift', editorialIntent: 'Ilustrar gestão de tráfego medieval mantendo a fala e a identidade.', mode: 'background-replacement', prompt: 'Vila medieval britânica sóbria ao fundo.', negativeConstraints: ['sem armas', 'sem texto inventado'], preserve: ['identity', 'lips', 'expression', 'body-motion', 'wardrobe', 'speech', 'foreground'], allowedChanges: ['background'], target: { environment: 'medieval-british-village' }, outputSpecIds: ['output-vertical'], intensityBps: 8_000, noveltyBps: 8_000, safety: ['no-weapon', 'no-identity-change'], safeZones: [{ x: 0.2, y: 0.05, width: 0.6, height: 0.9, purpose: 'subject' }], fallbackLadder: ['actor-composite', 'generated-cutaway', 'still-parallax', 'source-unchanged'], rightsSnapshotId: 'rights-medieval', rightsSnapshotHash: '7'.repeat(64), identitySnapshotId: 'identity-medieval', identitySnapshotHash: '8'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z',
  }),
}
