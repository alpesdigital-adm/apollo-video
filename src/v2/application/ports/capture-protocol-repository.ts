import type { CaptureProtocol } from '../../domain/capture-protocol.ts'
import type { CaptureProtocolEvaluation } from '../../domain/capture-protocol-evaluation.ts'

/** Which protocol a session declares it was shot under, and who said so. */
export interface AttachedCaptureProtocol {
  readonly sessionId: string
  readonly protocolId: string
  readonly protocolVersion: number
  readonly protocolHash: string
  readonly attachedByKind: 'human' | 'api-client' | 'director'
  readonly attachedById: string
  readonly attachedAt: string
}

/**
 * Persistence for capture protocols (F4.009 / FR-147).
 *
 * Three lifetimes live behind this one port, and keeping them distinct is the
 * whole design:
 *
 * The **catalogue** is append-only. `publish` refuses to overwrite a version
 * that already exists with different content, because a stored evaluation
 * naming protocol v1 has to keep meaning what it meant.
 *
 * The **attachment** is a mutable pointer — an operator can realise mid-ingest
 * that this was a podcast, not a multicam — and changing it deliberately does
 * *not* create a new CaptureSession version. The recording did not change; only
 * our description of what it was meant to be.
 *
 * The **evaluation** is a derivation bound to one exact session version, and
 * re-running the same judgement converges rather than accumulating rows.
 */
export interface CaptureProtocolRepository {
  /** Idempotent for identical content; a divergent republish is a conflict. */
  publish(input: {
    protocol: Readonly<CaptureProtocol>
    createdAt: string
  }): Promise<Readonly<{ protocol: Readonly<CaptureProtocol>; replayed: boolean }>>

  list(): Promise<readonly Readonly<CaptureProtocol>[]>

  read(input: {
    protocolId: string
    version?: number
  }): Promise<Readonly<CaptureProtocol> | null>

  attach(input: {
    workspaceId: string
    sessionId: string
    protocol: Readonly<CaptureProtocol>
    attachedByKind: AttachedCaptureProtocol['attachedByKind']
    attachedById: string
    attachedAt: string
  }): Promise<Readonly<AttachedCaptureProtocol>>

  readAttachment(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<AttachedCaptureProtocol> | null>

  persistEvaluation(input: {
    evaluation: Readonly<CaptureProtocolEvaluation>
    createdAt: string
  }): Promise<Readonly<{ evaluation: Readonly<CaptureProtocolEvaluation>; replayed: boolean }>>

  /**
   * The evaluation for one exact session version.
   *
   * Deliberately not "the latest evaluation for this session": an evaluation of
   * version 3 says nothing about version 4, and returning it because it is the
   * newest row would be the stale-derivation bug the whole session model exists
   * to prevent.
   */
  readEvaluation(input: {
    workspaceId: string
    sessionId: string
    sessionVersion: number
    protocolId: string
    protocolVersion: number
  }): Promise<Readonly<CaptureProtocolEvaluation> | null>

  listEvaluations(input: {
    workspaceId: string
    sessionId: string
    limit?: number
  }): Promise<readonly Readonly<CaptureProtocolEvaluation>[]>
}
