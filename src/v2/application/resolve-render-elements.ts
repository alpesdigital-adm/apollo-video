import type { RenderElementMapRepository } from './ports/render-element-map-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import { hitTestRenderElements, validateRenderElementMap } from '../domain/review-system.ts'

export function resolveRenderElementsService(dependencies: { repository: RenderElementMapRepository }) {
  return async function resolve(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    proxyArtifactId: string
    proxyHash: string
    frame: number
    x: number
    y: number
    displayWidth: number
    displayHeight: number
  }) {
    assertDomain(
      [input.workspaceId, input.projectId, input.projectVersionId, input.proxyArtifactId].every((value) => value.trim().length > 0) &&
        /^[a-f0-9]{64}$/.test(input.proxyHash),
      'INVALID_ARGUMENT',
      'Render element lookup identity is invalid',
    )
    const record = await dependencies.repository.findExact({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectVersionId: input.projectVersionId,
      proxyArtifactId: input.proxyArtifactId,
    })
    if (!record) throw new DomainError('RENDER_ELEMENT_MAP_NOT_FOUND', 'RenderElementMap is not available for this exact preview')
    const map = validateRenderElementMap(record.map, input.proxyHash)
    const hit = hitTestRenderElements(map, input)
    return Object.freeze({
      map: Object.freeze({
        schemaVersion: map.schemaVersion,
        mapHash: record.mapHash,
        proxyHash: map.proxyHash,
        fps: map.fps,
        durationFrames: map.durationFrames,
        canvas: map.canvas,
        frame: input.frame,
      }),
      selected: hit.selected,
      chooserRequired: hit.chooserRequired,
      candidates: hit.candidates,
    })
  }
}
