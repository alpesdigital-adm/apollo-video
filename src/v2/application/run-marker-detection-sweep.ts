import { DomainError } from '../domain/errors.ts'
import type { CaptureTrack, CaptureTrackPart } from '../domain/capture-session.ts'
import type { FusionMode, MarkerDetection } from '../domain/sync-marker-detection.ts'
import type { MarkerPosition, SyncMarker } from '../domain/sync-marker.ts'
import type { CaptureSessionRepository } from './ports/capture-session-repository.ts'
import type { SyncDiagnosticRepository } from './ports/sync-diagnostic-repository.ts'
import type { MarkerMediaPort, SyncActor } from './sync-diagnostic.ts'

/**
 * Detect every marker in every track of a session, resumably (F4.010).
 *
 * Detection is the expensive half of this wave: each pair is an FFmpeg decode
 * of a real recording, and a six-track session with three markers is eighteen
 * of them. Running that inside one HTTP request is how a feature becomes a
 * timeout, so the sweep is a separate operation a worker drives.
 *
 * **Progress is the detections table, not a cursor.** A pair that already has a
 * stored detection is skipped, so a sweep that dies halfway resumes exactly
 * where it stopped without anybody recording where that was. There is no state
 * to reconcile after a crash because there is no state apart from the result.
 *
 * **Deliberately not fenced.** Wave 18's sync run carries a lease and a fencing
 * token because settling a stale result would attribute a clock map to a
 * version that no longer exists. Nothing here has that shape: the unit of work
 * is one (marker, track) pair, its outcome is derived entirely from bytes that
 * cannot change, and the repository replaces by that key. Two workers sweeping
 * the same session duplicate FFmpeg work and converge on identical rows — that
 * costs CPU, not correctness, and a lease would buy nothing for the price of a
 * second failure mode. The session version *is* checked, because a session that
 * moved may have tracks this sweep was never asked about.
 *
 * **Observable per pair**, not per sweep. A sweep that reports only a total
 * cannot tell an operator which recording is the one refusing to yield a
 * marker, which is the only question worth asking when the total is wrong.
 */

export interface MarkerDetectionOutcome {
  readonly markerId: string
  readonly trackId: string
  readonly position: MarkerPosition
  readonly state: 'detected' | 'skipped-existing' | 'skipped-no-file' | 'failed'
  readonly outcome: MarkerDetection['outcome'] | null
  readonly rejection: MarkerDetection['rejection'] | null
  readonly atMs: number | null
  readonly detail: string
}

export interface MarkerDetectionSweepResult {
  readonly sessionId: string
  readonly sessionVersion: number
  readonly pairsConsidered: number
  readonly detected: number
  readonly skipped: number
  readonly failed: number
  readonly confirmed: number
  readonly outcomes: readonly Readonly<MarkerDetectionOutcome>[]
  readonly complete: boolean
}

/**
 * The file a marker of this position would be in, or nothing.
 *
 * Returns null rather than throwing: a track whose recorder never restarted
 * genuinely has nowhere for an after-restart marker to be, and a sweep must
 * record that as "nothing to search" and carry on, not abort the whole session
 * over one pair that was never possible.
 */
function partForPosition(
  track: Readonly<CaptureTrack>,
  position: MarkerPosition,
): Readonly<CaptureTrackPart> | null {
  const ordered = [...track.parts].sort((left, right) => left.ordinal - right.ordinal)
  if (position === 'after-restart') {
    // The ordinal, not the split reason. Wave 18 re-stamps the first part as
    // 'recorder-restart' once a second file arrives, so the reason says the
    // track is split and never which file came after the break.
    return ordered.find((entry) => entry.ordinal > 0) ?? null
  }
  return (position === 'end' ? ordered.at(-1) : ordered[0]) ?? null
}

export function runMarkerDetectionSweep(dependencies: {
  repository: SyncDiagnosticRepository
  sessions: CaptureSessionRepository
  media: MarkerMediaPort
  resolveMediaPath: (input: {
    workspaceId: string
    part: Readonly<CaptureTrackPart>
  }) => Promise<Readonly<{ path: string; release: () => Promise<void> }>>
  clock: () => Date
  /** Stop after this many decodes so one pass has a bounded cost. */
  maxPairs?: number
  onOutcome?: (outcome: Readonly<MarkerDetectionOutcome>) => void
}) {
  const maxPairs = dependencies.maxPairs ?? 24

  return async (input: {
    actor: SyncActor
    sessionId: string
  }): Promise<Readonly<MarkerDetectionSweepResult>> => {
    const session = await dependencies.sessions.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    if (!session) {
      throw new DomainError(
        'CAPTURE_SESSION_NOT_FOUND',
        `Capture session ${input.sessionId} does not exist`,
      )
    }

    const [markers, existing] = await Promise.all([
      dependencies.repository.listMarkers({
        workspaceId: input.actor.workspaceId,
        sessionId: input.sessionId,
      }),
      dependencies.repository.listDetections({
        workspaceId: input.actor.workspaceId,
        sessionId: input.sessionId,
      }),
    ])
    const done = new Set(existing.map((entry) => `${entry.markerId}:${entry.trackId}`))

    const outcomes: MarkerDetectionOutcome[] = []
    let detected = 0
    let skipped = 0
    let failed = 0
    let confirmed = existing.filter((entry) => entry.outcome === 'confirmed').length
    let complete = true

    const record = (outcome: MarkerDetectionOutcome) => {
      outcomes.push(outcome)
      dependencies.onOutcome?.(Object.freeze(outcome))
    }

    for (const entry of markers) {
      const marker: Readonly<SyncMarker> = entry.marker
      for (const track of session.tracks) {
        const key = `${marker.markerId}:${track.trackId}`
        if (done.has(key)) {
          skipped += 1
          record({
            markerId: marker.markerId,
            trackId: track.trackId,
            position: marker.position,
            state: 'skipped-existing',
            outcome: null,
            rejection: null,
            atMs: null,
            detail: 'already detected in an earlier pass',
          })
          continue
        }

        const part = partForPosition(track, marker.position)
        if (!part) {
          skipped += 1
          record({
            markerId: marker.markerId,
            trackId: track.trackId,
            position: marker.position,
            state: 'skipped-no-file',
            outcome: null,
            rejection: null,
            atMs: null,
            detail: `this track has no ${marker.position} file for the marker to be in`,
          })
          continue
        }

        // Bounded per pass rather than per session: a long session should make
        // progress every pass instead of timing out on the same first attempt
        // forever. The unfinished pairs are simply not in the detections table
        // yet, which is what the next pass reads.
        if (detected >= maxPairs) {
          complete = false
          break
        }

        let media
        try {
          media = await dependencies.resolveMediaPath({
            workspaceId: input.actor.workspaceId,
            part,
          })
          const detection = await dependencies.media.detect({
            marker,
            trackId: track.trackId,
            mediaPath: media.path,
            // A recorder that captured no usable audio can only ever produce
            // one channel; holding it to both refuses it for something that is
            // not its fault.
            mode: (track.syncAudioPolicy === 'none' ? 'either-channel' : 'both-channels') as FusionMode,
          })
          await dependencies.repository.persistDetection({
            workspaceId: input.actor.workspaceId,
            detection,
            detectedAt: dependencies.clock().toISOString(),
          })
          detected += 1
          if (detection.outcome === 'confirmed') confirmed += 1
          record({
            markerId: marker.markerId,
            trackId: track.trackId,
            position: marker.position,
            state: 'detected',
            outcome: detection.outcome,
            rejection: detection.rejection,
            atMs: detection.atMs,
            detail: detection.reasons.join('; '),
          })
        } catch (error) {
          // One unreadable file must not end the sweep. The pair stays absent
          // from the detections table, so the next pass tries it again — which
          // is the right behaviour for a disk that was briefly unavailable and
          // harmless for one that is permanently gone.
          failed += 1
          complete = false
          record({
            markerId: marker.markerId,
            trackId: track.trackId,
            position: marker.position,
            state: 'failed',
            outcome: null,
            rejection: null,
            atMs: null,
            detail: error instanceof Error ? error.message : String(error),
          })
        } finally {
          // On the S3 driver each pair materializes a whole recording. Left
          // unreleased, one sweep of a six-track session leaks six of them.
          if (media) await media.release()
        }
      }
      if (!complete && detected >= maxPairs) break
    }

    return Object.freeze({
      sessionId: input.sessionId,
      sessionVersion: session.version,
      // Every pair that was actually resolved records an outcome, and the one
      // that trips the per-pass budget records none. Counting at the top of the
      // loop instead made this one too high whenever a pass stopped early.
      pairsConsidered: outcomes.length,
      detected,
      skipped,
      failed,
      confirmed,
      outcomes: Object.freeze(outcomes),
      // True only when every pair either produced a detection or had nothing to
      // search. A caller that treats a bounded pass as finished would build a
      // diagnostic from half the evidence and call it complete.
      complete,
    })
  }
}
