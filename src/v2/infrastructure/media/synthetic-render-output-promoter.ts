import { isAbsolute, relative, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'

import type { VerifiedMediaStorage } from '../../application/ports/media-ingest.ts'
import type { SyntheticRenderOutputPromoter } from '../../application/ports/synthetic-render-output-promoter.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value.length > 0 && value !== '..' && !value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(value)
}

export class VerifiedSyntheticRenderOutputPromoter implements SyntheticRenderOutputPromoter {
  private readonly outputRoot: string
  private readonly storage: VerifiedMediaStorage

  constructor(options: { outputRoot: string; storage: VerifiedMediaStorage }) {
    this.outputRoot = options.outputRoot.trim()
    this.storage = options.storage
    if (!isAbsolute(this.outputRoot)) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Synthetic render output root must be absolute')
    }
  }

  async promote(input: { workspaceId: string; outputKey: string; sha256: string; byteSize: number }) {
    if (input.outputKey.includes('..') || input.outputKey.includes('\\') || input.outputKey.startsWith('/')) {
      throw new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render output key is unsafe')
    }
    const root = await realpath(this.outputRoot)
    const path = await realpath(resolve(root, ...input.outputKey.split('/')))
    if (!contained(root, path)) throw new DomainError('RENDER_OUTPUT_INVALID', 'Synthetic render output escaped owned storage')
    const [sha256, metadata] = await Promise.all([calculateFileSha256(path), stat(path)])
    if (sha256 !== input.sha256 || metadata.size !== input.byteSize) {
      throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Synthetic render bytes changed before promotion')
    }
    const stored = await this.storage.promoteDerived({
      workspaceId: input.workspaceId,
      sourcePath: path,
      sha256,
      extension: 'mp4',
      prefix: 'synthetic-production-renders',
    })
    if (stored.sha256 !== sha256 || stored.byteSize !== metadata.size) {
      throw new DomainError('RENDER_OUTPUT_CONFLICT', 'Promoted synthetic render bytes changed')
    }
    return Object.freeze({ artifactKey: stored.key, sha256: stored.sha256, byteSize: stored.byteSize })
  }
}
