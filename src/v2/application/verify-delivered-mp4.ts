import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DomainError } from '../domain/errors.ts'
import {
  sealMp4Evidence, serializeMp4QualityReport, type Mp4EvidenceSealV1, type Mp4QualityReportV1, type Mp4ReportIdentity,
} from '../domain/mp4-pixel-quality.ts'
import type { NormalizedInsets } from '../domain/output-spec.ts'
import type { EditorialCutClip } from './apply-editorial-cut-command.ts'
import type { EditorialProxyRenderer } from './ports/editorial-proxy-renderer.ts'
import type { VerifiedMediaStorage } from './ports/media-ingest.ts'
import type { Mp4ControlKind, Mp4PixelCritic, Mp4PixelVerification } from './ports/mp4-pixel-critic.ts'

/**
 * W67. Runs the independent MP4 critic on a delivered render, the way both workers need it: the controls are the SAME render request
 * with the overlay removed (captions off, CTA off, both off), rendered by the same renderer under their own operation ids and cleaned up
 * afterwards. The critic itself never edits a frame and never reads the plan: what it returns is a sealed report of the delivered file.
 *
 * A critic that could not run is NOT a pass: it returns `measurement: 'failed'` with a reason code, and the caller decides (the proxy
 * keeps the render waiting for a person; a final export refuses to deliver).
 */
export type DeliveredMp4Verification = Readonly<
  | { measurement: 'completed'; verification: Readonly<Mp4PixelVerification>; evidence: Readonly<Mp4EvidenceSealV1>; failureCode: null }
  | { measurement: 'failed'; verification: null; evidence: null; failureCode: string }
>

export async function verifyDeliveredMp4(input: Readonly<{
  critic: Mp4PixelCritic
  renderer: Pick<EditorialProxyRenderer, 'render' | 'cleanup'>
  renderRequest: Parameters<EditorialProxyRenderer['render']>[0]
  deliveredPath: string
  identity: Mp4ReportIdentity
  outputSpec: Readonly<{ width: number; height: number; safeArea: Readonly<NormalizedInsets> }>
  /** The render's sources and where the renderer read them (same order). */
  renderSources: readonly Readonly<{ artifactId: string; sha256: string }>[]
  sourcePaths: readonly string[]
  clips: readonly Readonly<EditorialCutClip>[]
  overlays: Readonly<{ captions: boolean; cta: boolean }>
  controlOperationPrefix: string
  signal?: AbortSignal
}>): Promise<DeliveredMp4Verification> {
  const created: string[] = []
  const control = async (kind: Mp4ControlKind): Promise<Readonly<{ path: string }>> => {
    const operationId = `${input.controlOperationPrefix}-mp4-${kind}`
    created.push(operationId)
    const { ctaOverlays: _cta, ...withoutCta } = input.renderRequest
    const base = kind === 'captions-off' ? input.renderRequest : withoutCta
    const rendered = await input.renderer.render({
      ...base, operationId, subtitleCues: kind === 'cta-off' ? input.renderRequest.subtitleCues : [],
      ...(kind === 'captions-off' && input.renderRequest.ctaOverlays ? { ctaOverlays: input.renderRequest.ctaOverlays } : {}),
    })
    return { path: rendered.outputPath }
  }
  try {
    const sources = Object.fromEntries(input.renderSources.map((source, index) => [source.artifactId, { path: input.sourcePaths[index]!, sha256: source.sha256 }]))
    const verification = await input.critic.verify({
      identity: input.identity, deliveredPath: input.deliveredPath, outputSpec: input.outputSpec, sources, overlays: input.overlays,
      clips: input.clips.map((clip) => ({
        sourceArtifactId: clip.sourceArtifactId, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame,
        sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, rate: clip.rate,
      })),
      renderControl: control, ...(input.signal ? { signal: input.signal } : {}),
    })
    return Object.freeze({ measurement: 'completed' as const, verification, evidence: sealMp4Evidence(verification.report), failureCode: null })
  } catch (error) {
    if (input.signal?.aborted) throw error
    return Object.freeze({
      measurement: 'failed' as const, verification: null, evidence: null,
      failureCode: error instanceof DomainError ? error.code : 'MP4_CRITIC_FAILED',
    })
  } finally {
    await Promise.allSettled(created.map((operationId) => input.renderer.cleanup(operationId)))
  }
}

/**
 * Stores the sealed report as a content-addressed JSON file (the bytes `serializeMp4QualityReport` writes), so the seal that travels
 * with the variant's verdict (`reportFileSha256`) finds the full evidence: frame hashes, sample ids, oracle digests, per-check verdicts and
 * unknowns. It is evidence, not a deliverable: it is stored for a blocked variant too, and the blocked variant's MP4 is not.
 */
export async function persistMp4QualityReport(input: Readonly<{
  storage: Pick<VerifiedMediaStorage, 'promoteDerived'>
  workspaceId: string
  report: Readonly<Mp4QualityReportV1>
}>): Promise<Readonly<{ key: string; sha256: string; byteSize: number }>> {
  const text = serializeMp4QualityReport(input.report)
  const sha256 = createHash('sha256').update(text).digest('hex')
  const directory = await mkdtemp(join(tmpdir(), 'apollo-mp4-report-'))
  try {
    const path = join(directory, 'mp4-quality-report.json')
    await writeFile(path, text, 'utf8')
    const stored = await input.storage.promoteDerived({ workspaceId: input.workspaceId, sourcePath: path, sha256, extension: 'json', prefix: 'mp4-quality-reports' })
    if (stored.sha256 !== sha256) throw new DomainError('RENDER_OUTPUT_PROMOTION_FAILED', 'The stored MP4 quality report checksum changed')
    return Object.freeze({ key: stored.key, sha256: stored.sha256, byteSize: stored.byteSize })
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined)
  }
}
