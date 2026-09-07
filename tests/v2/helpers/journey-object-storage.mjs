import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * The storage of record a Wave 20 product journey runs against.
 *
 * The briefing for these journeys says they run against PostgreSQL 16 **and
 * versioned object storage**. Every one of them used to open with
 *
 *     process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER = 'local'
 *
 * written into the test file, so the sentence was unfalsifiable: the repository
 * ships a versioned MinIO in `infra/object-storage/compose.yml` and a CI job
 * that proves versioning is on, and no capture journey could ever have reached
 * it. A pin inside the file also silently overrode the workflow — a CI step
 * that set the driver to `s3` for one of these journeys would have been
 * discarded by the assignment on the next line of the test.
 *
 * The driver now comes from the environment, the way the composition root reads
 * it (`repository-factory.ts:1239-1243`), and this module is the one place that
 * knows what each mode costs a journey:
 *
 * - **local** — the artifact root IS the store. A journey writes its fixtures
 *   at `<artifactRoot>/<artifactKey>` and reads the delivered file back from
 *   the same path. Nothing here does anything.
 * - **s3** — the run gets its OWN bucket, versioning enabled, and the journey
 *   puts its fixtures there. The artifact root becomes staging: the app writes
 *   through `S3VerifiedMediaStorage` and materializes sources through
 *   `S3ArtifactSourceMaterializer`, so every byte the render decodes has made a
 *   round trip through MinIO. Reading a stored object goes through `HeadObject`
 *   first and then a `GET` **bound to that VersionId**, which is what makes the
 *   word "versioned" mean something instead of decorating a bucket name.
 *
 * The bucket is created rather than reused on purpose: `CreateBucket`
 * succeeding is the proof that no state was inherited, and `close()` proves the
 * inverse by listing every version, deleting them, listing again and asserting
 * the listing is empty before it removes the bucket. Same shape the provider
 * and block-plan journeys already use
 * (`provider-tts-avatar-journey.e2e.mjs:193-200,462-474`) — extracted here
 * because six more journeys now need it and a sixth copy of it would be six
 * chances to forget the delete.
 */

const DRIVERS = Object.freeze(['local', 's3'])

/**
 * The driver this run uses, validated against the same two values the
 * composition root accepts.
 *
 * Unknown values throw rather than falling back to `local`: a typo in a CI step
 * would otherwise quietly demote a journey the workflow believes is running
 * against object storage.
 */
export function journeyStorageDriver(environment = process.env) {
  const driver = (environment.APOLLO_V2_ARTIFACT_STORAGE_DRIVER ?? 'local').trim().toLowerCase()
  assert.ok(
    DRIVERS.includes(driver),
    `APOLLO_V2_ARTIFACT_STORAGE_DRIVER must be one of ${DRIVERS.join(', ')}, not ${JSON.stringify(driver)}`,
  )
  return driver
}

/**
 * The run-exclusive versioned bucket, or `null` in local mode.
 *
 * `CreateBucket` is not tolerated failing: an existing bucket means shared or
 * inherited state, which is exactly the condition a zero-orphan assertion at
 * the end cannot distinguish from a leak of this run's own objects.
 */
export async function openJourneyObjectStore({ environment = process.env } = {}) {
  if (journeyStorageDriver(environment) === 'local') return null
  const aws = await import('@aws-sdk/client-s3')
  const { createArtifactS3ClientFromEnvironment } = await import(
    '../../../src/v2/infrastructure/media/s3-artifact-storage.ts'
  )
  const { bucket, client } = createArtifactS3ClientFromEnvironment(environment)
  await client.send(new aws.CreateBucketCommand({ Bucket: bucket }))
  await client.send(new aws.PutBucketVersioningCommand({
    Bucket: bucket,
    VersioningConfiguration: { Status: 'Enabled' },
  }))
  const versioning = await client.send(new aws.GetBucketVersioningCommand({ Bucket: bucket }))
  assert.equal(versioning.Status, 'Enabled', 'the journey bucket must be versioned')
  return Object.freeze({
    aws,
    bucket,
    client,
    /**
     * Put a local file at `key`, the way the app promotes one, and answer the
     * VersionId the store assigned.
     *
     * `ChecksumSHA256` and the `apollo-sha256` metadata are not decoration:
     * `S3ArtifactSourceMaterializer.materialize` verifies the head against both
     * before it downloads anything (`s3-artifact-storage.ts:61-80,240-242`) and
     * refuses `PERSISTENCE_CONFLICT` when neither is there. A fixture uploaded
     * without them is an object no worker in this repository can open — which
     * is how the first s3 run of the podcast journey turned three synchronised
     * cameras into `insufficient-evidence` with nothing in the logs.
     */
    async put(key, filePath) {
      const body = await readFile(filePath)
      const sha256 = createHash('sha256').update(body).digest('hex')
      const written = await client.send(new aws.PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentLength: body.byteLength,
        ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
        Metadata: { 'apollo-sha256': sha256 },
      }))
      assert.ok(
        written.VersionId && written.VersionId !== 'null',
        `object storage answered no version for ${key}`,
      )
      return written.VersionId
    },
    /**
     * Copy the object at `key` to a local path and answer that path.
     *
     * `HeadObject` then `GetObject` with the VersionId it reported: a bare
     * `GET` would read "whatever is latest now", which is the one thing a
     * versioned store exists to let a reader avoid.
     */
    async readTo(key, targetPath) {
      const head = await client.send(new aws.HeadObjectCommand({ Bucket: bucket, Key: key }))
      assert.ok(
        head.VersionId && head.VersionId !== 'null',
        `stored object ${key} is not version-bound`,
      )
      const object = await client.send(new aws.GetObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: head.VersionId,
      }))
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(targetPath, Buffer.from(await object.Body.transformToByteArray()))
      return targetPath
    },
    /** Every key the bucket currently holds a live version of, sorted. */
    async keys() {
      const listing = await client.send(new aws.ListObjectVersionsCommand({ Bucket: bucket }))
      assert.equal(listing.IsTruncated ?? false, false, 'the journey bucket listing must fit one page')
      return (listing.Versions ?? []).filter(({ IsLatest }) => IsLatest !== false).map(({ Key }) => Key).sort()
    },
  })
}

/**
 * Delete every version this run wrote, prove the bucket is empty, remove it.
 *
 * Called from the same `finally`/`t.after` that disconnects Prisma, so a
 * journey that fails halfway still leaves no bucket behind for the next one to
 * inherit — which would turn `CreateBucket` above into the failure report
 * instead of the real defect.
 */
export async function closeJourneyObjectStore(store) {
  if (!store) return
  const { aws, bucket, client } = store
  const versions = await client.send(new aws.ListObjectVersionsCommand({ Bucket: bucket }))
  const stored = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]
    .map(({ Key, VersionId }) => ({ Key, VersionId }))
  if (stored.length > 0) {
    await client.send(new aws.DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: stored, Quiet: true } }))
  }
  const after = await client.send(new aws.ListObjectVersionsCommand({ Bucket: bucket }))
  assert.deepEqual(
    [...(after.Versions ?? []), ...(after.DeleteMarkers ?? [])],
    [],
    'object storage must hold zero orphan objects after the journey',
  )
  await client.send(new aws.DeleteBucketCommand({ Bucket: bucket }))
  client.destroy()
}

/**
 * The storage half of the environment a journey hands to its worker children.
 *
 * A driver that only reached the parent would be a journey whose API calls used
 * MinIO and whose renders used a local disk — two stores, one claim. The S3
 * settings are copied from THIS process rather than re-derived, so the workers
 * open the same bucket the parent created.
 *
 * `APOLLO_V2_RENDER_WORK_ROOT` is mandatory in s3 mode and is asserted here
 * rather than at the first render: `createArtifactSourceMaterializer` and
 * `createRenderInputAssetResolver` both refuse without it
 * (`repository-factory.ts:1256-1257`, `:1804-1810`), and a worker that dies on configuration
 * is a much slower way to learn the same thing.
 */
export function journeyStorageEnvironment({
  driver,
  artifactRoot,
  workRoot = null,
  environment = process.env,
}) {
  assert.ok(DRIVERS.includes(driver), `unknown artifact storage driver: ${driver}`)
  if (driver === 'local') {
    return Object.freeze({
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
    })
  }
  assert.ok(workRoot, 'a render work root is required for the s3 artifact storage driver')
  const copied = {}
  for (const name of [
    'APOLLO_V2_S3_ENDPOINT',
    'APOLLO_V2_S3_REGION',
    'APOLLO_V2_S3_BUCKET',
    'APOLLO_V2_S3_ACCESS_KEY_ID',
    'APOLLO_V2_S3_SECRET_ACCESS_KEY',
    'APOLLO_V2_S3_SESSION_TOKEN',
    'APOLLO_V2_S3_FORCE_PATH_STYLE',
    'APOLLO_V2_S3_ALLOW_INSECURE_HTTP',
    'APOLLO_V2_S3_SIGNED_URL_TTL_SECONDS',
  ]) {
    const value = environment[name]
    if (value !== undefined && value !== '') copied[name] = value
  }
  return Object.freeze({
    APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
    APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 's3',
    APOLLO_V2_RENDER_WORK_ROOT: workRoot,
    ...copied,
  })
}

/**
 * Where a journey reads a stored artifact from, in either mode.
 *
 * Local mode answers the content-addressed path directly; s3 mode fetches the
 * object version-bound into `readbackRoot` and answers that copy. Callers get
 * one path they can hand to ffprobe either way, and the bytes it holds are the
 * bytes the store holds — never a local leftover the app never promoted.
 */
export async function storedArtifactPath(store, { artifactRoot, artifactKey, readbackRoot }) {
  if (!store) return join(artifactRoot, artifactKey)
  return await store.readTo(artifactKey, join(readbackRoot, ...artifactKey.split('/')))
}
