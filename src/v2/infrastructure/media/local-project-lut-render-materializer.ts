import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { ProjectLutRenderMaterializer } from '../../application/ports/project-lut-render-materializer.ts'
import type { ProjectLutSelectionRepository } from '../../application/ports/project-lut-selection-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { materializeCube3dIntensity } from '../../domain/workspace-lut.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function creativeStage(compilation: Parameters<ProjectLutRenderMaterializer['materialize']>[0]['compilations'][number]) {
  const stage = compilation.pipeline.stages.find((candidate) => candidate.kind === 'creative-lut')
  if (!stage) throw new DomainError('INVALID_RENDER_INPUT', 'Color pipeline has no creative LUT stage')
  return stage
}

export class LocalProjectLutRenderMaterializer implements ProjectLutRenderMaterializer {
  private readonly workRoot: string
  private readonly repository: ProjectLutSelectionRepository

  constructor(repository: ProjectLutSelectionRepository, workRoot: string) {
    this.repository = repository
    this.workRoot = resolve(workRoot)
    if (!workRoot.trim() || !isAbsolute(this.workRoot)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Project LUT work root is invalid')
  }

  private directory(operationId: string) {
    if (!ID.test(operationId)) throw new DomainError('INVALID_ARGUMENT', 'operationId is invalid')
    const directory = join(this.workRoot, operationId)
    const rel = relative(this.workRoot, directory)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new DomainError('PERSISTENCE_CONFLICT', 'Project LUT work path escaped its root')
    return directory
  }

  async materialize(input: Parameters<ProjectLutRenderMaterializer['materialize']>[0]) {
    if (input.compilations.length < 1) throw new DomainError('INVALID_RENDER_INPUT', 'Project LUT materialization requires color pipelines')
    const effective = await this.repository.readEffectiveForVersion(input)
    if (!effective) throw new DomainError('INVALID_RENDER_INPUT', 'ProjectVersion has no explicit LUT selection')
    const stages = input.compilations.map(creativeStage)
    if (effective.selection.resolved.mode === 'none') {
      if (stages.some((stage) => stage.enabled || stage.lut || stage.implementation.provider !== 'apollo-lut' || stage.implementation.parameters.mode !== 'none')) {
        throw new DomainError('INVALID_RENDER_INPUT', 'Color pipeline creative stage conflicts with explicit project none')
      }
      return Object.freeze({ selectionId: effective.selection.id, selectionHash: effective.selection.selectionHash, lutPaths: Object.freeze({}) })
    }
    const lut = effective.resolvedLutVersion
    const ref = effective.selection.resolved.lut
    if (!lut || lut.id !== ref.versionId || lut.recordHash !== ref.recordHash || lut.cube.contentHash !== ref.cubeContentHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Resolved project LUT content is unavailable')
    if (stages.some((stage) => !stage.enabled || stage.implementation.provider !== 'apollo-lut' || stage.implementation.parameters.mode !== 'lut3d' || stage.implementation.parameters.intensity !== effective.selection.intensity || stage.lut?.artifactId !== lut.id || stage.lut.sha256 !== lut.cube.contentHash)) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Color pipeline creative stage does not match the ProjectVersion LUT selection')
    }
    const materialized = materializeCube3dIntensity(lut.cube.canonicalContent, effective.selection.intensity)
    const directory = this.directory(input.operationId)
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })
    const path = join(directory, `lut-${materialized.contentHash}.cube`)
    await writeFile(path, materialized.canonicalContent, { encoding: 'utf8', flag: 'wx' })
    const sha256 = createHash('sha256').update(materialized.canonicalContent, 'utf8').digest('hex')
    return Object.freeze({
      selectionId: effective.selection.id, selectionHash: effective.selection.selectionHash, materializedCubeHash: materialized.contentHash,
      lutPaths: Object.freeze({ [lut.id]: path }),
      asset: Object.freeze({
        artifactId: lut.id,
        artifactKey: `workspace-luts/${lut.lutId}/versions/${lut.version}/intensity-${effective.selection.intensity.toFixed(6)}-${sha256}.cube`,
        sha256,
        byteSize: Buffer.byteLength(materialized.canonicalContent, 'utf8'),
      }),
    })
  }

  async cleanup(operationId: string) { await rm(this.directory(operationId), { recursive: true, force: true }) }
}
