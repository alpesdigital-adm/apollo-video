import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/**
 * T-F4.012 — the composition root, executed.
 *
 * The lane's whole claim about `silence` is "a production run could never emit
 * one, and now it can". That claim rested on a single line in
 * `repository-factory.ts` that nothing in the repository ran. Measured before
 * this file existed: deleting `silence: createMulticamSilenceEvidenceProvider(
 * environment),` from `createDirectMulticamSessionService` left `npm run
 * typecheck`, `npm run lint`, `npm run lint:code`, all 2150 cases of
 * `tests/v2/*.test.mjs` and `test:integration:multicam-silence-evidence` green.
 * The field is optional on `DeriveMulticamEvidenceDependencies` (a suite that
 * only reads the visual limb must not have to stand up an audio pass), the only
 * importers of the factory are the two `/v1` route files, and no test or
 * journey imports it at all.
 *
 * So this file builds the real dependency set from the real environment and
 * looks at what is in it. It is an integration suite rather than a
 * `*.test.mjs` for one mechanical reason: `repository-factory.ts` pulls modules
 * that use TypeScript parameter properties, which Node's strip-only loader
 * refuses, so it is run under `tsx` by `npm run test:integration:multicam-
 * composition` and by its own CI step.
 *
 * No database is touched. `PrismaClient` connects lazily, so a well-formed URL
 * that points at nothing is enough to build the repositories, and the suite
 * disconnects the cached client in `after` so nothing is left holding a pool.
 * The structural half of the same guarantee — that the root keeps deriving its
 * dependencies from this builder — is falsification 10 in
 * `wave20-falsification.test.mjs`, which runs in the default gate.
 */

/** A URL that parses as PostgreSQL and answers nothing. Port 1 is never a server. */
const UNREACHABLE_DATABASE = 'postgresql://apollo:apollo@127.0.0.1:1/apollo_composition_probe'

test('T-F4.012 the direct-multicam composition root carries a listening pass and a looking pass', async (t) => {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'apollo-composition-'))
  const previous = {
    V2_DATABASE_URL: process.env.V2_DATABASE_URL,
    APOLLO_V2_ARTIFACT_ROOT: process.env.APOLLO_V2_ARTIFACT_ROOT,
    APOLLO_V2_ARTIFACT_STORAGE_DRIVER: process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER,
  }
  process.env.V2_DATABASE_URL = UNREACHABLE_DATABASE
  process.env.APOLLO_V2_ARTIFACT_ROOT = artifactRoot
  process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER = 'local'

  const factory = await import('../../src/v2/infrastructure/repository-factory.ts')
  const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
  const { FfmpegMulticamSilenceProvider } = await import('../../src/v2/infrastructure/analysis/ffmpeg-multicam-silence-provider.ts')
  const { FfmpegMulticamVisualEvidenceProvider } = await import('../../src/v2/infrastructure/analysis/ffmpeg-multicam-visual-evidence-provider.ts')
  const { CaptureMediaResolver } = await import('../../src/v2/infrastructure/media/capture-media-resolver.ts')
  const { PrismaMulticamDiarizationSource } = await import('../../src/v2/infrastructure/prisma/multicam-diarization-source.ts')

  t.after(async () => {
    await disconnectV2PostgresClient()
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(artifactRoot, { recursive: true, force: true })
  })

  const assembled = factory.multicamDirectionCompositionDependencies()
  console.log(
    `composition session=[${Object.keys(assembled).filter((key) => key !== 'evidence').sort().join(',')}]`
    + ` evidence=[${Object.keys(assembled.evidence).sort().join(',')}]`,
  )
  for (const [name, value] of Object.entries(assembled.evidence)) {
    console.log(`composition evidence.${name.padEnd(12)} = ${value?.constructor?.name ?? typeof value}`)
  }

  // The two FFmpeg passes, by class rather than by truthiness: a `silence` that
  // arrived as `undefined` or as a leftover double would satisfy `in` and would
  // measure nothing in production.
  assert.ok(
    assembled.evidence.silence instanceof FfmpegMulticamSilenceProvider,
    'the listening pass in the composition root is the FFmpeg silence provider',
  )
  assert.ok(
    assembled.evidence.visual instanceof FfmpegMulticamVisualEvidenceProvider,
    'and the looking pass is the FFmpeg visual provider — the same hole, closed in the same place',
  )
  assert.ok(
    assembled.evidence.media instanceof CaptureMediaResolver,
    'both passes are handed files by the verified materializer, not by a path a caller chose',
  )
  assert.ok(
    assembled.evidence.diarization instanceof PrismaMulticamDiarizationSource,
    'and speech still comes from the persisted runs',
  )

  // `perception` is deliberately absent, and this suite says so rather than
  // leaving the reader to notice. Reaction evidence is ABSENCE in production,
  // which the direction reads as "nobody measured" and answers by holding the
  // current angle; a stub here would turn that into a measured zero.
  assert.equal(
    assembled.evidence.perception,
    undefined,
    'and `MulticamPerceptionSource` still has no adapter, which is absence and not zero',
  )

  // The session half of the root, so that a repository going missing is caught
  // here rather than at the first request.
  for (const name of ['sessions', 'directions', 'diagnostics', 'protocols', 'commands']) {
    assert.equal(typeof assembled[name], 'object', `the root assembles ${name}`)
    assert.notEqual(assembled[name], null, `and ${name} is not null`)
  }
  assert.equal(typeof assembled.clock, 'function', 'and one clock is shared by both halves')
  assert.equal(assembled.evidence.clock, assembled.clock, 'the same clock, not two')

  // And the root itself builds, which is what the routes call.
  assert.equal(
    typeof factory.createDirectMulticamSessionService(),
    'function',
    'the service the two /v1 routes call is assembled from exactly this set',
  )
})
