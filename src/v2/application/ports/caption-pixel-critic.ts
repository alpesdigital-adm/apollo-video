import type { CaptionPixelIssueV1, CaptionFootprintSample } from '../../domain/caption-pixel-verdict.ts'
import type { NormalizedBounds } from '../../domain/output-spec.ts'
import type { RenderPlacementPlan } from '../../domain/render-placement-plan.ts'

/**
 * A face veto detector for the caption critic (W65). It looks at a caption-free frame of the delivered render and returns the
 * faces it finds, normalized to the canvas. It must NOT be the detector that produced the clearance the plan was decided on:
 * the point of the check is a second opinion on the pixels. It can only veto; a frame on which it finds nothing certifies
 * nothing. No production detector is wired yet (the licence of the candidate is pending), so the production critic reports
 * `FACE_PIXEL_CHECK_UNAVAILABLE` and the port stays open for one.
 */
export interface PixelFaceVetoDetector {
  readonly id: string
  detect(frame: Readonly<{ width: number; height: number; rgb: Uint8Array }>): Promise<readonly Readonly<NormalizedBounds>[]>
}

export interface CaptionPixelVerification {
  issues: readonly Readonly<CaptionPixelIssueV1>[]
  samples: readonly Readonly<CaptionFootprintSample>[]
  /**
   * `completed`: the critic measured the delivered frames (and found whatever `issues` says). `failed`: it could not take its
   * measurement, and `issues` then only says so. A proxy waits for a person in that case; a FINAL never burns a caption that
   * was not confirmed in pixels (W65b).
   */
  measurement: 'completed' | 'failed'
}

/**
 * Verifies, on the delivered MP4, that the captions are where the placement plan says they are. The control is the same render
 * without the burned cues, so the changed pixels are the captions and nothing else.
 */
export interface CaptionPixelCritic {
  verify(request: Readonly<{
    plan: Readonly<RenderPlacementPlan>
    deliveredPath: string
    /** Renders the same input without the burned cues and returns where the caption-free MP4 is. */
    renderControl: () => Promise<Readonly<{ path: string }>>
    signal?: AbortSignal
  }>): Promise<Readonly<CaptionPixelVerification>>
}
