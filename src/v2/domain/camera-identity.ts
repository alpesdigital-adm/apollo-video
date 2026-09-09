import { assertDomain, DomainError } from './errors.ts'
import type { CaptureSession, CaptureTrack } from './capture-session.ts'

/**
 * F4.012/F4.013 — the one camera identity every downstream consumer agrees on.
 *
 * An angle is a `CaptureTrack`; a colour target is a `ColorPlan.cameras[key]`;
 * a rendered clip carries `EditorialCutClip.cameraId`. Three places, one key,
 * derived once here from `CaptureTrack.trackId` — never from the device (two
 * tracks can share a body) and never from the asset (a track has several).
 *
 * The capture identifier grammar (`domain/capture-session.ts:50`) allows upper case,
 * `:` and `/`; the ColorPlan camera key must satisfy the `TOKEN` grammar in
 * `color-and-export.ts:80` (`^[a-z0-9][a-z0-9._/-]{0,127}$`) and the renderer
 * lower-cases the id before keying the colour manifest
 * (`ffmpeg-editorial-proxy-renderer.ts:507`). Other aggregates the same id may
 * flow through (sync diagnostic, markers, synthesis) refuse `/` outright. So the
 * key is the track id lowered, with every character outside `[a-z0-9._-]`
 * folded to `-`. That fold is lossy on purpose — it is what makes the key
 * portable — and lossy means two distinct tracks can collide. A collision is
 * refused, never silently resolved, because a colour correction applied to
 * "the other camera" is the worst kind of wrong: invisible in every log.
 */

/** Mirrors `TOKEN` in `color-and-export.ts:80`. A structural test keeps the two equal. */
export const CAMERA_ID_TOKEN = /^[a-z0-9][a-z0-9._/-]{0,127}$/

const CAMERA_ID_MAX_LENGTH = 128

/**
 * The ColorPlan / clip camera key of one track. Pure, total and deterministic:
 * the same `trackId` always yields the same key on every machine.
 */
export function colorCameraIdForTrack(track: Readonly<Pick<CaptureTrack, 'trackId'>>): string {
  const folded = track.trackId
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, CAMERA_ID_MAX_LENGTH)
  assertDomain(
    CAMERA_ID_TOKEN.test(folded),
    'INVALID_ARGUMENT',
    `track ${track.trackId} cannot be folded into a ColorPlan camera key`,
    { trackId: track.trackId, folded },
  )
  return folded
}

/**
 * Every track's key at once, refusing the session when two tracks fold to the
 * same key. Callers that need more than one key must go through here so the
 * collision check cannot be skipped by asking one track at a time.
 */
export function colorCameraIdsForSession(
  session: Readonly<Pick<CaptureSession, 'sessionId' | 'tracks'>>,
): ReadonlyMap<string, string> {
  const byTrack = new Map<string, string>()
  const byKey = new Map<string, string>()
  for (const track of [...session.tracks].sort((left, right) => left.trackId.localeCompare(right.trackId))) {
    const cameraId = colorCameraIdForTrack(track)
    const holder = byKey.get(cameraId)
    if (holder !== undefined && holder !== track.trackId) {
      throw new DomainError(
        'CAMERA_IDENTITY_COLLISION',
        `tracks ${holder} and ${track.trackId} fold to the same camera key ${cameraId}; a colour correction could not tell them apart`,
        { sessionId: session.sessionId, cameraId, trackIds: [holder, track.trackId] },
      )
    }
    byKey.set(cameraId, track.trackId)
    byTrack.set(track.trackId, cameraId)
  }
  return byTrack
}
