import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createMediaLibraryPreviewsService } from '../../src/v2/application/create-media-library-previews.ts'
import { FfmpegLibraryPreviewProcessor } from '../../src/v2/infrastructure/media/ffmpeg-library-preview-processor.ts'
import { calculateFileSha256 } from '../../src/v2/infrastructure/media/local-artifact-manifest.ts'

const require = createRequire(import.meta.url), execute = promisify(execFile)

test('real preview executions isolate reclaim scratch and await canceled FFmpeg exit', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-preview-process-fence-')), sourcePath = join(root, 'source.mp4'), work = join(root, 'work')
  let release, firstRun
  try {
    await execute(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath], { windowsHide: true, timeout: 30000 })
    const sha = await calculateFileSha256(sourcePath), processor = new FfmpegLibraryPreviewProcessor(work)
    const executions = []
    let notify
    const firstGenerated = new Promise((resolve) => { notify = resolve }), hold = new Promise((resolve) => { release = resolve })
    const service = createMediaLibraryPreviewsService({
      processor: { async generate(input) { const outputs = await processor.generate(input); executions.push({ id: input.operationId, outputs }); if (executions.length === 1) { notify(); await hold } return outputs }, cleanup: (id) => processor.cleanup(id) },
      integrity: { sha256: calculateFileSha256 }, repository: { async find() { return null }, async publish() {} },
      storage: { async promoteDerived(input) { return { key: `previews/${input.sha256}.png`, sha256: input.sha256, byteSize: (await stat(input.sourcePath)).size } } }, artifacts: { async persistOrReplay(input) { return { artifactId: input.artifactId } } },
    })
    const input = { operationId: 'same-durable-ingest', leaseOwner: 'owner-old', attempt: 1, workspaceId: 'preview-workspace', artifactId: 'source-artifact', artifactKey: 'masters/source.mp4', sourcePath, sourceSha256: sha, mediaType: 'video', label: 'Source', assertActive: async () => {} }
    firstRun = service(input)
    await firstGenerated
    await service({ ...input, leaseOwner: 'owner-new', attempt: 2 })
    assert.notEqual(executions[0].id, executions[1].id)
    assert.ok((await stat(executions[0].outputs[0].path)).isFile(), 'new attempt cleanup cannot remove old attempt scratch')
    release(); await firstRun
    assert.deepEqual(await readdir(work), [])
    const events = [], abort = new AbortController()
    const canceled = new FfmpegLibraryPreviewProcessor(work, (event) => { events.push(event); if (event.state === 'started') abort.abort() })
    await assert.rejects(() => canceled.generate({ operationId: 'owned-preview-cancel', sourcePath, mediaType: 'video', signal: abort.signal }), /cancelled/i)
    assert.deepEqual(events.map((event) => event.state), ['started', 'exited'])
    assert.equal(events[0].pid, events[1].pid); assert.ok(events[0].pid > 0)
    await canceled.cleanup('owned-preview-cancel')
    assert.deepEqual(await readdir(work), [])
    assert.equal(await calculateFileSha256(sourcePath), sha)
  } finally {
    release?.(); await firstRun?.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})
