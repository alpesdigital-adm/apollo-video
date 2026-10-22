import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import type { RequiredSourceWindow } from '../domain/face-evidence-time-map.ts'
import { readOutputFormatPreset } from '../domain/output-format-registry.ts'
import type { OutputAspectRatio } from '../domain/output-spec.ts'
import { deriveEditorialRenderGeometry } from './derive-editorial-render-geometry.ts'
import type { FaceSourceWindowEvidenceReader, StoredFaceSourceWindow } from './ports/face-source-window-evidence-reader.ts'
import type { ProjectProxyRenderSource } from './ports/project-proxy-render-repository.ts'
import type { ProxyQualityIssue } from './render-workflow.ts'

/**
 * W70 readiness (R2). What a proxy's content address (`projectProxyRenderContentHash`) cannot see, made checkable.
 *
 * The address is computed from the sealed inputs of the output, before anything is read at render time. Two things the review of a proxy
 * depends on are read only then, and the address is blind to both:
 *  - the FACE WINDOWS the caption placement read for each source (the planner reads them by the source's own frames when the render runs, so
 *    a window published after a render moves the decision of a cue without moving the address);
 *  - the Director's quality ISSUES the review carries (`source.criticIssues`: the Version's own DirectorRun, or the ancestor's it inherits).
 * At render completion the worker stores a digest of each (`faceEvidenceDigest`, `criticIssuesDigest`, on the render's operation row). A carry
 * recomputes both for the head - the face windows by running the very same read the worker runs (`deriveProxyRenderGeometry`) - and refuses
 * with `face-evidence-moved` / `critic-issues-moved` when either is not the one the earlier render was made with.
 *
 * The face digest names every window the store returned, whatever the planner then did with it: trusted or not, authenticated or not (its
 * registry verdict is part of it). It also names the windows the plan still needs and nobody has published yet (`requiredFaceWindows`: the
 * pending ones), and whether a reader was wired at all. Order never matters; content does.
 */
export const PROXY_FACE_EVIDENCE_READ_SCHEMA = 'proxy-face-evidence-read/v1' as const
export const PROXY_DIRECTOR_CRITIC_ISSUES_SCHEMA = 'proxy-director-critic-issues/v1' as const

export type ProxyFaceWindowReadV1 = Readonly<{
  id: string
  envelopeHash: string
  startSourceFrame: number
  endSourceFrame: number
  /** The registry verdict the store computed for the window's producer; `null` when the store answered without one. */
  authenticated: boolean | null
  reasons: readonly string[]
}>

export type ProxyFaceEvidenceReadV1 = Readonly<{
  sourceArtifactId: string
  fromSourceFrame: number
  toSourceFrame: number
  windows: readonly ProxyFaceWindowReadV1[]
}>

function windowFacts(stored: Readonly<StoredFaceSourceWindow>): ProxyFaceWindowReadV1 {
  // The planner itself reads only the envelope; the verdict is recorded so a change of it is a change of the evidence.
  const authentication = (stored as { authentication?: StoredFaceSourceWindow['authentication'] }).authentication
  return Object.freeze({
    id: stored.envelope.id,
    envelopeHash: stored.envelope.envelopeHash,
    startSourceFrame: stored.envelope.window.startSourceFrame,
    endSourceFrame: stored.envelope.window.endSourceFrame,
    authenticated: authentication ? authentication.authenticated : null,
    reasons: Object.freeze(authentication ? [...authentication.reasons].toSorted() : []),
  })
}

/**
 * Wraps the reader the placement uses so every read it makes is recorded exactly as it was answered. `reader` is `undefined` when the
 * deployment wired none (the planner then reads nothing, and the digest says so).
 */
export function recordingFaceEvidenceReader(reader: FaceSourceWindowEvidenceReader | undefined) {
  const reads: ProxyFaceEvidenceReadV1[] = []
  const recorder: FaceSourceWindowEvidenceReader | undefined = reader
    ? {
        async listSourceWindows(input) {
          const stored = await reader.listSourceWindows(input)
          reads.push(Object.freeze({
            sourceArtifactId: input.sourceArtifactId,
            fromSourceFrame: input.fromSourceFrame,
            toSourceFrame: input.toSourceFrame,
            windows: Object.freeze(stored.map(windowFacts)),
          }))
          return stored
        },
      }
    : undefined
  return Object.freeze({ reader: recorder, wired: reader !== undefined, reads: () => Object.freeze([...reads]) })
}

const byNumbers = (left: Readonly<{ startSourceFrame: number; endSourceFrame: number }>, right: Readonly<{ startSourceFrame: number; endSourceFrame: number }>) =>
  left.startSourceFrame - right.startSourceFrame || left.endSourceFrame - right.endSourceFrame

/** The digest of what the caption placement of one render read (and still needs). */
export function proxyFaceEvidenceDigest(input: Readonly<{
  wired: boolean
  reads: readonly ProxyFaceEvidenceReadV1[]
  requiredFaceWindows: readonly Readonly<{ sourceArtifactId: string; windows: readonly RequiredSourceWindow[] }>[]
}>): string {
  return calculateCanonicalHash({
    kind: PROXY_FACE_EVIDENCE_READ_SCHEMA,
    readerWired: input.wired,
    reads: [...input.reads]
      .map((read) => ({ ...read, windows: [...read.windows].toSorted((left, right) => byNumbers(left, right) || left.id.localeCompare(right.id)) }))
      .toSorted((left, right) => left.sourceArtifactId.localeCompare(right.sourceArtifactId) ||
        left.fromSourceFrame - right.fromSourceFrame || left.toSourceFrame - right.toSourceFrame),
    required: [...input.requiredFaceWindows]
      .map((entry) => ({ sourceArtifactId: entry.sourceArtifactId, windows: [...entry.windows].toSorted(byNumbers) }))
      .toSorted((left, right) => left.sourceArtifactId.localeCompare(right.sourceArtifactId)),
  })
}

/** The digest of the Director's quality issues a proxy review is built over (`source.criticIssues`); an absent list is the empty one. */
export function proxyDirectorCriticIssuesDigest(issues: readonly Readonly<ProxyQualityIssue>[] | undefined): string {
  return calculateCanonicalHash({ kind: PROXY_DIRECTOR_CRITIC_ISSUES_SCHEMA, issues: issues ?? [] })
}

/**
 * The geometry a proxy of `source` draws, derived exactly as the proxy render worker derives it (the proxy canvas of the format, the clips
 * of the base video track, the composition, the final's rule for an uncertified cue), with the digest of the face windows that derivation
 * read. The worker renders from it; a carry reads it to know whether the windows a render was made with are still the ones there are.
 */
export async function deriveProxyRenderGeometry(input: Readonly<{
  source: Readonly<ProjectProxyRenderSource>
  workspaceId: string
  projectId: string
  faceEvidence?: FaceSourceWindowEvidenceReader
  clock: () => Date
}>) {
  const { source } = input
  const clips = source.editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
  const composition = 'composition' in source.editPlan ? source.editPlan.composition : undefined
  const outputPreset = readOutputFormatPreset(source.format as OutputAspectRatio)
  const recorder = recordingFaceEvidenceReader(input.faceEvidence)
  const geometry = await deriveEditorialRenderGeometry({
    source,
    canvas: { width: outputPreset.exportDefaults.proxy.width, height: outputPreset.exportDefaults.proxy.height },
    workspaceId: input.workspaceId, projectId: input.projectId, clips,
    ...(composition ? { composition } : {}),
    ...(recorder.reader ? { faceEvidence: recorder.reader } : {}),
    clock: input.clock,
    // W65b. The proxy is what the final is approved from, so it plans under the final's rule: a cue that cannot be certified is left out
    // and LISTED (a warning the reviewer acknowledges), instead of making the whole proxy unapprovable.
    uncertifiedCues: 'omit-and-list',
  })
  return Object.freeze({
    ...geometry,
    outputPreset,
    faceEvidenceDigest: proxyFaceEvidenceDigest({ wired: recorder.wired, reads: recorder.reads(), requiredFaceWindows: geometry.requiredFaceWindows }),
  })
}
