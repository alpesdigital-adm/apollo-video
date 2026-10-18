import type { FaceProducerEnvelopeV2 } from '../../domain/face-producer-envelope-v2.ts'

/**
 * Read side of the W62 face windows, as the caption planner needs it: the sealed window envelopes of one source on one
 * ProjectVersion that overlap a timeline range. The store has already rebuilt every envelope through the domain
 * constructor and refused what does not round-trip; whether an envelope is TRUSTED for this render (scope, source, time
 * map, policy, authentication, agreement with the other windows) is decided by `collectFaceEvidenceStream`, not here.
 */
export interface FaceWindowEvidenceReader {
  listWindows(input: Readonly<{
    workspaceId: string
    projectId: string
    projectVersionId: string
    sourceArtifactId: string
    fromTimelineFrame: number
    toTimelineFrame: number
    now: Date
    limit?: number
  }>): Promise<readonly Readonly<{ envelope: FaceProducerEnvelopeV2 }>[]>
}
