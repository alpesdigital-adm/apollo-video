import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { ProjectLutRenderMaterializer } from '../../application/ports/project-lut-render-materializer.ts'
import type { ProjectLutSelectionRepository } from '../../application/ports/project-lut-selection-repository.ts'
import type { WorkspaceLutRepository } from '../../application/ports/workspace-lut-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { materializeCube3dIntensity, type WorkspaceLutVersion } from '../../domain/workspace-lut.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

type MaterializeInput = Parameters<ProjectLutRenderMaterializer['materialize']>[0]
type Pipeline = NonNullable<MaterializeInput['executions']>[number]

function creativeStage(pipeline: Pipeline) {
  const stage = pipeline.stages.find((candidate) => candidate.kind === 'creative-lut')
  if (!stage) throw new DomainError('INVALID_RENDER_INPUT', 'Color pipeline has no creative LUT stage')
  return stage
}

export class LocalProjectLutRenderMaterializer implements ProjectLutRenderMaterializer {
  private readonly workRoot: string
  private readonly repository: ProjectLutSelectionRepository
  private readonly workspaceLuts?: Pick<WorkspaceLutRepository, 'readVersionById'>

  constructor(repository: ProjectLutSelectionRepository, workRoot: string, workspaceLuts?: Pick<WorkspaceLutRepository, 'readVersionById'>) {
    this.repository = repository
    this.workspaceLuts = workspaceLuts
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
    const pipelines = input.executions ?? input.compilations.map((compilation) => compilation.pipeline)
    if (pipelines.length < 1) throw new DomainError('INVALID_RENDER_INPUT', 'Project LUT materialization requires color pipeline executions')
    const stages = pipelines.map(creativeStage)
    const selectedLut = effective.resolvedLutVersion
    if (effective.selection.resolved.mode === 'lut-version') {
      const ref = effective.selection.resolved.lut
      if (!selectedLut || selectedLut.id !== ref.versionId || selectedLut.recordHash !== ref.recordHash || selectedLut.cube.contentHash !== ref.cubeContentHash) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Resolved project LUT content is unavailable')
      }
    } else if (selectedLut) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Explicit project none unexpectedly resolved a LUT')
    }
    if (stages.some((stage) => {
      if (!stage.enabled) {
        return Boolean(stage.lut) ||
          stage.implementation.provider !== 'apollo-lut' ||
          stage.implementation.parameters.mode !== 'none' ||
          Object.keys(stage.implementation.parameters).some((key) => key !== 'mode')
      }
      const intensity = Number(stage.implementation.parameters.intensity)
      return stage.implementation.provider !== 'apollo-lut' ||
        stage.implementation.parameters.mode !== 'lut3d' ||
        Object.keys(stage.implementation.parameters).some((key) => !['mode', 'intensity'].includes(key)) ||
        !Number.isFinite(intensity) || intensity < 0 || intensity > 1 || !stage.lut
    })) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Color pipeline creative stage is not materializable')
    }
    if (!input.executions && stages.some((stage) =>
      effective.selection.resolved.mode === 'none'
        ? stage.enabled
        : !stage.enabled || stage.lut?.artifactId !== selectedLut!.id || stage.lut.sha256 !== selectedLut!.cube.contentHash || stage.implementation.parameters.intensity !== effective.selection.intensity)) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Color pipeline creative stage does not match the ProjectVersion LUT selection')
    }
    const directory = this.directory(input.operationId)
    await rm(directory, { recursive: true, force: true })
    await mkdir(directory, { recursive: true })
    const uniqueStages = [...new Map(stages.filter((stage) => stage.enabled).map((stage) => [`${stage.lut!.artifactId}:${stage.implementation.parametersHash}`, stage])).values()]
    const lutPaths: Record<string, string> = {}
    const assets = []
    const versions = new Map<string, Readonly<WorkspaceLutVersion>>()
    if (selectedLut) versions.set(selectedLut.id, selectedLut)
    const writtenCubes = new Set<string>()
    for (const stage of uniqueStages) {
      let lut = versions.get(stage.lut!.artifactId)
      if (!lut) {
        if (!this.workspaceLuts) throw new DomainError('INVALID_RENDER_INPUT', 'ColorPlan LUT resolver is not configured')
        lut = await this.workspaceLuts.readVersionById({ workspaceId: input.workspaceId, versionId: stage.lut!.artifactId }) ?? undefined
        if (lut) versions.set(lut.id, lut)
      }
      if (!lut || lut.workspaceId !== input.workspaceId || lut.cube.contentHash !== stage.lut!.sha256 || !['owned', 'licensed'].includes(lut.license.policy)) {
        throw new DomainError('INVALID_RENDER_INPUT', 'ColorPlan LUT is unavailable or unauthorized')
      }
      const intensity = Number(stage.implementation.parameters.intensity)
      if (intensity < lut.intensity.min || intensity > lut.intensity.max) throw new DomainError('INVALID_RENDER_INPUT', 'ColorPlan LUT intensity is outside its version policy')
      const materialized = materializeCube3dIntensity(lut.cube.canonicalContent, intensity)
      const path = join(directory, `lut-${materialized.contentHash}.cube`)
      if (!writtenCubes.has(materialized.contentHash)) {
        await writeFile(path, materialized.canonicalContent, { encoding: 'utf8', flag: 'wx' })
        writtenCubes.add(materialized.contentHash)
      }
      const sha256 = createHash('sha256').update(materialized.canonicalContent, 'utf8').digest('hex')
      lutPaths[`${stage.lut!.artifactId}:${stage.implementation.parametersHash}`] = path
      assets.push(Object.freeze({
        artifactId: lut.id,
        artifactKey: `workspace-luts/${lut.lutId}/versions/${lut.version}/intensity-${intensity.toFixed(6)}-${sha256}.cube`,
        parametersHash: stage.implementation.parametersHash,
        intensity,
        cubeHash: materialized.contentHash,
        sha256,
        byteSize: Buffer.byteLength(materialized.canonicalContent, 'utf8'),
      }))
    }
    if (assets.length === 1) {
      const asset = assets[0]!
      lutPaths[asset.artifactId] = lutPaths[`${asset.artifactId}:${asset.parametersHash}`]!
    }
    return Object.freeze({
      selectionId: effective.selection.id,
      selectionHash: effective.selection.selectionHash,
      ...(assets.length === 1 ? { materializedCubeHash: assets[0]!.cubeHash, asset: assets[0] } : {}),
      materializedCubeHashes: Object.freeze(assets.map((asset) => asset.cubeHash).sort()),
      lutPaths: Object.freeze(lutPaths),
      assets: Object.freeze(assets),
    })
  }

  async cleanup(operationId: string) { await rm(this.directory(operationId), { recursive: true, force: true }) }
}
