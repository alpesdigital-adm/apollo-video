import type { FaceProducerEnvelopeV3 } from '../../domain/face-producer-envelope-v3.ts'
import type { FaceProducerAuthentication } from '../../domain/face-producer-registry.ts'

/** A sealed source window as the store hands it back, with the registry verdict on its producer computed NOW. */
export type StoredFaceSourceWindow = Readonly<{ envelope: FaceProducerEnvelopeV3; authentication: FaceProducerAuthentication }>

/**
 * Read side of the source-keyed face windows (W65b), as the caption planner needs it: the sealed window envelopes of one SOURCE that
 * overlap a range of its own frames. The store has already rebuilt every envelope through the domain constructor, recomputed its
 * integrity (columns, raw detector outputs, publishing operation), verified the source identity (artifact id and bytes hash) and
 * the consuming project's attachment, and re-checked the source's rights NOW; whether an envelope is TRUSTED for this render
 * (source, clock, policy, authentication, agreement with the other windows) is decided by `collectFaceSourceEvidenceStream`, not here.
 *
 * Evidence is a function of the source's bytes, so it is shared by every ProjectVersion (and every project of the workspace that
 * has the source attached); nothing about an edit is in the request.
 */
export interface FaceSourceWindowEvidenceReader {
  listSourceWindows(input: Readonly<{
    workspaceId: string
    /** The CONSUMING project: it must have the source attached, and its locale is the locale the rights are evaluated for. */
    projectId: string
    sourceArtifactId: string
    fromSourceFrame: number
    toSourceFrame: number
    now: Date
    limit?: number
  }>): Promise<readonly StoredFaceSourceWindow[]>
}
