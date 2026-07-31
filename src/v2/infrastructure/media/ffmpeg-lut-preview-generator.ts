import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import type { LutPreviewGenerator } from '../../application/ports/lut-preview-generator.ts'
import { DomainError } from '../../domain/errors.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

function escapeFilterPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

export class FfmpegLutPreviewGenerator implements LutPreviewGenerator {
  private readonly ffmpegPath: string
  constructor(options: { ffmpegPath?: string } = {}) {
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
  }

  async generate(input: { canonicalCube: string; signal?: AbortSignal }) {
    const directory = await mkdtemp(join(tmpdir(), 'apollo-v2-lut-preview-'))
    const cubePath = join(directory, 'input.cube')
    const pngPath = join(directory, 'preview.png')
    try {
      await writeFile(cubePath, input.canonicalCube, { encoding: 'utf8', flag: 'wx' })
      await execFileAsync(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=512x288:rate=1:duration=1',
        '-vf', `lut3d=file='${escapeFilterPath(cubePath)}':interp=tetrahedral`,
        '-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgb24', pngPath,
      ], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024, signal: input.signal })
      const png = await readFile(pngPath)
      if (png.length < 100 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new DomainError('RENDER_OUTPUT_INVALID', 'LUT preview is not a valid PNG')
      }
      return Object.freeze({
        png: new Uint8Array(png), width: 512 as const, height: 288 as const,
        sha256: createHash('sha256').update(png).digest('hex'),
      })
    } catch (error) {
      if (error instanceof DomainError) throw error
      throw new DomainError('INVALID_ARGUMENT', 'LUT could not be rendered by FFmpeg')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
