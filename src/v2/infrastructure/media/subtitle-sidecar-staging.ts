import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SubtitleSidecarStagingArea } from '../../application/export-subtitle-sidecar.ts'

/**
 * Content-addressed promotion reads from a file, so the encoded sidecar needs a
 * short-lived one. The directory is unique per call and removed in the caller's
 * `finally`, so an interrupted export never leaves subtitle bytes behind.
 */
export class TemporaryFileSubtitleSidecarStaging implements SubtitleSidecarStagingArea {
  private readonly root: string

  constructor(root: string = join(tmpdir(), 'apollo-subtitle-sidecars')) {
    this.root = root
  }

  async stage(input: { bytes: Buffer; extension: string }) {
    const directory = join(this.root, randomUUID())
    await mkdir(directory, { recursive: true })
    const path = join(directory, `sidecar.${input.extension}`)
    await writeFile(path, input.bytes)
    return Object.freeze({
      path,
      dispose: async () => {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      },
    })
  }
}
