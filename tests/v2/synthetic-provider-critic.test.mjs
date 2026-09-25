import assert from 'node:assert/strict'
import test from 'node:test'

import { SpecializedSyntheticProviderResultCritic } from '../../src/v2/application/synthetic-provider-critic.ts'

const digest = (character) => character.repeat(64)

function context(rightsValid) {
  return Object.freeze({
    subject: Object.freeze({
      workspaceId: 'workspace-critic-race', projectId: 'project-critic-race', blockId: 'block-critic-race',
      capability: 'tts', adapterId: 'controlled-tts', adapterVersion: '1.0.0', modelRef: null,
      video: null,
      audio: Object.freeze({ artifactId: 'artifact-critic-race', artifactKey: 'critic/race.wav', sha256: digest('a'), byteSize: 128 }),
      alignmentArtifactId: 'alignment-critic-race', scriptText: 'Texto aprovado.',
      expected: Object.freeze({
        durationMs: 1_000, durationMode: 'alignment', fps: null, videoCodec: null, audioCodec: null,
        audioSampleRateHz: null, identityRef: 'identity-critic-race', declaredIdentityRef: null,
        rights: Object.freeze({ withinGrantedScope: rightsValid, reason: rightsValid ? null : 'consent revoked during critic' }),
        previousBlock: null,
      }),
    }),
    profileSnapshotId: 'profile-critic-race:v1',
    scriptHash: digest('b'),
  })
}

test('W24.1 revocation during a long critic prevents terminal approval', async () => {
  let revoked = false
  let reads = 0
  const critic = new SpecializedSyntheticProviderResultCritic({
    transport: { async evaluate() { return { approved: true, resultHash: digest('c') } } },
    context: { async resolve() { reads += 1; return context(!revoked) } },
    async evaluate() {
      revoked = true
      return { report: { decision: 'approved', reportHash: digest('d') }, replayed: false }
    },
  })
  await assert.rejects(
    critic.evaluate({
      job: { workspaceId: 'workspace-critic-race', projectId: 'project-critic-race' },
      artifact: { artifactId: 'artifact-critic-race', artifactSha256: digest('a') },
    }),
    (error) => error?.code === 'ASSET_RIGHTS_BLOCKED' && /revoked during critic/.test(error.message),
  )
  assert.equal(reads, 2)
})
